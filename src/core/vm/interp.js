import * as t from '@babel/types';
import { gen } from '../../util/ast.js';
import { literalOf } from '../../util/literal.js';
import { walk, isRefPos } from './detect.js';

// Handler gövdeleri için kısmi değerlendirici (sembolik yorumlayıcı, E192).
//
// Somut olanlar: pc ve diğer durum değişkenleri, bytecode ve sabit havuzu, bytecode'dan okunan işlenenler.
// Sembolik olanlar: VM yığınındaki değerler. Yığın gerçek bir dizi olarak değil, ifade listesi olarak
// tutulur: S.push(a + b) yığına "a + b" ifadesini koyar, S.pop() onu geri alır. Böylece
// PUSH x; PUSH y; ADD; STORE r  dizisi tek bir "r = x + y" deyimine dönüşür.
//
// Değerlendirme sırası: yan etkisi olabilecek (çağrı, özellik okuma, işleç) ifadeler "etkili" sayılır ve
// aynı anda en fazla bir tane ertelenmiş etkili ifade bulunur (env.pending). Yeni bir etkili ifade ya da
// deyim üretilirken önceki ertelenmiş ifade, onu içermiyorsa geçici değişkene yazılır. Böylece
// yan etkilerin sırası orijinaldekiyle birebir aynı kalır.

export class Unsupported extends Error {}
export const fail = (why) => { throw new Unsupported(why); };

export const HOLE = Symbol('hole');
const MAX_UNROLL = 4096;

// Doğal olarak hesaplanabilen saf fonksiyonlar (gölgelenmemişse)
const PURE_GLOBAL_FNS = {
  parseInt, parseFloat, isNaN, isFinite, String, Number, Boolean, escape, unescape,
  encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
};
const PURE_STATIC = {
  String: { fromCharCode: String.fromCharCode, fromCodePoint: String.fromCodePoint },
  Math: Object.fromEntries(['abs', 'floor', 'ceil', 'round', 'trunc', 'max', 'min', 'pow', 'sign', 'sqrt', 'imul', 'log2', 'clz32'].map((k) => [k, Math[k]])),
  Number: { parseInt: Number.parseInt, parseFloat: Number.parseFloat, isInteger: Number.isInteger },
};
const STRING_METHODS = new Set(['charCodeAt', 'charAt', 'codePointAt', 'slice', 'substr', 'substring', 'indexOf', 'lastIndexOf',
  'split', 'toUpperCase', 'toLowerCase', 'trim', 'concat', 'startsWith', 'endsWith', 'includes', 'repeat', 'padStart', 'padEnd', 'at']);
const ARRAY_METHODS = new Set(['indexOf', 'lastIndexOf', 'includes', 'slice', 'join', 'at']);

let entrySeq = 0;
export class Entry {
  constructor(node, eff, deps = new Set()) {
    this.node = node;
    this.eff = eff;
    this.deps = deps;
    this.writes = null;
    this.hasC = false;
    this.c = undefined;
    this.used = 0;
    this.id = ++entrySeq;
  }
}

export function concreteEntry(v) {
  const node = literalOf(t, v);
  if (!node) fail('ilkel olmayan somut değer');
  const e = new Entry(node, false);
  e.hasC = true;
  e.c = v;
  return e;
}

export const C = (v, name = null) => ({ k: 'c', v, name });
export const E = (e) => ({ k: 'e', e });

class SymArray {
  constructor(items) { this.items = items; this.mat = null; }
}

export class Env {
  constructor(L) {
    this.L = L;
    this.conc = new Map();
    this.sym = new Map();
    this.stack = [];
    this.out = [];
    this.pending = null;
  }

  // Çatallanmada her dal kendi kopyasını alır: geçici değişkene yazma bir dalda olur, diğerini etkilemez
  clone() {
    const map = new Map();
    const ce = (e) => {
      if (!e) return e;
      if (!map.has(e)) {
        const c = new Entry(e.node, e.eff, new Set(e.deps));
        Object.assign(c, { writes: e.writes, hasC: e.hasC, c: e.c, used: e.used });
        map.set(e, c);
      }
      return map.get(e);
    };
    const cv = (v) => {
      if (v.k === 'e') return E(ce(v.e));
      if (v.k === 'arr') { const a = new SymArray(v.a.items.map(ce)); a.mat = ce(v.a.mat); return { k: 'arr', a }; }
      return v;
    };
    const n = new Env(this.L);
    n.conc = new Map(this.conc);
    n.sym = new Map([...this.sym].map(([k, v]) => [k, cv(v)]));
    n.stack = this.stack.map(ce);
    n.out = this.out.slice();
    n.pending = ce(this.pending);
    return n;
  }

  liveEntries() {
    const out = [...this.stack];
    for (const v of this.sym.values()) {
      if (v.k === 'e') out.push(v.e);
      if (v.k === 'arr') out.push(...v.a.items);
    }
    return out;
  }
}

// ── ifade kurucuları ────────────────────────────────────

function tempFor(env) {
  const name = env.L.gensym('_t');
  env.L.temps.add(name);
  return name;
}
const assignStmt = (name, node) => t.expressionStatement(t.assignmentExpression('=', t.identifier(name), node));

export function flush(env, e) {
  if (!e || e.hasC || (!e.eff && !e.deps.size)) return;
  // gömülmüş bir değer artık yerinden alınamaz: kurucular önce tüm işlenenleri hazırlar, sonra gömer
  if (e.used) fail('gömülmüş değer boşaltılamaz');
  if (t.isIdentifier(e.node) && env.L.temps.has(e.node.name)) { e.eff = false; e.deps = new Set(); return; }
  const name = tempFor(env);
  env.out.push(assignStmt(name, e.node));
  e.node = t.identifier(name);
  e.eff = false;
  e.deps = new Set();
  e.writes = null;
  if (env.pending === e) env.pending = null;
}

function use(e, parts) {
  if ((e.eff || e.fresh) && e.used) fail(`etkili değer iki kez kullanılıyor: ${gen(e.node).slice(0, 60)}`);
  e.used++;
  parts.push(e);
  return t.cloneNode(e.node, true);
}

