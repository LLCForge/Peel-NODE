// E716: semantik yama sentezi. Önce/sonra ifade çiftlerinden anti-unification ile $0..$n
// metadeğişkenli genel bir yeniden yazma kuralı öğrenir, kuralı çözücüyle (int32) ya da verilen
// değerlendiriciyle (ör. sandbox.batch) rastgele girdilerde doğrular ve koda uygular.
import { parse } from '../core/parse.js';
import { traverse, gen, generate } from '../util/ast.js';
import { proveEquivalent } from '../symbolic/verify.js';

const SKIP = new Set(['start', 'end', 'loc', 'extra', 'range', 'leadingComments', 'trailingComments', 'innerComments', 'comments']);
const HOLE = /^\$\d+$/;

function expr(code) {
  const ast = parse(`(${code});`);
  return ast.program.body[0].expression;
}

const fields = (n) => Object.keys(n).filter((k) => !SKIP.has(k) && k !== 'type');
const isNode = (v) => v && typeof v === 'object' && typeof v.type === 'string';

// Aynı tipte ve aynı skaler alanlara sahip düğümler alt düğüm düzeyinde karşılaştırılabilir
function sameShape(nodes) {
  const [a] = nodes;
  return nodes.every((n) => n.type === a.type && fields(n).every((k) => {
    const x = a[k];
    const y = n[k];
    if (isNode(x) || isNode(y)) return isNode(x) && isNode(y);
    if (Array.isArray(x)) return Array.isArray(y) && x.length === y.length;
    return x === y || (x == null && y == null);
  }));
}

function antiUnify(nodes, holes) {
  const codes = nodes.map(gen);
  if (codes.every((c) => c === codes[0])) return structuredClone(strip(nodes[0]));
  if (sameShape(nodes)) {
    const out = { type: nodes[0].type };
    for (const k of fields(nodes[0])) {
      const vals = nodes.map((n) => n[k]);
      if (isNode(vals[0])) out[k] = antiUnify(vals, holes);
      else if (Array.isArray(vals[0])) out[k] = vals[0].map((_, i) => (isNode(vals[0][i]) ? antiUnify(vals.map((v) => v[i]), holes) : vals[0][i]));
      else out[k] = vals[0];
    }
    return out;
  }
  const key = codes.join('\u0000');
  if (!holes.has(key)) holes.set(key, { name: `$${holes.size}`, bindings: codes });
  return { type: 'Identifier', name: holes.get(key).name };
}

// Sonraki ifade: farklılaşan her alt ağaç bir metadeğişkenin bağlarıyla birebir eşleşmeli
function generalizeAfter(nodes, holes) {
  const codes = nodes.map(gen);
  const key = codes.join('\u0000');
  if (holes.has(key)) return { type: 'Identifier', name: holes.get(key).name };
  if (codes.every((c) => c === codes[0])) return structuredClone(strip(nodes[0]));
  if (!sameShape(nodes)) return null;
  const out = { type: nodes[0].type };
  for (const k of fields(nodes[0])) {
    const vals = nodes.map((n) => n[k]);
    if (isNode(vals[0])) {
      out[k] = generalizeAfter(vals, holes);
      if (!out[k]) return null;
    } else if (Array.isArray(vals[0])) {
      out[k] = [];
      for (let i = 0; i < vals[0].length; i++) {
        if (!isNode(vals[0][i])) { out[k].push(vals[0][i]); continue; }
        const g = generalizeAfter(vals.map((v) => v[i]), holes);
        if (!g) return null;
        out[k].push(g);
      }
    } else out[k] = vals[0];
  }
  return out;
}

function strip(n) {
  if (Array.isArray(n)) return n.map(strip);
  if (!n || typeof n !== 'object') return n;
  const o = {};
  for (const k of Object.keys(n)) if (!SKIP.has(k)) o[k] = strip(n[k]);
  return o;
}

/**
 * @param {{ before: string, after: string }[]} pairs
 * @returns {{ pattern: string, replacement: string, holes: { name: string, bindings: string[] }[] } | { error: string }}
 */
export function synthesizeRule(pairs) {
  if (!pairs?.length) return { error: 'çift yok' };
  let before;
  let after;
  try {
    before = pairs.map((p) => expr(p.before));
    after = pairs.map((p) => expr(p.after));
  } catch (e) {
    return { error: e.message };
  }
  const holes = new Map();
  const pattern = antiUnify(before, holes);
  const replacement = generalizeAfter(after, holes);
  if (!replacement) return { error: 'sonraki ifade metadeğişkenlerle ifade edilemiyor' };
  const pCode = gen(pattern);
  const rCode = gen(replacement);
  // her metadeğişken kalıpta görünmeli; değişmeyen çift genelleşmez
  for (const h of rCode.match(/\$\d+/g) ?? []) if (!pCode.includes(h)) return { error: `serbest metadeğişken: ${h}` };
  return { pattern: pCode, replacement: rCode, holes: [...holes.values()] };
}

const holeNames = (rule) => [...new Set(rule.pattern.match(/\$\d+/g) ?? [])].sort((a, b) => a.slice(1) - b.slice(1));

/**
 * Kural doğrulama: önce int32 üzerinde SMT kanıtı, olmazsa `evaluate` verilmişse rastgele testler.
 * @param {object} rule
 * @param {{ evaluate?: (exprs: string[]) => Promise<{ ok: boolean, type?: string, value?: unknown }[]>, samples?: number, seed?: number, backend?: string }} o
 * @returns {Promise<{ valid: boolean|null, method: 'smt'|'smt+test'|'test'|'none', domain?: 'int32', counterexample?: unknown[], reason?: string }>}
 */
