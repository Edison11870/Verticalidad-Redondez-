/**
 * Modelo Dixon-Coles (Poisson bivariado con corrección de marcadores bajos).
 *
 * Ajusta fuerza de ataque y defensa por equipo con ponderación temporal
 * exponencial, ventaja de localía global y el parámetro rho que corrige la
 * dependencia entre goles en resultados 0-0, 1-0, 0-1 y 1-1.
 */

const MAX_GOALS = 10;

/** Corrección de Dixon-Coles para marcadores bajos. */
export function tau(x, y, lambdaHome, lambdaAway, rho) {
  if (x === 0 && y === 0) return 1 - lambdaHome * lambdaAway * rho;
  if (x === 0 && y === 1) return 1 + lambdaHome * rho;
  if (x === 1 && y === 0) return 1 + lambdaAway * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/** Peso temporal: los partidos viejos pesan menos (xi por día). */
export function timeWeight(matchDate, referenceDate, xi = 0.0045) {
  const days = (referenceDate - matchDate) / 86400000;
  return days <= 0 ? 1 : Math.exp(-xi * days);
}

function logFactorial(n) {
  let acc = 0;
  for (let i = 2; i <= n; i += 1) acc += Math.log(i);
  return acc;
}

const LOG_FACT = Array.from({ length: MAX_GOALS + 6 }, (_, i) => logFactorial(i));

export function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda + k * Math.log(lambda) - LOG_FACT[k]);
}

/**
 * @param {Array<{home:string, away:string, homeGoals:number, awayGoals:number, date:Date, weight?:number}>} matches
 * @param {{xi?:number, iterations?:number, learningRate?:number, reference?:Date}} [options]
 */
