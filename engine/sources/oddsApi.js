/**
 * Conector The Odds API (v4): cuotas de múltiples casas para comparar contra
 * la probabilidad del modelo.
 *
 * Mercados usados: h2h (1X2), totals (más/menos), spreads (hándicap) y btts
 * cuando la casa lo publica. De cada mercado se guarda la MEJOR cuota
 * disponible (la que maximiza el valor) y el consenso para quitar el margen.
 */

import { getJson, sleep } from './http.js';
import { LEAGUES } from '../config.js';

const BASE = 'https://api.the-odds-api.com/v4';

export async function fetchOdds(apiKey, {
  leagues = LEAGUES,
  regions = 'eu,uk,us',
  markets = 'h2h,totals,spreads',
  budget,
  onProgress,
} = {}) {
  const events = [];
  for (const league of leagues) {
    if (!league.oddsKey) continue;
    if (budget && !budget.consume()) break;
    const url = new URL(`${BASE}/sports/${league.oddsKey}/odds`);
    url.searchParams.set('apiKey', apiKey);
    url.searchParams.set('regions', regions);
    url.searchParams.set('markets', markets);
    url.searchParams.set('oddsFormat', 'decimal');
    url.searchParams.set('dateFormat', 'iso');
    try {
      const data = await getJson(url.toString());
      for (const event of data ?? []) {
        events.push(normalizeEvent(event, league));
      }
      onProgress?.(`${league.name}: ${data?.length ?? 0} eventos con cuotas`);
    } catch (error) {
      onProgress?.(`${league.name}: sin cuotas (${error.message})`);
    }
    await sleep(200);
  }
  return events;
}

function normalizeEvent(event, league) {
  return {
    id: event.id,
    leagueId: league.id,
    league: league.name,
    commenceTime: new Date(event.commence_time),
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    books: (event.bookmakers ?? []).map((b) => ({
      key: b.key,
      title: b.title,
      lastUpdate: b.last_update,
      markets: b.markets ?? [],
    })),
  };
}

/**
 * Agrega las cuotas de todas las casas a un diccionario por código de
 * selección, con la mejor cuota, el consenso y el margen medio del mercado.
 */
export function aggregateOdds(event, homeTeam, awayTeam) {
  const buckets = new Map();

  const push = (code, price, bookmaker, extra = {}) => {
    if (!Number.isFinite(price) || price <= 1) return;
    if (!buckets.has(code)) buckets.set(code, { code, prices: [], ...extra });
    buckets.get(code).prices.push({ price, bookmaker });
  };

  const marginByBook = [];

  for (const book of event.books ?? []) {
    for (const market of book.markets ?? []) {
      if (market.key === 'h2h') {
        const prices = {};
        for (const o of market.outcomes ?? []) {
          const code = o.name === homeTeam ? '1' : o.name === awayTeam ? '2' : 'X';
          prices[code] = o.price;
          push(code, o.price, book.title);
        }
        const implied = ['1', 'X', '2']
          .map((c) => (prices[c] ? 1 / prices[c] : 0))
          .reduce((a, b) => a + b, 0);
        if (implied > 1) marginByBook.push(implied - 1);
      } else if (market.key === 'totals') {
        for (const o of market.outcomes ?? []) {
          const line = Number(o.point);
          if (!Number.isFinite(line)) continue;
          const side = String(o.name).toLowerCase().startsWith('over') ? 'OVER' : 'UNDER';
          push(`${side}_${line}`, o.price, book.title, { line });
        }
      } else if (market.key === 'spreads') {
        for (const o of market.outcomes ?? []) {
          const line = Number(o.point);
          if (!Number.isFinite(line)) continue;
          const side = o.name === homeTeam ? 'HOME' : 'AWAY';
          push(`AH_${side}_${line}`, o.price, book.title, { line, side: side.toLowerCase() });
        }
      } else if (market.key === 'btts') {
        for (const o of market.outcomes ?? []) {
          const side = String(o.name).toLowerCase() === 'yes' ? 'SI' : 'NO';
          push(`BTTS_${side}`, o.price, book.title);
        }
      }
    }
  }

  const margin = marginByBook.length
    ? marginByBook.reduce((a, b) => a + b, 0) / marginByBook.length
    : 0.06;

  const result = {};
  for (const [code, bucket] of buckets) {
    const sorted = [...bucket.prices].sort((a, b) => b.price - a.price);
    const best = sorted[0];
    // El consenso se promedia en PROBABILIDAD implícita, no en cuota: promediar
    // cuotas sobrevalora las altas y deja el margen mal calculado.
    const impliedMean =
      bucket.prices.reduce((s, p) => s + 1 / p.price, 0) / bucket.prices.length;
    const consensus = 1 / impliedMean;
    result[code] = {
      odds: best.price,
      bookmaker: best.bookmaker,
      consensus: Number(consensus.toFixed(3)),
      bookmakers: bucket.prices.length,
      line: bucket.line,
      side: bucket.side,
      margin,
    };
  }
  return { selections: result, margin, bookmakers: (event.books ?? []).length };
}