function depsOf(parts, extra = []) {
  const s = new Set(extra);
  for (const p of parts) for (const d of p.deps) s.add(d);
  return s;
}

function mkEff(env, node, parts, writes = null) {
  if (env.pending && !parts.includes(env.pending)) flush(env, env.pending);
  const e = new Entry(node, true, depsOf(parts));
  if (writes) e.writes = writes;
  env.pending = e;
  return e;
}

function mkPure(node, parts, extra = []) {
  return new Entry(node, false, depsOf(parts, extra));
}

export function emit(env, stmt, parts) {
  if (env.pending && !parts.includes(env.pending)) flush(env, env.pending);
  else if (env.pending) env.pending = null;
  env.out.push(stmt);
}

// Yerel değişken yazılmadan önce onu okuyan bekleyen değerler kopyalanır
function flushDeps(env, name, exclude = []) {
  for (const e of env.liveEntries()) if (e.deps.has(name) && !exclude.includes(e)) flush(env, e);
}

export function asEntry(env, v) {
  if (v.k === 'e') return v.e;
  if (v.k === 'c') {
    if (v.v !== null && typeof v.v === 'object') {
      if (!v.name) fail('somut dizi değer olarak kullanılıyor');
      return mkPure(t.identifier(v.name), [], [v.name]);
    }
    return concreteEntry(v.v);
  }
  if (v.k === 'arr') return materialize(env, v.a);
  if (v.k === 'stack') fail('yığın dizisi değer olarak kullanılıyor');
  if (v.k === 'smeth') fail('yığın metodu değer olarak kullanılıyor');
  return fail('bilinmeyen değer');
}

// Dizi literali oluşturmak yan etkisizdir: bekleyen değer boşaltılmaz; yeni nesne kimliği iki kez kullanılamaz
function materialize(env, a) {
  if (a.mat) return a.mat;
  const parts = [];
  const node = t.arrayExpression(a.items.map((e) => use(e, parts)));
  const holdsPending = env.pending && parts.includes(env.pending);
  const e = new Entry(node, holdsPending || parts.some((x) => x.eff), depsOf(parts));
  e.fresh = true;
  if (holdsPending) env.pending = e;
  a.mat = e;
  return e;
}

const isConcrete = (v) => v.k === 'c' || (v.k === 'e' && v.e.hasC);
const cval = (v) => (v.k === 'c' ? v.v : v.e.c);

// ── ad çözümleme ────────────────────────────────────────

function readName(env, name) {
  const L = env.L;
  if (name === L.stackName) return { k: 'stack' };
  if (env.sym.has(name)) return env.sym.get(name);
  if (env.conc.has(name)) return C(env.conc.get(name), name);
  if (L.arrays.has(name)) return C(L.arrays.get(name), name);
  if (L.internal.has(name)) fail(`bağlanmamış yerel değişken: ${name}`);
  if (!L.isBound(name)) {
    if (name === 'undefined') return C(undefined);
    if (name === 'NaN') return C(NaN);
    if (name === 'Infinity') return C(Infinity);
  }
  if (L.locals.has(name)) {
    if (env.pending?.writes?.has(name)) flush(env, env.pending);
    return E(mkPure(t.identifier(name), [], [name]));
  }
  return E(mkEff(env, t.identifier(name), []));
}

// Bir handler'da adın kaç kez okunduğu: birden fazlaysa etkili değer bağlanırken geçiciye yazılır
function readCount(env, name) {
  const L = env.L;
  const list = L.curList;
  if (!list) return 2;
  let cache = L.countCache.get(list);
  if (!cache) {
    cache = new Map();
    const visit = (n, p, k, loopy) => {
      if (!n || typeof n !== 'object') return;
      if (t.isIdentifier(n) && isRefPos(p, k) && !(t.isAssignmentExpression(p) && k === 'left') && !(t.isVariableDeclarator(p) && k === 'id')) {
        cache.set(n.name, (cache.get(n.name) ?? 0) + (loopy ? 2 : 1));
      }
      const deeper = loopy || t.isLoop(n) || t.isFunction(n);
      for (const key of t.VISITOR_KEYS[n.type] ?? []) {
        const v = n[key];
        if (Array.isArray(v)) v.forEach((c) => visit(c, n, key, deeper)); else visit(v, n, key, deeper);
      }
    };
    // düşmeli case birleşiminde handler, en üst düzeydeki ilk break/return'de biter
    for (const s of list) {
      visit(s, null, null, false);
      if (t.isBreakStatement(s) || t.isContinueStatement(s) || t.isReturnStatement(s) || t.isThrowStatement(s)) break;
    }
    L.countCache.set(list, cache);
  }
  return cache.get(name) ?? 0;
}

function bind(env, name, v) {
  const L = env.L;
  if (name === L.stackName) fail('yığın değişkeni yeniden atanıyor');
  if (L.arrays.has(name)) fail(`sabit dizi yeniden atanıyor: ${name}`);
  if (!L.internal.has(name)) fail(`iç olmayan değişkene bağlama: ${name}`);
  if (isConcrete(v)) {
    const val = cval(v);
    if (val !== null && typeof val === 'object') {
      if (v.k === 'c' && v.name && L.arrays.has(v.name)) { env.sym.set(name, v); env.conc.delete(name); return; }
      fail('somut dizi yerele atanıyor');
    }
    env.conc.set(name, val);
    env.sym.delete(name);
    return;
  }
  // birden çok okunan etkili değer geçiciye alınır; saf (yalnızca bağımlılıklı) değer yazmada zaten kopyalanır
  if (v.k === 'e' && v.e.eff && readCount(env, name) > 1) flush(env, v.e);
  env.sym.set(name, v);
  env.conc.delete(name);
}

// ── yığın işlemleri ─────────────────────────────────────

function stackPop(env) {
  if (!env.stack.length) fail('yığın boşken pop');
  return env.stack.pop();
}

function stackPeek(env, i) {
  const e = env.stack[i];
  if (e.eff) flush(env, e);
  return e;
}

