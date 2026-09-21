/**
 * Orquestador: de los datos crudos al JSON que consume la web.
 *
 *   histórico -> walk-forward (modelos + calibración)
 *   fixtures  -> predicción por partido y por mercado
 *   cuotas    -> quitar vig, valor esperado, ranking y combinadas
 */

import { walkForward } from './lib/train.js';
import { predictFixture, refineWithMarket } from './lib/ensemble.js';
import { probabilityForCode, topScorelines, expectedTotalGoals, MARKET_LABELS } from './lib/markets.js';
import { evaluateSelection, removeVig, impliedProbability } from './lib/value.js';
import { buildParlays } from './lib/parlays.js';
import { buildReasoning, shortReasoning } from './lib/reasoning.js';
import { matchFixture } from './lib/names.js';
import { aggregateOdds } from './sources/oddsApi.js';
import { CONFIG, LEAGUES, LEAGUE_GROUPS } from './config.js';

const DAY = 86400000;

export function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/** Agrupa los códigos de cuotas en mercados para poder quitar el margen. */
function groupForDevig(codes) {
  const groups = [];
  const oneX2 = ['1', 'X', '2'].filter((c) => codes.includes(c));
  if (oneX2.length === 3) groups.push(oneX2);
  const btts = ['BTTS_SI', 'BTTS_NO'].filter((c) => codes.includes(c));
  if (btts.length === 2) groups.push(btts);

  const lines = new Map();
  for (const code of codes) {
    const ou = /^(OVER|UNDER)_(-?\d+(?:\.\d+)?)$/.exec(code);
    if (ou) {
      const key = `ou-${ou[2]}`;
      lines.set(key, [...(lines.get(key) ?? []), code]);
    }
    const ah = /^AH_(HOME|AWAY)_(-?\d+(?:\.\d+)?)$/.exec(code);
    if (ah) {
      const line = Number(ah[2]);
      const key = `ah-${Math.abs(line)}`;
      lines.set(key, [...(lines.get(key) ?? []), code]);
    }
  }
  for (const [, list] of lines) if (list.length === 2) groups.push(list);
  return groups;
}

/** Probabilidad justa del mercado (sin margen) para cada código con cuota. */
function fairProbabilities(oddsBySelection) {
  const codes = Object.keys(oddsBySelection);
  const fair = {};
  for (const group of groupForDevig(codes)) {
    const prices = group.map((c) => oddsBySelection[c].consensus ?? oddsBySelection[c].odds);
    const probs = removeVig(prices);
    group.forEach((code, i) => {
      fair[code] = probs[i];
    });
  }
  for (const code of codes) {
    if (fair[code] === undefined) {
      const price = oddsBySelection[code].consensus ?? oddsBySelection[code].odds;
      fair[code] = impliedProbability(price) / (1 + (oddsBySelection[code].margin ?? 0.06) / 2);
    }
  }
  return fair;
}

/** Cuotas de doble oportunidad derivadas del 1X2 (el mercado rara vez las publica). */
function deriveDoubleChance(oddsBySelection, fair, margin) {
  const need = ['1', 'X', '2'];
  if (!need.every((c) => fair[c] !== undefined)) return {};
  const combos = {
    '1X': fair['1'] + fair.X,
    '12': fair['1'] + fair['2'],
    X2: fair.X + fair['2'],
  };
  const out = {};
  for (const [code, probability] of Object.entries(combos)) {
    const priced = probability * (1 + Math.max(margin, 0.02) * 0.6);
    out[code] = {
      odds: Number((1 / Math.min(priced, 0.98)).toFixed(2)),
      bookmaker: 'Derivada del 1X2',
      bookmakers: oddsBySelection['1']?.bookmakers ?? 1,
      margin,
      derived: true,
      fairProbability: probability,
    };
  }
  return out;
}

/** Probabilidades justas del mercado para usarlas como prior. */
function buildMarketPrior(fair, { bookmakers, margin }) {
  if (fair['1'] === undefined || fair.X === undefined || fair['2'] === undefined) return null;
  const totalLines = Object.keys(fair)
    .map((code) => /^OVER_(-?\d+(?:\.\d+)?)$/.exec(code))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  // Se prefiere la línea principal (2.5) y, si no está, la más cercana.
  const line = totalLines.length
    ? totalLines.sort((a, b) => Math.abs(a - 2.5) - Math.abs(b - 2.5))[0]
    : null;

  return {
    oneX2: { home: fair['1'], draw: fair.X, away: fair['2'] },
    totals: line === null ? null : { line, overProbability: fair[`OVER_${line}`] },
    bookmakers,
    margin,
  };
}

function rankScore(pick) {
  const ev = Math.max(0, Math.min(pick.expectedValue, 0.5)) / 0.5;
  return 0.5 * pick.probability + 0.35 * ev + 0.15 * (pick.confidence / 100);
}

/**
 * @param {object} input {history, fixtures, oddsEvents, meta}
 */
