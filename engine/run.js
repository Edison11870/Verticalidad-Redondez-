#!/usr/bin/env node
/**
 * Actualización de la web.
 *
 *   node engine/run.js               # datos reales (requiere claves)
 *   node engine/run.js --prematch    # refresco de cuotas y alineaciones
 *   node engine/run.js --check       # comprueba las claves sin publicar nada
 *   node engine/run.js --demo        # datos simulados (sólo para desarrollo)
 *   node engine/run.js --full-history # fuerza la recarga completa del histórico
 *
 * Variables de entorno:
 *   API_FOOTBALL_KEY   api-sports.io — partidos, resultados, lesiones, alineaciones
 *   FOOTBALL_DATA_KEY  football-data.org — alternativa gratuita, menos ligas
 *   ODDS_API_KEY       the-odds-api.com — cuotas de varias casas
 *
 * Sin claves NO se inventan datos: se publica un estado de "configuración
 * pendiente" que la web muestra con las instrucciones. El modo demostración
 * existe sólo para desarrollo y hay que pedirlo explícitamente.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildDailyReport, dayKey } from './pipeline.js';
import { runBacktest } from './lib/backtest.js';
import { generateDemoData } from './demo.js';
import { CONFIG, LEAGUES } from './config.js';
import {
  readJson,
  writeJson,
  mergeHistory,
  settleReport,
  summarizeHistory,
  readHistoryCache,
  writeHistoryCache,
  mergeMatches,
  datesBetween,
} from './lib/store.js';
import { RequestBudget } from './sources/http.js';
import * as apiFootball from './sources/apiFootball.js';
import * as footballData from './sources/footballData.js';
import { fetchOdds, checkOddsKey } from './sources/oddsApi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'apuestas/data');
const DAY = 86400000;

const log = (...args) => console.log('[apuestas]', ...args);

function parseArgs(argv) {
  return {
    demo: argv.includes('--demo'),
    prematch: argv.includes('--prematch'),
    check: argv.includes('--check'),
    fullHistory: argv.includes('--full-history'),
    backtest: !argv.includes('--no-backtest'),
    out: DATA_DIR,
  };
}

function readKeys() {
  return {
    apiFootball: process.env.API_FOOTBALL_KEY?.trim() || null,
    footballData: process.env.FOOTBALL_DATA_KEY?.trim() || null,
    odds: process.env.ODDS_API_KEY?.trim() || null,
  };
}

/* ---------------------------- diagnóstico ---------------------------- */

async function checkKeys(keys) {
  let allOk = true;

  if (keys.apiFootball) {
    try {
      const status = await apiFootball.checkKey(keys.apiFootball);
      log(
        `API-Football: OK · plan "${status.plan}" · ${status.used}/${status.limit} peticiones usadas hoy`,
      );
      if (status.limit && status.limit - status.used < 60) {
        log('  Aviso: queda poca cuota para una actualización completa (necesita ~45).');
      }
    } catch (error) {
      allOk = false;
      log(`API-Football: FALLA — ${error.message}`);
    }
  } else {
    log('API-Football: sin configurar (API_FOOTBALL_KEY)');
  }

  if (keys.footballData) {
    try {
      const data = await footballData.checkKey(keys.footballData);
      log(`football-data.org: OK · ${data.competitions} competiciones accesibles`);
    } catch (error) {
      allOk = false;
      log(`football-data.org: FALLA — ${error.message}`);
    }
  } else {
    log('football-data.org: sin configurar (FOOTBALL_DATA_KEY)');
  }

  if (keys.odds) {
    try {
      const status = await checkOddsKey(keys.odds);
      log(
        `The Odds API: OK · ${status.sports} deportes · ${status.used} créditos usados, quedan ${status.remaining}`,
      );
      const perRun = estimateOddsCost();
      log(
        `  Coste estimado por actualización: ~${perRun} créditos (${CONFIG.odds.regions} / ${CONFIG.odds.markets}).`,
      );
      if (status.remaining < perRun * 10) {
        log('  Aviso: con el crédito restante quedan menos de 10 actualizaciones.');
      }
    } catch (error) {
      allOk = false;
      log(`The Odds API: FALLA — ${error.message}`);
    }
  } else {
    log('The Odds API: sin configurar (ODDS_API_KEY) — habrá probabilidades, pero no apuestas de valor');
  }

  if (!keys.apiFootball && !keys.footballData) {
    allOk = false;
    log('Falta una fuente de datos: configura API_FOOTBALL_KEY o FOOTBALL_DATA_KEY.');
  }
  return allOk;
}

function estimateOddsCost() {
  const perCall = CONFIG.odds.regions.split(',').length * CONFIG.odds.markets.split(',').length;
  const leagues = LEAGUES.filter((l) => l.oddsKey).length;
  // Con el filtro por partidos del día suelen consultarse ~1/3 de las ligas.
  return Math.round(perCall * Math.max(4, Math.ceil(leagues / 3)));
}

