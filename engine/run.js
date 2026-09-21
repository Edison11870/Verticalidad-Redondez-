#!/usr/bin/env node
/**
 * Actualización diaria de la web.
 *
 *   node engine/run.js               # usa las claves de API si existen; si no, modo demo
 *   node engine/run.js --demo        # fuerza datos simulados
 *   node engine/run.js --prematch    # refresco de cuotas/alineaciones antes de los partidos
 *   node engine/run.js --no-backtest # salta el backtesting (más rápido)
 *   node engine/run.js --strict     # falla si no hay claves (para tareas automáticas)
 *
 * Variables de entorno:
 *   API_FOOTBALL_KEY   clave de api-sports.io (datos, lesiones, alineaciones, xG)
 *   FOOTBALL_DATA_KEY  clave de football-data.org (alternativa gratuita)
 *   ODDS_API_KEY       clave de the-odds-api.com (cuotas)
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildDailyReport, dayKey } from './pipeline.js';
import { runBacktest } from './lib/backtest.js';
import { generateDemoData } from './demo.js';
import { CONFIG, LEAGUES } from './config.js';
import { readJson, writeJson, mergeHistory, settleReport, summarizeHistory } from './lib/store.js';
import { RequestBudget } from './sources/http.js';
import * as apiFootball from './sources/apiFootball.js';
import * as footballData from './sources/footballData.js';
import { fetchOdds } from './sources/oddsApi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '../apuestas/data');
const DAY = 86400000;

const log = (...args) => console.log('[apuestas]', ...args);

function parseArgs(argv) {
  return {
    demo: argv.includes('--demo'),
    // En automatizaciones, publicar datos de demostración por error sería peor
    // que no publicar nada: --strict aborta si faltan las claves.
    strict: argv.includes('--strict'),
    prematch: argv.includes('--prematch'),
    backtest: !argv.includes('--no-backtest'),
    out: DATA_DIR,
  };
}

/** Descarga histórico, fixtures, cuotas y lesiones con el proveedor disponible. */
async function loadRealData({ apiFootballKey, footballDataKey, oddsKey, now, prematch }) {
  const budget = new RequestBudget(Number(process.env.REQUEST_BUDGET ?? 400));
  const sources = [];
  let history = [];
  let fixtures = [];

  if (apiFootballKey) {
    sources.push('API-Football');
    history = await apiFootball.fetchHistory(apiFootballKey, {
      seasons: CONFIG.model.historySeasons,
      budget,
      onProgress: (m) => log(m),
    });
    const days = [dayKey(now), dayKey(new Date(now.getTime() + DAY))];
    for (const day of days) {
      const list = await apiFootball.fetchFixturesByDate(apiFootballKey, day, { budget });
      fixtures.push(...list);
      log(`Fixtures ${day}: ${list.length}`);
    }

    const injuries = await apiFootball.fetchInjuries(apiFootballKey, {
      date: dayKey(now),
      budget,
    });
    for (const fixture of fixtures) {
      const list = injuries.get(fixture.providerId);
      if (!list?.length) continue;
      const { detail, impact } = apiFootball.assignInjuries(fixture, list);
      fixture.injuriesDetail = detail;
      fixture.injuries = impact;
    }

    if (prematch) {
      const soon = fixtures.filter((f) => f.date - now < 3 * 3600 * 1000);
      for (const fixture of soon) {
        const lineups = await apiFootball.fetchLineups(apiFootballKey, fixture.providerId, budget);
        if (lineups) fixture.lineups = lineups;
      }
      log(`Alineaciones consultadas para ${soon.length} partidos`);
    }
  } else if (footballDataKey) {
    sources.push('football-data.org');
    history = await footballData.fetchHistory(footballDataKey, {
      seasons: CONFIG.model.historySeasons,
      budget,
      onProgress: (m) => log(m),
    });
    for (const day of [dayKey(now), dayKey(new Date(now.getTime() + DAY))]) {
      const list = await footballData.fetchFixturesByDate(footballDataKey, day, { budget });
      fixtures.push(...list);
    }
  }

  let oddsEvents = [];
  if (oddsKey) {
    sources.push('The Odds API');
    oddsEvents = await fetchOdds(oddsKey, { leagues: LEAGUES, budget, onProgress: (m) => log(m) });
  }

  return { history, fixtures, oddsEvents, sources, requests: budget.used };
}

