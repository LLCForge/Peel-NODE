import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import * as prettier from 'prettier/standalone';
import * as babelPlugin from 'prettier/plugins/babel';
import * as estreePlugin from 'prettier/plugins/estree';
import { EditorView } from '@codemirror/view';
import { undo, redo, selectAll } from '@codemirror/commands';
import { openSearchPanel, searchPanelOpen, findNext, findPrevious } from '@codemirror/search';
import { foldAll, unfoldAll } from '@codemirror/language';
import { deobfuscate } from './core/pipeline.js';
import { analyze } from './core/analyze.js';
import { sandbox } from './sandbox/client.js';
import { maskSecrets } from './core/threat.js';
import { initPanels } from './ui/panels.js';
import { log, clearLog, toggleLog } from './ui/log.js';
import { renderDiff, lineDiff, diffStats, compactDiff, renderRows } from './ui/diff.js';
import { renderReport } from './ui/report.js';
import { createTimeline } from './ui/timeline.js';
import { createEditor } from './ui/editor.js';
import { createTools, orderedPasses, TOOLS } from './ui/tools.js';
import { createWorkspace } from './ui/workspace.js';
import { register, run as runCommand, openPalette, openShortcuts, keyOf, isMac } from './ui/commands.js';
import { displayKey } from './ui/keys.js';
import { settings, update, onSettings, sanitize as sanitizeSettings } from './ui/settings.js';
import { openSettings } from './ui/settings-panel.js';
import { h, modal, promptText, confirmDialog, contextMenu, download, toast, announce } from './ui/dom.js';
import * as intel from './ui/code-intel.js';
import { buildMap, mapOffset } from './ui/srcmap.js';
import { fnv1a } from './util/hash.js';
import { t, applyI18n, toggleLang, onLang, getLang, LANGS } from './i18n.js';
import { SAMPLE } from './sample.js';
import { mountIntegrations } from './ui/integrations/index.js';
import { createTrace } from './analysis/trace.js';
import { detectTools, autoProfile } from './core/detect.js';
import { deobfuscateRegion } from './core/search.js';
import { configureNaming, namingOptions, recordSnapshot, resetSnapshots } from './ui/naming/index.js';

const $ = (id) => document.getElementById(id);
const status = $('status');
const stats = $('stats');
const passbar = $('passbar');
const runBtn = $('btn-run');
const stopBtn = $('btn-stop');
const logBtn = $('btn-log');
const empty = $('empty');
const main = $('main');
const views = { code: $('view-code'), report: $('view-report'), timeline: $('view-timeline'), diff: $('view-diff') };
const outTabs = [...document.querySelectorAll('#pane-out .tabs [role="tab"]')];

// Her çalıştırma tüm pass'leri en yüksek seviyede çalıştırır; davranış testi yanlış dönüşümü geri alır
const LEVEL = 4;
const LAYER_MAX = 3_000_000; // kapsam/ölü kod/güven katmanları bu boyutun üstünde kapalı (performans)

let sandboxOk = true;
let controller = null;
let lastStatus = ['status.ready', {}, ''];
let lastStats = {};
let diffDirty = true;
let activeTab = 'code';
let activeSide = 'in';

// ── olay yolu ──
const bus = new Map();
const on = (ev, fn) => { const set = bus.get(ev) ?? bus.set(ev, new Set()).get(ev); set.add(fn); return () => set.delete(fn); };
const emit = (ev, arg) => { for (const fn of bus.get(ev) ?? []) { try { fn(arg); } catch (e) { log(`${ev}: ${e.message}`, 'warn'); } } };

// ── editörler ──
const editorView = () => {
  const s = settings();
  return { fontSize: s.fontSize, wrap: s.wrap, invisibles: s.invisibles, hexLines: s.hexLines, ligatures: s.ligatures, minimap: s.minimap, indentGuides: s.indentGuides, activeLine: s.activeLine, tabWidth: s.format.tabWidth };
};
const edIn = createEditor($('ed-in'), {
  label: t('panel.input'),
  onChange: () => { onTextChange('in'); },
  onCursor: (st) => onCursor('in', st),
  onContext: (pt, pos) => editorMenu('in', pt, pos),
  onScroll: () => syncScroll('in'),
});
const edOut = createEditor(views.code, {
  readOnly: true,
  label: t('panel.output'),
  onChange: () => { onTextChange('out'); },
  onCursor: (st) => onCursor('out', st),
  onContext: (pt, pos) => editorMenu('out', pt, pos),
  onScroll: () => syncScroll('out'),
});
const editors = { in: edIn, out: edOut };
for (const [side, ed] of Object.entries(editors)) {
  ed.view.dom.addEventListener('focusin', () => { activeSide = side; });
  pinchZoom(ed.view.dom);
}
const timeline = createTimeline(views.timeline, { viewConfig: editorView() });

// ── kod zekâsı önbelleği: belge nesnesi değişmedikçe yeniden parse edilmez ──
const intelCache = { in: null, out: null };
function source(side) {
  const doc = editors[side].state.doc;
  const c = intelCache[side];
  if (c && c.doc === doc) return c;
  const code = doc.toString();
  const r = code.trim() ? intel.parseSafe(code) : { ast: null, error: t('tools.emptySource') };
  intelCache[side] = { doc, code, ast: r.ast, error: r.error };
  return intelCache[side];
}

// ── durum çubuğu ──
function setStatus(key, vars = {}, cls = '') {
  lastStatus = [key, vars, cls];
  status.textContent = t(key, vars);
  status.className = cls;
}
function rawStatus(msg, cls = '') {
  lastStatus = ['', {}, cls];
  status.textContent = msg;
  status.className = cls;
}
function setStats(o) {
  lastStats = o;
  stats.textContent = '';
  for (const [k, v] of Object.entries(o)) {
    if (!v) continue;
    // çevirisi olmayan iç sayaçlar (ör. stat.dead.inTest) durum çubuğunda ham anahtar olarak görünmesin; raporda yer alırlar
    const label = t(`stat.${k}`);
    if (label === `stat.${k}`) continue;
    const s = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = v.toLocaleString();
    s.append(b, ` ${label}`);
    stats.appendChild(s);
  }
}
// Kodun cihazdan çıkmadığının kanıtı: sayfanın kendi kökeni dışına giden istek sayısı
function updateNetworkBadge() {
  const external = performance.getEntriesByType('resource').filter((e) => {
    try {
      const u = new URL(e.name);
      return /^https?:$/.test(u.protocol) && u.origin !== location.origin;
    } catch {
      return false;
    }
  });
  const badge = $('net');
  badge.hidden = false;
  badge.classList.toggle('leak', external.length > 0);
  badge.textContent = external.length ? t('status.external', { n: external.length }) : t('status.offline');
}
const setLog = (open) => logBtn.setAttribute('aria-expanded', String(toggleLog(open)));

function onCursor(side, st) {
  const sel = st.selection.main;
  const line = st.doc.lineAt(sel.head);
  const col = sel.head - line.from + 1;
  const hex = settings().hexLines;
  const ln = hex ? line.number.toString(16).toUpperCase() : line.number;
  $('cursor').textContent = `${t(side === 'in' ? 'panel.input' : 'panel.output')} · ${t('status.cursor', { l: ln, c: col })}${sel.empty ? '' : ` · ${t('status.selected', { n: sel.to - sel.from })}`}`;
  if (side === 'out') scheduleMap();
  emit('cursor', st);
}

// ── belge değişimi ──
let changeTimer;
function onTextChange(side) {
  const n = editors[side].length;
  $(side === 'in' ? 'in-info' : 'out-info').textContent = n.toLocaleString();
  diffDirty = true;
  if (side === 'in') syncEmpty();
  else for (const id of ['btn-copy', 'btn-dl']) $(id).disabled = n === 0;
  mapCache = null;
  ws.persist();
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => { refreshLayers(); if (activeTab === 'diff') selectTab('diff'); emit('change', side); }, 450);
}
const syncEmpty = () => { empty.hidden = edIn.length > 0; };

