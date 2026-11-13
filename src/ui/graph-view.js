import { t } from '../i18n.js';
import { h, download } from './dom.js';
import { layout, LAYOUTS, visibleNodes } from './graph-layout.js';

// Kanvas grafik görüntüleyici: yakınlaştırma/kaydırma (fare, klavye, iki parmak), yerleşim seçimi,
// filtreleme, arama, SVG/PNG dışa aktarma. Yalnızca görünür düğüm ve kenarlar çizilir (büyük grafikler);
// uzaklaştırınca etiketler ve kutular sadeleşir. Erişilebilirlik için düğüm listesi ayrıca sunulur.

const FONT = '12px "JetBrains Mono Variable", Consolas, monospace';
const KIND_VAR = {
  entry: '--accent', exit: '--accent', function: '--syn-fn', external: '--muted', cond: '--syn-kw', case: '--syn-num',
  state: '--syn-num', return: '--err', throw: '--err', jump: '--warn', missing: '--warn', file: '--syn-str', catch: '--warn',
  var: '--syn-def', let: '--syn-def', const: '--syn-def', param: '--syn-prop', hoisted: '--syn-fn', module: '--syn-def',
};
const MAX_LIST = 2000;

export function createGraphView(host, { onSelect = () => {}, name = 'graph' } = {}) {
  let full = { nodes: [], edges: [] };
  let graph = full;
  let pos = new Map();
  let view = { x: 0, y: 0, k: 1 };
  let selected = null;
  let hits = [];
  let hitIndex = -1;
  let kind = 'layered';
  const measure = document.createElement('canvas').getContext('2d');

  const layoutSel = h('select', { class: 'field small', 'aria-label': t('graph.layout') },
    LAYOUTS.map((l) => h('option', { value: l }, t(`graph.layout.${l}`))));
  const filter = h('input', { class: 'field small', type: 'search', placeholder: t('graph.filter'), 'aria-label': t('graph.filter') });
  const minDeg = h('input', { class: 'field small num', type: 'number', min: '0', max: '50', value: '0', 'aria-label': t('graph.minDegree'), title: t('graph.minDegree') });
  const hideExt = h('input', { type: 'checkbox' });
  const search = h('input', { class: 'field small', type: 'search', placeholder: t('graph.search'), 'aria-label': t('graph.search') });
  const count = h('span', { class: 'count', 'aria-live': 'polite' });
  const btn = (label, fn, aria) => h('button', { type: 'button', class: 'tiny', onclick: fn, 'aria-label': aria ?? label, title: aria ?? label }, label);
  const canvas = h('canvas', { class: 'graph-canvas', tabindex: '0', role: 'img' });
  const tip = h('div', { class: 'graph-tip', hidden: true });
  const list = h('ul', { class: 'graph-list' });
  const listBox = h('details', { class: 'graph-nodes' }, h('summary', {}, t('graph.nodeList')), list);
  const stage = h('div', { class: 'graph-stage' }, canvas, tip);
  host.replaceChildren(
    h('div', { class: 'graph-bar' }, layoutSel, filter, minDeg,
      h('label', { class: 'check' }, hideExt, t('graph.hideExternal')),
      h('span', { class: 'graph-sep' }), search,
      btn('‹', () => jumpHit(-1), t('search.prev')), btn('›', () => jumpHit(1), t('search.next')), count,
      h('span', { class: 'grow' }),
      btn(t('graph.fit'), fit), btn('SVG', exportSvg, t('graph.exportSvg')), btn('PNG', exportPng, t('graph.exportPng'))),
    stage, listBox);

  const css = () => getComputedStyle(host);
  const color = (k) => css().getPropertyValue(KIND_VAR[k] ?? '--text').trim() || '#ccc';

  function sizeNodes(nodes) {
    measure.font = FONT;
    for (const n of nodes) {
      const lines = String(n.label).split('\n').slice(0, 5).map((s) => (s.length > 64 ? `${s.slice(0, 63)}…` : s));
      n._lines = lines;
      n.w = Math.max(...lines.map((s) => measure.measureText(s).width)) + 18;
      n.h = lines.length * 16 + 10;
    }
  }

  function applyFilters() {
    const q = filter.value.trim().toLowerCase();
    const md = Number(minDeg.value) || 0;
    const deg = new Map();
    for (const e of full.edges) { deg.set(e.from, (deg.get(e.from) ?? 0) + 1); deg.set(e.to, (deg.get(e.to) ?? 0) + 1); }
    const keep = new Set(full.nodes.filter((n) => (!q || String(n.label).toLowerCase().includes(q)) && (deg.get(n.id) ?? 0) >= md
      && !(hideExt.checked && n.kind === 'external')).map((n) => n.id));
    graph = { nodes: full.nodes.filter((n) => keep.has(n.id)), edges: full.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) };
    pos = layout(graph.nodes, graph.edges, kind);
    renderList();
    runSearch();
    fit();
  }

  function renderList() {
    list.replaceChildren(...graph.nodes.slice(0, MAX_LIST).map((n) => h('li', {}, h('button', {
      type: 'button', class: 'linkish', onclick: () => { focusNode(n); onSelect(n); },
    }, String(n.label).split('\n')[0]))));
    if (graph.nodes.length > MAX_LIST) list.append(h('li', { class: 'rep-muted' }, t('graph.more', { n: graph.nodes.length - MAX_LIST })));
    canvas.setAttribute('aria-label', t('graph.summary', { n: graph.nodes.length, e: graph.edges.length }));
  }

  function runSearch() {
    const q = search.value.trim().toLowerCase();
    hits = q ? graph.nodes.filter((n) => String(n.label).toLowerCase().includes(q)) : [];
    hitIndex = -1;
    count.textContent = q ? t('search.count', { n: hits.length }) : '';
    draw();
  }

  function jumpHit(d) {
    if (!hits.length) return;
    hitIndex = (hitIndex + d + hits.length) % hits.length;
    focusNode(hits[hitIndex]);
    count.textContent = `${hitIndex + 1}/${hits.length}`;
  }

  function focusNode(n) {
    selected = n.id;
    userMoved = true;
    const p = pos.get(n.id);
    if (p) {
      view.k = Math.max(view.k, 0.9);
      view.x = canvas.clientWidth / 2 - p.x * view.k;
      view.y = canvas.clientHeight / 2 - p.y * view.k;
    }
    draw();
  }

  function bounds(nodes = graph.nodes) {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const n of nodes) {
      const p = pos.get(n.id);
      if (!p) continue;
      x0 = Math.min(x0, p.x - n.w / 2); y0 = Math.min(y0, p.y - n.h / 2);
      x1 = Math.max(x1, p.x + n.w / 2); y1 = Math.max(y1, p.y + n.h / 2);
    }
    return x0 === Infinity ? { x0: 0, y0: 0, x1: 1, y1: 1 } : { x0, y0, x1, y1 };
  }

  // görünmezken (boyut 0) sığdırma ertelenir; panel açılınca ResizeObserver tamamlar
  let needsFit = false;
  let userMoved = false; // kullanıcı kaydırıp yakınlaştırmadıysa boyut değişiminde yeniden sığdır
  function fit() {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    needsFit = !W || !H;
    if (needsFit) return;
    const b = bounds();
    const k = Math.min(2, Math.max(0.02, Math.min((W - 40) / (b.x1 - b.x0 || 1), (H - 40) / (b.y1 - b.y0 || 1))));
    view = { k, x: W / 2 - ((b.x0 + b.x1) / 2) * k, y: H / 2 - ((b.y0 + b.y1) / 2) * k };
    draw();
  }

  // Çizimi ortak tut: kanvas ve PNG dışa aktarma aynı fonksiyonu kullanır
  function paint(ctx, W, H, v, { cull = true } = {}) {
    const box = { x0: -v.x / v.k, y0: -v.y / v.k, x1: (W - v.x) / v.k, y1: (H - v.y) / v.k };
    const vis = cull ? visibleNodes(graph.nodes, pos, box) : graph.nodes;
    const visSet = new Set(vis.map((n) => n.id));
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const c = css();
    const lineCol = c.getPropertyValue('--line-strong').trim();
    const textCol = c.getPropertyValue('--text').trim();
    const mutedCol = c.getPropertyValue('--muted').trim();
    const accent = c.getPropertyValue('--accent').trim();
    const surface = c.getPropertyValue('--raised').trim();
    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.scale(v.k, v.k);
    ctx.lineWidth = 1 / Math.max(v.k, 0.5);
    ctx.font = FONT;
    const hitSet = new Set(hits.map((n) => n.id));
    const curved = kind === 'layered';
    for (const e of graph.edges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      if (cull && !visSet.has(e.from) && !visSet.has(e.to)) {
        if (Math.max(a.x, b.x) < box.x0 || Math.min(a.x, b.x) > box.x1 || Math.max(a.y, b.y) < box.y0 || Math.min(a.y, b.y) > box.y1) continue;
      }
      const na = byId.get(e.from);
      const nb = byId.get(e.to);
      const hot = selected && (e.from === selected || e.to === selected);
      ctx.strokeStyle = hot ? accent : lineCol;
      ctx.fillStyle = ctx.strokeStyle;
      const sy = a.y + (b.y > a.y ? na.h / 2 : -na.h / 2);
      const ty = b.y + (b.y > a.y ? -nb.h / 2 : nb.h / 2);
      ctx.beginPath();
      if (e.from === e.to) {
        ctx.arc(a.x + na.w / 2, a.y, 10, -Math.PI / 2, Math.PI / 2 * 3);
      } else if (curved) {
        ctx.moveTo(a.x, sy);
        const my = (sy + ty) / 2;
        ctx.bezierCurveTo(a.x, my, b.x, my, b.x, ty);
      } else {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      // ok başı
      if (v.k > 0.25 && e.from !== e.to) {
        const tx = b.x;
        const ang = curved ? (b.y > a.y ? Math.PI / 2 : -Math.PI / 2) : Math.atan2(b.y - a.y, b.x - a.x);
        const ex = curved ? tx : b.x - Math.cos(ang) * (nb.w / 2);
        const ey = curved ? ty : b.y - Math.sin(ang) * (nb.h / 2);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - 7 * Math.cos(ang - 0.4), ey - 7 * Math.sin(ang - 0.4));
        ctx.lineTo(ex - 7 * Math.cos(ang + 0.4), ey - 7 * Math.sin(ang + 0.4));
        ctx.fill();
      }
      if (e.label && v.k > 0.6) {
        ctx.fillStyle = mutedCol;
        ctx.fillText(e.label, (a.x + b.x) / 2 + 4, (sy + ty) / 2);
      }
    }
    const detail = v.k > 0.45;
    for (const n of vis) {
      const p = pos.get(n.id);
      const col = color(n.kind);
      const x = p.x - n.w / 2;
      const y = p.y - n.h / 2;
      if (!detail && graph.nodes.length > 1500) {
        ctx.fillStyle = hitSet.has(n.id) || n.id === selected ? accent : col;
        ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
        continue;
      }
      ctx.fillStyle = n.id === selected ? c.getPropertyValue('--accent-soft').trim() : surface;
      ctx.strokeStyle = hitSet.has(n.id) || n.id === selected ? accent : col;
      ctx.lineWidth = (hitSet.has(n.id) || n.id === selected ? 2.5 : 1.2) / Math.max(v.k, 0.5);
      ctx.beginPath();
      ctx.roundRect(x, y, n.w, n.h, 6);
      ctx.fill();
      ctx.stroke();
      if (detail) {
        ctx.fillStyle = n.kind === 'external' ? mutedCol : textCol;
        n._lines.forEach((s, i) => ctx.fillText(s, x + 9, y + 18 + i * 16));
      }
    }
    ctx.restore();
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!graph.nodes.length) {
      ctx.fillStyle = css().getPropertyValue('--faint').trim();
      ctx.font = '13px "Inter Variable", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(t('graph.empty'), W / 2, H / 2);
      ctx.textAlign = 'start';
      return;
    }
    paint(ctx, W, H, view);
  }

  const toWorld = (cx, cy) => ({ x: (cx - view.x) / view.k, y: (cy - view.y) / view.k });
  const nodeAt = (cx, cy) => {
    const w = toWorld(cx, cy);
    for (let i = graph.nodes.length - 1; i >= 0; i--) {
      const n = graph.nodes[i];
      const p = pos.get(n.id);
      if (p && Math.abs(w.x - p.x) <= n.w / 2 && Math.abs(w.y - p.y) <= n.h / 2) return n;
    }
    return null;
  };
  const zoomAt = (cx, cy, f) => {
    const k = Math.max(0.02, Math.min(4, view.k * f));
    view.x = cx - (cx - view.x) * (k / view.k);
    view.y = cy - (cy - view.y) * (k / view.k);
    view.k = k;
    userMoved = true;
    draw();
  };

  // işaretçi: tek parmak/fare kaydırır, iki parmak yakınlaştırır; hareketsiz tık düğüm seçer
  const pointers = new Map();
  let moved = false;
  let pinch = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    moved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) {
      const n = nodeAt(e.offsetX, e.offsetY);
      tip.hidden = !n;
      if (n) { tip.textContent = String(n.label); tip.style.left = `${e.offsetX + 12}px`; tip.style.top = `${e.offsetY + 12}px`; }
      return;
    }
    const cur = { x: e.offsetX, y: e.offsetY };
    pointers.set(e.pointerId, cur);
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (pinch.k * (d / (pinch.d || 1))) / view.k);
      moved = true;
      return;
    }
    if (Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y) > 1) moved = true;
    view.x += cur.x - prev.x;
    view.y += cur.y - prev.y;
    userMoved = true;
    draw();
  });
  const up = (e) => {
    if (pointers.has(e.pointerId) && !moved && pointers.size === 1) {
      const n = nodeAt(e.offsetX, e.offsetY);
      selected = n?.id ?? null;
      draw();
      if (n) onSelect(n);
    }
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); pinch = null; });
  canvas.addEventListener('pointerleave', () => { tip.hidden = true; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const step = 40;
    const k = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (k) { view.x += k[0]; view.y += k[1]; draw(); }
    else if (e.key === '+' || e.key === '=') zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.2);
    else if (e.key === '-') zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.2);
    else if (e.key === '0') fit();
    else return;
    e.preventDefault();
  });
  layoutSel.addEventListener('change', () => { kind = layoutSel.value; applyFilters(); });
  let ft;
  for (const el of [filter, minDeg]) el.addEventListener('input', () => { clearTimeout(ft); ft = setTimeout(applyFilters, 200); });
  hideExt.addEventListener('change', applyFilters);
  search.addEventListener('input', runSearch);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); jumpHit(e.shiftKey ? -1 : 1); } });
  const ro = new ResizeObserver(() => (needsFit || !userMoved ? fit() : draw()));
  ro.observe(stage);

  function exportSvg() {
    const NS = 'http://www.w3.org/2000/svg';
    const b = bounds();
    const pad = 20;
    const svg = document.createElementNS(NS, 'svg');
    const W = b.x1 - b.x0 + pad * 2;
    const H = b.y1 - b.y0 + pad * 2;
    svg.setAttribute('xmlns', NS);
    svg.setAttribute('viewBox', `${b.x0 - pad} ${b.y0 - pad} ${W} ${H}`);
    svg.setAttribute('width', String(Math.round(W)));
    svg.setAttribute('height', String(Math.round(H)));
    const el = (tag, attrs, text) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      if (text != null) n.textContent = text;
      return n;
    };
    const c = css();
    svg.append(el('rect', { x: b.x0 - pad, y: b.y0 - pad, width: W, height: H, fill: c.getPropertyValue('--bg').trim() }));
    const defs = el('defs', {});
    const marker = el('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 10, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    marker.append(el('path', { d: 'M0,0 L10,5 L0,10 z', fill: c.getPropertyValue('--line-strong').trim() }));
    defs.append(marker);
    svg.append(defs);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const e of graph.edges) {
      const a = pos.get(e.from);
      const bb = pos.get(e.to);
      if (!a || !bb) continue;
      const nb = byId.get(e.to);
      const ang = Math.atan2(bb.y - a.y, bb.x - a.x);
      svg.append(el('line', { x1: a.x, y1: a.y, x2: bb.x - Math.cos(ang) * nb.w / 2, y2: bb.y - Math.sin(ang) * nb.h / 2, stroke: c.getPropertyValue('--line-strong').trim(), 'marker-end': 'url(#arrow)' }));
      if (e.label) svg.append(el('text', { x: (a.x + bb.x) / 2, y: (a.y + bb.y) / 2, fill: c.getPropertyValue('--muted').trim(), 'font-family': 'monospace', 'font-size': 11 }, e.label));
    }
    for (const n of graph.nodes) {
      const p = pos.get(n.id);
      svg.append(el('rect', { x: p.x - n.w / 2, y: p.y - n.h / 2, width: n.w, height: n.h, rx: 6, fill: c.getPropertyValue('--raised').trim(), stroke: color(n.kind) }));
      n._lines.forEach((s, i) => svg.append(el('text', { x: p.x - n.w / 2 + 9, y: p.y - n.h / 2 + 18 + i * 16, fill: c.getPropertyValue('--text').trim(), 'font-family': 'monospace', 'font-size': 12 }, s)));
    }
    download(`peel-${name}.svg`, new XMLSerializer().serializeToString(svg), 'image/svg+xml');
  }

  function exportPng() {
    const b = bounds();
    const pad = 20;
    const scale = Math.min(2, 8000 / Math.max(b.x1 - b.x0 + pad * 2, b.y1 - b.y0 + pad * 2));
    const W = Math.ceil((b.x1 - b.x0 + pad * 2) * scale);
    const H = Math.ceil((b.y1 - b.y0 + pad * 2) * scale);
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const ctx = off.getContext('2d');
    ctx.fillStyle = css().getPropertyValue('--bg').trim();
    ctx.fillRect(0, 0, W, H);
    paint(ctx, W, H, { k: scale, x: (pad - b.x0) * scale, y: (pad - b.y0) * scale }, { cull: false });
    off.toBlob((blob) => blob && download(`peel-${name}.png`, blob, 'image/png'), 'image/png');
  }

  return {
    setGraph(g, { keepView = false } = {}) {
      full = { nodes: g.nodes.map((n) => ({ ...n })), edges: g.edges };
      sizeNodes(full.nodes);
      selected = null;
      userMoved = false;
      const v = view;
      applyFilters();
      if (keepView) { view = v; draw(); }
    },
    select(id) { const n = graph.nodes.find((x) => x.id === id); if (n) focusNode(n); },
    redraw: draw,
    destroy() { ro.disconnect(); },
  };
}