/* ------------------------------ descarga ----------------------------- */

/** Histórico: descarga completa la primera vez, incremental después. */
async function loadHistory({ keys, now, budget, forceFull }) {
  const cachePath = resolve(ROOT, CONFIG.cache.historyFile);
  const cache = await readHistoryCache(cachePath);
  const ageDays = cache.updatedAt ? (now - cache.updatedAt) / DAY : Infinity;
  const needsFull = forceFull || !cache.matches.length || ageDays > CONFIG.cache.refreshDays;

  let fresh = [];

  if (needsFull) {
    log(
      cache.matches.length
        ? `Caché de ${cache.matches.length} partidos con ${ageDays.toFixed(0)} días: recarga completa.`
        : 'Sin caché de histórico: primera descarga completa (es la más cara en peticiones).',
    );
    if (keys.apiFootball) {
      fresh = await apiFootball.fetchHistory(keys.apiFootball, {
        seasons: CONFIG.model.historySeasons,
        budget,
        onProgress: (m) => log(' ', m),
      });
    } else {
      fresh = await footballData.fetchHistory(keys.footballData, {
        seasons: CONFIG.model.historySeasons,
        budget,
        onProgress: (m) => log(' ', m),
      });
    }
  } else if (keys.apiFootball) {
    // Incremental: una petición por día pendiente cubre todas las ligas.
    const from = new Date(cache.updatedAt.getTime() - 2 * DAY);
    const days = datesBetween(from, now);
    log(`Caché al día (${cache.matches.length} partidos): actualizando ${days.length} fechas.`);
    for (const day of days) {
      try {
        const results = await apiFootball.fetchResultsByDate(keys.apiFootball, day, { budget });
        fresh.push(...results);
      } catch (error) {
        log(`  No se pudieron leer los resultados de ${day}: ${error.message}`);
      }
    }
  } else {
    log(`Caché al día (${cache.matches.length} partidos).`);
  }

  const matches = mergeMatches(cache.matches, fresh, CONFIG.cache.maxAgeDays);
  if (matches.length) {
    await writeHistoryCache(cachePath, matches, {
      source: keys.apiFootball ? 'API-Football' : 'football-data.org',
      seasons: CONFIG.model.historySeasons,
    });
  }
  return { matches, added: fresh.length, fullRefresh: needsFull };
}

/** Partidos de hoy y mañana, con lesiones y (si toca) alineaciones. */
async function loadFixtures({ keys, now, budget, prematch }) {
  const fixtures = [];
  const days = [dayKey(now), dayKey(new Date(now.getTime() + DAY))];

  if (keys.apiFootball) {
    for (const day of days) {
      const list = await apiFootball.fetchFixturesByDate(keys.apiFootball, day, { budget });
      fixtures.push(...list);
      log(`Partidos ${day}: ${list.length}`);
    }

    // Las bajas se piden liga por liga, así que sólo se consultan las ligas
    // que juegan hoy: era el mayor coste recurrente de cuota.
    const activeLeagueIds = new Set(fixtures.map((f) => f.leagueId));
    const activeLeagues = LEAGUES.filter((l) => activeLeagueIds.has(l.id));
    const injuries = await apiFootball.fetchInjuries(keys.apiFootball, {
      leagues: activeLeagues,
      date: days[0],
      budget,
    });
    log(`Bajas: consultando ${activeLeagues.length} ligas con partidos`);
    let withInjuries = 0;
    for (const fixture of fixtures) {
      const list = injuries.get(fixture.providerId);
      if (!list?.length) continue;
      const { detail, impact } = apiFootball.assignInjuries(fixture, list);
      fixture.injuriesDetail = detail;
      fixture.injuries = impact;
      withInjuries += 1;
    }
    log(`Bajas localizadas en ${withInjuries} partidos`);

    if (prematch) {
      const soon = fixtures.filter((f) => f.date - now < 3 * 3600 * 1000 && f.date > now);
      for (const fixture of soon) {
        const lineups = await apiFootball.fetchLineups(keys.apiFootball, fixture.providerId, budget);
        if (lineups) fixture.lineups = lineups;
      }
      log(`Alineaciones consultadas para ${soon.length} partidos próximos`);
    }
  } else {
    for (const day of days) {
      const list = await footballData.fetchFixturesByDate(keys.footballData, day, { budget });
      fixtures.push(...list);
      log(`Partidos ${day}: ${list.length}`);
    }
  }

  return fixtures;
}

