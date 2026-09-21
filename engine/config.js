/**
 * Catálogo de competiciones y parámetros globales.
 *
 * Dos avisos sobre los proveedores:
 *
 * - El plan GRATUITO de API-Football sólo da acceso a temporadas antiguas
 *   (responde "Free plans do not have access to this season, try from 2022 to
 *   2024"), así que no sirve para predecir los partidos de hoy. Para usarlo de
 *   verdad hace falta un plan de pago; si no, usa football-data.org.
 * - football-data.org sí incluye la temporada en curso en su plan gratuito,
 *   pero sólo cubre las competiciones con código `footballData` en esta lista.
 *
 * Los IDs de API-Football pueden cambiar entre temporadas: verifícalos con
 * GET https://v3.football.api-sports.io/leagues?search=<nombre> si alguna liga
 * deja de traer partidos.
 */

export const LEAGUES = [
  { id: 'ucl', name: 'Champions League', short: 'UCL', group: 'europa', apiFootballId: 2, footballData: 'CL', oddsKey: 'soccer_uefa_champs_league', priority: 1 },
  { id: 'uel', name: 'Europa League', short: 'UEL', group: 'europa', apiFootballId: 3, footballData: null, oddsKey: 'soccer_uefa_europa_league', priority: 2 },
  { id: 'epl', name: 'Premier League', short: 'PL', group: 'europa', apiFootballId: 39, footballData: 'PL', oddsKey: 'soccer_epl', priority: 3 },
  { id: 'laliga', name: 'LaLiga', short: 'LaLiga', group: 'europa', apiFootballId: 140, footballData: 'PD', oddsKey: 'soccer_spain_la_liga', priority: 4 },
  { id: 'seriea', name: 'Serie A', short: 'Serie A', group: 'europa', apiFootballId: 135, footballData: 'SA', oddsKey: 'soccer_italy_serie_a', priority: 5 },
  { id: 'bundesliga', name: 'Bundesliga', short: 'BL', group: 'europa', apiFootballId: 78, footballData: 'BL1', oddsKey: 'soccer_germany_bundesliga', priority: 6 },
  { id: 'ligue1', name: 'Ligue 1', short: 'L1', group: 'europa', apiFootballId: 61, footballData: 'FL1', oddsKey: 'soccer_france_ligue_one', priority: 7 },
  { id: 'peru', name: 'Liga 1 Perú', short: 'Perú', group: 'america', apiFootballId: 281, footballData: null, oddsKey: null, priority: 8 },
  { id: 'libertadores', name: 'Copa Libertadores', short: 'Libertadores', group: 'america', apiFootballId: 13, footballData: null, oddsKey: 'soccer_conmebol_copa_libertadores', priority: 9 },
  { id: 'sudamericana', name: 'Copa Sudamericana', short: 'Sudamericana', group: 'america', apiFootballId: 11, footballData: null, oddsKey: 'soccer_conmebol_copa_sudamericana', priority: 10 },
  { id: 'mls', name: 'MLS', short: 'MLS', group: 'america', apiFootballId: 253, footballData: null, oddsKey: 'soccer_usa_mls', priority: 11 },
  { id: 'brasileirao', name: 'Brasileirão', short: 'Brasil', group: 'otras', apiFootballId: 71, footballData: 'BSA', oddsKey: 'soccer_brazil_campeonato', priority: 12 },
  { id: 'argentina', name: 'Liga Profesional Argentina', short: 'Argentina', group: 'otras', apiFootballId: 128, footballData: null, oddsKey: 'soccer_argentina_primera_division', priority: 13 },
  { id: 'eredivisie', name: 'Eredivisie', short: 'Países Bajos', group: 'otras', apiFootballId: 88, footballData: 'DED', oddsKey: 'soccer_netherlands_eredivisie', priority: 14 },
  { id: 'primeira', name: 'Primeira Liga', short: 'Portugal', group: 'otras', apiFootballId: 94, footballData: 'PPL', oddsKey: 'soccer_portugal_primeira_liga', priority: 15 },
  { id: 'championship', name: 'Championship', short: 'EFL', group: 'otras', apiFootballId: 40, footballData: 'ELC', oddsKey: 'soccer_efl_champ', priority: 16 },
  { id: 'liga_mx', name: 'Liga MX', short: 'México', group: 'america', apiFootballId: 262, footballData: null, oddsKey: 'soccer_mexico_ligamx', priority: 17 },
  { id: 'wc_qual_sa', name: 'Eliminatorias Conmebol', short: 'Eliminatorias', group: 'selecciones', apiFootballId: 34, footballData: null, oddsKey: 'soccer_fifa_world_cup_qualifiers_south_america', priority: 18, neutralPossible: false },
  { id: 'wc_qual_eu', name: 'Eliminatorias UEFA', short: 'Elim. UEFA', group: 'selecciones', apiFootballId: 32, footballData: null, oddsKey: 'soccer_fifa_world_cup_qualifiers_europe', priority: 19 },
  { id: 'worldcup', name: 'Copa del Mundo', short: 'Mundial', group: 'selecciones', apiFootballId: 1, footballData: 'WC', oddsKey: 'soccer_fifa_world_cup', priority: 20, neutralPossible: true },
];

