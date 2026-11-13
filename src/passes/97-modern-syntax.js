import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { scan, usesOwnContext, callOnlyProperty } from '../naming/scope.js';

// 78: ES5 → modern sözdizimi (kanıtlanabilir alt küme)
//  - ok fonksiyonu: yalnızca yerleşik API'lere verilen callback'ler (dizi metotları, Promise, zamanlayıcılar);
//    bunlar callback'i new ile çağırmaz, prototype/name okumaz. Gövdede this/arguments/super/new.target yok.
//  - şablon string: "a" + x + "b" zinciri, ifadeler kanıtlanabilir primitive ise (nesnede valueOf/toString sırası farklı)
//  - kısa özellik: { a: a } → { a }; kısa metot: { f: function () {} } → { f() {} } (f programda yalnızca çağrılıyorsa)

const ARRAY_CALLBACKS = new Set(['map', 'forEach', 'filter', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex',
  'findLast', 'findLastIndex', 'flatMap', 'sort']);
const PROMISE_CALLBACKS = new Set(['then', 'catch', 'finally']);
const GLOBAL_CALLBACKS = new Set(['setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask']);
const PRIMITIVE_GLOBALS = new Set(['String', 'Number', 'Boolean', 'parseInt', 'parseFloat', 'encodeURIComponent', 'encodeURI',
  'decodeURIComponent', 'decodeURI', 'escape', 'unescape', 'isNaN', 'isFinite']);

const propKey = (m) => (!m.computed && t.isIdentifier(m.property) ? m.property.name
  : t.isStringLiteral(m.property) ? m.property.value : null);

export async function run(ast, { onLog, bump, naming = {} }) {
  if (naming.modernSyntax === false) return;
  const info = scan(ast);
  // programda yeniden atanan yerleşik isimler: callback garantisi kalmaz
  const overwritten = new Set();
  traverse(ast, {
    AssignmentExpression(p) {
      const l = p.node.left;
      if (t.isIdentifier(l) && !p.scope.getBinding(l.name)) overwritten.add(l.name);
      if (t.isMemberExpression(l)) { const k = propKey(l); if (k) overwritten.add(k); }
    },
  });
  const stats = { arrows: 0, templates: 0, shorthand: 0, methods: 0 };

  traverse(ast, {
    FunctionExpression: {
      exit(p) {
        if (!builtinCallback(p, overwritten)) return;
        const fn = p.node;
        if (fn.generator) return;
        if (fn.id && p.scope.getBinding(fn.id.name)?.referencePaths.length) return;
        const names = fn.params.filter((x) => t.isIdentifier(x)).map((x) => x.name);
        if (new Set(names).size !== names.length) return;
        if (usesOwnContext(p)) return;
        let body = fn.body;
        if (body.body.length === 1 && t.isReturnStatement(body.body[0]) && body.body[0].argument && !body.directives.length &&
          !(body.body[0].leadingComments?.length || body.body[0].trailingComments?.length)) {
          body = body.body[0].argument;
        }
        if (fn.body.directives.length) return; // gövde yönergesi (use strict) ok fonksiyonunda basit parametre ister
        const arrow = t.arrowFunctionExpression(fn.params, body, fn.async);
        t.inheritsComments(arrow, fn);
        p.replaceWith(arrow);
        stats.arrows++;
      },
    },
    BinaryExpression: {
      exit(p) {
        if (p.node.operator !== '+' || p.parentPath.isBinaryExpression({ operator: '+', left: p.node })) return;
        const parts = [];
        let cur = p.node;
        while (t.isBinaryExpression(cur, { operator: '+' })) { parts.unshift(cur.right); cur = cur.left; }
        parts.unshift(cur);
        if (!t.isStringLiteral(parts[0]) || parts.length < 2) return;
        const exprs = parts.filter((x) => !t.isStringLiteral(x));
        if (!exprs.length) return;
        // her ifade ilk string'den sonra string birleştirmeye girer: ToPrimitive(default) ≡ ToString yalnızca primitive'de
        const paths = collectPaths(p, parts.length);
        if (!paths.every((x, i) => t.isStringLiteral(parts[i]) || provablyPrimitive(x, new Set()))) return;
        const quasis = [];
        const expressions = [];
        let text = '';
        for (const part of parts) {
          if (t.isStringLiteral(part)) { text += part.value; continue; }
          quasis.push(t.templateElement({ raw: escapeRaw(text), cooked: text }));
          expressions.push(part);
          text = '';
        }
        quasis.push(t.templateElement({ raw: escapeRaw(text), cooked: text }, true));
        p.replaceWith(t.templateLiteral(quasis, expressions));
        stats.templates++;
      },
    },
    ObjectProperty(p) {
      const { key, value } = p.node;
      if (p.node.computed || p.node.shorthand || !t.isIdentifier(key) || key.name === '__proto__') return;
      if (t.isIdentifier(value, { name: key.name })) {
        p.node.shorthand = true;
        p.node.value = t.identifier(key.name);
        stats.shorthand++;
        return;
      }
      if (t.isFunctionExpression(value) && p.parentPath.isObjectExpression() && !value.generator) {
        if (value.id && p.get('value').scope.getBinding(value.id.name)?.referencePaths.length) return;
        if (!callOnlyProperty(info, key.name)) return;
        // gövdede super yok (normal fonksiyonda zaten olamaz); metot sıkı modluğu dış bağlamdan alır
        const m = t.objectMethod('method', t.identifier(key.name), value.params, value.body, false, value.generator, value.async);
        t.inheritsComments(m, p.node);
        p.replaceWith(m);
        stats.methods++;
      }
    },
  });
  const total = stats.arrows + stats.templates + stats.shorthand + stats.methods;
  if (total) onLog(`modern-syntax: ${stats.arrows} ok fonksiyonu, ${stats.templates} şablon string, ${stats.shorthand} kısa özellik, ${stats.methods} kısa metot`, 'info');
  bump('modernSyntax', total);
}

