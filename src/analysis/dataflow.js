import { reversePostOrder } from './cfg.js';

// E554/E555: genel worklist sabit nokta çözücüsü. Öncelik = (ters) son sıra indeksi: aynı girdide
// her zaman aynı işlem sırası ve aynı sonuç (Set/Map ekleme sırası dahil) üretilir.

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(x) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p] <= a[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l] < a[m]) m = l;
        if (r < a.length && a[r] < a[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * İleri analiz:  in(n) = ⊔ out(pred) ⊔ exc(excPred);  {out, exc} = transfer(n, in(n))
 * Geri analiz:   out(n) = ⊔ in(succ);  in(n) = transfer(n, out(n), ⊔ in(excHandler))
 * @returns {{ input: any[], output: any[], iterations: number }}
 */
export function solve(g, { direction = 'forward', bottom, boundary, transfer, join, equal, maxIterations = 200000 }) {
  const forward = direction === 'forward';
  const order = reversePostOrder(g, { backward: !forward });
  const rank = new Int32Array(g.nodes.length);
  order.forEach((n, i) => { rank[n.id] = i; });
  const input = g.nodes.map(() => bottom());
  const output = g.nodes.map(() => bottom());
  const excOut = g.nodes.map(() => bottom());

  const excPred = g.nodes.map(() => []);
  for (const n of g.nodes) for (const h of n.exc) excPred[h.id].push(n);

  const heap = new MinHeap();
  const queued = new Uint8Array(g.nodes.length);
  for (const n of order) { heap.push(rank[n.id]); queued[n.id] = 1; }

  let iterations = 0;
  while (heap.size) {
    if (++iterations > maxIterations) throw new Error('dataflow: yineleme sınırı aşıldı');
    const n = order[heap.pop()];
    queued[n.id] = 0;
    if (forward) {
      let inn = n === g.entry ? boundary() : bottom();
      for (const p of n.pred) inn = join(inn, output[p.id]);
      for (const p of excPred[n.id]) inn = join(inn, excOut[p.id]);
      input[n.id] = inn;
      const r = transfer(n, inn);
      const changed = !equal(r.out, output[n.id]) || !equal(r.exc ?? r.out, excOut[n.id]);
      output[n.id] = r.out;
      excOut[n.id] = r.exc ?? r.out;
      if (changed) for (const s of [...n.succ, ...n.exc]) if (!queued[s.id]) { queued[s.id] = 1; heap.push(rank[s.id]); }
    } else {
      let out = n === g.exit ? boundary() : bottom();
      for (const s of n.succ) out = join(out, input[s.id]);
      let exc = bottom();
      for (const h of n.exc) exc = join(exc, input[h.id]);
      output[n.id] = out;
      const inn = transfer(n, out, exc);
      if (!equal(inn, input[n.id])) {
        input[n.id] = inn;
        for (const p of [...n.pred, ...excPred[n.id]]) if (!queued[p.id]) { queued[p.id] = 1; heap.push(rank[p.id]); }
      }
    }
  }
  return { input, output, exc: excOut, iterations };
}

// Küme kafesi yardımcıları
export const setUnion = (a, b) => {
  if (!b.size) return a;
  if (!a.size) return b;
  const r = new Set(a);
  for (const x of b) r.add(x);
  return r;
};
export const setEqual = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