export function buildDailyReport(input, options = {}) {
  const config = { ...CONFIG, ...(options.config ?? {}) };
  const now = options.now ?? new Date();
  const onProgress = options.onProgress ?? (() => {});

  onProgress('Entrenando modelos (walk-forward)...');
  const artifacts = walkForward(input.history, {
    warmup: config.model.warmupMatches,
    refitEveryDays: config.model.refitEveryDays,
    onProgress,
  });

  const fixtures = [...input.fixtures].sort((a, b) => a.date - b.date);
  const oddsEvents = input.oddsEvents ?? [];
  const matches = [];
  const allPicks = [];

  for (const fixture of fixtures) {
    const feats = artifacts.tracker.featuresFor(fixture, {
      eloModel: artifacts.eloModel,
      dcModel: artifacts.dcModel,
    });
    const rawPrediction = predictFixture(
      fixture,
      {
        dcModel: artifacts.dcModel,
        eloModel: artifacts.eloModel,
        mlModel: artifacts.mlModel,
        weights: artifacts.weights,
        calibration: artifacts.calibration,
      },
      feats.vector,
    );

    const teams = { home: fixture.home, away: fixture.away };
    const coverage = artifacts.tracker.coverage(fixture);
    const event = findOddsEvent(fixture, oddsEvents);
    let oddsBySelection = {};
    let margin = 0.06;
    let bookmakers = 0;

    if (event) {
      const aggregated = aggregateOdds(event, event.homeTeam, event.awayTeam);
      oddsBySelection = aggregated.selections;
      margin = aggregated.margin;
      bookmakers = aggregated.bookmakers;
    }

    const fair = fairProbabilities(oddsBySelection);

    // El mercado entra como prior antes de derivar los mercados, para que todo
    // (1X2, goles, hándicap) salga de una única matriz coherente.
    const prediction = refineWithMarket(
      rawPrediction,
      buildMarketPrior(fair, { bookmakers, margin }),
      { weight: config.model.marketPrior, rho: artifacts.dcModel?.rho ?? 0 },
    );

    const derived = deriveDoubleChance(oddsBySelection, fair, margin);
    for (const [code, value] of Object.entries(derived)) {
      oddsBySelection[code] = value;
      fair[code] = value.fairProbability;
    }

    const meta = {
      agreement: prediction.agreement,
      coverage,
      injuriesKnown: Boolean(fixture.injuriesDetail),
      lineupsKnown: Boolean(fixture.lineups),
    };

    const evaluated = [];
    for (const [code, market] of Object.entries(oddsBySelection)) {
      const selection = probabilityForCode(prediction.matrix, code, teams);
      if (!selection) continue;
      if (!config.markets.includes(selection.market)) continue;
      const pick = evaluateSelection(
        selection,
        {
          odds: market.odds,
          fairProbability: fair[code],
          bookmaker: market.bookmaker,
          bookmakers: market.bookmakers,
          margin,
        },
        meta,
      );
      pick.derived = Boolean(market.derived);
      pick.consensusOdds = market.consensus ?? null;
      evaluated.push(pick);
    }

    const valueBets = evaluated
      .filter(
        (p) =>
          p.expectedValue >= config.value.minExpectedValue &&
          p.edge >= config.value.minEdge &&
          p.probability >= config.value.minProbability &&
          p.odds >= config.value.minOdds &&
          p.odds <= config.value.maxOdds &&
          p.confidence >= config.value.minConfidence &&
          p.expectedValue <= config.value.maxExpectedValue,
      )
      .sort((a, b) => rankScore(b) - rankScore(a))
      .slice(0, config.value.maxPicksPerMatch);

    const context = { features: feats.context, injuries: fixture.injuriesDetail };
    for (const pick of valueBets) {
      pick.score = rankScore(pick);
      pick.reasoning = buildReasoning(fixture, prediction, pick, context);
      pick.summary = shortReasoning(fixture, prediction, pick, context);
      pick.fixtureId = fixture.id;
      pick.homeTeam = fixture.home;
      pick.awayTeam = fixture.away;
      pick.league = fixture.league;
      pick.leagueId = fixture.leagueId;
      pick.kickoff = fixture.date.toISOString();
      pick.day = dayKey(fixture.date);
      allPicks.push(pick);
    }

    matches.push({
      id: fixture.id,
      league: fixture.league,
      leagueId: fixture.leagueId,
      leagueGroup: fixture.leagueGroup ?? 'otras',
      country: fixture.country ?? null,
      round: fixture.round ?? null,
      venue: fixture.venue ?? null,
      neutral: Boolean(fixture.neutral),
      kickoff: fixture.date.toISOString(),
      day: dayKey(fixture.date),
      home: fixture.home,
      away: fixture.away,
      homeLogo: fixture.homeLogo ?? null,
      awayLogo: fixture.awayLogo ?? null,
      probabilities: {
        home: prediction.probabilities.home,
        draw: prediction.probabilities.draw,
        away: prediction.probabilities.away,
      },
      modelParts: prediction.parts,
      modelProbabilities: prediction.modelProbabilities ?? prediction.probabilities,
      marketWeight: prediction.marketWeight ?? 0,
      agreement: prediction.agreement,
      coverage,
      confidence: valueBets[0]?.confidence ?? null,
      lambdas: prediction.lambdas,
      expectedGoals: expectedTotalGoals(prediction.matrix),
      topScorelines: topScorelines(prediction.matrix, 3),
      markets: summarizeMarkets(prediction.matrix, teams, oddsBySelection),
      picks: valueBets,
      bookmakers,
      margin,
      hasOdds: Boolean(event),
      injuries: fixture.injuriesDetail ?? null,
      lineups: fixture.lineups ?? null,
      form: {
        home: roundSummary(feats.context.home),
        away: roundSummary(feats.context.away),
      },
      h2h: feats.context.h2h,
    });
  }

  const ranked = [...allPicks].sort((a, b) => rankScore(b) - rankScore(a));
  const todayKey = dayKey(now);
  const tomorrowKey = dayKey(new Date(now.getTime() + DAY));

  const parlayPool = ranked.filter((p) => p.day === todayKey);
  const parlays = buildParlays(
    (parlayPool.length >= 4 ? parlayPool : ranked).map((p) => ({ ...p })),
  );

  return {
    generatedAt: now.toISOString(),
    days: { today: todayKey, tomorrow: tomorrowKey },
    leagues: leagueSummary(matches),
    groups: LEAGUE_GROUPS,
    matches,
    topPicks: ranked.slice(0, config.value.topPicks).map((p, i) => ({ ...p, rank: i + 1 })),
    parlays,
    bankroll: config.bankroll,
    model: {
      weights: artifacts.weights,
      calibration: artifacts.calibration,
      featureImportance: artifacts.featureImportance,
      matchesUsed: artifacts.matchesUsed,
      refits: artifacts.refits,
      dixonColes: {
        homeAdvantage: Number(artifacts.dcModel?.homeAdvantage?.toFixed(4) ?? 0),
        rho: artifacts.dcModel?.rho ?? 0,
        teams: artifacts.dcModel?.teams?.length ?? 0,
      },
      marketLabels: MARKET_LABELS,
    },
    artifacts,
  };
}

