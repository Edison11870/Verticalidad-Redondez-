/**
 * Construcción de variables para el modelo de machine learning.
 *
 * El tracker procesa los partidos en orden cronológico: al generar las
 * variables de un partido sólo conoce lo ocurrido ANTES de esa fecha, así el
 * backtesting es walk-forward y no hay fuga de información.
 */

import { getRating } from './elo.js';

export const FEATURE_NAMES = [
  'elo_diff',          // diferencia de Elo (incluye localía) / 400
  'attack_diff',       // ataque local - ataque visitante (Dixon-Coles)
  'defence_diff',      // defensa local - defensa visitante
  'form_home',         // puntos por partido, últimos N, con decaimiento
  'form_away',
  'xg_diff_home',      // (xG a favor - xG en contra) por partido
  'xg_diff_away',
  'goal_diff_home',    // diferencia de goles real por partido
  'goal_diff_away',
  'rest_diff',         // días de descanso local - visitante (recortado)
  'congestion_diff',   // partidos en los últimos 14 días (local - visitante)
  'injury_diff',       // impacto de bajas visitante - local (positivo favorece al local)
  'h2h_score',         // dominio histórico directo del local (-1..1)
  'home_field',        // 1 local real, 0 campo neutral
];

const FORM_WINDOW = 10;
const CONGESTION_DAYS = 14;

function pointsFor(goalsFor, goalsAgainst) {
  if (goalsFor > goalsAgainst) return 3;
  if (goalsFor === goalsAgainst) return 1;
  return 0;
}

function pairKey(a, b) {
  return [a, b].sort().join('||');
}

export class TeamStateTracker {
  constructor(options = {}) {
    this.formWindow = options.formWindow ?? FORM_WINDOW;
    this.formDecay = options.formDecay ?? 0.86;
    this.teams = new Map();
    this.h2h = new Map();
  }

  team(name) {
    if (!this.teams.has(name)) {
      this.teams.set(name, { matches: [], lastDate: null });
    }
    return this.teams.get(name);
  }

  /** Registra un partido ya jugado. */
  record(match) {
    const { home, away, homeGoals, awayGoals, date } = match;
    const xgHome = match.xgHome ?? homeGoals;
    const xgAway = match.xgAway ?? awayGoals;

    const push = (team, isHome, gf, ga, xgf, xga) => {
      const state = this.team(team);
      state.matches.push({
        date,
        isHome,
        goalsFor: gf,
        goalsAgainst: ga,
        xgFor: xgf,
        xgAgainst: xga,
        points: pointsFor(gf, ga),
      });
      if (state.matches.length > 60) state.matches.shift();
      state.lastDate = date;
    };

    push(home, true, homeGoals, awayGoals, xgHome, xgAway);
    push(away, false, awayGoals, homeGoals, xgAway, xgHome);

    const key = pairKey(home, away);
    if (!this.h2h.has(key)) this.h2h.set(key, []);
    const log = this.h2h.get(key);
    log.push({ date, home, away, homeGoals, awayGoals });
    if (log.length > 12) log.shift();
  }

  /** Resumen de forma reciente de un equipo antes de `date`. */
  summary(team, date) {
    const state = this.teams.get(team);
    const empty = {
      games: 0,
      form: 1.35,
      xgDiff: 0,
      goalDiff: 0,
      restDays: 7,
      congestion: 1,
      goalsFor: 1.3,
      goalsAgainst: 1.3,
      xgFor: 1.3,
      xgAgainst: 1.3,
    };
    if (!state || !state.matches.length) return empty;

    const past = state.matches.filter((m) => m.date < date).slice(-this.formWindow);
    if (!past.length) return empty;

    let wSum = 0;
    let pts = 0;
    let xgF = 0;
    let xgA = 0;
    let gF = 0;
    let gA = 0;
    past.forEach((m, i) => {
      const w = this.formDecay ** (past.length - 1 - i);
      wSum += w;
      pts += w * m.points;
      xgF += w * m.xgFor;
      xgA += w * m.xgAgainst;
      gF += w * m.goalsFor;
      gA += w * m.goalsAgainst;
    });

    const last = past[past.length - 1];
    const restDays = Math.min(21, Math.max(1, (date - last.date) / 86400000));
    const congestion = past.filter(
      (m) => (date - m.date) / 86400000 <= CONGESTION_DAYS,
    ).length;

    return {
      games: past.length,
      form: pts / wSum,
      xgDiff: (xgF - xgA) / wSum,
      goalDiff: (gF - gA) / wSum,
      goalsFor: gF / wSum,
      goalsAgainst: gA / wSum,
      xgFor: xgF / wSum,
      xgAgainst: xgA / wSum,
      restDays,
      congestion,
    };
  }

  /** Dominio histórico directo del local: -1 (visitante domina) a 1. */
  h2hScore(home, away, date) {
    const log = (this.h2h.get(pairKey(home, away)) ?? []).filter((m) => m.date < date);
    if (!log.length) return { score: 0, games: 0 };
    let total = 0;
    let weight = 0;
    log.slice(-8).forEach((m, i) => {
      const w = 0.85 ** (Math.min(log.length, 8) - 1 - i);
      const homeWasHome = m.home === home;
      const gf = homeWasHome ? m.homeGoals : m.awayGoals;
      const ga = homeWasHome ? m.awayGoals : m.homeGoals;
      total += w * (gf > ga ? 1 : gf === ga ? 0 : -1);
      weight += w;
    });
    return { score: weight ? total / weight : 0, games: log.length };
  }

  /**
   * Vector de variables para un partido por jugar.
   * @param {object} fixture  {home, away, date, neutral, injuries:{home,away}}
   * @param {object} context  {eloModel, dcModel}
   */
  featuresFor(fixture, context) {
    const { home, away, date, neutral = false } = fixture;
    const injuries = fixture.injuries ?? { home: 0, away: 0 };
    const sHome = this.summary(home, date);
    const sAway = this.summary(away, date);
    const h2h = this.h2hScore(home, away, date);

    const elo = context.eloModel;
    const eloDiff =
      (getRating(elo, home) - getRating(elo, away) + (neutral ? 0 : elo.homeAdvantage)) / 400;

    const dc = context.dcModel;
    const rHome = dc?.ratings?.[home] ?? { attack: 0, defence: 0 };
    const rAway = dc?.ratings?.[away] ?? { attack: 0, defence: 0 };

    const vector = [
      eloDiff,
      rHome.attack - rAway.attack,
      rHome.defence - rAway.defence,
      sHome.form,
      sAway.form,
      sHome.xgDiff,
      sAway.xgDiff,
      sHome.goalDiff,
      sAway.goalDiff,
      Math.max(-10, Math.min(10, sHome.restDays - sAway.restDays)) / 10,
      (sHome.congestion - sAway.congestion) / 4,
      (injuries.away ?? 0) - (injuries.home ?? 0),
      h2h.score,
      neutral ? 0 : 1,
    ];

    return {
      vector,
      names: FEATURE_NAMES,
      context: { home: sHome, away: sAway, h2h, eloDiff, injuries },
    };
  }

  /** Cobertura de datos: cuánta historia hay para confiar en la predicción. */
  coverage(fixture) {
    const sHome = this.summary(fixture.home, fixture.date);
    const sAway = this.summary(fixture.away, fixture.date);
    const games = Math.min(sHome.games, sAway.games);
    return Math.max(0, Math.min(1, games / 8));
  }
}

export { FORM_WINDOW, CONGESTION_DAYS };
