import { t } from '../i18n.js';
import { h, announce, download, toCsv, promptText, toast } from './dom.js';
import * as intel from './code-intel.js';
import * as gm from './graph-model.js';
import { createGraphView } from './graph-view.js';
import { chartCard, barChart, lineChart, heatmap, treemap, smallMultiples, emptyChart } from './charts.js';
import { lineDiff } from './diff.js';
import { PASSES } from '../core/registry.js';
import { settings, update } from './settings.js';

// Araç paneli: arama, semboller, AST ağacı, grafikler, tablolar, çizelgeler, notlar ve pass'ler.
// Aynı panel 4'lü görünümde iki kez kurulabilir; her örnek kendi aracını gösterir.

export const TOOLS = ['search', 'symbols', 'ast', 'graph', 'tables', 'charts', 'notes', 'passes'];
const MAX_ROWS = 2000;

// Satır başlangıçları: konum → satır/sütun (ikili arama)
function lineIndex(code) {
  const starts = [0];
  for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) starts.push(i + 1);
  return (off) => {
    let lo = 0; let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: off - starts[lo] + 1 };
  };
}

const SEARCH_MODES = ['text', 'ast', 'api', 'string', 'refs', 'remnants', 'entropy', 'duplicates', 'similar', 'undefined', 'unused', 'long', 'nesting', 'magic'];
const NEEDS_QUERY = new Set(['text', 'ast', 'api', 'string']);

export function createTools(host, app, { initial = 'search', index = 0 } = {}) {
  let current = null;
  const tabs = [];
  const tablist = h('div', { class: 'tabs tool-tabs', role: 'tablist', 'aria-label': t('tools.label') });
  const sourceSel = h('select', { class: 'field small', 'aria-label': t('tools.source') },
    h('option', { value: 'auto' }, t('tools.source.auto')), h('option', { value: 'in' }, t('panel.input')), h('option', { value: 'out' }, t('panel.output')));
  const body = h('div', { class: 'tool-body' });
  for (const name of TOOLS) {
    const tab = h('button', { type: 'button', role: 'tab', id: `tool${index}-${name}`, 'aria-controls': `toolpanel${index}`, 'aria-selected': 'false', tabindex: '-1' }, t(`tool.${name}`));
    tab.addEventListener('click', () => show(name));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = TOOLS.indexOf(name) + (e.key === 'ArrowRight' ? 1 : -1);
      show(TOOLS[(i + TOOLS.length) % TOOLS.length], true);
    });
    tabs.push(tab);
    tablist.append(tab);
  }
  body.id = `toolpanel${index}`;
  body.setAttribute('role', 'tabpanel');
  host.replaceChildren(h('div', { class: 'ph' }, tablist, h('div', { class: 'ph-actions' }, sourceSel)), body);

  const side = () => (sourceSel.value === 'auto' ? (app.text('out').trim() ? 'out' : 'in') : sourceSel.value);
  const ctx = { app, side, sourceSel };
  const instances = {};
  const builders = { search: searchTool, symbols: symbolsTool, ast: astTool, graph: graphTool, tables: tablesTool, charts: chartsTool, notes: notesTool, passes: passesTool };

  function show(name, focus = false) {
    if (!builders[name]) return;
    current = name;
    for (const tab of tabs) {
      const on = tab.id === `tool${index}-${name}`;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    }
    body.setAttribute('aria-labelledby', `tool${index}-${name}`);
    if (!instances[name]) instances[name] = builders[name](ctx);
    body.replaceChildren(instances[name].el);
    instances[name].refresh?.();
  }
  sourceSel.addEventListener('change', () => instances[current]?.refresh?.());
  // belge/çıktı değişince yalnızca görünen araç yenilenir; diğerleri gösterildiğinde yenilenir
  const offs = [
    app.on('doc', () => { if (!host.hidden) instances[current]?.refresh?.(); }),
    app.on('results', () => { if (!host.hidden) instances[current]?.refresh?.(); }),
    app.on('cursor', (s) => instances[current]?.onCursor?.(s)),
    app.on('marks', () => instances.notes?.refresh?.()),
    // düzenleme sırasında yalnızca hafif araçlar yenilenir; grafik/çizelge görünür olunca ya da çözmeden sonra
    app.on('change', () => { if (!host.hidden && ['symbols', 'ast', 'tables'].includes(current)) instances[current]?.refresh?.(); }),
  ];
  show(initial);
  return {
    show,
    get current() { return current; },
    tool: (name) => { if (!instances[name]) instances[name] = builders[name](ctx); return instances[name]; },
    refresh: () => instances[current]?.refresh?.(),
    setSource: (s) => { sourceSel.value = s; },
    destroy() { for (const off of offs) off(); for (const i of Object.values(instances)) i.destroy?.(); },
  };
}