export const LEAGUE_GROUPS = [
  { id: 'todas', name: 'Todas' },
  { id: 'europa', name: 'Europa' },
  { id: 'america', name: 'América' },
  { id: 'selecciones', name: 'Selecciones' },
  { id: 'otras', name: 'Otras ligas' },
];

export const CONFIG = {
  /** Mínimos para que una apuesta entre al listado de valor. */
  value: {
    minExpectedValue: 0.03,
    minEdge: 0.025,
    minProbability: 0.3,
    minOdds: 1.25,
    maxOdds: 12,
    minConfidence: 45,
    // Un valor esperado enorme casi nunca es valor real: suele ser un error de
    // emparejado de nombres, una cuota desfasada o una liga con poca muestra.
    maxExpectedValue: 0.35,
    maxPicksPerMatch: 2,
    topPicks: 12,
  },
  /** Gestión de bankroll sugerida (unidades sobre 100). */
  bankroll: {
    unit: 1,
    maxStakePerBet: 2.5,
    kellyFraction: 0.25,
    maxDailyExposure: 12,
  },
  model: {
    xi: 0.0045,
    historySeasons: 2,
    warmupMatches: 200,
    refitEveryDays: 14,
    /**
     * Peso del mercado como prior sobre la predicción del modelo (0 = ignorar
     * el mercado, 1 = copiarlo). Se ajusta a la baja si hay pocas casas o
     * mucho margen. Sin este prior, el filtro de valor se queda con los
     * partidos donde el modelo más se equivoca.
     */
    marketPrior: 0.4,
  },
  markets: ['1x2', 'dc', 'ou', 'btts', 'ah'],

  /**
   * Horizonte de partidos que se publican.
   *
   * La portada es "hoy y mañana", pero el fútbol tiene parones: tras una
   * jornada puede no haber nada durante dos semanas. Como la descarga trae la
   * temporada entera de cada competición, ampliar el horizonte no cuesta ni
   * una petición más, y evita que la web se quede vacía en un parón.
   */
  fixtures: {
    horizonDays: 16,
  },

  /**
   * Consumo de las APIs. Los planes gratuitos son pequeños y The Odds API
   * cobra UNA petición por cada combinación de región y mercado: pedir
   * `eu,uk,us` con `h2h,totals,spreads` cuesta 9 créditos por liga y por
   * ejecución, que agota el plan gratuito (500 al mes) en tres días.
   *
   * Por defecto se pide una sola región y dos mercados (2 créditos por liga)
   * y sólo para las ligas que tienen partidos en las próximas horas.
   */
  odds: {
    regions: 'eu',
    markets: 'h2h,totals',
    onlyLeaguesWithFixtures: true,
    // Horizonte de partidos para los que se piden cuotas.
    hoursAhead: 48,
    // El refresco prepartido mira sólo lo inminente.
    prematchHoursAhead: 8,
  },

  /**
   * El histórico se descarga una vez y después sólo se piden los resultados
   * nuevos. Sin esta caché, cada actualización gastaría 40 peticiones de
   * API-Football (20 ligas x 2 temporadas) y el plan gratuito de 100 al día
   * no daría para nada más.
   */
  cache: {
    historyFile: 'apuestas/data/historial-partidos.json',
    refreshDays: 12,
    maxAgeDays: 900,
  },
};

export function leagueById(id) {
  return LEAGUES.find((l) => l.id === id) ?? null;
}

export function leagueByApiFootballId(id) {
  return LEAGUES.find((l) => l.apiFootballId === Number(id)) ?? null;
}
