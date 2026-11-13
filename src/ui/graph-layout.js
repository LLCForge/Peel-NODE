// Grafik yerleşimleri: katmanlı (Sugiyama benzeri), kuvvet yönlü, dairesel ve ızgara.
// Girdi: nodes [{id, w, h}], edges [{from, to}]. Çıktı: Map id → {x, y} (düğüm merkezi).

export const LAYOUTS = ['layered', 'force', 'circle', 'grid'];

export function layout(nodes, edges, kind = 'layered') {
  if (!nodes.length) return new Map();
  if (kind === 'force') return force(nodes, edges);
  if (kind === 'circle') return circle(nodes);
  if (kind === 'grid') return grid(nodes);
  return layered(nodes, edges);
}

function adjacency(nodes, edges) {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const out = nodes.map(() => []);
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) out[a].push(b);
  }
  return out;
}

export function layered(nodes, edges, { gapX = 28, gapY = 56 } = {}) {
  const n = nodes.length;
  const out = adjacency(nodes, edges);
  // 1) döngü kır: DFS geri kenarlarını ters çevir (yinelemeli, büyük grafikte yığın taşmasın)
  const state = new Uint8Array(n);
  const dag = nodes.map(() => []);
  for (let s = 0; s < n; s++) {
    if (state[s]) continue;
    const stack = [[s, 0]];
    state[s] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [v, i] = top;
      if (i < out[v].length) {
        top[1]++;
        const w = out[v][i];
        if (state[w] === 1) dag[w].push(v); // geri kenar → ters
        else {
          dag[v].push(w);
          if (!state[w]) { state[w] = 1; stack.push([w, 0]); }
        }
      } else {
        state[v] = 2;
        stack.pop();
      }
    }
  }
  // 2) en uzun yol katmanlaması (Kahn)
  const indeg = new Int32Array(n);
  for (const list of dag) for (const w of list) indeg[w]++;
  const layer = new Int32Array(n);
  const queue = [];
  for (let v = 0; v < n; v++) if (!indeg[v]) queue.push(v);
  for (let q = 0; q < queue.length; q++) {
    const v = queue[q];
    for (const w of dag[v]) {
      layer[w] = Math.max(layer[w], layer[v] + 1);
      if (--indeg[w] === 0) queue.push(w);
    }
  }
  const layers = [];
  for (let v = 0; v < n; v++) (layers[layer[v]] ??= []).push(v);
  // 3) barycenter sıralaması: aşağı ve yukarı süpürmeler
  const preds = nodes.map(() => []);
  for (let v = 0; v < n; v++) for (const w of dag[v]) preds[w].push(v);
  const pos = new Float64Array(n);
  const reindex = (L) => L.forEach((v, i) => { pos[v] = i; });
  layers.forEach((L) => L && reindex(L));
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? layers.keys() : [...layers.keys()].reverse();
    for (const li of order) {
      const L = layers[li];
      if (!L) continue;
      const nb = down ? preds : dag;
      const bary = new Map(L.map((v) => [v, nb[v].length ? nb[v].reduce((s, u) => s + pos[u], 0) / nb[v].length : pos[v]]));
      L.sort((a, b) => bary.get(a) - bary.get(b));
      reindex(L);
    }
  }
  // 4) koordinatlar
  const res = new Map();
  let y = 0;
  for (const L of layers) {
    if (!L) continue;
    const h = Math.max(...L.map((v) => nodes[v].h));
    const total = L.reduce((s, v) => s + nodes[v].w, 0) + gapX * (L.length - 1);
    let x = -total / 2;
    for (const v of L) {
      res.set(nodes[v].id, { x: x + nodes[v].w / 2, y: y + h / 2 });
      x += nodes[v].w + gapX;
    }
    y += h + gapY;
  }
  return res;
}

// Belirlenimci sözde rastgele: aynı grafik her seferinde aynı yerleşimi alır
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 10000) / 10000; };
}

export function force(nodes, edges) {
  const n = nodes.length;
  const out = adjacency(nodes, edges);
  const avg = nodes.reduce((s, v) => s + Math.max(v.w, v.h), 0) / n;
  const k = avg * 1.6;
  const rand = rng(n * 7919 + edges.length);
  const R = Math.sqrt(n) * k;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; x[i] = Math.cos(a) * R * (0.5 + rand()); y[i] = Math.sin(a) * R * (0.5 + rand()); }
  const iters = Math.max(20, Math.min(300, Math.round(60000 / n)));
  let temp = R / 4;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const cell = k * 2;
  for (let it = 0; it < iters; it++) {
    dx.fill(0);
    dy.fill(0);
    // itme: yalnızca komşu hücrelerdeki düğümler (O(n) ortalama)
    const gridMap = new Map();
    for (let i = 0; i < n; i++) {
      const key = `${Math.floor(x[i] / cell)},${Math.floor(y[i] / cell)}`;
      (gridMap.get(key) ?? gridMap.set(key, []).get(key)).push(i);
    }
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(x[i] / cell);
      const cy = Math.floor(y[i] / cell);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        for (const j of gridMap.get(`${cx + ox},${cy + oy}`) ?? []) {
          if (j <= i) continue;
          let ddx = x[i] - x[j];
          let ddy = y[i] - y[j];
          let d2 = ddx * ddx + ddy * ddy;
          if (d2 < 0.01) { ddx = rand() - 0.5; ddy = rand() - 0.5; d2 = 0.5; }
          const f = (k * k) / d2;
          dx[i] += ddx * f; dy[i] += ddy * f;
          dx[j] -= ddx * f; dy[j] -= ddy * f;
        }
      }
    }
    // çekme: kenarlar
    for (let i = 0; i < n; i++) {
      for (const j of out[i]) {
        const ddx = x[i] - x[j];
        const ddy = y[i] - y[j];
        const d = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
        const f = d / k;
        dx[i] -= ddx * f; dy[i] -= ddy * f;
        dx[j] += ddx * f; dy[j] += ddy * f;
      }
    }
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
      const m = Math.min(d, temp);
      x[i] += (dx[i] / d) * m;
      y[i] += (dy[i] / d) * m;
    }
    temp *= 0.95;
  }
  return new Map(nodes.map((v, i) => [v.id, { x: x[i], y: y[i] }]));
}

export function circle(nodes) {
  const n = nodes.length;
  const per = nodes.reduce((s, v) => s + v.w, 0) + n * 16;
  const r = Math.max(60, per / (2 * Math.PI));
  return new Map(nodes.map((v, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return [v.id, { x: Math.cos(a) * r, y: Math.sin(a) * r }];
  }));
}

export function grid(nodes, gap = 24) {
  const cols = Math.ceil(Math.sqrt(nodes.length));
  const w = Math.max(...nodes.map((v) => v.w)) + gap;
  const h = Math.max(...nodes.map((v) => v.h)) + gap;
  return new Map(nodes.map((v, i) => [v.id, { x: (i % cols) * w, y: Math.floor(i / cols) * h }]));
}

/** Görünür kutuyla kesişen düğümler (sanallaştırma) */
export function visibleNodes(nodes, pos, box) {
  return nodes.filter((v) => {
    const p = pos.get(v.id);
    return p && p.x + v.w / 2 >= box.x0 && p.x - v.w / 2 <= box.x1 && p.y + v.h / 2 >= box.y0 && p.y - v.h / 2 <= box.y1;
  });
}
