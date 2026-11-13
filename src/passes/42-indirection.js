import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { literalValue, isLiteralTree } from '../util/pure.js';
import { proxyKind, expand } from './28-const-objects.js';

// Dolaylılık sökücüleri. Her dönüşüm yalnızca eşdeğerliği yerel olarak kanıtlanan biçimlere uygulanır.
//  A-17  destructuring ile gizlenmiş atamalar        A-23  sabit nesneli with → açık erişim
//  E100  getter proxy        E101 sınıf statik üye proxy     E104 global nesne biçimlerini birleştirme
//  E105  this proxy          E107 bind düzleştirme           E109 bind ile kısmi uygulama
//  E112  bağımsız operatör fonksiyonu   E115 Object.create   E116 Reflect.*
//  E117  Object.defineProperty sabit değeri                  E118 Symbol anahtarlarını isimlendirme

// ── ortak ───────────────────────────────────────────────

const keyOf = (node, computed) => (!computed && t.isIdentifier(node) ? node.name
  : t.isStringLiteral(node) ? node.value : t.isNumericLiteral(node) ? String(node.value) : null);
const memberKey = (m) => keyOf(m.property, m.computed);

// Üye ifadesi okuma dışında bir konumda mı? (atama hedefi, artırma, silme, for-in/of hedefi)
function isWritten(m) {
  const par = m.parentPath;
  return par.isAssignmentExpression({ left: m.node }) || par.isUpdateExpression() ||
    par.isUnaryExpression({ operator: 'delete' }) || par.isForXStatement({ left: m.node }) ||
    (par.isArrayPattern() || par.isObjectProperty({ value: m.node }) && par.parentPath.isObjectPattern());
}

const isPureAtom = (n) => t.isIdentifier(n) || t.isThisExpression(n) || literalValue(n).ok;
const nullish = (n) => !n || t.isIdentifier(n, { name: 'undefined' }) ||
  (t.isUnaryExpression(n, { operator: 'void' }) && literalValue(n.argument).ok);

function isStrict(path) {
  for (let p = path; p; p = p.parentPath) {
    if (p.isClass()) return true;
    const dirs = p.isProgram() ? p.node.directives : p.isFunction() && t.isBlockStatement(p.node.body) ? p.node.body.directives : null;
    if (dirs?.some((d) => d.value.value === 'use strict')) return true;
    if (p.isProgram()) return p.node.sourceType === 'module';
  }
  return false;
}

// Bildirim deyimi, aynı fonksiyondaki kullanımdan önce mi? (iç fonksiyonlardaki kullanımlar sonradan çağrılır kabul edilir:
// const-objects ile aynı sözleşme)
function usedBeforeDecl(uses, declStmt) {
  const fn = declStmt.getFunctionParent();
  return uses.some((u) => u.getFunctionParent() === fn && u.node.start < declStmt.node.end);
}

// Bilinen fonksiyon bağlaması: fonksiyon bildirimi ya da hiç değişmeyen fonksiyon ifadeli değişken
function knownFunction(scope, name) {
  const b = scope.getBinding(name);
  if (!b?.constant) return null;
  if (b.path.isFunctionDeclaration() && !b.path.node.async && !b.path.node.generator) return b;
  if (b.path.isVariableDeclarator() && (t.isFunctionExpression(b.path.node.init) || t.isArrowFunctionExpression(b.path.node.init))) return b;
  return null;
}

const OBJECT_PROTO = new Set(Object.getOwnPropertyNames(Object.prototype));

function crawl(ast) {
  traverse(ast, { Program(p) { p.scope.crawl(); p.stop(); } });
}

// ── A-17: destructuring ─────────────────────────────────

// Sıralı atamaya çevrilebilir mi? Hedef adlarından biri değer tarafında geçmemeli ve ilk değerden sonrakiler
// kod çalıştırmamalı (orijinalde tüm değerler atamalardan önce hesaplanır; bir çağrı yeni atanan değeri görebilirdi).
function mentions(nodes, names) {
  let hit = false;
  for (const n of nodes) t.traverseFast(n, (x) => { if (t.isIdentifier(x) && names.has(x.name)) hit = true; });
  const inert = (v) => isLiteralTree(v) || t.isIdentifier(v) || t.isFunction(v) ||
    (t.isUnaryExpression(v, { operator: 'void' }) && literalValue(v.argument).ok);
  return hit || nodes.slice(1).some((v) => !inert(v));
}

// [a, b = 1] ← [x, y]  →  [[a, x], [b, y]]  (null: desteklenmeyen biçim)
function pairArray(pattern, init) {
  if (!t.isArrayExpression(init) || init.elements.some((e) => e === null || t.isSpreadElement(e))) return null;
  const pairs = [];
  for (const [i, el] of pattern.elements.entries()) {
    if (el === null) continue;
    let target = el;
    let value = init.elements[i] ?? null;
    if (t.isAssignmentPattern(el)) {
      // varsayılan yalnızca değer undefined iken devreye girer: değer undefined olmayan literal olmalı
      const lit = value && literalValue(value);
      if (!lit?.ok || lit.value === undefined) return null;
      target = el.left;
    }
    if (!t.isIdentifier(target) && !t.isMemberExpression(target)) return null;
    if (t.isMemberExpression(target) && !(t.isIdentifier(target.object) && !target.computed)) return null;
    pairs.push([target, value ?? t.unaryExpression('void', t.numericLiteral(0))]);
  }
  // kalan değerler yine değerlendirilir: yan etkisiz olmalı
  if (init.elements.slice(pattern.elements.length).some((e) => !isLiteralTree(e) && !t.isIdentifier(e))) return null;
  if (init.elements.some((e, i) => (i >= pattern.elements.length || pattern.elements[i] === null) && !isLiteralTree(e) && !t.isIdentifier(e))) return null;
  return pairs;
}