export function fitDixonColes(matches, options = {}) {
  const {
    xi = 0.0025,
    iterations = 80,
    tolerance = 1e-7,
    reference = new Date(),
    // Regularización: equivale a añadir `shrinkage` goles de un equipo medio a
    // cada equipo, así los que tienen pocos partidos no reciben ratings
    // extremos por dos goleadas sueltas.
    shrinkage = 6,
  } = options;

  const teams = [...new Set(matches.flatMap((m) => [m.home, m.away]))].sort();
  const index = new Map(teams.map((t, i) => [t, i]));
  const n = teams.length;
  if (n < 2) throw new Error('Se necesitan al menos 2 equipos para ajustar Dixon-Coles');

  const rows = matches
    .filter((m) => index.has(m.home) && index.has(m.away))
    .map((m) => ({
      h: index.get(m.home),
      a: index.get(m.away),
      x: Math.min(m.homeGoals, MAX_GOALS),
      y: Math.min(m.awayGoals, MAX_GOALS),
      neutral: Boolean(m.neutral),
      league: m.leagueId ?? m.league ?? 'global',
      w: m.weight ?? timeWeight(m.date, reference, xi),
    }));

  const totalWeight = rows.reduce((s, r) => s + r.w, 0) || 1;
  const meanGoals =
    rows.reduce((s, r) => s + r.w * (r.x + r.y), 0) / (2 * totalWeight) || 1.35;

  // Nivel de goles por competición: una liga con 3.2 goles por partido y otra
  // con 2.3 no pueden compartir la misma media. Los equipos que juegan en
  // varias competiciones (liga + copa continental) son los que enlazan los
  // niveles entre sí.
  const leagues = [...new Set(rows.map((r) => r.league))];
  const leagueIndex = new Map(leagues.map((l, i) => [l, i]));
  for (const r of rows) r.l = leagueIndex.get(r.league);

  // Escalado iterativo de Poisson: cada parámetro tiene solución cerrada dado
  // el resto, así que el ajuste converge en pocas pasadas y reproduce
  // exactamente los goles observados (sin el sesgo del descenso de gradiente).
  const mu = new Float64Array(leagues.length).fill(Math.max(meanGoals, 0.2));
  let gamma = 1.25;
  const alpha = new Float64Array(n).fill(1); // fuerza de ataque (multiplicativa)
  const beta = new Float64Array(n).fill(1);  // solidez defensiva

  const scoredNum = new Float64Array(n);
  const scoredDen = new Float64Array(n);
  const concededNum = new Float64Array(n);
  const concededDen = new Float64Array(n);

  // Gauss-Seidel: se actualiza un bloque de parámetros a la vez, usando ya los
  // valores nuevos de los bloques anteriores. Actualizar todo a la vez (Jacobi)
  // hace oscilar ataque y defensa, porque ambos mueven lambda en la misma
  // dirección.
  for (let it = 0; it < iterations; it += 1) {
    let maxDelta = 0;

    // 1) Ataque
    scoredNum.fill(0);
    scoredDen.fill(0);
    for (const r of rows) {
      const g = r.neutral ? 1 : gamma;
      scoredNum[r.h] += r.w * r.x;
      scoredDen[r.h] += (r.w * mu[r.l] * g) / beta[r.a];
      scoredNum[r.a] += r.w * r.y;
      scoredDen[r.a] += (r.w * mu[r.l]) / beta[r.h];
    }
    for (let i = 0; i < n; i += 1) {
      if (scoredDen[i] <= 0) continue;
      const next = clampParam((scoredNum[i] + shrinkage) / (scoredDen[i] + shrinkage));
      maxDelta = Math.max(maxDelta, Math.abs(next - alpha[i]));
      alpha[i] = next;
    }
    normalizeInPlace(alpha);

    // 2) Defensa
    concededNum.fill(0);
    concededDen.fill(0);
    for (const r of rows) {
      const g = r.neutral ? 1 : gamma;
      concededNum[r.a] += r.w * mu[r.l] * alpha[r.h] * g;
      concededDen[r.a] += r.w * r.x;
      concededNum[r.h] += r.w * mu[r.l] * alpha[r.a];
      concededDen[r.h] += r.w * r.y;
    }
    for (let i = 0; i < n; i += 1) {
      if (concededDen[i] <= 0) continue;
      const next = clampParam((concededNum[i] + shrinkage) / (concededDen[i] + shrinkage));
      maxDelta = Math.max(maxDelta, Math.abs(next - beta[i]));
      beta[i] = next;
    }
    normalizeInPlace(beta);

    // 3) Localía (global) y nivel de goles de cada competición
    let homeGoals = 0;
    let homeLambda = 0;
    const leagueGoals = new Float64Array(leagues.length);
    const leagueLambda = new Float64Array(leagues.length);
    for (const r of rows) {
      const g = r.neutral ? 1 : gamma;
      const lh = (mu[r.l] * alpha[r.h] * g) / beta[r.a];
      const la = (mu[r.l] * alpha[r.a]) / beta[r.h];
      leagueGoals[r.l] += r.w * (r.x + r.y);
      leagueLambda[r.l] += r.w * (lh + la);
      if (!r.neutral) {
        homeGoals += r.w * r.x;
        homeLambda += r.w * lh;
      }
    }
    if (homeLambda > 0) {
      const nextGamma = Math.max(0.8, Math.min(2, (gamma * homeGoals) / homeLambda));
      maxDelta = Math.max(maxDelta, Math.abs(nextGamma - gamma));
      gamma = nextGamma;
    }
    for (let l = 0; l < leagues.length; l += 1) {
      if (leagueLambda[l] <= 0) continue;
      const scale = leagueGoals[l] / leagueLambda[l];
      maxDelta = Math.max(maxDelta, Math.abs(scale - 1));
      mu[l] = Math.max(0.3, Math.min(4, mu[l] * scale));
    }

    if (maxDelta < tolerance) break;
  }

  const baseByLeague = {};
  leagues.forEach((league, i) => {
    baseByLeague[league] = Math.log(mu[i]);
  });
  const base = Math.log(
    Math.exp(leagues.reduce((s, l, i) => s + Math.log(mu[i]), 0) / Math.max(leagues.length, 1)),
  );
  const homeAdvantage = Math.log(gamma);
  const attack = Array.from(alpha, (v) => Math.log(v));
  const defence = Array.from(beta, (v) => Math.log(v));
  const rho = fitRho(rows, { mu, attack, defence, homeAdvantage });

  const ratings = {};
  teams.forEach((team, i) => {
    ratings[team] = { attack: attack[i], defence: defence[i] };
  });

  return {
    type: 'dixon-coles',
    base,
    baseByLeague,
    homeAdvantage,
    rho,
    ratings,
    matchesUsed: rows.length,
    teams,
  };
}

