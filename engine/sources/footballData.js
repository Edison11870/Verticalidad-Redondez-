/**
 * Conector football-data.org (v4) — alternativa gratuita a API-Football.
 *
 * Cubre menos competiciones (sobre todo Europa) y no trae xG ni lesiones, así
 * que el motor usa goles reales como sustituto del xG cuando es la única fuente.
 */

import { getJson, sleep } from './http.js';
import { LEAGUES } from '../config.js';

const BASE = 'https://api.football-data.org/v4';

async function call(apiKey, path, params = {}, budget) {
  if (budget && !budget.consume()) {
    throw new Error('Cuota de peticiones agotada para football-data.org');
  }
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return getJson(url.toString(), { headers: { 'X-Auth-Token': apiKey } });
}

function mapMatch(item) {
  const league = LEAGUES.find((l) => l.footballData === item.competition?.code);
  const finished = item.status === 'FINISHED';
  return {
    id: `fd-${item.id}`,
    providerId: item.id,
    date: new Date(item.utcDate),
    league: league?.name ?? item.competition?.name ?? 'Otra liga',
    leagueId: league?.id ?? `fd-${item.competition?.code}`,
    leagueGroup: league?.group ?? 'otras',
    country: item.area?.name ?? null,
    round: item.matchday ? `Jornada ${item.matchday}` : null,
    venue: null,
    neutral: false,
    home: item.homeTeam?.name,
    away: item.awayTeam?.name,
    homeId: item.homeTeam?.id,
    awayId: item.awayTeam?.id,
    homeLogo: item.homeTeam?.crest ?? null,
    awayLogo: item.awayTeam?.crest ?? null,
    status: item.status,
    finished,
    homeGoals: item.score?.fullTime?.home ?? null,
    awayGoals: item.score?.fullTime?.away ?? null,
  };
}

export async function fetchHistory(apiKey, { leagues = LEAGUES, seasons = 2, budget, onProgress } = {}) {
  const out = [];
  const year = new Date().getUTCFullYear();
  const currentSeason = new Date().getUTCMonth() + 1 >= 7 ? year : year - 1;
  for (const league of leagues) {
    if (!league.footballData) continue;
    for (let s = 0; s < seasons; s += 1) {
      const season = currentSeason - s;
      try {
        const data = await call(
          apiKey,
          `/competitions/${league.footballData}/matches`,
          { season, status: 'FINISHED' },
          budget,
        );
        const mapped = (data?.matches ?? [])
          .map(mapMatch)
          .filter((m) => m.homeGoals !== null && m.awayGoals !== null);
        out.push(...mapped);
        onProgress?.(`${league.name} ${season}: ${mapped.length} partidos`);
      } catch (error) {
        onProgress?.(`${league.name} ${season}: ${error.message}`);
      }
      await sleep(6500); // 10 peticiones por minuto en el plan gratuito
    }
  }
  return out;
}

export async function fetchFixturesByDate(apiKey, date, { budget } = {}) {
  const data = await call(apiKey, '/matches', { date }, budget);
  return (data?.matches ?? []).map(mapMatch).filter((m) => !m.finished && m.home && m.away);
}

export { mapMatch };
