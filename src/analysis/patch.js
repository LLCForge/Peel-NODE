import * as t from '@babel/types';
import { structuralHash, forget } from './nodehash.js';
import { serializeAst, deserializeAst, AST_VERSION } from './serialize.js';

// E562: AST diff/patch biçimi. E559: geri alınabilir dönüşüm günlüğü (her yama tersine çevrilebilir).
// İşlemler: { op: 'splice', path, index, removed: [düğüm], inserted: [düğüm] } dizi üzerinde,
//           { op: 'replace', path, removed: düğüm, inserted: düğüm } tek düğüm yuvasında.
// Sıra: aynı dizide yüksek indeksten düşüğe. Böylece herhangi bir alt küme özgün sırayla uygulanabilir
// ve ters yama işlemleri ters sırada aynı yollarla uygular.

export const PATCH_FORMAT = 'peel-ast-patch';
const ser = (n) => (n ? serializeAst(n).root : null);
const de = (n) => (n ? deserializeAst({ format: 'peel-ast', version: AST_VERSION, root: n }) : null);
const hashOf = (n) => (n ? structuralHash(n) : '0');

function scalarsEqual(a, b) {
  const visit = new Set(t.VISITOR_KEYS[a.type] ?? []);
  for (const k of Object.keys(t.NODE_FIELDS[a.type] ?? {})) {
    if (visit.has(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

// En uzun ortak alt dizi (hash'lerle); büyük orta bölgede tek bölge döner
function lcs(ha, hb, i0, i1, j0, j1) {
  const n = i1 - i0;
  const m = j1 - j0;
  if (!n || !m || n * m > 1_000_000) return [];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = ha[i0 + i] === hb[j0 + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ha[i0 + i] === hb[j0 + j]) { pairs.push([i0 + i, j0 + j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return pairs;
}

function diffArray(a, b, path, ops) {
  const ha = a.map(hashOf);
  const hb = b.map(hashOf);
  let p = 0;
  while (p < a.length && p < b.length && ha[p] === hb[p]) p++;
  let sa = a.length;
  let sb = b.length;
  while (sa > p && sb > p && ha[sa - 1] === hb[sb - 1]) { sa--; sb--; }
  const pairs = [[p - 1, p - 1], ...lcs(ha, hb, p, sa, p, sb), [sa, sb]];
  // bölgeler sondan başa
  for (let k = pairs.length - 1; k > 0; k--) {
    const [ai0, bj0] = pairs[k - 1];
    const [ai1, bj1] = pairs[k];
    const ra = a.slice(ai0 + 1, ai1);
    const rb = b.slice(bj0 + 1, bj1);
    if (!ra.length && !rb.length) continue;
    if (ra.length === rb.length && ra.every((x, i) => x && rb[i] && x.type === rb[i].type)) {
      for (let i = ra.length - 1; i >= 0; i--) diffNode(ra[i], rb[i], [...path, ai0 + 1 + i], ops);
    } else {
      ops.push({ op: 'splice', path, index: ai0 + 1, removed: ra.map(ser), inserted: rb.map(ser), removedHash: ra.map(hashOf) });
    }
  }
}

function diffNode(a, b, path, ops) {
  if (hashOf(a) === hashOf(b)) return;
  if (!a || !b || a.type !== b.type || !scalarsEqual(a, b)) {
    ops.push({ op: 'replace', path, removed: ser(a), inserted: ser(b), removedHash: hashOf(a) });
    return;
  }
  const keys = t.VISITOR_KEYS[a.type] ?? [];
  for (let k = keys.length - 1; k >= 0; k--) {
    const key = keys[k];
    const x = a[key];
    const y = b[key];
    if (Array.isArray(x) || Array.isArray(y)) diffArray(x ?? [], y ?? [], [...path, key], ops);
    else diffNode(x ?? null, y ?? null, [...path, key], ops);
  }
}

/** a → b yaması. a ve b File ya da Program olabilir (aynı türde). */
export function diffAst(a, b) {
  const ops = [];
  diffNode(a, b, [], ops);
  return { format: PATCH_FORMAT, version: 1, ops };
}

function resolve(root, path) {
  let parent = null;
  let key = null;
  let cur = root;
  const chain = [root];
  for (const k of path) {
    parent = cur;
    key = k;
    if (cur === null || cur === undefined) throw new Error(`yama: yol çözülemedi (${path.join('.')})`);
    cur = cur[k];
    chain.push(cur);
  }
  return { parent, key, cur, chain };
}

/**
 * Yamayı yerinde uygular. ops: uygulanacak işlem indeksleri (alt küme; varsayılan hepsi).
 * Her işlemden önce kaldırılacak içeriğin hash'i doğrulanır: tutmazsa çakışma hatası.
 */
export function applyPatch(root, patch, only = null) {
  if (patch.format !== PATCH_FORMAT) throw new Error('yama: biçim tanınmadı');
  const list = only ? patch.ops.filter((_, i) => only.includes(i)) : patch.ops;
  let out = root;
  for (const op of list) {
    if (op.op === 'splice') {
      const { cur, chain } = resolve(out, op.path);
      if (!Array.isArray(cur)) throw new Error('yama: dizi bekleniyordu');
      chain.forEach(forget); // atalar yerinde değişiyor: hash önbelleği geçersiz
      const current = cur.slice(op.index, op.index + op.removed.length).map(hashOf);
      if (current.length !== op.removed.length || current.some((h, i) => h !== op.removedHash[i])) throw new Error('yama: çakışma (içerik değişmiş)');
      cur.splice(op.index, op.removed.length, ...op.inserted.map(de));
    } else {
      if (!op.path.length) {
        if (hashOf(out) !== op.removedHash) throw new Error('yama: çakışma (kök)');
        out = de(op.inserted);
        continue;
      }
      const { parent, key, cur, chain } = resolve(out, op.path);
      if (hashOf(cur ?? null) !== op.removedHash) throw new Error('yama: çakışma (içerik değişmiş)');
      chain.slice(0, -1).forEach(forget);
      parent[key] = de(op.inserted);
    }
  }
  return out;
}

/** Ters yama: işlemler ters sırada, kaldırılan/eklenen yer değiştirir. */
export function invertPatch(patch) {
  return {
    format: PATCH_FORMAT,
    version: patch.version,
    ops: [...patch.ops].reverse().map((op) => op.op === 'splice'
      ? { op: 'splice', path: op.path, index: op.index, removed: op.inserted, inserted: op.removed, removedHash: op.inserted.map((n) => hashOf(de(n))) }
      : { op: 'replace', path: op.path, removed: op.inserted, inserted: op.removed, removedHash: hashOf(de(op.inserted)) }),
  };
}

/** Yamanın özeti: işlem sayısı ve etkilenen yollar (gerekçe kayıtları için). */
export function patchSummary(patch) {
  let removed = 0;
  let inserted = 0;
  for (const op of patch.ops) {
    if (op.op === 'splice') { removed += op.removed.length; inserted += op.inserted.length; } else { removed++; inserted++; }
  }
  return { ops: patch.ops.length, removed, inserted, paths: patch.ops.slice(0, 20).map((o) => o.path.join('.')) };
}
