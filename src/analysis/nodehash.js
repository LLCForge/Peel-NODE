import * as t from '@babel/types';
import { fnv1a } from '../util/hash.js';

// E551 alt ağaç hash önbelleği, E556 kararlı düğüm kimlikleri, E550 kirli küme.
// Hash yalnızca anlamsal alanlardan hesaplanır (konum, yorum, extra hariç; literal ham metni dahil değil).
// Önbellek düğüm nesnesine bağlıdır: yerinde değiştirilen düğüm için invalidate() çağrılmalı.

const cache = new WeakMap();
const SKIP = new Set(['loc', 'start', 'end', 'leadingComments', 'trailingComments', 'innerComments', 'extra', 'range', 'comments', 'tokens']);
const scalarKeys = new Map();

function scalars(type) {
  let keys = scalarKeys.get(type);
  if (!keys) {
    const visit = new Set(t.VISITOR_KEYS[type] ?? []);
    keys = Object.keys(t.NODE_FIELDS[type] ?? {}).filter((k) => !visit.has(k) && !SKIP.has(k)).sort();
    scalarKeys.set(type, keys);
  }
  return keys;
}

const enc = (v) => (v === undefined ? 'u' : typeof v === 'object' && v !== null ? JSON.stringify(v) : `${typeof v}:${String(v)}`);

/** Düğümün yapısal hash'i (aynı yapı → aynı hash; önbellekli). skip: hash dışı bırakılacak çocuk anahtarı. */
export function structuralHash(node, skip = null) {
  if (node === null || node === undefined) return '0';
  if (!skip) {
    const c = cache.get(node);
    if (c) return c;
  }
  let s = node.type;
  for (const k of scalars(node.type)) s += `|${k}=${enc(node[k])}`;
  for (const k of t.VISITOR_KEYS[node.type] ?? []) {
    if (k === skip) continue;
    const v = node[k];
    if (Array.isArray(v)) s += `|${k}[${v.map((x) => structuralHash(x)).join(',')}]`;
    else s += `|${k}:${structuralHash(v)}`;
  }
  // iki bağımsız 32 bit hash: 64 bit; çakışma olasılığı paylaşım ve eşleme için ihmal edilebilir, store yine de eşitlik doğrular
  const h = fnv1a(s) + fnv1a(`${s.length}:${s}`);
  if (!skip) cache.set(node, h);
  return h;
}

/** E553: yerinde değişen düğüm ve atalarının hash'ini geçersiz kılar (Babel yolu ile). */
export function invalidate(path) {
  for (let p = path; p; p = p.parentPath) cache.delete(p.node);
}

export const isCached = (node) => cache.has(node);

/** Tek düğümün önbellek kaydını siler (yolu bilinmeyen yerinde değişiklikler için). */
export const forget = (node) => { if (node && typeof node === 'object') cache.delete(node); };

const UNIT = (n) => t.isFunction(n) || t.isProgram(n) || t.isStaticBlock(n);

function unitName(node, parent, key) {
  if (t.isProgram(node)) return 'program';
  if (node.id?.name) return node.id.name;
  if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) return parent.id.name;
  if ((t.isObjectProperty(parent) || t.isClassProperty(parent)) && t.isIdentifier(parent.key)) return parent.key.name;
  if ((t.isObjectMethod(node) || t.isClassMethod(node)) && t.isIdentifier(node.key)) return node.key.name;
  if (t.isAssignmentExpression(parent) && t.isMemberExpression(parent.left) && t.isIdentifier(parent.left.property)) return parent.left.property.name;
  return key === 'callee' ? 'iife' : 'anonim';
}

/**
 * E556: kararlı düğüm kimlikleri. Kimlik = birim yolu (adlandırılmış fonksiyon zinciri) + tür + yapısal hash + aynı
 * (birim, tür, hash) içindeki sıra. Aynı kod yeniden parse edilince aynı kimlikler; başka birimdeki değişiklik etkilemez.
 * @param {(node) => boolean} filter kimlik verilecek düğümler (varsayılan: deyimler ve fonksiyonlar)
 * @returns {Map<object, string>}
 */
export function stableIds(ast, filter = (n) => t.isStatement(n) || UNIT(n)) {
  const ids = new Map();
  const counters = new Map();
  const walk = (node, parent, key, unitPath) => {
    if (!node || typeof node.type !== 'string') return;
    let path = unitPath;
    if (UNIT(node)) {
      const base = `${unitPath}/${unitName(node, parent, key)}`;
      const n = (counters.get(`unit:${base}`) ?? 0) + 1;
      counters.set(`unit:${base}`, n);
      path = n > 1 ? `${base}~${n}` : base;
      if (filter(node)) ids.set(node, `${path}:${node.type}`);
    } else if (filter(node)) {
      const k = `${unitPath}:${node.type}:${structuralHash(node)}`;
      const n = (counters.get(k) ?? 0) + 1;
      counters.set(k, n);
      ids.set(node, `${k}#${n}`);
    }
    for (const ck of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[ck];
      if (Array.isArray(v)) for (const x of v) walk(x, node, ck, path);
      else walk(v, node, ck, path);
    }
  };
  walk(ast.type === 'File' ? ast.program : ast, null, null, '');
  return ids;
}

/** Birim (program/fonksiyon) kimliği → yapısal hash. */
export function unitHashes(ast) {
  const ids = stableIds(ast, UNIT);
  const out = new Map();
  for (const [node, id] of ids) out.set(id, { hash: structuralHash(node), node });
  return out;
}

/**
 * E550: iki ağaç arasında kirli birimler. changed: hash'i değişen, added/removed: yalnızca bir tarafta olan.
 * Bir birim değiştiğinde onu içeren birimler de değişmiş sayılır (hash çocukları kapsar).
 */
export function dirtyUnits(prev, next) {
  const a = prev instanceof Map ? prev : unitHashes(prev);
  const b = next instanceof Map ? next : unitHashes(next);
  const changed = [];
  const added = [];
  const removed = [];
  const clean = [];
  for (const [id, v] of b) {
    const old = a.get(id);
    if (!old) added.push(id);
    else if (old.hash !== v.hash) changed.push(id);
    else clean.push(id);
  }
  for (const id of a.keys()) if (!b.has(id)) removed.push(id);
  return { changed, added, removed, clean, map: b };
}
