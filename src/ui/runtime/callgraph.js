import { el, tx, section, muted, table } from './dom.js';

// C61: çalışma anı çağrı grafiği — katmanlı SVG (çağrı derinliğine göre sütunlar) + kenar tablosu.
const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, text = null) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (text != null) n.textContent = text;
  return n;
};

// düğümleri programdan (−1) BFS derinliğine göre katmanlar
export function layout(cg, max = 40) {
  const nodes = cg.nodes.slice(0, max);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = cg.edges.filter((e) => (e.from === -1 || ids.has(e.from)) && ids.has(e.to));
  const depth = new Map([[-1, 0]]);
  const queue = [-1];
  while (queue.length) {
    const cur = queue.shift();
    for (const e of edges) if (e.from === cur && !depth.has(e.to)) { depth.set(e.to, depth.get(cur) + 1); queue.push(e.to); }
  }
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 1);
  const cols = new Map();
  for (const n of [{ id: -1, name: '(program)' }, ...nodes]) {
    const d = depth.get(n.id);
    if (!cols.has(d)) cols.set(d, []);
    cols.get(d).push(n);
  }
  const pos = new Map();
  for (const [d, list] of cols) list.forEach((n, i) => pos.set(n.id, { x: 20 + d * 180, y: 24 + i * 34, name: n.name, calls: n.calls }));
  return { pos, edges, width: 40 + cols.size * 180, height: 40 + Math.max(...[...cols.values()].map((l) => l.length)) * 34 };
}

export function render(root, coverage) {
  root.textContent = '';
  const cg = coverage?.callGraph;
  if (!coverage?.ok || !cg?.nodes.length) { root.append(section(tx('callgraph'), muted(coverage?.error ?? tx('none')))); return; }
  const { pos, edges, width, height } = layout(cg);
  const g = svg('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', role: 'img', 'aria-label': tx('callgraph'), style: 'max-height:360px' });
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    g.append(svg('line', { x1: a.x + 140, y1: a.y, x2: b.x, y2: b.y, stroke: 'currentColor', 'stroke-opacity': 0.35, 'stroke-width': Math.min(4, 1 + Math.log10(e.count)) }));
  }
  for (const [, p] of pos) {
    g.append(svg('rect', { x: p.x, y: p.y - 11, width: 140, height: 22, rx: 4, fill: 'var(--raised, #1a1a1a)', stroke: 'var(--line-strong, #343434)' }));
    g.append(svg('text', { x: p.x + 6, y: p.y + 4, 'font-size': 11, fill: 'currentColor' }, `${p.name.slice(0, 16)}${p.calls != null ? ` ×${p.calls}` : ''}`));
  }
  const name = (id) => (id === -1 ? '(program)' : coverage.functions[id]?.name ?? `#${id}`);
  root.append(section(tx('callgraph'), g,
    table(['caller', 'callee', tx('calls')], cg.edges.map((e) => [name(e.from), name(e.to), e.count]), ['mono', 'mono', 'num']),
    muted(`max depth ${coverage.maxDepth}`)));
}
