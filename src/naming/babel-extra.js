import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { provablyPrimitive, isProvenArray } from '../passes/97-modern-syntax.js';

// 79 (devam): Babel'in diğer yaygın yardımcı kalıntıları. Her kural yalnızca eşdeğerliği kanıtlanan biçime uygulanır.
//  - _createForOfIteratorHelper(X) try/catch/finally döngüsü, _createForOfIteratorHelperLoose(X) döngüsü
//    ve dizi indeks döngüsü (for (var _i = 0, _a = X; _i < _a.length; _i++)) → for (… of X)
//  - _toArray(x) + _arrayLikeToArray(_x).slice(n) → [a, ...rest] deseni
//  - _objectWithoutProperties(Loose)(src, ["a"]) → { a, ...rest } = src
//  - (_o = {}, _o[k] = v, _o.p = w, _o) → { [k]: v, p: w }   (gevşek mod nesne literali)
//  - [].concat(a, b) (a, b kesin dizi) → [...a, ...b];   o.f.apply(o, [...x]) → o.f(...x)
//  - _extends({}, …) → nesne yayma (kaynaklarda kendi "__proto__" anahtarı olamıyorsa; yoksa Object.assign)

const propKey = (m) => (!m.computed && t.isIdentifier(m.property) ? m.property.name
  : t.isStringLiteral(m.property) ? m.property.value : null);

// Yerleşik yineleyiciler next()'te hata atmaz ve return() tanımlamaz: yardımcının kapanış farkı gözlenemez
function builtinIterable(p, depth = 0) {
  const n = p.node;
  if (depth > 4) return false;
  if (t.isArrayExpression(n) || t.isStringLiteral(n) || t.isTemplateLiteral(n)) return true;
  if (t.isNewExpression(n) && t.isIdentifier(n.callee) && ['Set', 'Map'].includes(n.callee.name) && !p.scope.getBinding(n.callee.name)) return true;
  if (isProvenArray(p)) return true;
  if (t.isIdentifier(n)) {
    const b = p.scope.getBinding(n.name);
    if (!b || !b.constant || !b.path.isVariableDeclarator() || !b.path.node.init) return false;
    return builtinIterable(b.path.get('init'), depth + 1);
  }
  return false;
}

// Çağrısı bir generator fonksiyonuna (programda tek tanım) gidiyor mu? Generator'ın next() hatası sonrası return()
// tamamlanmış nesnede etkisizdir; break/hata kapanışı yerel for-of ile aynıdır.
function generatorCall(p) {
  const n = p.node;
  if (!t.isCallExpression(n) || !t.isIdentifier(n.callee)) return false;
  const b = p.scope.getBinding(n.callee.name);
  return Boolean(b?.constant && b.path.isFunctionDeclaration() && b.path.node.generator);
}

// Kalıbın geçici adları yalnızca kalıbın içinde geçmeli
function onlyUsedWithin(scope, names, nodes) {
  for (const name of names) {
    const b = scope.getBinding(name);
    if (!b) return false;
    const inside = (r) => nodes.some((n) => r.node === n || r.findParent((x) => x.node === n));
    if (![...b.referencePaths, ...b.constantViolations].every(inside)) return false;
  }
  return true;
}

function removeDeclarators(scope, names) {
  for (const name of names) {
    const b = scope.getBinding(name);
    const d = b?.path;
    if (!d?.isVariableDeclarator()) continue;
    if (d.parent.declarations.length === 1) d.parentPath.remove();
    else d.remove();
  }
}

// for (var x = _step.value, y = x[0] …) gövdesinin ilk deyiminden döngü başı ve gövdede kalan bildirimler
function loopHead(first, stepName) {
  if (!t.isVariableDeclaration(first) || !first.declarations.length) return null;
  const d = first.declarations[0];
  const v = d.init;
  if (!t.isMemberExpression(v) || !t.isIdentifier(v.object, { name: stepName }) || propKey(v) !== 'value') return null;
  const rest = first.declarations.slice(1);
  return { head: t.variableDeclaration(first.kind, [t.variableDeclarator(d.id)]), rest: rest.length ? [t.variableDeclaration(first.kind, rest)] : [] };
}

