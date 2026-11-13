import { parse } from '../../core/parse.js';
import { pretty, FORMAT_PROFILES, profileOptions } from '../../core/emit.js';
import { traverse } from '../../util/ast.js';
import { applyNameMap, listSuggestions, serializeNameMap, parseNameMap } from '../../naming/names.js';
import { summarizeFunction } from '../../naming/summary.js';
import { createInferer, toDts } from '../../naming/types.js';
import { explain } from '../../naming/explain.js';
import { functionUnits } from '../../analysis/index.js';
import { analyzeFunction } from '../../analysis/defs.js';
import { settings, update as updateSettings } from '../settings.js';
import { sequence } from '../../naming/sequence.js';
import { complexity } from '../../naming/metrics.js';
import { deadRegions } from '../../naming/deadcode.js';
import { annotatedDiff } from '../../naming/diffnotes.js';
import { zip } from '../../naming/zip.js';
import { webgpuStatus, loadModel, suggestNames, modelLoaded } from '../../naming/llm.js';
import { fnv1a } from '../../util/hash.js';
import { getLang } from '../../i18n.js';
import { s } from './strings.js';
import {
  getOptions, setOption, getDict, setDict, getMap, setMap, getSnapshots, parseDictText, dictToText,
} from './state.js';

export { namingOptions, recordSnapshot, resetSnapshots } from './state.js';

// Editör erişimi main.js'ten verilir (CodeMirror editörleri): { getInput, getOutput, setOutput }
const io = { getInput: () => '', getOutput: () => '', setOutput: () => {} };
export function configureNaming(api) { Object.assign(io, api); }
const setOutput = (text) => io.setOutput(text);

// Anlamlandırma paneli: rapor sekmesine bağlanır. Ağır görünümler sekme açılınca güncel çıktıdan hesaplanır.

// CFG görseli araç panelindeki grafik görünümündedir (ui/graph-model + graph-view): burada tekrarlanmaz
const VIEWS = ['names', 'summary', 'explain', 'defuse', 'sequence', 'readability', 'unresolved', 'dead', 'modules', 'diff', 'types', 'options'];
const SVG = 'http://www.w3.org/2000/svg';
const MAX_ROWS = 400;

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}
function sv(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const c of children) if (c) node.append(c);
  return node;
}
const muted = (text) => h('p', { class: 'rep-muted' }, text);
const btn = (label, onclick, cls = 'ghost') => h('button', { type: 'button', class: cls, onclick }, label);
const table = (headers, rows, classes = []) => h('table', { class: 'rep-table' },
  h('thead', {}, h('tr', {}, headers.map((x) => h('th', {}, x)))),
  h('tbody', {}, rows.slice(0, MAX_ROWS).map((r) => h('tr', {}, r.map((c, i) => h('td', { class: classes[i] ?? '' }, c instanceof Node ? c : String(c ?? '')))))));

function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const output = () => io.getOutput();
const input = () => io.getInput();
function parsed() {
  const code = output();
  if (!code.trim()) return { error: s().empty };
  try { return { ast: parse(code), code }; } catch { return { error: s().parseFail }; }
}

/**
 * @param {HTMLElement} root
 * @param {object} data  analyze() raporunun naming alanı
 */
export function render(root, data) {
  root.textContent = '';
  root.classList.add('nm');
  let active = 'names';
  const status = h('p', { class: 'nm-status', role: 'status', 'aria-live': 'polite' });
  const panel = h('div', { class: 'nm-panel', role: 'tabpanel', tabindex: '0' });
  const tabs = VIEWS.map((v) => h('button', {
    type: 'button', role: 'tab', class: 'tiny', id: `nm-tab-${v}`, 'aria-selected': String(v === active), tabindex: v === active ? '0' : '-1',
    onclick: () => select(v),
  }, s().tabs[v]));
  const list = h('div', { class: 'nm-tabs', role: 'tablist', 'aria-label': s().tablist }, tabs);
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = VIEWS.indexOf(active) + (e.key === 'ArrowRight' ? 1 : -1);
    select(VIEWS[(i + VIEWS.length) % VIEWS.length], true);
  });
  const say = (text) => { status.textContent = text; };
  const ctx = { data, say, rerender: () => select(active) };

  function select(v, focus = false) {
    active = v;
    for (const t of tabs) {
      const on = t.id === `nm-tab-${v}`;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    }
    panel.setAttribute('aria-labelledby', `nm-tab-${v}`);
    panel.textContent = '';
    try {
      panel.append(VIEW_FNS[v](ctx));
    } catch (e) {
      panel.append(muted(`${e.message}`));
    }
  }
  root.append(list, status, panel);
  select(active);
  return root;
}