// ── ortak: sonuç listesi (E325) ──
function resultList(ctx, { onPick } = {}) {
  const list = h('ol', { class: 'results', role: 'listbox', tabindex: '0', 'aria-label': t('search.results') });
  let rows = [];
  let cur = -1;
  let srcSide = 'in';
  const pick = (i, focusEditor = false) => {
    if (!rows.length) return;
    cur = (i + rows.length) % rows.length;
    for (const li of list.children) li.setAttribute('aria-selected', String(Number(li.dataset.i) === cur));
    const li = list.querySelector(`[data-i="${cur}"]`);
    li?.scrollIntoView({ block: 'nearest' });
    list.setAttribute('aria-activedescendant', li?.id ?? '');
    const r = rows[cur];
    (onPick ?? ((row) => ctx.app.jump(srcSide, row.start, row.end, { focus: focusEditor })))(r);
    ctx.app.status(t('search.position', { i: cur + 1, n: rows.length }));
  };
  list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); pick(cur + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); pick(cur - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(Math.max(cur, 0), true); }
  });
  return {
    el: list,
    get rows() { return rows; },
    set(newRows, side, code) {
      rows = newRows;
      srcSide = side;
      cur = -1;
      const pos = lineIndex(code ?? '');
      const uid = Math.random().toString(36).slice(2, 7);
      list.replaceChildren(...rows.slice(0, MAX_ROWS).map((r, i) => {
        const p = pos(r.start);
        r.line = p.line;
        r.col = p.col;
        const li = h('li', { id: `r${uid}-${i}`, role: 'option', 'aria-selected': 'false', 'data-i': String(i) },
          h('span', { class: 'res-pos' }, `${p.line}:${p.col}`),
          h('span', { class: 'res-text' }, String(r.text ?? '').replace(/\s+/g, ' ').slice(0, 160)),
          r.note ? h('span', { class: 'res-note' }, String(r.note)) : null);
        li.addEventListener('click', () => pick(i));
        li.addEventListener('dblclick', () => pick(i, true));
        return li;
      }));
      if (rows.length > MAX_ROWS) list.append(h('li', { class: 'rep-muted' }, t('search.truncated', { n: MAX_ROWS, total: rows.length })));
      for (const r of rows.slice(MAX_ROWS)) { const p = pos(r.start); r.line = p.line; r.col = p.col; }
    },
    next: (d) => pick(cur + d),
  };
}

// ── Arama (E311, 124, E312, E314–E330) ──
function searchTool(ctx) {
  const { app } = ctx;
  const mode = h('select', { class: 'field small', 'aria-label': t('search.mode') }, SEARCH_MODES.map((m) => h('option', { value: m }, t(`search.mode.${m}`))));
  const query = h('input', { class: 'field', type: 'search', list: 'search-history', spellcheck: 'false', 'aria-label': t('search.query'), placeholder: t('search.placeholder.text') });
  const history = h('datalist', { id: 'search-history' });
  const opt = (k) => { const c = h('input', { type: 'checkbox' }); return [c, h('label', { class: 'check', title: t(`search.opt.${k}`) }, c, t(`search.opt.${k}.short`))]; };
  const [regex, regexL] = opt('regex');
  const [cs, csL] = opt('case');
  const [word, wordL] = opt('word');
  const scope = h('select', { class: 'field small', 'aria-label': t('search.scope') }, ['all', 'strings', 'calls', 'comments'].map((s) => h('option', { value: s }, t(`search.scope.${s}`))));
  const go = h('button', { type: 'submit', class: 'ghost accent small' }, t('search.run'));
  const saved = h('select', { class: 'field small', 'aria-label': t('search.saved') });
  const count = h('span', { class: 'count', 'aria-live': 'polite' });
  const err = h('p', { class: 'dlg-err', role: 'alert' });
  const results = resultList(ctx);
  const textOpts = h('div', { class: 'row-opts' }, regexL, csL, wordL, scope);
  const form = h('form', { class: 'search-form', onsubmit: (e) => { e.preventDefault(); runSearch(); } },
    h('div', { class: 'row' }, mode, query, history, go), textOpts);
  const bar = h('div', { class: 'row search-bar' }, count, h('span', { class: 'grow' }),
    h('button', { type: 'button', class: 'tiny', onclick: () => results.next(-1), title: t('search.prev'), 'aria-label': t('search.prev') }, '‹'),
    h('button', { type: 'button', class: 'tiny', onclick: () => results.next(1), title: t('search.next'), 'aria-label': t('search.next') }, '›'),
    saved,
    h('button', { type: 'button', class: 'tiny', onclick: saveSearch }, t('search.save')),
    h('button', { type: 'button', class: 'tiny', onclick: () => exportResults('json') }, 'JSON'),
    h('button', { type: 'button', class: 'tiny', onclick: () => exportResults('csv') }, 'CSV'));
  const el = h('div', { class: 'tool tool-search' }, form, err, bar, results.el);
  let lastSide = 'in';

  const syncMode = () => {
    const m = mode.value;
    textOpts.hidden = m !== 'text';
    query.disabled = !NEEDS_QUERY.has(m) && m !== 'refs';
    query.placeholder = t(`search.placeholder.${NEEDS_QUERY.has(m) ? m : 'lens'}`);
  };
  mode.addEventListener('change', () => { syncMode(); if (!NEEDS_QUERY.has(mode.value) && mode.value !== 'refs') runSearch(); });

  function renderSaved() {
    const list = app.searches();
    saved.replaceChildren(h('option', { value: '' }, t('search.saved')), ...list.map((s, i) => h('option', { value: String(i) }, s.name)));
    history.replaceChildren(...app.searchHistory().map((q) => h('option', { value: q })));
  }
  saved.addEventListener('change', () => {
    const s = app.searches()[Number(saved.value)];
    saved.value = '';
    if (!s) return;
    mode.value = SEARCH_MODES.includes(s.mode) ? s.mode : 'text';
    query.value = s.query;
    regex.checked = !!s.opts?.regex; cs.checked = !!s.opts?.caseSensitive; word.checked = !!s.opts?.wholeWord;
    if (['all', 'strings', 'calls', 'comments'].includes(s.opts?.scope)) scope.value = s.opts.scope;
    syncMode();
    runSearch();
  });

  async function saveSearch() {
    if (!query.value && NEEDS_QUERY.has(mode.value)) return;
    const name = await promptText(t('search.save'), { label: t('search.saveName'), value: query.value.slice(0, 40) || t(`search.mode.${mode.value}`), validate: (v) => (v.trim() ? null : t('search.saveName')) });
    if (!name) return;
    app.addSearch({ name: name.trim(), mode: mode.value, query: query.value, opts: { regex: regex.checked, caseSensitive: cs.checked, wholeWord: word.checked, scope: scope.value } });
    renderSaved();
    toast(t('search.saved.ok'), 'ok');
  }

  function exportResults(kind) {
    const rows = results.rows.map((r) => ({ line: r.line, col: r.col, start: r.start, end: r.end, text: r.text ?? '', note: r.note ?? '' }));
    if (!rows.length) return;
    const meta = { mode: mode.value, query: query.value, side: lastSide, doc: app.doc().name };
    if (kind === 'json') download('peel-search.json', JSON.stringify({ ...meta, results: rows }, null, 2), 'application/json');
    else download('peel-search.csv', toCsv(rows, ['line', 'col', 'start', 'end', 'text', 'note']), 'text/csv');
  }

  function runSearch(preset = null) {
    err.textContent = '';
    const s = ctx.side();
    lastSide = s;
    const src = app.source(s);
    const m = mode.value;
    const q = query.value;
    let rows = [];
    try {
      if (preset) rows = preset;
      else if (m === 'text') rows = intel.textSearch(src.code, q, { regex: regex.checked, caseSensitive: cs.checked, wholeWord: word.checked, scope: scope.value, ast: src.ast });
      else if (m === 'long') rows = intel.longLines(src.code);
      else {
        if (!src.ast) throw new Error(t('tools.parseError', { m: src.error ?? '' }));
        const cursor = app.editor(s).cursor;
        rows = {
          ast: () => intel.queryAst(src.ast, q).map((r) => ({ ...r, text: src.code.slice(r.start, Math.min(r.end, r.start + 120)), note: r.type })),
          api: () => intel.apiUsage(src.ast, q),
          string: () => intel.stringUsage(src.ast, q),
          refs: () => { const sym = intel.symbolAt(src.ast, cursor); return sym ? sym.refs.map((r) => ({ ...r, text: src.code.slice(r.start, r.end), note: sym.kind })) : []; },
          remnants: () => intel.remnants(src.ast),
          entropy: () => intel.highEntropy(src.ast),
          duplicates: () => intel.duplicates(src.ast).flatMap((g, gi) => g.members.map((mm) => ({ ...mm, text: src.code.slice(mm.start, mm.start + 100), note: `#${gi + 1} · ${g.members.length}× · ${g.size}` }))),
          similar: () => intel.similarFunctions(src.ast, src.code, cursor >= 0 ? cursor : null),
          undefined: () => intel.undefinedRefs(src.ast),
          unused: () => intel.unusedBindings(src.ast),
          nesting: () => intel.deepNesting(src.ast),
          magic: () => intel.magicNumbers(src.ast),
        }[m]?.() ?? [];
      }
    } catch (e) {
      err.textContent = e.message;
      rows = [];
    }
    if (NEEDS_QUERY.has(m) && q && !preset) { app.pushSearchHistory(q); renderSaved(); }
    results.set(rows, s, src.code);
    count.textContent = t('search.count', { n: rows.length });
    announce(t('search.count', { n: rows.length }));
    app.setLayer(s, 'search', rows.slice(0, 20000).map((r) => ({ from: r.start, to: r.end, cls: 'cm-hit' })));
    app.setLayer(s === 'in' ? 'out' : 'in', 'search', []);
  }

  renderSaved();
  syncMode();
  return {
    el,
    refresh: renderSaved,
    focus: () => query.focus(),
    next: (d) => results.next(d),
    /** Dışarıdan arama: mod ve sorguyla çalıştır (referanslar, string kullanımı) */
    runWith(m, q = '', preset = null) { mode.value = m; query.value = q; syncMode(); runSearch(preset); },
    showRows(label, rows, side) {
      mode.value = 'refs';
      syncMode();
      query.value = label;
      results.set(rows, side, app.text(side));
      count.textContent = t('search.count', { n: rows.length });
      announce(t('search.count', { n: rows.length }));
      app.setLayer(side, 'search', rows.map((r) => ({ from: r.start, to: r.end, cls: 'cm-hit' })));
    },
  };
}