function stackSet(env, i, e) {
  while (env.stack.length < i) env.stack.push(concreteEntry(undefined));
  const old = env.stack[i];
  if (old && old.eff) flush(env, old);
  env.stack[i] = e;
}

function stackTruncate(env, n) {
  while (env.stack.length > n) {
    const e = env.stack.pop();
    if (e.eff) {
      const parts = [];
      emit(env, t.expressionStatement(use(e, parts)), parts);
    }
  }
  while (env.stack.length < n) env.stack.push(concreteEntry(undefined));
}

const intOf = (v) => {
  if (!isConcrete(v)) fail('sembolik yığın indeksi');
  const i = cval(v);
  if (typeof i !== 'number' && !(typeof i === 'string' && /^\d+$/.test(i))) return null;
  const n = Number(i);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

// ── ifadeler ────────────────────────────────────────────

export function ev(n, env) {
  switch (n.type) {
    case 'NumericLiteral': case 'StringLiteral': case 'BooleanLiteral': return C(n.value);
    case 'NullLiteral': return C(null);
    case 'TemplateLiteral':
      if (!n.expressions.length) return C(n.quasis[0].value.cooked);
      return residual(n, env);
    case 'ParenthesizedExpression': return ev(n.expression, env);
    case 'Identifier': return readName(env, n.name);
    case 'ThisExpression':
      if (env.L.inTableFn) fail('tablo handler\'ında this');
      return E(mkPure(t.thisExpression(), []));
    case 'MemberExpression': return member(n, env);
    case 'CallExpression': return call(n, env);
    case 'NewExpression': return residualCall(n, env, true);
    case 'UnaryExpression': return unary(n, env);
    case 'BinaryExpression': return binary(n, env);
    case 'LogicalExpression': return logical(n, env);
    case 'ConditionalExpression': return conditional(n, env);
    case 'AssignmentExpression': return assign(n, env);
    case 'UpdateExpression': return update(n, env);
    case 'SequenceExpression': {
      let last = C(undefined);
      n.expressions.forEach((x, i) => {
        last = ev(x, env);
        if (i < n.expressions.length - 1) dropValue(env, last);
      });
      return last;
    }
    case 'ArrayExpression': {
      const parts = [];
      const ents = n.elements.map((x) => {
        if (x === null) return null;
        if (t.isSpreadElement(x)) fail('dizi yayma');
        return asEntry(env, ev(x, env));
      });
      const els = ents.map((e) => (e ? use(e, parts) : null));
      // dizi literali yan etkisizdir: bekleyen değeri boşaltmaz, yeni kimlik bir kez kullanılır
      const holdsPending = env.pending && parts.includes(env.pending);
      const arr = new Entry(t.arrayExpression(els), holdsPending || parts.some((x) => x.eff), depsOf(parts));
      arr.fresh = true;
      if (holdsPending) env.pending = arr;
      return E(arr);
    }
    case 'ObjectExpression': {
      const parts = [];
      const ents = n.properties.map((p) => {
        if (t.isObjectProperty(p)) {
          return { p, key: p.computed ? asEntry(env, ev(p.key, env)) : null, value: asEntry(env, ev(p.value, env)) };
        }
        if (!safeSubtree(env, p)) fail('nesne metodu VM durumuna dokunuyor');
        return { p };
      });
      const props = ents.map(({ p, key, value }) => {
        if (!value) return t.cloneNode(p, true);
        return t.objectProperty(key ? use(key, parts) : t.cloneNode(p.key), use(value, parts), p.computed, false);
      });
      return E(mkEff(env, t.objectExpression(props), parts));
    }
    case 'FunctionExpression': case 'ArrowFunctionExpression': case 'ClassExpression': case 'RegExpLiteral': case 'BigIntLiteral':
      if (!safeSubtree(env, n)) fail('iç fonksiyon VM durumuna dokunuyor');
      return E(mkEff(env, t.cloneNode(n, true), []));
    default:
      return fail(`desteklenmeyen ifade: ${n.type}`);
  }
}

// VM durumuna (yığın, iç değişkenler) dokunmayan alt ağaç olduğu gibi kopyalanabilir
export function safeSubtree(env, node) {
  const L = env.L;
  let ok = true;
  walk(node, (n, p, k) => {
    if (!ok) return false;
    if (t.isIdentifier(n) && isRefPos(p, k) && (n.name === L.stackName || L.internal.has(n.name) || env.sym.has(n.name))) ok = false;
    if (L.inTableFn && (t.isThisExpression(n) || t.isIdentifier(n, { name: 'arguments' }))) ok = false;
    return undefined;
  });
  return ok;
}

function residual(n, env) {
  if (!safeSubtree(env, n)) fail('VM durumuna dokunan ifade');
  return E(mkEff(env, t.cloneNode(n, true), []));
}

function dropValue(env, v) {
  // yığında ya da bir yerelde tutulan değer (x = S.pop()) sahiplidir: deyim olarak yazılmaz
  if (v.k === 'e' && v.e.eff && !v.e.used && !env.liveEntries().includes(v.e)) {
    const parts = [];
    emit(env, t.expressionStatement(use(v.e, parts)), parts);
  }
}

function member(n, env) {
  const L = env.L;
  const ov = ev(n.object, env);
  const pv = n.computed ? ev(n.property, env) : C(n.property.name);
  if (ov.k === 'stack') {
    if (!isConcrete(pv)) fail('sembolik yığın indeksi');
    if (cval(pv) === 'length') return C(env.stack.length);
    // çevrilmiş kodda görülen biçim: _t = S.push; _t.apply(S, [x])
    if (['push', 'pop'].includes(cval(pv))) return { k: 'smeth', m: cval(pv) };
    const i = intOf(pv);
    if (i === null) fail('yığın dizisinde özellik okuma');
    return i < env.stack.length ? E(stackPeek(env, i)) : C(undefined);
  }
  if (ov.k === 'arr') {
    if (!isConcrete(pv)) fail('sembolik dizi indeksi');
    if (cval(pv) === 'length') return C(ov.a.items.length);
    const i = intOf(pv);
    if (i === null || ov.a.mat) fail('yerel dizide özellik okuma');
    const e = ov.a.items[i];
    if (!e) return C(undefined);
    if (e.eff) flush(env, e);
    return E(e);
  }
  if (ov.k === 'c' && ov.v !== null && typeof ov.v === 'object') {
    // somut dizi: bytecode ya da sabit havuzu
    if (!isConcrete(pv)) {
      if (L.mode === 'sem' && ov.name === L.codeName) return E(L.placeholderRead(env));
      const parts = [];
      const node = t.memberExpression(t.identifier(ov.name), use(asEntry(env, pv), parts), true);
      return E(mkPure(node, parts, [ov.name]));
    }
    const key = cval(pv);
    if (key === 'length') return C(ov.v.length);
    const i = intOf(pv);
    if (i === null) fail(`somut dizide özellik: ${String(key)}`);
    if (ov.name === L.codeName) return L.codeRead(env, i);
    if (i >= ov.v.length) return C(undefined);
    const el = ov.v[i];
    if (el === HOLE) {
      if (ov.name === L.regsName) L.regsSeen.add(i);
      return E(mkPure(t.memberExpression(t.identifier(ov.name), t.numericLiteral(i), true), [], [ov.name]));
    }
    return C(el);
  }
  if (isConcrete(ov) && isConcrete(pv)) {
    const o = cval(ov);
    const k = cval(pv);
    if (typeof o === 'string') {
      if (ov.name === L.codeName && (typeof k === 'number' || /^\d+$/.test(k))) return L.codeRead(env, Number(k));
      if (k === 'length') return C(o.length);
      if (typeof k === 'number' || /^\d+$/.test(k)) return C(o[Number(k)]);
    }
  }
  const parts = [];
  const oe = asEntry(env, ov);
  const pe = n.computed ? asEntry(env, pv) : null;
  const obj = use(oe, parts);
  if (L.regsName && t.isIdentifier(obj, { name: L.regsName }) && isConcrete(pv)) L.regsSeen.add(cval(pv));
  const prop = pe ? use(pe, parts) : t.identifier(n.property.name);
  const node = t.memberExpression(obj, prop, n.computed || !t.isIdentifier(prop));
  // kaçmayan yerel dizinin (register dizisi) ilkel indeksli okuması getter çalıştıramaz: yalnızca yazmalara bağımlı
  if (t.isIdentifier(obj) && L.plainArrays?.has(obj.name) && isConcrete(pv) && cval(pv) !== null && typeof cval(pv) !== 'object') {
    return E(mkPure(node, parts, [obj.name]));
  }
  return E(mkEff(env, node, parts));
}

function staticPure(callee, env) {
  if (t.isIdentifier(callee) && Object.hasOwn(PURE_GLOBAL_FNS, callee.name) && !env.L.isBound(callee.name)) return PURE_GLOBAL_FNS[callee.name];
  if (t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.object) && Object.hasOwn(PURE_STATIC, callee.object.name) &&
      !env.L.isBound(callee.object.name) && Object.hasOwn(PURE_STATIC[callee.object.name], callee.property.name)) {
    return PURE_STATIC[callee.object.name][callee.property.name];
  }
  return null;
}

