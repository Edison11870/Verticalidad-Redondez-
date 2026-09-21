/**
 * Regresión logística multinomial (softmax) entrenada con descenso de
 * gradiente y regularización L2. Sustituye al XGBoost del diseño original:
 * misma familia de variables, sin dependencias externas y con coeficientes
 * legibles para poder explicar cada predicción.
 */

const CLASSES = ['home', 'draw', 'away'];

function standardizeFit(rows) {
  const dim = rows[0].length;
  const mean = new Float64Array(dim);
  const std = new Float64Array(dim).fill(1);
  for (const r of rows) for (let j = 0; j < dim; j += 1) mean[j] += r[j];
  for (let j = 0; j < dim; j += 1) mean[j] /= rows.length;
  for (const r of rows) for (let j = 0; j < dim; j += 1) std[j] += (r[j] - mean[j]) ** 2;
  for (let j = 0; j < dim; j += 1) {
    std[j] = Math.sqrt(std[j] / Math.max(rows.length - 1, 1));
    if (!Number.isFinite(std[j]) || std[j] < 1e-6) std[j] = 1;
  }
  return { mean: Array.from(mean), std: Array.from(std) };
}

function applyScaler(scaler, x) {
  return x.map((v, j) => (v - scaler.mean[j]) / scaler.std[j]);
}

function softmax(scores) {
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/**
 * @param {number[][]} X  matriz de variables
 * @param {string[]} y    etiquetas 'home' | 'draw' | 'away'
 * @param {number[]} [weights] pesos por muestra (decaimiento temporal)
 */
export function trainMultinomial(X, y, weights, options = {}) {
  const { iterations = 700, learningRate = 0.25, l2 = 0.004, featureNames = [] } = options;
  if (!X.length) throw new Error('Sin datos de entrenamiento para la regresión logística');

  const scaler = standardizeFit(X);
  const Z = X.map((x) => applyScaler(scaler, x));
  const dim = Z[0].length;
  const w = CLASSES.map(() => new Float64Array(dim));
  const b = new Float64Array(CLASSES.length);
  const sampleW = weights ?? X.map(() => 1);
  const totalW = sampleW.reduce((a, c) => a + c, 0) || 1;

  for (let it = 0; it < iterations; it += 1) {
    const gW = CLASSES.map(() => new Float64Array(dim));
    const gB = new Float64Array(CLASSES.length);

    for (let i = 0; i < Z.length; i += 1) {
      const scores = CLASSES.map((_, c) => {
        let s = b[c];
        for (let j = 0; j < dim; j += 1) s += w[c][j] * Z[i][j];
        return s;
      });
      const probs = softmax(scores);
      const target = CLASSES.indexOf(y[i]);
      for (let c = 0; c < CLASSES.length; c += 1) {
        const err = sampleW[i] * ((target === c ? 1 : 0) - probs[c]);
        gB[c] += err;
        for (let j = 0; j < dim; j += 1) gW[c][j] += err * Z[i][j];
      }
    }

    const lr = learningRate / (1 + it / 300);
    for (let c = 0; c < CLASSES.length; c += 1) {
      b[c] += (lr * gB[c]) / totalW;
      for (let j = 0; j < dim; j += 1) {
        w[c][j] += (lr * gW[c][j]) / totalW - lr * l2 * w[c][j];
      }
    }
  }

  return {
    type: 'logistic-multinomial',
    classes: CLASSES,
    featureNames,
    scaler,
    weights: w.map((row) => Array.from(row)),
    bias: Array.from(b),
    samples: X.length,
  };
}

export function predictMultinomial(model, x) {
  const z = applyScaler(model.scaler, x);
  const scores = model.weights.map((row, c) => {
    let s = model.bias[c];
    for (let j = 0; j < row.length; j += 1) s += row[j] * z[j];
    return s;
  });
  const probs = softmax(scores);
  return { home: probs[0], draw: probs[1], away: probs[2] };
}

/** Importancia aproximada: magnitud media del coeficiente estandarizado. */
export function featureImportance(model) {
  return model.featureNames
    .map((name, j) => ({
      feature: name,
      weight: model.weights.reduce((s, row) => s + Math.abs(row[j]), 0) / model.weights.length,
    }))
    .sort((a, b) => b.weight - a.weight);
}

export { CLASSES };
