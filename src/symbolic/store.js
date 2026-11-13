// API: new ConstraintStore(opts): push(), pop(), assert(c) → 'added'|'redundant'|'conflict', check(extra) → {status, model}, implies(c), feasible()
import { mk, show, same, isNegation, vars } from './ir.js';
import { solve } from './solver.js';

// E582: kısıt deposu. Yol koşulları çerçeveli (push/pop) tutulur; eklenen kısıt sadeleştirilir, zaten bilinen
// olgu tekrar eklenmez, bilinenin değili eklenirse çelişki hemen bildirilir. Tatmin sorguları kısıt kümesinin
// kanonik anahtarıyla önbelleğe alınır; sorgu yalnızca değişkenleri paylaşan kısımlarla (bağımsızlık bölmesi)
// çözücüye gider: ayrık kümelerin her biri ayrı ayrı tatmin edilebilirse bütün de tatmin edilebilir.

const sharedCache = new Map();
const MAX_CACHE = 5000;

export class ConstraintStore {
  constructor(o = {}) {
    this.frames = [[]];
    this.o = { mode: 'find', timeMs: 300, maxConflicts: 5000, ...o };
    this.stats = { queries: 0, cacheHits: 0, solverCalls: 0, redundant: 0, conflicts: 0 };
  }

  get facts() { return this.frames.flat(); }
  push() { this.frames.push([]); }
  pop() { if (this.frames.length > 1) this.frames.pop(); }

  /** @returns {'added'|'redundant'|'conflict'} */
  assert(c) {
    const x = mk('truthy', c);
    if (x.k === 'c') {
      if (x.v) { this.stats.redundant++; return 'redundant'; }
      this.stats.conflicts++;
      return 'conflict';
    }
    const facts = this.facts;
    if (facts.some((f) => same(f, x))) { this.stats.redundant++; return 'redundant'; }
    if (facts.some((f) => isNegation(f, x))) { this.stats.conflicts++; return 'conflict'; }
    // anlamsal çelişki (x > 3 ile x <= 3): önbellekli tatmin sorgusu
    if (this.o.eager !== false && facts.length && this.check([x]).status === 'unsat') { this.stats.conflicts++; return 'conflict'; }
    this.frames[this.frames.length - 1].push(x);
    return 'added';
  }

  /** facts ∧ extra tatmin edilebilir mi? { status, model } */
  check(extra = []) {
    this.stats.queries++;
    const all = [...this.facts, ...extra.map((e) => mk('truthy', e))].filter((x) => !(x.k === 'c' && x.v));
    if (all.some((x) => x.k === 'c' && !x.v)) return { status: 'unsat' };
    // bağımsızlık bölmesi: ortak değişkeni olan kısıtlar bir grupta
    const groups = partition(all);
    let model = new Map();
    for (const g of groups) {
      const key = g.map((x) => show(x)).sort().join(' ∧ ');
      let r = sharedCache.get(key);
      if (r) this.stats.cacheHits++;
      else {
        this.stats.solverCalls++;
        r = solve(g, this.o);
        if (sharedCache.size > MAX_CACHE) sharedCache.clear();
        sharedCache.set(key, r);
      }
      if (r.status === 'unsat') return { status: 'unsat', proof: r.proof };
      if (r.status === 'unknown') return { status: 'unknown', reason: r.reason };
      model = new Map([...model, ...r.model]);
    }
    return { status: 'sat', model };
  }

  implies(c) { return this.check([mk('!', c)]).status === 'unsat'; }
  feasible(extra = []) { return this.check(extra).status !== 'unsat'; }
}

function partition(list) {
  const groups = [];
  for (const c of list) {
    const vs = new Set(vars(c).keys());
    const hit = groups.filter((g) => [...vs].some((v) => g.vars.has(v)));
    const merged = { items: [c], vars: vs };
    for (const g of hit) {
      merged.items.push(...g.items);
      g.vars.forEach((v) => merged.vars.add(v));
      groups.splice(groups.indexOf(g), 1);
    }
    groups.push(merged);
  }
  return groups.map((g) => g.items);
}

export function clearStoreCache() { sharedCache.clear(); }
