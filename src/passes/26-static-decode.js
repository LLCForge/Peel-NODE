import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { literalOf } from '../util/literal.js';

// Sandbox gerektirmeyen statik çözücü çağrıları (E67, E83–E86, E89). Argümanlar literal ya da sabit
// bağlamalı (tek atamalı, literal başlangıçlı) değişkenlerse ve çağrılan global gölgelenmemişse katlanır:
//   decodeURIComponent("%41") / decodeURI / encodeURI(Component) / unescape / escape
//   parseInt("ff", 16) / parseFloat("1.5") / Number("0x1f")
//   [104, 105].join("") / ["a", "b"].join("-") / "a,b".split(",")[1]
//   String.fromCharCode(104, 105) / String.fromCharCode.apply(null, [104, 105]) / String.fromCodePoint(...)
//   new TextDecoder("utf-8").decode(new Uint8Array([104, 105])) / Uint8Array.from([...])

const MAX_STRING = 4000;
const MAX_ARRAY = 4000;

const URI_FNS = { decodeURIComponent, decodeURI, encodeURIComponent, encodeURI, unescape, escape };

const isGlobal = (p, name) => !p.scope.hasBinding(name, true);

// Sabit değer: literal, ifadesiz şablon, literal birleştirme ya da sabit bağlamalı değişken
function constValue(node, scope, depth = 0) {
  if (!node || depth > 3) return undefined;
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return node.value;
  if (t.isNullLiteral(node)) return null;
  if (t.isUnaryExpression(node, { operator: '-' }) && t.isNumericLiteral(node.argument)) return -node.argument.value;
  if (t.isTemplateLiteral(node) && !node.expressions.length) return node.quasis[0].value.cooked;
  if (t.isBinaryExpression(node, { operator: '+' })) {
    const a = constValue(node.left, scope, depth + 1);
    const b = constValue(node.right, scope, depth + 1);
    if ((typeof a === 'string' || typeof a === 'number') && (typeof b === 'string' || typeof b === 'number') && (typeof a === 'string' || typeof b === 'string')) return a + b;
    return undefined;
  }
  if (t.isIdentifier(node)) {
    const b = scope.getBinding(node.name);
    if (!b || !b.constant || !t.isVariableDeclarator(b.path.node) || !b.path.node.init) return undefined;
    // döngü/fonksiyon içinde yeniden bildirilen var değil, tek atama
    if (b.path.parentPath.node.kind === 'var' && b.path.parentPath.parentPath.isFor()) return undefined;
    return constValue(b.path.node.init, b.path.scope, depth + 1);
  }
  return undefined;
}

// Literal sayı/string dizisi (dizi literal ya da sabit bağlamalı diziye referans: yazılmayan diziler)
function constArray(node, scope) {
  let arr = node;
  if (t.isIdentifier(node)) {
    const b = scope.getBinding(node.name);
    if (!b || !b.constant || !t.isVariableDeclarator(b.path.node)) return null;
    // dizi değiştirilmiyor olmalı: tüm referanslar okuma amaçlı üye erişimi ya da argüman olmamalı
    const safe = b.referencePaths.every((r) => {
      const parent = r.parentPath;
      if (parent.isMemberExpression({ object: r.node })) {
        if (parent.parentPath.isAssignmentExpression({ left: parent.node }) || parent.parentPath.isUpdateExpression()) return false;
        const prop = parent.node.computed ? null : parent.node.property.name;
        return !prop || !/^(push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)$/.test(prop);
      }
      // yalnızca diziyi değiştirmeyen bilinen tüketicilere argüman olarak verilebilir
      if (parent.isNewExpression()) return t.isIdentifier(parent.node.callee, { name: 'Uint8Array' });
      if (!parent.isCallExpression() || !parent.node.arguments.includes(r.node) || !t.isMemberExpression(parent.node.callee)) return false;
      const c = parent.node.callee;
      const name = c.property?.name ?? '';
      if (name === 'fromCharCode' || name === 'fromCodePoint') return t.isIdentifier(c.object, { name: 'String' });
      if (name === 'from') return t.isIdentifier(c.object, { name: 'Uint8Array' });
      if (name === 'apply') return t.isMemberExpression(c.object) && t.isIdentifier(c.object.object, { name: 'String' });
      return false;
    });
    if (!safe) return null;
    arr = b.path.node.init;
  }
  if (!t.isArrayExpression(arr) || arr.elements.length > MAX_ARRAY) return null;
  const vals = [];
  for (const e of arr.elements) {
    const v = e && !t.isSpreadElement(e) ? constValue(e, scope) : undefined;
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    vals.push(v);
  }
  return vals;
}

const byteArray = (vals) => (vals && vals.every((v) => Number.isInteger(v) && v >= 0 && v < 256) ? Uint8Array.from(vals) : null);

// new Uint8Array([..]) / Uint8Array.from([..]) / [..] → baytlar
function bytesOf(node, p) {
  if ((t.isNewExpression(node) && t.isIdentifier(node.callee, { name: 'Uint8Array' }) && isGlobal(p, 'Uint8Array')) ||
      (t.isCallExpression(node) && t.isMemberExpression(node.callee) && t.isIdentifier(node.callee.object, { name: 'Uint8Array' }) &&
        t.isIdentifier(node.callee.property, { name: 'from' }) && isGlobal(p, 'Uint8Array'))) {
    if (node.arguments.length !== 1) return null;
    return byteArray(constArray(node.arguments[0], p.scope));
  }
  return null;
}