// ── çalışma alanı ──
const ws = createWorkspace({
  text: (side) => editors[side].text,
  setInput: (text) => edIn.setText(text),
  persist: () => ws?.persist(),
  status: (msg, cls) => rawStatus(msg, cls),
  log,
  networkChanged: updateNetworkBadge,
  runGroup: (gid) => runGroup(gid),
  stash(doc) {
    doc.inState = edIn.state;
    doc.outState = edOut.state;
    doc.marks = { in: edIn.marks(), out: edOut.marks() };
  },
  load(doc) {
    edIn.setState(doc.inState ?? edIn.createState(doc.input));
    edOut.setState(doc.outState ?? edOut.createState(doc.output));
    if (!doc.inState) edIn.resetMarks(doc.marks.in);
    if (!doc.outState) edOut.resetMarks(doc.marks.out);
    intelCache.in = null;
    intelCache.out = null;
    mapCache = null;
    onTextChange('in');
    onTextChange('out');
    resetResultsView();
    if (doc.report) safeRenderReport(doc.report);
    timeline.load(doc.snapshots ?? []);
    setStats(doc.lastStats ?? {});
    for (const e of doc.events ?? []) markPass(e.id, e.state);
    emit('doc', doc);
  },
}, $('doctabs'));

// ── sonuç görünümleri ──
function selectTab(name, focus = false) {
  activeTab = name;
  for (const tab of outTabs) {
    const on = tab.id === `tab-${name}`;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  }
  for (const [key, view] of Object.entries(views)) view.hidden = key !== name;
  if (name === 'diff' && diffDirty) {
    renderDiff(views.diff, edIn.text, edOut.text);
    diffDirty = false;
  }
}

function markPass(id, state) {
  let seg = passbar.querySelector(`i[data-id="${CSS.escape(id)}"]`);
  if (!seg) {
    seg = document.createElement('i');
    seg.dataset.id = id;
    seg.title = id;
    passbar.appendChild(seg);
  }
  // birden çok turda en iyi sonucu koru: bir kez değişiklik yapan pass işaretli kalır
  if (state === 'skip' && seg.className === 'ok') return;
  seg.className = state;
}

function resetResultsView() {
  setStats({});
  passbar.textContent = '';
  renderReport(views.report, null);
  timeline.reset();
  resetSnapshots();
  diffDirty = true;
  $('eta').textContent = '';
}

function safeRenderReport(report) {
  try {
    renderReport(views.report, report, exportReport, reportActions);
  } catch (e) {
    // içe aktarılmış oturumdaki bozuk rapor arayüzü kırmasın
    log(`report: ${e.message}`, 'warn');
    renderReport(views.report, null);
  }
}

// ── biçimlendirme tercihleri (138) ──
async function formatCode(code) {
  const f = settings().format;
  try {
    return await prettier.format(code, { parser: 'babel', plugins: [babelPlugin, estreePlugin], ...f });
  } catch {
    return code;
  }
}

function enabledPasses() {
  const off = new Set(settings().passDisabled);
  return orderedPasses().map((p) => p.id).filter((id) => !off.has(id));
}

// ── çalıştırma: normal, kuru (E256), adım adım onaylı (E257) ──
async function run({ mode = 'normal' } = {}) {
  if (controller) return null;
  const doc = ws.active;
  const src = edIn.text;
  if (!src.trim()) {
    setStatus('status.empty', {}, 'err');
    edIn.focus();
    return null;
  }
  let only = enabledPasses();
  // E26: ayarlarda otomatik profil açıksa eşiği aşan araç tespitinin profili uygulanır (eşik altında tüm pass'ler)
  let profileNote = null;
  if (settings().autoProfile) {
    const prof = autoProfile(detectTools(src));
    if (prof.passes) only = only.filter((id) => prof.passes.includes(id));
    profileNote = t('log.autoProfile', { p: prof.profile, r: prof.reason });
  }
  if (!only.length) { setStatus('status.noPasses', {}, 'err'); return null; }
  controller = new AbortController();
  runBtn.disabled = true;
  runBtn.setAttribute('aria-busy', 'true');
  stopBtn.hidden = false;
  if (mode !== 'dry') { resetResultsView(); clearLog(); }
  if (profileNote) log(profileNote, 'info');
  setStatus(mode === 'dry' ? 'status.dryRunning' : 'status.running', {}, 'busy');
  const t0 = performance.now();
  const snapshots = [];
  const layers = [{ id: t('layers.original'), code: src }];
  const series = [];
  const sample = (id, bytes) => series.push({ t: performance.now() - t0, id, heap: performance.memory?.usedJSHeapSize ?? null, bytes });
  let lastLen = src.length;
  const rejected = new Set();
  let acceptAll = false;
  const onApprove = mode === 'step' ? async ({ id, round, before, after }) => {
    const key = `${id}:${fnv1a(after)}`;
    if (acceptAll) return true;
    if (rejected.has(key)) return false;
    const ans = await approveDialog({ id, round, before, after });
    if (ans === 'all') { acceptAll = true; return true; }
    if (ans === 'stop') { controller?.abort(); return false; }
    if (ans !== 'yes') rejected.add(key);
    return ans === 'yes';
  } : null;
  // pass kayıtları, yama günlüğü, köken ve yorum koruma (E-V); rapordaki semantik bölüm bunu okur
  const trace = createTrace({ keepComments: true });
  try {
    const res = await deobfuscate(src, {
      trace,
      level: LEVEL,
      only,
      order: only,
      sandbox: sandboxOk ? sandbox : null,
      deep: sandboxOk,
      signal: controller.signal,
      onLog: log,
      onPass: (id, state) => { if (mode !== 'dry') markPass(id, state); if (state !== 'run') sample(id, lastLen); },
      onSnapshot: (s) => { snapshots.push(s); lastLen = s.code.length; if (mode !== 'dry') timeline.push(s); tools.snapshot(s); if (mode !== 'dry') recordSnapshot(s); },
      onLayer: (l) => { layers.push(l); lastLen = l.code.length; },
      onProgress: (pct) => updateEta(pct, t0),
      onApprove,
      plugins: tools.plugins(),
      naming: namingOptions(src),
    });
    $('eta').textContent = '';
    if (res.error) {
      log(`Parse: ${res.error}`, 'err');
      setStatus('status.parse', {}, 'err');
      setLog(true);
      if (mode !== 'dry') timeline.finish();
      return null;
    }
    const output = await formatCode(res.code);
    const secs = ((performance.now() - t0) / 1000).toFixed(2);
    sample('pretty', output.length);
    if (mode === 'dry') {
      setStatus('status.dryDone', { s: secs }, 'ok');
      const apply = await dryRunDialog({ src, output, events: res.events, secs });
      if (!apply) return null;
    }
    // sonuç uygulanır: çıktı geri alınabilir şekilde değişir
    doc.snapshots = snapshots;
    doc.layers = layers;
    doc.series = series;
    doc.events = res.events;
    doc.lastStats = res.stats;
    if (mode === 'dry') { passbar.textContent = ''; for (const e of res.events) markPass(e.id, e.state); timeline.load(snapshots); } else timeline.finish();
    edOut.setText(output);
    setStats(res.stats);
    log(`OK (${secs}s)`, 'ok');
    if (sandboxOk && !res.verified) {
      log(t('status.unverified', { s: secs }), 'warn');
      setStatus('status.unverified', { s: secs }, 'err');
    } else {
      setStatus(output.trim() === src.trim() ? 'status.unchanged' : 'status.done', { s: secs }, 'ok');
    }
    announce(status.textContent);
    doc.text = res.text;
    const report = await analyze({ input: src, text: res.text, output, events: res.events, sandbox: sandboxOk ? sandbox : null, trace, verified: res.verified, findings: res.findings });
    report.stats = res.stats;
    doc.report = report;
    doc.runs = [...(doc.runs ?? []), {
      at: Date.now(), inBytes: src.length, outBytes: output.length, ms: Math.round(performance.now() - t0),
      changed: res.events.filter((e) => e.state === 'ok').length, rollbacks: res.events.filter((e) => e.state === 'fail').length,
      obfIdsAfter: report.metrics.obfuscatedIdsAfter, hexCallsAfter: report.metrics.hexCallsAfter, functions: report.metrics.functions,
    }].slice(-20);
    safeRenderReport(report);
    tools.onResult({ input: src, output, report, stats: res.stats });
    ws.render();
    ws.persist();
    emit('results', doc);
    return report;
  } catch (e) {
    log(e.message, 'err');
    if (controller.signal.aborted) setStatus('status.stopped', {}, 'err');
    else setStatus('status.error', { m: e.message }, 'err');
    return null;
  } finally {
    controller = null;
    runBtn.disabled = false;
    runBtn.removeAttribute('aria-busy');
    stopBtn.hidden = true;
    $('eta').textContent = '';
    updateNetworkBadge();
  }
}