function clampParam(value) {
  return Math.max(0.05, Math.min(6, value));
}

/** Fija la media geométrica en 1 (identificabilidad de ataque/defensa). */
function normalizeInPlace(values) {
  const g = geometricMean(values);
  for (let i = 0; i < values.length; i += 1) values[i] /= g;
  return g;
}

function geometricMean(values) {
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += Math.log(Math.max(values[i], 1e-9));
  return Math.exp(sum / values.length);
}

/** Búsqueda 1-D del rho que maximiza la verosimilitud completa. */
function fitRho(rows, { mu, attack, defence, homeAdvantage }) {
  let best = 0;
  let bestLL = -Infinity;
  for (let rho = -0.22; rho <= 0.101; rho += 0.005) {
    let ll = 0;
    for (const r of rows) {
      const leagueBase = Math.log(mu[r.l]);
      const lh = Math.exp(leagueBase + attack[r.h] - defence[r.a] + (r.neutral ? 0 : homeAdvantage));
      const la = Math.exp(leagueBase + attack[r.a] - defence[r.h]);
      const t = tau(r.x, r.y, lh, la, rho);
      if (t <= 0) {
        ll = -Infinity;
        break;
      }
      ll += r.w * Math.log(t);
    }
    if (ll > bestLL) {
      bestLL = ll;
      best = rho;
    }
  }
  return Number(best.toFixed(4));
}

/**
 * Lambdas esperadas para un enfrentamiento concreto.
 * @param {string} [leagueId] competición, para usar su nivel de goles propio
 */
export function expectedGoals(model, home, away, leagueId = null) {
  const fallback = { attack: 0, defence: 0 };
  const h = model.ratings[home] ?? fallback;
  const a = model.ratings[away] ?? fallback;
  const base = model.baseByLeague?.[leagueId] ?? model.base;
  return {
    home: Math.exp(base + h.attack - a.defence + model.homeAdvantage),
    away: Math.exp(base + a.attack - h.defence),
    known: Boolean(model.ratings[home] && model.ratings[away]),
  };
}

/** Matriz de probabilidad conjunta de marcadores (con corrección tau). */
export function scoreMatrix(lambdaHome, lambdaAway, rho = 0, maxGoals = MAX_GOALS) {
  const matrix = [];
  let total = 0;
  for (let x = 0; x <= maxGoals; x += 1) {
    const row = [];
    for (let y = 0; y <= maxGoals; y += 1) {
      const p =
        poissonPmf(x, lambdaHome) *
        poissonPmf(y, lambdaAway) *
        Math.max(tau(x, y, lambdaHome, lambdaAway, rho), 0.0001);
      row.push(p);
      total += p;
    }
    matrix.push(row);
  }
  for (let x = 0; x <= maxGoals; x += 1) {
    for (let y = 0; y <= maxGoals; y += 1) matrix[x][y] /= total;
  }
  return matrix;
}

/** Probabilidades 1X2 derivadas de la matriz de marcadores. */
export function outcomeProbabilities(matrix) {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let x = 0; x < matrix.length; x += 1) {
    for (let y = 0; y < matrix[x].length; y += 1) {
      if (x > y) home += matrix[x][y];
      else if (x === y) draw += matrix[x][y];
      else away += matrix[x][y];
    }
  }
  return { home, draw, away };
}

export { MAX_GOALS };
