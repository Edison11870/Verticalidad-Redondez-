/**
 * Conector API-Football (v3, api-sports.io).
 *
 * Cubre: resultados históricos, partidos del día, lesiones, alineaciones y xG.
 * Cada llamada consume cuota, así que el histórico se pide por liga/temporada
 * (1 petición por combinación) y el xG sólo para partidos recientes.
 */

import { getJson, sleep } from './http.js';
import { LEAGUES, leagueByApiFootballId } from '../config.js';

const BASE = 'https://v3.football.api-sports.io';

function headers(apiKey) {
  return { 'x-apisports-key': apiKey, Accept: 'application/json' };
}

async function call(apiKey, path, params = {}, budget) {
  if (budget && !budget.consume()) {
    throw new Error('Cuota de peticiones agotada para API-Football');
  }
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const data = await getJson(url.toString(), { headers: headers(apiKey) });
  if (data?.errors && Object.keys(data.errors).length) {
    const message = Object.values(data.errors).join('; ');
    if (message) throw new Error(`API-Football: ${message}`);
  }
  return data?.response ?? [];
}

function mapFixture(item) {
  const league = leagueByApiFootballId(item.league?.id);
  const status = item.fixture?.status?.short ?? 'NS';
  return {
    id: `af-${item.fixture?.id}`,
    providerId: item.fixture?.id,
    date: new Date(item.fixture?.date),
    league: league?.name ?? item.league?.name ?? 'Otra liga',
    leagueId: league?.id ?? `af-${item.league?.id}`,
    leagueProviderId: Number(item.league?.id ?? 0),
    leagueGroup: league?.group ?? 'otras',
    country: item.league?.country ?? null,
    round: item.league?.round ?? null,
    venue: item.fixture?.venue?.name ?? null,
    neutral: false,
    home: item.teams?.home?.name,
    away: item.teams?.away?.name,
    homeId: item.teams?.home?.id,
    awayId: item.teams?.away?.id,
    homeLogo: item.teams?.home?.logo ?? null,
    awayLogo: item.teams?.away?.logo ?? null,
    status,
    finished: ['FT', 'AET', 'PEN'].includes(status),
    homeGoals: item.goals?.home ?? null,
    awayGoals: item.goals?.away ?? null,
  };
}

/** Temporada vigente para una liga (las ligas de apertura/clausura usan el año). */
export function currentSeason(date = new Date(), league = null) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const calendarYearLeagues = ['peru', 'mls', 'brasileirao', 'argentina', 'libertadores', 'sudamericana'];
  if (league && calendarYearLeagues.includes(league.id)) return year;
  return month >= 7 ? year : year - 1;
}

/** Resultados históricos de las ligas configuradas. */
export async function fetchHistory(apiKey, { leagues = LEAGUES, seasons = 2, budget, onProgress } = {}) {
  const out = [];
  for (const league of leagues) {
    if (!league.apiFootballId) continue;
    const current = currentSeason(new Date(), league);
    for (let s = 0; s < seasons; s += 1) {
      const season = current - s;
      try {
        const response = await call(
          apiKey,
          '/fixtures',
          { league: league.apiFootballId, season, status: 'FT-AET-PEN' },
          budget,
        );
        const mapped = response
          .map(mapFixture)
          .filter((f) => f.homeGoals !== null && f.awayGoals !== null);
        out.push(...mapped);
        onProgress?.(`${league.name} ${season}: ${mapped.length} partidos`);
      } catch (error) {
        onProgress?.(`${league.name} ${season}: ${error.message}`);
      }
      await sleep(250);
    }
  }
  return out;
}

/** Partidos programados para una fecha (YYYY-MM-DD, UTC). */
export async function fetchFixturesByDate(apiKey, date, { leagues = LEAGUES, budget } = {}) {
  const ids = new Set(leagues.map((l) => l.apiFootballId).filter(Boolean));
  const response = await call(apiKey, '/fixtures', { date, timezone: 'UTC' }, budget);
  return response
    .map(mapFixture)
    .filter((f) => ids.has(f.leagueProviderId))
    .filter((f) => !f.finished && f.home && f.away);
}

/**
 * Lesiones y sanciones por liga y fecha.
 *
 * La respuesta de /injuries identifica al equipo, no si juega en casa: el
 * reparto local/visitante se hace fuera, comparando el id del equipo con el
 * del partido (ver assignInjuries).
 *
 * @returns {Map<number, Array<{teamId:number, teamName:string, name:string, reason:string|null}>>}
 */
export async function fetchInjuries(apiKey, { leagues = LEAGUES, date, budget } = {}) {
  const byFixture = new Map();
  for (const league of leagues) {
    if (!league.apiFootballId) continue;
    try {
      const season = currentSeason(new Date(), league);
      const response = await call(
        apiKey,
        '/injuries',
        { league: league.apiFootballId, season, date },
        budget,
      );
      for (const item of response) {
        const fixtureId = item.fixture?.id;
        if (!fixtureId || !item.team?.id) continue;
        if (!byFixture.has(fixtureId)) byFixture.set(fixtureId, []);
        byFixture.get(fixtureId).push({
          teamId: item.team.id,
          teamName: item.team.name,
          name: item.player?.name ?? 'Jugador sin identificar',
          reason: item.player?.reason ?? item.type ?? null,
        });
      }
    } catch {
      // Las lesiones son opcionales: si fallan, el modelo sigue con el resto.
    }
    await sleep(200);
  }
  return byFixture;
}

/**
 * Reparte las bajas de un partido entre local y visitante y estima su impacto.
 * El impacto es deliberadamente simple (número de bajas acotado): sin datos de
 * minutos jugados por jugador, ponderar por "importancia" sería inventar.
 */
export function assignInjuries(fixture, injuryList) {
  const home = [];
  const away = [];
  for (const injury of injuryList ?? []) {
    const target = injury.teamId === fixture.homeId ? home : injury.teamId === fixture.awayId ? away : null;
    if (!target) continue;
    target.push(`${injury.name}${injury.reason ? ` (${injury.reason})` : ''}`);
  }
  return {
    detail: home.length || away.length ? { home, away } : null,
    impact: {
      home: Math.min(0.5, home.length * 0.08),
      away: Math.min(0.5, away.length * 0.08),
    },
  };
}

/** Alineaciones confirmadas (disponibles ~40 min antes del inicio). */
export async function fetchLineups(apiKey, fixtureId, budget) {
  try {
    const response = await call(apiKey, '/fixtures/lineups', { fixture: fixtureId }, budget);
    if (!response.length) return null;
    return response.map((t) => ({
      team: t.team?.name,
      formation: t.formation ?? null,
      startXI: (t.startXI ?? []).map((p) => p.player?.name).filter(Boolean),
    }));
  } catch {
    return null;
  }
}

/** xG por partido a partir de las estadísticas del encuentro. */
export async function fetchExpectedGoals(apiKey, fixtureId, budget) {
  try {
    const response = await call(apiKey, '/fixtures/statistics', { fixture: fixtureId }, budget);
    const read = (team) => {
      const stat = team?.statistics?.find((s) =>
        String(s.type).toLowerCase().includes('expected'),
      );
      const value = stat?.value;
      return value === null || value === undefined ? null : Number(String(value).replace(',', '.'));
    };
    if (response.length < 2) return null;
    const home = read(response[0]);
    const away = read(response[1]);
    if (home === null || away === null) return null;
    return { home, away };
  } catch {
    return null;
  }
}

export { mapFixture };