function call(n, env) {
  const L = env.L;
  const callee = n.callee;
  if (n.arguments.some((a) => t.isSpreadElement(a))) fail('çağrıda yayma');
  // saf yerleşik fonksiyon + somut argümanlar → doğrudan hesapla
  const pureFn = staticPure(callee, env);
  if (pureFn) {
    const args = n.arguments.map((a) => ev(a, env));
    if (args.every(isConcrete)) {
      const vals = args.map(cval);
      if (vals.every((x) => x === null || typeof x !== 'object')) {
        try { return C(pureFn(...vals)); } catch { /* hata atıyorsa çalışma anına bırak */ }
      }
    }
    return residualCallWith(env, n, null, null, args, false);
  }
  if (t.isMemberExpression(callee)) {
    const ov = ev(callee.object, env);
    const pv = callee.computed ? ev(callee.property, env) : C(callee.property.name);
    const method = isConcrete(pv) ? cval(pv) : undefined;
    if (ov.k === 'smeth') return stackMethodCall(n, env, ov.m, method);
    if (ov.k === 'stack') return stackMethod(n, env, method);
    if (ov.k === 'arr') return arrayMethod(n, env, ov.a, method);
    // o.m.apply(o, [a, b]) → o.m(a, b): o saf ve aynı ifade (E114'teki .call kuralının apply karşılığı)
    if (method === 'apply' && n.arguments.length === 2 && ov.k === 'e' && t.isMemberExpression(ov.e.node)) {
      const self = ev(n.arguments[0], env);
      const list = ev(n.arguments[1], env);
      const se = self.k === 'e' ? self.e : null;
      const literalList = list.k === 'e' && list.e.fresh && t.isArrayExpression(list.e.node) && list.e.node.elements.every((x) => x && !t.isSpreadElement(x));
      if ((literalList || (list.k === 'arr' && !list.a.mat)) && se && !se.eff && !se.fresh && gen(ov.e.node.object) === gen(se.node)) {
        const parts = [];
        const callee = use(ov.e, parts);
        const args = literalList ? use(list.e, parts).elements : list.a.items.map((x) => use(x, parts));
        return E(mkEff(env, t.callExpression(callee, args), parts));
      }
      return residualCallWith(env, n, ov, pv, [self, list], false);
    }
    if (isConcrete(ov) && method !== undefined) {
      const o = cval(ov);
      const args = n.arguments.map((a) => ev(a, env));
      const all = args.every(isConcrete) && args.map(cval).every((x) => x === null || typeof x !== 'object');
      if (typeof o === 'string' && STRING_METHODS.has(method)) {
        if (ov.name === L.codeName && L.mode === 'sem' && ['charCodeAt', 'codePointAt', 'charAt'].includes(method)) return E(L.placeholderRead(env));
        if (all) {
          if (ov.name === L.codeName && ['charCodeAt', 'codePointAt', 'charAt'].includes(method)) L.noteCodeRead(Number(cval(args[0]) ?? 0));
          return C(String.prototype[method].apply(o, args.map(cval)));
        }
      }
      if (Array.isArray(o) && ARRAY_METHODS.has(method) && all && !o.includes(HOLE)) {
        const r = Array.prototype[method].apply(o, args.map(cval));
        return C(r);
      }
      if ((typeof o === 'number' || typeof o === 'boolean') && ['toString', 'toFixed', 'valueOf'].includes(method) && all) {
        return C(o[method](...args.map(cval)));
      }
      return residualCallWith(env, n, ov, pv, args, false);
    }
    const args = n.arguments.map((a) => ev(a, env));
    return residualCallWith(env, n, ov, pv, args, false);
  }
  const fv = ev(callee, env);
  const args = n.arguments.map((a) => ev(a, env));
  return residualCallWith(env, n, fv, null, args, false);
}

