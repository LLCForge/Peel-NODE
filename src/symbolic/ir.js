// API: C(v), V(name, ty, {lo,hi,cap}), fresh(prefix, ty), mk(op, ...args) [sadeleştirir], evaluate(term, Map) [kesin JS anlamı],
// types(term) → Set, truthOf, same, isNegation, vars(term) → Map, substitute(term, Map), show(term), toAst(term).
import * as t from '@babel/types';

// Sembolik ifade IR'ı (E581). Terimler düz nesneler:
//   { k: 'c', v }                     somut JS primitive değeri (NaN, -0 dahil)
//   { k: 'v', name, ty, lo, hi, cap } sembolik değişken; ty: int32|int|num|str|bool|any
//   { k: 'op', op, a: [terim...] }    JS anlamlı işlem (yalnızca primitive argümanlar üzerinde)
// Diziler ve nesneler yürütücüde yapısal tutulur (E596/E597); IR'a yalnızca elemanları girer.

export const C = (v) => ({ k: 'c', v });
export const TRUE = C(true);
export const FALSE = C(false);
export const UNDEF = C(undefined);

let varSeq = 0;
export function V(name, ty = 'any', extra = {}) {
  const v = { k: 'v', name, ty, ...extra };
  if (ty === 'int32') { v.lo ??= -2147483648; v.hi ??= 2147483647; }
  return v;
}
export const fresh = (prefix, ty = 'any', extra = {}) => V(`${prefix}#${++varSeq}`, ty, extra);

export const isConst = (x) => x.k === 'c';

const BIN = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b, '%': (a, b) => a % b,
  '**': (a, b) => a ** b, '&': (a, b) => a & b, '|': (a, b) => a | b, '^': (a, b) => a ^ b,
  '<<': (a, b) => a << b, '>>': (a, b) => a >> b, '>>>': (a, b) => a >>> b,
  '===': (a, b) => a === b, '!==': (a, b) => a !== b, '==': (a, b) => a == b, '!=': (a, b) => a != b, // eslint-disable-line eqeqeq
  '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b,
};
const UN = {
  neg: (a) => -a, pos: (a) => +a, '~': (a) => ~a, '!': (a) => !a, typeof: (a) => (a === null ? 'object' : typeof a),
  void: () => undefined, truthy: (a) => Boolean(a), tostr: (a) => String(a), tonum: (a) => Number(a),
  len: (s) => s.length, upper: (s) => s.toUpperCase(), lower: (s) => s.toLowerCase(),
};
const MULTI = {
  ite: (c, a, b) => (c ? a : b), '&&': (a, b) => a && b, '||': (a, b) => a || b, '??': (a, b) => a ?? b,
  charCodeAt: (s, i) => s.charCodeAt(i), charAt: (s, i) => s.charAt(i), slice: (s, a, b) => s.slice(a, b),
  indexOf: (s, x) => s.indexOf(x), startsWith: (s, x) => s.startsWith(x), endsWith: (s, x) => s.endsWith(x),
  includes: (s, x) => s.includes(x), imul: (a, b) => Math.imul(a, b), retest: (src, flags, s) => new RegExp(src, flags).test(s),
};
export const OPS = new Set([...Object.keys(BIN), ...Object.keys(UN), ...Object.keys(MULTI)]);
// String metodlarının argümanı string/number değilse ToString/ToNumber gözlenebilir yan etki üretebilir:
// yalnızca primitive argümanlarla çağrılır (yürütücü bunu garanti eder).
const STRING_ONLY = new Set(['len', 'upper', 'lower', 'charCodeAt', 'charAt', 'slice', 'indexOf', 'startsWith', 'endsWith', 'includes']);

export function applyOp(op, vals) {
  if (BIN[op]) return BIN[op](vals[0], vals[1]);
  if (UN[op]) return UN[op](vals[0]);
  if (STRING_ONLY.has(op) && typeof vals[0] !== 'string') throw new TypeError('string bekleniyordu');
  return MULTI[op](...vals);
}