// ── Semboller (E329) ──
function symbolsTool(ctx) {
  const { app } = ctx;
  const filter = h('input', { class: 'field', type: 'search', 'aria-label': t('symbols.filter'), placeholder: t('symbols.filter') });
  const list = h('ul', { class: 'symbols', 'aria-label': t('tool.symbols') });
  const info = h('p', { class: 'rep-muted small' });
  let syms = [];
  let s = 'in';
  const render = () => {
    const q = filter.value.toLowerCase();
    const shown = syms.filter((x) => !q || x.name.toLowerCase().includes(q)).slice(0, MAX_ROWS);
    list.replaceChildren(...shown.map((x) => h('li', { style: `padding-inline-start:${Math.min(8, x.depth) * 12}px` },
      h('button', { type: 'button', class: 'linkish', onclick: () => app.jump(s, x.start, x.end, { focus: true }) },
        h('span', { class: `sym-kind k-${x.kind}` }, t(`symbols.kind.${x.kind}`)), h('span', {}, x.name)))));
    info.textContent = t('symbols.count', { n: syms.length });
  };
  filter.addEventListener('input', render);
  return {
    el: h('div', { class: 'tool' }, filter, info, list),
    refresh() {
      s = ctx.side();
      const src = app.source(s);
      syms = src.ast ? intel.symbols(src.ast) : [];
      if (!src.ast) info.textContent = t('tools.parseError', { m: src.error ?? '' });
      render();
      if (!src.ast) info.textContent = t('tools.parseError', { m: src.error ?? '' });
    },
    focus: () => filter.focus(),
  };
}

