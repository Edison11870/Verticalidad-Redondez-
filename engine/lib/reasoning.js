/**
 * Justificación en lenguaje natural de cada selección: forma, xG, descanso,
 * bajas y comparación con la cuota. Todo sale de las mismas variables que
 * alimentan al modelo, así que lo que se lee es lo que se calculó.
 */

const fmt = (n, d = 2) => Number(n).toFixed(d);
const pct = (n) => `${Math.round(n * 100)}%`;

function formWord(form) {
  if (form >= 2.2) return 'en gran momento';
  if (form >= 1.6) return 'en forma regular-buena';
  if (form >= 1.1) return 'irregular';
  return 'en mal momento';
}

export function buildReasoning(fixture, prediction, selection, context) {
  const { home: sHome, away: sAway, h2h, injuries } = context.features;
  const reasons = [];

  reasons.push(
    `Forma: ${fixture.home} ${fmt(sHome.form, 2)} pts/partido (${formWord(sHome.form)}) vs ${fixture.away} ${fmt(sAway.form, 2)} (${formWord(sAway.form)}).`,
  );

  reasons.push(
    `xG últimos partidos: ${fixture.home} ${fmt(sHome.xgFor, 2)} a favor / ${fmt(sHome.xgAgainst, 2)} en contra; ${fixture.away} ${fmt(sAway.xgFor, 2)} / ${fmt(sAway.xgAgainst, 2)}.`,
  );

  reasons.push(
    `Goles esperados en este partido: ${fmt(prediction.lambdas.home, 2)} - ${fmt(prediction.lambdas.away, 2)}.`,
  );

  if (Math.abs(sHome.restDays - sAway.restDays) >= 2) {
    const rested = sHome.restDays > sAway.restDays ? fixture.home : fixture.away;
    reasons.push(
      `Descanso: ${rested} llega con más días libres (${fmt(Math.max(sHome.restDays, sAway.restDays), 0)} vs ${fmt(Math.min(sHome.restDays, sAway.restDays), 0)}).`,
    );
  }

  if (sHome.congestion >= 4 || sAway.congestion >= 4) {
    const loaded = sHome.congestion >= sAway.congestion ? fixture.home : fixture.away;
    reasons.push(
      `Calendario cargado: ${loaded} acumula ${Math.max(sHome.congestion, sAway.congestion)} partidos en 14 días.`,
    );
  }

  const injuryList = context.injuries;
  if (injuryList?.home?.length || injuryList?.away?.length) {
    const parts = [];
    if (injuryList.home?.length) parts.push(`${fixture.home}: ${injuryList.home.slice(0, 3).join(', ')}`);
    if (injuryList.away?.length) parts.push(`${fixture.away}: ${injuryList.away.slice(0, 3).join(', ')}`);
    reasons.push(`Bajas — ${parts.join(' | ')}.`);
  } else if ((injuries?.home ?? 0) + (injuries?.away ?? 0) > 0) {
    reasons.push(
      `Impacto estimado de bajas: ${fixture.home} ${pct(injuries.home)} / ${fixture.away} ${pct(injuries.away)} de su plantel clave.`,
    );
  } else {
    reasons.push('Sin bajas relevantes reportadas al momento de calcular.');
  }

  if (h2h?.games >= 2) {
    const tone = h2h.score > 0.2 ? fixture.home : h2h.score < -0.2 ? fixture.away : null;
    reasons.push(
      tone
        ? `Historial directo (${h2h.games} partidos) favorece a ${tone}.`
        : `Historial directo parejo en ${h2h.games} partidos.`,
    );
  }

  reasons.push(
    `Cuota ${fmt(selection.odds, 2)} implica ${pct(selection.impliedProbability)}; el modelo da ${pct(selection.probability)} → valor esperado ${selection.expectedValue > 0 ? '+' : ''}${pct(selection.expectedValue)} por unidad.`,
  );

  return reasons;
}

/** Resumen de una línea para las tarjetas compactas. */
export function shortReasoning(fixture, prediction, selection, context) {
  const { home: sHome, away: sAway } = context.features;
  const edge = `${selection.edge > 0 ? '+' : ''}${(selection.edge * 100).toFixed(1)} pts de ventaja sobre el mercado`;
  const goals = `xG ${fmt(prediction.lambdas.home, 1)}-${fmt(prediction.lambdas.away, 1)}`;
  const form = `forma ${fmt(sHome.form, 1)} vs ${fmt(sAway.form, 1)}`;
  return `${goals}, ${form}, ${edge}.`;
}