// ── görünümler ──────────────────────────────────────────

const VIEW_FNS = {
  names: namesView,
  summary: summaryView,
  explain: explainView,
  defuse: defUseView,
  sequence: sequenceView,
  readability: readabilityView,
  unresolved: unresolvedView,
  dead: deadView,
  modules: modulesView,
  diff: diffView,
  types: typesView,
  options: optionsView,
};

async function applyNames(names, ctx) {
  const L = s();
  try {
    const r = await applyNameMap(output(), names, { originalComments: Boolean(getOptions().originalComments) });
    setOutput(r.code);
    ctx.say(`${L.applied(r.renamed.length)}${r.skipped.length ? ` · ${L.skipped(r.skipped.length)}` : ''}`);
  } catch (e) {
    ctx.say(e.message);
  }
  ctx.rerender();
}

function namesView(ctx) {
  const L = s();
  const wrap = h('div', { class: 'nm-stack' });
  const src = input();
  const items = listSuggestions(output());
  const map = getMap(src);
  const fields = new Map();

  // 71: yerel model
  const llmStatus = h('span', { class: 'rep-muted' });
  const llmBox = h('div', { class: 'nm-box' },
    h('h4', {}, L.llm), muted(L.llmHint),
    h('div', { class: 'rep-actions' },
      btn(L.llmLoad, async () => {
        const st = await webgpuStatus();
        if (!st.ok) { llmStatus.textContent = L.llmNoGpu(st.reason); return; }
        try {
          const r = await loadModel(({ progress, text }) => { llmStatus.textContent = L.llmProgress(progress, text); });
          llmStatus.textContent = L.llmLoaded(r.model);
        } catch (e) {
          llmStatus.textContent = L.llmFallback(e.message);
        }
      }),
      btn(L.llmRun, async () => {
        const r = await suggestNames(output());
        if (r.source !== 'llm') llmStatus.textContent = modelLoaded() ? L.llmFallback(r.reason) : L.llmFallback(r.reason ?? '');
        for (const [k, v] of Object.entries(r.names)) {
          const f = fields.get(k);
          if (f) f.value = v;
        }
        setMap(src, { ...getMap(src), ...r.names });
        ctx.say(L.llmDone(Object.keys(r.names).length));
      }),
      llmStatus));

  // 72: öneriler
  const rows = items.map((it) => {
    const field = h('input', { type: 'text', class: 'nm-input mono', value: map[it.name] ?? it.suggestion ?? '', 'aria-label': `${L.newName}: ${it.name}`, spellcheck: 'false' });
    fields.set(it.name, field);
    const apply = it.blocked ? h('span', { class: 'rep-muted' }, `${L.blocked} (${it.blocked})`)
      : btn(L.apply, () => {
        const v = field.value.trim();
        if (!v) return;
        setMap(src, { ...getMap(src), [it.name]: v });
        applyNames({ [it.name]: v }, ctx);
      }, 'tiny');
    return [it.name, it.kind, it.type, it.line ?? '', it.refs, field, it.reason ?? '', apply];
  });
  const applyAll = btn(L.applyAll, () => {
    const names = {};
    for (const it of items) {
      const v = fields.get(it.name)?.value.trim();
      if (v && !it.blocked) names[it.name] = v;
    }
    setMap(src, { ...getMap(src), ...names });
    applyNames(names, ctx);
  });

  // 87/88: dosya haritası
  const mapRows = Object.entries(map).map(([k, v]) => [k, v, btn(L.remove, () => {
    const m = getMap(src);
    delete m[k];
    setMap(src, m);
    ctx.rerender();
  }, 'tiny')]);
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    if (f.size > 1_000_000) { ctx.say(L.importFail('> 1 MB')); return; }
    const r = parseNameMap(await f.text());
    if (!r.ok) { ctx.say(L.importFail(r.error)); return; }
    setMap(src, { ...getMap(src), ...r.names });
    ctx.say(L.imported(Object.keys(r.names).length, r.rejected.length));
    applyNames(r.names, ctx);
  });
  const mapBox = h('div', { class: 'nm-box' }, h('h4', {}, L.map), muted(L.mapHint),
    mapRows.length ? table([L.name, L.newName, ''], mapRows, ['mono', 'mono', '']) : null,
    h('div', { class: 'rep-actions' },
      btn(L.exportMap, () => download('peel-names.json', serializeNameMap(getMap(src), fnv1a(src)), 'application/json')),
      btn(L.importMap, () => fileInput.click()),
      btn(L.clearMap, () => { setMap(src, {}); ctx.rerender(); }),
      fileInput));

  // E231: kullanıcı sözlüğü
  const dictArea = h('textarea', { class: 'nm-textarea mono', rows: '5', spellcheck: 'false', 'aria-label': L.dict });
  dictArea.value = dictToText(getDict());
  const dictBox = h('div', { class: 'nm-box' }, h('h4', {}, L.dict), muted(L.dictHint), dictArea,
    h('div', { class: 'rep-actions' }, btn(L.saveDict, () => {
      const d = parseDictText(dictArea.value);
      setDict(d);
      dictArea.value = dictToText(d);
      applyNames(d, ctx);
    })));

  wrap.append(...[llmBox,
    items.length ? h('div', {}, table([L.name, L.kind, L.type, L.line, L.refs, L.suggestion, L.reason, ''], rows, ['mono', '', 'mono', 'num', 'num', '', 'rep-muted', '']),
      h('div', { class: 'rep-actions' }, applyAll)) : null,
    mapBox, dictBox].filter(Boolean));
  return wrap;
}