function roundSummary(s) {
  return {
    games: s.games,
    form: Number(s.form.toFixed(2)),
    xgFor: Number(s.xgFor.toFixed(2)),
    xgAgainst: Number(s.xgAgainst.toFixed(2)),
    goalDiff: Number(s.goalDiff.toFixed(2)),
    restDays: Math.round(s.restDays),
    congestion: s.congestion,
  };
}

function findOddsEvent(fixture, oddsEvents) {
  const sameDay = oddsEvents.filter(
    (e) =>
      Math.abs(e.commenceTime - fixture.date) < 6 * 3600 * 1000 &&
      (!e.leagueId || !fixture.leagueId || e.leagueId === fixture.leagueId),
  );
  const pool = sameDay.length ? sameDay : oddsEvents.filter((e) => Math.abs(e.commenceTime - fixture.date) < 12 * 3600 * 1000);
  const found = matchFixture(fixture.home, fixture.away, pool, 0.75);
  return found?.fixture ?? null;
}

/** Tabla de mercados para la ficha del partido (con o sin cuota disponible). */
function summarizeMarkets(matrix, teams, oddsBySelection) {
  const codes = [
    '1', 'X', '2',
    '1X', '12', 'X2',
    'OVER_1.5', 'UNDER_1.5', 'OVER_2.5', 'UNDER_2.5', 'OVER_3.5', 'UNDER_3.5',
    'BTTS_SI', 'BTTS_NO',
    'AH_HOME_-1', 'AH_HOME_-0.5', 'AH_AWAY_0.5', 'AH_AWAY_1',
  ];
  const rows = [];
  for (const code of codes) {
    const selection = probabilityForCode(matrix, code, teams);
    if (!selection) continue;
    const market = oddsBySelection[code];
    rows.push({
      market: selection.market,
      code,
      label: selection.label,
      probability: selection.probability,
      push: selection.push ?? 0,
      odds: market?.odds ?? null,
      bookmaker: market?.bookmaker ?? null,
      expectedValue: market ? selection.probability * market.odds - 1 : null,
    });
  }
  return rows;
}

function leagueSummary(matches) {
  const counts = new Map();
  for (const m of matches) {
    const row = counts.get(m.leagueId) ?? {
      id: m.leagueId,
      name: m.league,
      group: m.leagueGroup,
      matches: 0,
      picks: 0,
    };
    row.matches += 1;
    row.picks += m.picks.length;
    counts.set(m.leagueId, row);
  }
  const order = new Map(LEAGUES.map((l, i) => [l.id, i]));
  return [...counts.values()].sort(
    (a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99),
  );
}

export { rankScore };