// Kalan süre tahmini (128): ilerleme yüzdesine göre doğrusal; ilk saniyede gösterilmez
function updateEta(pct, t0) {
  const el = $('eta');
  const elapsed = (performance.now() - t0) / 1000;
  if (pct < 3 || elapsed < 1 || pct >= 100) { el.textContent = pct ? `${pct}%` : ''; return; }
  const left = Math.max(0, (elapsed * (100 - pct)) / pct);
  el.textContent = `${pct}% · ${t('status.eta', { s: left < 60 ? Math.ceil(left) : `${Math.floor(left / 60)}:${String(Math.ceil(left % 60)).padStart(2, '0')}` })}`;
}

function diffBlock(before, after, { max = 600 } = {}) {
  const rows = lineDiff(before, after);
  const box = h('div', { class: 'diff-box mono', tabindex: '0', role: 'region', 'aria-label': t('tab.diff') });
  if (!rows) { box.append(h('p', { class: 'placeholder' }, t('diff.tooBig', { a: before.split('\n').length, b: after.split('\n').length }))); return { box, stats: null }; }
  const st = diffStats(rows);
  const compact = compactDiff(rows, 2);
  queueMicrotask(() => renderRows(box, compact.length > max * 20 ? compact.slice(0, max * 20) : compact));
  return { box, stats: st };
}

function approveDialog({ id, round, before, after }) {
  return modal(t('step.title', { id }), (close) => {
    const { box, stats: st } = diffBlock(before, after);
    return h('div', { class: 'dlg-body' },
      h('p', {}, t('step.body', { id, r: round, a: st?.add ?? '?', d: st?.del ?? '?' })), box,
      h('div', { class: 'dlg-actions' },
        h('button', { type: 'button', class: 'ghost danger', onclick: () => close('stop') }, t('step.stop')),
        h('button', { type: 'button', class: 'ghost', onclick: () => close('no') }, t('step.reject')),
        h('button', { type: 'button', class: 'ghost', onclick: () => close('all') }, t('step.acceptAll')),
        h('button', { type: 'button', class: 'ghost accent', autofocus: true, onclick: () => close('yes') }, t('step.accept'))));
  }, { wide: true }).then((v) => v ?? 'no');
}

function dryRunDialog({ src, output, events, secs }) {
  return modal(t('dry.title'), (close) => {
    const ok = events.filter((e) => e.state === 'ok');
    const fail = events.filter((e) => e.state === 'fail');
    const { box, stats: st } = diffBlock(src, output);
    const counts = new Map();
    for (const e of ok) counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
    return h('div', { class: 'dlg-body' },
      h('p', {}, t('dry.summary', { s: secs, a: (src.length / 1024).toFixed(1), b: (output.length / 1024).toFixed(1), add: st?.add ?? '?', del: st?.del ?? '?' })),
      h('div', { class: 'chips' }, ...[...counts].map(([id, n]) => h('span', { class: 'chip' }, id, h('b', {}, `×${n}`)))),
      fail.length ? h('p', { class: 'rep-muted small' }, t('dry.failed', { list: [...new Set(fail.map((e) => e.id))].join(', ') })) : null,
      box,
      h('div', { class: 'dlg-actions' },
        h('button', { type: 'button', class: 'ghost', onclick: () => close(false) }, t('ui.close')),
        h('button', { type: 'button', class: 'ghost accent', autofocus: true, onclick: () => close(true) }, t('dry.apply'))));
  }, { wide: true });
}

// Pass önizlemesi (E255): tek pass, mevcut çıktı (yoksa girdi) üzerinde; uygulamadan fark gösterir
async function previewPass(id) {
  if (controller) return;
  const base = edOut.text.trim() ? edOut.text : edIn.text;
  if (!base.trim()) { setStatus('status.empty', {}, 'err'); return; }
  setStatus('status.previewing', { id }, 'busy');
  controller = new AbortController();
  stopBtn.hidden = false;
  try {
    const res = await deobfuscate(base, { level: LEVEL, only: [id], sandbox: sandboxOk ? sandbox : null, deep: false, signal: controller.signal, onLog: log });
    if (res.error) { setStatus('status.parse', {}, 'err'); return; }
    const after = await formatCode(res.code);
    const before = await formatCode(base);
    setStatus('status.ready');
    const apply = await modal(t('preview.title', { id }), (close) => {
      const { box, stats: st } = diffBlock(before, after);
      const changed = before !== after;
      return h('div', { class: 'dlg-body' },
        h('p', {}, changed ? t('preview.body', { add: st?.add ?? '?', del: st?.del ?? '?' }) : t('preview.none')), changed ? box : null,
        h('div', { class: 'dlg-actions' },
          h('button', { type: 'button', class: 'ghost', onclick: () => close(false) }, t('ui.close')),
          changed ? h('button', { type: 'button', class: 'ghost accent', onclick: () => close(true) }, t('preview.apply')) : null));
    }, { wide: true });
    if (apply) { edOut.setText(after); setStatus('status.applied', { id }, 'ok'); }
  } catch (e) {
    setStatus('status.error', { m: e.message }, 'err');
  } finally {
    controller = null;
    stopBtn.hidden = true;
  }
}

// Seçili bölgede pass çalıştırma (E253): seçim bağımsız parse edilebilmeli
async function runSelection() {
  if (controller) return;
  const ed = editors[activeSide];
  const sel = ed.selection;
  if (!sel.text.trim()) { setStatus('status.noSelection', {}, 'err'); return; }
  controller = new AbortController();
  stopBtn.hidden = false;
  setStatus('status.running', {}, 'busy');
  try {
    // E36: girdideki seçim önce tüm program bağlamıyla çözülür (decoder'lar seçim dışında olabilir);
    // bölge eşlenemezse seçim tek başına çözülür
    if (activeSide === 'in') {
      const reg = await deobfuscateRegion(ed.text, sel.from, sel.to, { sandbox: sandboxOk ? sandbox : null, signal: controller.signal });
      if (reg.ok) {
        ed.applyEdits([{ from: reg.region.from, to: reg.region.to, insert: reg.after }]);
        ed.select(reg.region.from, reg.region.from + reg.after.length);
        setStatus('status.selectionDone', { n: reg.after.length }, 'ok');
        return;
      }
      log(`seçim bağlamla çözülemedi: ${reg.reason}`, 'info');
    }
    const res = await deobfuscate(sel.text, { level: LEVEL, only: enabledPasses(), order: enabledPasses(), sandbox: sandboxOk ? sandbox : null, deep: false, signal: controller.signal, onLog: log });
    if (res.error) { setStatus('status.selectionParse', { m: res.error }, 'err'); return; }
    const out = (await formatCode(res.code)).replace(/\n$/, '');
    ed.applyEdits([{ from: sel.from, to: sel.to, insert: out }]);
    ed.select(sel.from, sel.from + out.length);
    setStatus('status.selectionDone', { n: out.length }, 'ok');
  } catch (e) {
    setStatus('status.error', { m: e.message }, 'err');
  } finally {
    controller = null;
    stopBtn.hidden = true;
  }
}

