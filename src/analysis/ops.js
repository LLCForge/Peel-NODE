import * as t from '@babel/types';

// E501/E535/E536: ECMAScript soyut işlemleri (ToPrimitive, ToNumber, ToString, ToNumeric, ToBoolean,
// ToPropertyKey, IsLooselyEqual) ve operatörler. Değer alanı: primitive'ler + literal'den gelen model nesneler.
// Varsayım: yerleşik prototype'lar (Object/Array/String/Number/Boolean/Symbol/Function/RegExp) değiştirilmemiş;
// çağıran bunu prototypesPatched() ile denetler. Primitive'ler arası işlemler host motoruna bırakılır (spec ile aynı).

export const UNKNOWN = Symbol('unknown');
export const HOLE = Symbol('hole');

export class Thrown {
  constructor(name) { this.name = name; }
}

const isModel = (v) => v !== null && typeof v === 'object' && !(v instanceof Thrown) && typeof v.obj === 'string';
export const isThrown = (v) => v instanceof Thrown;
const bad = (v) => v === UNKNOWN || v instanceof Thrown;

export const arrayModel = (items) => ({ obj: 'array', items });
export const objectModel = (props) => ({ obj: 'object', props });
export const regexpModel = (source, flags) => ({ obj: 'regexp', source, flags });
export const functionModel = () => ({ obj: 'function' });

function own(model, key) {
  if (model.obj === 'object') {
    for (let i = model.props.length - 1; i >= 0; i--) if (model.props[i][0] === key) return { found: true, value: model.props[i][1] };
    return { found: false };
  }
  if (model.obj === 'array') {
    if (key === 'length') return { found: true, value: model.items.length };
    const i = canonicalIndex(key);
    if (i !== null && i < model.items.length && model.items[i] !== HOLE) return { found: true, value: model.items[i] };
    return { found: false };
  }
  if (model.obj === 'regexp') {
    if (key === 'lastIndex') return { found: true, value: 0 };
    return { found: false };
  }
  return { found: false };
}

function canonicalIndex(key) {
  if (typeof key !== 'string') return null;
  const n = Number(key);
  return Number.isInteger(n) && n >= 0 && n < 2 ** 32 - 1 && String(n) === key ? n : null;
}

// Prototype'tan gelen toString/valueOf; own özellik varsa o kullanılır (çağrılabilir değilse atlanır)
function method(model, name) {
  const o = own(model, name);
  if (o.found) {
    if (isModel(o.value) && o.value.obj === 'function') return UNKNOWN; // kullanıcı tanımlı yöntem: modellenmez
    return null; // çağrılabilir değil
  }
  if (model.obj === 'function') return UNKNOWN;
  return name;
}

function builtinCall(model, name) {
  if (name === 'valueOf') return model; // Object.prototype.valueOf: nesnenin kendisi
  if (model.obj === 'array') return arrayJoin(model, ',');
  if (model.obj === 'regexp') {
    return `/${model.source}/${model.flags}`;
  }
  return '[object Object]';
}

function arrayJoin(model, sep) {
  let out = '';
  for (let i = 0; i < model.items.length; i++) {
    if (i) out += sep;
    const v = model.items[i];
    if (v === HOLE || v === null || v === undefined) continue;
    const s = toString(v);
    if (bad(s)) return s;
    out += s;
  }
  return out;
}

// OrdinaryToPrimitive (Symbol.toPrimitive literal nesnede yalnızca hesaplanmış anahtarla tanımlanabilir: o durumda model yok)
export function toPrimitive(v, hint = 'default') {
  if (bad(v) || !isModel(v)) return v;
  if (v.obj === 'function') return UNKNOWN;
  const order = hint === 'string' ? ['toString', 'valueOf'] : ['valueOf', 'toString'];
  for (const name of order) {
    const m = method(v, name);
    if (m === UNKNOWN) return UNKNOWN;
    if (m === null) continue;
    const r = builtinCall(v, m);
    if (bad(r)) return r;
    if (!isModel(r)) return r;
  }
  return new Thrown('TypeError');
}

export function toString(v) {
  if (bad(v)) return v;
  if (typeof v === 'symbol') return new Thrown('TypeError');
  if (isModel(v)) return toString(toPrimitive(v, 'string'));
  return String(v); // Number::toString / BigInt::toString host'ta spec'e uygun; -0 → "0"
}

