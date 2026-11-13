import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { analyzeFunction } from './defs.js';
import { structuralHash, stableIds, dirtyUnits } from './nodehash.js';
import { prototypesPatched } from './ops.js';

// E549 artımlı yeniden analiz, E552 talep odaklı analiz, E553 analiz geçersizleştirme.
// Analiz sonucu birim (fonksiyon/program) başına, yapısal hash'e göre önbelleğe alınan konumdan bağımsız bir özettir:
// düğümler birim içindeki ön-sıra indeksiyle anılır, böylece aynı hash'li birim yeniden parse edilse de özet geçerlidir.

function preorder(root) {
  const list = [];
  const idx = new Map();
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    idx.set(n, list.length);
    list.push(n);
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk); else walk(v);
    }
  };
  walk(root);
  return { list, idx };
}

/** Birim analizini konumdan bağımsız özete çevirir. */
export function summarize(result) {
  const { idx } = preorder(result.fn.node);
  const at = (p) => (p?.node ? idx.get(p.node) : -1);
  const defs = result.defs.map((d) => ({ kind: d.kind, b: d.b, at: d.entry ? -1 : at(d.path) }));
  return {
    bindings: result.bindings.map((b) => b.identifier.name),
    defs,
    uses: result.uses.map((u) => ({ at: at(u.e.path), b: u.e.b, defs: u.defs.map((d) => d.id) })),
    dead: result.deadAssignments.map((d) => d.def.id),
    copies: result.copies.map((c) => ({ at: at(c.use), from: c.from.identifier.name, to: c.to.identifier.name })),
    constants: result.constants.map((c) => ({ at: at(c.use), value: c.value })),
  };
}

export class AnalysisSession {
  constructor() {
    this.cache = new Map(); // birim hash → özet
    this.units = new Map(); // birim kimliği → { hash, node }
    this.stats = { updates: 0, hits: 0, misses: 0, invalidated: 0, lastDirty: null };
    this.ast = null;
    this.models = true;
  }

  /** Yeni ağaç: kirli birimleri bulur, artık var olmayan hash'lerin özetlerini düşürür. */
  update(ast) {
    const next = new Map();
    for (const [node, id] of stableIds(ast, (n) => t.isFunction(n) || t.isProgram(n) || t.isStaticBlock(n))) next.set(id, { hash: structuralHash(node), node });
    const dirty = dirtyUnits(this.units, next);
    const live = new Set([...next.values()].map((v) => v.hash));
    for (const k of [...this.cache.keys()]) if (!live.has(k.split(':')[0])) { this.cache.delete(k); this.stats.invalidated++; }
    this.units = next;
    this.ast = ast;
    this.models = !prototypesPatched(ast, traverse);
    this.stats.updates++;
    this.stats.lastDirty = { changed: dirty.changed.length, added: dirty.added.length, removed: dirty.removed.length, clean: dirty.clean.length };
    return dirty;
  }

  /** Talep odaklı: yalnızca istenen birim analiz edilir (önbellekte yoksa). unitPath: Babel yolu. */
  summaryFor(unitPath) {
    const h = structuralHash(unitPath.node);
    // birim dışı bağlam: prototype yaması, eval/arguments adlarının dışarıda gölgelenmesi
    const ctx = `${this.models ? 1 : 0}${unitPath.scope.getBinding('eval') ? 'e' : ''}${unitPath.scope.getBinding('arguments') ? 'a' : ''}`;
    const key = `${h}:${ctx}`;
    if (this.cache.has(key)) { this.stats.hits++; return this.cache.get(key); }
    this.stats.misses++;
    const s = summarize(analyzeFunction(unitPath, { models: this.models }));
    this.cache.set(key, s);
    return s;
  }

  /** Bir tanımlayıcı kullanımına ulaşan tanımlar: [{ kind, node|null }] ya da null (izlenmeyen değişken). */
  reaching(identPath) {
    const unit = identPath.findParent((p) => p.isFunction() || p.isStaticBlock() || p.isProgram());
    const s = this.summaryFor(unit);
    const { list, idx } = preorder(unit.node);
    const at = idx.get(identPath.node);
    const u = s.uses.find((x) => x.at === at);
    if (!u) return null;
    return u.defs.map((id) => ({ kind: s.defs[id].kind, node: s.defs[id].at >= 0 ? list[s.defs[id].at] : null }));
  }

  /** Bir kullanımın sabit değeri (yoksa undefined + ok:false). */
  constant(identPath) {
    const unit = identPath.findParent((p) => p.isFunction() || p.isStaticBlock() || p.isProgram());
    const s = this.summaryFor(unit);
    const at = preorder(unit.node).idx.get(identPath.node);
    const c = s.constants.find((x) => x.at === at);
    return c ? { ok: true, value: c.value } : { ok: false };
  }

  /** Tüm birimleri analiz eder (önbellekten yararlanarak); artımlı maliyet ölçümü için. */
  analyzeAll(ast = this.ast) {
    const before = this.stats.misses;
    traverse(ast, {
      'Program|Function|StaticBlock'(p) { try { this.summaryFor(p); } catch { /* aşırı büyük/çözümsüz birim */ } },
    });
    return { analyzed: this.stats.misses - before };
  }
}