// {a: x, b} ← {a: 1, b: 2}
function pairObject(pattern, init) {
  if (!t.isObjectExpression(init)) return null;
  const values = new Map();
  const order = [];
  for (const p of init.properties) {
    if (!t.isObjectProperty(p) || p.computed) return null;
    const k = keyOf(p.key, false);
    if (k === null || k === '__proto__' || values.has(k)) return null;
    values.set(k, p.value);
    order.push(k);
  }
  const pairs = [];
  const used = [];
  for (const p of pattern.properties) {
    if (!t.isObjectProperty(p) || p.computed) return null;
    const k = keyOf(p.key, false);
    if (k === null || !values.has(k) || !t.isIdentifier(p.value)) return null; // eksik anahtar prototipten okunabilir
    pairs.push([p.value, values.get(k)]);
    used.push(k);
  }
  const pure = (n) => isLiteralTree(n) || t.isIdentifier(n) || t.isFunction(n);
  if (order.some((k) => !used.includes(k) && !pure(values.get(k)))) return null;
  // değerler nesne sırasıyla değerlendirilir; desen sırası farklıysa yan etkili değer olmamalı
  const sameOrder = used.every((k, i) => i === 0 || order.indexOf(k) > order.indexOf(used[i - 1]));
  if (!sameOrder && pairs.some(([, v]) => !pure(v))) return null;
  return pairs;
}

function destructuring(ast) {
  let n = 0;
  traverse(ast, {
    VariableDeclaration(p) {
      if (!Array.isArray(p.container) && !p.parentPath.isBlockStatement() && !p.parentPath.isProgram()) return;
      if (p.parentPath.isForXStatement() || p.parentPath.isForStatement()) return;
      let changed = false;
      const decls = [];
      for (const d of p.node.declarations) {
        const pairs = t.isArrayPattern(d.id) ? pairArray(d.id, d.init) : t.isObjectPattern(d.id) ? pairObject(d.id, d.init) : null;
        if (!pairs || pairs.some(([target]) => !t.isIdentifier(target))) { decls.push(d); continue; }
        const names = new Set(pairs.map(([target]) => target.name));
        if (mentions(pairs.map(([, v]) => v), names)) { decls.push(d); continue; }
        for (const [target, value] of pairs) decls.push(t.variableDeclarator(target, value));
        changed = true;
      }
      if (!changed) return;
      p.node.declarations = decls;
      n++;
    },
    ExpressionStatement(p) {
      const e = p.node.expression;
      if (!t.isAssignmentExpression(e, { operator: '=' }) || !Array.isArray(p.container)) return;
      const pairs = t.isArrayPattern(e.left) ? pairArray(e.left, e.right) : t.isObjectPattern(e.left) ? pairObject(e.left, e.right) : null;
      if (!pairs) return;
      const names = new Set();
      for (const [target] of pairs) {
        if (t.isIdentifier(target)) names.add(target.name); else names.add(target.object.name);
      }
      if (mentions(pairs.map(([, v]) => v), names)) return;
      p.replaceWithMultiple(pairs.map(([target, value]) => t.expressionStatement(t.assignmentExpression('=', target, value))));
      n++;
    },
  });
  return n;
}

// ── A-23: with (SABİT_NESNE) ────────────────────────────