/** Liquida el informe anterior contra los resultados ya disponibles. */
async function settlePrevious({ previous, apiFootballKey, historyMatches }) {
  if (!previous?.matches?.length) return [];
  const results = new Map();

  for (const match of historyMatches ?? []) {
    results.set(match.id, { homeGoals: match.homeGoals, awayGoals: match.awayGoals });
  }

  if (apiFootballKey) {
    const pendingDays = [...new Set(previous.matches.map((m) => m.day))];
    for (const day of pendingDays) {
      try {
        const list = await apiFootball.fetchFixturesByDate(apiFootballKey, day, {});
        for (const f of list) {
          if (f.finished) results.set(f.id, { homeGoals: f.homeGoals, awayGoals: f.awayGoals });
        }
      } catch (error) {
        log(`No se pudieron liquidar los partidos de ${day}: ${error.message}`);
      }
    }
  }

  return settleReport(previous, results);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const apiFootballKey = process.env.API_FOOTBALL_KEY?.trim();
  const footballDataKey = process.env.FOOTBALL_DATA_KEY?.trim();
  const oddsKey = process.env.ODDS_API_KEY?.trim();

  const useDemo = args.demo || (!apiFootballKey && !footballDataKey);
  if (useDemo && args.strict && !args.demo) {
    console.error(
      '[apuestas] --strict: faltan API_FOOTBALL_KEY o FOOTBALL_DATA_KEY. No se publica nada para no sustituir datos reales por una demostración.',
    );
    process.exitCode = 1;
    return;
  }
  let data;
  let sources;
  let requests = 0;

  if (useDemo) {
    log('Modo DEMOSTRACIÓN: datos simulados (sin claves de API configuradas)');
    data = generateDemoData({ now });
    sources = ['Datos simulados (demo)'];
  } else {
    log('Descargando datos reales...');
    const loaded = await loadRealData({
      apiFootballKey,
      footballDataKey,
      oddsKey,
      now,
      prematch: args.prematch,
    });
    data = loaded;
    sources = loaded.sources;
    requests = loaded.requests;
    log(`Histórico: ${data.history.length} partidos · Fixtures: ${data.fixtures.length} · Cuotas: ${data.oddsEvents.length}`);
    if (!data.history.length) {
      log('Sin histórico utilizable: se aborta para no publicar predicciones vacías.');
      process.exitCode = 1;
      return;
    }
  }

  const report = buildDailyReport(
    { history: data.history, fixtures: data.fixtures, oddsEvents: data.oddsEvents },
    { now, onProgress: (m) => log(m) },
  );

  delete report.artifacts;
  report.demo = Boolean(useDemo);
  report.dataSources = sources;
  report.apiRequests = requests;
  report.updateType = args.prematch ? 'prepartido' : 'diaria';
  report.disclaimer =
    'Ninguna predicción garantiza resultados. Las probabilidades son estimaciones estadísticas con margen de error. Apuesta sólo lo que puedas permitirte perder.';

  let backtest = await readJson(`${args.out}/backtest.json`, null);
  if (args.backtest) {
    log('Ejecutando backtesting walk-forward...');
    const started = Date.now();
    backtest = runBacktest(data.history, {
      warmup: CONFIG.model.warmupMatches,
      refitEveryDays: CONFIG.model.refitEveryDays,
      minEdge: CONFIG.value.minEdge,
      minExpectedValue: CONFIG.value.minExpectedValue,
      onProgress: (m) => log(m),
    });
    backtest.simulatedMarket = Boolean(useDemo);
    backtest.generatedAt = new Date().toISOString();
    backtest.durationMs = Date.now() - started;
    log(
      `Backtest: ${backtest.matchesEvaluated} partidos · acierto ${(backtest.accuracy * 100).toFixed(1)}% · Brier ${backtest.brierScore?.toFixed(4)} · ROI ${(backtest.betting.roi * 100).toFixed(2)}%`,
    );
  }

  // Historial publicado: se liquida el informe del día anterior.
  const previous = await readJson(`${args.out}/latest.json`, null);
  const existingHistory = (await readJson(`${args.out}/history.json`, null))?.entries ?? [];
  const settled = await settlePrevious({
    previous,
    apiFootballKey: useDemo ? null : apiFootballKey,
    historyMatches: data.history,
  });
  if (settled.length) log(`Liquidados ${settled.length} pronósticos del informe anterior`);

  // Los pronósticos reales se acumulan; el tramo simulado se regenera entero en
  // cada corrida. Si se fuese acumulando, cada ejecución de la demo duplicaría
  // el historial y las métricas dejarían de cuadrar con el backtesting.
  let entries = mergeHistory(existingHistory.filter((e) => !e.simulated), settled);

  // En modo demo no hay historial real todavía: se muestra el del backtesting,
  // marcado como simulado, para que la vista de aciertos no salga vacía.
  if (useDemo && backtest?.sampleBets?.length) {
    const simulated = backtest.sampleBets.map((b, i) => ({
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
    }));
    entries = mergeHistory(entries, simulated);
  }

  // El resumen se calcula sobre TODO el historial; la lista publicada se recorta
  // para no hacer pesada la descarga en móvil.
  const summary = summarizeHistory(entries);
  const historyPayload = {
    generatedAt: new Date().toISOString(),
    demo: Boolean(useDemo),
    summary,
    totalEntries: entries.length,
    entries: entries.slice(0, 400),
  };

  await writeJson(`${args.out}/latest.json`, report);
  await writeJson(`${args.out}/history.json`, historyPayload);
  if (backtest) await writeJson(`${args.out}/backtest.json`, backtest);

  log(
    `Listo: ${report.matches.length} partidos, ${report.topPicks.length} apuestas destacadas, ${report.parlays.filter((p) => p.available).length}/3 combinadas`,
  );
}

main().catch((error) => {
  console.error('[apuestas] Error fatal:', error);
  process.exitCode = 1;
});
