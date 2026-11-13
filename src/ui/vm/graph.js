import { el } from './dom.js';

// İnteraktif geçiş grafiği (madde 35): katmanlı yerleşim, düğümler sürüklenebilir, tıklanan düğümün
// giren/çıkan kenarları vurgulanır ve koşulları altta listelenir. Koşullu kenarlar kesikli,
// zorlanmış (concolic) kenarlar noktalı çizilir.

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

const DX = 150;
const DY = 64;
const R = 22;

function layout(nodes, edges) {
  const out = new Map(nodes.map((n) => [n, []]));
  for (const e of edges) out.get(e.from)?.push(e.to);
  const start = nodes.includes('GİRİŞ') ? 'GİRİŞ' : nodes[0];
  const layer = new Map([[start, 0]]);
  const queue = [start];
  while (queue.length) {
    const x = queue.shift();
    for (const y of out.get(x) ?? []) if (!layer.has(y)) { layer.set(y, layer.get(x) + 1); queue.push(y); }
  }
  let extra = Math.max(0, ...layer.values()) + 1;
  for (const n of nodes) if (!layer.has(n)) layer.set(n, extra++);
  const rows = new Map();
  const pos = new Map();
  for (const n of nodes) {
    const l = layer.get(n);
    const r = rows.get(l) ?? 0;
    rows.set(l, r + 1);
    pos.set(n, { x: 50 + l * DX, y: 40 + r * DY });
  }
  return pos;
}

export function renderGraph(root, data) {
  root.textContent = '';
  const edges = data.edges ?? [];
  const nodes = [...new Set([...(data.nodes ?? []).map((n) => n.id ?? n), ...edges.flatMap((e) => [e.from, e.to])])].map(String);
  if (!nodes.length) return;
  const pos = layout(nodes, edges.map((e) => ({ from: String(e.from), to: String(e.to) })));
  const w = Math.max(...[...pos.values()].map((p) => p.x)) + 80;
  const h = Math.max(...[...pos.values()].map((p) => p.y)) + 60;
  const s = svg('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', role: 'img', 'aria-label': data.title ?? 'geçiş grafiği' });
  s.style.maxHeight = '520px';
  s.style.background = 'var(--raised, transparent)';
  s.style.borderRadius = '8px';
  const defs = svg('defs');
  const marker = svg('marker', { id: `peel-arrow-${data.id ?? 0}`, viewBox: '0 0 10 10', refX: '10', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
  marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'currentColor' }));
  defs.append(marker);
  s.append(defs);

  const lines = edges.map((e) => {
    const p = svg('path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'marker-end': `url(#peel-arrow-${data.id ?? 0})` });
    if (e.cond) p.setAttribute('stroke-dasharray', '5 3');
    if ((e.sources ?? []).includes('zorlanmış yol')) p.setAttribute('stroke-dasharray', '1 3');
    p.style.color = 'var(--muted, #888)';
    const title = svg('title');
    title.textContent = `${e.from} → ${e.to}${e.cond ? ` [${e.cond}]` : ''}${e.sources ? ` (${e.sources.join(', ')})` : ''}`;
    p.append(title);
    s.append(p);
    return { e, p };
  });
  const route = ({ e, p }) => {
    const a = pos.get(String(e.from));
    const b = pos.get(String(e.to));
    if (!a || !b) return;
    if (a === b) {
      p.setAttribute('d', `M ${a.x - 8} ${a.y - R} C ${a.x - 40} ${a.y - 70}, ${a.x + 40} ${a.y - 70}, ${a.x + 8} ${a.y - R}`);
      return;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const sx = a.x + (dx / len) * R;
    const sy = a.y + (dy / len) * R;
    const tx = b.x - (dx / len) * R;
    const ty = b.y - (dy / len) * R;
    const bend = dx <= 0 ? 40 : 0;
    p.setAttribute('d', `M ${sx} ${sy} Q ${(sx + tx) / 2 + bend} ${(sy + ty) / 2 - bend} ${tx} ${ty}`);
  };
  lines.forEach(route);

  const info = el('div', { class: 'rep-muted' });
  const groups = new Map();
  let selected = null;
  const select = (id) => {
    selected = selected === id ? null : id;
    for (const l of lines) {
      const on = selected && (String(l.e.from) === selected || String(l.e.to) === selected);
      l.p.style.color = on ? 'var(--accent, #f7df1e)' : 'var(--muted, #888)';
      l.p.setAttribute('stroke-width', on ? '2.4' : '1.4');
    }
    for (const [id2, g] of groups) g.querySelector('circle').setAttribute('stroke-width', id2 === selected ? '3' : '1.5');
    info.textContent = '';
    if (!selected) return;
    const outs = edges.filter((e) => String(e.from) === selected);
    const ins = edges.filter((e) => String(e.to) === selected);
    info.append(el('b', {}, `${selected}: `), `${ins.length} giriş, ${outs.length} çıkış`);
    for (const e of outs) info.append(el('div', { class: 'mono' }, `→ ${e.to}${e.cond ? `  [${e.cond}]` : ''}`));
  };

  for (const id of nodes) {
    const p = pos.get(id);
    const g = svg('g', { transform: `translate(${p.x} ${p.y})`, tabindex: '0', role: 'button', 'aria-label': `durum ${id}` });
    g.style.cursor = 'grab';
    const terminal = id === 'ÇIKIŞ' || id === 'GİRİŞ';
    g.append(svg('circle', { r: String(R), fill: 'var(--panel, #1b1b1b)', stroke: terminal ? 'var(--accent, #f7df1e)' : 'var(--line-strong, #555)', 'stroke-width': '1.5' }));
    const label = svg('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': '11', fill: 'var(--text, #eee)' });
    label.style.fontFamily = 'var(--mono, monospace)';
    label.textContent = id.length > 7 ? `${id.slice(0, 6)}…` : id;
    g.append(label);
    const tt = svg('title');
    tt.textContent = id;
    g.append(tt);
    // sürükle: işaretçi olaylarıyla, svg koordinatlarına çevrilerek
    let drag = null;
    g.addEventListener('pointerdown', (ev) => {
      drag = { x: ev.clientX, y: ev.clientY, px: p.x, py: p.y, moved: false };
      g.setPointerCapture(ev.pointerId);
    });
    g.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const scale = w / s.getBoundingClientRect().width;
      p.x = drag.px + (ev.clientX - drag.x) * scale;
      p.y = drag.py + (ev.clientY - drag.y) * scale;
      drag.moved = drag.moved || Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 3;
      g.setAttribute('transform', `translate(${p.x} ${p.y})`);
      lines.filter((l) => String(l.e.from) === id || String(l.e.to) === id).forEach(route);
    });
    g.addEventListener('pointerup', () => {
      if (drag && !drag.moved) select(id);
      drag = null;
    });
    g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(id); } });
    groups.set(id, g);
    s.append(g);
  }
  root.append(s, el('p', { class: 'rep-muted' }, 'Düğümü sürükle; tıklayınca bağlantıları vurgulanır. Kesikli: koşullu kenar, noktalı: zorlanmış yol.'), info);
}