function summaryView(ctx) {
  const L = s();
  const wrap = h('div', { class: 'nm-stack' }, h('h4', {}, L.summary), h('p', { class: 'nm-summary' }, ctx.data?.summary || '–'));
  const p = parsed();
  if (p.ast) {
    const inf = createInferer();
    const rows = [];
    traverse(p.ast, {
      Function(f) {
        if (rows.length >= MAX_ROWS) return f.stop();
        const name = f.node.id?.name ?? (f.parentPath.isVariableDeclarator() ? f.parent.id.name : null) ?? f.node.key?.name ?? null;
        if (!name) return;
        const { text, sig } = summarizeFunction(f, inf, getLang());
        rows.push([`${name}(${sig.params.map((x) => x.name).join(', ')})`, f.node.loc?.start.line ?? '', sig.returns, text]);
      },
    });
    if (rows.length) wrap.append(h('h4', {}, L.functions), table([L.fn, L.line, L.type, ''], rows, ['mono', 'num', 'mono', '']));
  }
  const libs = ctx.data?.libraryVersions ?? [];
  if (libs.length) wrap.append(h('h4', {}, L.libs), table([L.name, 'v', L.source, L.line], libs.map((l) => [l.name, l.version, l.source, l.line ?? '']), ['', 'mono', 'rep-muted', 'num']));
  return wrap;
}

function codeLines() {
  return output().split('\n');
}

function explainView() {
  const L = s();
  const p = parsed();
  if (p.error) return muted(p.error);
  const notes = new Map(explain(p.ast, getLang()).map((e) => [e.line, e]));
  const lines = codeLines().slice(0, 3000);
  return h('div', {}, muted(L.explainHint), h('table', { class: 'nm-explain' }, h('tbody', {},
    lines.map((line, i) => {
      const n = notes.get(i + 1);
      return h('tr', {}, h('td', { class: 'num' }, String(i + 1)), h('td', { class: 'mono nm-code' }, line), h('td', { class: 'nm-note' }, n?.text ?? ''));
    }))));
}