export function toNumber(v) {
  if (bad(v)) return v;
  if (typeof v === 'bigint' || typeof v === 'symbol') return new Thrown('TypeError');
  if (isModel(v)) return toNumber(toPrimitive(v, 'number'));
  return Number(v); // StringToNumber dahil
}

export function toNumeric(v) {
  if (bad(v)) return v;
  const p = isModel(v) ? toPrimitive(v, 'number') : v;
  if (bad(p)) return p;
  return typeof p === 'bigint' ? p : toNumber(p);
}

export function toBoolean(v) {
  if (bad(v)) return v;
  if (isModel(v)) return true;
  return Boolean(v);
}

export function toPropertyKey(v) {
  const p = toPrimitive(v, 'string');
  if (bad(p)) return p;
  return typeof p === 'symbol' ? p : toString(p);
}

export function typeOf(v) {
  if (bad(v)) return v;
  if (isModel(v)) return v.obj === 'function' ? 'function' : 'object';
  return v === null ? 'object' : typeof v;
}

function hostTry(fn) {
  try { return fn(); } catch (e) { return new Thrown(e?.name ?? 'Error'); }
}

export function strictEquals(a, b) {
  if (bad(a)) return a;
  if (bad(b)) return b;
  if (isModel(a) || isModel(b)) return a === b;
  return a === b;
}

// IsLooselyEqual (7.2.14)
export function looseEquals(a, b) {
  if (bad(a)) return a;
  if (bad(b)) return b;
  const ma = isModel(a);
  const mb = isModel(b);
  if (ma && mb) return a === b;
  if (ma) {
    if (b === null || b === undefined) return false;
    return looseEquals(toPrimitive(a), b);
  }
  if (mb) return looseEquals(b, a);
  // eslint-disable-next-line eqeqeq
  return a == b;
}

const ARITH = {
  '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b, '%': (a, b) => a % b,
  '**': (a, b) => a ** b, '<<': (a, b) => a << b, '>>': (a, b) => a >> b, '>>>': (a, b) => a >>> b,
  '&': (a, b) => a & b, '|': (a, b) => a | b, '^': (a, b) => a ^ b,
};
const REL = { '<': (a, b) => a < b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '>=': (a, b) => a >= b };

export function binary(op, a, b) {
  if (bad(a)) return a;
  if (op === '==' || op === '!=') {
    const r = looseEquals(a, b);
    return bad(r) ? r : op === '==' ? r : !r;
  }
  if (op === '===' || op === '!==') {
    const r = strictEquals(a, b);
    return bad(r) ? r : op === '===' ? r : !r;
  }
  if (bad(b)) return b;
  if (op === '+') {
    const pa = toPrimitive(a);
    if (bad(pa)) return pa;
    const pb = toPrimitive(b);
    if (bad(pb)) return pb;
    if (typeof pa === 'string' || typeof pb === 'string') {
      const sa = toString(pa);
      if (bad(sa)) return sa;
      const sb = toString(pb);
      return bad(sb) ? sb : sa + sb;
    }
    const na = toNumeric(pa);
    if (bad(na)) return na;
    const nb = toNumeric(pb);
    if (bad(nb)) return nb;
    return hostTry(() => na + nb); // BigInt + Number → TypeError (host ile aynı)
  }
  if (Object.hasOwn(ARITH, op)) {
    const na = toNumeric(a);
    if (bad(na)) return na;
    const nb = toNumeric(b);
    if (bad(nb)) return nb;
    return hostTry(() => ARITH[op](na, nb)); // karışık tür, 0n bölme, negatif BigInt üs, BigInt >>> hataları
  }
  if (Object.hasOwn(REL, op)) {
    const pa = toPrimitive(a, 'number');
    if (bad(pa)) return pa;
    const pb = toPrimitive(b, 'number');
    if (bad(pb)) return pb;
    return hostTry(() => REL[op](pa, pb));
  }
  return UNKNOWN; // in / instanceof: nesne modeli gerektirir
}

export function unary(op, v) {
  if (op === 'void') return bad(v) ? v : undefined;
  if (bad(v)) return v;
  switch (op) {
    case '!': return !toBoolean(v);
    case '+': return toNumber(v);
    case '-': { const n = toNumeric(v); return bad(n) ? n : -n; }
    case '~': { const n = toNumeric(v); return bad(n) ? n : ~n; }
    case 'typeof': return typeOf(v);
    default: return UNKNOWN;
  }
}

