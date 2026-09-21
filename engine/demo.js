/**
 * Generador de datos de DEMOSTRACIÓN.
 *
 * Simula dos temporadas de resultados, los partidos de hoy y mañana y un
 * mercado de cuotas con varias casas. Sirve para que la web funcione sin
 * claves de API y para probar el motor de punta a punta: los modelos, el
 * backtesting y las combinadas corren exactamente igual que en producción.
 *
 * Los resultados NO son reales y la web lo señala en todas las vistas.
 */

import { ROSTERS, LEAGUE_STRENGTH } from './data/teams.js';
import { LEAGUES } from './config.js';

/** PRNG determinista (mulberry32) para que la demo sea reproducible. */
export function createRandom(seed = 20260921) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random) {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function samplePoisson(lambda, random) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= random();
  } while (p > L);
  return k - 1;
}

/**
 * Visión del mercado: la casa de apuestas NO conoce la fuerza verdadera de
 * cada equipo, la estima. Se le da una versión de la verdad con un error
 * persistente por equipo (sus puntos ciegos), igual que el modelo tiene el
 * suyo. Sin esto la casa sería un oráculo y ningún modelo podría encontrar
 * valor jamás: el backtesting sólo mediría el margen.
 */
function buildBookView(teams, random, sigma = 0.075) {
  const view = new Map();
  for (const [name, team] of teams) {
    view.set(name, {
      name,
      attack: team.attack + sigma * gaussian(random),
      defence: team.defence + sigma * gaussian(random),
    });
  }
  return view;
}

function lambdasFor(teams, home, away, neutral = false) {
  const h = teams.get(home);
  const a = teams.get(away);
  const base = Math.log(1.35);
  const homeAdv = neutral ? 0 : 0.26;
  return {
    home: Math.exp(base + h.attack - a.defence + homeAdv),
    away: Math.exp(base + a.attack - h.defence),
  };
}

/** Universo de equipos con fuerza latente de ataque y defensa. */
function buildTeams(random) {
  const teams = new Map();
  for (const league of LEAGUES) {
    const roster = ROSTERS[league.id] ?? [];
    const strength = LEAGUE_STRENGTH[league.id] ?? 1;
    roster.forEach((name, i) => {
      if (teams.has(name)) {
        teams.get(name).leagues.add(league.id);
        return;
      }
      // Los primeros del listado son los históricamente más fuertes.
      const seedRank = 1 - i / Math.max(roster.length - 1, 1);
      teams.set(name, {
        name,
        leagues: new Set([league.id]),
        attack: 0.28 * seedRank + 0.12 * gaussian(random) + 0.1 * (strength - 1),
        defence: 0.26 * seedRank + 0.12 * gaussian(random) + 0.1 * (strength - 1),
      });
    });
  }
  return teams;
}

function simulateMatch(teams, home, away, random, { neutral = false } = {}) {
  const { home: lambdaHome, away: lambdaAway } = lambdasFor(teams, home, away, neutral);
  const homeGoals = Math.min(7, samplePoisson(lambdaHome, random));
  const awayGoals = Math.min(7, samplePoisson(lambdaAway, random));
  return {
    homeGoals,
    awayGoals,
    // xG simulado: ruido alrededor de la lambda verdadera.
    xgHome: Math.max(0.1, lambdaHome + 0.35 * gaussian(random)),
    xgAway: Math.max(0.1, lambdaAway + 0.35 * gaussian(random)),
    lambdaHome,
    lambdaAway,
  };
}

/**
 * Sesgo favorito-outsider ("favourite-longshot bias"): en los mercados reales
 * los outsiders se pagan peor de lo que les corresponde y los favoritos algo
 * mejor, porque el público sobre-apuesta a las cuotas altas. Se reproduce
 * elevando la probabilidad a un exponente < 1 y renormalizando.
 *
 * Sin este sesgo el mercado simulado sería perfecto por construcción y ningún
 * modelo podría encontrar valor: el backtesting sólo mediría el margen de la
 * casa. Con él, la demo muestra el flujo completo (detectar valor, apostar,
 * medir ROI) sobre un mercado con una ineficiencia documentada en la
 * literatura. Con claves de API reales esto no se usa: manda la cuota real.
 */
const LONGSHOT_EXPONENT = 0.94;

/** Dispersión de precio entre casas para un mismo resultado (~2%). */
const BOOK_DISPERSION = 0.02;

function applyLongshotBias(probs, exponent = LONGSHOT_EXPONENT) {
  const raw = {
    home: probs.home ** exponent,
    draw: probs.draw ** exponent,
    away: probs.away ** exponent,
  };
  const total = raw.home + raw.draw + raw.away;
  return { home: raw.home / total, draw: raw.draw / total, away: raw.away / total };
}