// 90: tanım-kullanım zincirleri semantik analiz altyapısının ulaşan tanımlar çözümünden (analysis/defs.js) okunur
function defUseRows(ast) {
  const lineOf = (p) => p?.node?.loc?.start.line ?? null;
  const rows = [];
  for (const unit of functionUnits(ast)) {
    let r;
    try { r = analyzeFunction(unit); } catch { continue; }
    r.bindings.forEach((b, i) => {
      const defs = r.defs.filter((d) => d.b === i);
      const uses = r.uses.filter((u) => u.e.b === i);
      rows.push({
        name: b.identifier.name,
        kind: b.kind,
        line: b.identifier.loc?.start.line ?? null,
        defs: defs.map((d) => `${lineOf(d.path) ?? '–'} ${d.kind}`),
        uses: uses.map((u) => `${lineOf(u.e.path) ?? '?'} ← ${[...new Set(u.defs.map((d) => lineOf(d.path) ?? d.kind))].join('/') || '–'}`),
      });
    });
  }
  return rows.sort((x, y) => (x.line ?? 0) - (y.line ?? 0));
}

function defUseView() {
  const L = s();
  const p = parsed();
  if (p.error) return muted(p.error);
  const all = defUseRows(p.ast);
  const filter = h('input', { type: 'search', class: 'nm-input', placeholder: L.filter, 'aria-label': L.filter });
  const holder = h('div');
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = all.filter((b) => !q || b.name.toLowerCase().includes(q)).map((b) => [b.name, b.kind, b.line ?? '', b.defs.join(', '), b.uses.join(', ')]);
    holder.textContent = '';
    holder.append(table([L.name, L.kind, L.line, L.defs, `${L.uses} (${L.from})`], rows, ['mono', '', 'num', 'mono', 'mono']));
  };
  filter.addEventListener('input', draw);
  draw();
  return h('div', {}, filter, holder);
}

function sequenceView() {
  const L = s();
  const p = parsed();
  if (p.error) return muted(p.error);
  const seq = sequence(p.ast);
  const calls = seq.messages.filter((m) => m.kind !== 'open' && m.kind !== 'close');
  if (!calls.length) return muted(L.noMessages);
  const COL = 150;
  const ROW = 26;
  const top = 40;
  const width = seq.participants.length * COL + 40;
  const height = top + seq.messages.length * ROW + 20;
  const xOf = (name) => 20 + seq.participants.indexOf(name) * COL + COL / 2;
  const svg = sv('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': L.tabs.sequence, class: 'nm-svg' });
  svg.append(sv('defs', {}, sv('marker', { id: 'nm-seq-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' },
    sv('path', { d: 'M0,0 L10,5 L0,10 z', class: 'nm-arrowhead' }))));
  seq.participants.forEach((name) => {
    const x = xOf(name);
    svg.append(sv('line', { x1: x, y1: top - 8, x2: x, y2: height - 10, class: 'nm-lifeline' }));
    svg.append(sv('rect', { x: x - COL / 2 + 8, y: 6, width: COL - 16, height: 24, rx: 5, class: 'nm-actor' }));
    const t = sv('text', { x, y: 22, 'text-anchor': 'middle' });
    t.textContent = name.length > 18 ? `${name.slice(0, 17)}…` : name;
    svg.append(t);
  });
  const frames = [];
  seq.messages.forEach((m, i) => {
    const y = top + i * ROW + 14;
    if (m.kind === 'open') { frames.push({ y, label: m.label, x: xOf(m.from) }); return; }
    if (m.kind === 'close') {
      const f = frames.pop();
      if (f) {
        svg.append(sv('rect', { x: f.x - 14, y: f.y - 10, width: width - f.x - 6, height: y - f.y + 6, class: 'nm-frame' }));
        const t = sv('text', { x: f.x - 10, y: f.y + 2, class: 'nm-frame-label' });
        t.textContent = f.label;
        svg.append(t);
      }
      return;
    }
    const x1 = xOf(m.from);
    const x2 = xOf(m.to);
    if (m.kind === 'note' || x1 === x2) {
      const t = sv('text', { x: x1 + 6, y, class: 'nm-note-label' });
      t.textContent = m.label;
      svg.append(t);
      return;
    }
    svg.append(sv('line', { x1, y1: y, x2, y2: y, class: `nm-msg ${m.kind}`, 'marker-end': 'url(#nm-seq-arrow)' }));
    const t = sv('text', { x: (x1 + x2) / 2, y: y - 4, 'text-anchor': 'middle', class: 'nm-msg-label' });
    t.textContent = m.label.length > 40 ? `${m.label.slice(0, 39)}…` : m.label;
    svg.append(t);
  });
  return h('div', {}, seq.truncated ? muted(L.truncated) : null, h('div', { class: 'nm-graph' }, svg));
}