// "a" + x + "b" zincirindeki parçaların yolları (soldan sağa)
function collectPaths(p, n) {
  const out = [];
  let cur = p;
  while (cur.isBinaryExpression({ operator: '+' }) && out.length < n - 1) { out.unshift(cur.get('right')); cur = cur.get('left'); }
  out.unshift(cur);
  return out;
}

function escapeRaw(s) {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/\r/g, '\\r');
}

// İfadenin değeri her zaman primitive mi (kanıt)?
export function provablyPrimitive(p, seen) {
  const n = p.node;
  if (t.isStringLiteral(n) || t.isNumericLiteral(n) || t.isBooleanLiteral(n) || t.isNullLiteral(n) || t.isBigIntLiteral(n) || t.isTemplateLiteral(n)) return true;
  if (t.isUnaryExpression(n) || t.isUpdateExpression(n)) return true; // -x, !x, typeof x, void x, ++x: hep primitive
  if (t.isBinaryExpression(n)) return true; // aritmetik, karşılaştırma, + : sonuç daima primitive
  if (t.isLogicalExpression(n)) return provablyPrimitive(p.get('left'), seen) && provablyPrimitive(p.get('right'), seen);
  if (t.isConditionalExpression(n)) return provablyPrimitive(p.get('consequent'), seen) && provablyPrimitive(p.get('alternate'), seen);
  if (t.isSequenceExpression(n)) return provablyPrimitive(p.get('expressions').at(-1), seen);
  if (t.isCallExpression(n)) {
    const c = n.callee;
    if (t.isIdentifier(c) && PRIMITIVE_GLOBALS.has(c.name) && !p.scope.getBinding(c.name)) return true;
    if (t.isMemberExpression(c) && t.isIdentifier(c.object, { name: 'Math' }) && !p.scope.getBinding('Math')) return true;
    if (t.isMemberExpression(c) && t.isIdentifier(c.object, { name: 'JSON' }) && propKey(c) === 'stringify' && !p.scope.getBinding('JSON')) return true;
    return false;
  }
  if (t.isIdentifier(n)) {
    if ((n.name === 'undefined' || n.name === 'NaN' || n.name === 'Infinity') && !p.scope.getBinding(n.name)) return true;
    const b = p.scope.getBinding(n.name);
    if (!b || !b.constant || seen.has(b) || !b.path.isVariableDeclarator() || !b.path.node.init) return false;
    seen.add(b);
    return provablyPrimitive(b.path.get('init'), seen);
  }
  return false;
}