// ── tip modeli (E599) ──────────────────────────────────
const ALL = ['number', 'string', 'boolean', 'undefined', 'null', 'object'];
const VAR_TYPES = { int32: ['number'], int: ['number'], num: ['number'], str: ['string'], bool: ['boolean'], undef: ['undefined'], null: ['null'], any: ALL };
const NUMERIC = new Set(['imul', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>', 'neg', 'pos', '~', 'tonum', 'len', 'charCodeAt', 'indexOf']);
const BOOLEAN = new Set(['===', '!==', '==', '!=', '<', '<=', '>', '>=', '!', 'truthy', 'startsWith', 'endsWith', 'includes', 'retest']);
const STRINGY = new Set(['typeof', 'tostr', 'upper', 'lower', 'charAt', 'slice']);
const typeCache = new WeakMap();

const tagOf = (v) => (v === null ? 'null' : typeof v === 'object' || typeof v === 'function' ? 'object' : typeof v);

/** Terimin alabileceği JS tipleri */
export function types(x) {
  if (x.k === 'c') return new Set([tagOf(x.v)]);
  if (x.k === 'v') return new Set(VAR_TYPES[x.ty] ?? ALL);
  if (typeCache.has(x)) return typeCache.get(x);
  let r;
  const { op, a } = x;
  if (NUMERIC.has(op)) r = new Set(['number']);
  else if (BOOLEAN.has(op)) r = new Set(['boolean']);
  else if (STRINGY.has(op)) r = new Set(['string']);
  else if (op === 'void') r = new Set(['undefined']);
  else if (op === '+') {
    const l = types(a[0]);
    const rr = types(a[1]);
    const prim = (s) => [...s].every((k) => k !== 'object');
    if (l.has('string') && l.size === 1 || rr.has('string') && rr.size === 1) r = new Set(['string']);
    else if (prim(l) && prim(rr) && !l.has('string') && !rr.has('string')) r = new Set(['number']);
    else r = new Set(['number', 'string']);
  } else if (op === 'ite') r = new Set([...types(a[1]), ...types(a[2])]);
  else if (op === '&&' || op === '||' || op === '??') r = new Set([...types(a[0]), ...types(a[1])]);
  else r = new Set(ALL);
  typeCache.set(x, r);
  return r;
}
export const onlyType = (x, tag) => { const s = types(x); return s.size === 1 && s.has(tag); };

// ── kurucu + sadeleştirici ─────────────────────────────
const NO_NAN = (x) => onlyType(x, 'string') || onlyType(x, 'boolean') || (x.k === 'v' && (x.ty === 'int32' || x.ty === 'int'));

export function mk(op, ...a) {
  if (!OPS.has(op)) throw new Error(`bilinmeyen IR işlemi: ${op}`);
  if (a.every(isConst)) {
    try { return C(applyOp(op, a.map((x) => x.v))); } catch { /* katlanamaz: terim olarak kalır */ }
  }
  if (op === 'ite') {
    const c = truthOf(a[0]);
    if (c === true) return a[1];
    if (c === false) return a[2];
    if (same(a[1], a[2])) return a[1];
    if (a[0].k === 'op' && a[0].op === '!' ) return mk('ite', a[0].a[0], a[2], a[1]);
  }
  if (op === 'truthy' && onlyType(a[0], 'boolean')) return a[0];
  if (op === 'typeof') {
    const ty = types(a[0]);
    // 'object' tipi fonksiyon da olabilir ("function"): yalnızca primitive tek tip katlanır
    if (ty.size === 1 && !ty.has('object')) return C(ty.has('null') ? 'object' : [...ty][0]);
  }
  if (op === '!') {
    const c = truthOf(a[0]);
    if (c !== null) return C(!c);
    if (a[0].k === 'op' && a[0].op === '!' && onlyType(a[0].a[0], 'boolean')) return a[0].a[0];
    const inv = { '===': '!==', '!==': '===', '==': '!=', '!=': '==' }[a[0].op];
    if (a[0].k === 'op' && inv) return mk(inv, ...a[0].a);
  }
  if (op === '===' || op === '!==') {
    const lt = types(a[0]);
    const rt = types(a[1]);
    if (![...lt].some((k) => rt.has(k))) return C(op === '!==');
    if (same(a[0], a[1]) && NO_NAN(a[0])) return C(op === '===');
  }
  if (op === '&&' || op === '||') {
    const c = truthOf(a[0]);
    if (c !== null) return (op === '&&') === c ? a[1] : a[0];
    // boolean cebiri (yalnızca iki taraf da boolean tipliyse: değer döndüren && / || anlamı korunur)
    if (onlyType(a[0], 'boolean') && onlyType(a[1], 'boolean')) {
      const r = truthOf(a[1]);
      if (r !== null) return (op === '&&') === r ? a[0] : C(r);
      if (same(a[0], a[1])) return a[0];
      if (isNegation(a[0], a[1])) return C(op === '||');
      // x || (!x && y) → x || y ;  x && (!x || y) → x && y
      const inner = op === '||' ? '&&' : '||';
      if (a[1].k === 'op' && a[1].op === inner && isNegation(a[0], a[1].a[0])) return mk(op, a[0], a[1].a[1]);
      // (x && y) || (!x && y) → y
      if (a[0].k === 'op' && a[1].k === 'op' && a[0].op === inner && a[1].op === inner &&
          isNegation(a[0].a[0], a[1].a[0]) && same(a[0].a[1], a[1].a[1])) return a[0].a[1];
    }
  }
  return { k: 'op', op, a };
}

const NEG = { '===': '!==', '!==': '===', '==': '!=', '!=': '==' };
/** b, a'nın mantıksal tersi mi? (sözdizimsel) */
export function isNegation(a, b) {
  if (b.k === 'op' && b.op === '!' && same(b.a[0], a)) return true;
  if (a.k === 'op' && a.op === '!' && same(a.a[0], b)) return true;
  return a.k === 'op' && b.k === 'op' && NEG[a.op] === b.op && same(a.a[0], b.a[0]) && same(a.a[1], b.a[1]);
}

// Terimin doğruluk değeri sabit mi? (null: bilinmiyor)
export function truthOf(x) {
  if (x.k === 'c') return Boolean(x.v);
  const ty = types(x);
  if (![...ty].some((k) => k !== 'undefined' && k !== 'null')) return false;
  if (ty.size === 1 && ty.has('object')) return true;
  return null;
}

export function same(x, y) {
  if (x === y) return true;
  if (x.k !== y.k) return false;
  if (x.k === 'c') return Object.is(x.v, y.v);
  if (x.k === 'v') return x.name === y.name;
  return x.op === y.op && x.a.length === y.a.length && x.a.every((e, i) => same(e, y.a[i]));
}

// ── değerlendirme ve dolaşma ───────────────────────────
/** Model altında somut değer (model: Map ad → değer). Kesin JS anlamı: modeller bununla doğrulanır. */
export function evaluate(x, model, memo = new Map()) {
  if (x.k === 'c') return x.v;
  if (x.k === 'v') {
    if (!model.has(x.name)) throw new Error(`modelde yok: ${x.name}`);
    return model.get(x.name);
  }
  if (memo.has(x)) return memo.get(x);
  let r;
  if (x.op === 'ite') r = evaluate(x.a[0], model, memo) ? evaluate(x.a[1], model, memo) : evaluate(x.a[2], model, memo);
  else if (x.op === '&&') r = evaluate(x.a[0], model, memo) && evaluate(x.a[1], model, memo);
  else if (x.op === '||') r = evaluate(x.a[0], model, memo) || evaluate(x.a[1], model, memo);
  else if (x.op === '??') r = evaluate(x.a[0], model, memo) ?? evaluate(x.a[1], model, memo);
  else r = applyOp(x.op, x.a.map((e) => evaluate(e, model, memo)));
  memo.set(x, r);
  return r;
}

export function vars(x, out = new Map()) {
  if (x.k === 'v') out.set(x.name, x);
  else if (x.k === 'op') for (const e of x.a) vars(e, out);
  return out;
}

export function size(x) {
  if (x.k !== 'op') return 1;
  let n = 1;
  for (const e of x.a) n += size(e);
  return n;
}

/** Değişkenleri yerine koyar (sub: Map ad → terim) ve yeniden sadeleştirir */
export function substitute(x, sub, memo = new Map()) {
  if (x.k === 'c') return x;
  if (x.k === 'v') return sub.get(x.name) ?? x;
  if (memo.has(x)) return memo.get(x);
  const r = mk(x.op, ...x.a.map((e) => substitute(e, sub, memo)));
  memo.set(x, r);
  return r;
}

// ── yazdırma ───────────────────────────────────────────
const PREC = { '||': 1, '??': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '===': 6, '!==': 6, '==': 6, '!=': 6, '<': 7, '<=': 7, '>': 7, '>=': 7, '<<': 8, '>>': 8, '>>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10, '**': 11 };

export function show(x, p = 0) {
  if (x.k === 'c') return typeof x.v === 'string' ? JSON.stringify(x.v) : Object.is(x.v, -0) ? '-0' : String(x.v);
  if (x.k === 'v') return x.name;
  const { op, a } = x;
  const wrap = (s, q) => (q < p ? `(${s})` : s);
  if (PREC[op]) return wrap(`${show(a[0], PREC[op])} ${op} ${show(a[1], PREC[op] + 1)}`, PREC[op]);
  if (op === 'ite') return wrap(`${show(a[0], 1)} ? ${show(a[1], 1)} : ${show(a[2], 1)}`, 0);
  if (op === 'neg') return `-${show(a[0], 12)}`;
  if (op === 'pos') return `+${show(a[0], 12)}`;
  if (op === '~' || op === '!') return `${op}${show(a[0], 12)}`;
  if (op === 'typeof' || op === 'void') return wrap(`${op} ${show(a[0], 12)}`, 12);
  if (op === 'truthy') return `Boolean(${show(a[0])})`;
  if (op === 'tostr') return `String(${show(a[0])})`;
  if (op === 'tonum') return `Number(${show(a[0])})`;
  if (op === 'len') return `${show(a[0], 13)}.length`;
  if (op === 'upper') return `${show(a[0], 13)}.toUpperCase()`;
  if (op === 'lower') return `${show(a[0], 13)}.toLowerCase()`;
  if (op === 'retest') return `/${a[0].v}/${a[1].v}.test(${show(a[2])})`;
  if (op === 'imul') return `Math.imul(${show(a[0])}, ${show(a[1])})`;
  return `${show(a[0], 13)}.${op}(${a.slice(1).map((e) => show(e)).join(', ')})`;
}

/** Babel düğümü üretir (ad → Identifier). Yalnızca sabit/ad/işlem içeren terimler için. */
export function toAst(x, nameOf = (n) => n) {
  if (x.k === 'c') {
    const v = x.v;
    if (v === undefined) return t.unaryExpression('void', t.numericLiteral(0));
    if (v === null) return t.nullLiteral();
    if (typeof v === 'boolean') return t.booleanLiteral(v);
    if (typeof v === 'string') return t.stringLiteral(v);
    if (Number.isNaN(v)) return t.identifier('NaN');
    if (v === Infinity) return t.identifier('Infinity');
    if (v === -Infinity) return t.unaryExpression('-', t.identifier('Infinity'));
    if (Object.is(v, -0)) return t.unaryExpression('-', t.numericLiteral(0));
    return v < 0 ? t.unaryExpression('-', t.numericLiteral(-v)) : t.numericLiteral(v);
  }
  if (x.k === 'v') return t.identifier(nameOf(x.name));
  const { op, a } = x;
  const A = (i) => toAst(a[i], nameOf);
  const call = (m, args) => t.callExpression(t.memberExpression(A(0), t.identifier(m)), args);
  if (BIN[op]) return t.binaryExpression(op, A(0), A(1));
  switch (op) {
    case 'ite': return t.conditionalExpression(A(0), A(1), A(2));
    case '&&': case '||': case '??': return t.logicalExpression(op, A(0), A(1));
    case 'neg': return t.unaryExpression('-', A(0));
    case 'pos': return t.unaryExpression('+', A(0));
    case '~': case '!': case 'typeof': case 'void': return t.unaryExpression(op, A(0));
    case 'truthy': return t.unaryExpression('!', t.unaryExpression('!', A(0)));
    case 'tostr': return t.callExpression(t.identifier('String'), [A(0)]);
    case 'tonum': return t.callExpression(t.identifier('Number'), [A(0)]);
    case 'len': return t.memberExpression(A(0), t.identifier('length'));
    case 'upper': return call('toUpperCase', []);
    case 'lower': return call('toLowerCase', []);
    case 'imul': return t.callExpression(t.memberExpression(t.identifier('Math'), t.identifier('imul')), [A(0), A(1)]);
    case 'retest': return t.callExpression(t.memberExpression(t.regExpLiteral(a[0].v, a[1].v), t.identifier('test')), [A(2)]);
    default: return call(op, a.slice(1).map((_, i) => A(i + 1)));
  }
}