function withBlocks(ast) {
  let n = 0;
  traverse(ast, {
    WithStatement(p) {
      if (!t.isIdentifier(p.node.object)) return;
      const b = p.scope.getBinding(p.node.object.name);
      if (!b?.constant || !b.path.isVariableDeclarator() || !t.isObjectExpression(b.path.node.init)) return;
      const keys = new Set();
      for (const prop of b.path.node.init.properties) {
        if (!(t.isObjectProperty(prop) || t.isObjectMethod(prop)) || prop.computed) return;
        const k = keyOf(prop.key, false);
        if (k === null || k === '__proto__') return;
        keys.add(k);
      }
      const name = p.node.object.name;
      // nesne yalnızca with nesnesi ya da var olan anahtarların statik okuması/yazması olarak kullanılmalı (anahtar kümesi sabit)
      for (const r of b.referencePaths) {
        if (r.parentPath.isWithStatement({ object: r.node })) continue;
        const m = r.parentPath;
        if (!m.isMemberExpression({ object: r.node }) || !keys.has(memberKey(m.node)) || m.parentPath.isUnaryExpression({ operator: 'delete' })) return;
      }
      // bildirim with'ten önce, aynı fonksiyonun üst seviyesinde koşulsuz çalışmış olmalı
      const declStmt = b.path.parentPath;
      if (!(declStmt.parentPath.isProgram() || (declStmt.parentPath.isBlockStatement() && declStmt.parentPath.parentPath.isFunction()))) return;
      if (p.getFunctionParent() !== b.path.getFunctionParent() || p.node.start < declStmt.node.end) return;
      const affected = (k) => keys.has(k) || OBJECT_PROTO.has(k);
      let bad = false;
      const replace = [];
      const body = p.get('body');
      body.traverse({
        WithStatement(q) { bad = true; q.stop(); },
        CallExpression(q) { if (t.isIdentifier(q.node.callee, { name: 'eval' })) { bad = true; q.stop(); } },
        // with gövdesindeki var/fonksiyon bildirimleri nesne özelliğine yazabilir
        VariableDeclaration(q) {
          if (q.node.kind !== 'var' || q.getFunctionParent() !== p.getFunctionParent()) return;
          for (const d of q.node.declarations) if (Object.keys(t.getBindingIdentifiers(d.id)).some(affected)) { bad = true; q.stop(); }
        },
        FunctionDeclaration(q) { if (q.node.id && affected(q.node.id.name)) { bad = true; q.stop(); } },
        Identifier(q) {
          const k = q.node.name;
          if (!affected(k)) return;
          const isRef = q.isReferencedIdentifier() || q.parentPath.isAssignmentExpression({ left: q.node }) ||
            q.parentPath.isUpdateExpression({ argument: q.node });
          if (!isRef) return;
          if (q.parentPath.isUnaryExpression({ operator: 'delete' })) { bad = true; q.stop(); return; }
          const qb = q.scope.getBinding(k);
          // gövde içinde (iç fonksiyon/blok kapsamında) bildirilmiş ad with nesnesinden önce çözülür
          if (qb && qb.scope.path.findParent((x) => x === body)) return;
          if (qb && qb.scope.path === body) return;
          replace.push(q);
        },
      });
      if (bad) return;
      for (const q of replace) {
        const m = t.memberExpression(t.identifier(name), t.identifier(q.node.name));
        if (q.parentPath.isObjectProperty({ value: q.node }) && q.parent.shorthand) q.parent.shorthand = false;
        q.replaceWith(m);
      }
      const inner = p.node.body;
      const lexical = t.isBlockStatement(inner) && inner.body.some((x) => t.isFunctionDeclaration(x) || t.isClassDeclaration(x) ||
        (t.isVariableDeclaration(x) && x.kind !== 'var'));
      if (t.isBlockStatement(inner) && !lexical && Array.isArray(p.container)) p.replaceWithMultiple(inner.body);
      else p.replaceWith(inner);
      n++;
    },
  });
  return n;
}

// ── E104 / E105: global nesne ve this ───────────────────

const GLOBAL_NAMES = new Set(['globalThis', 'window', 'self', 'global']);