/**
 * Cuotas históricas simuladas: estimación de la casa + sesgo favorito-outsider
 * + margen, y se toma la MEJOR cuota entre varias casas.
 *
 * Es la misma estructura que usa la vista diaria (comparar casas y quedarse
 * con el mejor precio), así el ROI del backtesting mide lo que realmente haría
 * el sistema y no una versión más optimista.
 */
function simulateOdds(trueProbs, random, { margin = 0.05, books = 6 } = {}) {
  const biased = applyLongshotBias(trueProbs);
  const best = { home: 0, draw: 0, away: 0 };
  const impliedSum = { home: 0, draw: 0, away: 0 };
  for (let b = 0; b < books; b += 1) {
    const bookMargin = margin * (0.85 + 0.3 * random());
    for (const key of ['home', 'draw', 'away']) {
      const jitter = 1 + BOOK_DISPERSION * gaussian(random);
      const implied = Math.min(0.97, Math.max(0.02, biased[key] * (1 + bookMargin) * jitter));
      impliedSum[key] += implied;
      best[key] = Math.max(best[key], 1 / implied);
    }
  }
  const price = (key) => Number((books / impliedSum[key]).toFixed(3));
  return {
    home: Number(best.home.toFixed(2)),
    draw: Number(best.draw.toFixed(2)),
    away: Number(best.away.toFixed(2)),
    // Consenso: media de probabilidades implícitas. Es la referencia para
    // quitar el margen; la apuesta se hace a la mejor cuota.
    consensus: { home: price('home'), draw: price('draw'), away: price('away') },
    bookmakers: books,
    margin,
  };
}

function trueOutcomeProbs(lambdaHome, lambdaAway) {
  const pmf = (k, l) => Math.exp(-l + k * Math.log(l) - Math.log(factorial(k)));
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let x = 0; x <= 9; x += 1) {
    for (let y = 0; y <= 9; y += 1) {
      const p = pmf(x, lambdaHome) * pmf(y, lambdaAway);
      if (x > y) home += p;
      else if (x === y) draw += p;
      else away += p;
    }
  }
  const total = home + draw + away;
  return { home: home / total, draw: draw / total, away: away / total };
}

function factorial(n) {
  let acc = 1;
  for (let i = 2; i <= n; i += 1) acc *= i;
  return acc;
}