const ENCODINGS = new Set(['utf-8', 'utf8', 'unicode-1-1-utf-8', 'utf-16le', 'utf-16', 'utf-16be', 'latin1', 'iso-8859-1', 'ascii', 'windows-1252']);

function fold(p) {
  const n = p.node;
  const callee = n.callee;
  const args = n.arguments;
  // URI ailesi ve escape/unescape
  if (t.isIdentifier(callee) && Object.hasOwn(URI_FNS, callee.name) && args.length === 1 && isGlobal(p, callee.name)) {
    const v = constValue(args[0], p.scope);
    if (typeof v !== 'string') return undefined;
    try { return URI_FNS[callee.name](v); } catch { return undefined; } // bozuk kaçış: çalışma anında da URIError
  }
  // parseInt / parseFloat / Number
  if (t.isIdentifier(callee, { name: 'parseInt' }) && isGlobal(p, 'parseInt') && args.length >= 1 && args.length <= 2) {
    const v = constValue(args[0], p.scope);
    const radix = args[1] ? constValue(args[1], p.scope) : undefined;
    if ((typeof v === 'string' || typeof v === 'number') && (radix === undefined || typeof radix === 'number')) return parseInt(v, radix);
  }
  if (t.isIdentifier(callee) && /^(parseFloat|Number)$/.test(callee.name) && isGlobal(p, callee.name) && args.length === 1) {
    const v = constValue(args[0], p.scope);
    if (typeof v === 'string' || typeof v === 'number') return callee.name === 'Number' ? Number(v) : parseFloat(v);
  }
  if (!t.isMemberExpression(callee) || callee.computed) return undefined;
  const prop = callee.property.name;
  // [..].join(sep)
  if (prop === 'join' && args.length <= 1) {
    const arr = constArray(callee.object, p.scope);
    const sep = args.length ? constValue(args[0], p.scope) : ',';
    if (arr && typeof sep === 'string') return arr.join(sep);
  }
  // "a,b".split(",") sonucunu dizi olarak kullanan "x".split("").reverse().join("") gibi zincirler
  if (prop === 'join' && args.length === 1 && t.isCallExpression(callee.object)) {
    const inner = splitChain(callee.object, p);
    const sep = constValue(args[0], p.scope);
    if (inner && typeof sep === 'string') return inner.join(sep);
  }
  // String.fromCharCode / fromCodePoint (doğrudan ya da .apply(null|undefined|String, [..]))
  const strObj = (o) => t.isIdentifier(o, { name: 'String' }) && isGlobal(p, 'String');
  if (/^(fromCharCode|fromCodePoint)$/.test(prop) && strObj(callee.object)) {
    const vals = args.map((a) => constValue(a, p.scope));
    if (vals.every((v) => typeof v === 'number')) {
      try { return String[prop](...vals); } catch { return undefined; } // geçersiz kod noktası: RangeError korunur
    }
  }
  if (prop === 'apply' && t.isMemberExpression(callee.object) && !callee.object.computed && strObj(callee.object.object) &&
      /^(fromCharCode|fromCodePoint)$/.test(callee.object.property.name) && args.length === 2 &&
      (t.isNullLiteral(args[0]) || t.isIdentifier(args[0], { name: 'undefined' }) || strObj(args[0]))) {
    const vals = constArray(args[1], p.scope);
    if (vals && vals.every((v) => typeof v === 'number')) {
      try { return String[callee.object.property.name](...vals); } catch { return undefined; }
    }
  }
  // new TextDecoder(enc).decode(bytes)
  if (prop === 'decode' && t.isNewExpression(callee.object) && t.isIdentifier(callee.object.callee, { name: 'TextDecoder' }) &&
      isGlobal(p, 'TextDecoder') && callee.object.arguments.length <= 1 && args.length === 1) {
    const enc = callee.object.arguments.length ? constValue(callee.object.arguments[0], p.scope) : 'utf-8';
    if (typeof enc !== 'string' || !ENCODINGS.has(enc.toLowerCase())) return undefined;
    const bytes = bytesOf(args[0], p) ?? byteArray(constArray(args[0], p.scope));
    if (!bytes) return undefined;
    return new TextDecoder(enc.toLowerCase()).decode(bytes);
  }
  return undefined;
}

// "abc".split("") / .reverse() zinciri → dizi (yalnızca literal string kaynaklı)
function splitChain(node, p) {
  if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee) || node.callee.computed) return null;
  const prop = node.callee.property.name;
  if (prop === 'reverse' && !node.arguments.length) {
    const inner = splitChain(node.callee.object, p);
    return inner ? [...inner].reverse() : null;
  }
  if (prop === 'split' && node.arguments.length === 1) {
    const s = constValue(node.callee.object, p.scope);
    const sep = constValue(node.arguments[0], p.scope);
    if (typeof s === 'string' && typeof sep === 'string') return s.split(sep);
  }
  return null;
}

export async function run(ast, { onLog, bump }) {
  let n = 0;
  traverse(ast, {
    'CallExpression|NewExpression': {
      exit(p) {
        if (!t.isCallExpression(p.node)) return;
        // sonucu kullanılmayan çağrı yan etkisiz olsa da dokunulmaz (ölü kod pass'inin işi)
        if (p.parentPath.isExpressionStatement()) return;
        const v = fold(p);
        if (v === undefined) return;
        if (typeof v === 'string' && v.length > MAX_STRING) return;
        const lit = literalOf(t, v);
        if (!lit) return;
        p.replaceWith(lit);
        n++;
      },
    },
  });
  if (n) onLog(`static-decode: ${n} çağrı statik çözüldü`, 'info');
  bump('staticDecode', n);
}
