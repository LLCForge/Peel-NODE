import { el, tx, section, muted, table } from './dom.js';

// C62 coverage renklendirme + I177 gözlemle üretilen değerler + C63 tuzak işaretleri: satır numaralı kod görünümü.
// data: { code, coverage, observed, traps }

const MAX_LINES = 4000;
const STYLE = {
  hit: 'background:color-mix(in srgb, var(--ok) 12%, transparent)',
  miss: 'background:color-mix(in srgb, var(--err) 12%, transparent)',
  observed: 'background:var(--accent-soft);outline:1px solid var(--accent);border-radius:2px',
};

export function lineModel(code, coverage, observed = [], traps = []) {
  const hits = new Map(coverage?.lines ?? []);
  const obs = new Map();
  for (const o of observed) {
    if (o.line !== o.endLine) continue;
    if (!obs.has(o.line)) obs.set(o.line, []);
    obs.get(o.line).push(o);
  }
  const trapAt = new Map(traps.filter((t) => t.source === 'çıktı').map((t) => [t.line, t.kind]));
  return code.split('\n').slice(0, MAX_LINES).map((text, i) => {
    const n = i + 1;
    return { n, text, hits: hits.has(n) ? hits.get(n) : null, observed: (obs.get(n) ?? []).sort((a, b) => a.column - b.column), trap: trapAt.get(n) ?? null };
  });
}

function lineNode(l) {
  const parts = [];
  let pos = 0;
  for (const o of l.observed) {
    if (o.column < pos) continue;
    parts.push(l.text.slice(pos, o.column));
    parts.push(el('mark', { style: STYLE.observed, title: `${tx('observed')}${o.pass ? ` (${o.pass})` : ''}` }, l.text.slice(o.column, o.endColumn)));
    pos = o.endColumn;
  }
  parts.push(l.text.slice(pos));
  const state = l.hits == null ? '' : l.hits > 0 ? STYLE.hit : STYLE.miss;
  return el('div', { style: `display:flex;gap:8px;${state}`, title: l.hits == null ? null : l.hits > 0 ? `${tx('hit')}: ${l.hits}` : tx('miss') },
    el('span', { class: 'rep-muted', style: 'min-width:4ch;text-align:right;user-select:none' }, String(l.n)),
    el('span', { class: 'rep-muted', style: 'min-width:5ch;text-align:right;user-select:none' }, l.hits == null ? '' : String(l.hits)),
    el('span', { style: 'white-space:pre' }, ...parts),
    l.trap ? el('span', { class: 'chip' }, l.trap) : null);
}

export function render(root, data) {
  root.textContent = '';
  const cov = data?.coverage;
  if (!cov?.ok) { root.append(section(tx('coverage'), muted(cov?.error ?? tx('noSandbox')))); return; }
  const lines = lineModel(data.code ?? '', cov, data.observed ?? [], data.traps ?? []);
  const head = el('p', {}, `${cov.covered} / ${cov.statements} ${tx('covered')} (%${Math.round(cov.ratio * 100)})`);
  const legend = el('p', { class: 'rep-muted' },
    el('span', { style: STYLE.hit }, tx('hit')), ' · ', el('span', { style: STYLE.miss }, tx('miss')), ' · ', el('mark', { style: STYLE.observed }, tx('observed')));
  const view = el('div', { class: 'mono', style: 'max-height:420px;overflow:auto;font-size:12px;line-height:1.5' }, ...lines.map(lineNode));
  const extra = [];
  if (cov.infinite) {
    extra.push(el('p', { class: 'rep-error' }, `${tx('infinite')}: ${cov.infinite.loop ? `${cov.infinite.loop.kind} @${cov.infinite.loop.line}` : '?'}`
      + (cov.infinite.stack.length ? ` ← ${cov.infinite.stack.map((f) => f.name).join(' ← ')}` : '')));
  }
  if (cov.loops.length) extra.push(el('h4', {}, tx('loops')), table(['#', 'line', 'iter'], cov.loops.map((l) => [l.kind, l.line, l.iterations]), ['mono', 'num', 'num']));
  if (data.traps?.length) extra.push(el('h4', {}, tx('traps')), table(['kind', 'line', '', 'code'], data.traps.map((t) => [t.kind, t.line, t.source, t.snippet]), ['mono', 'num', '', 'mono']));
  if (cov.debuggerHits?.length) extra.push(muted(`debugger: ${cov.debuggerHits.map((d) => `@${d.line}×${d.hits}`).join(', ')}`));
  root.append(section(tx('coverage'), head, legend, view, ...extra));
}