function readabilityView(ctx) {
  const L = s();
  const r = ctx.data?.readability;
  const wrap = h('div', { class: 'nm-stack' });
  if (r?.before && r?.after) {
    const keys = Object.keys(L.metric);
    const score = h('div', { class: 'nm-score' },
      h('span', {}, L.score), h('b', {}, `${r.before.score} → ${r.after.score}`), h('small', {}, r.delta >= 0 ? `+${r.delta}` : String(r.delta)));
    wrap.append(score, table(['', L.before, L.after], keys.map((k) => [L.metric[k], r.before[k], r.after[k]]), ['', 'num', 'num']));
  }
  // 93: ısı haritası
  const p = parsed();
  if (p.ast) {
    const fns = complexity(p.ast);
    const lines = codeLines().slice(0, 3000);
    const cx = new Array(lines.length).fill(0);
    // iç fonksiyonun karmaşıklığı dıştakinin üstüne yazılır (kısa aralık önce sona)
    for (const f of [...fns].sort((a, b) => (b.endLine - b.line) - (a.endLine - a.line))) {
      for (let i = f.line; i <= f.endLine && i <= lines.length; i++) cx[i - 1] = f.complexity;
    }
    const max = Math.max(1, ...cx);
    wrap.append(h('h4', {}, L.heat), muted(L.heatHint), h('div', { class: 'nm-heat mono' }, lines.map((line, i) => {
      const row = h('div', { class: 'nm-heat-row', title: cx[i] ? String(cx[i]) : '' }, h('span', { class: 'num' }, String(i + 1)), h('span', {}, line || ' '));
      if (cx[i]) row.style.setProperty('--heat', String(Math.min(1, cx[i] / Math.max(10, max))));
      return row;
    })));
  }
  return wrap;
}

function unresolvedView(ctx) {
  const L = s();
  const u = ctx.data?.unresolved;
  if (!u?.items.length) return muted(L.noneUnresolved);
  return h('div', {},
    h('div', { class: 'chips' }, Object.entries(u.counts).map(([k, n]) => h('span', { class: 'chip' }, L.kinds[k] ?? k, h('b', {}, String(n))))),
    table([L.line, L.kind, L.reason, ''], u.items.map((i) => [i.line ?? '', L.kinds[i.kind] ?? i.kind, i.reason, i.code]), ['num', '', 'rep-muted', 'mono']));
}

function deadView() {
  const L = s();
  const p = parsed();
  if (p.error) return muted(p.error);
  const regions = deadRegions(p.ast);
  if (!regions.length) return muted(L.noDead);
  const lines = codeLines();
  const out = h('div', { class: 'nm-folded mono' });
  let i = 1;
  for (const r of regions) {
    if (r.start > i) out.append(h('pre', {}, lines.slice(i - 1, r.start - 1).join('\n')));
    out.append(h('details', { class: 'nm-dead' },
      h('summary', {}, L.deadLines(r.end - r.start + 1, r.reason)),
      h('pre', {}, lines.slice(r.start - 1, r.end).join('\n'))));
    i = Math.max(i, r.end + 1);
  }
  if (i <= lines.length) out.append(h('pre', {}, lines.slice(i - 1).join('\n')));
  return out;
}

