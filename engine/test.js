/**
 * Pruebas del motor. Se ejecutan con `npm test` (node --test).
 *
 * Cubren lo que de verdad puede romperse en silencio y publicar números
 * equivocados: la coherencia entre mercados, la eliminación del margen, el
 * cálculo del valor esperado, la liquidación de apuestas y las reglas de las
 * combinadas.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fitDixonColes, expectedGoals, scoreMatrix, outcomeProbabilities } from './lib/poisson.js';
import { trainElo, eloProbabilities } from './lib/elo.js';
import { buildSelections, probabilityForCode } from './lib/markets.js';
import { removeVig, expectedValue, kellyStake, impliedProbability } from './lib/value.js';
import { settleSelection, profitFor, mergeHistory, summarizeHistory } from './lib/store.js';
import { buildParlays } from './lib/parlays.js';
import { similarity, matchFixture } from './lib/names.js';
import { solveLambdas, blendWithMarket, marketWeight } from './lib/ensemble.js';
import { brierScore, fitTemperature, calibrate } from './lib/calibration.js';
import { generateDemoData } from './demo.js';
import { buildDailyReport } from './pipeline.js';

const close = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tol, `esperaba ${b}, obtuve ${a} (tolerancia ${tol})`);

test('la matriz de marcadores es una distribución de probabilidad', () => {
  const matrix = scoreMatrix(1.8, 1.1, -0.05);
  const total = matrix.flat().reduce((a, b) => a + b, 0);
  close(total, 1, 1e-9);
  const { home, draw, away } = outcomeProbabilities(matrix);
  close(home + draw + away, 1, 1e-9);
});

test('los mercados derivados son coherentes entre sí', () => {
  const matrix = scoreMatrix(1.6, 1.3, -0.03);
  const teams = { home: 'A', away: 'B' };
  const byCode = Object.fromEntries(
    buildSelections(matrix, teams).map((s) => [s.code, s.probability]),
  );
  close(byCode['1'] + byCode.X + byCode['2'], 1, 1e-9);
  close(byCode['1X'], byCode['1'] + byCode.X, 1e-9);
  close(byCode.X2, byCode.X + byCode['2'], 1e-9);
  close(byCode['12'], byCode['1'] + byCode['2'], 1e-9);
  close(byCode.BTTS_SI + byCode.BTTS_NO, 1, 1e-9);
  close(byCode['OVER_2.5'] + byCode['UNDER_2.5'], 1, 1e-9);
  // Hándicap de media: equivale a ganar el partido
  close(byCode['AH_HOME_-0.5'], byCode['1'], 1e-9);
});

test('las líneas enteras devuelven empate técnico (push)', () => {
  const matrix = scoreMatrix(1.5, 1.2, 0);
  const over2 = probabilityForCode(matrix, 'OVER_2.0');
  assert.ok(over2.push > 0, 'más de 2 goles exactos debe poder quedar en nulo');
  close(over2.rawWin + over2.push + over2.lose, 1, 1e-9);
  const ah1 = probabilityForCode(matrix, 'AH_HOME_-1');
  assert.ok(ah1.push > 0);
  close(ah1.probability, ah1.rawWin / (ah1.rawWin + ah1.lose), 1e-9);
});

test('las líneas de cuarto se parten en dos mitades', () => {
  const matrix = scoreMatrix(1.4, 1.4, 0);
  const quarter = probabilityForCode(matrix, 'OVER_2.25');
  const low = probabilityForCode(matrix, 'OVER_2.0');
  const high = probabilityForCode(matrix, 'OVER_2.5');
  close(quarter.probability, (low.probability + high.probability) / 2, 1e-9);
});

test('quitar el margen devuelve probabilidades que suman 1', () => {
  const odds = [2.1, 3.4, 3.6];
  for (const method of ['power', 'proportional']) {
    const fair = removeVig(odds, method);
    close(fair.reduce((a, b) => a + b, 0), 1, 1e-9);
    fair.forEach((p, i) => assert.ok(p < impliedProbability(odds[i]), 'la probabilidad justa baja'));
  }
});

test('el valor esperado y el stake de Kelly son correctos', () => {
  close(expectedValue(0.5, 2.2), 0.1, 1e-9);           // 0.5*1.2 - 0.5
  close(expectedValue(0.5, 2), 0, 1e-9);               // apuesta neutra
  close(expectedValue(1, 3, 0.5), 1, 1e-9);            // mitad nula, mitad ganada
  assert.equal(kellyStake(0.4, 2), 0, 'sin ventaja no se apuesta');
  assert.ok(kellyStake(0.6, 2) > 0);
  assert.ok(kellyStake(0.99, 50) <= 2.5, 'el stake queda acotado');
});

test('la liquidación de apuestas cubre victorias, nulos y medias', () => {
  assert.equal(settleSelection('1', 2, 1), 'win');
  assert.equal(settleSelection('X', 1, 1), 'win');
  assert.equal(settleSelection('1X', 0, 1), 'loss');
  assert.equal(settleSelection('OVER_2.5', 2, 1), 'win');
  assert.equal(settleSelection('UNDER_2.5', 1, 1), 'win');
  assert.equal(settleSelection('OVER_3.0', 2, 1), 'push');
  assert.equal(settleSelection('BTTS_NO', 2, 0), 'win');
  assert.equal(settleSelection('AH_HOME_-1', 2, 1), 'push');
  assert.equal(settleSelection('AH_AWAY_0.25', 1, 1), 'half-win');
  assert.equal(settleSelection('AH_HOME_-0.25', 1, 1), 'half-loss');
  assert.equal(settleSelection('MERCADO_RARO', 1, 1), null);

  close(profitFor('win', 2.5), 1.5, 1e-9);
  close(profitFor('half-win', 2.5), 0.75, 1e-9);
  close(profitFor('push', 2.5), 0, 1e-9);
  close(profitFor('half-loss', 2.5), -0.5, 1e-9);
  close(profitFor('loss', 2.5), -1, 1e-9);
});

test('el historial no duplica entradas ni pierde las nuevas', () => {
  const a = [{ fixtureId: 'f1', code: '1', date: '2026-01-01', result: 'win', profit: 1, odds: 2, stake: 1, league: 'X', market: '1x2', confidence: 70 }];
  const b = [
    { fixtureId: 'f1', code: '1', date: '2026-01-01', result: 'win', profit: 1, odds: 2, stake: 1, league: 'X', market: '1x2', confidence: 70 },
    { fixtureId: 'f2', code: 'X', date: '2026-01-02', result: 'loss', profit: -1, odds: 3, stake: 1, league: 'X', market: '1x2', confidence: 60 },
  ];
  const merged = mergeHistory(a, b);
  assert.equal(merged.length, 2);
  const summary = summarizeHistory(merged);
  assert.equal(summary.bets, 2);
  close(summary.profit, 0, 1e-9);
  close(summary.hitRate, 0.5, 1e-9);
});

test('Dixon-Coles recupera la ventaja de localía y no sesga los goles', () => {
  // Liga sintética: fuerzas conocidas, localía conocida.
  const teams = ['A', 'B', 'C', 'D', 'E', 'F'];
  const strength = { A: 0.3, B: 0.2, C: 0.05, D: -0.05, E: -0.2, F: -0.3 };
  const matches = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const poisson = (lambda) => {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do { k += 1; p *= rand(); } while (p > L);
    return k - 1;
  };
  const now = new Date('2026-09-01');
  for (let round = 0; round < 60; round += 1) {
    for (const home of teams) {
      for (const away of teams) {
        if (home === away) continue;
        const lh = Math.exp(Math.log(1.35) + strength[home] - strength[away] + 0.25);
        const la = Math.exp(Math.log(1.35) + strength[away] - strength[home]);
        matches.push({
          home, away,
          homeGoals: poisson(lh),
          awayGoals: poisson(la),
          date: new Date(now.getTime() - (60 - round) * 86400000),
          leagueId: 'test',
        });
      }
    }
  }
  const model = fitDixonColes(matches, { reference: now, xi: 0 });
  assert.ok(Math.abs(model.homeAdvantage - 0.25) < 0.05, `localía ${model.homeAdvantage}`);

  let predicted = 0;
  let observed = 0;
  for (const m of matches) {
    const eg = expectedGoals(model, m.home, m.away, 'test');
    predicted += eg.home + eg.away;
    observed += m.homeGoals + m.awayGoals;
  }
  const bias = (predicted - observed) / observed;
  assert.ok(Math.abs(bias) < 0.02, `sesgo de goles ${(bias * 100).toFixed(2)}%`);

  // El orden de fuerza se respeta
  assert.ok(model.ratings.A.attack > model.ratings.F.attack);
});

test('el Elo separa equipos de nivel distinto', () => {
  const matches = [];
  for (let i = 0; i < 200; i += 1) {
    const strongHome = i % 2 === 0;
    matches.push({
      home: strongHome ? 'Fuerte' : 'Débil',
      away: strongHome ? 'Débil' : 'Fuerte',
      homeGoals: strongHome ? 2 : 0,
      awayGoals: strongHome ? 0 : 2,
      date: new Date(2026, 0, 1 + i),
    });
  }
  const model = trainElo(matches);
  assert.ok(model.ratings.Fuerte > model.ratings['Débil'] + 200);
  const probs = eloProbabilities(model, 'Fuerte', 'Débil');
  close(probs.home + probs.draw + probs.away, 1, 1e-9);
  assert.ok(probs.home > 0.8);
});

test('el ajuste de lambdas reproduce el 1X2 objetivo sin romper los goles', () => {
  const target = { home: 0.45, draw: 0.27, away: 0.28 };
  const fitted = solveLambdas(1.9, 1.1, -0.03, target);
  const got = outcomeProbabilities(fitted.matrix);
  close(got.home, target.home, 0.02);
  close(got.draw, target.draw, 0.02);
  close(got.away, target.away, 0.02);
  const total = fitted.matrix.flat().reduce((a, b) => a + b, 0);
  close(total, 1, 1e-9);
});

test('la mezcla con el mercado pondera por número de casas y margen', () => {
  const blended = blendWithMarket({ home: 0.6, draw: 0.2, away: 0.2 }, { home: 0.4, draw: 0.3, away: 0.3 }, 0.5);
  close(blended.home, 0.5, 1e-9);
  close(blended.home + blended.draw + blended.away, 1, 1e-9);
  assert.equal(marketWeight(0.4, { bookmakers: 0 }), 0, 'sin cuotas el mercado no pesa');
  assert.ok(marketWeight(0.4, { bookmakers: 8, margin: 0.03 }) > marketWeight(0.4, { bookmakers: 2, margin: 0.09 }));
});

test('la calibración por temperatura mejora el log loss de un modelo excesivamente seguro', () => {
  const probs = [];
  const outcomes = [];
  for (let i = 0; i < 300; i += 1) {
    // El modelo dice 95% pero sólo acierta el 70% de las veces.
    probs.push({ home: 0.95, draw: 0.03, away: 0.02 });
    outcomes.push(i % 10 < 7 ? 'home' : 'away');
  }
  const { temperature } = fitTemperature(probs, outcomes);
  assert.ok(temperature > 1, `la temperatura debe suavizar (${temperature})`);
  const calibrated = probs.map((p) => calibrate(p, { temperature }));
  assert.ok(brierScore(calibrated, outcomes) < brierScore(probs, outcomes));
});

test('las combinadas respetan la banda de cuota y no mezclan partidos correlacionados', () => {
  const candidates = [];
  for (let i = 0; i < 10; i += 1) {
    candidates.push({
      fixtureId: `f${i}`,
      homeTeam: `Local ${i}`,
      awayTeam: `Visitante ${i}`,
      league: 'Liga',
      leagueId: `liga-${i % 3}`,
      day: '2026-09-21',
      kickoff: '2026-09-21T18:00:00Z',
      market: i % 2 ? '1x2' : 'ou',
      label: `Selección ${i}`,
      code: '1',
      odds: 1.5 + i * 0.25,
      probability: 0.75 - i * 0.03,
      confidence: 80 - i,
      expectedValue: 0.06,
    });
  }
  const parlays = buildParlays(candidates);
  assert.equal(parlays.length, 3);
  for (const parlay of parlays) {
    if (!parlay.available) continue;
    const ids = parlay.legs.map((l) => l.fixtureId);
    assert.equal(new Set(ids).size, ids.length, 'no puede repetirse un partido');
    const product = parlay.legs.reduce((p, l) => p * l.odds, 1);
    close(parlay.odds, Number(product.toFixed(2)), 0.01);
    assert.ok(parlay.probability <= parlay.legs.reduce((p, l) => p * l.probability, 1) + 1e-9,
      'la probabilidad combinada nunca supera el producto');
  }
});

test('el emparejado de nombres tolera abreviaturas y no confunde clubes distintos', () => {
  assert.ok(similarity('Man Utd', 'Manchester United') > 0.85);
  assert.ok(similarity('Wolves', 'Wolverhampton Wanderers') > 0.8);
  assert.ok(similarity('Atlético Madrid', 'Atletico Madrid') > 0.95);
  assert.ok(similarity('Alianza Lima', 'Alianza Atlético') < 0.75, 'clubes distintos no deben cruzarse');
  assert.equal(matchFixture('Barcelona', 'Girona', [{ homeTeam: 'Real Madrid', awayTeam: 'Osasuna' }]), null);
});

test('el informe diario se genera completo a partir de datos de demostración', () => {
  const now = new Date('2026-09-21T09:00:00Z');
  const data = generateDemoData({ now, daysOfHistory: 220, seed: 42 });
  const report = buildDailyReport(
    { history: data.history, fixtures: data.fixtures, oddsEvents: data.oddsEvents },
    { now },
  );

  assert.ok(report.matches.length > 0);
  assert.ok(report.leagues.length > 0);
  assert.equal(report.parlays.length, 3);

  for (const match of report.matches) {
    const p = match.probabilities;
    close(p.home + p.draw + p.away, 1, 1e-6);
    assert.ok(match.lambdas.home > 0 && match.lambdas.away > 0);
    for (const pick of match.picks) {
      assert.ok(pick.expectedValue > 0, 'sólo se publican apuestas con valor positivo');
      assert.ok(pick.odds > 1);
      assert.ok(pick.confidence >= 0 && pick.confidence <= 100);
      assert.ok(Array.isArray(pick.reasoning) && pick.reasoning.length >= 3);
    }
  }

  // El ranking está ordenado
  const scores = report.topPicks.map((p) => p.score);
  const sorted = [...scores].sort((a, b) => b - a);
  assert.deepEqual(scores, sorted);
});
