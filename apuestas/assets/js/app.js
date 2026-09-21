/* =========================================================================
   Valor Diario — capa de presentación
   Lee los JSON que genera engine/run.js y pinta las vistas.
   Sin dependencias externas: se publica tal cual en cualquier hosting estático.
   ========================================================================= */

const DATA = {
  latest: 'data/latest.json',
  history: 'data/history.json',
  backtest: 'data/backtest.json',
};

const state = {
  report: null,
  history: null,
  backtest: null,
  view: 'hoy',
  group: 'todas',
  leagues: new Set(),
  market: 'todos',
  minConfidence: 0,
  historyFilter: 'todos',
  historyLimit: 40,
  segment: 'byLeague',
};

/* ----------------------------- utilidades ----------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const pct = (n, digits = 1) =>
  n === null || n === undefined || Number.isNaN(n) ? '—' : `${(n * 100).toFixed(digits)}%`;

const signedPct = (n, digits = 1) =>
  n === null || n === undefined ? '—' : `${n > 0 ? '+' : ''}${(n * 100).toFixed(digits)}%`;

const num = (n, digits = 2) =>
  n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toFixed(digits);

const units = (n) => `${n > 0 ? '+' : ''}${Number(n).toFixed(2)} u`;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function timeOf(iso) {
  const date = new Date(iso);
  return date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

function dateLabel(iso) {
  return new Date(iso).toLocaleDateString('es', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

function confidenceLevel(score) {
  if (score >= 72) return 'alta';
  if (score >= 55) return 'media';
  return 'baja';
}

const MARKET_NAMES = {
  '1x2': '1X2',
  dc: 'Doble oportunidad',
  ou: 'Más/Menos',
  btts: 'Ambos anotan',
  ah: 'Hándicap',
};

/* ------------------------------- carga -------------------------------- */

