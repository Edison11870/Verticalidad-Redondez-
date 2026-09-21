/**
 * Conector football-data.org (v4).
 *
 * Es la fuente gratuita que SÍ da la temporada en curso: el plan gratuito de
 * API-Football sólo permite temporadas 2022-2024, así que no sirve para
 * predecir los partidos de hoy.
 *
 * A cambio cubre menos competiciones (Champions, las cinco grandes ligas
 * europeas, Brasileirão, Championship, Eredivisie, Primeira Liga y poco más) y
 * no trae xG ni lesiones: el motor usa los goles reales como sustituto del xG
 * y trabaja sin datos de bajas.
 *
 * Límite del plan gratuito: 10 peticiones por minuto.
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

/** Un día UTC en formato YYYY-MM-DD. */
function shiftDay(day, days) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Competiciones de LEAGUES que este proveedor puede servir. */
export function supportedLeagues(leagues = LEAGUES) {
  return leagues.filter((l) => l.footballData);
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
        // Una competición fuera del plan devuelve 403: se anota y se sigue.
        onProgress?.(`${league.name} ${season}: ${error.message}`);
      }
      await sleep(6500); // 10 peticiones por minuto en el plan gratuito
    }
  }
  return out;
}

/**
 * Partidos de un rango de fechas.
 *
 * Se consulta competición por competición (`/competitions/{code}/matches`) en
 * vez del endpoint global `/matches`: el global devolvió cero partidos con
 * este plan aunque el de competición sí traía datos, así que se usa el que
 * está demostrado que funciona. Cuesta una petición por competición, que con
 * el límite de 10 por minuto son unos 70 segundos.
 *
 * `dateTo` puede ser exclusivo según el endpoint, así que se pide un día de
 * más y se filtra en local por los días exactos que interesan.
 */
export async function fetchFixturesByDateRange(
  apiKey,
  days,
  { leagues = LEAGUES, budget, includeFinished = false, onProgress } = {},
) {
  const wanted = new Set(days);
  const dateFrom = days[0];
  const dateTo = shiftDay(days[days.length - 1], 1);
  const out = [];

  for (const league of supportedLeagues(leagues)) {
    try {
      const data = await call(
        apiKey,
        `/competitions/${league.footballData}/matches`,
        { dateFrom, dateTo },
        budget,
      );
      const all = (data?.matches ?? []).map(mapMatch).filter((m) => m.home && m.away);
      const inRange = all.filter((m) => wanted.has(m.date.toISOString().slice(0, 10)));
      const usable = inRange.filter((m) => (includeFinished ? true : !m.finished));
      out.push(...usable);
      onProgress?.(
        `${league.name}: ${usable.length} de ${inRange.length} en fecha (${all.length} devueltos)`,
      );
    } catch (error) {
      onProgress?.(`${league.name}: ${error.message}`);
    }
    await sleep(6500);
  }
  return out;
}

/** Partidos por jugar de una fecha concreta. */
export async function fetchFixturesByDate(apiKey, date, options = {}) {
  return fetchFixturesByDateRange(apiKey, [date], options);
}

/** Resultados ya jugados de una fecha, para mantener el histórico al día. */
export async function fetchResultsByDate(apiKey, date, options = {}) {
  const list = await fetchFixturesByDateRange(apiKey, [date], {
    ...options,
    includeFinished: true,
  });
  return list.filter((m) => m.finished && m.homeGoals !== null && m.awayGoals !== null);
}

export { mapMatch };

/** Comprueba que la clave es válida. */
export async function checkKey(apiKey) {
  const data = await call(apiKey, '/competitions', {});
  return { ok: true, competitions: data?.count ?? (data?.competitions?.length ?? 0) };
}
