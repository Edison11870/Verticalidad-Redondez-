/**
 * Calibración de probabilidades y métricas de evaluación.
 *
 * - Temperature scaling multiclase (1 parámetro, robusto con pocos datos).
 * - Curva de fiabilidad por bins para mostrar si el modelo está bien calibrado.
 * - Brier score multiclase y log loss.
 */

const CLASSES = ['home', 'draw', 'away'];
const EPS = 1e-9;

function toVector(p) {
  return CLASSES.map((c) => Math.max(p[c] ?? 0, EPS));
}

function applyTemperature(vector, T) {
  const logits = vector.map((p) => Math.log(p) / T);
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

export function logLoss(probs, outcomes) {
  let loss = 0;
  probs.forEach((p, i) => {
    const v = toVector(p);
    const idx = CLASSES.indexOf(outcomes[i]);
    loss -= Math.log(Math.max(v[idx], EPS));
  });
  return loss / Math.max(probs.length, 1);
}

export function brierScore(probs, outcomes) {
  let total = 0;
  probs.forEach((p, i) => {
    const v = toVector(p);
    const idx = CLASSES.indexOf(outcomes[i]);
    v.forEach((pi, c) => {
      total += (pi - (c === idx ? 1 : 0)) ** 2;
    });
  });
  return total / Math.max(probs.length, 1);
}

/** Busca la temperatura que minimiza el log loss. T>1 suaviza, T<1 agudiza. */
export function fitTemperature(probs, outcomes) {
  if (probs.length < 30) return { temperature: 1, logLoss: logLoss(probs, outcomes) };
  let best = 1;
  let bestLoss = Infinity;
  for (let T = 0.6; T <= 2.001; T += 0.02) {
    let loss = 0;
    probs.forEach((p, i) => {
      const v = applyTemperature(toVector(p), T);
      loss -= Math.log(Math.max(v[CLASSES.indexOf(outcomes[i])], EPS));
    });
    loss /= probs.length;
    if (loss < bestLoss) {
      bestLoss = loss;
      best = T;
    }
  }
  return { temperature: Number(best.toFixed(3)), logLoss: bestLoss };
}

export function calibrate(prob, calibration) {
  const T = calibration?.temperature ?? 1;
  if (Math.abs(T - 1) < 1e-6) return { ...prob };
  const v = applyTemperature(toVector(prob), T);
  return { home: v[0], draw: v[1], away: v[2] };
}

/**
 * Curva de fiabilidad: agrupa todas las predicciones individuales
 * (cada clase cuenta como una predicción binaria) en bins de 10%.
 */
export function reliabilityCurve(probs, outcomes, bins = 10) {
  const buckets = Array.from({ length: bins }, (_, i) => ({
    from: i / bins,
    to: (i + 1) / bins,
    predicted: 0,
    observed: 0,
    count: 0,
  }));
  probs.forEach((p, i) => {
    const v = toVector(p);
    const idx = CLASSES.indexOf(outcomes[i]);
    v.forEach((pi, c) => {
      const b = Math.min(bins - 1, Math.floor(pi * bins));
      buckets[b].predicted += pi;
      buckets[b].observed += c === idx ? 1 : 0;
      buckets[b].count += 1;
    });
  });
  return buckets
    .filter((b) => b.count > 0)
    .map((b) => ({
      from: b.from,
      to: b.to,
      count: b.count,
      predicted: b.predicted / b.count,
      observed: b.observed / b.count,
    }));
}

/** Error de calibración esperado (ECE) sobre la curva de fiabilidad. */
export function expectedCalibrationError(curve) {
  const total = curve.reduce((s, b) => s + b.count, 0) || 1;
  return curve.reduce((s, b) => s + (b.count / total) * Math.abs(b.predicted - b.observed), 0);
}

export { CLASSES };