async function loadJson(path) {
  const res = await fetch(`${path}?v=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`No se pudo cargar ${path} (${res.status})`);
  return res.json();
}

async function boot() {
  restoreTheme();
  wireChrome();
  try {
    const [report, history, backtest] = await Promise.all([
      loadJson(DATA.latest),
      loadJson(DATA.history).catch(() => null),
      loadJson(DATA.backtest).catch(() => null),
    ]);
    state.report = report;
    state.history = history;
    state.backtest = backtest;
    renderAll();
  } catch (error) {
    $('#update-line').textContent = 'No se pudieron cargar los datos';
    $('#top-picks').append(
      el('p', {
        class: 'empty',
        text: `${error.message}. Ejecuta "node engine/run.js" para generar los datos.`,
      }),
    );
  }
}

/* ------------------------------- chrome ------------------------------- */

function restoreTheme() {
  const saved = localStorage.getItem('vd-theme');
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.dataset.theme = saved;
  }
}

function wireChrome() {
  $('#theme-toggle').addEventListener('click', () => {
    // El oscuro es el tema por defecto de la hoja de estilos, no el del
    // sistema: deducirlo de prefers-color-scheme haría que el primer clic no
    // cambiara nada en un equipo configurado en claro.
    const current = document.documentElement.dataset.theme || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('vd-theme', next);
    renderCharts();
  });

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setView(tab.dataset.view));
  });

  $('#market-filter').addEventListener('change', (e) => {
    state.market = e.target.value;
    renderDay();
  });
  $('#confidence-filter').addEventListener('change', (e) => {
    state.minConfidence = Number(e.target.value);
    renderDay();
  });

  document.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-table-toggle]');
    if (!toggle) return;
    const target = document.getElementById(toggle.dataset.tableToggle);
    if (!target) return;
    target.hidden = !target.hidden;
    toggle.textContent = target.hidden ? 'Ver datos en tabla' : 'Ocultar tabla';
  });

  addEventListener('resize', debounce(renderCharts, 200));
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function setView(view) {
  state.view = view;
  $$('.tab').forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.view === view)));
  const dayViews = ['hoy', 'manana'];
  $('#view-dia').hidden = !dayViews.includes(view);
  $('#view-combinadas').hidden = view !== 'combinadas';
  $('#view-historial').hidden = view !== 'historial';
  $('#view-modelo').hidden = view !== 'modelo';
  scrollTo({ top: 0, behavior: 'smooth' });
  if (dayViews.includes(view)) renderDay();
  if (view === 'historial') renderHistory();
  if (view === 'modelo') renderModel();
}

/* ------------------------------ render -------------------------------- */

function renderAll() {
  const report = state.report;
  const updated = new Date(report.generatedAt);
  $('#update-line').textContent = `Actualizado ${updated.toLocaleString('es', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })} · ${report.matches.length} partidos`;

  if (report.demo) {
    $('#demo-banner').hidden = false;
  }
  $('#sources-line').textContent = `Fuentes: ${(report.dataSources ?? []).join(' · ')}. ${
    report.disclaimer ?? ''
  }`;

  renderFilters();
  renderDay();
  renderParlays();
  renderHistory();
  renderModel();
}

function currentDayKey() {
  return state.view === 'manana' ? state.report.days.tomorrow : state.report.days.today;
}

function visibleMatches() {
  const day = currentDayKey();
  return state.report.matches.filter((match) => {
    if (match.day !== day) return false;
    if (state.group !== 'todas' && match.leagueGroup !== state.group) return false;
    if (state.leagues.size && !state.leagues.has(match.leagueId)) return false;
    return true;
  });
}

function pickPasses(pick) {
  if (state.market !== 'todos' && pick.market !== state.market) return false;
  if (pick.confidence < state.minConfidence) return false;
  return true;
}

function renderFilters() {
  const groups = state.report.groups ?? [];
  const groupBox = $('#group-filters');
  groupBox.replaceChildren(
    ...groups.map((group) =>
      el('button', {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(state.group === group.id),
        onclick: () => {
          state.group = group.id;
          state.leagues.clear();
          renderFilters();
          renderDay();
        },
        text: group.name,
      }),
    ),
  );

  const leagues = state.report.leagues.filter(
    (league) => state.group === 'todas' || league.group === state.group,
  );
  const leagueBox = $('#league-filters');
  leagueBox.replaceChildren(
    ...leagues.map((league) =>
      el(
        'button',
        {
          class: 'chip',
          type: 'button',
          'aria-pressed': String(state.leagues.has(league.id)),
          onclick: () => {
            if (state.leagues.has(league.id)) state.leagues.delete(league.id);
            else state.leagues.add(league.id);
            renderFilters();
            renderDay();
          },
        },
        [league.name, el('span', { class: 'chip-count', text: league.matches })],
      ),
    ),
  );
}

function renderDay() {
  if (!state.report) return;
  const day = currentDayKey();
  const matches = visibleMatches();
  const picks = matches.flatMap((match) => match.picks.filter(pickPasses));

  $('#day-title').textContent =
    state.view === 'manana' ? 'Apuestas de mañana' : 'Apuestas de hoy';
  $('#day-summary').textContent = `${dateLabel(day)} · ${matches.length} partidos · ${
    picks.length
  } selecciones con valor`;

  const ranked = [...picks].sort((a, b) => b.score - a.score || b.probability - a.probability);
  const top = ranked.length
    ? ranked.slice(0, 12)
    : (state.report.topPicks ?? []).filter((p) => p.day === day && pickPasses(p));

  const list = $('#top-picks');
  if (!top.length) {
    list.replaceChildren(
      el('p', {
        class: 'empty',
        text: 'Ninguna selección supera el umbral de valor con estos filtros. No apostar también es una decisión.',
      }),
    );
  } else {
    list.replaceChildren(...top.map((pick, i) => pickCard(pick, i + 1)));
  }

  const withOdds = matches.filter((m) => m.hasOdds).length;
  $('#matches-note').textContent = `${withOdds} de ${matches.length} partidos tienen cuotas disponibles. Toca un partido para ver todos los mercados.`;
  renderMatchGroups(matches);
}

function pickCard(pick, rank) {
  const level = confidenceLevel(pick.confidence);
  return el('article', { class: 'pick' }, [
    el('div', { class: 'pick-top' }, [
      el('span', { class: 'rank', text: `#${rank}` }),
      el('div', { class: 'pick-head' }, [
        el('div', { class: 'pick-league', text: pick.league }),
        el('div', { class: 'pick-match', text: `${pick.homeTeam} vs ${pick.awayTeam}` }),
        el('div', { class: 'pick-time', text: `${timeOf(pick.kickoff)} · ${dateLabel(pick.day)}` }),
      ]),
    ]),
    el('div', { class: 'pick-bet' }, [
      el('div', {}, [
        el('div', { class: 'pick-market', text: MARKET_NAMES[pick.market] ?? pick.market }),
        el('div', { class: 'pick-label', text: pick.label }),
      ]),
      el('div', {}, [
        el('div', { class: 'pick-odds', text: num(pick.odds) }),
        el('div', {
          class: 'pick-book',
          text: pick.derived ? 'cuota derivada' : pick.bookmaker ?? '',
        }),
      ]),
    ]),
    el('div', { class: 'metrics' }, [
      metric('Probabilidad', pct(pick.probability, 0)),
      metric('Valor esperado', signedPct(pick.expectedValue), pick.expectedValue > 0 ? 'pos' : 'neg'),
      metric('Stake', `${num(pick.stake, 2)} u`),
    ]),
    el('div', { class: 'confidence' }, [
      el('div', { class: 'confidence-row' }, [
        el('span', { text: `Confianza ${level}` }),
        el('span', { text: `${pick.confidence}/100 · mercado ${pct(pick.fairProbability, 0)}` }),
      ]),
      el('div', { class: 'meter', 'data-level': level, role: 'img', 'aria-label': `Confianza ${pick.confidence} sobre 100` }, [
        el('span', { style: `width:${pick.confidence}%` }),
      ]),
    ]),
    pick.summary ? el('p', { class: 'summary-line', text: pick.summary }) : null,
    pick.reasoning
      ? el('details', { class: 'reasons' }, [
          el('summary', { text: 'Por qué esta apuesta' }),
          el('ul', {}, pick.reasoning.map((reason) => el('li', { text: reason }))),
        ])
      : null,
  ]);
}

