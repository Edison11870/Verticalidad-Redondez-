/**
 * Construcción de combinadas en tres niveles de riesgo.
 *
 * Reglas duras:
 *  - nunca dos selecciones del mismo partido (correlación total)
 *  - nunca dos selecciones que compartan un equipo
 *  - como máximo una selección del mismo mercado dentro de la misma liga y día
 *    (los goles de una liga comparten entorno: arbitraje, clima, calendario)
 *
 * La probabilidad combinada se calcula como producto de probabilidades
 * independientes y se aplica un descuento por correlación residual, para no
 * vender una probabilidad inflada.
 */

/** Etiqueta legible de la banda de cuota objetivo. */
function tierLabel(tier) {
  return tier.openEnded ? `${tier.minOdds}+` : `${tier.minOdds}-${tier.maxOdds}`;
}

export const PARLAY_TIERS = [
  {
    id: 'segura',
    name: 'Segura',
    minOdds: 2,
    maxOdds: 3,
    minLegs: 2,
    maxLegs: 3,
    minLegProbability: 0.62,
    minConfidence: 60,
  },
  {
    id: 'media',
    name: 'Media',
    minOdds: 5,
    maxOdds: 8,
    minLegs: 3,
    maxLegs: 4,
    minLegProbability: 0.45,
    minConfidence: 52,
  },
  {
    id: 'alta',
    name: 'Alta',
    minOdds: 10,
    maxOdds: 60,
    openEnded: true,
    minLegs: 3,
    maxLegs: 4,
    minLegProbability: 0.3,
    minConfidence: 45,
  },
];

const CORRELATION_DISCOUNT = 0.985;

function conflicts(a, b) {
  if (a.fixtureId === b.fixtureId) return true;
  if (a.homeTeam === b.homeTeam || a.homeTeam === b.awayTeam) return true;
  if (a.awayTeam === b.homeTeam || a.awayTeam === b.awayTeam) return true;
  if (a.leagueId === b.leagueId && a.market === b.market && a.day === b.day) return true;
  return false;
}

function combine(legs) {
  const odds = legs.reduce((p, l) => p * l.odds, 1);
  const rawProbability = legs.reduce((p, l) => p * l.probability, 1);
  const probability = rawProbability * CORRELATION_DISCOUNT ** (legs.length - 1);
  return {
    odds: Number(odds.toFixed(2)),
    rawProbability,
    probability,
    expectedValue: probability * odds - 1,
    confidence: Math.round(legs.reduce((s, l) => s + l.confidence, 0) / legs.length),
  };
}

/** Enumera combinaciones válidas y devuelve la mejor por valor esperado. */
function searchTier(candidates, tier) {
  const pool = candidates
    .filter(
      (c) =>
        c.probability >= tier.minLegProbability &&
        c.confidence >= tier.minConfidence &&
        c.expectedValue > 0,
    )
    .sort((a, b) => b.expectedValue * b.probability - a.expectedValue * a.probability)
    .slice(0, 26);

  let best = null;
  const current = [];

  const visit = (start) => {
    if (current.length >= tier.minLegs) {
      const combo = combine(current);
      const inBand = combo.odds >= tier.minOdds && combo.odds <= tier.maxOdds;
      if (inBand && combo.expectedValue > 0) {
        const score = combo.probability * (1 + combo.expectedValue);
        if (!best || score > best.score) {
          best = { score, legs: [...current], ...combo };
        }
      }
    }
    if (current.length >= tier.maxLegs) return;
    for (let i = start; i < pool.length; i += 1) {
      const candidate = pool[i];
      if (current.some((leg) => conflicts(leg, candidate))) continue;
      const projected = current.reduce((p, l) => p * l.odds, 1) * candidate.odds;
      if (projected > tier.maxOdds * 1.25) continue;
      current.push(candidate);
      visit(i + 1);
      current.pop();
    }
  };

  visit(0);
  return best;
}

/**
 * @param {Array} candidates selecciones evaluadas con fixtureId, equipos, liga,
 *                           odds, probability, confidence, expectedValue
 */
export function buildParlays(candidates, tiers = PARLAY_TIERS) {
  return tiers
    .map((tier) => {
      const best = searchTier(candidates, tier);
      if (!best) {
        return {
          tier: tier.id,
          name: tier.name,
          targetOdds: tierLabel(tier),
          available: false,
          reason: 'No hay selecciones con valor suficiente para armar este nivel hoy',
          legs: [],
        };
      }
      return {
        tier: tier.id,
        name: tier.name,
        targetOdds: tierLabel(tier),
        available: true,
        fairOdds: Number((1 / best.probability).toFixed(2)),
        odds: best.odds,
        probability: best.probability,
        rawProbability: best.rawProbability,
        expectedValue: best.expectedValue,
        confidence: best.confidence,
        correlationNote:
          'Sin partidos correlacionados: un solo pick por encuentro, sin equipos repetidos y sin repetir mercado dentro de la misma liga.',
        legs: best.legs.map((l) => ({
          fixtureId: l.fixtureId,
          match: `${l.homeTeam} vs ${l.awayTeam}`,
          league: l.league,
          kickoff: l.kickoff,
          market: l.market,
          label: l.label,
          odds: l.odds,
          probability: l.probability,
          confidence: l.confidence,
          reasoning: l.reasoning,
        })),
      };
    })
    .filter(Boolean);
}
