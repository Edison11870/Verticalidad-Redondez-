/**
 * Emparejado de nombres de equipo entre proveedores (la API de cuotas y la de
 * datos rara vez usan la misma grafía: "Man City" vs "Manchester City").
 */

const NOISE = [
  'fc', 'cf', 'ac', 'afc', 'sc', 'cd', 'ud', 'sd', 'club', 'deportivo', 'calcio',
  'sv', 'vfl', 'vfb', 'tsg', 'bsc', 'if', 'ss', 'as', 'aс', 'de', 'futbol', 'football',
];

export function normalize(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(name) {
  return normalize(name)
    .split(' ')
    .filter((t) => t && !NOISE.includes(t) && t.length > 1);
}

const ALIASES = new Map(Object.entries({
  utd: 'united',
  man: 'manchester',
  wolves: 'wolverhampton',
  spurs: 'tottenham',
  psg: 'paris',
  atleti: 'atletico',
  inter: 'internazionale',
  bayern: 'bayern',
  gladbach: 'monchengladbach',
  dortmund: 'dortmund',
  boca: 'boca',
  river: 'river',
  'u': 'universitario',
}));

function canonical(token) {
  return ALIASES.get(token) ?? token;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

function stringSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return Math.max(0, 1 - levenshtein(a, b) / Math.max(a.length, b.length));
}

/** Similitud entre dos palabras sueltas, tolerando abreviaturas. */
function tokenSimilarity(a, b) {
  const ca = canonical(a);
  const cb = canonical(b);
  if (ca === cb) return 1;
  if (ca.length >= 3 && cb.length >= 3 && (ca.startsWith(cb) || cb.startsWith(ca))) return 0.95;
  const shared = commonPrefix(ca, cb);
  if (shared >= 4) return 0.85;
  return stringSimilarity(ca, cb);
}

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/** Puntúa una sigla ("sg") contra tramos del otro nombre ("saint germain"). */
function acronymScore(token, list) {
  if (token.length < 2 || token.length > 4) return 0;
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j <= list.length; j += 1) {
      const initials = list.slice(i, j).map((t) => t[0]).join('');
      if (initials === token) return 0.92;
    }
  }
  return 0;
}

function directional(from, to) {
  const scores = from.map((t) =>
    Math.max(acronymScore(t, to), ...to.map((u) => tokenSimilarity(t, u))),
  );
  return scores.reduce((a, b) => a + b, 0) / from.length;
}

/** 0 a 1: 1 es coincidencia exacta. */
export function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return stringSimilarity(na, nb);

  // Se puntúa el nombre corto contra el largo (un proveedor suele abreviar) y
  // se penaliza levemente cada palabra sobrante para no confundir clubes de la
  // misma ciudad ("Alianza Lima" vs "Alianza Atlético").
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const core = directional(short, long);
  const extras = long.length - short.length;
  const penalty = Math.min(0.15, extras * 0.06);
  const tokenScore = Math.max(0, core - penalty);

  return Math.max(tokenScore, stringSimilarity(na, nb));
}

/** Busca el mejor candidato por encima del umbral. */
export function bestMatch(name, candidates, threshold = 0.72) {
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? candidate : candidate.name;
    const score = similarity(name, value);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= threshold ? { match: best, score: bestScore } : null;
}

/** Empareja un partido (local + visitante) contra una lista de fixtures. */
export function matchFixture(home, away, fixtures, threshold = 0.72) {
  let best = null;
  let bestScore = 0;
  for (const fixture of fixtures) {
    const score = (similarity(home, fixture.homeTeam) + similarity(away, fixture.awayTeam)) / 2;
    if (score > bestScore) {
      bestScore = score;
      best = fixture;
    }
  }
  return bestScore >= threshold ? { fixture: best, score: bestScore } : null;
}
