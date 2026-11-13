import { t } from '../i18n.js';
import { h, download } from './dom.js';

// SVG grafikleri: çubuk, çizgi, ısı haritası, ağaç haritası. Renkler CSS değişkenlerinden gelir
// (tema ve renk körlüğü paletleri otomatik yansır); etiketler textContent ile yazılır.

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'style') n.setAttribute('style', v);
    else n.setAttribute(k, String(v));
  }
  if (text != null) n.textContent = text;
  return n;
}
const svgRoot = (w, hgt, label) => {
  const root = s('svg', { viewBox: `0 0 ${w} ${hgt}`, width: '100%', role: 'img', 'aria-label': label, class: 'chart' });
  root.append(s('title', {}, label));
  return root;
};
const fmt = (v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e4 ? `${(v / 1e3).toFixed(0)}k` : Number.isInteger(v) ? String(v) : v.toFixed(2));

/** Dışa aktarma düğmeli grafik kartı */
export function chartCard(title, svg, { note } = {}) {
  const exp = h('button', { type: 'button', class: 'tiny', onclick: () => exportChart(svg, title) }, 'SVG');
  return h('figure', { class: 'chart-card' }, h('figcaption', {}, h('span', {}, title), exp), svg, note ? h('p', { class: 'rep-muted small' }, note) : null);
}

export function exportChart(svg, name) {
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', NS);
  // CSS değişkenlerini dışa aktarımda somut renge çevir
  const css = getComputedStyle(svg);
  for (const n of clone.querySelectorAll('[style]')) {
    n.setAttribute('style', n.getAttribute('style').replace(/var\((--[\w-]+)\)/g, (_, v) => css.getPropertyValue(v).trim() || '#888'));
  }
  clone.insertBefore(s('rect', { width: '100%', height: '100%', style: `fill:${css.getPropertyValue('--bg').trim()}` }), clone.firstChild.nextSibling);
  download(`peel-${String(name).toLowerCase().replace(/[^a-z0-9]+/gi, '-')}.svg`, new XMLSerializer().serializeToString(clone), 'image/svg+xml');
}

/** Yatay çubuk grafik: items [{label, value, color?, title?, onClick?}] */
export function barChart(items, { label, unit = '', max } = {}) {
  const rowH = 20;
  const W = 520;
  const lw = 150;
  const H = Math.max(rowH, items.length * rowH) + 8;
  const root = svgRoot(W, H, label);
  const m = max ?? Math.max(1, ...items.map((i) => i.value));
  items.forEach((it, i) => {
    const y = 4 + i * rowH;
    const g = s('g', { class: it.onClick ? 'chart-hit' : null, tabindex: it.onClick ? '0' : null, role: it.onClick ? 'button' : null });
    g.append(s('title', {}, it.title ?? `${it.label}: ${it.value}${unit}`));
    g.append(s('text', { x: lw - 8, y: y + 13, 'text-anchor': 'end', class: 'chart-label' }, it.label.length > 22 ? `${it.label.slice(0, 21)}…` : it.label));
    const w = Math.max(1, ((W - lw - 70) * it.value) / m);
    g.append(s('rect', { x: lw, y: y + 3, width: w, height: rowH - 8, rx: 3, style: `fill:${it.color ?? 'var(--chart-1)'}` }));
    g.append(s('text', { x: lw + w + 6, y: y + 13, class: 'chart-value' }, `${fmt(it.value)}${unit}`));
    if (it.onClick) {
      g.addEventListener('click', it.onClick);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); it.onClick(); } });
    }
    root.append(g);
  });
  return root;
}

/** Çizgi grafik: series [{name, color, points: [{x, y, label?}]}] */
export function lineChart(series, { label, xLabel = '', yLabel = '' } = {}) {
  const W = 560;
  const H = 220;
  const pad = { l: 52, r: 12, t: 12, b: 34 };
  const root = svgRoot(W, H, label);
  const all = series.flatMap((x) => x.points);
  if (!all.length) return root;
  const xmax = Math.max(1, ...all.map((p) => p.x));
  const ymin = Math.min(0, ...all.map((p) => p.y));
  const ymax = Math.max(1, ...all.map((p) => p.y));
  const X = (x) => pad.l + ((W - pad.l - pad.r) * x) / xmax;
  const Y = (y) => H - pad.b - ((H - pad.t - pad.b) * (y - ymin)) / (ymax - ymin || 1);
  for (let i = 0; i <= 4; i++) {
    const v = ymin + ((ymax - ymin) * i) / 4;
    root.append(s('line', { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), class: 'chart-grid' }));
    root.append(s('text', { x: pad.l - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'chart-value' }, fmt(v)));
  }
  root.append(s('text', { x: (W + pad.l) / 2, y: H - 6, 'text-anchor': 'middle', class: 'chart-label' }, xLabel));
  root.append(s('text', { x: 12, y: pad.t + 4, class: 'chart-label' }, yLabel));
  series.forEach((ser, si) => {
    const col = ser.color ?? `var(--chart-${(si % 4) + 1})`;
    const d = ser.points.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
    root.append(s('path', { d, style: `fill:none;stroke:${col};stroke-width:2` }));
    for (const p of ser.points) {
      const c = s('circle', { cx: X(p.x), cy: Y(p.y), r: 3, style: `fill:${col}` });
      c.append(s('title', {}, `${ser.name} · ${p.label ?? p.x}: ${fmt(p.y)}`));
      root.append(c);
    }
  });
  if (series.length > 1) {
    series.forEach((ser, si) => {
      root.append(s('rect', { x: W - pad.r - 140, y: pad.t + si * 16, width: 10, height: 10, style: `fill:${ser.color ?? `var(--chart-${(si % 4) + 1})`}` }));
      root.append(s('text', { x: W - pad.r - 124, y: pad.t + 9 + si * 16, class: 'chart-label' }, ser.name));
    });
  }
  return root;
}