// Function("return this") gövdesi: düz ya da obfuscator.io'nun getGlobal biçimi
const RETURN_THIS = /^\s*return\s+this\s*;?\s*$/;
const GET_GLOBAL = /^\s*return\s*\(?\s*function\s*\(\s*\)\s*\{\s*\}\s*\.constructor\s*\(\s*["']return this["']\s*\)\s*\(\s*\)\s*\)?\s*;?\s*$/;

function isGlobalForm(p, node) {
  if (t.isIdentifier(node) && GLOBAL_NAMES.has(node.name) && !p.scope.getBinding(node.name)) return true;
  // Function("return this")() / new Function(...)(): oluşturulan fonksiyon her zaman sloppy, this = global
  if (t.isCallExpression(node) && !node.arguments.length && (t.isCallExpression(node.callee) || t.isNewExpression(node.callee)) &&
      t.isIdentifier(node.callee.callee, { name: 'Function' }) && !p.scope.getBinding('Function') &&
      node.callee.arguments.length === 1 && t.isStringLiteral(node.callee.arguments[0]) &&
      (RETURN_THIS.test(node.callee.arguments[0].value) || GET_GLOBAL.test(node.callee.arguments[0].value))) return true;
  // function () {}.constructor("return this")(): bir fonksiyonun constructor'ı Function'dır
  if (t.isCallExpression(node) && !node.arguments.length && t.isCallExpression(node.callee) &&
      t.isMemberExpression(node.callee.callee) && !node.callee.callee.computed &&
      t.isIdentifier(node.callee.callee.property, { name: 'constructor' }) &&
      t.isFunctionExpression(node.callee.callee.object) && !node.callee.callee.object.async && !node.callee.callee.object.generator &&
      node.callee.arguments.length === 1 && t.isStringLiteral(node.callee.arguments[0]) && RETURN_THIS.test(node.callee.arguments[0].value)) return true;
  return false;
}

// typeof X !== "undefined" ? X : <devam>   (ya da ters yazımı)
function ladderStep(node) {
  if (!t.isConditionalExpression(node)) return null;
  const test = node.test;
  if (!t.isBinaryExpression(test) || !['!==', '!=', '===', '=='].includes(test.operator)) return null;
  const [ty, str] = t.isUnaryExpression(test.left, { operator: 'typeof' }) ? [test.left, test.right] : [test.right, test.left];
  if (!t.isUnaryExpression(ty, { operator: 'typeof' }) || !t.isIdentifier(ty.argument) || !t.isStringLiteral(str, { value: 'undefined' })) return null;
  const name = ty.argument.name;
  const positive = test.operator.startsWith('!');
  const pick = positive ? node.consequent : node.alternate;
  const rest = positive ? node.alternate : node.consequent;
  if (!t.isIdentifier(pick, { name })) return null;
  return { name, rest };
}

function globalForms(ast) {
  let n = 0;
  traverse(ast, {
    // E104: window.window, self.self, globalThis.globalThis, window.self, X.globalThis → X
    MemberExpression: {
      exit(p) {
        const { object } = p.node;
        const k = memberKey(p.node);
        if (!t.isIdentifier(object) || p.scope.getBinding(object.name) || isWritten(p) || p.parentPath.isCallExpression({ callee: p.node })) return;
        const o = object.name;
        const same = (o === k && ['window', 'self', 'globalThis'].includes(o)) || (o === 'window' && k === 'self') ||
          (k === 'globalThis' && ['window', 'self', 'globalThis'].includes(o));
        if (!same) return;
        p.replaceWith(t.identifier(o));
        n++;
      },
    },
    // E104: typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : … : this
    ConditionalExpression: {
      exit(p) {
        if (p.parentPath.isConditionalExpression()) return;
        let cur = p.node;
        let steps = 0;
        for (;;) {
          const s = ladderStep(cur);
          if (!s) break;
          if (!GLOBAL_NAMES.has(s.name) || p.scope.getBinding(s.name)) return;
          cur = s.rest;
          steps++;
        }
        // son seçenek her ortamda global nesneyi vermeli
        if (!steps || !isGlobalForm(p, cur) || (t.isIdentifier(cur) && cur.name !== 'globalThis')) return;
        if (p.scope.getBinding('globalThis')) return;
        p.replaceWith(t.identifier('globalThis'));
        n++;
      },
    },
    CallExpression: {
      exit(p) {
        if (p.scope.getBinding('globalThis')) return;
        // E105: new Function("return this")() ve getGlobal gövdesi
        if (isGlobalForm(p, p.node) && !t.isIdentifier(p.node)) { p.replaceWith(t.identifier('globalThis')); n++; return; }
        // E105: (0, eval)("this") — dolaylı eval her zaman global kapsamda
        const c = p.node.callee;
        if (t.isSequenceExpression(c) && c.expressions.length === 2 && literalValue(c.expressions[0]).ok &&
            t.isIdentifier(c.expressions[1], { name: 'eval' }) && !p.scope.getBinding('eval') &&
            p.node.arguments.length === 1 && t.isStringLiteral(p.node.arguments[0]) && /^\s*this\s*;?\s*$/.test(p.node.arguments[0].value)) {
          p.replaceWith(t.identifier('globalThis')); n++; return;
        }
        // (function () { return globalThis; })() → globalThis  (gövde tek dönüş, argümansız)
        if (t.isFunctionExpression(c) && !c.async && !c.generator && !p.node.arguments.length && !c.params.length &&
            c.body.body.length === 1 && t.isReturnStatement(c.body.body[0]) && t.isIdentifier(c.body.body[0].argument, { name: 'globalThis' })) {
          p.replaceWith(t.identifier('globalThis')); n++; return;
        }
        // E105: (function () { return this; })()  /  .call()  /  .call(undefined)
        let fn = c;
        let viaCall = false;
        if (t.isMemberExpression(c) && !c.computed && t.isIdentifier(c.property, { name: 'call' }) && p.node.arguments.length <= 1 &&
            nullish(p.node.arguments[0])) { fn = c.object; viaCall = true; }
        if (!viaCall && p.node.arguments.length) return;
        if (!t.isFunctionExpression(fn) || fn.async || fn.generator || fn.body.body.length !== 1) return;
        const ret = fn.body.body[0];
        if (!t.isReturnStatement(ret) || !t.isThisExpression(ret.argument)) return;
        const strict = isStrict(p) || fn.body.directives.some((d) => d.value.value === 'use strict');
        p.replaceWith(strict ? t.unaryExpression('void', t.numericLiteral(0)) : t.identifier('globalThis'));
        n++;
      },
    },
  });
  return n;
}

// ── E115: Object.create → nesne literali ────────────────

function descriptorToProp(key, desc) {
  if (!t.isObjectExpression(desc)) return null;
  const f = new Map();
  for (const p of desc.properties) {
    if (!t.isObjectProperty(p) || p.computed) return null;
    const k = keyOf(p.key, false);
    if (!['value', 'writable', 'enumerable', 'configurable', 'get', 'set'].includes(k) || f.has(k)) return null;
    f.set(k, p.value);
  }
  const isTrue = (k) => t.isBooleanLiteral(f.get(k), { value: true });
  if (!isTrue('enumerable') || !isTrue('configurable')) return null;
  const keyNode = t.isValidIdentifier(key) ? t.identifier(key) : t.stringLiteral(key);
  if (f.has('get') || f.has('set')) {
    if (f.has('value') || f.has('writable')) return null;
    const out = [];
    for (const kind of ['get', 'set']) {
      const fn = f.get(kind);
      if (!fn) continue;
      // yalnızca adsız, super/new.target kullanmayan fonksiyon ifadeleri metot olarak yazılabilir
      if (!t.isFunctionExpression(fn) || fn.id || fn.async || fn.generator || (kind === 'get' && fn.params.length) || (kind === 'set' && fn.params.length !== 1)) return null;
      let bad = false;
      t.traverseFast(fn.body, (x) => { if (t.isMetaProperty(x) || t.isSuper(x)) bad = true; });
      if (bad) return null;
      out.push(t.objectMethod(kind, t.cloneNode(keyNode), fn.params, fn.body));
    }
    return out;
  }
  if (!isTrue('writable')) return null;
  return [t.objectProperty(keyNode, f.get('value') ?? t.unaryExpression('void', t.numericLiteral(0)))];
}

function objectCreate(ast) {
  let n = 0;
  traverse(ast, {
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.object, { name: 'Object' }) ||
          !t.isIdentifier(callee.property, { name: 'create' }) || p.scope.getBinding('Object')) return;
      if (!args.length || args.length > 2 || args.some((a) => t.isSpreadElement(a))) return;
      const [proto, descs] = args;
      const props = [];
      const isObjectProto = t.isMemberExpression(proto) && !proto.computed && t.isIdentifier(proto.object, { name: 'Object' }) &&
        t.isIdentifier(proto.property, { name: 'prototype' });
      if (t.isNullLiteral(proto) || t.isObjectExpression(proto)) props.push(t.objectProperty(t.identifier('__proto__'), proto));
      else if (!isObjectProto) return;
      if (descs) {
        if (!t.isObjectExpression(descs)) return;
        const seen = new Set();
        for (const d of descs.properties) {
          if (!t.isObjectProperty(d) || d.computed) return;
          const k = keyOf(d.key, false);
          if (k === null || k === '__proto__' || seen.has(k)) return;
          seen.add(k);
          const out = descriptorToProp(k, d.value);
          if (!out) return;
          props.push(...out);
        }
      }
      p.replaceWith(t.objectExpression(props));
      n++;
    },
  });
  return n;
}