/** Cuotas sólo de las ligas que tienen partidos próximos: cada liga cuesta crédito. */
async function loadOdds({ keys, fixtures, now, budget, prematch = false }) {
  if (!keys.odds) return { events: [], credits: null };

  let leagues = LEAGUES.filter((l) => l.oddsKey);
  if (CONFIG.odds.onlyLeaguesWithFixtures) {
    // El refresco prepartido sólo mira lo que empieza pronto: menos ligas,
    // menos crédito gastado.
    const hours = prematch ? CONFIG.odds.prematchHoursAhead : CONFIG.odds.hoursAhead;
    const horizon = now.getTime() + hours * 3600 * 1000;
    const active = new Set(
      fixtures.filter((f) => f.date.getTime() <= horizon).map((f) => f.leagueId),
    );
    leagues = leagues.filter((l) => active.has(l.id));
    log(`Cuotas: ${leagues.length} ligas con partidos en las próximas ${hours} h`);
  }
  if (!leagues.length) return { events: [], credits: null };

  return fetchOdds(keys.odds, {
    leagues,
    regions: CONFIG.odds.regions,
    markets: CONFIG.odds.markets,
    budget,
    onProgress: (m) => log(' ', m),
  });
}

/* ----------------------------- liquidación --------------------------- */

async function settlePrevious({ previous, keys, historyMatches }) {
  if (!previous?.matches?.length) return [];
  const results = new Map();
  for (const match of historyMatches ?? []) {
    results.set(match.id, { homeGoals: match.homeGoals, awayGoals: match.awayGoals });
  }

  if (keys.apiFootball) {
    const pendingDays = [...new Set(previous.matches.map((m) => m.day))];
    for (const day of pendingDays) {
      if (results.size && previous.matches.every((m) => results.has(m.id))) break;
      try {
        const list = await apiFootball.fetchResultsByDate(keys.apiFootball, day, {});
        for (const f of list) results.set(f.id, { homeGoals: f.homeGoals, awayGoals: f.awayGoals });
      } catch (error) {
        log(`No se pudieron liquidar los partidos de ${day}: ${error.message}`);
      }
    }
  }

  return settleReport(previous, results);
}

/* ------------------------- estado sin configurar --------------------- */

function setupState(keys, now) {
  const missing = [];
  if (!keys.apiFootball && !keys.footballData) {
    missing.push({
      key: 'API_FOOTBALL_KEY',
      name: 'API-Football',
      url: 'https://www.api-football.com/',
      what: 'Partidos, resultados, xG, lesiones y alineaciones de todas las ligas.',
      alternative: 'FOOTBALL_DATA_KEY (football-data.org), gratuita pero con menos competiciones.',
    });
  }
  if (!keys.odds) {
    missing.push({
      key: 'ODDS_API_KEY',
      name: 'The Odds API',
      url: 'https://the-odds-api.com/',
      what: 'Cuotas de varias casas. Sin ellas hay probabilidades, pero no se puede detectar valor.',
      alternative: null,
    });
  }
  return {
    generatedAt: now.toISOString(),
    configured: false,
    missingKeys: missing,
    demo: false,
    dataSources: [],
    days: { today: dayKey(now), tomorrow: dayKey(new Date(now.getTime() + DAY)) },
    leagues: [],
    groups: [],
    matches: [],
    topPicks: [],
    parlays: [],
    bankroll: CONFIG.bankroll,
    model: {},
    disclaimer:
      'Ninguna predicción garantiza resultados. Las probabilidades son estimaciones estadísticas con margen de error.',
  };
}