function metric(label, value, tone) {
  return el('div', { class: 'metric' }, [
    el('div', { class: 'metric-label', text: label }),
    el('div', { class: `metric-value${tone ? ` ${tone}` : ''}`, text: value }),
  ]);
}

function renderMatchGroups(matches) {
  const container = $('#match-groups');
  if (!matches.length) {
    container.replaceChildren(
      el('p', { class: 'empty', text: 'No hay partidos programados con estos filtros.' }),
    );
    return;
  }

  const byLeague = new Map();
  for (const match of matches) {
    if (!byLeague.has(match.leagueId)) byLeague.set(match.leagueId, []);
    byLeague.get(match.leagueId).push(match);
  }

  container.replaceChildren(
    ...[...byLeague.entries()].map(([, list]) => {
      const sorted = [...list].sort((a, b) => a.kickoff.localeCompare(b.kickoff));
      return el('section', { class: 'league-group' }, [
        el('div', { class: 'league-head' }, [
          el('h4', { text: sorted[0].league }),
          el('span', { class: 'muted', text: `${sorted.length} partidos` }),
        ]),
        el('div', { class: 'match-list' }, sorted.map(matchCard)),
      ]);
    }),
  );
}

function matchCard(match) {
  const p = match.probabilities;
  const details = el('details', { class: 'match' }, [
    el('summary', { class: 'match-summary' }, [
      el('div', { class: 'match-teams' }, [
        el('div', { class: 'team-names', text: `${match.home} vs ${match.away}` }),
        el('div', { class: 'match-meta' }, [
          el('div', { text: timeOf(match.kickoff) }),
          el('div', { text: match.picks.length ? `${match.picks.length} pick` : 'sin valor' }),
        ]),
      ]),
      probabilityBar(p, match),
      el('div', { class: 'prob-legend' }, [
        legendItem('home', `${match.home} ${pct(p.home, 0)}`),
        legendItem('draw', `Empate ${pct(p.draw, 0)}`),
        legendItem('away', `${match.away} ${pct(p.away, 0)}`),
      ]),
    ]),
    el('div', { class: 'match-extra' }, [
      el('dl', { class: 'facts' }, [
        fact('Goles esperados', `${num(match.lambdas.home, 1)} - ${num(match.lambdas.away, 1)}`),
        fact('Total esperado', num(match.expectedGoals, 2)),
        fact('Marcador más probable', match.topScorelines?.[0]?.score ?? '—'),
        fact('Casas comparadas', match.bookmakers || '—'),
        fact(
          'Forma (pts/partido)',
          `${num(match.form.home.form, 2)} vs ${num(match.form.away.form, 2)}`,
        ),
        fact(
          'xG reciente',
          `${num(match.form.home.xgFor, 1)}/${num(match.form.home.xgAgainst, 1)} — ${num(
            match.form.away.xgFor,
            1,
          )}/${num(match.form.away.xgAgainst, 1)}`,
        ),
        fact('Descanso', `${match.form.home.restDays}d vs ${match.form.away.restDays}d`),
        fact('Peso del mercado', pct(match.marketWeight ?? 0, 0)),
      ]),
      match.injuries ? injuriesBlock(match) : null,
      marketsTable(match),
    ]),
  ]);
  return details;
}

function legendItem(cls, text) {
  return el('span', {}, [el('i', { class: `swatch ${cls}` }), text]);
}

function fact(label, value) {
  return el('div', { class: 'fact' }, [
    el('dt', { text: label }),
    el('dd', { text: String(value) }),
  ]);
}

function probabilityBar(p, match) {
  const seg = (cls, value, label) =>
    el('div', {
      class: `prob-seg ${cls}`,
      style: `flex:${Math.max(value, 0.05)}`,
      title: `${label}: ${pct(value, 1)}`,
      text: value >= 0.12 ? pct(value, 0) : '',
    });
  return el('div', { class: 'prob-bar', role: 'img', 'aria-label': `Probabilidades: ${match.home} ${pct(p.home, 0)}, empate ${pct(p.draw, 0)}, ${match.away} ${pct(p.away, 0)}` }, [
    seg('home', p.home, match.home),
    seg('draw', p.draw, 'Empate'),
    seg('away', p.away, match.away),
  ]);
}

function injuriesBlock(match) {
  const rows = [];
  if (match.injuries.home?.length) rows.push(`${match.home}: ${match.injuries.home.join(', ')}`);
  if (match.injuries.away?.length) rows.push(`${match.away}: ${match.injuries.away.join(', ')}`);
  if (!rows.length) return null;
  return el('div', {}, [
    el('div', { class: 'metric-label', text: 'Bajas reportadas' }),
    ...rows.map((row) => el('p', { class: 'muted', text: row })),
  ]);
}