// Özellik okuma: model nesne ya da string. Prototype zinciri yalnızca length/indeks için modellenir.
export function getMember(obj, key) {
  if (bad(obj)) return obj;
  if (bad(key)) return key;
  if (obj === null || obj === undefined) return new Thrown('TypeError');
  const k = toPropertyKey(key);
  if (bad(k)) return k;
  if (typeof obj === 'string') {
    if (k === 'length') return obj.length;
    const i = canonicalIndex(k);
    if (i !== null) return i < obj.length ? obj[i] : undefined;
    return UNKNOWN;
  }
  if (isModel(obj)) {
    const o = own(obj, k);
    if (o.found) return o.value;
    // delik/sınır dışı indeks ya da ad biçiminde olmayan anahtar: Array.prototype'ta yok (yöntem adları tanımlayıcıdır)
    if (obj.obj === 'array' && typeof k === 'string' && (canonicalIndex(k) !== null || !/^[A-Za-z_$][\w$]*$/.test(k))) return undefined;
    if (obj.obj === 'object' && !Object.hasOwn(Object.prototype, k) && typeof k === 'string') return undefined;
    return UNKNOWN;
  }
  return UNKNOWN;
}

/**
 * Babel ifadesini soyut olarak değerlendirir.
 * lookup(identifierNode) → değer ya da UNKNOWN (çağıran gölgelemeyi ve sabitliği bilir).
 * opts.models: false ise dizi/nesne/regexp/fonksiyon literal'leri bilinmez sayılır.
 */
export function evaluate(node, lookup = () => UNKNOWN, opts = {}, depth = 0) {
  if (depth > 200) return UNKNOWN;
  const ev = (n) => evaluate(n, lookup, opts, depth + 1);
  // models:false → yerleşik prototype'lar değişmiş olabilir; nesne literal'leri modellenmez
  if (opts.models === false && /^(Array|Object|Function|ArrowFunction|Class)Expression$|^RegExpLiteral$/.test(node.type)) return UNKNOWN;
  switch (node.type) {
    case 'StringLiteral': case 'NumericLiteral': case 'BooleanLiteral': return node.value;
    case 'NullLiteral': return null;
    case 'BigIntLiteral': return BigInt(node.value.replace(/_/g, ''));
    case 'RegExpLiteral': return regexpModel(node.pattern, node.flags);
    case 'TemplateLiteral': {
      let s = node.quasis[0].value.cooked;
      if (s == null) return UNKNOWN;
      for (let i = 0; i < node.expressions.length; i++) {
        const v = ev(node.expressions[i]);
        const str = toString(v);
        if (bad(str)) return str;
        const q = node.quasis[i + 1].value.cooked;
        if (q == null) return UNKNOWN;
        s += str + q;
      }
      return s;
    }
    case 'Identifier': return lookup(node);
    case 'ParenthesizedExpression': return ev(node.expression);
    case 'ArrayExpression': {
      const items = [];
      for (const e of node.elements) {
        if (e === null) { items.push(HOLE); continue; }
        if (t.isSpreadElement(e)) return UNKNOWN;
        const v = ev(e);
        if (bad(v)) return v;
        items.push(v);
      }
      return arrayModel(items);
    }
    case 'ObjectExpression': {
      const props = [];
      for (const p of node.properties) {
        if (t.isObjectMethod(p)) {
          if (p.kind !== 'method') return UNKNOWN; // erişimci: okumada yan etki
          const k = p.computed ? toPropertyKey(ev(p.key)) : propKey(p.key);
          if (bad(k)) return k;
          props.push([k, functionModel()]);
          continue;
        }
        if (!t.isObjectProperty(p)) return UNKNOWN;
        let k;
        if (p.computed) k = toPropertyKey(ev(p.key));
        else k = propKey(p.key);
        if (bad(k)) return k;
        if (k === '__proto__' && !p.computed && !p.shorthand) return UNKNOWN; // prototype atar
        if (typeof k === 'symbol') return UNKNOWN;
        const v = ev(p.value);
        if (bad(v)) return v;
        props.push([k, v]);
      }
      return objectModel(props);
    }
    case 'FunctionExpression': case 'ArrowFunctionExpression': case 'ClassExpression':
      return functionModel();
    case 'UnaryExpression': {
      if (node.operator === 'delete') return UNKNOWN;
      if (node.operator === 'typeof' && t.isIdentifier(node.argument)) {
        const v = lookup(node.argument);
        return v === UNKNOWN ? UNKNOWN : typeOf(v);
      }
      return unary(node.operator, ev(node.argument));
    }
    case 'BinaryExpression': {
      if (t.isPrivateName(node.left)) return UNKNOWN;
      const a = ev(node.left);
      if (bad(a)) return a;
      return binary(node.operator, a, ev(node.right));
    }
    case 'LogicalExpression': {
      const a = ev(node.left);
      if (bad(a)) return a;
      if (node.operator === '&&') return toBoolean(a) ? ev(node.right) : a;
      if (node.operator === '||') return toBoolean(a) ? a : ev(node.right);
      return a === null || a === undefined ? ev(node.right) : a;
    }
    case 'ConditionalExpression': {
      const c = ev(node.test);
      if (bad(c)) return c;
      return toBoolean(c) ? ev(node.consequent) : ev(node.alternate);
    }
    case 'SequenceExpression': {
      let v;
      for (const e of node.expressions) {
        v = ev(e);
        if (bad(v)) return v;
      }
      return v;
    }
    case 'MemberExpression': {
      if (t.isPrivateName(node.property)) return UNKNOWN;
      const o = ev(node.object);
      if (bad(o)) return o;
      const k = node.computed ? ev(node.property) : node.property.name;
      return getMember(o, k);
    }
    default: return UNKNOWN;
  }
}