// ── AST ağacı (E286), çift yönlü vurgu (E251), düğüm yolu seçici (E313) ──
function astTool(ctx) {
  const { app } = ctx;
  const crumbs = h('nav', { class: 'crumbs', 'aria-label': t('ast.path') });
  const pathInput = h('input', { class: 'field small', type: 'text', spellcheck: 'false', placeholder: 'body.0.expression.callee', 'aria-label': t('ast.pathInput') });
  const follow = h('input', { type: 'checkbox', checked: true });
  const tree = h('ul', { class: 'ast-tree', role: 'tree', 'aria-label': t('tool.ast') });
  const err = h('p', { class: 'dlg-err', role: 'alert' });
  let src = null;
  let s = 'in';
  const itemOf = new WeakMap();

  const label = (key, index, node) => {
    const sum = intel.nodeSummary(node);
    return [h('span', { class: 'ast-key' }, index == null ? key : `${key}[${index}]`), h('span', { class: 'ast-type' }, node.type), sum ? h('span', { class: 'ast-sum' }, sum) : null];
  };
  function makeItem(key, index, node, level) {
    const kids = intel.childrenOf(node);
    const li = h('li', { role: 'treeitem', tabindex: '-1', 'aria-level': String(level), 'aria-selected': 'false' });
    const row = h('div', { class: 'ast-row' }, h('span', { class: 'ast-tw', 'aria-hidden': 'true' }, kids.length ? '▸' : ' '), ...label(key, index, node));
    li.append(row);
    if (kids.length) li.setAttribute('aria-expanded', 'false');
    li._node = node;
    li._level = level;
    itemOf.set(node, li);
    row.addEventListener('click', () => { focusItem(li); selectNode(node); if (kids.length) toggle(li); });
    return li;
  }
  function expand(li, open = true) {
    if (!li.hasAttribute('aria-expanded')) return;
    li.setAttribute('aria-expanded', String(open));
    li.querySelector('.ast-tw').textContent = open ? '▾' : '▸';
    let group = li.querySelector(':scope > ul');
    if (open && !group) {
      group = h('ul', { role: 'group' }, ...intel.childrenOf(li._node).map((c) => makeItem(c.key, c.index, c.node, li._level + 1)));
      li.append(group);
    }
    if (group) group.hidden = !open;
  }
  const toggle = (li) => expand(li, li.getAttribute('aria-expanded') !== 'true');
  const visibleItems = () => [...tree.querySelectorAll('[role="treeitem"]')].filter((x) => !x.closest('ul[hidden]'));
  function focusItem(li) {
    for (const x of tree.querySelectorAll('[tabindex="0"]')) x.tabIndex = -1;
    for (const x of tree.querySelectorAll('[aria-selected="true"]')) x.setAttribute('aria-selected', 'false');
    li.tabIndex = 0;
    li.setAttribute('aria-selected', 'true');
    li.focus({ preventScroll: true });
    li.scrollIntoView({ block: 'nearest' });
  }
  const selectNode = (node) => app.jump(s, node.start, node.end, { flash: true });
  tree.addEventListener('keydown', (e) => {
    const cur = document.activeElement.closest('[role="treeitem"]');
    if (!cur) return;
    const items = visibleItems();
    const i = items.indexOf(cur);
    if (e.key === 'ArrowDown') items[i + 1] && focusItem(items[i + 1]);
    else if (e.key === 'ArrowUp') items[i - 1] && focusItem(items[i - 1]);
    else if (e.key === 'ArrowRight') { if (cur.getAttribute('aria-expanded') === 'false') expand(cur, true); else if (cur.getAttribute('aria-expanded') === 'true') { const c = cur.querySelector('[role="treeitem"]'); if (c) focusItem(c); } }
    else if (e.key === 'ArrowLeft') { if (cur.getAttribute('aria-expanded') === 'true') expand(cur, false); else { const p = cur.parentElement.closest('[role="treeitem"]'); if (p) focusItem(p); } }
    else if (e.key === 'Enter' || e.key === ' ') selectNode(cur._node);
    else if (e.key === 'Home') focusItem(items[0]);
    else if (e.key === 'End') focusItem(items[items.length - 1]);
    else return;
    e.preventDefault();
  });

  // imleçteki düğüme kadar aç ve vurgula (editör → ağaç)
  function reveal(offset) {
    if (!src?.ast) return;
    const chain = intel.nodePath(src.ast, offset);
    renderCrumbs(chain);
    let li = itemOf.get(chain[0].node);
    for (let k = 1; k < chain.length && li; k++) {
      expand(li, true);
      li = itemOf.get(chain[k].node);
    }
    if (li) {
      for (const x of tree.querySelectorAll('[aria-selected="true"]')) x.setAttribute('aria-selected', 'false');
      for (const x of tree.querySelectorAll('[tabindex="0"]')) x.tabIndex = -1;
      li.tabIndex = 0;
      li.setAttribute('aria-selected', 'true');
      li.scrollIntoView({ block: 'nearest' });
    }
  }
  function renderCrumbs(chain) {
    crumbs.replaceChildren(...chain.flatMap((c, i) => [i ? h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›') : null,
      h('button', { type: 'button', class: 'crumb', onclick: () => selectNode(c.node), title: c.index == null ? c.key : `${c.key}[${c.index}]` }, c.node.type)]).filter(Boolean));
    pathInput.value = intel.pathString(chain);
  }
  pathInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !src?.ast) return;
    e.preventDefault();
    const node = intel.resolveNodePath(src.ast, pathInput.value);
    err.textContent = node ? '' : t('ast.pathMissing');
    if (node) { selectNode(node); reveal(node.start); }
  });

  let timer;
  return {
    el: h('div', { class: 'tool tool-ast' }, h('div', { class: 'row' }, pathInput, h('label', { class: 'check' }, follow, t('ast.follow'))), crumbs, err, tree),
    refresh() {
      s = ctx.side();
      src = app.source(s);
      err.textContent = src.ast ? '' : t('tools.parseError', { m: src.error ?? '' });
      tree.replaceChildren();
      if (!src.ast) return;
      const root = makeItem('program', null, src.ast.program, 1);
      tree.append(root);
      root.tabIndex = 0;
      expand(root, true);
      reveal(app.editor(s).cursor);
    },
    onCursor(state) {
      if (!follow.checked || app.activeSide() !== s) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (src?.ast && app.source(s).ast !== src.ast) this.refresh();
        else reveal(state.selection.main.head);
      }, 200);
    },
  };
}