export function reverseExtras(ast, helperOf, stats) {
  traverse(ast, {
    // ── strict: var _it = H(X), _step; try { for (_it.s(); !(_step = _it.n()).done;) {…} } catch (err) { _it.e(err); } finally { _it.f(); }
    TryStatement(p) {
      const { block, handler, finalizer } = p.node;
      if (!handler || !finalizer || block.body.length !== 1 || !t.isForStatement(block.body[0])) return;
      const loop = block.body[0];
      const init = loop.init;
      if (!t.isCallExpression(init) || !t.isMemberExpression(init.callee) || !t.isIdentifier(init.callee.object) || propKey(init.callee) !== 's') return;
      const it = init.callee.object.name;
      const test = loop.test;
      if (!(t.isUnaryExpression(test, { operator: '!' }) && t.isMemberExpression(test.argument) && propKey(test.argument) === 'done')) return;
      const asg = test.argument.object;
      if (!t.isAssignmentExpression(asg) || !t.isIdentifier(asg.left) || !t.isCallExpression(asg.right) ||
        !t.isMemberExpression(asg.right.callee) || !t.isIdentifier(asg.right.callee.object, { name: it }) || propKey(asg.right.callee) !== 'n') return;
      const step = asg.left.name;
      const eStmt = handler.body.body;
      const fStmt = finalizer.body;
      const isCall = (st, name) => t.isExpressionStatement(st) && t.isCallExpression(st.expression) && t.isMemberExpression(st.expression.callee) &&
        t.isIdentifier(st.expression.callee.object, { name: it }) && propKey(st.expression.callee) === name;
      if (eStmt.length !== 1 || !isCall(eStmt[0], 'e') || !t.isIdentifier(handler.param) ||
        !t.isIdentifier(eStmt[0].expression.arguments[0], { name: handler.param.name }) || fStmt.length !== 1 || !isCall(fStmt[0], 'f')) return;
      if (loop.update || !t.isBlockStatement(loop.body) || p.parentPath.isLabeledStatement()) return;
      const head = loopHead(loop.body.body[0], step);
      if (!head) return;
      const b = p.scope.getBinding(it);
      const decl = b?.path;
      if (!decl?.isVariableDeclarator() || !t.isCallExpression(decl.node.init) || decl.node.init.arguments.length !== 1) return;
      if (helperOf(decl.get('init.callee')) !== 'createForOfIteratorHelper') return;
      const src = decl.get('init.arguments.0');
      if (!(builtinIterable(src) || generatorCall(src))) return;
      if (!onlyUsedWithin(p.scope, [it, step], [p.node, decl.node])) return;
      // kaynak ifadesi try'dan önce, kendi yerinde değerlendiriliyordu: araya başka deyim girmemeli
      const declStmt = decl.parentPath;
      if (!declStmt.inList || declStmt.getSibling(declStmt.key + 1).node !== p.node) return;
      const forOf = t.forOfStatement(head.head, src.node, t.blockStatement([...head.rest, ...loop.body.body.slice(1)]));
      t.inheritsComments(forOf, p.node);
      p.replaceWith(forOf);
      removeDeclarators(p.scope, [it, step]);
      p.scope.crawl();
      stats.helpers++;
    },
    ForStatement(p) {
      const { init, test, update, body } = p.node;
      if (!t.isVariableDeclaration(init) || !t.isBlockStatement(body) || p.parentPath.isLabeledStatement()) return;
      // gevşek: for (var _it = HL(X), _step; !(_step = _it()).done;) { var x = _step.value; … }
      if (init.declarations.length === 2 && !update && t.isCallExpression(init.declarations[0].init) && init.declarations[0].init.arguments.length === 1 &&
        helperOf(p.get('init.declarations.0.init.callee')) === 'createForOfIteratorHelperLoose') {
        const [itD, stepD] = init.declarations;
        if (!t.isIdentifier(itD.id) || !t.isIdentifier(stepD.id) || stepD.init) return;
        if (!(t.isUnaryExpression(test, { operator: '!' }) && t.isMemberExpression(test.argument) && propKey(test.argument) === 'done')) return;
        const asg = test.argument.object;
        if (!t.isAssignmentExpression(asg) || !t.isIdentifier(asg.left, { name: stepD.id.name }) || !t.isCallExpression(asg.right) ||
          !t.isIdentifier(asg.right.callee, { name: itD.id.name }) || asg.right.arguments.length) return;
        const head = loopHead(body.body[0], stepD.id.name);
        if (!head) return;
        // gevşek yardımcı break'te return() çağırmaz: yalnızca return()'süz yerleşik yineleyiciler
        const src = p.get('init.declarations.0.init.arguments.0');
        if (!builtinIterable(src)) return;
        if (!onlyUsedWithin(p.scope, [itD.id.name, stepD.id.name], [p.node])) return;
        p.replaceWith(t.forOfStatement(head.head, src.node, t.blockStatement([...head.rest, ...body.body.slice(1)])));
        stats.helpers++;
        return;
      }
      // dizi: for (var _i = 0, _a = X; _i < _a.length; _i++) { var x = _a[_i]; … }
      if (init.declarations.length === 2 && t.isUpdateExpression(update, { operator: '++' })) {
        const [iD, aD] = init.declarations;
        if (!t.isIdentifier(iD.id) || !t.isNumericLiteral(iD.init, { value: 0 }) || !t.isIdentifier(aD.id) || !aD.init) return;
        if (!t.isIdentifier(update.argument, { name: iD.id.name })) return;
        if (!(t.isBinaryExpression(test, { operator: '<' }) && t.isIdentifier(test.left, { name: iD.id.name }) &&
          t.isMemberExpression(test.right) && t.isIdentifier(test.right.object, { name: aD.id.name }) && propKey(test.right) === 'length')) return;
        const first = body.body[0];
        if (!t.isVariableDeclaration(first) || !first.declarations.length) return;
        const v = first.declarations[0].init;
        if (!t.isMemberExpression(v) || !v.computed || !t.isIdentifier(v.object, { name: aD.id.name }) || !t.isIdentifier(v.property, { name: iD.id.name })) return;
        if (!/^_/.test(iD.id.name) || !/^_/.test(aD.id.name)) return; // yalnızca Babel'in ürettiği geçiciler
        const src = p.get('init.declarations.1.init');
        if (!isProvenArray(src)) return;
        if (!onlyUsedWithin(p.scope, [iD.id.name, aD.id.name], [p.node])) return;
        // kaynak bir kez okunur: dizi kesin olduğu için yineleyicisi indeks okumasıyla aynı sırayı verir
        const rest = first.declarations.slice(1);
        p.replaceWith(t.forOfStatement(t.variableDeclaration(first.kind, [t.variableDeclarator(first.declarations[0].id)]), src.node,
          t.blockStatement([...(rest.length ? [t.variableDeclaration(first.kind, rest)] : []), ...body.body.slice(1)])));
        stats.helpers++;
      }
    },
    VariableDeclaration(p) {
      const ds = p.node.declarations;
      for (let i = 0; i < ds.length; i++) {
        const d = ds[i];
        // var _x = _toArray(src), a = _x[0], rest = _arrayLikeToArray(_x).slice(1);
        if (t.isIdentifier(d.id) && t.isCallExpression(d.init) && d.init.arguments.length === 1 &&
          helperOf(p.get(`declarations.${i}.init.callee`)) === 'toArray') {
          const tmp = d.id.name;
          const elems = [];
          let j = i + 1;
          for (; j < ds.length; j++) {
            const e = ds[j];
            if (!t.isIdentifier(e.id) || !t.isMemberExpression(e.init) || !t.isIdentifier(e.init.object, { name: tmp }) ||
              !e.init.computed || !t.isNumericLiteral(e.init.property, { value: elems.length })) break;
            elems.push(t.identifier(e.id.name));
          }
          const r = ds[j];
          const restOk = r && t.isIdentifier(r.id) && t.isCallExpression(r.init) && t.isMemberExpression(r.init.callee) && propKey(r.init.callee) === 'slice' &&
            t.isNumericLiteral(r.init.arguments[0], { value: elems.length }) && r.init.arguments.length === 1;
          if (!restOk) continue;
          const base = r.init.callee.object;
          const baseOk = t.isIdentifier(base, { name: tmp }) || (t.isCallExpression(base) && base.arguments.length === 1 &&
            t.isIdentifier(base.arguments[0], { name: tmp }) && helperOf(p.get(`declarations.${j}.init.callee.object.callee`)) === 'arrayLikeToArray');
          const b = p.scope.getBinding(tmp);
          if (!baseOk || !b || !b.constantViolations.every((v) => v.node === d) || b.referencePaths.length !== elems.length + 1) continue;
          const pattern = t.arrayPattern([...elems, t.restElement(t.identifier(r.id.name))]);
          ds.splice(i, j - i + 1, t.variableDeclarator(pattern, d.init.arguments[0]));
          stats.helpers++;
          continue;
        }
        // var a = src.a, rest = _objectWithoutProperties(src, ["a"]);
        if (t.isIdentifier(d.id) && t.isCallExpression(d.init) && d.init.arguments.length === 2) {
          const kind = helperOf(p.get(`declarations.${i}.init.callee`));
          if (kind !== 'objectWithoutProperties' && kind !== 'objectWithoutPropertiesLoose') continue;
          const [srcN, keysN] = d.init.arguments;
          if (!t.isIdentifier(srcN) || !t.isArrayExpression(keysN) || !keysN.elements.every((k) => t.isStringLiteral(k))) continue;
          const keys = keysN.elements.map((k) => k.value);
          if (!keys.length || i < keys.length) continue;
          const reads = ds.slice(i - keys.length, i);
          const ok = reads.every((r, k) => t.isMemberExpression(r.init) && t.isIdentifier(r.init.object, { name: srcN.name }) && propKey(r.init) === keys[k] &&
            (t.isIdentifier(r.id) || t.isPattern(r.id)));
          if (!ok) continue;
          const src = p.get(`declarations.${i}.init.arguments.0`);
          const sb = src.scope.getBinding(srcN.name);
          if (!sb || (sb.kind !== 'param' && !sb.constant)) continue;
          // gevşek sürüm sembol anahtarlarını kopyalamaz: kaynakta sembol anahtar olamayacağı kanıtlanmalı
          if (kind === 'objectWithoutPropertiesLoose' && !symbolFree(src)) continue;
          const props = reads.map((r, k) => t.objectProperty(t.isValidIdentifier(keys[k]) ? t.identifier(keys[k]) : t.stringLiteral(keys[k]), r.id,
            false, t.isIdentifier(r.id, { name: keys[k] })));
          ds.splice(i - keys.length, keys.length + 1, t.variableDeclarator(t.objectPattern([...props, t.restElement(t.identifier(d.id.name))]), t.identifier(srcN.name)));
          stats.helpers++;
          i -= keys.length;
        }
      }
    },
    SequenceExpression: {
      exit(p) {
        // (_o = {}, _o[k] = v, _o.p = w, _o)
        const ex = p.node.expressions;
        if (ex.length < 3) return;
        const first = ex[0];
        const last = ex.at(-1);
        if (!t.isAssignmentExpression(first, { operator: '=' }) || !t.isIdentifier(first.left) || !t.isObjectExpression(first.right) || first.right.properties.length) return;
        const name = first.left.name;
        if (!t.isIdentifier(last, { name })) return;
        const props = [];
        for (let i = 1; i < ex.length - 1; i++) {
          const a = ex[i];
          if (!t.isAssignmentExpression(a, { operator: '=' }) || !t.isMemberExpression(a.left) || !t.isIdentifier(a.left.object, { name })) return;
          const keyPath = p.get(`expressions.${i}.left.property`);
          const computed = a.left.computed;
          const k = computed ? (literalKey(a.left.property) ?? (provablyPrimitive(keyPath, new Set()) ? null : undefined)) : a.left.property.name;
          if (k === undefined || k === '__proto__') return;
          // [[Set]] ile tanımlama farkı yalnızca __proto__ anahtarında: hesaplanan anahtar o olamamalı
          if (k === null && !keyNotProto(keyPath)) return;
          // değer, nesneyi (henüz tamamlanmamış) okumamalı
          let reads = false;
          t.traverseFast(a.right, (n) => { if (t.isIdentifier(n, { name })) reads = true; });
          if (reads) return;
          props.push(k !== null && !computed ? t.objectProperty(t.identifier(k), a.right)
            : k !== null && t.isValidIdentifier(k) ? t.objectProperty(t.identifier(k), a.right)
              : t.objectProperty(a.left.property, a.right, true));
        }
        const b = p.scope.getBinding(name);
        if (!b || b.referencePaths.length !== ex.length - 1 || b.constantViolations.some((v) => v.node !== first)) return;
        if (!b.path.isVariableDeclarator() || b.path.node.init) return;
        p.replaceWith(t.objectExpression(props));
        removeDeclarators(p.scope, [name]);
        stats.helpers++;
      },
    },
    CallExpression: {
      exit(p) {
        const n = p.node;
        const c = n.callee;
        // [].concat(a, b): tüm argümanlar kesin dizi → [...a, ...b]
        if (t.isMemberExpression(c) && propKey(c) === 'concat' && t.isArrayExpression(c.object) && !c.object.elements.length && n.arguments.length) {
          const args = p.get('arguments');
          if (!args.every((a) => t.isArrayExpression(a.node) || isProvenArray(a))) return;
          const els = [];
          for (const a of args) {
            if (t.isArrayExpression(a.node) && a.node.elements.every((e) => e !== null)) els.push(...a.node.elements);
            else els.push(t.spreadElement(a.node));
          }
          p.replaceWith(t.arrayExpression(els));
          stats.helpers++;
          return;
        }
        // o.f.apply(o, [...x]) → o.f(...x);  f.apply(void 0, [...]) → f(...)
        if (t.isMemberExpression(c) && propKey(c) === 'apply' && n.arguments.length === 2 && t.isArrayExpression(n.arguments[1]) &&
          n.arguments[1].elements.every((e) => e !== null)) {
          const [thisArg, arr] = n.arguments;
          const fn = c.object;
          const sameRecv = t.isMemberExpression(fn) && !fn.computed && ((t.isIdentifier(fn.object) && t.isIdentifier(thisArg, { name: fn.object.name })) ||
            (t.isThisExpression(fn.object) && t.isThisExpression(thisArg)));
          const plain = t.isIdentifier(fn) && (t.isUnaryExpression(thisArg, { operator: 'void' }) || t.isNullLiteral(thisArg) || t.isIdentifier(thisArg, { name: 'undefined' }));
          if (!sameRecv && !plain) return;
          // f.apply kullanıcı tarafından gölgelenmiş olabilir: yalnızca yerleşik fonksiyonlarda ya da yerel fonksiyonlarda
          if (sameRecv && !(t.isIdentifier(fn.object) && ['Math', 'console', 'String', 'Array', 'Object', 'Number', 'JSON'].includes(fn.object.name) && !p.scope.getBinding(fn.object.name))) return;
          if (plain && !p.scope.getBinding(fn.name)?.path.isFunction()) return;
          p.replaceWith(t.callExpression(fn, arr.elements));
          stats.helpers++;
          return;
        }
        // _extends({}, a, b) → { ...a, ...b }
        if (helperOf(p.get('callee')) === 'extends' && n.arguments.length && t.isObjectExpression(n.arguments[0])) {
          const args = p.get('arguments');
          if (!args.every((a) => symbolFree(a, true))) {
            // kaynakta kendi "__proto__" anahtarı olabilir: yayma farklı davranır, _extends ≡ Object.assign
            if (!p.scope.getBinding('Object')) {
              p.get('callee').replaceWith(t.memberExpression(t.identifier('Object'), t.identifier('assign')));
              stats.helpers++;
            }
            return;
          }
          const props = [...n.arguments[0].properties];
          for (const a of n.arguments.slice(1)) {
            if (t.isObjectExpression(a) && a.properties.every((x) => t.isObjectProperty(x) && !x.computed)) props.push(...a.properties);
            else props.push(t.spreadElement(a));
          }
          p.replaceWith(t.objectExpression(props));
          stats.helpers++;
        }
      },
    },
  });
}