// HAR/zip/klasör toplu çözme (136): grup belgeleri sırayla
async function runGroup(gid) {
  const list = ws.groupDocs(gid);
  for (let i = 0; i < list.length; i++) {
    ws.switchTo(list[i].id);
    rawStatus(t('status.batch', { i: i + 1, n: list.length, name: list[i].name }), 'busy');
    if (!edIn.text.trim()) continue;
    await run();
    if (status.className === 'err' && lastStatus[0] === 'status.stopped') break;
  }
  announce(t('status.batchDone', { n: list.length }));
  toast(t('status.batchDone', { n: list.length }), 'ok');
}

function stop() {
  if (!controller) return;
  controller.abort();
  sandbox.kill();
  log(t('status.stopped'), 'warn');
}

function exportReport() {
  const r = ws.active?.report;
  if (r) download('peel-report.json', JSON.stringify(r, null, 2), 'application/json');
}

// Rapor eylemleri: YARA / Suricata kuralları ve anahtarları maskelenmiş çıktı (paylaşmadan önce)
const reportActions = {
  yara: () => ws.active?.report?.threat?.yara && download('peel.yar', ws.active.report.threat.yara, 'text/plain'),
  ids: () => ws.active?.report?.threat?.ids && download('peel.rules', ws.active.report.threat.ids, 'text/plain'),
  masked: () => {
    const { code, count } = maskSecrets(edOut.text);
    download('peeled.masked.js', code, 'text/javascript');
    setStatus('status.masked', { n: count }, 'ok');
  },
  // güvenlik/motor araçları (src/ui/security): indirme, sandbox, girdi/çıktı erişimi, seçim, anlık görüntüler
  security: {
    download,
    get sandbox() { return sandboxOk ? sandbox : null; },
    getInput: () => edIn.text,
    setInput: (text) => edIn.setText(text),
    getOutput: () => edOut.text,
    setOutput: (text) => edOut.setText(text),
    getText: () => ws.active?.text ?? edIn.text,
    getSelection: () => ({ start: edIn.selection.from, end: edIn.selection.to }),
    snapshots: () => ws.active?.snapshots ?? [],
  },
};

// ── gezinme: atla, geçmiş (geri/ileri), tanıma git, referanslar, yeniden adlandır ──
const nav = { stack: [], index: -1 };
function navPoint() { return { doc: ws.active?.id, side: activeSide, pos: editors[activeSide].cursor }; }
function pushNav() {
  nav.stack = nav.stack.slice(0, nav.index + 1);
  nav.stack.push(navPoint());
  if (nav.stack.length > 200) nav.stack.shift();
  nav.index = nav.stack.length - 1;
}
function goNav(d) {
  if (d < 0 && nav.index === nav.stack.length - 1) { nav.stack.push(navPoint()); }
  const i = nav.index + d;
  const p = nav.stack[i];
  if (!p) return;
  nav.index = i;
  if (p.doc !== ws.active?.id && ws.byId(p.doc)) ws.switchTo(p.doc);
  jump(p.side, p.pos, p.pos, { focus: true, push: false });
}

let flashTimer;
function jump(side, from, to, { focus = false, flash = false, push = true } = {}) {
  if (push) pushNav();
  if (side === 'out' && activeTab !== 'code') selectTab('code');
  if (document.body.classList.contains('mobile')) panels.setPane(side);
  if (document.body.classList.contains('reading') && side === 'in') setReading(false);
  const ed = editors[side];
  activeSide = side;
  ed.select(from, to, { focus });
  if (flash) {
    ed.setLayer('flash', [{ from, to, cls: 'cm-flash' }]);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => ed.setLayer('flash', []), 1400);
  }
}

function symbolHere(side = activeSide) {
  const src = source(side);
  if (!src.ast) { setStatus('status.parseTool', { m: src.error ?? '' }, 'err'); return null; }
  const sym = intel.symbolAt(src.ast, editors[side].cursor);
  if (!sym) setStatus('status.noSymbol', {}, 'err');
  return sym ? { sym, src, side } : null;
}

function gotoDefinition() {
  const r = symbolHere();
  if (!r) return;
  const def = r.sym.def;
  if (!def) { setStatus('status.noDefinition', { n: r.sym.name }, 'err'); return; }
  if (r.sym.defs.length > 1) { showRefs(r, r.sym.defs); return; }
  jump(r.side, def.start, def.end, { focus: true, flash: true });
}

function showRefs(r, list = r.sym.refs) {
  const rows = list.map((x) => ({ ...x, text: lineText(r.src.code, x.start), note: r.sym.kind }));
  showTool('search').showRows(r.sym.name, rows, r.side);
  setStatus('status.refs', { n: rows.length, name: r.sym.name }, 'ok');
}
const lineText = (code, off) => {
  const a = code.lastIndexOf('\n', off - 1) + 1;
  const b = code.indexOf('\n', off);
  return code.slice(a, b < 0 ? code.length : b).trim().slice(0, 160);
};

async function renameSymbol() {
  const r = symbolHere();
  if (!r) return;
  if (r.sym.kind !== 'binding') { setStatus('status.renameOnlyBinding', {}, 'err'); return; }
  const cursor = editors[r.side].cursor;
  const errors = { invalid: t('rename.invalid'), conflict: t('rename.conflict'), notBinding: t('status.renameOnlyBinding') };
  let edits = null;
  const name = await promptText(t('rename.title', { n: r.sym.name }), {
    label: t('rename.label'),
    value: r.sym.name,
    validate: (v) => {
      const res = intel.renameEdits(r.src.ast, cursor, v.trim());
      if (res.error) return errors[res.error];
      edits = res.edits;
      return null;
    },
  });
  if (!name || !edits?.length) return;
  editors[r.side].applyEdits(edits);
  setStatus('status.renamed', { a: r.sym.name, b: name.trim(), n: edits.length }, 'ok');
}

// Çıktıdan girdiye kaynak eşleme (118)
let mapCache = null;
let mapTimer;
function getMap() {
  if (mapCache) return mapCache;
  const out = edOut.text;
  const inp = edIn.text;
  if (!out.trim() || !inp.trim() || out.length + inp.length > 12_000_000) return null;
  mapCache = buildMap(out, inp);
  return mapCache;
}
function scheduleMap() {
  clearTimeout(mapTimer);
  if (!settings().mapToInput) return;
  mapTimer = setTimeout(() => showInInput(false), 150);
}
function showInInput(explicit = true) {
  const map = getMap();
  if (!map) { if (explicit) setStatus('status.noMap', {}, 'err'); return; }
  const sel = edOut.selection;
  const m = mapOffset(map, sel.from, 'out');
  if (!m) return;
  // tam eşleşme: token vurgulanır; yaklaşık: çapalar arası bölge soluk, tahmini satır belirgin
  edIn.setLayer('map', m.exact
    ? [{ from: m.from, to: Math.max(m.to, m.from + 1), cls: 'cm-map' }]
    : [{ from: m.from, to: Math.max(m.to, m.from + 1), cls: 'cm-map-approx' }, { from: m.point, to: m.point, line: true, cls: 'cm-map-line' }]);
  edIn.view.dispatch({ effects: EditorView.scrollIntoView(m.point, { y: 'center' }) });
  if (explicit) jump('in', m.exact ? m.from : m.point, m.exact ? m.to : m.point, { flash: m.exact });
}
function showInOutput() {
  const map = getMap();
  if (!map) { setStatus('status.noMap', {}, 'err'); return; }
  const m = mapOffset(map, edIn.cursor, 'in');
  if (m) jump('out', m.exact ? m.from : m.point, m.exact ? m.to : m.point, { flash: m.exact });
}