// ── E116: Reflect.* ─────────────────────────────────────

const GLOBAL_OBJECTS = new Set(['Math', 'JSON', 'console', 'globalThis', 'window', 'document', 'Reflect', 'Atomics', 'Intl']);

// Değer kesinlikle nesne mi? (Reflect.get primitive'de TypeError verir, o.k vermez)
function isObjectValue(p, node) {
  if (t.isObjectExpression(node) || t.isArrayExpression(node) || t.isFunction(node) || t.isClassExpression(node)) return true;
  if (!t.isIdentifier(node)) return false;
  const b = p.scope.getBinding(node.name);
  if (!b) return GLOBAL_OBJECTS.has(node.name);
  if (!b.constant) return false;
  if (b.path.isFunctionDeclaration() || b.path.isClassDeclaration()) return true;
  return b.path.isVariableDeclarator() && (t.isObjectExpression(b.path.node.init) || t.isArrayExpression(b.path.node.init) ||
    t.isFunction(b.path.node.init) || t.isClassExpression(b.path.node.init));
}

function reflect(ast) {
  let n = 0;
  traverse(ast, {
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.object, { name: 'Reflect' }) || p.scope.getBinding('Reflect')) return;
      if (args.some((a) => t.isSpreadElement(a))) return;
      const m = callee.property.name;
      if (m === 'get' && args.length === 2 && isObjectValue(p, args[0])) {
        p.replaceWith(t.memberExpression(args[0], args[1], true)); n++; return;
      }
      if (m === 'set' && args.length === 3 && isObjectValue(p, args[0]) && literalValue(args[1]).ok &&
          p.parentPath.isExpressionStatement() && !isStrict(p)) {
        // sonuç kullanılmıyor ve sloppy mod: başarısız yazma iki biçimde de sessiz
        p.replaceWith(t.assignmentExpression('=', t.memberExpression(args[0], args[1], true), args[2])); n++; return;
      }
      if (m === 'has' && args.length === 2 && isPureAtom(args[0]) && isPureAtom(args[1])) {
        p.replaceWith(t.binaryExpression('in', args[1], args[0])); n++; return;
      }
      const list = args[m === 'apply' ? 2 : 1];
      const plainList = t.isArrayExpression(list) && list.elements.every((e) => e !== null);
      const safeOrder = (fn) => t.isIdentifier(fn) && (knownFunction(p.scope, fn.name) || list.elements.every((e) => isPureAtom(e)));
      if (m === 'apply' && args.length === 3 && plainList && safeOrder(args[0])) {
        p.replaceWith(t.callExpression(t.memberExpression(args[0], t.identifier('call')), [args[1], ...list.elements])); n++; return;
      }
      if (m === 'construct' && args.length === 2 && plainList && safeOrder(args[0])) {
        p.replaceWith(t.newExpression(args[0], list.elements)); n++;
      }
    },
  });
  return n;
}

// ── E107 / E109: bind ───────────────────────────────────

