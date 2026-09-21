/**
 * Backtesting walk-forward: reutiliza el mismo bucle que el entrenamiento
 * (engine/lib/train.js) y añade el registro de apuestas simuladas para medir
 * acierto, ROI, Brier score y calibración.
 */

import { walkForward, outcomeOf } from './train.js';
import {
  brierScore,
  logLoss,
  reliabilityCurve,
  expectedCalibrationError,
} from './calibration.js';
import { buildSelections } from './markets.js';
import { evaluateSelection, removeVig } from './value.js';
import { refineWithMarket } from './ensemble.js';
import { CONFIG } from '../config.js';

export { outcomeOf };

/**
 * @param {Array} matches histórico completo, con date, home, away, goles y (opcional) odds 1X2
 * @param {object} options {warmup, refitEveryDays, minEdge, minExpectedValue, stakeUnits}
 */
export function runBacktest(matches, options = {}) {
  const {
    warmup = 200,
    refitEveryDays = 14,
    minEdge = 0.03,
    minExpectedValue = 0.02,
    stakeUnits = 1,
    onProgress,
  } = options;

  if (matches.length <= warmup + 20) {
    return { insufficientData: true, matchesEvaluated: 0 };
  }

  const bets = [];
  const artifacts = walkForward(matches, {
    warmup,
    refitEveryDays,
    onProgress,
    onPrediction: ({ match, prediction, tracker }) => {
      if (!match.odds) return;
      settleBets(bets, match, prediction, {
        minEdge,
        minExpectedValue,
        maxExpectedValue: CONFIG.value.maxExpectedValue,
        marketPrior: CONFIG.model.marketPrior,
        stakeUnits,
        agreement: prediction.agreement,
        coverage: tracker.coverage(match),
      });
    },
  });

  const summary = summarize(
    artifacts.records.map((r) => ({ ...r, predicted: bestOutcome(r.probabilities) })),
    bets,
  );
  // Todas las apuestas simuladas: el historial de la demo se construye con
  // ellas y sus métricas deben cuadrar con las del backtesting.
  summary.sampleBets = bets.map((b) => ({
    date: b.date.toISOString().slice(0, 10),
    league: b.league,
    match: b.match,
    label: b.label,
    odds: Number(b.odds.toFixed(2)),
    probability: Number(b.probability.toFixed(4)),
    confidence: b.confidence,
    won: b.won,
    profit: Number(b.profit.toFixed(2)),
  }));

  return {
    ...summary,
    refits: artifacts.refits,
    weights: artifacts.weights,
    calibration: artifacts.calibration,
  };
}

function bestOutcome(p) {
  if (p.home >= p.draw && p.home >= p.away) return 'home';
  if (p.draw >= p.away) return 'draw';
  return 'away';
}

function settleBets(bets, match, prediction, config) {
  // El margen se quita sobre el consenso del mercado; la apuesta se registra a
  // la mejor cuota disponible. Quitar el margen sobre la mejor cuota inventaría
  // valor que no existe.
  const reference = match.odds.consensus ?? match.odds;
  const fair = removeVig([reference.home, reference.draw, reference.away]);

  // Mismo tratamiento que en producción: el mercado entra como prior antes de
  // buscar valor. Medir sin este paso daría un ROI que el sistema real no tiene.
  const refined = refineWithMarket(
    prediction,
    {
      oneX2: { home: fair[0], draw: fair[1], away: fair[2] },
      totals: null,
      bookmakers: match.odds.bookmakers ?? 1,
      margin: match.odds.margin ?? 0.05,
    },
    { weight: config.marketPrior ?? 0, rho: 0 },
  );

  const selections = buildSelections(refined.matrix, {
    home: match.home,
    away: match.away,
  });
  const map = { '1': 0, X: 1, '2': 2 };
  const outcome = outcomeOf(match);

  for (const code of ['1', 'X', '2']) {
    const selection = selections.find((s) => s.code === code);
    const odds = [match.odds.home, match.odds.draw, match.odds.away][map[code]];
    const evaluated = evaluateSelection(
      selection,
      { odds, fairProbability: fair[map[code]], bookmakers: match.odds.bookmakers ?? 1 },
      { agreement: config.agreement, coverage: config.coverage },
    );
    if (evaluated.edge < config.minEdge) continue;
    if (evaluated.expectedValue < config.minExpectedValue) continue;
    if (config.maxExpectedValue && evaluated.expectedValue > config.maxExpectedValue) continue;

    const won =
      (code === '1' && outcome === 'home') ||
      (code === 'X' && outcome === 'draw') ||
      (code === '2' && outcome === 'away');
    bets.push({
      date: match.date,
      league: match.league ?? null,
      match: `${match.home} vs ${match.away}`,
      label: evaluated.label,
      stake: config.stakeUnits,
      odds,
      probability: evaluated.probability,
      confidence: evaluated.confidence,
      won,
      profit: won ? config.stakeUnits * (odds - 1) : -config.stakeUnits,
    });
  }
}

function summarize(records, bets) {
  if (!records.length) return { insufficientData: true, matchesEvaluated: 0 };

  const probs = records.map((r) => r.probabilities);
  const outcomes = records.map((r) => r.outcome);
  const hits = records.filter((r) => r.predicted === r.outcome).length;
  const curve = reliabilityCurve(probs, outcomes);

  const staked = bets.reduce((s, b) => s + b.stake, 0);
  const profit = bets.reduce((s, b) => s + b.profit, 0);
  const wonBets = bets.filter((b) => b.won).length;

  const byMonth = new Map();
  for (const bet of bets) {
    const key = `${bet.date.getUTCFullYear()}-${String(bet.date.getUTCMonth() + 1).padStart(2, '0')}`;
    const row = byMonth.get(key) ?? { month: key, bets: 0, staked: 0, profit: 0 };
    row.bets += 1;
    row.staked += bet.stake;
    row.profit += bet.profit;
    byMonth.set(key, row);
  }

  return {
    insufficientData: false,
    matchesEvaluated: records.length,
    from: records[0].date.toISOString().slice(0, 10),
    to: records[records.length - 1].date.toISOString().slice(0, 10),
    accuracy: hits / records.length,
    brierScore: brierScore(probs, outcomes),
    logLoss: logLoss(probs, outcomes),
    calibrationError: expectedCalibrationError(curve),
    reliability: curve.map((b) => ({
      from: Number(b.from.toFixed(2)),
      to: Number(b.to.toFixed(2)),
      predicted: Number(b.predicted.toFixed(4)),
      observed: Number(b.observed.toFixed(4)),
      count: b.count,
    })),
    betting: {
      bets: bets.length,
      won: wonBets,
      hitRate: bets.length ? wonBets / bets.length : 0,
      staked: Number(staked.toFixed(2)),
      profit: Number(profit.toFixed(2)),
      roi: staked ? profit / staked : 0,
      averageOdds: bets.length ? bets.reduce((s, b) => s + b.odds, 0) / bets.length : 0,
      monthly: [...byMonth.values()]
        .sort((a, b) => a.month.localeCompare(b.month))
        .map((m) => ({
          month: m.month,
          bets: m.bets,
          profit: Number(m.profit.toFixed(2)),
          roi: m.staked ? Number((m.profit / m.staked).toFixed(4)) : 0,
        })),
    },
  };
}