// Senkron kaydırma (117): eşleme varsa çapa üzerinden, yoksa orantılı
let syncing = false;
function syncScroll(from) {
  if (!settings().syncScroll || syncing) return;
  const a = editors[from];
  const b = editors[from === 'in' ? 'out' : 'in'];
  syncing = true;
  const map = getMap();
  if (map) {
    const m = mapOffset(map, a.topPos(), from === 'out' ? 'out' : 'in');
    if (m) b.scrollToPos(m.point);
  } else {
    const s = a.scrollDOM;
    const frac = s.scrollTop / Math.max(1, s.scrollHeight - s.clientHeight);
    b.scrollDOM.scrollTop = frac * (b.scrollDOM.scrollHeight - b.scrollDOM.clientHeight);
  }
  requestAnimationFrame(() => { syncing = false; });
}

// Seçimi kapsayan bir üst düğümü seç (tekrarlandıkça genişler)
function selectNode() {
  const src = source(activeSide);
  if (!src.ast) return;
  const ed = editors[activeSide];
  const sel = ed.selection;
  const chain = intel.nodePath(src.ast, sel.from);
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = chain[i].node;
    if (n.start <= sel.from && n.end >= sel.to && (n.end - n.start) > (sel.to - sel.from)) { ed.select(n.start, n.end, { scroll: false }); return; }
  }
}

function copyNodePath() {
  const src = source(activeSide);
  if (!src.ast) return;
  const p = intel.pathString(intel.nodePath(src.ast, editors[activeSide].cursor));
  navigator.clipboard.writeText(p).then(() => setStatus('status.copiedPath', {}, 'ok'), () => rawStatus(p));
}

// ── satır notları ve yer imleri (132) ──
async function editNote(side = activeSide, pos = editors[side].cursor) {
  const ed = editors[side];
  const cur = ed.noteAt(pos);
  const text = await promptText(t('notes.title', { l: ed.lineAt(pos).number }), { label: t('notes.label'), value: cur, multiline: true });
  if (text === undefined) return;
  ed.setNote(pos, text.trim().slice(0, 4000));
  marksChanged();
}
function toggleBookmark() { editors[activeSide].toggleBookmark(); marksChanged(); }
function marksChanged() { ws.persist(); emit('marks'); }

// ── katmanlar: kapsam renkleri (E297), ölü kod (E299), güven ısı haritası (E300) ──
function refreshLayers() {
  const s = settings();
  for (const side of ['in', 'out']) {
    const ed = editors[side];
    const want = s.scopeColors || s.deadLayer || s.trustLayer;
    if (!want || !ed.length || ed.length > LAYER_MAX) {
      for (const n of ['scope', 'dead', 'trust']) if (ed.hasLayer(n)) ed.setLayer(n, []);
      continue;
    }
    const src = source(side);
    if (!src.ast) continue;
    ed.setLayer('scope', s.scopeColors ? intel.scopeColors(src.ast).map((r) => ({ from: r.start, to: r.end, cls: r.global ? 'cm-scope-g' : `cm-scope-${r.scope % 8}` })) : []);
    ed.setLayer('dead', s.deadLayer ? intel.deadCode(src.ast).map((r) => ({ from: r.start, to: r.end, cls: 'cm-dead', title: t(`dead.${r.note}`) })) : []);
    if (s.trustLayer) {
      const score = intel.trustMap(src.code, src.ast);
      const ranges = [];
      let pos = 0;
      const lines = src.code.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (score[i] < 0.85) ranges.push({ from: pos, to: pos, line: true, cls: score[i] < 0.5 ? 'cm-trust-lo' : 'cm-trust-mid' });
        pos += lines[i].length + 1;
      }
      ed.setLayer('trust', ranges);
    } else ed.setLayer('trust', []);
  }
}

// ── bağlam menüsü (E254) ──
function editorMenu(side, pt, pos) {
  activeSide = side;
  const src = source(side);
  const sym = src.ast ? intel.symbolAt(src.ast, pos) : null;
  const k = (id) => displayKey(keyOf(id), isMac);
  const sel = editors[side].selection;
  contextMenu(pt.x, pt.y, [
    { label: t('cmd.gotoDef'), key: k('gotoDef'), disabled: !sym?.def, run: gotoDefinition },
    { label: t('cmd.refs'), key: k('refs'), disabled: !sym, run: () => { const r = symbolHere(); if (r) showRefs(r); } },
    { label: t('cmd.rename'), key: k('rename'), disabled: sym?.kind !== 'binding', run: renameSymbol },
    'sep',
    { label: t('cmd.selectNode'), key: k('selectNode'), disabled: !src.ast, run: selectNode },
    { label: t('cmd.showInAst'), disabled: !src.ast, run: () => showTool('ast') },
    { label: t('cmd.copyPath'), disabled: !src.ast, run: copyNodePath },
    side === 'out' ? { label: t('cmd.showInInput'), key: k('showInInput'), run: () => showInInput(true) } : { label: t('cmd.showInOutput'), disabled: !edOut.length, run: showInOutput },
    { label: t('cmd.cfgHere'), disabled: !src.ast, run: () => { const g = showTool('graph'); g.show('cfg'); g.refresh(); } },
    { label: t('cmd.similar'), disabled: !src.ast, run: () => showTool('search').runWith('similar') },
    sym ? { label: t('cmd.searchSymbol', { n: sym.name.slice(0, 30) }), run: () => showTool('search').runWith('text', sym.name) } : null,
    'sep',
    { label: t('cmd.runSelection'), key: k('runSelection'), disabled: sel.from === sel.to, run: runSelection },
    { label: t('cmd.toggleBookmark'), key: k('toggleBookmark'), run: toggleBookmark },
    { label: t('cmd.addNote'), key: k('addNote'), run: () => editNote(side, pos) },
  ].filter(Boolean));
}
function menuAtCursor() {
  const ed = editors[activeSide];
  const c = ed.view.coordsAtPos(ed.cursor);
  editorMenu(activeSide, { x: c?.left ?? 100, y: c?.bottom ?? 100 }, ed.cursor);
}

// ── araç panelleri ve düzen (E265) ──
let toolsA = createTools($('pane-tools-1'), appApi(), { initial: 'search', index: 1 });
let toolsB = createTools($('pane-tools-2'), appApi(), { initial: 'graph', index: 2 });
function appApi() {
  return {
    text: (side) => editors[side].text,
    source,
    editor: (side) => editors[side],
    jump,
    status: (msg) => rawStatus(msg),
    setLayer: (side, name, ranges) => editors[side].setLayer(name, ranges),
    on,
    doc: () => ws.active,
    docs: () => ws.docs,
    groupDocs: () => ws.groupDocs(),
    switchDoc: (id) => ws.switchTo(id),
    searches: () => ws.searches(),
    addSearch: (s) => ws.addSearch(s),
    searchHistory: () => ws.searchHistory(),
    pushSearchHistory: (q) => ws.pushHistory(q),
    layers: () => ws.active?.layers ?? [],
    openDoc: (o) => ws.add(o),
    tools: () => toolsA,
    showTool: (n) => showTool(n),
    openTimeline: (i) => { selectTab('timeline'); timeline.show(i); },
    activeSide: () => activeSide,
    editNote,
    toggleBookmark,
    marksChanged,
    previewPass,
    run: (o) => run(o),
    runSelection,
  };
}
function showTool(name) {
  if (settings().layout === 2) update({ layout: 3 });
  if (document.body.classList.contains('mobile')) panels.setPane('tools');
  if (document.body.classList.contains('focus-mode')) setFocusMode(false);
  if (document.body.classList.contains('reading')) setReading(false);
  toolsA.show(name);
  return toolsA.tool(name);
}