function binds(ast) {
  let n = 0;
  traverse(ast, {
    CallExpression(p) {
      const inner = p.node.callee;
      // E107: F.bind(T, ...A)(...B) → F.call(T, ...A, ...B)  (F bilinen fonksiyon: bind TypeError'ı oluşamaz)
      if (!t.isCallExpression(inner) || !t.isMemberExpression(inner.callee) || inner.callee.computed ||
          !t.isIdentifier(inner.callee.property, { name: 'bind' })) return;
      const F = inner.callee.object;
      const all = [...inner.arguments, ...p.node.arguments];
      if (all.some((a) => t.isSpreadElement(a))) return;
      const known = t.isIdentifier(F) && knownFunction(p.scope, F.name);
      // o.m.bind(o)(...) → o.m(...)  (argümanlar yan etkisiz: hata sırası değişmez)
      if (!known && t.isMemberExpression(F) && t.isIdentifier(F.object) && t.isIdentifier(inner.arguments[0], { name: F.object.name }) &&
          all.slice(1).every(isPureAtom)) {
        p.replaceWith(t.callExpression(F, [...inner.arguments.slice(1), ...p.node.arguments])); n++; return;
      }
      if (!known) return;
      const [T = t.unaryExpression('void', t.numericLiteral(0)), ...A] = inner.arguments;
      p.replaceWith(t.callExpression(t.memberExpression(F, t.identifier('call')), [T, ...A, ...p.node.arguments]));
      n++;
    },
    // E109: var g = F.bind(T, 1, "x"); g(y) → F.call(T, 1, "x", y)
    VariableDeclarator(p) {
      const { id, init } = p.node;
      if (!t.isIdentifier(id) || !t.isCallExpression(init) || !t.isMemberExpression(init.callee) || init.callee.computed ||
          !t.isIdentifier(init.callee.property, { name: 'bind' }) || !t.isIdentifier(init.callee.object)) return;
      const F = init.callee.object;
      const fb = knownFunction(p.scope, F.name);
      if (!fb || !init.arguments.length || !init.arguments.every((a) => literalValue(a).ok)) return;
      const b = p.scope.getBinding(id.name);
      if (!b?.constant || !b.referencePaths.length) return;
      // bağlı fonksiyon new ile çağrılırsa T yok sayılır: yalnızca düz çağrılar
      const calls = b.referencePaths.map((r) => r.parentPath);
      if (!calls.every((c, i) => c.isCallExpression({ callee: b.referencePaths[i].node }) && !c.node.arguments.some((a) => t.isSpreadElement(a)))) return;
      if (!calls.every((c) => c.scope.getBinding(F.name) === fb)) return;
      if (usedBeforeDecl(calls, p.parentPath)) return;
      for (const c of calls) {
        c.replaceWith(t.callExpression(t.memberExpression(t.identifier(F.name), t.identifier('call')),
          [...init.arguments.map((a) => t.cloneNode(a)), ...c.node.arguments]));
        n++;
      }
      p.remove();
    },
  });
  return n;
}

// ── E117: Object.defineProperty sabit değeri ────────────

function definedConstants(ast) {
  let n = 0;
  traverse(ast, {
    ExpressionStatement(p) {
      const e = p.node.expression;
      if (!t.isCallExpression(e) || !Array.isArray(p.container)) return;
      const c = e.callee;
      if (!t.isMemberExpression(c) || c.computed || !t.isIdentifier(c.object, { name: 'Object' }) ||
          !t.isIdentifier(c.property, { name: 'defineProperty' }) || p.scope.getBinding('Object')) return;
      const [obj, keyNode, desc] = e.arguments;
      if (e.arguments.length !== 3 || !t.isIdentifier(obj) || !literalValue(keyNode).ok || !t.isObjectExpression(desc)) return;
      const key = String(literalValue(keyNode).value);
      let value = null;
      for (const prop of desc.properties) {
        if (!t.isObjectProperty(prop) || prop.computed) return;
        const k = keyOf(prop.key, false);
        if (k === 'value') value = prop.value;
        else if (k === 'writable' || k === 'configurable') { if (!t.isBooleanLiteral(prop.value, { value: false })) return; } else if (k !== 'enumerable') return;
      }
      // yazılamaz + yapılandırılamaz: değer bundan sonra hiç değişemez
      if (!value || !literalValue(value).ok) return;
      const b = p.scope.getBinding(obj.name);
      if (!b?.constant || !b.path.isVariableDeclarator() || !t.isObjectExpression(b.path.node.init)) return;
      const init = b.path.node.init;
      if (init.properties.some((x) => !t.isObjectProperty(x) && !t.isObjectMethod(x) || x.computed || keyOf(x.key, false) === key || keyOf(x.key, false) === '__proto__')) return;
      const declStmt = b.path.parentPath;
      if (declStmt.parentPath !== p.parentPath || declStmt.key > p.key) return;
      const reads = [];
      for (const r of b.referencePaths) {
        if (r.parentPath === p.get('expression') || r.parent === e) continue;
        const m = r.parentPath;
        if (!m.isMemberExpression({ object: r.node }) || memberKey(m.node) === null) return;
        if (memberKey(m.node) !== key) continue;
        if (isWritten(m) || m.parentPath.isCallExpression({ callee: m.node })) return;
        reads.push(m);
      }
      // okuma tanımdan sonra: aynı fonksiyonda kaynakta sonra, ya da tanımdan sonra oluşturulan iç fonksiyon ifadesinde
      const fn = p.getFunctionParent();
      const after = (m) => {
        if (m.node.start < p.node.end) return false;
        let f = m.getFunctionParent();
        if (f === fn) return true;
        while (f && f.getFunctionParent() !== fn) f = f.getFunctionParent();
        return Boolean(f) && !f.isFunctionDeclaration() && f.node.start > p.node.end;
      };
      for (const m of reads) {
        if (!after(m)) continue;
        m.replaceWith(t.cloneNode(value, true));
        n++;
      }
    },
  });
  return n;
}