const literalKey = (n) => (t.isStringLiteral(n) ? n.value : t.isNumericLiteral(n) ? String(n.value) : null);

// Hesaplanan anahtar kesin "__proto__" değil mi (sabit string/sayı değeri)?
function keyNotProto(p) {
  const n = p.node;
  const lit = literalKey(n);
  if (lit !== null) return lit !== '__proto__';
  if (t.isIdentifier(n)) {
    const b = p.scope.getBinding(n.name);
    const init = b?.constant && b.path.isVariableDeclarator() ? b.path.node.init : null;
    if (init && literalKey(init) !== null) return literalKey(init) !== '__proto__';
  }
  return t.isNumericLiteral(n) || t.isUpdateExpression(n);
}

/**
 * Nesnenin kendi anahtarları arasında sembol ya da "__proto__" olamayacağı kanıtlanabiliyor mu?
 * Nesne literali (hesaplanan anahtarları sabit, yaymaları da öyle) ya da yalnızca okunan sabit bağlama.
 */
function symbolFree(p, protoOnly = false, depth = 0) {
  const n = p.node;
  if (depth > 5) return false;
  if (t.isObjectExpression(n)) {
    return p.get('properties').every((q) => {
      if (q.isSpreadElement()) return symbolFree(q.get('argument'), protoOnly, depth + 1);
      if (q.isObjectMethod()) return !q.node.computed;
      if (!q.node.computed) return true; // literal'de __proto__: x prototip ayarlar, kendi anahtarı olmaz
      const k = literalKey(q.node.key);
      return k !== null ? k !== '__proto__' : (keyNotProto(q.get('key')) && (protoOnly || provablyPrimitive(q.get('key'), new Set())));
    });
  }
  if (t.isIdentifier(n)) {
    const b = p.scope.getBinding(n.name);
    if (!b?.constant || !b.path.isVariableDeclarator() || !b.path.node.init) return false;
    // nesne yalnızca okunuyor: üyesine yazılmıyor, başka fonksiyona verilmiyor
    const readOnly = b.referencePaths.every((r) => {
      const par = r.parentPath;
      if (par.isSpreadElement() || par.isObjectExpression()) return true; // ObjectExpression: yerine nesne konmuş eski çağrı yolu
      if (par.isMemberExpression({ object: r.node })) {
        return !par.parentPath.isAssignmentExpression({ left: par.node }) && !par.parentPath.isUpdateExpression() &&
          !par.parentPath.isCallExpression({ callee: par.node }) && !par.parentPath.isUnaryExpression({ operator: 'delete' });
      }
      if (par.isVariableDeclarator({ init: r.node }) && t.isObjectPattern(par.node.id)) return true;
      if (par.isCallExpression() && t.isIdentifier(par.node.callee) && /^_?(extends|objectWithoutPropertiesLoose|objectWithoutProperties|objectSpread2?)\d*$/.test(par.node.callee.name)) return true;
      if (par.isCallExpression() && t.isMemberExpression(par.node.callee) && t.isIdentifier(par.node.callee.object, { name: 'JSON' }) && propKey(par.node.callee) === 'stringify') return true;
      return false;
    });
    return readOnly && symbolFree(b.path.get('init'), protoOnly, depth + 1);
  }
  return false;
}