const panels = initPanels({
  split: settings().split,
  onSplit: (v) => updateSoon({ split: Math.round(v) }),
  onFiles: async (dt) => { const { files, group } = await ws.filesFromDrop(dt); ws.loadFiles(files, { groupName: group }); },
  onPane: () => { for (const ed of Object.values(editors)) ed.view.requestMeasure(); },
});
let splitTimer;
const updateSoon = (patch) => { clearTimeout(splitTimer); splitTimer = setTimeout(() => update(patch), 300); };

// ── modlar: okuma (E276/130), odak (E274), tam ekran (E275) ──
function setReading(on) {
  update({ reading: on });
}
function setFocusMode(on) {
  document.body.classList.toggle('focus-mode', on);
  document.body.dataset.focusSide = activeSide;
  if (on) { editors[activeSide].focus(); toast(t('focus.on'), 'info'); }
  announce(t(on ? 'focus.on' : 'focus.off'));
  for (const ed of Object.values(editors)) ed.view.requestMeasure();
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch((e) => setStatus('status.error', { m: e.message }, 'err'));
}

// İki parmakla yakınlaştırma (E285): editörde yazı boyutu
function pinchZoom(el) {
  const pts = new Map();
  let start = null;
  el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') pts.set(e.pointerId, e); });
  el.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, e);
    if (pts.size !== 2) return;
    const [a, b] = [...pts.values()];
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (!start) { start = { d, size: settings().fontSize }; return; }
    const size = Math.round(Math.max(9, Math.min(32, start.size * (d / start.d))));
    if (size !== settings().fontSize) updateSoon({ fontSize: size });
  });
  const end = (e) => { pts.delete(e.pointerId); if (pts.size < 2) start = null; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// ── ayarların uygulanması ──
const mq = matchMedia('(prefers-color-scheme: light)');
const mobileMq = matchMedia('(max-width: 767px)');
function applySettings(s, patch = {}) {
  const theme = s.theme === 'system' ? (mq.matches ? 'light' : 'dark') : s.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.palette = s.palette;
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0c0c0c';
  const view = editorView();
  edIn.configure(view);
  edOut.configure(s.reading ? { ...view, wrap: true, fontSize: s.fontSize + 2, minimap: false } : view);
  timeline.configure(view);
  const layoutChanged = main.dataset.layout !== String(s.layout);
  main.dataset.layout = String(s.layout);
  const wasHidden = [$('pane-tools-1').hidden, $('pane-tools-2').hidden];
  $('pane-tools-1').hidden = s.layout < 3 && !document.body.classList.contains('mobile');
  $('pane-tools-2').hidden = s.layout < 4 || document.body.classList.contains('mobile');
  $('divider2').hidden = s.layout < 3;
  document.body.classList.toggle('reading', s.reading);
  $('btn-reading').setAttribute('aria-pressed', String(s.reading));
  if (s.reading && activeTab !== 'code') selectTab('code');
  if (s.reading && document.body.classList.contains('mobile')) panels.setPane('out');
  if (['scopeColors', 'deadLayer', 'trustLayer'].some((k) => k in patch) || !Object.keys(patch).length) refreshLayers();
  if ('mapToInput' in patch && !s.mapToInput) edIn.setLayer('map', []);
  for (const ed of Object.values(editors)) ed.view.requestMeasure();
  // gizliyken kurulmuş araç paneli görünür olunca güncel belgeyle yenilensin
  if (layoutChanged || (wasHidden[0] && !$('pane-tools-1').hidden)) toolsA?.refresh();
  if (layoutChanged || (wasHidden[1] && !$('pane-tools-2').hidden)) toolsB?.refresh();
}
onSettings(applySettings);
mq.addEventListener('change', () => applySettings(settings()));
const applyMobile = () => { document.body.classList.toggle('mobile', mobileMq.matches); applySettings(settings()); };
mobileMq.addEventListener('change', applyMobile);

function viewMenu(btn, side) {
  const s = settings();
  const r = btn.getBoundingClientRect();
  const item = (key, label) => ({ label: `${s[key] ? '✓ ' : ' '}${label}`, run: () => update({ [key]: !s[key] }) });
  contextMenu(r.left, r.bottom + 4, [
    item('wrap', t('settings.wrap')), item('invisibles', t('settings.invisibles')), item('hexLines', t('settings.hexLines')),
    item('minimap', t('settings.minimap')), item('indentGuides', t('settings.indentGuides')), item('activeLine', t('settings.activeLine')),
    item('ligatures', t('settings.ligatures')), 'sep',
    item('scopeColors', t('settings.scopeColors')), item('deadLayer', t('settings.deadLayer')), item('trustLayer', t('settings.trustLayer')), 'sep',
    item('syncScroll', t('settings.syncScroll')), item('mapToInput', t('settings.mapToInput')), 'sep',
    { label: t('cmd.foldAll'), run: () => foldAll(editors[side].view) },
    { label: t('cmd.unfoldAll'), run: () => unfoldAll(editors[side].view) },
    { label: t('cmd.zoomIn'), key: displayKey(keyOf('zoomIn'), isMac), run: () => runCommand('zoomIn') },
    { label: t('cmd.zoomOut'), key: displayKey(keyOf('zoomOut'), isMac), run: () => runCommand('zoomOut') },
  ]);
}

function openMenu(btn) {
  const r = btn.getBoundingClientRect();
  const k = (id) => displayKey(keyOf(id), isMac);
  contextMenu(r.left, r.bottom + 4, [
    { label: t('cmd.openFile'), key: k('openFile'), run: () => $('file').click() },
    { label: t('cmd.openFolder'), key: k('openFolder'), run: () => $('folder').click() },
    { label: t('cmd.openUrl'), key: k('openUrl'), run: () => ws.fromUrl() },
    'sep',
    { label: t('cmd.newTab'), key: k('newTab'), run: () => ws.add({}) },
    { label: t('cmd.importSession'), run: () => $('session-file').click() },
    { label: t('cmd.exportSession'), key: k('exportSession'), run: exportSession },
  ]);
}

// ── oturum JSON (E260) ──
function exportSession() {
  const data = { ...ws.serialize(), settings: settings() };
  download(`peel-session-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
  setStatus('status.sessionExported', {}, 'ok');
}
async function importSession(file) {
  try {
    if (file.size > 200 * 1024 * 1024) throw new Error(t('ws.tooBig', { n: file.name }));
    const raw = JSON.parse(await file.text());
    if (raw?.format !== 'peel-session') throw new Error(t('session.badFormat'));
    if (!(await confirmDialog(t('session.importTitle'), t('session.importBody', { n: Array.isArray(raw.docs) ? raw.docs.length : 0 }), { ok: t('session.import') }))) return;
    if (raw.settings) update(sanitizeSettings(raw.settings));
    ws.restore(raw);
    ws.persist();
    setStatus('status.sessionImported', {}, 'ok');
  } catch (e) {
    setStatus('status.error', { m: e.message }, 'err');
  }
}
async function clearSessionCmd() {
  if (await confirmDialog(t('session.clearTitle'), t('session.clearBody'), { ok: t('session.clear'), danger: true })) {
    await ws.clearAll();
    setStatus('status.sessionCleared', {}, 'ok');
  }
}

function loadSample() {
  edIn.setText(SAMPLE);
  edIn.focus();
}

function cycleSetting(key, values) {
  const s = settings();
  update({ [key]: values[(values.indexOf(s[key]) + 1) % values.length] });
  toast(`${t(`settings.${key}`)}: ${t(`settings.${key}.${settings()[key]}`)}`, 'info', 1500);
}

// ── komutlar (121/E261, E262, 137) ──
const G = { file: 'cmd.group.file', run: 'cmd.group.run', nav: 'cmd.group.nav', search: 'cmd.group.search', view: 'cmd.group.view', tools: 'cmd.group.tools', marks: 'cmd.group.marks' };
const cmd = (id, key, group, runFn, extra = {}) => ({ id, key, group, title: () => t(`cmd.${id}`), run: runFn, ...extra });
const toggleCmd = (id, key, settingKey) => cmd(id, key, G.view, () => { update({ [settingKey]: !settings()[settingKey] }); toast(`${t(`settings.${settingKey}`)}: ${t(settings()[settingKey] ? 'ui.on' : 'ui.off')}`, 'info', 1400); });
const notRunning = () => !controller;
register(
  cmd('palette', 'Ctrl+Shift+P', null, () => openPalette({ gotoLine, symbols: paletteSymbols })),
  cmd('paletteAlt', 'F1', null, () => openPalette({ gotoLine, symbols: paletteSymbols })),
  cmd('shortcuts', 'Shift+F1', null, openShortcuts),
  cmd('settings', 'Ctrl+,', null, () => openSettings({ onClearSession: clearSessionCmd })),
  cmd('openFile', 'Ctrl+O', G.file, () => $('file').click()),
  cmd('openFolder', 'Ctrl+Alt+O', G.file, () => $('folder').click()),
  cmd('openUrl', 'Ctrl+Alt+U', G.file, () => ws.fromUrl()),
  cmd('newTab', 'Alt+N', G.file, () => ws.add({})),
  cmd('closeTab', 'Alt+W', G.file, () => ws.close(ws.active.id)),
  cmd('nextTab', 'Alt+PageDown', G.file, () => ws.next(1)),
  cmd('prevTab', 'Alt+PageUp', G.file, () => ws.next(-1)),
  cmd('renameTab', null, G.file, () => ws.rename(ws.active.id)),
  cmd('newGroup', null, G.file, () => ws.newGroupForActive()),
  cmd('runGroup', null, G.run, () => ws.active?.group ? runGroup(ws.active.group) : setStatus('status.noGroup', {}, 'err'), { when: notRunning }),
  cmd('saveSession', 'Ctrl+S', G.file, () => { if (!settings().persist) { setStatus('status.persistOff', {}, 'err'); return; } ws.persist(); setStatus('status.sessionSaved', {}, 'ok'); }),
  cmd('exportSession', 'Ctrl+Shift+S', G.file, exportSession),
  cmd('importSession', null, G.file, () => $('session-file').click()),
  cmd('clearSession', null, G.file, clearSessionCmd),
  cmd('sample', null, G.file, loadSample),
  cmd('copyOutput', null, G.file, () => $('btn-copy').click()),
  cmd('downloadOutput', null, G.file, () => $('btn-dl').click()),
  cmd('run', 'Ctrl+Enter', G.run, () => run(), { when: notRunning }),
  cmd('stop', 'Ctrl+.', G.run, stop),
  cmd('dryRun', 'Ctrl+Shift+Enter', G.run, () => run({ mode: 'dry' }), { when: notRunning }),
  cmd('stepRun', 'Ctrl+Alt+Enter', G.run, () => run({ mode: 'step' }), { when: notRunning }),
  cmd('runSelection', 'Ctrl+Shift+R', G.run, runSelection, { when: notRunning }),
  cmd('reformat', 'Ctrl+Alt+L', G.run, async () => { if (edOut.length) edOut.setText(await formatCode(edOut.text)); }),
  cmd('passes', null, G.run, () => showTool('passes')),
  cmd('gotoDef', 'F12', G.nav, gotoDefinition),
  cmd('refs', 'Shift+F12', G.nav, () => { const r = symbolHere(); if (r) showRefs(r); }),
  cmd('rename', 'F2', G.nav, renameSymbol),
  cmd('symbols', 'Ctrl+Shift+O', G.nav, () => { showTool('symbols'); toolsA.tool('symbols').focus(); }),
  cmd('gotoLine', 'Ctrl+G', G.nav, async () => {
    const v = await promptText(t('cmd.gotoLine'), { label: t('palette.lineLabel'), validate: (x) => (/^\d+$/.test(x.trim()) ? null : t('palette.lineLabel')) });
    if (v) gotoLine(Number(v));
  }),
  cmd('back', 'Alt+ArrowLeft', G.nav, () => goNav(-1)),
  cmd('forward', 'Alt+ArrowRight', G.nav, () => goNav(1)),
  cmd('selectNode', 'Ctrl+Alt+ArrowUp', G.nav, selectNode),
  cmd('showInInput', 'Ctrl+Alt+I', G.nav, () => showInInput(true)),
  cmd('showInOutput', null, G.nav, showInOutput),
  cmd('contextMenu', 'Shift+F10', G.nav, menuAtCursor),
  cmd('switchSide', 'F6', G.nav, () => { activeSide = activeSide === 'in' ? 'out' : 'in'; if (activeSide === 'out') selectTab('code'); editors[activeSide].focus(); }),
  cmd('undo', null, G.nav, () => undo(editors[activeSide].view)),
  cmd('redo', null, G.nav, () => redo(editors[activeSide].view)),
  cmd('selectAll', null, G.nav, () => selectAll(editors[activeSide].view)),
  cmd('findInEditor', null, G.search, () => openSearchPanel(editors[activeSide].view)),
  cmd('searchTool', 'Ctrl+Shift+F', G.search, () => { showTool('search'); toolsA.tool('search').focus(); }),
  cmd('findNext', 'F3', G.search, () => { const v = editors[activeSide].view; if (searchPanelOpen(v.state)) findNext(v); else toolsA.tool('search').next(1); }),
  cmd('findPrev', 'Shift+F3', G.search, () => { const v = editors[activeSide].view; if (searchPanelOpen(v.state)) findPrevious(v); else toolsA.tool('search').next(-1); }),
  ...['remnants', 'entropy', 'duplicates', 'similar', 'undefined', 'unused', 'long', 'nesting', 'magic'].map((m) => ({
    id: `lens.${m}`, group: G.search, title: () => `${t('cmd.lens')}: ${t(`search.mode.${m}`)}`, run: () => showTool('search').runWith(m),
  })),
  cmd('toggleBookmark', 'Ctrl+B', G.marks, toggleBookmark),
  cmd('nextBookmark', 'F8', G.marks, () => editors[activeSide].nextBookmark(1)),
  cmd('prevBookmark', 'Shift+F8', G.marks, () => editors[activeSide].nextBookmark(-1)),
  cmd('addNote', 'Ctrl+Alt+N', G.marks, () => editNote()),
  cmd('notes', null, G.marks, () => showTool('notes')),
  cmd('zoomIn', 'Ctrl+=', G.view, () => update({ fontSize: settings().fontSize + 1 })),
  cmd('zoomOut', 'Ctrl+-', G.view, () => update({ fontSize: settings().fontSize - 1 })),
  cmd('zoomReset', 'Ctrl+0', G.view, () => update({ fontSize: 13 })),
  toggleCmd('wrap', 'Alt+Z', 'wrap'),
  toggleCmd('invisibles', null, 'invisibles'),
  toggleCmd('hexLines', null, 'hexLines'),
  toggleCmd('minimap', null, 'minimap'),
  toggleCmd('indentGuides', null, 'indentGuides'),
  toggleCmd('activeLine', null, 'activeLine'),
  toggleCmd('ligatures', null, 'ligatures'),
  toggleCmd('scopeColors', null, 'scopeColors'),
  toggleCmd('deadLayer', null, 'deadLayer'),
  toggleCmd('trustLayer', null, 'trustLayer'),
  toggleCmd('syncScroll', null, 'syncScroll'),
  toggleCmd('mapToInput', null, 'mapToInput'),
  cmd('reading', 'Ctrl+Alt+R', G.view, () => setReading(!settings().reading)),
  cmd('focusMode', 'Ctrl+Alt+F', G.view, () => setFocusMode(!document.body.classList.contains('focus-mode'))),
  cmd('exitModes', 'Escape', G.view, () => { setFocusMode(false); if (settings().reading) setReading(false); }, {
    when: () => (document.body.classList.contains('focus-mode') || settings().reading) && !document.querySelector('.cm-panel.cm-search, .ctx-menu'),
  }),
  cmd('fullscreen', 'Shift+F11', G.view, toggleFullscreen),
  cmd('layout2', 'Ctrl+Alt+2', G.view, () => update({ layout: 2 })),
  cmd('layout3', 'Ctrl+Alt+3', G.view, () => update({ layout: 3 })),
  cmd('layout4', 'Ctrl+Alt+4', G.view, () => update({ layout: 4 })),
  cmd('theme', null, G.view, () => cycleSetting('theme', ['dark', 'light', 'contrast', 'system'])),
  cmd('palette.colors', null, G.view, () => cycleSetting('palette', ['default', 'deutan', 'protan', 'tritan'])),
  cmd('language', null, G.view, () => toggleLang()),
  cmd('toggleLog', 'Ctrl+J', G.view, () => setLog()),
  cmd('tabCode', 'Alt+1', G.view, () => selectTab('code', true)),
  cmd('tabReport', 'Alt+2', G.view, () => selectTab('report', true)),
  cmd('tabTimeline', 'Alt+3', G.view, () => selectTab('timeline', true)),
  cmd('tabDiff', 'Alt+4', G.view, () => selectTab('diff', true)),
  ...TOOLS.map((n) => ({ id: `tool.${n}`, group: G.tools, title: () => `${t('cmd.openTool')}: ${t(`tool.${n}`)}`, run: () => showTool(n) })),
  ...['call', 'cfg', 'dataflow', 'deps', 'state'].map((k) => ({ id: `graph.${k}`, group: G.tools, title: () => `${t('tool.graph')}: ${t(`graph.kind.${k}`)}`, run: () => { const g = showTool('graph'); g.show(k); } })),
  ...['strings', 'proxies', 'shadows', 'layers', 'complexity'].map((k) => ({ id: `table.${k}`, group: G.tools, title: () => `${t('tool.tables')}: ${t(`tables.kind.${k}`)}`, run: () => showTool('tables').show(k) })),
  ...['heat', 'complexity', 'opcodes', 'memory', 'nodes', 'compare'].map((k) => ({ id: `chart.${k}`, group: G.tools, title: () => `${t('tool.charts')}: ${t(`charts.kind.${k}`)}`, run: () => showTool('charts').show(k) })),
);

function gotoLine(n) {
  const ed = editors[activeSide];
  const pos = ed.posOfLine(n);
  jump(activeSide, pos, pos, { focus: true });
}
function paletteSymbols() {
  const side = activeSide;
  const src = source(side);
  return src.ast ? intel.symbols(src.ast).map((s) => ({ name: s.name, kind: t(`symbols.kind.${s.kind}`), go: () => jump(side, s.start, s.end, { focus: true, flash: true }) })) : [];
}

// ── olay bağlama ──
runBtn.addEventListener('click', () => run());
stopBtn.addEventListener('click', stop);
$('btn-load').addEventListener('click', (e) => openMenu(e.currentTarget));
$('btn-empty-open').addEventListener('click', () => $('file').click());
$('btn-sample').addEventListener('click', loadSample);
$('btn-empty-sample').addEventListener('click', loadSample);
$('btn-palette').addEventListener('click', () => runCommand('palette'));
$('btn-settings').addEventListener('click', () => runCommand('settings'));
$('btn-view-in').addEventListener('click', (e) => viewMenu(e.currentTarget, 'in'));
$('btn-view-out').addEventListener('click', (e) => viewMenu(e.currentTarget, 'out'));
$('btn-reading').addEventListener('click', () => setReading(!settings().reading));
$('btn-clear').addEventListener('click', () => {
  edIn.setText('');
  edOut.setText('');
  const d = ws.active;
  Object.assign(d, { report: null, events: [], snapshots: [], layers: [], series: [], lastStats: {} });
  resetResultsView();
  clearLog();
  setStatus('status.ready');
  ws.render();
  edIn.focus();
});
$('btn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(edOut.text);
    setStatus('status.copied', {}, 'ok');
  } catch {
    setStatus('status.copyFail', {}, 'err');
  }
});
$('btn-dl').addEventListener('click', () => download(ws.active?.name?.replace(/(\.\w+)?$/, '.peeled.js') || 'peeled.js', edOut.text, 'text/javascript'));
logBtn.addEventListener('click', () => setLog());
$('btn-lang').addEventListener('click', () => toggleLang());
for (const [id, opts] of [['file', {}], ['folder', { folder: true }]]) {
  $(id).addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    const top = opts.folder ? files[0].webkitRelativePath.split('/')[0] : null;
    ws.loadFiles(opts.folder ? files.filter((f) => /\.(m|c)?jsx?$/i.test(f.name)) : files, { groupName: top });
  });
}
$('session-file').addEventListener('change', (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importSession(f); });

for (const tab of outTabs) {
  tab.addEventListener('click', () => selectTab(tab.id.slice(4)));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = outTabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1);
    selectTab(outTabs[(i + outTabs.length) % outTabs.length].id.slice(4), true);
  });
}
document.addEventListener('fullscreenchange', () => document.body.classList.toggle('fullscreen', Boolean(document.fullscreenElement)));

function relabel() {
  applyI18n();
  const code = getLang();
  const lb = $('btn-lang');
  lb.textContent = code.toUpperCase();
  lb.setAttribute('aria-label', `${t('settings.lang')}: ${LANGS.find(([c]) => c === code)?.[1] ?? code}`);
  $('btn-palette').querySelector('kbd').textContent = displayKey(keyOf('palette'), isMac);
  runBtn.querySelector('kbd').textContent = displayKey(keyOf('run'), isMac);
  if (lastStatus[0]) setStatus(...lastStatus);
  setStats(lastStats);
  if (ws.active?.report) safeRenderReport(ws.active.report);
  else renderReport(views.report, null);
  timeline.render();
  diffDirty = true;
  if (activeTab === 'diff') selectTab('diff');
  updateNetworkBadge();
  ws.render();
}
onLang(() => {
  relabel();
  // araç panelleri yeni dilde baştan kurulur (metinler kurulumda yazılır)
  const [a, b] = [toolsA.current, toolsB.current];
  toolsA.destroy();
  toolsB.destroy();
  toolsA = createTools($('pane-tools-1'), appApi(), { initial: a, index: 1 });
  toolsB = createTools($('pane-tools-2'), appApi(), { initial: b, index: 2 });
});
onSettings((_s, patch) => { if ('keymap' in patch) relabel(); });

// ── başlangıç ──
applyMobile();
relabel();
setStatus('status.ready');
renderReport(views.report, null);
timeline.reset();
ws.init().then((restored) => {
  syncEmpty();
  if (restored) setStatus('status.restored', { n: ws.docs.length }, 'ok');
  refreshLayers();
});
updateNetworkBadge();

sandbox.health().then((ok) => {
  sandboxOk = ok;
  if (ok) return;
  log('Sandbox unavailable', 'warn');
  setStatus('status.nosandbox', {}, 'err');
});

// Entegrasyon araçları (karşılaştırma, geçmiş, paylaşım, öğrenme, kurallar/eklentiler, PWA)
// Girdi/çıktı artık CodeMirror editörleri: entegrasyonlar onlara editör API'si üzerinden erişir
const tools = mountIntegrations({
  getInput: () => edIn.text,
  setInput: (text) => { edIn.setText(text); syncEmpty(); },
  getOutput: () => edOut.text,
  setOutput: (text) => edOut.setText(text),
  getSandbox: () => (sandboxOk ? sandbox : null),
  deobfuscate,
  log,
  notify: (msg, kind) => rawStatus(msg, kind === 'ok' ? 'ok' : 'err'),
});

// Anlamlandırma paneli (rapor sekmesi): editörlere aynı API ile erişir
configureNaming({
  getInput: () => edIn.text,
  getOutput: () => edOut.text,
  setOutput: (text) => edOut.setText(text),
});