function residualCall(n, env, isNew) {
  if (n.arguments.some((a) => t.isSpreadElement(a))) fail('çağrıda yayma');
  const fv = ev(n.callee, env);
  const args = n.arguments.map((a) => ev(a, env));
  return residualCallWith(env, n, fv, null, args, isNew);
}

// ov/pv: üye çağrısında nesne ve özellik (this bağlamı korunur); pv null ise ov doğrudan fonksiyon
function residualCallWith(env, n, ov, pv, args, isNew) {
  const parts = [];
  // önce tüm işlenenler hazırlanır (dizi materialize edilirken bekleyen değer boşaltılabilir), sonra gömülür
  const computed = pv ? n.callee.computed || !(isConcrete(pv) && typeof cval(pv) === 'string' && t.isValidIdentifier(cval(pv))) : false;
  const oe = ov === null ? null : asEntry(env, ov);
  const pe = pv && computed ? asEntry(env, pv) : null;
  const ae = args.map((a) => asEntry(env, a));
  let calleeNode;
  if (ov === null) {
    calleeNode = t.cloneNode(n.callee, true);
  } else if (pv) {
    const obj = use(oe, parts);
    const prop = computed ? use(pe, parts) : t.identifier(cval(pv));
    calleeNode = t.memberExpression(obj, prop, computed);
  } else {
    calleeNode = use(oe, parts);
    // f(a) çağrısında f'nin değeri o.m ise doğrudan o.m(a) yazmak this'i değiştirirdi: (0, o.m)(a)
    if (!isNew && (t.isMemberExpression(calleeNode) || t.isOptionalMemberExpression(calleeNode))) {
      calleeNode = t.sequenceExpression([t.numericLiteral(0), calleeNode]);
    }
  }
  const argNodes = ae.map((e) => use(e, parts));
  const node = isNew ? t.newExpression(calleeNode, argNodes) : t.callExpression(calleeNode, argNodes);
  return E(mkEff(env, node, parts));
}

function stackMethod(n, env, method) {
  if (method === 'push') {
    for (const a of n.arguments) env.stack.push(asEntry(env, ev(a, env)));
    return C(env.stack.length);
  }
  if (method === 'pop') {
    if (n.arguments.length) fail('pop argümanlı');
    return E(stackPop(env));
  }
  if (method === 'splice') {
    const args = n.arguments.map((a) => ev(a, env));
    if (!args.length || args.length > 2 || !args.every(isConcrete)) fail('sembolik splice');
    const len = env.stack.length;
    let start = Number(cval(args[0]));
    start = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    const count = args.length > 1 ? Math.max(0, Math.min(Number(cval(args[1])), len - start)) : len - start;
    return { k: 'arr', a: new SymArray(env.stack.splice(start, count)) };
  }
  return fail(`yığında desteklenmeyen işlem: ${String(method)}`);
}

// S.push / S.pop bir değişkene alınıp apply/call ile çağrılmış: this yığınsa yığın işlemi
function stackMethodCall(n, env, m, how) {
  if (!['apply', 'call'].includes(how) || !n.arguments.length) fail('yığın metodu doğrudan çağrılıyor');
  if (ev(n.arguments[0], env).k !== 'stack') fail('yığın metodu başka nesneyle çağrılıyor');
  let items = [];
  if (how === 'call') items = n.arguments.slice(1).map((a) => asEntry(env, ev(a, env)));
  else if (n.arguments.length > 1) {
    const list = n.arguments[1];
    if (t.isArrayExpression(list) && list.elements.every((e) => e && !t.isSpreadElement(e))) items = list.elements.map((e) => asEntry(env, ev(e, env)));
    else {
      const v = ev(list, env);
      if (v.k !== 'arr' || v.a.mat) fail('yığın metodu bilinmeyen argüman listesiyle');
      items = v.a.items;
    }
  }
  if (m === 'push') { env.stack.push(...items); return C(env.stack.length); }
  if (items.length) fail('pop argümanlı');
  return E(stackPop(env));
}

function arrayMethod(n, env, a, method) {
  if (a.mat) fail('materialize edilmiş diziye işlem');
  const args = () => n.arguments.map((x) => asEntry(env, ev(x, env)));
  switch (method) {
    case 'push': a.items.push(...args()); return C(a.items.length);
    case 'unshift': a.items.unshift(...args()); return C(a.items.length);
    case 'pop': return a.items.length ? E(a.items.pop()) : C(undefined);
    case 'shift': return a.items.length ? E(a.items.shift()) : C(undefined);
    case 'reverse': a.items.reverse(); return { k: 'arr', a };
    default: return fail(`yerel dizide desteklenmeyen işlem: ${String(method)}`);
  }
}

function computeUnary(op, v) {
  switch (op) {
    case '!': return !v; case '-': return -v; case '+': return +v; case '~': return ~v;
    case 'typeof': return typeof v; case 'void': return undefined;
    default: return fail(`tekli işleç: ${op}`);
  }
}

function unary(n, env) {
  if (n.operator === 'delete') return residual(n, env);
  if (n.operator === 'typeof' && t.isIdentifier(n.argument) && !env.L.isBound(n.argument.name) && !env.sym.has(n.argument.name)) {
    return E(mkEff(env, t.cloneNode(n, true), []));
  }
  const v = ev(n.argument, env);
  if (isConcrete(v)) {
    const x = cval(v);
    if (x === null || typeof x !== 'object') return C(computeUnary(n.operator, x));
  }
  const parts = [];
  const e = asEntry(env, v);
  const node = t.unaryExpression(n.operator, use(e, parts));
  // !, typeof ve void kullanıcı kodu çağırmaz
  if (['!', 'typeof', 'void'].includes(n.operator) && !e.eff) return E(mkPure(node, parts));
  return E(mkEff(env, node, parts));
}