// ── E100: getter proxy ──────────────────────────────────

function valueNames(node, out = new Set()) {
  if (t.isIdentifier(node, { name: 'arguments' })) return null;
  if (t.isIdentifier(node)) { out.add(node.name); return out; }
  if (t.isMemberExpression(node) && (!node.computed || t.isStringLiteral(node.property))) return valueNames(node.object, out);
  return null;
}

function getterProxies(ast) {
  let n = 0;
  traverse(ast, {
    VariableDeclarator(p) {
      const { id, init } = p.node;
      if (!t.isIdentifier(id) || !t.isObjectExpression(init)) return;
      const getters = new Map();
      const keys = new Set();
      for (const prop of init.properties) {
        if (!(t.isObjectProperty(prop) || t.isObjectMethod(prop)) || prop.computed) return;
        const k = keyOf(prop.key, false);
        if (k === null || k === '__proto__' || keys.has(k)) return;
        keys.add(k);
        if (t.isObjectMethod(prop) && prop.kind === 'set') return;
        if (t.isObjectMethod(prop, { kind: 'get' }) && prop.body.body.length === 1 && t.isReturnStatement(prop.body.body[0])) {
          const value = prop.body.body[0].argument;
          const names = value && valueNames(value);
          if (names) getters.set(k, { value, names, prop });
        }
      }
      if (!getters.size) return;
      const b = p.scope.getBinding(id.name);
      if (!b?.constant) return;
      const uses = [];
      for (const r of b.referencePaths) {
        const m = r.parentPath;
        if (!m.isMemberExpression({ object: r.node }) || memberKey(m.node) === null) return;
        const g = getters.get(memberKey(m.node));
        if (!g) continue;
        if (isWritten(m) || m.parentPath.isCallExpression({ callee: m.node }) || m.parentPath.isOptionalCallExpression()) continue;
        uses.push({ m, g });
      }
      if (usedBeforeDecl(uses.map((u) => u.m), p.parentPath)) return;
      const getterScope = (g) => p.get('init').get('properties').find((x) => x.node === g.prop).scope;
      for (const { m, g } of uses) {
        const gs = getterScope(g);
        if ([...g.names].some((nm) => gs.getOwnBinding(nm) || m.scope.getBinding(nm) !== gs.getBinding(nm))) continue;
        m.replaceWith(t.cloneNode(g.value, true));
        n++;
      }
    },
  });
  return n;
}

// ── E101 / E112: sınıf statik üye ve bağımsız operatör fonksiyonları ──

const asFnExpr = (m) => t.functionExpression(null, m.params, m.body, m.generator, m.async);

function classProxies(ast) {
  let n = 0;
  traverse(ast, {
    ClassDeclaration(p) {
      const cls = p.node;
      if (!cls.id || cls.superClass || cls.decorators?.length) return;
      const members = new Map();
      for (const m of cls.body.body) {
        if (!m.static) continue;
        if (m.computed || t.isClassPrivateMethod(m) || t.isClassPrivateProperty(m) || t.isStaticBlock(m)) return;
        const k = keyOf(m.key, false);
        if (k === null) return;
        if (members.has(k)) return;
        if (t.isClassMethod(m, { kind: 'method' })) {
          const kind = proxyKind(asFnExpr(m));
          members.set(k, kind ? { kind } : { other: true });
        } else if (t.isClassProperty(m) && m.value && literalValue(m.value).ok) members.set(k, { literal: m.value });
        else if (t.isClassProperty(m) && m.value && !t.isFunction(m.value)) return; // sınıf kaldırılınca başlatıcının yan etkisi kaybolur
        else members.set(k, { other: true });
      }
      if (cls.body.body.some((m) => t.isStaticBlock(m))) return;
      const b = p.parentPath.scope.getBinding(cls.id.name);
      if (!b?.constant || !b.referencePaths.length) return;
      const uses = [];
      for (const r of b.referencePaths) {
        if (r.findParent((x) => x === p)) return;
        const m = r.parentPath;
        if (!m.isMemberExpression({ object: r.node })) return; // new C(), C başka yere veriliyor: üyeler değişebilir
        const e = members.get(memberKey(m.node));
        if (!e || e.other || isWritten(m)) return;
        if (e.kind) {
          const call = m.parentPath;
          if (!call.isCallExpression({ callee: m.node }) || call.node.arguments.length !== e.kind.arity ||
              call.node.arguments.some((a) => t.isSpreadElement(a))) return;
          uses.push({ path: call, e });
        } else {
          if (m.parentPath.isCallExpression({ callee: m.node })) return;
          uses.push({ path: m, e });
        }
      }
      if (usedBeforeDecl(uses.map((u) => u.path), p)) return;
      for (const u of uses.sort((a, c) => c.path.node.start - a.path.node.start)) {
        if (!u.path.node) continue;
        u.path.replaceWith(u.e.kind ? expand(u.e.kind, u.path.node.arguments) : t.cloneNode(u.e.literal, true));
        n++;
      }
      p.remove();
    },
  });
  return n;
}

