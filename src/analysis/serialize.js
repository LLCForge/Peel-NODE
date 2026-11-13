import * as t from '@babel/types';

// E561: sürümlü AST serileştirme. Biçim: { format: 'peel-ast', version, root }.
// Konum ve token bilgisi atılır; yorumlar isteğe bağlı korunur. Okurken sürüm ve düğüm türleri doğrulanır;
// eski sürümler MIGRATIONS ile güncel sürüme yükseltilir.

export const AST_FORMAT = 'peel-ast';
export const AST_VERSION = 1;
const DROP = new Set(['loc', 'start', 'end', 'range', 'tokens']);
const COMMENTS = new Set(['leadingComments', 'trailingComments', 'innerComments']);

// sürüm → bir sonraki sürüme dönüştürücü (şimdilik yalnızca v1 var)
const MIGRATIONS = {};

function strip(v, keepComments) {
  if (Array.isArray(v)) return v.map((x) => strip(x, keepComments));
  if (v === null || typeof v !== 'object') return v;
  if (typeof v.type === 'string' && (v.type === 'CommentBlock' || v.type === 'CommentLine')) return { type: v.type, value: v.value };
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (DROP.has(k) || (!keepComments && COMMENTS.has(k)) || x === undefined) continue;
    if (k === 'extra') {
      // yalnızca yazdırmayı etkileyen alanlar
      const e = {};
      if (x && 'raw' in x) { e.raw = x.raw; e.rawValue = x.rawValue; }
      if (x?.parenthesized) e.parenthesized = true;
      if (Object.keys(e).length) out.extra = e;
      continue;
    }
    if (typeof x === 'bigint') { out[k] = { $bigint: String(x) }; continue; }
    out[k] = strip(x, keepComments);
  }
  return out;
}

export function serializeAst(node, { keepComments = false } = {}) {
  return { format: AST_FORMAT, version: AST_VERSION, root: strip(node, keepComments) };
}

function revive(v, path) {
  if (Array.isArray(v)) return v.map((x, i) => revive(x, `${path}[${i}]`));
  if (v === null || typeof v !== 'object') return v;
  if (Object.keys(v).length === 1 && typeof v.$bigint === 'string') return BigInt(v.$bigint);
  if (typeof v.type === 'string' && v.type !== 'CommentBlock' && v.type !== 'CommentLine' && !Object.hasOwn(t.VISITOR_KEYS, v.type)) {
    throw new Error(`AST: bilinmeyen düğüm türü ${v.type} (${path})`);
  }
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = k === 'extra' ? { ...x } : revive(x, `${path}.${k}`);
  return out;
}

export function deserializeAst(doc) {
  const obj = typeof doc === 'string' ? JSON.parse(doc) : doc;
  if (!obj || obj.format !== AST_FORMAT) throw new Error('AST: biçim tanınmadı');
  if (!Number.isInteger(obj.version) || obj.version < 1) throw new Error('AST: geçersiz sürüm');
  if (obj.version > AST_VERSION) throw new Error(`AST: sürüm ${obj.version} bu PEEL sürümünden yeni (en fazla ${AST_VERSION})`);
  let cur = obj;
  for (let v = obj.version; v < AST_VERSION; v++) {
    if (!MIGRATIONS[v]) throw new Error(`AST: sürüm ${v} için yükseltme yok`);
    cur = MIGRATIONS[v](cur);
  }
  return revive(cur.root, 'root');
}