function propKey(key) {
  if (t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key)) return key.value;
  if (t.isNumericLiteral(key)) return String(key.value);
  if (t.isBigIntLiteral(key)) return String(BigInt(key.value));
  return UNKNOWN;
}

// Primitive sonucu AST düğümüne çevirir (model nesneler ve symbol için null)
export function valueToNode(v) {
  if (typeof v === 'string') return t.stringLiteral(v);
  if (typeof v === 'boolean') return t.booleanLiteral(v);
  if (v === null) return t.nullLiteral();
  if (v === undefined) return t.unaryExpression('void', t.numericLiteral(0));
  if (typeof v === 'bigint') return v < 0n ? t.unaryExpression('-', t.bigIntLiteral(String(-v))) : t.bigIntLiteral(String(v));
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return t.binaryExpression('/', t.numericLiteral(0), t.numericLiteral(0));
    if (v === Infinity) return t.binaryExpression('/', t.numericLiteral(1), t.numericLiteral(0));
    if (v === -Infinity) return t.unaryExpression('-', t.binaryExpression('/', t.numericLiteral(1), t.numericLiteral(0)));
    if (Object.is(v, -0)) return t.unaryExpression('-', t.numericLiteral(0));
    return v < 0 ? t.unaryExpression('-', t.numericLiteral(-v)) : t.numericLiteral(v);
  }
  return null;
}

export const isPrimitiveResult = (v) => !bad(v) && !isModel(v) && typeof v !== 'symbol';

const PROTO_OWNERS = new Set(['Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'Function', 'RegExp', 'BigInt']);

// Yerleşik prototype'ları değiştiren kod varsa nesne modeli devre dışı kalmalı
export function prototypesPatched(ast, traverse) {
  let patched = false;
  const isBuiltinProto = (n) => t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property, { name: 'prototype' }) &&
    t.isIdentifier(n.object) && PROTO_OWNERS.has(n.object.name);
  const touches = (n) => {
    while (t.isMemberExpression(n)) {
      if (isBuiltinProto(n)) return true;
      if (!n.computed && t.isIdentifier(n.property, { name: '__proto__' })) return true;
      n = n.object;
    }
    return false;
  };
  traverse(ast, {
    AssignmentExpression(p) { if (touches(p.node.left)) { patched = true; p.stop(); } },
    UpdateExpression(p) { if (touches(p.node.argument)) { patched = true; p.stop(); } },
    CallExpression(p) {
      const c = p.node.callee;
      const name = t.isMemberExpression(c) && !c.computed && t.isIdentifier(c.property) ? c.property.name : null;
      if ((name === 'defineProperty' || name === 'defineProperties' || name === 'setPrototypeOf' || name === 'assign' ||
        name === '__defineGetter__' || name === '__defineSetter__') &&
        p.node.arguments.some((a) => isBuiltinProto(a) || touches(a))) { patched = true; p.stop(); }
    },
  });
  return patched;
}