function operatorFunctions(ast, level) {
  let n = 0;
  traverse(ast, {
    FunctionDeclaration(p) {
      // program kapsamındaki fonksiyon başka script'lerden çağrılabilir: yalnızca maksimum seviyede
      if (p.parentPath.isProgram() && level < 4) return;
      if (!p.node.id || p.parentPath.isExportDeclaration()) return;
      const kind = proxyKind(t.functionExpression(null, p.node.params, p.node.body, p.node.generator, p.node.async));
      if (!kind) return;
      const b = p.parentPath.scope.getBinding(p.node.id.name);
      if (!b?.constant || !b.referencePaths.length) return;
      const calls = b.referencePaths.map((r) => r.parentPath);
      if (!calls.every((c, i) => c.isCallExpression({ callee: b.referencePaths[i].node }) &&
          c.node.arguments.length === kind.arity && !c.node.arguments.some((a) => t.isSpreadElement(a)))) return;
      if (b.referencePaths.some((r) => r.findParent((x) => x === p))) return;
      for (const c of calls.sort((a, d) => d.node.start - a.node.start)) {
        if (!c.node) continue;
        c.replaceWith(expand(kind, c.node.arguments));
        n++;
      }
      p.remove();
    },
  });
  return n;
}

// ── E118: Symbol anahtarlarını isimlendirme ─────────────

const GENERATED = /^(_0x[0-9a-f]+|[a-zA-Z_$][0-9a-zA-Z_$]?|[vc]\d+|_?[a-zA-Z]{1,3}\d{2,})$/i;

function symbolNames(ast) {
  const taken = new Set();
  traverse(ast, {
    Program(p) { for (const g of Object.keys(p.scope.globals)) taken.add(g); },
    Scopable(p) { for (const k of Object.keys(p.scope.bindings)) taken.add(k); },
  });
  let n = 0;
  traverse(ast, {
    VariableDeclarator(p) {
      const { id, init } = p.node;
      if (!t.isIdentifier(id) || !GENERATED.test(id.name) || !t.isCallExpression(init) || init.arguments.length !== 1 ||
          !t.isStringLiteral(init.arguments[0]) || p.scope.getBinding('Symbol')) return;
      const c = init.callee;
      const isSym = t.isIdentifier(c, { name: 'Symbol' }) ||
        (t.isMemberExpression(c) && !c.computed && t.isIdentifier(c.object, { name: 'Symbol' }) && t.isIdentifier(c.property, { name: 'for' }));
      if (!isSym) return;
      const b = p.scope.getBinding(id.name);
      if (!b?.constant) return;
      const words = init.arguments[0].value.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 4);
      if (!words.length) return;
      const base = `sym${words.map((w) => w[0].toUpperCase() + w.slice(1)).join('')}`.slice(0, 40);
      let name = base;
      for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
      taken.add(name);
      p.scope.rename(id.name, name);
      n++;
    },
  });
  return n;
}

// ── sürücü ──────────────────────────────────────────────

export async function run(ast, { onLog, bump, level }) {
  const steps = [
    ['destructuring', 'A-17 destructuring açıldı', () => destructuring(ast)],
    ['withConst', 'A-23 sabit nesneli with açık erişime çevrildi', () => withBlocks(ast)],
    ['globalForm', 'E104/E105 global nesne/this biçimi globalThis yapıldı', () => globalForms(ast)],
    ['objectCreate', 'E115 Object.create literal yapıldı', () => objectCreate(ast)],
    ['reflect', 'E116 Reflect çağrısı açıldı', () => reflect(ast)],
    ['bind', 'E107/E109 bind düzleştirildi', () => binds(ast)],
    ['definedConst', 'E117 defineProperty sabiti okuma yerine yazıldı', () => definedConstants(ast)],
    ['getterProxy', 'E100 getter proxy açıldı', () => getterProxies(ast)],
    ['classProxy', 'E101 sınıf statik üye proxy açıldı', () => classProxies(ast)],
    ['operatorFn', 'E112 operatör fonksiyonu açıldı', () => operatorFunctions(ast, level)],
    ['symbolName', 'E118 Symbol değişkeni isimlendirildi', () => symbolNames(ast)],
  ];
  let changed = false;
  for (const [stat, label, step] of steps) {
    if (changed) { crawl(ast); changed = false; }
    const k = step();
    if (!k) continue;
    changed = true;
    bump(stat, k);
    onLog(`indirection: ${label} (${k})`, 'info');
  }
}