function roundRobin(roster, random) {
  const pairs = [];
  for (let i = 0; i < roster.length; i += 1) {
    for (let j = 0; j < roster.length; j += 1) {
      if (i !== j) pairs.push([roster[i], roster[j]]);
    }
  }
  // Barajado determinista
  for (let i = pairs.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  return pairs;
}

/**
 * @param {object} options {now, seed, daysOfHistory}
 * @returns {{history, fixtures, oddsEvents, demo:true}}
 */
export function generateDemoData(options = {}) {
  const now = options.now ?? new Date();
  // Dos flujos aleatorios independientes: uno para lo que ocurre en el campo y
  // otro para cómo cotiza el mercado. Así, tocar el simulador de cuotas no
  // cambia los resultados simulados y las corridas siguen siendo comparables.
  const random = createRandom(options.seed ?? 20260921);
  const marketRandom = createRandom((options.seed ?? 20260921) + 7919);
  const daysOfHistory = options.daysOfHistory ?? 560;
  const teams = buildTeams(random);
  const bookView = buildBookView(teams, marketRandom);

  const history = [];
  const fixtures = [];
  const oddsEvents = [];

  for (const league of LEAGUES) {
    const roster = ROSTERS[league.id] ?? [];
    if (roster.length < 4) continue;
    const neutral = league.id === 'worldcup';
    const pairs = roundRobin(roster, random);
    const spacing = daysOfHistory / Math.max(pairs.length, 1);

    pairs.forEach(([home, away], idx) => {
      const date = new Date(now.getTime() - (daysOfHistory - idx * spacing) * 86400000);
      if (date >= now) return;
      const result = simulateMatch(teams, home, away, random, { neutral });
      history.push({
        id: `demo-${league.id}-${idx}`,
        date,
        league: league.name,
        leagueId: league.id,
        leagueGroup: league.group,
        home,
        away,
        neutral,
        homeGoals: result.homeGoals,
        awayGoals: result.awayGoals,
        xgHome: result.xgHome,
        xgAway: result.xgAway,
        odds: simulateOdds(
          // La casa cotiza con SU estimación, no con la verdad.
          trueOutcomeProbs(
            lambdasFor(bookView, home, away, neutral).home,
            lambdasFor(bookView, home, away, neutral).away,
          ),
          marketRandom,
          { margin: 0.045 + 0.02 * marketRandom() },
        ),
      });
    });
  }

  history.sort((a, b) => a.date - b.date);

  // Partidos de hoy y mañana: se eligen parejas que no jugaron en los últimos días.
  let fixtureId = 0;
  for (const dayOffset of [0, 1]) {
    for (const league of LEAGUES) {
      const roster = ROSTERS[league.id] ?? [];
      if (roster.length < 4) continue;
      const neutral = league.id === 'worldcup';
      const perLeague = roster.length >= 12 ? 3 : 2;
      const used = new Set();
      for (let k = 0; k < perLeague; k += 1) {
        const home = pickUnused(roster, used, random);
        const away = pickUnused(roster, used, random);
        if (!home || !away) break;
        const kickoffHour = 12 + Math.floor(random() * 9);
        const date = new Date(now);
        date.setUTCDate(date.getUTCDate() + dayOffset);
        date.setUTCHours(kickoffHour, random() < 0.5 ? 0 : 30, 0, 0);
        if (dayOffset === 0 && date <= now) date.setUTCHours(date.getUTCHours() + 6);

        const bookLambdas = lambdasFor(bookView, home, away, neutral);
        const probs = trueOutcomeProbs(bookLambdas.home, bookLambdas.away);

        fixtureId += 1;
        const id = `demo-fx-${fixtureId}`;
        const injuriesHome = maybeInjuries(random);
        const injuriesAway = maybeInjuries(random);

        fixtures.push({
          id,
          date,
          league: league.name,
          leagueId: league.id,
          leagueGroup: league.group,
          country: null,
          round: null,
          venue: null,
          neutral,
          home,
          away,
          injuries: {
            home: injuriesHome.length * 0.08,
            away: injuriesAway.length * 0.08,
          },
          injuriesDetail:
            injuriesHome.length || injuriesAway.length
              ? { home: injuriesHome, away: injuriesAway }
              : null,
        });

        oddsEvents.push(
          buildDemoOddsEvent(
            id,
            league,
            home,
            away,
            date,
            probs,
            bookLambdas.home,
            bookLambdas.away,
            marketRandom,
          ),
        );
      }
    }
  }

  return { history, fixtures, oddsEvents, demo: true };
}

function pickUnused(roster, used, random) {
  const available = roster.filter((t) => !used.has(t));
  if (!available.length) return null;
  const pick = available[Math.floor(random() * available.length)];
  used.add(pick);
  return pick;
}

const INJURY_NAMES = ['Central titular', 'Volante creativo', 'Delantero centro', 'Lateral derecho', 'Arquero titular'];

function maybeInjuries(random) {
  const count = random() < 0.45 ? 1 + Math.floor(random() * 2) : 0;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(`${INJURY_NAMES[Math.floor(random() * INJURY_NAMES.length)]} (lesión)`);
  }
  return [...new Set(out)];
}

/** Evento de cuotas con varias casas, con precios ligeramente distintos. */
function buildDemoOddsEvent(id, league, home, away, date, probs, lambdaHome, lambdaAway, random) {
  const bookNames = ['Bet365', 'Pinnacle', 'Betfair', 'William Hill', 'Betsson', '1xBet'];
  const totalLambda = lambdaHome + lambdaAway;
  const overProb = 1 - Math.exp(-totalLambda) * (1 + totalLambda + totalLambda ** 2 / 2);
  const bttsProb = (1 - Math.exp(-lambdaHome)) * (1 - Math.exp(-lambdaAway));
  const ahHomeProb = probs.home + 0.5 * probs.draw;

  const biased = applyLongshotBias(probs);
  const books = bookNames.slice(0, 3 + Math.floor(random() * 4)).map((title) => {
    const margin = 0.03 + 0.035 * random();
    const jitter = () => 1 + BOOK_DISPERSION * gaussian(random);
    const price = (p) =>
      Number((1 / Math.min(0.97, Math.max(0.02, p * (1 + margin) * jitter()))).toFixed(2));
    return {
      key: title.toLowerCase().replace(/\s+/g, ''),
      title,
      markets: [
        {
          key: 'h2h',
          outcomes: [
            { name: home, price: price(biased.home) },
            { name: 'Draw', price: price(biased.draw) },
            { name: away, price: price(biased.away) },
          ],
        },
        {
          key: 'totals',
          outcomes: [
            { name: 'Over', point: 2.5, price: price(overProb) },
            { name: 'Under', point: 2.5, price: price(1 - overProb) },
          ],
        },
        {
          key: 'btts',
          outcomes: [
            { name: 'Yes', price: price(bttsProb) },
            { name: 'No', price: price(1 - bttsProb) },
          ],
        },
        {
          key: 'spreads',
          outcomes: [
            { name: home, point: -0.5, price: price(biased.home) },
            { name: away, point: 0.5, price: price(1 - biased.home) },
          ],
        },
      ],
    };
  });

  return {
    id: `odds-${id}`,
    leagueId: league.id,
    league: league.name,
    commenceTime: date,
    homeTeam: home,
    awayTeam: away,
    books,
  };
}