export function computeBinary(op, a, b) {
  switch (op) {
    case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '%': return a % b;
    case '**': return a ** b; case '|': return a | b; case '&': return a & b; case '^': return a ^ b;
    case '<<': return a << b; case '>>': return a >> b; case '>>>': return a >>> b;
    case '===': return a === b; case '!==': return a !== b;
    case '==': return a == b; case '!=': return a != b; // eslint-disable-line eqeqeq
    case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b;
    default: return fail(`ikili işleç: ${op}`);
  }
}

function binary(n, env) {
  const l = ev(n.left, env);
  const r = ev(n.right, env);
  if (isConcrete(l) && isConcrete(r) && !['in', 'instanceof'].includes(n.operator)) {
    const a = cval(l);
    const b = cval(r);
    if ((a === null || typeof a !== 'object') && (b === null || typeof b !== 'object')) return C(computeBinary(n.operator, a, b));
  }
  const parts = [];
  const le = asEntry(env, l);
  const re = asEntry(env, r);
  const node = t.binaryExpression(n.operator, use(le, parts), use(re, parts));
  if (['===', '!=='].includes(n.operator) && !le.eff && !re.eff) return E(mkPure(node, parts));
  return E(mkEff(env, node, parts));
}

// Kısa devre / koşullu: tembel taraf VM durumunu değiştirmemeli ve kendi başına deyim üretmemeli
function lazy(env, node) {
  if (!safeSubtree(env, node)) fail('kısa devre tarafı VM durumuna dokunuyor');
  let mutates = false;
  walk(node, (x) => { if (t.isAssignmentExpression(x) || t.isUpdateExpression(x)) mutates = true; });
  if (mutates) fail('kısa devre tarafında atama');
  const saved = env.pending;
  env.pending = null;
  const before = env.out.length;
  const e = asEntry(env, ev(node, env));
  if (env.out.length !== before) fail('kısa devre tarafı sıralanamıyor');
  env.pending = saved;
  return e;
}

function logical(n, env) {
  const l = ev(n.left, env);
  if (isConcrete(l)) {
    const a = cval(l);
    if (n.operator === '&&') return a ? ev(n.right, env) : l;
    if (n.operator === '||') return a ? l : ev(n.right, env);
    return a === null || a === undefined ? ev(n.right, env) : l;
  }
  const le = asEntry(env, l);
  const re = lazy(env, n.right);
  const parts = [];
  const node = t.logicalExpression(n.operator, use(le, parts), use(re, parts));
  if (!le.eff && !re.eff) return E(mkPure(node, parts));
  return E(mkEff(env, node, parts));
}

function conditional(n, env) {
  const tv = ev(n.test, env);
  if (isConcrete(tv)) return cval(tv) ? ev(n.consequent, env) : ev(n.alternate, env);
  const te = asEntry(env, tv);
  const a = lazy(env, n.consequent);
  const b = lazy(env, n.alternate);
  const parts = [];
  const node = t.conditionalExpression(use(te, parts), use(a, parts), use(b, parts));
  if (!te.eff && !a.eff && !b.eff) return E(mkPure(node, parts));
  return E(mkEff(env, node, parts));
}

function combine(env, op, cur, rhs) {
  if (isConcrete(cur) && isConcrete(rhs)) {
    const a = cval(cur);
    const b = cval(rhs);
    if ((a === null || typeof a !== 'object') && (b === null || typeof b !== 'object')) return C(computeBinary(op, a, b));
  }
  const parts = [];
  const a = asEntry(env, cur);
  const b = asEntry(env, rhs);
  const node = t.binaryExpression(op, use(a, parts), use(b, parts));
  return E(mkEff(env, node, parts));
}

function assign(n, env) {
  const L = env.L;
  const op = n.operator;
  if (t.isIdentifier(n.left)) {
    const name = n.left.name;
    if (L.internal.has(name)) {
      let v;
      if (op === '=') v = ev(n.right, env);
      else if (['&&=', '||=', '??='].includes(op)) fail('mantıksal atama');
      else { const cur = readName(env, name); v = combine(env, op.slice(0, -1), cur, ev(n.right, env)); }
      if (L.mode === 'sem' && name === L.pcName && !isConcrete(v)) { L.semJump(env, v); return v; }
      bind(env, name, v);
      return v;
    }
    if (name === L.stackName) fail('yığın yeniden atanıyor');
    if (L.arrays.has(name)) fail(`sabit dizi yeniden atanıyor: ${name}`);
    const re = asEntry(env, ev(n.right, env));
    const parts = [];
    flushDeps(env, name, [re]);
    const node = t.assignmentExpression(op, t.identifier(name), use(re, parts));
    return E(mkEff(env, node, parts, new Set([name])));
  }
  if (!t.isMemberExpression(n.left)) fail('desenli atama');
  const ov = ev(n.left.object, env);
  const pv = n.left.computed ? ev(n.left.property, env) : C(n.left.property.name);
  if (ov.k === 'stack' || ov.k === 'arr') {
    if (!isConcrete(pv)) fail('sembolik indekse yazma');
    const items = ov.k === 'stack' ? env.stack : ov.a.items;
    if (cval(pv) === 'length') {
      if (op !== '=') fail('length bileşik atama');
      const v = ev(n.right, env);
      if (!isConcrete(v)) fail('sembolik length');
      if (ov.k === 'stack') stackTruncate(env, cval(v)); else ov.a.items.length = cval(v);
      return v;
    }
    const i = intOf(pv);
    if (i === null) fail('yığın dizisine özellik yazma');
    let v;
    if (op === '=') v = ev(n.right, env);
    else v = combine(env, op.slice(0, -1), i < items.length ? E(items[i]) : C(undefined), ev(n.right, env));
    const e = asEntry(env, v);
    if (ov.k === 'stack') stackSet(env, i, e); else items[i] = e;
    return E(e);
  }
  if (ov.k === 'c' && ov.v !== null && typeof ov.v === 'object' && ov.name !== L.regsName) fail(`sabit dizi yazılıyor: ${ov.name}`);
  const parts = [];
  const computed = n.left.computed || false;
  const oe = asEntry(env, ov);
  const pe = computed ? asEntry(env, pv) : null;
  const re = asEntry(env, ev(n.right, env));
  const obj = use(oe, parts);
  if (L.regsName && t.isIdentifier(obj, { name: L.regsName }) && isConcrete(pv)) L.regsSeen.add(cval(pv));
  const prop = computed ? use(pe, parts) : t.identifier(n.left.property.name);
  const node = t.assignmentExpression(op, t.memberExpression(obj, prop, computed), use(re, parts));
  if (t.isIdentifier(obj) && L.plainArrays?.has(obj.name)) {
    flushDeps(env, obj.name, parts);
    return E(mkEff(env, node, parts, new Set([obj.name])));
  }
  return E(mkEff(env, node, parts));
}