function marketsTable(match) {
  const pickCodes = new Set(match.picks.map((p) => p.code));
  const rows = match.markets.filter(
    (row) => state.market === 'todos' || row.market === state.market,
  );
  return el('div', { class: 'table-wrap' }, [
    el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Mercado' }),
          el('th', { text: 'Prob.' }),
          el('th', { text: 'Cuota' }),
          el('th', { text: 'Valor' }),
        ]),
      ]),
      el(
        'tbody',
        {},
        rows.map((row) =>
          el('tr', { class: pickCodes.has(row.code) ? 'is-pick' : null }, [
            el('td', { text: row.label }),
            el('td', { text: pct(row.probability, 1) }),
            el('td', { text: row.odds ? num(row.odds) : '—' }),
            el('td', {
              class: row.expectedValue === null ? null : row.expectedValue > 0 ? 'pos' : 'neg',
              text: row.expectedValue === null ? '—' : signedPct(row.expectedValue),
            }),
          ]),
        ),
      ),
    ]),
  ]);
}

/* ----------------------------- combinadas ----------------------------- */

function renderParlays() {
  const container = $('#parlays');
  const parlays = state.report.parlays ?? [];
  container.replaceChildren(
    ...parlays.map((parlay) => {
      if (!parlay.available) {
        return el('article', { class: 'parlay' }, [
          el('div', { class: 'parlay-head' }, [
            el('div', {}, [
              el('div', { class: 'parlay-name', text: parlay.name }),
              el('div', { class: 'parlay-target', text: `Objetivo de cuota ${parlay.targetOdds}` }),
            ]),
          ]),
          el('p', { class: 'muted', text: parlay.reason }),
        ]);
      }
      return el('article', { class: 'parlay' }, [
        el('div', { class: 'parlay-head' }, [
          el('div', {}, [
            el('div', { class: 'parlay-name', text: parlay.name }),
            el('div', { class: 'parlay-target', text: `Objetivo de cuota ${parlay.targetOdds} · ${parlay.legs.length} partidos` }),
          ]),
          el('div', {}, [
            el('div', { class: 'parlay-odds', text: num(parlay.odds) }),
            el('div', { class: 'parlay-target', text: 'cuota total' }),
          ]),
        ]),
        el('div', { class: 'metrics' }, [
          metric('Prob. combinada', pct(parlay.probability, 1)),
          metric('Cuota justa', num(parlay.fairOdds)),
          metric('VE estimado', signedPct(parlay.expectedValue), parlay.expectedValue > 0 ? 'pos' : 'neg'),
        ]),
        el('div', { class: 'legs' }, parlay.legs.map(legRow)),
        el('p', { class: 'note', text: parlay.correlationNote }),
      ]);
    }),
  );

  $('#parlay-note').textContent =
    'Los tres niveles son alternativas entre sí, no para jugarlas a la vez. La probabilidad de acertar cae rápido con cada partido añadido: una combinada de cuota 10 acierta, como mucho, una de cada cuatro o cinco veces. La "cuota justa" es 1 dividido por la probabilidad del modelo: si la cuota del boletín la supera, hay valor. El VE estimado multiplica el error del modelo en cada selección, así que tómalo como orientación, no como una promesa: la referencia realista es el ROI medido en la pestaña Modelo.';
}

function legRow(leg) {
  return el('div', { class: 'leg' }, [
    el('div', { class: 'leg-match', text: leg.match }),
    el('div', { class: 'leg-bet' }, [
      el('span', { text: `${leg.label} · ${MARKET_NAMES[leg.market] ?? leg.market}` }),
      el('span', { text: `${num(leg.odds)} · ${pct(leg.probability, 0)}` }),
    ]),
    el('div', { class: 'leg-why', text: `${leg.league} · ${timeOf(leg.kickoff)}` }),
  ]);
}

/* ------------------------------ historial ----------------------------- */

function renderHistory() {
  const history = state.history;
  const kpis = $('#history-kpis');
  if (!history || !history.summary.bets) {
    kpis.replaceChildren(
      el('p', {
        class: 'empty',
        text: 'Todavía no hay pronósticos liquidados. El historial se llena solo: cada actualización liquida los pronósticos del día anterior contra los resultados reales.',
      }),
    );
    $('#history-list').replaceChildren();
    return;
  }

  const s = history.summary;
  kpis.replaceChildren(
    kpi('Pronósticos', String(s.bets), `${s.wins} acertados · ${s.losses} fallados`),
    kpi('Acierto', pct(s.hitRate, 1), `cuota media ${num(s.averageOdds)}`),
    kpi('ROI', signedPct(s.roi, 2), `${s.staked} unidades arriesgadas`, s.roi >= 0 ? 'pos' : 'neg'),
    kpi('Beneficio', units(s.profit), 'a 1 unidad por apuesta', s.profit >= 0 ? 'pos' : 'neg'),
  );

  const total = history.totalEntries ?? history.entries.length;
  const shownNote =
    total > history.entries.length
      ? ` Se listan los ${history.entries.length} más recientes de ${total}; las métricas de arriba usan los ${total}.`
      : '';
  $('#history-note').textContent =
    (history.demo
      ? 'En modo demostración el historial procede del backtesting simulado, marcado como tal.'
      : 'Cada línea es un pronóstico publicado y liquidado contra el resultado real.') + shownNote;

  renderSegmentTabs();
  renderHistoryFilters();
  renderHistoryList();
  renderCharts();
}

