/**
 * Persistencia del historial: liquidación de los pronósticos publicados y
 * métricas acumuladas. El historial guarda aciertos Y fallos: es el registro
 * que permite juzgar si el modelo sirve.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Redondea todos los números del árbol. Publicar probabilidades con 17
 * decimales triplica el peso del JSON que descarga el móvil sin aportar nada.
 */
export function roundDeep(value, decimals = 4) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Number(value.toFixed(decimals));
  }
  if (Array.isArray(value)) return value.map((v) => roundDeep(v, decimals));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = roundDeep(v, decimals);
    return out;
  }
  return value;
}

export async function writeJson(path, value, { decimals = 4, pretty = false } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const payload = roundDeep(value, decimals);
  await writeFile(path, `${JSON.stringify(payload, null, pretty ? 2 : 0)}\n`, 'utf8');
}

/** ¿Ganó la selección dado el marcador final? null = no liquidable. */
export function settleSelection(code, homeGoals, awayGoals) {
  const total = homeGoals + awayGoals;
  const diff = homeGoals - awayGoals;

  const simple = {
    '1': diff > 0,
    X: diff === 0,
    '2': diff < 0,
    '1X': diff >= 0,
    '12': diff !== 0,
    X2: diff <= 0,
    BTTS_SI: homeGoals > 0 && awayGoals > 0,
    BTTS_NO: homeGoals === 0 || awayGoals === 0,
  };
  if (code in simple) return simple[code] ? 'win' : 'loss';

  const ou = /^(OVER|UNDER)_(-?\d+(?:\.\d+)?)$/.exec(code);
  if (ou) {
    const line = Number(ou[2]);
    if (total === line) return 'push';
    const over = total > line;
    return (ou[1] === 'OVER') === over ? 'win' : 'loss';
  }

  const ah = /^AH_(HOME|AWAY)_(-?\d+(?:\.\d+)?)$/.exec(code);
  if (ah) {
    const line = Number(ah[2]);
    const margin = (ah[1] === 'HOME' ? diff : -diff) + line;
    if (Math.abs(margin) < 1e-9) return 'push';
    if (Math.abs(Math.abs(margin) - 0.25) < 1e-9) return margin > 0 ? 'half-win' : 'half-loss';
    return margin > 0 ? 'win' : 'loss';
  }

  return null;
}

export function profitFor(result, odds, stake = 1) {
  switch (result) {
    case 'win':
      return stake * (odds - 1);
    case 'half-win':
      return (stake * (odds - 1)) / 2;
    case 'push':
      return 0;
    case 'half-loss':
      return -stake / 2;
    case 'loss':
      return -stake;
    default:
      return 0;
  }
}

/**
 * Liquida los pronósticos de un informe anterior contra los resultados reales.
 * @param {object} report informe previo (latest.json)
 * @param {Map<string,{homeGoals:number,awayGoals:number}>} results por id de partido
 */
export function settleReport(report, results) {
  const entries = [];
  for (const match of report?.matches ?? []) {
    const result = results.get(match.id);
    if (!result || result.homeGoals === null || result.awayGoals === null) continue;
    for (const pick of match.picks ?? []) {
      const outcome = settleSelection(pick.code, result.homeGoals, result.awayGoals);
      if (!outcome) continue;
      entries.push({
        date: match.day,
        settledAt: new Date().toISOString(),
        fixtureId: match.id,
        league: match.league,
        leagueId: match.leagueId,
        match: `${match.home} vs ${match.away}`,
        score: `${result.homeGoals}-${result.awayGoals}`,
        market: pick.market,
        code: pick.code,
        label: pick.label,
        odds: pick.odds,
        probability: pick.probability,
        confidence: pick.confidence,
        stake: pick.stake ?? 1,
        result: outcome,
        profit: Number(profitFor(outcome, pick.odds, pick.stake ?? 1).toFixed(3)),
        simulated: Boolean(report?.demo),
      });
    }
  }
  return entries;
}

/** Une entradas nuevas evitando duplicados (mismo partido + selección). */
export function mergeHistory(existing = [], incoming = []) {
  const key = (e) => `${e.fixtureId}|${e.code}`;
  const seen = new Set(existing.map(key));
  const merged = [...existing];
  for (const entry of incoming) {
    if (seen.has(key(entry))) continue;
    seen.add(key(entry));
    merged.push(entry);
  }
  return merged.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** Métricas acumuladas del historial publicado. */
export function summarizeHistory(entries = []) {
  const settled = entries.filter((e) => e.result && e.result !== 'pending');
  const staked = settled.reduce((s, e) => s + (e.stake ?? 1), 0);
  const profit = settled.reduce((s, e) => s + e.profit, 0);
  const wins = settled.filter((e) => e.result === 'win' || e.result === 'half-win').length;
  const pushes = settled.filter((e) => e.result === 'push').length;

  const group = (keyFn) => {
    const map = new Map();
    for (const e of settled) {
      const k = keyFn(e);
      const row = map.get(k) ?? { key: k, bets: 0, wins: 0, staked: 0, profit: 0 };
      row.bets += 1;
      row.wins += e.result === 'win' || e.result === 'half-win' ? 1 : 0;
      row.staked += e.stake ?? 1;
      row.profit += e.profit;
      map.set(k, row);
    }
    return [...map.values()]
      .map((r) => ({
        ...r,
        profit: Number(r.profit.toFixed(2)),
        hitRate: r.bets ? r.wins / r.bets : 0,
        roi: r.staked ? r.profit / r.staked : 0,
      }))
      .sort((a, b) => b.bets - a.bets);
  };

  const byDay = new Map();
  for (const e of settled) {
    const row = byDay.get(e.date) ?? { date: e.date, bets: 0, wins: 0, profit: 0, staked: 0 };
    row.bets += 1;
    row.wins += e.result === 'win' || e.result === 'half-win' ? 1 : 0;
    row.profit += e.profit;
    row.staked += e.stake ?? 1;
    byDay.set(e.date, row);
  }
  const daily = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  let running = 0;
  const bankrollCurve = daily.map((d) => {
    running += d.profit;
    return { date: d.date, profit: Number(d.profit.toFixed(2)), cumulative: Number(running.toFixed(2)) };
  });

  return {
    bets: settled.length,
    wins,
    pushes,
    losses: settled.length - wins - pushes,
    hitRate: settled.length ? wins / settled.length : 0,
    staked: Number(staked.toFixed(2)),
    profit: Number(profit.toFixed(2)),
    roi: staked ? profit / staked : 0,
    averageOdds: settled.length
      ? Number((settled.reduce((s, e) => s + e.odds, 0) / settled.length).toFixed(2))
      : 0,
    byLeague: group((e) => e.league),
    byMarket: group((e) => e.market),
    byConfidence: group((e) =>
      e.confidence >= 72 ? 'Alta' : e.confidence >= 55 ? 'Media' : 'Baja',
    ),
    daily: bankrollCurve,
  };
}