function update(n, env) {
  const L = env.L;
  if (t.isIdentifier(n.argument)) {
    const name = n.argument.name;
    if (L.internal.has(name)) {
      const cur = readName(env, name);
      if (isConcrete(cur)) {
        const old = cval(cur);
        const num = +old;
        const nv = n.operator === '++' ? num + 1 : num - 1;
        bind(env, name, C(nv));
        return C(n.prefix ? nv : num);
      }
      const parts = [];
      const e = asEntry(env, cur);
      if (e.eff) flush(env, e);
      const node = t.binaryExpression(n.operator === '++' ? '+' : '-', t.unaryExpression('+', use(e, parts)), t.numericLiteral(1));
      const nv = E(mkEff(env, node, parts));
      bind(env, name, nv);
      if (n.prefix) return nv;
      return E(mkEff(env, t.unaryExpression('+', t.cloneNode(e.node, true)), []));
    }
    if (name === L.stackName || L.arrays.has(name)) fail('sabit değişken artırılıyor');
    flushDeps(env, name);
    return E(mkEff(env, t.cloneNode(n, true), [], new Set([name])));
  }
  if (!t.isMemberExpression(n.argument)) fail('desenli artırma');
  const ov = ev(n.argument.object, env);
  if (ov.k === 'stack' || ov.k === 'arr' || (ov.k === 'c' && ov.name !== L.regsName)) fail('yığın/sabit dizi elemanı artırılıyor');
  const pv = n.argument.computed ? ev(n.argument.property, env) : C(n.argument.property.name);
  const parts = [];
  const oe = asEntry(env, ov);
  const pe = n.argument.computed ? asEntry(env, pv) : null;
  const obj = use(oe, parts);
  const prop = pe ? use(pe, parts) : t.identifier(n.argument.property.name);
  const writes = t.isIdentifier(obj) && L.plainArrays?.has(obj.name) ? new Set([obj.name]) : null;
  if (writes) flushDeps(env, obj.name, parts);
  return E(mkEff(env, t.updateExpression(n.operator, t.memberExpression(obj, prop, n.argument.computed), n.prefix), parts, writes));
}

// ── deyimler ────────────────────────────────────────────
// exec bir ağaç döndürür: { fork: test, yes, no, out } ya da { leaf: env, end, label }
// end: 'fall' liste bitti, 'brk'/'cont' döngü/switch, 'exit' VM döngüsünden çıkış, 'ret' return/throw

export const leaf = (env, end, label = null) => ({ env, end, label });

export function mapLeaves(tree, fn) {
  if (tree.fork) return { ...tree, yes: mapLeaves(tree.yes, fn), no: mapLeaves(tree.no, fn) };
  return fn(tree);
}

export function leavesOf(tree, out = []) {
  if (tree.fork) { leavesOf(tree.yes, out); leavesOf(tree.no, out); } else out.push(tree);
  return out;
}

const branchList = (b) => (!b ? [] : t.isBlockStatement(b) ? b.body : [b]);

export function evalStatementExpr(env, expr) {
  const v = ev(expr, env);
  dropValue(env, v);
}