function kpi(label, value, note, tone) {
  return el('div', { class: 'kpi' }, [
    el('div', { class: 'kpi-label', text: label }),
    el('div', { class: `kpi-value${tone ? ` ${tone}` : ''}`, text: value }),
    note ? el('div', { class: 'kpi-note', text: note }) : null,
  ]);
}

const SEGMENTS = [
  { id: 'byLeague', name: 'Por liga' },
  { id: 'byMarket', name: 'Por mercado' },
  { id: 'byConfidence', name: 'Por confianza' },
];

function renderSegmentTabs() {
  $('#segment-tabs').replaceChildren(
    ...SEGMENTS.map((segment) =>
      el('button', {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(state.segment === segment.id),
        text: segment.name,
        onclick: () => {
          state.segment = segment.id;
          renderSegmentTabs();
          renderSegmentTable();
        },
      }),
    ),
  );
  renderSegmentTable();
}

function renderSegmentTable() {
  const rows = state.history.summary[state.segment] ?? [];
  $('#segment-table').replaceChildren(
    el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: SEGMENTS.find((s) => s.id === state.segment).name }),
          el('th', { text: 'Apuestas' }),
          el('th', { text: 'Acierto' }),
          el('th', { text: 'ROI' }),
          el('th', { class: 'col-optional', text: 'Beneficio' }),
        ]),
      ]),
      el(
        'tbody',
        {},
        rows.slice(0, 20).map((row) =>
          el('tr', {}, [
            el('td', { text: MARKET_NAMES[row.key] ?? row.key }),
            el('td', { text: row.bets }),
            el('td', { text: pct(row.hitRate, 0) }),
            el('td', { class: row.roi >= 0 ? 'pos' : 'neg', text: signedPct(row.roi, 1) }),
            el('td', {
              class: `col-optional ${row.profit >= 0 ? 'pos' : 'neg'}`,
              text: units(row.profit),
            }),
          ]),
        ),
      ),
    ]),
  );
}

const HISTORY_FILTERS = [
  { id: 'todos', name: 'Todos' },
  { id: 'win', name: 'Acertados' },
  { id: 'loss', name: 'Fallados' },
];

function renderHistoryFilters() {
  $('#history-filters').replaceChildren(
    ...HISTORY_FILTERS.map((filter) =>
      el('button', {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(state.historyFilter === filter.id),
        text: filter.name,
        onclick: () => {
          state.historyFilter = filter.id;
          state.historyLimit = 40;
          renderHistoryFilters();
          renderHistoryList();
        },
      }),
    ),
  );
}

function renderHistoryList() {
  const entries = (state.history.entries ?? []).filter((entry) => {
    if (state.historyFilter === 'win') return entry.result === 'win' || entry.result === 'half-win';
    if (state.historyFilter === 'loss') return entry.result === 'loss' || entry.result === 'half-loss';
    return true;
  });

  const shown = entries.slice(0, state.historyLimit);
  $('#history-list').replaceChildren(
    ...(shown.length
      ? shown.map(historyEntry)
      : [el('p', { class: 'empty', text: 'Sin registros con este filtro.' })]),
  );

  const more = $('#history-more');
  more.hidden = entries.length <= state.historyLimit;
  more.onclick = () => {
    state.historyLimit += 40;
    renderHistoryList();
  };
}

const RESULT_LABEL = {
  win: 'Acierto',
  loss: 'Fallo',
  push: 'Nulo',
  'half-win': 'Medio acierto',
  'half-loss': 'Media pérdida',
};

function historyEntry(entry) {
  return el('div', { class: 'entry', 'data-result': entry.result }, [
    el('div', { class: 'entry-body' }, [
      el('div', { class: 'entry-match', text: entry.match }),
      el('div', {
        class: 'entry-sub',
        text: [
          entry.date,
          entry.league,
          entry.label,
          `@${num(entry.odds)}`,
          entry.score ? `final ${entry.score}` : null,
          entry.simulated ? 'simulado' : null,
        ]
          .filter(Boolean)
          .join(' · '),
      }),
    ]),
    el('div', { class: 'entry-result' }, [
      el('div', {
        class: `entry-profit ${entry.profit >= 0 ? 'pos' : 'neg'}`,
        text: units(entry.profit),
      }),
      el('div', { class: 'entry-icon muted', text: RESULT_LABEL[entry.result] ?? entry.result }),
    ]),
  ]);
}

