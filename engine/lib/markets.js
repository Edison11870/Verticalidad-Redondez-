/**
 * Derivación de todos los mercados a partir de la matriz de marcadores.
 * Al salir todos de la misma matriz, las probabilidades son internamente
 * coherentes (p.ej. 1X2 y doble oportunidad nunca se contradicen).
 */

export const MARKET_LABELS = {
  '1x2': '1X2',
  dc: 'Doble oportunidad',
  ou: 'Más/Menos goles',
  btts: 'Ambos anotan',
  ah: 'Hándicap asiático',
};

const OU_LINES = [1.5, 2.5, 3.5];
const AH_LINES = [-1.5, -1, -0.5, 0, 0.5, 1, 1.5];

function sumMatrix(matrix, predicate) {
  let total = 0;
  for (let x = 0; x < matrix.length; x += 1) {
    for (let y = 0; y < matrix[x].length; y += 1) {
      if (predicate(x, y)) total += matrix[x][y];
    }
  }
  return total;
}

/** Probabilidades de ganar / empujar (push) / perder para un hándicap. */
export function handicapProbabilities(matrix, line, side = 'home') {
  let win = 0;
  let push = 0;
  let lose = 0;
  for (let x = 0; x < matrix.length; x += 1) {
    for (let y = 0; y < matrix[x].length; y += 1) {
      const p = matrix[x][y];
      const margin = (side === 'home' ? x - y : y - x) + line;
      if (Math.abs(margin) < 1e-9) push += p;
      else if (margin > 0) win += p;
      else lose += p;
    }
  }
  return { win, push, lose };
}

function fmtLine(line) {
  return line > 0 ? `+${line}` : `${line}`;
}

/**
 * Todas las selecciones disponibles de un partido.
 * @returns {Array<{market, code, label, probability, push}>}
 */
export function buildSelections(matrix, teams = { home: 'Local', away: 'Visitante' }) {
  const p1 = sumMatrix(matrix, (x, y) => x > y);
  const px = sumMatrix(matrix, (x, y) => x === y);
  const p2 = sumMatrix(matrix, (x, y) => x < y);

  const selections = [
    { market: '1x2', code: '1', label: `Gana ${teams.home}`, probability: p1 },
    { market: '1x2', code: 'X', label: 'Empate', probability: px },
    { market: '1x2', code: '2', label: `Gana ${teams.away}`, probability: p2 },
    { market: 'dc', code: '1X', label: `${teams.home} o empate`, probability: p1 + px },
    { market: 'dc', code: '12', label: 'Sin empate', probability: p1 + p2 },
    { market: 'dc', code: 'X2', label: `Empate o ${teams.away}`, probability: px + p2 },
    {
      market: 'btts',
      code: 'BTTS_SI',
      label: 'Ambos anotan: Sí',
      probability: sumMatrix(matrix, (x, y) => x > 0 && y > 0),
    },
    {
      market: 'btts',
      code: 'BTTS_NO',
      label: 'Ambos anotan: No',
      probability: sumMatrix(matrix, (x, y) => x === 0 || y === 0),
    },
  ];

  for (const line of OU_LINES) {
    selections.push({
      market: 'ou',
      code: `OVER_${line}`,
      label: `Más de ${line} goles`,
      probability: sumMatrix(matrix, (x, y) => x + y > line),
      line,
    });
    selections.push({
      market: 'ou',
      code: `UNDER_${line}`,
      label: `Menos de ${line} goles`,
      probability: sumMatrix(matrix, (x, y) => x + y < line),
      line,
    });
  }

  for (const line of AH_LINES) {
    for (const side of ['home', 'away']) {
      const { win, push, lose } = handicapProbabilities(matrix, line, side);
      const team = side === 'home' ? teams.home : teams.away;
      selections.push({
        market: 'ah',
        code: `AH_${side.toUpperCase()}_${line}`,
        label: `${team} ${fmtLine(line)}`,
        probability: push > 0 ? win / Math.max(win + lose, 1e-9) : win,
        rawWin: win,
        push,
        lose,
        line,
        side,
      });
    }
  }

  return selections;
}

/** Marcadores más probables, para mostrar contexto en la ficha del partido. */
export function topScorelines(matrix, count = 3) {
  const list = [];
  for (let x = 0; x < matrix.length; x += 1) {
    for (let y = 0; y < matrix[x].length; y += 1) {
      list.push({ score: `${x}-${y}`, probability: matrix[x][y] });
    }
  }
  return list.sort((a, b) => b.probability - a.probability).slice(0, count);
}

