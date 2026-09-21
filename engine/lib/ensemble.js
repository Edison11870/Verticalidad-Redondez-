/**
 * Ensamble Dixon-Coles + Elo + regresión logística.
 *
 * 1. Cada modelo entrega su vector 1X2.
 * 2. Los pesos se optimizan por búsqueda en el símplex sobre un conjunto de
 *    validación (minimizando log loss); si no hay datos suficientes se usan
 *    pesos por defecto.
 * 3. La matriz de marcadores de Dixon-Coles se "inclina" hacia el 1X2 del
 *    ensamble, de modo que TODOS los mercados (over/under, BTTS, hándicap)
 *    quedan coherentes con la predicción final.
 */

import { expectedGoals, scoreMatrix, outcomeProbabilities } from './poisson.js';
import { eloProbabilities, eloGoalTilt } from './elo.js';
import { predictMultinomial } from './logreg.js';
import { calibrate, logLoss } from './calibration.js';

export const DEFAULT_WEIGHTS = { dixonColes: 0.45, elo: 0.2, ml: 0.35 };

function blend(parts, weights) {
  const out = { home: 0, draw: 0, away: 0 };
  let used = 0;
  for (const [key, prob] of Object.entries(parts)) {
    const w = weights[key] ?? 0;
    if (!prob || w <= 0) continue;
    used += w;
    out.home += w * prob.home;
    out.draw += w * prob.draw;
    out.away += w * prob.away;
  }
  if (used <= 0) return { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
  return { home: out.home / used, draw: out.draw / used, away: out.away / used };
}

/** Búsqueda de pesos en una rejilla del símplex (paso 0.05). */
export function optimizeWeights(samples) {
  if (samples.length < 60) return { ...DEFAULT_WEIGHTS, tuned: false };
  let best = { ...DEFAULT_WEIGHTS, tuned: false };
  let bestLoss = Infinity;
  for (let a = 0; a <= 20; a += 1) {
    for (let b = 0; a + b <= 20; b += 1) {
      const weights = { dixonColes: a / 20, elo: b / 20, ml: (20 - a - b) / 20 };
      const probs = samples.map((s) => blend(s.parts, weights));
      const loss = logLoss(probs, samples.map((s) => s.outcome));
      if (loss < bestLoss) {
        bestLoss = loss;
        best = { ...weights, tuned: true };
      }
    }
  }
  best.logLoss = Number(bestLoss.toFixed(5));
  return best;
}

/**
 * Predicción completa de un partido.
 * @returns {{probabilities, parts, matrix, lambdas, agreement}}
 */
export function predictFixture(fixture, models, featureVector) {
  const { dcModel, eloModel, mlModel, weights = DEFAULT_WEIGHTS, calibration } = models;
  const neutral = fixture.neutral ?? false;

  const eg = expectedGoals(dcModel, fixture.home, fixture.away, fixture.leagueId ?? fixture.league ?? null);
  const tilt = eloGoalTilt(eloModel, fixture.home, fixture.away, neutral);
  let lambdaHome = eg.home * tilt.home;
  let lambdaAway = eg.away * tilt.away;
  if (neutral) {
    const flat = Math.exp(dcModel.homeAdvantage / 2);
    lambdaHome /= flat;
    lambdaAway *= flat;
  }
  lambdaHome = Math.max(0.15, Math.min(5, lambdaHome));
  lambdaAway = Math.max(0.15, Math.min(5, lambdaAway));

  const baseMatrix = scoreMatrix(lambdaHome, lambdaAway, dcModel.rho);
  const parts = {
    dixonColes: outcomeProbabilities(baseMatrix),
    elo: eloProbabilities(eloModel, fixture.home, fixture.away, neutral),
    ml: mlModel && featureVector ? predictMultinomial(mlModel, featureVector) : null,
  };

  const raw = blend(parts, weights);
  const probabilities = calibrate(raw, calibration);
  const fitted = solveLambdas(lambdaHome, lambdaAway, dcModel.rho, probabilities);

  return {
    probabilities,
    parts,
    matrix: fitted.matrix,
    totalsProbability: (line) => overProbability(fitted.matrix, line),
    lambdas: { home: fitted.lambdaHome, away: fitted.lambdaAway, known: eg.known, base: { home: lambdaHome, away: lambdaAway } },
    fitResidual: fitted.residual,
    agreement: agreementScore(parts),
  };
}

/**
 * Busca las lambdas cuya matriz de marcadores reproduce el 1X2 del ensamble.
 *
 * Es preferible a reescalar la matriz por regiones (local/empate/visitante):
 * aquello casaba el 1X2 pero deformaba la distribución de goles, inflando
 * artificialmente "menos de 2.5" y "ambos no anotan". Aquí se mueven dos
 * palancas con sentido físico —cuántos goles se esperan y cómo se reparten—
 * y el resto de mercados sale coherente.
 *
 * Quedan topes: si el ensamble se aleja demasiado del modelo de goles, se
 * respeta la forma de la distribución y se deja el resto como residuo.
 */
export function solveLambdas(lambdaHome, lambdaAway, rho, target, options = {}) {
  const {
    totalsTarget = null, // {line, probability} objetivo de "más de X goles"
    iterations = 14,
    maxScale = 1.35,
    minScale = 0.72,
    maxTilt = 1.2,
    residualCap = 0.18,
  } = options;

  let lh = lambdaHome;
  let la = lambdaAway;
  let scale = 1;
  let tilt = 0;
  let matrix = scoreMatrix(lh, la, rho);
  let current = outcomeProbabilities(matrix);

  for (let i = 0; i < iterations; i += 1) {
    // 1) Reparto local/visitante: iguala el log-ratio de las probabilidades.
    const targetRatio = Math.log(Math.max(target.home, 1e-6) / Math.max(target.away, 1e-6));
    const currentRatio = Math.log(Math.max(current.home, 1e-6) / Math.max(current.away, 1e-6));
    const step = 0.45 * (targetRatio - currentRatio);
    tilt = Math.max(-maxTilt, Math.min(maxTilt, tilt + step));

    // 2) Nivel de goles. Si el mercado publica una línea de más/menos, se usa
    // esa referencia directa; si no, se usa la tasa de empates como proxy
    // (más goles => menos empates).
    if (totalsTarget) {
      const currentOver = overProbability(matrix, totalsTarget.line);
      const gap = totalsTarget.probability - currentOver;
      scale = Math.max(minScale, Math.min(maxScale, scale * (1 + 0.75 * gap)));
    } else {
      const drawGap = current.draw - target.draw;
      scale = Math.max(minScale, Math.min(maxScale, scale * (1 + 0.8 * drawGap)));
    }

    lh = lambdaHome * scale * Math.exp(tilt / 2);
    la = lambdaAway * scale * Math.exp(-tilt / 2);
    lh = Math.max(0.12, Math.min(6, lh));
    la = Math.max(0.12, Math.min(6, la));

    matrix = scoreMatrix(lh, la, rho);
    current = outcomeProbabilities(matrix);

    const gap =
      Math.abs(current.home - target.home) +
      Math.abs(current.draw - target.draw) +
      Math.abs(current.away - target.away);
    if (gap < 0.004) break;
  }

  // Residuo: un ajuste pequeño y acotado por regiones para cerrar la diferencia
  // que las lambdas no pueden reproducir (sobre todo la tasa de empates).
  const limited = {
    home: limitFactor(target.home, current.home, residualCap),
    draw: limitFactor(target.draw, current.draw, residualCap),
    away: limitFactor(target.away, current.away, residualCap),
  };
  matrix = tiltMatrix(matrix, current, limited);

  const final = outcomeProbabilities(matrix);
  return {
    matrix,
    lambdaHome: lh,
    lambdaAway: la,
    residual:
      Math.abs(final.home - target.home) +
      Math.abs(final.draw - target.draw) +
      Math.abs(final.away - target.away),
  };
}

/** P(más de `line` goles) directamente sobre la matriz. */
function overProbability(matrix, line) {
  let total = 0;
  for (let x = 0; x < matrix.length; x += 1) {
    for (let y = 0; y < matrix[x].length; y += 1) {
      if (x + y > line) total += matrix[x][y];
    }
  }
  return total;
}

/**
 * Mezcla la predicción del modelo con la probabilidad justa del mercado.
 *
 * El mercado (una vez quitado el margen) es el mejor predictor individual que
 * existe: concentra dinero, información de última hora y el criterio de casas
 * profesionales. Usarlo como prior evita que el filtro de valor se quede
 * justamente con los partidos donde el modelo más se equivoca, que es lo que
 * ocurre si se compara el modelo crudo contra la cuota.
 *
 * `weight` = 0 ignora el mercado (sólo modelo); 1 replica el mercado y no deja
 * ninguna apuesta de valor.
 */
export function blendWithMarket(modelProbabilities, marketProbabilities, weight) {
  if (!marketProbabilities || weight <= 0) return { ...modelProbabilities };
  const w = Math.max(0, Math.min(1, weight));
  const out = {
    home: (1 - w) * modelProbabilities.home + w * marketProbabilities.home,
    draw: (1 - w) * modelProbabilities.draw + w * marketProbabilities.draw,
    away: (1 - w) * modelProbabilities.away + w * marketProbabilities.away,
  };
  const total = out.home + out.draw + out.away;
  return { home: out.home / total, draw: out.draw / total, away: out.away / total };
}

/**
 * Peso efectivo del mercado: más casas y menos margen => mercado más fiable.
 * Un mercado con una sola casa y margen alto aporta poco y pesa menos.
 */
export function marketWeight(baseWeight, { bookmakers = 0, margin = 0.08 } = {}) {
  if (!bookmakers) return 0;
  const depth = Math.min(1, Math.log2(1 + bookmakers) / 3);
  const quality = Math.max(0.3, Math.min(1, 1 - (margin - 0.03) / 0.1));
  return baseWeight * depth * quality;
}

/**
 * Recalcula la matriz de un partido usando el mercado como prior, tanto en el
 * 1X2 como en el nivel de goles. Devuelve una predicción con la misma forma.
 */
export function refineWithMarket(prediction, market, options = {}) {
  const { weight = 0.35, rho = 0 } = options;
  const effective = marketWeight(weight, market ?? {});
  if (!market || effective <= 0) return prediction;

  const target = blendWithMarket(prediction.probabilities, market.oneX2, effective);
  const totalsTarget = market.totals
    ? {
        line: market.totals.line,
        probability:
          (1 - effective) * prediction.totalsProbability(market.totals.line) +
          effective * market.totals.overProbability,
      }
    : null;

  const base = prediction.lambdas.base ?? prediction.lambdas;
  const fitted = solveLambdas(base.home, base.away, rho, target, { totalsTarget });

  return {
    ...prediction,
    probabilities: target,
    modelProbabilities: prediction.probabilities,
    marketWeight: effective,
    matrix: fitted.matrix,
    lambdas: { ...prediction.lambdas, home: fitted.lambdaHome, away: fitted.lambdaAway },
    fitResidual: fitted.residual,
  };
}

/** Limita cuánto puede moverse una probabilidad respecto a la del modelo de goles. */
function limitFactor(target, current, cap) {
  const ratio = target / Math.max(current, 1e-6);
  const limited = Math.max(1 - cap, Math.min(1 + cap, ratio));
  return current * limited;
}

/** Reescala la matriz por regiones (local/empate/visitante) para casar el 1X2. */
export function tiltMatrix(matrix, from, to) {
  const factor = {
    home: to.home / Math.max(from.home, 1e-6),
    draw: to.draw / Math.max(from.draw, 1e-6),
    away: to.away / Math.max(from.away, 1e-6),
  };
  const out = [];
  let total = 0;
  for (let x = 0; x < matrix.length; x += 1) {
    const row = [];
    for (let y = 0; y < matrix[x].length; y += 1) {
      const region = x > y ? 'home' : x === y ? 'draw' : 'away';
      const v = matrix[x][y] * factor[region];
      row.push(v);
      total += v;
    }
    out.push(row);
  }
  for (let x = 0; x < out.length; x += 1) {
    for (let y = 0; y < out[x].length; y += 1) out[x][y] /= total;
  }
  return out;
}

/** 1 = los tres modelos dicen lo mismo, 0 = discrepan por completo. */
export function agreementScore(parts) {
  const vectors = Object.values(parts).filter(Boolean);
  if (vectors.length < 2) return 0.5;
  let maxDistance = 0;
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      const d =
        (Math.abs(vectors[i].home - vectors[j].home) +
          Math.abs(vectors[i].draw - vectors[j].draw) +
          Math.abs(vectors[i].away - vectors[j].away)) /
        2;
      maxDistance = Math.max(maxDistance, d);
    }
  }
  return Math.max(0, 1 - maxDistance);
}

export { blend };