export async function validateRule(rule, { evaluate = null, samples = 40, seed = 7, ...opts } = {}) {
  const params = holeNames(rule).join(', ');
  const fa = `function a(${params}) { return (${rule.pattern}); }`;
  const fb = `function b(${params}) { return (${rule.replacement}); }`;
  let smt = await proveEquivalent(fa, fb, { ...opts, minimize: true });
  // kural kod değiştirir: z3'ün denetlenmemiş UNSAT'ı yerleşik çözücüyle (DRUP denetimli) yeniden kanıtlanmalı
  if (smt.status === 'proved' && !smt.checked) {
    const again = await proveEquivalent(fa, fb, { ...opts, backend: 'builtin', minimize: true, timeoutMs: Math.max(opts.timeoutMs ?? 5000, 10000) });
    smt = again.status === 'proved' && again.checked ? again : { status: 'unknown', reason: 'z3 kanıtı yerleşik çözücüyle denetlenemedi' };
  }
  if (smt.status === 'refuted') return { valid: false, method: 'smt', counterexample: smt.minimized ?? smt.counterexample };
  // SMT kanıtı yalnızca int32 girdiler içindir; değerlendirici varsa diğer tipler de denenir
  if (!evaluate) {
    return smt.status === 'proved' ? { valid: true, method: 'smt', domain: 'int32' }
      : { valid: null, method: 'none', reason: `çözücü: ${smt.reason}; değerlendirici yok` };
  }
  let s = seed;
  // LCG alt bitleri kısa döngülü: üst bitler kullanılır
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s >>> 16; };
  const pool = () => {
    const r = rnd() % 8;
    return [0, 1, -1, rnd() % 1000, -(rnd() % 1000), `s${rnd() % 100}`, r & 1 ? true : false, ''][r];
  };
  const arity = holeNames(rule).length;
  const vectors = Array.from({ length: samples }, () => Array.from({ length: arity }, pool));
  const call = (f, v) => `(${f})(${v.map((x) => JSON.stringify(x)).join(', ')})`;
  const ra = await evaluate(vectors.map((v) => call(fa, v)));
  const rb = await evaluate(vectors.map((v) => call(fb, v)));
  for (let i = 0; i < vectors.length; i++) {
    const x = ra[i];
    const y = rb[i];
    if (x.ok !== y.ok || x.type !== y.type || !Object.is(x.value, y.value)) return { valid: false, method: 'test', counterexample: vectors[i] };
  }
  return { valid: true, method: smt.status === 'proved' ? 'smt+test' : 'test', reason: `${samples} rastgele girdi` };
}

const PURE = new Set(['Identifier', 'NumericLiteral', 'StringLiteral', 'BooleanLiteral', 'NullLiteral', 'BigIntLiteral', 'ThisExpression']);
function pure(n) {
  if (PURE.has(n.type)) return true;
  if (n.type === 'MemberExpression') return pure(n.object) && (!n.computed || pure(n.property));
  if (n.type === 'UnaryExpression') return n.operator !== 'delete' && pure(n.argument);
  if (n.type === 'BinaryExpression') return pure(n.left) && pure(n.right);
  return false;
}

function match(p, n, bind) {
  if (p.type === 'Identifier' && HOLE.test(p.name)) {
    if (bind.has(p.name)) return gen(bind.get(p.name)) === gen(n);
    bind.set(p.name, n);
    return true;
  }
  if (!sameShape([p, n])) return false;
  for (const k of fields(p)) {
    const a = p[k];
    const b = n[k];
    if (isNode(a)) { if (!match(a, b, bind)) return false; }
    else if (Array.isArray(a)) { for (let i = 0; i < a.length; i++) if (isNode(a[i]) && !match(a[i], b[i], bind)) return false; }
  }
  return true;
}

function instantiate(t, bind) {
  if (Array.isArray(t)) return t.map((x) => instantiate(x, bind));
  if (!t || typeof t !== 'object') return t;
  if (t.type === 'Identifier' && HOLE.test(t.name)) return structuredClone(strip(bind.get(t.name)));
  const o = {};
  for (const k of Object.keys(t)) o[k] = instantiate(t[k], bind);
  return o;
}

/**
 * Kuralı koddaki tüm eşleşmelere (iç içe olanlar dahil, içten dışa) uygular.
 * Kalıp ve yerinekoyma arasında sayısı değişen metadeğişkenler yalnızca yan etkisiz ifadelere bağlanır.
 * @returns {{ code: string, count: number }}
 */
export function applyRule(code, rule) {
  const ast = parse(code);
  const pattern = expr(rule.pattern);
  const replacement = expr(rule.replacement);
  const count = (s, h) => (s.match(new RegExp(`\\${h}(?!\\d)`, 'g')) ?? []).length;
  const unstable = holeNames(rule).filter((h) => count(rule.pattern, h) !== count(rule.replacement, h));
  let n = 0;
  traverse(ast, {
    Expression: {
      exit(path) {
        const bind = new Map();
        if (!match(pattern, path.node, bind)) return;
        if (unstable.some((h) => !pure(bind.get(h)))) return;
        path.replaceWith(instantiate(replacement, bind));
        path.skip();
        n++;
      },
    },
  });
  return { code: n ? generate(ast, { jsescOption: { minimal: true } }).code : code, count: n };
}
