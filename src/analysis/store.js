import * as t from '@babel/types';
import { structuralHash } from './nodehash.js';

// E548: yapısal paylaşım. Anlık görüntüler alt ağaç düzeyinde iç içe geçirilir (hash-consing): pass'ler arasında
// değişmeyen alt ağaçlar bir kez saklanır. Eşitlik hash'e değil, tür + skaler alanlar + çocuk referanslarına bakılarak
// doğrulanır (çocuklar zaten iç içe geçirilmiş olduğundan karşılaştırma sığdır), çakışma veri bozmaz.

const SKIP = new Set(['loc', 'start', 'end', 'leadingComments', 'trailingComments', 'innerComments', 'range', 'comments', 'tokens']);

export class SnapshotStore {
  constructor() {
    this.table = new Map(); // hash → [kayıt]
    this.roots = [];
    this.logical = 0;
    this.stored = 0;
  }

  intern(node) {
    if (node === null || node === undefined) return null;
    this.logical++;
    const visit = t.VISITOR_KEYS[node.type] ?? [];
    const fields = {};
    for (const [k, v] of Object.entries(node)) {
      if (SKIP.has(k) || visit.includes(k) || v === undefined) continue;
      fields[k] = k === 'extra' ? (v && 'raw' in v ? { raw: v.raw, rawValue: v.rawValue } : undefined) : v;
    }
    const kids = {};
    for (const k of visit) {
      const v = node[k];
      kids[k] = Array.isArray(v) ? v.map((x) => this.intern(x)) : this.intern(v ?? null);
    }
    const h = structuralHash(node);
    const bucket = this.table.get(h) ?? [];
    const fieldKey = JSON.stringify(fields, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));
    for (const e of bucket) {
      if (e.type !== node.type || e.fieldKey !== fieldKey) continue;
      let same = true;
      for (const k of visit) {
        const a = e.kids[k];
        const b = kids[k];
        if (Array.isArray(a) ? !(Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])) : a !== b) { same = false; break; }
      }
      if (same) return e;
    }
    const entry = Object.freeze({ type: node.type, fields, fieldKey, kids: Object.freeze(kids) });
    bucket.push(entry);
    this.table.set(h, bucket);
    this.stored++;
    return entry;
  }

  /** Anlık görüntü ekler; döndürür: görüntü indeksi. */
  add(ast, meta = {}) {
    const root = this.intern(ast.type === 'File' ? ast.program : ast);
    this.roots.push({ root, meta });
    return this.roots.length - 1;
  }

  /** Görüntüyü bağımsız (değiştirilebilir) Babel düğümü olarak yeniden kurar. */
  materialize(i) {
    const build = (e) => {
      if (e === null) return null;
      const n = { type: e.type };
      for (const [k, v] of Object.entries(e.fields)) if (v !== undefined) n[k] = k === 'extra' ? { ...v } : structuredCloneSafe(v);
      for (const [k, v] of Object.entries(e.kids)) n[k] = Array.isArray(v) ? v.map(build) : build(v);
      return n;
    };
    return build(this.roots[i].root);
  }

  stats() {
    return { snapshots: this.roots.length, logicalNodes: this.logical, storedNodes: this.stored, sharing: this.logical ? 1 - this.stored / this.logical : 0 };
  }
}

function structuredCloneSafe(v) {
  if (v === null || typeof v !== 'object') return v;
  return Array.isArray(v) ? v.map(structuredCloneSafe) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, structuredCloneSafe(x)]));
}
