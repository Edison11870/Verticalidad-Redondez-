/**
 * Elo para fútbol con margen de goles (estilo World Football Elo) y
 * conversión a probabilidades 1X2 mediante un modelo ordinal.
 */

const DEFAULT_RATING = 1500;

export function createEloModel(options = {}) {
  const {
    k = 20,
    homeAdvantage = 62,
    initial = DEFAULT_RATING,
    drawScale = 0.28,
    ratingScale = 400,
  } = options;
  return { type: 'elo', k, homeAdvantage, initial, drawScale, ratingScale, ratings: {} };
}

export function getRating(model, team) {
  return model.ratings[team] ?? model.initial;
}

/** Expectativa de puntuación (victoria=1, empate=0.5) para el local. */
export function expectedScore(model, home, away, neutral = false) {
  const diff =
    getRating(model, home) - getRating(model, away) + (neutral ? 0 : model.homeAdvantage);
  return 1 / (1 + 10 ** (-diff / model.ratingScale));
}

/** Multiplicador por margen de goles: evita sobrerreaccionar a goleadas. */
function goalMultiplier(goalDiff, ratingDiff) {
  const g = Math.abs(goalDiff);
  if (g <= 1) return 1;
  if (g === 2) return 1.5;
  return (11 + g) / 8 / (1 + 0.001 * Math.abs(ratingDiff));
}

/** Actualiza el Elo con un partido jugado. Devuelve el delta aplicado. */
export function updateElo(model, match) {
  const { home, away, homeGoals, awayGoals, neutral = false, weight = 1 } = match;
  const exp = expectedScore(model, home, away, neutral);
  const actual = homeGoals > awayGoals ? 1 : homeGoals === awayGoals ? 0.5 : 0;
  const ratingDiff =
    getRating(model, home) - getRating(model, away) + (neutral ? 0 : model.homeAdvantage);
  const delta =
    model.k * weight * goalMultiplier(homeGoals - awayGoals, ratingDiff) * (actual - exp);
  model.ratings[home] = getRating(model, home) + delta;
  model.ratings[away] = getRating(model, away) - delta;
  return delta;
}

/** Entrena el Elo recorriendo los partidos en orden cronológico. */
export function trainElo(matches, options = {}) {
  const model = createEloModel(options);
  const ordered = [...matches].sort((a, b) => a.date - b.date);
  for (const m of ordered) updateElo(model, m);
  model.matchesUsed = ordered.length;
  return model;
}

/**
 * Probabilidades 1X2 a partir del Elo. El empate se modela con una banda
 * alrededor del equilibrio, más ancha cuanto más parejo es el partido.
 */
export function eloProbabilities(model, home, away, neutral = false) {
  const exp = expectedScore(model, home, away, neutral);
  const drawPeak = model.drawScale;
  const draw = drawPeak * Math.exp(-((exp - 0.5) ** 2) / 0.08);
  const rest = 1 - draw;
  // exp = pHome + 0.5*draw  =>  pHome = exp - 0.5*draw
  let pHome = exp - 0.5 * draw;
  let pAway = rest - pHome;
  pHome = Math.max(pHome, 0.01);
  pAway = Math.max(pAway, 0.01);
  const total = pHome + draw + pAway;
  return { home: pHome / total, draw: draw / total, away: pAway / total };
}

/** Convierte una diferencia de Elo en un ajuste multiplicativo de lambdas. */
export function eloGoalTilt(model, home, away, neutral = false) {
  const diff =
    (getRating(model, home) - getRating(model, away) + (neutral ? 0 : model.homeAdvantage)) /
    model.ratingScale;
  const tilt = Math.max(-0.35, Math.min(0.35, diff * 0.22));
  return { home: Math.exp(tilt), away: Math.exp(-tilt) };
}

export { DEFAULT_RATING };
