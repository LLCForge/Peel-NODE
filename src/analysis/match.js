import * as t from '@babel/types';
import { structuralHash } from './nodehash.js';

// E563: iki çalıştırma/sürüm arasında düğüm eşleme (GumTree benzeri).
// 1) yukarıdan aşağı: iki tarafta da tekil olan yapısal hash'ler alt ağaçlarıyla eşlenir
// 2) aşağıdan yukarı: eşlenmiş çocuklarının çoğu aynı adaydaki çocuklara giden aynı türden ata eşlenir
// 3) adlandırılmış fonksiyon/değişken bildirimleri ada göre eşlenir
// 4) eşlenmiş ataların aynı anahtar/indeksteki aynı türden çocukları eşlenir

function index(root) {
  const nodes = [];
  const parent = new Map();
  const walk = (n, p) => {
    if (!n || typeof n.type !== 'string') return;
    nodes.push(n);
    if (p) parent.set(n, p);
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) for (const x of v) walk(x, n); else walk(v, n);
    }
  };
  walk(root.type === 'File' ? root.program : root, null);
  return { nodes, parent };
}

const children = (n) => {
  const out = [];
  for (const k of t.VISITOR_KEYS[n.type] ?? []) {
    const v = n[k];
    if (Array.isArray(v)) out.push(...v.map((x, i) => [`${k}.${i}`, x]).filter(([, x]) => x)); else if (v) out.push([k, v]);
  }
  return out;
};

function declName(n) {
  if ((t.isFunctionDeclaration(n) || t.isClassDeclaration(n)) && n.id) return `${n.type}:${n.id.name}`;
  if (t.isVariableDeclarator(n) && t.isIdentifier(n.id)) return `VariableDeclarator:${n.id.name}`;
  return null;
}

/**
 * @returns {{ map: Map<object, object>, reverse: Map<object, object>, stats: object }}
 */
export function matchTrees(a, b, { maxNodes = 300000 } = {}) {
  const A = index(a);
  const B = index(b);
  const map = new Map();
  const reverse = new Map();
  const link = (x, y) => { if (!map.has(x) && !reverse.has(y) && x.type === y.type) { map.set(x, y); reverse.set(y, x); return true; } return false; };
  if (A.nodes.length > maxNodes || B.nodes.length > maxNodes) return { map, reverse, stats: { skipped: true }, parentA: A.parent, parentB: B.parent };

  // özyinelemesiz: derin ikili ifade zincirlerinde yığın taşmasın
  const linkSubtree = (x0, y0) => {
    const stack = [[x0, y0]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (!link(x, y)) continue;
      const cx = children(x);
      const cy = children(y);
      for (let i = 0; i < cx.length && i < cy.length; i++) stack.push([cx[i][1], cy[i][1]]);
    }
  };

  // 1) tekil hash'ler
  const countA = new Map();
  const countB = new Map();
  const byHashB = new Map();
  for (const n of A.nodes) { const h = structuralHash(n); countA.set(h, (countA.get(h) ?? 0) + 1); }
  for (const n of B.nodes) { const h = structuralHash(n); countB.set(h, (countB.get(h) ?? 0) + 1); byHashB.set(h, n); }
  for (const n of A.nodes) {
    if (map.has(n)) continue;
    const h = structuralHash(n);
    if (countA.get(h) === 1 && countB.get(h) === 1) linkSubtree(n, byHashB.get(h));
  }
  // yinelenen hash'ler: eşlenmiş ebeveynlerin altındaki aynı hash'li çocuklar sırayla
  const pairChildren = () => {
    let added = 0;
    for (const [x, y] of [...map]) {
      const cx = children(x).map(([, n]) => n).filter((n) => !map.has(n));
      const cy = children(y).map(([, n]) => n).filter((n) => !reverse.has(n));
      for (const n of cx) {
        const h = structuralHash(n);
        const m = cy.find((c) => !reverse.has(c) && structuralHash(c) === h);
        if (m) { linkSubtree(n, m); added++; }
      }
    }
    return added;
  };
  pairChildren();

  // 3) adlandırılmış bildirimler
  const namedB = new Map();
  for (const n of B.nodes) { const k = declName(n); if (k && !reverse.has(n)) namedB.set(k, namedB.has(k) ? null : n); }
  for (const n of A.nodes) {
    const k = declName(n);
    const m = k && namedB.get(k);
    if (m && !map.has(n)) link(n, m);
  }

  // 2) aşağıdan yukarı
  for (let i = A.nodes.length - 1; i >= 0; i--) {
    const n = A.nodes[i];
    if (map.has(n)) continue;
    const votes = new Map();
    let total = 0;
    for (const [, c] of children(n)) {
      total++;
      const m = map.get(c);
      const pb = m && B.parent.get(m);
      if (pb && pb.type === n.type && !reverse.has(pb)) votes.set(pb, (votes.get(pb) ?? 0) + 1);
    }
    let best = null;
    let bestVotes = 0;
    for (const [cand, v] of votes) if (v > bestVotes) { best = cand; bestVotes = v; }
    if (best && bestVotes * 2 >= total) link(n, best);
  }

  // 4) ebeveynler eşlendiyse aynı konumdaki aynı türden çocuklar
  const queue = [...map];
  while (queue.length) {
    const [x, y] = queue.pop();
    const cy = new Map(children(y));
    for (const [k, c] of children(x)) {
      if (map.has(c)) continue;
      const m = cy.get(k);
      if (m && !reverse.has(m) && m.type === c.type && link(c, m)) queue.push([c, m]);
    }
  }
  // kök her zaman eşlenir
  link(A.nodes[0], B.nodes[0]);
  return { map, reverse, stats: { a: A.nodes.length, b: B.nodes.length, matched: map.size }, parentA: A.parent, parentB: B.parent };
}