// 86: modüller motorun paket ayırıcısından (core/bundle.js, report.engine.bundle) gelir; burada indirme eklenir
function modulesView(ctx) {
  const L = s();
  const m = ctx.data?.bundle;
  if (!m?.modules?.length) return muted(L.noModules);
  const fileName = (id) => {
    const n = String(id).replace(/^[./\\]+/, '').replace(/[^\w.@/-]+/g, '_').slice(0, 120) || 'module';
    return /\.[cm]?[jt]sx?$/.test(n) ? n : `${n}.js`;
  };
  return h('div', { class: 'nm-stack' },
    h('p', {}, `${L.format}: ${m.kind} · ${m.modules.length}`),
    h('div', { class: 'rep-actions' }, btn(L.downloadZip, () => download('peel-modules.zip', zip(m.modules.map((x) => ({ name: fileName(x.id), text: x.code }))), 'application/zip'))),
    table([L.name, 'B', L.deps, ''], m.modules.map((x) => [
      x.id, x.size, x.deps.join(', '),
      btn(L.download, async () => download(fileName(x.id).split('/').pop(), await pretty(x.code, profileOptions(settings().format)), 'text/javascript'), 'tiny'),
    ]), ['mono', 'num', 'mono', '']));
}

function diffView() {
  const L = s();
  const snaps = getSnapshots();
  if (snaps.length < 2) return muted(L.noSnaps);
  const steps = annotatedDiff(snaps, getLang());
  return h('div', { class: 'nm-stack' }, steps.map((st, i) => h('details', { class: 'nm-step' },
    h('summary', {}, h('b', {}, L.step(i + 1, steps.length)), ` · ${st.pass} · ${L.round(st.round)} · `, h('span', {}, st.note), ` · ${L.changes(st.added, st.removed)}`),
    st.tooBig ? muted(L.diffTooBig) : h('div', { class: 'nm-hunks mono' }, st.hunks.slice(0, 40).map((hk) => h('div', { class: 'nm-hunk' },
      hk.ops.map(([kind, text, ln]) => h('div', { class: `row ${kind === 'same' ? '' : kind}` }, h('span', { class: 'n' }, String(ln)), h('span', { class: 'c' }, text)))))))));
}

function typesView() {
  const L = s();
  const p = parsed();
  if (p.error) return muted(p.error);
  const dts = toDts(p.ast);
  return h('div', { class: 'nm-stack' }, h('h4', {}, L.dts),
    h('div', { class: 'rep-actions' }, btn(L.dtsDownload, () => download('peeled.d.ts', dts, 'text/plain'))),
    h('pre', { class: 'nm-pre mono', tabindex: '0' }, dts));
}

function optionsView(ctx) {
  const L = s();
  const opts = getOptions();
  const boxes = Object.entries(L.toggles).map(([key, label]) => {
    const on = key === 'originalComments' ? Boolean(opts[key]) : opts[key] !== false;
    const cb = h('input', { type: 'checkbox', id: `nm-opt-${key}`, checked: on || null });
    cb.addEventListener('change', () => setOption(key, cb.checked));
    return h('label', { class: 'nm-check', for: `nm-opt-${key}` }, cb, label);
  });
  // E239: profil, arayüzün tek biçim ayarına (settings.format) yazılır; çıktı o ayarla biçimlenir
  const current = Object.keys(FORMAT_PROFILES).find((k) => sameFormat(FORMAT_PROFILES[k], settings().format)) ?? '';
  const profile = h('select', { class: 'nm-select', id: 'nm-format', 'aria-label': L.formatProfile },
    h('option', { value: '' }, '–'), Object.keys(FORMAT_PROFILES).map((k) => h('option', { value: k }, L.profiles[k] ?? k)));
  profile.value = current;
  return h('div', { class: 'nm-stack' },
    h('h4', {}, L.options), muted(L.optionsHint), h('div', { class: 'nm-checks' }, boxes),
    h('h4', {}, L.formatProfile),
    h('div', { class: 'rep-actions' }, profile, btn(L.reformat, async () => {
      if (!profile.value) return;
      updateSettings({ format: FORMAT_PROFILES[profile.value] });
      setOutput(await pretty(output(), profileOptions(settings().format)));
      ctx.say(L.profiles[profile.value] ?? profile.value);
    })));
}

const sameFormat = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);