/* -------------------------------- modelo ------------------------------ */

function renderModel() {
  const report = state.report;
  const backtest = state.backtest;
  const kpis = $('#backtest-kpis');

  if (!backtest || backtest.insufficientData) {
    kpis.replaceChildren(
      el('p', { class: 'empty', text: 'Sin backtesting disponible: hace falta más historial.' }),
    );
  } else {
    kpis.replaceChildren(
      kpi('Acierto 1X2', pct(backtest.accuracy, 1), `${backtest.matchesEvaluated} partidos evaluados`),
      kpi('Brier score', num(backtest.brierScore, 4), 'menor es mejor (0 = perfecto)'),
      kpi(
        'ROI backtesting',
        signedPct(backtest.betting.roi, 2),
        `${backtest.betting.bets} apuestas simuladas`,
        backtest.betting.roi >= 0 ? 'pos' : 'neg',
      ),
      kpi('Error de calibración', pct(backtest.calibrationError, 2), 'desvío medio entre predicho y real'),
    );
  }

  const weights = report.model.weights ?? {};
  $('#model-weights').replaceChildren(
    ...[
      ['Dixon-Coles', weights.dixonColes],
      ['Elo', weights.elo],
      ['Machine learning', weights.ml],
    ].map(([name, value]) => weightRow(name, value ?? 0, 1)),
  );

  const importance = report.model.featureImportance ?? [];
  const maxWeight = Math.max(...importance.map((f) => f.weight), 0.001);
  $('#feature-importance').replaceChildren(
    ...importance.map((feature) => weightRow(featureName(feature.feature), feature.weight, maxWeight)),
  );

  $('#model-meta').textContent = [
    `Entrenado con ${report.model.matchesUsed} partidos`,
    `${report.model.refits} reajustes walk-forward`,
    `temperatura de calibración ${num(report.model.calibration?.temperature, 2)}`,
    `ventaja de localía ${num(Math.exp(report.model.dixonColes?.homeAdvantage ?? 0), 2)}x`,
    `rho ${num(report.model.dixonColes?.rho, 3)}`,
    backtest?.simulatedMarket ? 'mercado simulado (demo)' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  renderCharts();
}

const FEATURE_LABELS = {
  elo_diff: 'Diferencia de Elo',
  attack_diff: 'Diferencia de ataque',
  defence_diff: 'Diferencia de defensa',
  form_home: 'Forma del local',
  form_away: 'Forma del visitante',
  xg_diff_home: 'xG neto del local',
  xg_diff_away: 'xG neto del visitante',
  goal_diff_home: 'Diferencia de goles (local)',
  goal_diff_away: 'Diferencia de goles (visitante)',
  rest_diff: 'Días de descanso',
  congestion_diff: 'Congestión de calendario',
  injury_diff: 'Impacto de bajas',
  h2h_score: 'Historial directo',
  home_field: 'Jugar en casa',
};

const featureName = (key) => FEATURE_LABELS[key] ?? key;

function weightRow(name, value, max) {
  return el('div', {}, [
    el('div', { class: 'weight-name', text: name }),
    el('div', { class: 'weight-row' }, [
      el('div', { class: 'weight-bar' }, [
        el('span', { style: `width:${Math.max(2, (value / max) * 100)}%` }),
      ]),
      el('div', { class: 'weight-value', text: max === 1 ? pct(value, 0) : num(value, 2) }),
    ]),
  ]);
}

/* -------------------------------- charts ------------------------------ */

function renderCharts() {
  if (state.history?.summary?.daily?.length) {
    drawBankroll(state.history.summary.daily);
  }
  if (state.backtest && !state.backtest.insufficientData) {
    drawReliability(state.backtest.reliability ?? []);
    drawMonthly(state.backtest.betting?.monthly ?? []);
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

function chartFrame(container, { height = 190, padding = { top: 12, right: 12, bottom: 24, left: 38 } } = {}) {
  container.replaceChildren();
  const width = Math.max(container.clientWidth || 320, 260);
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    preserveAspectRatio: 'none',
  });
  svg.style.height = `${height}px`;
  container.append(svg);
  return {
    svg,
    width,
    height,
    padding,
    innerWidth: width - padding.left - padding.right,
    innerHeight: height - padding.top - padding.bottom,
  };
}

function tooltipFor(container) {
  const tip = el('div', { class: 'chart-tooltip' });
  container.append(tip);
  return {
    show(x, y, html) {
      tip.innerHTML = html;
      tip.dataset.show = '1';
      const maxX = container.clientWidth - tip.offsetWidth - 4;
      tip.style.left = `${Math.max(4, Math.min(x - tip.offsetWidth / 2, maxX))}px`;
      tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
    },
    hide() {
      tip.dataset.show = '0';
    },
  };
}

function drawBankroll(daily) {
  const container = $('#bankroll-chart');
  if (!container) return;
  const frame = chartFrame(container, { height: 200 });
  const { svg, padding, innerWidth, innerHeight } = frame;
  svg.setAttribute(
    'aria-label',
    `Bankroll acumulado en ${daily.length} jornadas, desde ${daily[0].date} hasta ${daily[daily.length - 1].date}`,
  );

  const values = daily.map((d) => d.cumulative);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const x = (i) => padding.left + (daily.length === 1 ? innerWidth / 2 : (i / (daily.length - 1)) * innerWidth);
  const y = (v) => padding.top + innerHeight - ((v - min) / span) * innerHeight;

  for (const tick of ticks(min, max, 4)) {
    svg.append(svgEl('line', { class: 'grid-line', x1: padding.left, x2: padding.left + innerWidth, y1: y(tick), y2: y(tick) }));
    const label = svgEl('text', { class: 'axis-label', x: padding.left - 6, y: y(tick) + 3, 'text-anchor': 'end' });
    label.textContent = tick.toFixed(0);
    svg.append(label);
  }
  svg.append(svgEl('line', { class: 'ref-line', x1: padding.left, x2: padding.left + innerWidth, y1: y(0), y2: y(0) }));

  const path = daily.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.cumulative).toFixed(1)}`).join(' ');
  const area = `${path} L${x(daily.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  svg.append(svgEl('path', { d: area, fill: 'var(--series-1)', opacity: 0.14 }));
  svg.append(svgEl('path', { class: 'series-line', d: path, stroke: 'var(--series-1)' }));

  const last = daily[daily.length - 1];
  svg.append(svgEl('circle', { cx: x(daily.length - 1), cy: y(last.cumulative), r: 4, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2 }));

  const firstLabel = svgEl('text', { class: 'axis-label', x: padding.left, y: frame.height - 6 });
  firstLabel.textContent = daily[0].date.slice(5);
  const lastLabel = svgEl('text', { class: 'axis-label', x: padding.left + innerWidth, y: frame.height - 6, 'text-anchor': 'end' });
  lastLabel.textContent = last.date.slice(5);
  svg.append(firstLabel, lastLabel);

  const tip = tooltipFor(container);
  const cursor = svgEl('line', { class: 'ref-line', y1: padding.top, y2: padding.top + innerHeight, opacity: 0 });
  svg.append(cursor);
  svg.addEventListener('pointermove', (event) => {
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * frame.width;
    const i = Math.max(0, Math.min(daily.length - 1, Math.round(((px - padding.left) / innerWidth) * (daily.length - 1))));
    const point = daily[i];
    cursor.setAttribute('x1', x(i));
    cursor.setAttribute('x2', x(i));
    cursor.setAttribute('opacity', 1);
    const rel = (x(i) / frame.width) * rect.width;
    tip.show(rel, ((y(point.cumulative) / frame.height) * rect.height), `<strong>${point.date}</strong><br>Acumulado ${point.cumulative.toFixed(2)} u<br>Día ${point.profit > 0 ? '+' : ''}${point.profit.toFixed(2)} u`);
  });
  svg.addEventListener('pointerleave', () => {
    cursor.setAttribute('opacity', 0);
    tip.hide();
  });

  renderTable('#bankroll-table', ['Fecha', 'Día (u)', 'Acumulado (u)'], daily.slice(-60).map((d) => [d.date, d.profit.toFixed(2), d.cumulative.toFixed(2)]));
}

function drawReliability(bins) {
  const container = $('#reliability-chart');
  if (!container || !bins.length) return;
  const frame = chartFrame(container, { height: 210, padding: { top: 12, right: 14, bottom: 30, left: 38 } });
  const { svg, padding, innerWidth, innerHeight } = frame;
  svg.setAttribute('aria-label', 'Curva de fiabilidad: probabilidad predicha frente a frecuencia observada');

  const x = (v) => padding.left + v * innerWidth;
  const y = (v) => padding.top + innerHeight - v * innerHeight;

  for (const tick of [0, 0.25, 0.5, 0.75, 1]) {
    svg.append(svgEl('line', { class: 'grid-line', x1: padding.left, x2: padding.left + innerWidth, y1: y(tick), y2: y(tick) }));
    const label = svgEl('text', { class: 'axis-label', x: padding.left - 6, y: y(tick) + 3, 'text-anchor': 'end' });
    label.textContent = `${tick * 100}%`;
    svg.append(label);
    const xLabel = svgEl('text', { class: 'axis-label', x: x(tick), y: frame.height - 14, 'text-anchor': 'middle' });
    xLabel.textContent = `${tick * 100}%`;
    svg.append(xLabel);
  }
  const axisTitle = svgEl('text', { class: 'axis-label', x: padding.left + innerWidth / 2, y: frame.height - 2, 'text-anchor': 'middle' });
  axisTitle.textContent = 'Probabilidad predicha por el modelo';
  svg.append(axisTitle);

  svg.append(svgEl('line', { class: 'ref-line', x1: x(0), y1: y(0), x2: x(1), y2: y(1) }));

  const path = bins.map((b, i) => `${i ? 'L' : 'M'}${x(b.predicted).toFixed(1)},${y(b.observed).toFixed(1)}`).join(' ');
  svg.append(svgEl('path', { class: 'series-line', d: path, stroke: 'var(--series-1)' }));

  const tip = tooltipFor(container);
  for (const bin of bins) {
    const dot = svgEl('circle', {
      cx: x(bin.predicted),
      cy: y(bin.observed),
      r: Math.max(4, Math.min(9, Math.sqrt(bin.count) / 6)),
      fill: 'var(--series-1)',
      stroke: 'var(--surface-1)',
      'stroke-width': 2,
    });
    dot.addEventListener('pointerenter', () => {
      const rect = svg.getBoundingClientRect();
      tip.show(
        (x(bin.predicted) / frame.width) * rect.width,
        (y(bin.observed) / frame.height) * rect.height,
        `Predicho ${(bin.predicted * 100).toFixed(1)}%<br>Observado ${(bin.observed * 100).toFixed(1)}%<br>${bin.count} casos`,
      );
    });
    dot.addEventListener('pointerleave', () => tip.hide());
    svg.append(dot);
  }

  container.prepend(
    el('div', { class: 'chart-legend' }, [
      el('span', {}, [el('i', { class: 'swatch', style: 'background:var(--series-1)' }), 'Frecuencia observada']),
      el('span', {}, [el('i', { class: 'swatch', style: 'background:var(--series-neutral)' }), 'Calibración perfecta']),
    ]),
  );

  renderTable(
    '#reliability-table',
    ['Rango', 'Predicho', 'Observado', 'Casos'],
    bins.map((b) => [`${(b.from * 100).toFixed(0)}–${(b.to * 100).toFixed(0)}%`, pct(b.predicted, 1), pct(b.observed, 1), b.count]),
  );
}

function drawMonthly(monthly) {
  const container = $('#monthly-chart');
  if (!container || !monthly.length) return;
  const data = monthly.slice(-14);
  const frame = chartFrame(container, { height: 190, padding: { top: 12, right: 12, bottom: 30, left: 40 } });
  const { svg, padding, innerWidth, innerHeight } = frame;
  svg.setAttribute('aria-label', `ROI mensual del backtesting en ${data.length} meses`);

  const maxAbs = Math.max(0.05, ...data.map((m) => Math.abs(m.roi)));
  const y = (v) => padding.top + innerHeight / 2 - (v / maxAbs) * (innerHeight / 2);
  const slot = innerWidth / data.length;
  const barWidth = Math.max(6, slot - 6);

  for (const tick of [maxAbs, 0, -maxAbs]) {
    svg.append(svgEl('line', { class: tick === 0 ? 'axis-line' : 'grid-line', x1: padding.left, x2: padding.left + innerWidth, y1: y(tick), y2: y(tick) }));
    const label = svgEl('text', { class: 'axis-label', x: padding.left - 6, y: y(tick) + 3, 'text-anchor': 'end' });
    label.textContent = `${(tick * 100).toFixed(0)}%`;
    svg.append(label);
  }

  const tip = tooltipFor(container);
  data.forEach((month, i) => {
    const cx = padding.left + i * slot + slot / 2;
    const top = month.roi >= 0 ? y(month.roi) : y(0);
    const height = Math.max(2, Math.abs(y(month.roi) - y(0)));
    const bar = svgEl('rect', {
      x: cx - barWidth / 2,
      y: top,
      width: barWidth,
      height,
      rx: 4,
      fill: month.roi >= 0 ? 'var(--series-1)' : 'var(--critical)',
    });
    bar.addEventListener('pointerenter', () => {
      const rect = svg.getBoundingClientRect();
      tip.show((cx / frame.width) * rect.width, (top / frame.height) * rect.height, `<strong>${month.month}</strong><br>ROI ${signedPct(month.roi, 1)}<br>${month.bets} apuestas`);
    });
    bar.addEventListener('pointerleave', () => tip.hide());
    svg.append(bar);

    if (i % Math.ceil(data.length / 6) === 0) {
      const label = svgEl('text', { class: 'axis-label', x: cx, y: frame.height - 8, 'text-anchor': 'middle' });
      label.textContent = month.month.slice(2);
      svg.append(label);
    }
  });

  renderTable('#monthly-table', ['Mes', 'Apuestas', 'ROI', 'Beneficio (u)'], data.map((m) => [m.month, m.bets, signedPct(m.roi, 1), m.profit.toFixed(2)]));
}

function ticks(min, max, count) {
  const step = (max - min) / count || 1;
  return Array.from({ length: count + 1 }, (_, i) => min + i * step);
}

function renderTable(selector, headers, rows) {
  const target = $(selector);
  if (!target) return;
  const wasHidden = target.hidden;
  target.replaceChildren(
    el('table', {}, [
      el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { text: h })))]),
      el('tbody', {}, rows.map((row) => el('tr', {}, row.map((cell) => el('td', { text: String(cell) }))))),
    ]),
  );
  target.hidden = wasHidden;
}

boot();
