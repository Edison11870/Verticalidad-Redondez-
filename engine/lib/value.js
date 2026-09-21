/**
 * Comparación modelo vs mercado: eliminación del margen (vig), valor
 * esperado, ventaja (edge), Kelly fraccionario y nivel de confianza.
 */

export const MAX_STAKE_UNITS = 2.5;

export function impliedProbability(decimalOdds) {
  return decimalOdds > 1 ? 1 / decimalOdds : 0;
}

/** Margen del libro: suma de probabilidades implícitas - 1. */
export function overround(oddsList) {
  return oddsList.reduce((s, o) => s + impliedProbability(o), 0) - 1;
}

/**
 * Quita el margen de un mercado completo.
 * 'power' reparte el margen de forma no proporcional (más realista en
 * favoritos/underdogs); 'proportional' es el reparto simple.
 */
export function removeVig(oddsList, method = 'power') {
  const implied = oddsList.map(impliedProbability);
  const sum = implied.reduce((a, b) => a + b, 0);
  if (sum <= 0) return implied;
  if (method === 'proportional') return implied.map((p) => p / sum);

  let lo = 0.5;
  let hi = 1.5;
  for (let i = 0; i < 60; i += 1) {
    const k = (lo + hi) / 2;
    const total = implied.reduce((s, p) => s + p ** k, 0);
    if (total > 1) lo = k;
    else hi = k;
  }
  const k = (lo + hi) / 2;
  const fair = implied.map((p) => p ** k);
  const total = fair.reduce((a, b) => a + b, 0);
  return fair.map((p) => p / total);
}

/**
 * Valor esperado por unidad apostada, contemplando el empate técnico (push)
 * de los hándicaps enteros, donde se devuelve el importe.
 */
export function expectedValue(probability, decimalOdds, pushProbability = 0) {
  const pWin = probability * (1 - pushProbability);
  const pLose = Math.max(0, 1 - pWin - pushProbability);
  return pWin * (decimalOdds - 1) - pLose;
}

/** Kelly fraccionario, acotado para proteger el bankroll. */
export function kellyStake(probability, decimalOdds, fraction = 0.25) {
  const b = decimalOdds - 1;
  if (b <= 0) return 0;
  const raw = (b * probability - (1 - probability)) / b;
  if (raw <= 0) return 0;
  return Math.min(MAX_STAKE_UNITS, Number((raw * fraction * 10).toFixed(2)));
}

/**
 * Nivel de confianza 0-100. Combina:
 *  - acuerdo entre los tres modelos
 *  - cobertura de datos históricos
 *  - calidad del mercado (nº de casas y margen)
 *  - qué tan lejos está la probabilidad del 50% (señal más nítida)
 */
export function confidenceScore({
  agreement = 0.5,
  coverage = 0.5,
  bookmakers = 1,
  margin = 0.06,
  probability = 0.5,
  injuriesKnown = false,
  lineupsKnown = false,
}) {
  const bookScore = Math.min(1, Math.log2(1 + bookmakers) / 3.5);
  const marginScore = Math.max(0, Math.min(1, 1 - margin / 0.12));
  const sharpness = Math.min(1, Math.abs(probability - 0.5) / 0.35);
  const dataBonus = (injuriesKnown ? 0.5 : 0) + (lineupsKnown ? 0.5 : 0);

  const score =
    0.3 * agreement +
    0.22 * coverage +
    0.16 * bookScore +
    0.12 * marginScore +
    0.12 * sharpness +
    0.08 * dataBonus;

  return Math.round(Math.max(0, Math.min(1, score)) * 100);
}

export function confidenceLabel(score) {
  if (score >= 72) return 'Alta';
  if (score >= 55) return 'Media';
  return 'Baja';
}

/**
 * Evalúa una selección frente al mercado.
 * @param {object} selection  salida de buildSelections
 * @param {object} market     {odds, fairProbability, bookmaker, bookmakers, margin}
 */
export function evaluateSelection(selection, market, meta = {}) {
  const push = selection.push ?? 0;
  const modelProbability = selection.probability;
  const ev = expectedValue(modelProbability, market.odds, push);
  const fair = market.fairProbability ?? impliedProbability(market.odds);
  const edge = modelProbability - fair;
  const confidence = confidenceScore({
    ...meta,
    probability: modelProbability,
    bookmakers: market.bookmakers ?? 1,
    margin: market.margin ?? 0.06,
  });

  return {
    ...selection,
    odds: market.odds,
    bookmaker: market.bookmaker ?? null,
    bookmakers: market.bookmakers ?? 1,
    fairProbability: fair,
    impliedProbability: impliedProbability(market.odds),
    expectedValue: ev,
    edge,
    stake: kellyStake(modelProbability, market.odds),
    confidence,
    confidenceLabel: confidenceLabel(confidence),
  };
}