// Fonksiyon ifadesi, yerleşik bir API'ye doğrudan callback olarak mı veriliyor?
function builtinCallback(p, overwritten) {
  const par = p.parentPath;
  if (par.isNewExpression() && t.isIdentifier(par.node.callee, { name: 'Promise' }) && par.node.arguments[0] === p.node &&
    !par.scope.getBinding('Promise') && !overwritten.has('Promise')) return true;
  if (!par.isCallExpression() || !par.node.arguments.includes(p.node)) return false;
  const c = par.node.callee;
  if (t.isIdentifier(c)) return GLOBAL_CALLBACKS.has(c.name) && !par.scope.getBinding(c.name) && !overwritten.has(c.name) && par.node.arguments[0] === p.node;
  if (!t.isMemberExpression(c)) return false;
  const k = propKey(c);
  if (!k || overwritten.has(k)) return false;
  const recv = par.get('callee.object');
  if (ARRAY_CALLBACKS.has(k)) {
    if (par.node.arguments[0] !== p.node) return false;
    return isProvenArray(recv);
  }
  if (PROMISE_CALLBACKS.has(k)) return isProvenPromise(recv);
  if ((k === 'setTimeout' || k === 'setInterval') && t.isIdentifier(c.object) && ['window', 'self', 'globalThis'].includes(c.object.name) &&
    !par.scope.getBinding(c.object.name)) return par.node.arguments[0] === p.node;
  return false;
}

// Alıcı kesin dizi mi: dizi literali, Array.from/of, split/map/filter/slice/concat sonucu ya da öyle başlatılmış sabit değişken
export function isProvenArray(p, depth = 0) {
  const n = p.node;
  if (t.isArrayExpression(n)) return true;
  if (depth > 4) return false;
  if (t.isCallExpression(n) && t.isMemberExpression(n.callee)) {
    const k = propKey(n.callee);
    if (t.isIdentifier(n.callee.object, { name: 'Array' }) && !p.scope.getBinding('Array') && (k === 'from' || k === 'of')) return true;
    if (t.isIdentifier(n.callee.object, { name: 'Object' }) && !p.scope.getBinding('Object') && (k === 'keys' || k === 'values' || k === 'entries')) return true;
    if (k === 'split' && t.isStringLiteral(n.callee.object)) return true;
    if (['map', 'filter', 'slice', 'concat', 'flatMap', 'flat'].includes(k) && isProvenArray(p.get('callee.object'), depth + 1)) return true;
  }
  if (t.isIdentifier(n)) {
    const b = p.scope.getBinding(n.name);
    if (!b || !b.constant || !b.path.isVariableDeclarator() || !b.path.node.init) return false;
    return isProvenArray(b.path.get('init'), depth + 1);
  }
  return false;
}

function isProvenPromise(p, depth = 0) {
  const n = p.node;
  if (depth > 6) return false;
  if (t.isCallExpression(n)) {
    if (t.isIdentifier(n.callee, { name: 'fetch' }) && !p.scope.getBinding('fetch')) return true;
    if (t.isMemberExpression(n.callee)) {
      const k = propKey(n.callee);
      if (t.isIdentifier(n.callee.object, { name: 'Promise' }) && !p.scope.getBinding('Promise')) return ['all', 'allSettled', 'race', 'any', 'resolve', 'reject'].includes(k);
      if (PROMISE_CALLBACKS.has(k)) return isProvenPromise(p.get('callee.object'), depth + 1);
    }
    // async fonksiyon çağrısı
    if (t.isIdentifier(n.callee)) {
      const b = p.scope.getBinding(n.callee.name);
      const fn = b?.path.isFunctionDeclaration() ? b.path.node : null;
      return Boolean(fn?.async && b.constant);
    }
  }
  if (t.isNewExpression(n) && t.isIdentifier(n.callee, { name: 'Promise' }) && !p.scope.getBinding('Promise')) return true;
  return false;
}