/** Isı haritası: values[row][col] (0..max); yoğunluk saydamlıkla (renk körlüğüne dayanıklı) */
export function heatmap(values, { label, rowLabels = [], colLabel = '', onCell } = {}) {
  const rows = values.length;
  const cols = values[0]?.length ?? 0;
  const cw = 12;
  const rh = 16;
  const lw = 140;
  const W = lw + cols * cw + 10;
  const H = rows * rh + 28;
  const root = svgRoot(W, H, label);
  const max = Math.max(1, ...values.flat());
  values.forEach((row, r) => {
    root.append(s('text', { x: lw - 6, y: r * rh + 12, 'text-anchor': 'end', class: 'chart-label' }, (rowLabels[r] ?? '').slice(0, 20)));
    row.forEach((v, c) => {
      const rect = s('rect', { x: lw + c * cw, y: r * rh, width: cw - 1, height: rh - 2, style: `fill:var(--chart-heat);fill-opacity:${v ? 0.15 + 0.85 * (v / max) : 0.04}` });
      rect.append(s('title', {}, `${rowLabels[r] ?? r} · ${c + 1}/${cols}: ${v}`));
      if (onCell) { rect.classList.add('chart-hit'); rect.addEventListener('click', () => onCell(r, c)); }
      root.append(rect);
    });
  });
  root.append(s('text', { x: lw, y: H - 8, class: 'chart-label' }, colLabel));
  return root;
}

/** Kare ağaç haritası (squarified): items [{label, size, value, onClick}] ; renk = value/max */
export function treemap(items, { label, W = 560, H = 300, valueLabel = '' } = {}) {
  const root = svgRoot(W, H, label);
  const list = items.filter((i) => i.size > 0).sort((a, b) => b.size - a.size).slice(0, 400);
  const total = list.reduce((a, b) => a + b.size, 0) || 1;
  const max = Math.max(1, ...list.map((i) => i.value));
  const scale = (W * H) / total;
  const rects = [];
  let box = { x: 0, y: 0, w: W, h: H };
  let row = [];
  const worst = (r, side) => {
    const sum = r.reduce((a, b) => a + b.area, 0);
    const mx = Math.max(...r.map((x) => x.area));
    const mn = Math.min(...r.map((x) => x.area));
    return Math.max((side * side * mx) / (sum * sum), (sum * sum) / (side * side * mn));
  };
  const layoutRow = (r) => {
    const sum = r.reduce((a, b) => a + b.area, 0);
    const horizontal = box.w >= box.h;
    const side = horizontal ? box.h : box.w;
    const thick = sum / side;
    let off = 0;
    for (const it of r) {
      const len = it.area / thick;
      rects.push(horizontal ? { ...it, x: box.x, y: box.y + off, w: thick, h: len } : { ...it, x: box.x + off, y: box.y, w: len, h: thick });
      off += len;
    }
    box = horizontal ? { x: box.x + thick, y: box.y, w: box.w - thick, h: box.h } : { x: box.x, y: box.y + thick, w: box.w, h: box.h - thick };
  };
  for (const it of list.map((i) => ({ ...i, area: i.size * scale }))) {
    const side = Math.min(box.w, box.h);
    if (!row.length || worst([...row, it], side) <= worst(row, side)) row.push(it);
    else { layoutRow(row); row = [it]; }
  }
  if (row.length) layoutRow(row);
  for (const r of rects) {
    const g = s('g', { class: r.onClick ? 'chart-hit' : null, tabindex: r.onClick ? '0' : null, role: r.onClick ? 'button' : null });
    g.append(s('title', {}, `${r.label} · ${valueLabel} ${r.value}`));
    g.append(s('rect', { x: r.x + 0.5, y: r.y + 0.5, width: Math.max(0, r.w - 1), height: Math.max(0, r.h - 1), style: `fill:var(--chart-heat);fill-opacity:${0.12 + 0.88 * (r.value / max)};stroke:var(--bg)` }));
    if (r.w > 50 && r.h > 16) g.append(s('text', { x: r.x + 4, y: r.y + 13, class: 'chart-label on-heat' }, `${r.label.slice(0, Math.floor(r.w / 7))} ${r.value}`));
    if (r.onClick) {
      g.addEventListener('click', r.onClick);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter') r.onClick(); });
    }
    root.append(g);
  }
  return root;
}

/** Küçük çoklu: her ölçüt için ayrı ölçekli çubuklar (karşılaştırmalı grafik) */
export function smallMultiples(metrics, groups, { label } = {}) {
  const wrap = h('div', { class: 'multiples', role: 'group', 'aria-label': label });
  for (const m of metrics) {
    wrap.append(chartCard(m.label, barChart(groups.map((g, i) => ({ label: g.label, value: g.values[m.key] ?? 0, color: `var(--chart-${(i % 4) + 1})` })), { label: m.label })));
  }
  return wrap;
}

export const emptyChart = (key = 'chart.empty') => h('p', { class: 'placeholder' }, t(key));