// ── Grafikler (E287–E290, E293, E306–E310) ──
function graphTool(ctx) {
  const { app } = ctx;
  const kind = h('select', { class: 'field small', 'aria-label': t('graph.kind') }, ['call', 'cfg', 'dataflow', 'deps', 'state'].map((k) => h('option', { value: k }, t(`graph.kind.${k}`))));
  const target = h('select', { class: 'field small grow', 'aria-label': t('graph.target') });
  const note = h('p', { class: 'rep-muted small' });
  const host = h('div', { class: 'graph-host' });
  let s = 'in';
  let src = null;
  const viewer = createGraphView(host, {
    name: 'graph',
    onSelect: (n) => {
      if (n.docId) app.switchDoc(n.docId);
      else if (n.start != null) app.jump(s, n.start, n.end ?? n.start, { flash: true });
    },
  });
  let targets = [];
  const build = () => {
    note.textContent = '';
    const k = kind.value;
    target.hidden = !(k === 'cfg' || k === 'state');
    if (k === 'deps') {
      const docs = app.groupDocs().map((d) => {
        const code = d.output || d.input;
        const r = intel.parseSafe(code);
        return { id: d.id, path: d.path || d.name, specifiers: r.ast ? gm.specifiers(r.ast) : [] };
      });
      note.textContent = t('graph.depsNote', { n: docs.length });
      viewer.setGraph(gm.dependencyGraph(docs));
      return;
    }
    if (!src?.ast) { note.textContent = t('tools.parseError', { m: src?.error ?? '' }); viewer.setGraph({ nodes: [], edges: [] }); return; }
    if (k === 'call') viewer.setGraph(gm.callGraph(src.ast, src.code));
    else if (k === 'dataflow') viewer.setGraph(gm.dataFlow(src.ast, src.code));
    else if (k === 'cfg') {
      const tg = targets[Number(target.value)] ?? targets[0];
      viewer.setGraph(tg ? gm.cfg(tg.node) : { nodes: [], edges: [] });
    } else if (k === 'state') {
      const m = targets[Number(target.value)];
      if (!m) note.textContent = t('graph.noState');
      viewer.setGraph(m ? m.graph : { nodes: [], edges: [] });
    }
  };
  const fillTargets = () => {
    const k = kind.value;
    targets = !src?.ast ? [] : k === 'cfg' ? gm.cfgTargets(src.ast, src.code) : k === 'state' ? gm.stateMachines(src.ast, src.code) : [];
    target.replaceChildren(...targets.map((x, i) => h('option', { value: String(i) }, x.label)));
  };
  kind.addEventListener('change', () => { fillTargets(); build(); });
  target.addEventListener('change', build);
  return {
    destroy: () => viewer.destroy(),
    el: h('div', { class: 'tool tool-graph' }, h('div', { class: 'row' }, kind, target), note, host),
    refresh() {
      s = ctx.side();
      src = app.source(s);
      fillTargets();
      // imleç bir fonksiyondaysa CFG onunla açılır
      if (kind.value === 'cfg') {
        const cur = app.editor(s).cursor;
        let best = 0;
        targets.forEach((x, i) => { if (i && x.node.start <= cur && cur <= x.node.end && x.node.start >= targets[best].node.start) best = i; });
        target.value = String(best);
      }
      build();
    },
    show(k) { kind.value = k; fillTargets(); build(); },
  };
}