/** Total de goles esperado según la matriz final (post-ensamble). */
export function expectedTotalGoals(matrix) {
  let total = 0;
  for (let x = 0; x < matrix.length; x += 1) {
    for (let y = 0; y < matrix[x].length; y += 1) total += matrix[x][y] * (x + y);
  }
  return total;
}

export { OU_LINES, AH_LINES };

/**
 * Probabilidad para un código de selección arbitrario, incluidas líneas que
 * sólo publica el mercado (over 2.25, hándicap -1.25, etc.).
 * Devuelve null si el código no se reconoce.
 */
export function probabilityForCode(matrix, code, teams = { home: 'Local', away: 'Visitante' }) {
  const simple = {
    '1': { market: '1x2', label: `Gana ${teams.home}`, test: (x, y) => x > y },
    X: { market: '1x2', label: 'Empate', test: (x, y) => x === y },
    '2': { market: '1x2', label: `Gana ${teams.away}`, test: (x, y) => x < y },
    '1X': { market: 'dc', label: `${teams.home} o empate`, test: (x, y) => x >= y },
    '12': { market: 'dc', label: 'Sin empate', test: (x, y) => x !== y },
    X2: { market: 'dc', label: `Empate o ${teams.away}`, test: (x, y) => x <= y },
    BTTS_SI: { market: 'btts', label: 'Ambos anotan: Sí', test: (x, y) => x > 0 && y > 0 },
    BTTS_NO: { market: 'btts', label: 'Ambos anotan: No', test: (x, y) => x === 0 || y === 0 },
  };

  if (simple[code]) {
    const { market, label, test } = simple[code];
    return { market, code, label, probability: sumMatrix(matrix, test), push: 0 };
  }

  const total = /^(OVER|UNDER)_(-?\d+(?:\.\d+)?)$/.exec(code);
  if (total) {
    const line = Number(total[2]);
    const over = total[1] === 'OVER';
    // Las líneas cuarto (2.25) se dividen en dos mitades: 2.0 y 2.5.
    if (Math.abs(line * 4 - Math.round(line * 4)) < 1e-9 && Math.abs(line * 2 - Math.round(line * 2)) > 1e-9) {
      const a = probabilityForCode(matrix, `${total[1]}_${line - 0.25}`, teams);
      const b = probabilityForCode(matrix, `${total[1]}_${line + 0.25}`, teams);
      return {
        market: 'ou',
        code,
        label: `${over ? 'Más' : 'Menos'} de ${line} goles`,
        probability: (a.probability + b.probability) / 2,
        push: (a.push + b.push) / 2,
        line,
      };
    }
    const push = sumMatrix(matrix, (x, y) => x + y === line);
    const win = sumMatrix(matrix, (x, y) => (over ? x + y > line : x + y < line));
    const lose = 1 - win - push;
    return {
      market: 'ou',
      code,
      label: `${over ? 'Más' : 'Menos'} de ${line} goles`,
      probability: push > 0 ? win / Math.max(win + lose, 1e-9) : win,
      rawWin: win,
      push,
      lose,
      line,
    };
  }

  const ah = /^AH_(HOME|AWAY)_(-?\d+(?:\.\d+)?)$/.exec(code);
  if (ah) {
    const side = ah[1].toLowerCase();
    const line = Number(ah[2]);
    const team = side === 'home' ? teams.home : teams.away;
    if (Math.abs(line * 4 - Math.round(line * 4)) < 1e-9 && Math.abs(line * 2 - Math.round(line * 2)) > 1e-9) {
      const a = probabilityForCode(matrix, `AH_${ah[1]}_${line - 0.25}`, teams);
      const b = probabilityForCode(matrix, `AH_${ah[1]}_${line + 0.25}`, teams);
      return {
        market: 'ah',
        code,
        label: `${team} ${line > 0 ? '+' : ''}${line}`,
        probability: (a.probability + b.probability) / 2,
        push: (a.push + b.push) / 2,
        line,
        side,
      };
    }
    const { win, push, lose } = handicapProbabilities(matrix, line, side);
    return {
      market: 'ah',
      code,
      label: `${team} ${line > 0 ? '+' : ''}${line}`,
      probability: push > 0 ? win / Math.max(win + lose, 1e-9) : win,
      rawWin: win,
      push,
      lose,
      line,
      side,
    };
  }

  return null;
}