/* -------------------------------- main -------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const keys = readKeys();

  if (args.check) {
    const ok = await checkKeys(keys);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const hasSource = Boolean(keys.apiFootball || keys.footballData);

  // Sin fuente de datos no se inventa nada: se publica el estado de
  // configuración pendiente y la web explica qué falta.
  if (!hasSource && !args.demo) {
    log('Sin claves de API configuradas. Se publica el estado de configuración pendiente.');
    log('Configura API_FOOTBALL_KEY (o FOOTBALL_DATA_KEY) y ODDS_API_KEY, o usa --demo para desarrollo.');
    await writeJson(`${args.out}/latest.json`, setupState(keys, now));
    await writeJson(`${args.out}/history.json`, {
      generatedAt: now.toISOString(),
      configured: false,
      demo: false,
      summary: summarizeHistory([]),
      totalEntries: 0,
      entries: [],
    });
    process.exitCode = 1;
    return;
  }

  let data;
  let sources;
  let requests = 0;
  let oddsCredits = null;

  if (args.demo) {
    log('MODO DEMOSTRACIÓN: datos simulados. No publiques esto como si fuera real.');
    data = generateDemoData({ now });
    sources = ['Datos simulados (demo)'];
  } else {
    const budget = new RequestBudget(Number(process.env.REQUEST_BUDGET ?? 400));
    sources = [];

    const history = await loadHistory({ keys, now, budget, forceFull: args.fullHistory });
    if (!history.matches.length) {
      log('El proveedor no devolvió histórico: se aborta para no publicar predicciones sin base.');
      process.exitCode = 1;
      return;
    }
    sources.push(keys.apiFootball ? 'API-Football' : 'football-data.org');

    const fixtures = await loadFixtures({ keys, now, budget, prematch: args.prematch });
    const odds = await loadOdds({ keys, fixtures, now, budget, prematch: args.prematch });
    if (keys.odds) sources.push('The Odds API');
    oddsCredits = odds.credits;

    data = { history: history.matches, fixtures, oddsEvents: odds.events };
    requests = budget.used;
    log(
      `Histórico: ${history.matches.length} partidos (${history.added} nuevos) · Programados: ${fixtures.length} · Con cuotas: ${odds.events.length}`,
    );

    if (!fixtures.length) {
      log('No hay partidos programados para hoy ni mañana en las ligas configuradas.');
    }
  }

  const report = buildDailyReport(
    { history: data.history, fixtures: data.fixtures, oddsEvents: data.oddsEvents },
    { now, onProgress: (m) => log(m) },
  );

  delete report.artifacts;
  report.configured = true;
  report.demo = Boolean(args.demo);
  report.dataSources = sources;
  report.apiRequests = requests;
  report.oddsCredits = oddsCredits;
  report.hasOdds = data.oddsEvents.length > 0;
  report.updateType = args.prematch ? 'prepartido' : 'diaria';
  report.disclaimer =
    'Ninguna predicción garantiza resultados. Las probabilidades son estimaciones estadísticas con margen de error. Apuesta sólo lo que puedas permitirte perder.';

  let backtest = await readJson(`${args.out}/backtest.json`, null);
  if (args.backtest) {
    log('Ejecutando backtesting walk-forward...');
    const started = Date.now();
    const result = runBacktest(data.history, {
      warmup: CONFIG.model.warmupMatches,
      refitEveryDays: CONFIG.model.refitEveryDays,
      minEdge: CONFIG.value.minEdge,
      minExpectedValue: CONFIG.value.minExpectedValue,
      onProgress: (m) => log(m),
    });
    if (result.insufficientData) {
      log('Histórico insuficiente para el backtesting: se conserva el anterior.');
    } else {
      backtest = result;
      backtest.simulatedMarket = Boolean(args.demo);
      backtest.generatedAt = new Date().toISOString();
      backtest.durationMs = Date.now() - started;
      log(
        `Backtest: ${backtest.matchesEvaluated} partidos · acierto ${(backtest.accuracy * 100).toFixed(1)}% · Brier ${backtest.brierScore?.toFixed(4)} · ROI ${(backtest.betting.roi * 100).toFixed(2)}%`,
      );
    }
  }

  // Historial publicado: se liquida el informe anterior contra los resultados.
  const previous = await readJson(`${args.out}/latest.json`, null);
  const existingHistory = (await readJson(`${args.out}/history.json`, null))?.entries ?? [];
  const settled = await settlePrevious({
    previous: previous?.configured === false ? null : previous,
    keys: args.demo ? {} : keys,
    historyMatches: data.history,
  });
  if (settled.length) log(`Liquidados ${settled.length} pronósticos del informe anterior`);

  // Los pronósticos reales se acumulan; el tramo simulado se regenera entero.
  let entries = mergeHistory(existingHistory.filter((e) => !e.simulated), settled);

  if (args.demo && backtest?.sampleBets?.length) {
    entries = mergeHistory(
      entries,
      backtest.sampleBets.map((b, i) => ({
        date: b.date,
        fixtureId: `bt-${i}`,
        league: b.league,
        leagueId: null,
        match: b.match,
        score: null,
        market: '1x2',
        code: null,
        label: b.label,
        odds: b.odds,
        probability: b.probability,
        confidence: b.confidence,
        stake: 1,
        result: b.won ? 'win' : 'loss',
        profit: b.profit,
        simulated: true,
      })),
    );
  }

  const summary = summarizeHistory(entries);
  await writeJson(`${args.out}/latest.json`, report);
  await writeJson(`${args.out}/history.json`, {
    generatedAt: new Date().toISOString(),
    configured: true,
    demo: Boolean(args.demo),
    summary,
    totalEntries: entries.length,
    entries: entries.slice(0, 400),
  });
  if (backtest) await writeJson(`${args.out}/backtest.json`, backtest);

  log(
    `Listo: ${report.matches.length} partidos, ${report.topPicks.length} apuestas destacadas, ${report.parlays.filter((p) => p.available).length}/3 combinadas` +
      (requests ? ` · ${requests} peticiones` : ''),
  );
  if (!report.hasOdds && !args.demo) {
    log('Sin cuotas: se publican probabilidades reales, pero no hay apuestas de valor que mostrar.');
  }
}

main().catch((error) => {
  console.error('[apuestas] Error fatal:', error);
  process.exitCode = 1;
});