// ── Tablolar: string (E291/E314), proxy (E292), gölge (E298), katman (E301), karmaşıklık ──
function tablesTool(ctx) {
  const { app } = ctx;
  const kind = h('select', { class: 'field small', 'aria-label': t('tables.kind') }, ['strings', 'proxies', 'shadows', 'layers', 'complexity'].map((k) => h('option', { value: k }, t(`tables.kind.${k}`))));
  const filter = h('input', { class: 'field small grow', type: 'search', placeholder: t('tables.filter'), 'aria-label': t('tables.filter') });
  const info = h('span', { class: 'count' });
  const wrap = h('div', { class: 'table-wrap' });
  let rows = [];
  let cols = [];
  let s = 'in';
  const exportCsv = () => rows.length && download(`peel-${kind.value}.csv`, toCsv(rows.map((r) => Object.fromEntries(cols.map((c) => [c.key, r[c.key]]))), cols.map((c) => c.key)), 'text/csv');
  const render = () => {
    const q = filter.value.toLowerCase();
    const shown = rows.filter((r) => !q || cols.some((c) => String(r[c.key] ?? '').toLowerCase().includes(q)));
    info.textContent = t('tables.count', { n: shown.length, total: rows.length });
    const table = h('table', { class: 'rep-table click-rows' },
      h('thead', {}, h('tr', {}, ...cols.map((c) => h('th', { scope: 'col' }, c.label)))),
      h('tbody', {}, ...shown.slice(0, MAX_ROWS).map((r) => {
        const tr = h('tr', { tabindex: r.go ? '0' : null }, ...cols.map((c) => h('td', { class: c.cls ?? '' }, String(r[c.key] ?? ''))));
        if (r.go) { tr.addEventListener('click', r.go); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') r.go(); }); }
        return tr;
      })));
    wrap.replaceChildren(table);
  };
  const build = () => {
    s = ctx.side();
    const src = app.source(s);
    const k = kind.value;
    const go = (a, b) => () => app.jump(s, a, b, { flash: true });
    if (k === 'layers') {
      const layers = app.layers();
      cols = [{ key: 'n', label: '#', cls: 'num' }, { key: 'id', label: t('tables.col.layer') }, { key: 'size', label: t('tables.col.size'), cls: 'num' }, { key: 'preview', label: t('tables.col.preview'), cls: 'mono' }];
      rows = layers.map((l, i) => ({ n: i, id: l.id, size: l.code.length.toLocaleString(), preview: l.code.slice(0, 120).replace(/\s+/g, ' '), go: () => app.openDoc({ name: `${app.doc().name} · ${l.id}`, input: l.code }) }));
      if (!rows.length) { wrap.replaceChildren(emptyChart('tables.layers.empty')); info.textContent = ''; return; }
      render();
      return;
    }
    if (!src.ast) { rows = []; wrap.replaceChildren(h('p', { class: 'dlg-err' }, t('tools.parseError', { m: src.error ?? '' }))); return; }
    if (k === 'strings') {
      cols = [{ key: 'value', label: t('tables.col.value'), cls: 'mono' }, { key: 'count', label: '#', cls: 'num' }, { key: 'entropy', label: 'H', cls: 'num' }];
      rows = intel.stringTable(src.ast).map((x) => ({ value: x.value.length > 200 ? `${x.value.slice(0, 200)}…` : x.value, count: x.count, entropy: x.entropy.toFixed(2),
        go: () => { const occ = x.occurrences; app.tools().tool('search').showRows(JSON.stringify(x.value).slice(0, 60), occ.map((o) => ({ ...o, text: src.code.slice(o.start, o.end) })), s); app.showTool('search'); } }));
    } else if (k === 'proxies') {
      cols = [{ key: 'owner', label: t('tables.col.owner'), cls: 'mono' }, { key: 'kind', label: t('tables.col.kind') }, { key: 'shape', label: t('tables.col.shape'), cls: 'mono' }, { key: 'refs', label: t('tables.col.refs'), cls: 'num' }];
      rows = intel.proxyMap(src.ast).map((x) => ({ ...x, go: go(x.start, x.end) }));
    } else if (k === 'shadows') {
      cols = [{ key: 'text', label: t('tables.col.name'), cls: 'mono' }, { key: 'note', label: t('tables.col.kind') }, { key: 'where', label: t('tables.col.where'), cls: 'num' }];
      const pos = lineIndex(src.code);
      rows = intel.shadows(src.ast).map((x) => ({ ...x, where: `${pos(x.start).line} → ${pos(x.outer.start).line}`, go: () => { app.jump(s, x.start, x.end, { flash: true }); app.setLayer(s, 'shadow', [{ from: x.start, to: x.end, cls: 'cm-shadow' }, { from: x.outer.start, to: x.outer.end, cls: 'cm-shadow-outer' }]); } }));
    } else if (k === 'complexity') {
      cols = [{ key: 'name', label: t('tables.col.name'), cls: 'mono' }, { key: 'complexity', label: t('tables.col.complexity'), cls: 'num' }, { key: 'size', label: t('tables.col.size'), cls: 'num' }];
      rows = intel.complexity(src.ast, src.code).map((x) => ({ ...x, go: go(x.start, x.end) }));
    }
    render();
  };
  kind.addEventListener('change', build);
  filter.addEventListener('input', render);
  return {
    el: h('div', { class: 'tool' }, h('div', { class: 'row' }, kind, filter, info, h('button', { type: 'button', class: 'tiny', onclick: exportCsv }, 'CSV')), wrap),
    refresh: build,
    show(k) { kind.value = k; build(); },
  };
}

// ── Çizelgeler: dönüşüm ısı haritası (E295), karmaşıklık (E296), opcode (E294), bellek (E303),
//    düğüm sayısı (E304), karşılaştırma (E305) ──
function chartsTool(ctx) {
  const { app } = ctx;
  const kind = h('select', { class: 'field small', 'aria-label': t('charts.kind') }, ['heat', 'complexity', 'opcodes', 'memory', 'nodes', 'compare'].map((k) => h('option', { value: k }, t(`charts.kind.${k}`))));
  const wrap = h('div', { class: 'charts' });
  const nodeCache = new Map();
  const build = () => {
    const k = kind.value;
    const s = ctx.side();
    const doc = app.doc();
    if (k === 'heat') {
      const snaps = doc.snapshots ?? [];
      if (snaps.length < 2) { wrap.replaceChildren(emptyChart('charts.needRun')); return; }
      const BUCKETS = 40;
      const values = [];
      const labels = [];
      for (let i = 1; i < snaps.length; i++) {
        const before = snaps[i - 1].code;
        const rows = lineDiff(before, snaps[i].code);
        const row = new Array(BUCKETS).fill(0);
        if (rows) {
          const total = Math.max(1, before.split('\n').length);
          let line = 0;
          for (const [kd] of rows) {
            if (kd !== 'add') line++;
            if (kd !== 'same') row[Math.min(BUCKETS - 1, Math.floor(((line - 1) / total) * BUCKETS))]++;
          }
        }
        values.push(row);
        labels.push(`${snaps[i].id}${snaps[i].round ? ` #${snaps[i].round}` : ''}`);
      }
      wrap.replaceChildren(chartCard(t('charts.kind.heat'), heatmap(values, { label: t('charts.kind.heat'), rowLabels: labels, colLabel: t('charts.heat.cols'), onCell: (r) => app.openTimeline(r + 1) }), { note: t('charts.heat.note') }));
    } else if (k === 'complexity') {
      const src = app.source(s);
      if (!src.ast) { wrap.replaceChildren(h('p', { class: 'dlg-err' }, t('tools.parseError', { m: src.error ?? '' }))); return; }
      const list = intel.complexity(src.ast, src.code);
      if (!list.length) { wrap.replaceChildren(emptyChart('charts.noFunctions')); return; }
      wrap.replaceChildren(chartCard(t('charts.kind.complexity'), treemap(list.map((f) => ({ label: f.name, size: f.size, value: f.complexity, onClick: () => app.jump(s, f.start, f.end, { flash: true }) })), { label: t('charts.kind.complexity'), valueLabel: t('tables.col.complexity') }), { note: t('charts.complexity.note') }));
    } else if (k === 'opcodes') {
      const src = app.source(s);
      const found = src.ast ? gm.opcodeFrequency(src.ast) : [];
      if (!found.length) { wrap.replaceChildren(emptyChart('charts.noVm')); return; }
      wrap.replaceChildren(...found.map((f) => chartCard(t('charts.opcodes.title', { a: f.array, n: f.length }),
        barChart(f.ops.slice(0, 64).map((o) => ({ label: String(o.op), value: o.count, color: o.handled ? 'var(--chart-1)' : 'var(--chart-3)', title: `${o.op}: ${o.count}${o.handled ? '' : ` · ${t('charts.opcodes.unhandled')}`}`, onClick: () => app.jump(s, f.start, f.end, { flash: true }) })), { label: t('charts.kind.opcodes') }),
        { note: t('charts.opcodes.note') })));
    } else if (k === 'memory') {
      const series = doc.series ?? [];
      if (!series.length) { wrap.replaceChildren(emptyChart('charts.needRun')); return; }
      const heap = series.filter((p) => p.heap != null);
      const parts = [];
      if (heap.length) parts.push(chartCard(t('charts.memory.heap'), lineChart([{ name: 'JS heap (MB)', points: heap.map((p) => ({ x: p.t / 1000, y: p.heap / 1048576, label: p.id })) }], { label: t('charts.memory.heap'), xLabel: t('charts.axis.seconds'), yLabel: 'MB' })));
      else parts.push(h('p', { class: 'rep-muted small' }, t('charts.memory.noApi')));
      parts.push(chartCard(t('charts.memory.code'), lineChart([{ name: 'KB', points: series.map((p) => ({ x: p.t / 1000, y: p.bytes / 1024, label: p.id })) }], { label: t('charts.memory.code'), xLabel: t('charts.axis.seconds'), yLabel: 'KB' })));
      wrap.replaceChildren(...parts);
    } else if (k === 'nodes') {
      const snaps = doc.snapshots ?? [];
      if (!snaps.length) { wrap.replaceChildren(emptyChart('charts.needRun')); return; }
      const points = snaps.map((sn, i) => {
        let n = nodeCache.get(sn.code);
        if (n === undefined) { const r = intel.parseSafe(sn.code); n = r.ast ? intel.countNodes(r.ast) : 0; nodeCache.set(sn.code, n); }
        return { x: i, y: n, label: sn.id };
      });
      wrap.replaceChildren(chartCard(t('charts.kind.nodes'), lineChart([{ name: t('charts.kind.nodes'), points }], { label: t('charts.kind.nodes'), xLabel: t('charts.axis.step'), yLabel: t('charts.axis.nodes') })));
    } else if (k === 'compare') {
      const groups = [];
      (doc.runs ?? []).slice(-6).forEach((r, i, arr) => groups.push({ label: i === arr.length - 1 ? t('charts.compare.latest') : `#${(doc.runs.length - arr.length) + i + 1}`, values: r }));
      for (const other of app.docs()) if (other !== doc && other.runs?.length) groups.push({ label: other.name.slice(0, 18), values: other.runs[other.runs.length - 1] });
      if (!groups.length) { wrap.replaceChildren(emptyChart('charts.needRun')); return; }
      const metrics = ['outBytes', 'inBytes', 'ms', 'changed', 'rollbacks', 'obfIdsAfter', 'hexCallsAfter', 'functions'].map((key) => ({ key, label: t(`charts.metric.${key}`) }));
      wrap.replaceChildren(h('p', { class: 'rep-muted small' }, t('charts.compare.note')), smallMultiples(metrics, groups, { label: t('charts.kind.compare') }));
    }
  };
  kind.addEventListener('change', build);
  return { el: h('div', { class: 'tool' }, h('div', { class: 'row' }, kind), wrap), refresh: build, show(k) { kind.value = k; build(); } };
}

// ── Satır notları ve yer imleri (132) ──
function notesTool(ctx) {
  const { app } = ctx;
  const list = h('ul', { class: 'notes' });
  const add = h('button', { type: 'button', class: 'ghost small', onclick: () => app.editNote() }, t('notes.add'));
  const mark = h('button', { type: 'button', class: 'ghost small', onclick: () => app.toggleBookmark() }, t('notes.bookmark'));
  const refresh = () => {
    const items = [];
    for (const side of ['in', 'out']) {
      const m = app.editor(side).marks();
      for (const n of m.bookmarks) items.push({ side, line: n, kind: 'bookmark', text: app.editor(side).lineAt(app.editor(side).posOfLine(n)).text.trim().slice(0, 100) });
      for (const n of m.notes) items.push({ side, line: n.line, kind: 'note', text: n.text });
    }
    list.replaceChildren(...items.map((it) => {
      const go = () => { const p = app.editor(it.side).posOfLine(it.line); app.jump(it.side, p, p, { focus: true }); };
      return h('li', { class: `note-${it.kind}` },
        h('button', { type: 'button', class: 'linkish', onclick: go },
          h('span', { class: 'res-pos' }, `${t(it.side === 'in' ? 'panel.input' : 'panel.output')} ${it.line}`),
          h('span', { class: 'note-text' }, it.text || '–')),
        it.kind === 'note' ? h('button', { type: 'button', class: 'tiny', onclick: () => app.editNote(it.side, app.editor(it.side).posOfLine(it.line)) }, t('notes.edit')) : null,
        h('button', { type: 'button', class: 'tiny', 'aria-label': t('notes.remove'), onclick: () => {
          const p = app.editor(it.side).posOfLine(it.line);
          if (it.kind === 'note') app.editor(it.side).setNote(p, ''); else app.editor(it.side).toggleBookmark(p);
          app.marksChanged();
        } }, '✕'));
    }));
    if (!items.length) list.append(h('li', { class: 'rep-muted' }, t('notes.empty')));
  };
  return { el: h('div', { class: 'tool' }, h('div', { class: 'row' }, add, mark), h('p', { class: 'rep-muted small' }, t('notes.hint')), list), refresh };
}

// ── Pass'ler: hariç tutma (120), sıralama (E282), önizleme (E255), kuru çalıştırma (E256),
//    adım adım onay (E257), seçimde çalıştırma (E253) ──
export function orderedPasses() {
  const order = settings().passOrder;
  const rank = (id) => { const i = order.indexOf(id); return i < 0 ? 1000 + PASSES.findIndex((p) => p.id === id) : i; };
  return [...PASSES].sort((a, b) => rank(a.id) - rank(b.id));
}

function passesTool(ctx) {
  const { app } = ctx;
  const list = h('ol', { class: 'pass-list', 'aria-label': t('tool.passes') });
  let dragId = null;
  const move = (id, delta) => {
    const ids = orderedPasses().map((p) => p.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    update({ passOrder: ids });
    render();
    list.querySelector(`[data-id="${CSS.escape(id)}"] .mv-${delta < 0 ? 'up' : 'down'}`)?.focus();
    announce(t('passes.moved', { id, n: j + 1 }));
  };
  const render = () => {
    const disabled = new Set(settings().passDisabled);
    const events = app.doc().events ?? [];
    list.replaceChildren(...orderedPasses().map((p, i) => {
      const cb = h('input', { type: 'checkbox', checked: !disabled.has(p.id), 'aria-label': t('passes.enable', { id: p.id }) });
      cb.addEventListener('change', () => {
        const d = new Set(settings().passDisabled);
        if (cb.checked) d.delete(p.id); else d.add(p.id);
        update({ passDisabled: [...d] });
      });
      const ok = events.filter((e) => e.id === p.id && e.state === 'ok').length;
      const fail = events.filter((e) => e.id === p.id && e.state === 'fail').length;
      const li = h('li', { draggable: 'true', 'data-id': p.id, class: disabled.has(p.id) ? 'off' : '' },
        h('span', { class: 'drag', 'aria-hidden': 'true', title: t('passes.drag') }, '⠿'),
        h('span', { class: 'num' }, String(i + 1)), cb,
        h('span', { class: 'pass-id' }, p.id),
        h('span', { class: 'pass-meta' }, `${p.kind} · L${p.level}${p.needs ? ' · sandbox' : ''}`),
        ok || fail ? h('span', { class: 'pass-res' }, ok ? `✓${ok}` : '', fail ? ` ✕${fail}` : '') : null,
        h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'tiny mv-up', 'aria-label': t('passes.up', { id: p.id }), disabled: i === 0, onclick: () => move(p.id, -1) }, '↑'),
        h('button', { type: 'button', class: 'tiny mv-down', 'aria-label': t('passes.down', { id: p.id }), disabled: i === PASSES.length - 1, onclick: () => move(p.id, 1) }, '↓'),
        h('button', { type: 'button', class: 'tiny', onclick: () => app.previewPass(p.id) }, t('passes.preview')));
      li.addEventListener('dragstart', (e) => { dragId = p.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p.id); li.classList.add('dragging'); });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      li.addEventListener('dragover', (e) => { if (dragId) { e.preventDefault(); li.classList.add('drop-target'); } });
      li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        li.classList.remove('drop-target');
        if (!dragId || dragId === p.id) return;
        const ids = orderedPasses().map((x) => x.id).filter((x) => x !== dragId);
        ids.splice(ids.indexOf(p.id), 0, dragId);
        update({ passOrder: ids });
        dragId = null;
        render();
      });
      return li;
    }));
  };
  const actions = h('div', { class: 'row wrap' },
    h('button', { type: 'button', class: 'ghost small accent', onclick: () => app.run() }, t('action.run')),
    h('button', { type: 'button', class: 'ghost small', onclick: () => app.run({ mode: 'dry' }) }, t('passes.dry')),
    h('button', { type: 'button', class: 'ghost small', onclick: () => app.run({ mode: 'step' }) }, t('passes.step')),
    h('button', { type: 'button', class: 'ghost small', onclick: () => app.runSelection() }, t('passes.selection')),
    h('button', { type: 'button', class: 'tiny', onclick: () => { update({ passOrder: [], passDisabled: [] }); render(); } }, t('passes.reset')));
  return { el: h('div', { class: 'tool' }, actions, h('p', { class: 'rep-muted small' }, t('passes.hint')), list), refresh: render };
}