// ctx: { brk: 'vm'|'switch'|'inner'|'fn', cont: 'vm'|'inner', depth }
export function exec(list, env, ctx) {
  const L = env.L;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const rest = () => list.slice(i + 1);
    switch (s.type) {
      case 'EmptyStatement': continue;
      case 'BlockStatement': list = [...s.body, ...rest()]; i = -1; continue;
      case 'ExpressionStatement':
        if (L.dispatchStmt === s) return then(L.dispatchTable(env, ctx), rest(), ctx);
        evalStatementExpr(env, s.expression);
        continue;
      case 'VariableDeclaration':
        for (const d of s.declarations) {
          if (!t.isIdentifier(d.id)) fail('desenli bildirim');
          if (!d.init) {
            if (s.kind !== 'var') bind(env, d.id.name, C(undefined));
            continue;
          }
          const v = ev(d.init, env);
          if (L.internal.has(d.id.name)) bind(env, d.id.name, v);
          else {
            const parts = [];
            const re = asEntry(env, v);
            flushDeps(env, d.id.name, [re]);
            emit(env, t.expressionStatement(t.assignmentExpression('=', t.identifier(d.id.name), use(re, parts))), parts);
          }
        }
        continue;
      case 'IfStatement': {
        const tv = ev(s.test, env);
        if (isConcrete(tv)) {
          list = [...branchList(cval(tv) ? s.consequent : s.alternate), ...rest()];
          // if-chain dağıtımında seçilen kol handler'dır: okuma sayımı o kola göre yapılır
          if (L.chainNodes?.has(s)) L.curList = list;
          i = -1;
          continue;
        }
        if (ctx.depth > 0) fail('iç döngüde sembolik dal');
        const parts = [];
        const te = asEntry(env, tv);
        const test = use(te, parts);
        if (env.pending && !parts.includes(env.pending)) flush(env, env.pending);
        else if (env.pending) env.pending = null;
        const prefix = env.out;
        const a = env.clone(); a.out = [];
        const b = env.clone(); b.out = [];
        const r = rest();
        const yes = exec([...branchList(s.consequent), ...r], a, ctx);
        const no = exec([...branchList(s.alternate), ...r], b, ctx);
        return { fork: true, test, yes, no, out: prefix };
      }
      case 'ReturnStatement': {
        if (ctx.brk === 'fn') {
          if (s.argument) evalStatementExpr(env, s.argument);
          return leaf(env, 'fret');
        }
        const parts = [];
        const arg = s.argument ? use(asEntry(env, ev(s.argument, env)), parts) : null;
        emit(env, t.returnStatement(arg), parts);
        return leaf(env, 'ret');
      }
      case 'ThrowStatement': {
        const parts = [];
        const arg = use(asEntry(env, ev(s.argument, env)), parts);
        emit(env, t.throwStatement(arg), parts);
        return leaf(env, 'ret');
      }
      case 'BreakStatement':
        if (s.label) {
          if (s.label.name === L.label) return leaf(env, 'exit');
          return leaf(env, 'lbrk', s.label.name);
        }
        if (ctx.brk === 'vm') return leaf(env, 'exit');
        if (ctx.brk === 'fn') fail('fonksiyonda break');
        return leaf(env, 'brk');
      case 'ContinueStatement':
        if (s.label) {
          if (s.label.name === L.label) return leaf(env, 'cont');
          fail('etiketli continue');
        }
        return leaf(env, ctx.cont === 'vm' ? 'cont' : 'icont');
      case 'SwitchStatement': {
        const dv = ev(s.discriminant, env);
        if (!isConcrete(dv)) {
          if (s === L.dispatchStmt) fail('opcode sembolik');
          if (ctx.depth > 0 || !safeStatement(env, s)) fail('sembolik iç switch');
          residualStatement(env, s);
          continue;
        }
        const d = cval(dv);
        if (s === L.dispatchStmt) L.noteOp(d);
        let idx = -1;
        for (let k = 0; k < s.cases.length; k++) {
          const c = s.cases[k];
          if (!c.test) continue;
          const cv = ev(c.test, env);
          if (!isConcrete(cv)) fail('sembolik case');
          if (cval(cv) === d) { idx = k; break; }
        }
        if (idx < 0) idx = s.cases.findIndex((c) => !c.test);
        if (idx < 0) continue;
        const body = s.cases.slice(idx).flatMap((c) => c.consequent);
        const prev = L.curList;
        if (s === L.dispatchStmt) L.curList = body;
        const sub = exec(body, env, { ...ctx, brk: 'switch' });
        L.curList = prev;
        return then(sub, rest(), ctx, ['brk', 'fall']);
      }
      case 'ForStatement': case 'WhileStatement': case 'DoWhileStatement': {
        const r = unroll(s, env, ctx);
        if (r) return then(r, rest(), ctx);
        continue;
      }
      case 'LabeledStatement':
        if (t.isLoop(s.body) || t.isSwitchStatement(s.body)) {
          const r = exec([s.body], env, ctx);
          return then(mapLeaves(r, (lf) => (lf.end === 'lbrk' && lf.label === s.label.name ? { ...lf, end: 'fall', label: null } : lf)), rest(), ctx);
        }
        if (!safeStatement(env, s)) fail('etiketli deyim');
        residualStatement(env, s);
        continue;
      case 'FunctionDeclaration': case 'ClassDeclaration':
        return fail('handler içinde bildirim');
      default:
        if (!safeStatement(env, s)) fail(`desteklenmeyen deyim: ${s.type}`);
        residualStatement(env, s);
    }
  }
  return leaf(env, 'fall');
}

// İç içe ağaçta belirli sonlardaki yapraklarda kalan deyimlerle devam et
function then(tree, rest, ctx, accept = ['fall']) {
  return mapLeaves(tree, (lf) => {
    if (!accept.includes(lf.end)) return lf;
    if (!rest.length) return { ...lf, end: 'fall' };
    return exec(rest, lf.env, ctx);
  });
}

function safeStatement(env, s) {
  if (!safeSubtree(env, s)) return false;
  let jumps = false;
  const visit = (n, nested) => {
    if (!n || typeof n !== 'object' || jumps || t.isFunction(n)) return;
    if ((t.isBreakStatement(n) || t.isContinueStatement(n)) && (n.label || !nested)) jumps = true;
    const inner = nested || t.isLoop(n) || t.isSwitchStatement(n);
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => visit(c, inner)); else visit(v, inner);
    }
  };
  visit(s, false);
  return !jumps;
}

function residualStatement(env, s) {
  emit(env, t.cloneNode(s, true), []);
}

// Testi somut iç döngüyü aç; sembolikse ve VM durumuna dokunmuyorsa olduğu gibi bırak
function unroll(s, env, ctx) {
  if (t.isForStatement(s) && s.init) {
    if (t.isVariableDeclaration(s.init)) {
      const r = exec([s.init], env, ctx);
      if (r.fork || r.end !== 'fall') fail('for başlangıcı');
    } else evalStatementExpr(env, s.init);
  }
  const test = s.test ?? t.booleanLiteral(true);
  let first = t.isDoWhileStatement(s);
  for (let k = 0; k < MAX_UNROLL; k++) {
    if (!first) {
      const tv = ev(test, env);
      if (!isConcrete(tv)) {
        if (k === 0 && safeStatement(env, s) && !t.isForStatement(s)) { residualStatement(env, s); return null; }
        fail('iç döngü testi sembolik');
      }
      if (!cval(tv)) return null;
    }
    first = false;
    const r = exec([s.body], env, { ...ctx, brk: 'inner', cont: 'inner', depth: ctx.depth + 1 });
    if (r.fork) fail('iç döngüde dal');
    if (r.end === 'brk') return null;
    if (!['fall', 'icont'].includes(r.end)) return r;
    if (t.isForStatement(s) && s.update) evalStatementExpr(env, s.update);
  }
  return fail('iç döngü açılamadı (sınır)');
}
