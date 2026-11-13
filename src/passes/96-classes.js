import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { scan, renameBlocker, runsAfter, isStrict, strictSafe, callOnlyProperty } from '../naming/scope.js';
import { traverseOwn, replaceThisVar, superMember, collectHelpers } from './96-babel.js';

// 77: function Foo() {…}  Foo.prototype.m = function () {…};  →  class Foo { constructor() {…} m() {…} }
// Babel gevşek (loose) çıktısı da aynı yoldan: var _proto = Foo.prototype; _proto.m = function () {…};
// ve kalıtım: _inheritsLoose(Foo, S) + return S.call(this, …) || this + S.prototype.m.call(this, …)
//   →  class Foo extends S { constructor(…) { super(…); } m() { super.m(…); } }
// Davranış farkları ve kanıtları:
//  - sınıf new'siz çağrılamaz      → Foo yalnızca new, instanceof ve statik üye erişimiyle kullanılıyor
//  - class bildirimi hoist edilmez → her kullanım son prototype atamasından sonra çalışıyor
//  - metotlar ve (gevşek kalıtımda) constructor özelliği sayılamaz → programda for-in/Object.keys yok,
//    metot adları yalnızca çağrılıyor
//  - sınıf gövdesi sıkı moddadır    → kod zaten sıkı ya da gövdeler sıkı moda uygun (scope.strictSafe)
//  - S.call(this) yerine super()   → S yerel sınıf değil, fonksiyon (S.call onu kurucu olarak değil çağırıyordu;
//    üst ES5 kurucusunda ikisi aynı nesneyi kurar, üst nesne döndürürse ikisi de onu this yapar)
// Foo.prototype = {…} biçimi çevrilmez: constructor özelliği kaybolduğu için örnekler farklı davranır.

const memberKey = (m) => (!m.computed && t.isIdentifier(m.property) ? m.property.name
  : t.isStringLiteral(m.property) ? m.property.value : null);

// Foo.prototype.m = function () {…};  ya da  _proto.m = function () {…};
function protoMethod(st, name, alias) {
  if (!t.isExpressionStatement(st)) return null;
  const e = st.expression;
  if (!t.isAssignmentExpression(e, { operator: '=' }) || !t.isFunctionExpression(e.right)) return null;
  const l = e.left;
  if (!t.isMemberExpression(l)) return null;
  const viaProto = t.isMemberExpression(l.object) && t.isIdentifier(l.object.object, { name }) && memberKey(l.object) === 'prototype';
  const viaAlias = alias && t.isIdentifier(l.object, { name: alias });
  if (!viaProto && !viaAlias) return null;
  const key = memberKey(l);
  if (!key || key === 'constructor' || !t.isValidIdentifier(key)) return null;
  return { key, fn: e.right, member: l };
}

// _inheritsLoose yardımcısı (gövde biçiminden)
function isInheritsLoose(p, callee) {
  if (!t.isIdentifier(callee) || !/^_?inheritsLoose\d*$/.test(callee.name)) return false;
  const b = p.scope.getBinding(callee.name);
  if (!b?.path.isFunctionDeclaration()) return false;
  const code = gen(b.path.node);
  return code.includes('Object.create') && code.includes('.constructor=');
}

// S, çağrıldığı anda kesin bir ES5 fonksiyonu mu? (yerel class değil: S.call sınıfta hata verirdi)
function es5Function(path, depth = 0) {
  const n = path.node;
  if (depth > 4 || !t.isIdentifier(n)) return false;
  const b = path.scope.getBinding(n.name);
  if (!b) return false;
  if (b.path.isFunctionDeclaration()) return !b.path.node.async && !b.path.node.generator;
  if (b.kind === 'param') {
    // IIFE parametresi: argümanı izlenir
    const fn = b.scope.path;
    const call = fn.parentPath;
    const idx = fn.node.params.findIndex((x) => t.isIdentifier(x, { name: n.name }));
    if (!fn.isFunctionExpression() || !call.isCallExpression({ callee: fn.node }) || idx < 0 || !b.constant) return false;
    const arg = call.get(`arguments.${idx}`);
    return arg?.node ? es5Function(arg, depth + 1) : false;
  }
  if (b.path.isVariableDeclarator() && b.constant) {
    const init = b.path.get('init');
    // Babel sınıf IIFE'si: function () { function X() {…} …; return X; }()
    if (init.isCallExpression() && init.get('callee').isFunctionExpression()) {
      const body = init.node.callee.body.body;
      const ret = body.at(-1);
      if (!t.isReturnStatement(ret) || !t.isIdentifier(ret.argument)) return false;
      return body.some((s) => t.isFunctionDeclaration(s) && s.id.name === ret.argument.name && !s.async && !s.generator);
    }
    return init.isFunctionExpression() && !init.node.async && !init.node.generator;
  }
  return false;
}

// return S.call(this, a, b) || this  /  _this = S.call(this, …) || this  /  S.apply(this, arguments) || this
function superFromCall(expr, superName) {
  if (!t.isLogicalExpression(expr, { operator: '||' }) || !t.isThisExpression(expr.right) || !t.isCallExpression(expr.left)) return null;
  const c = expr.left;
  if (!t.isMemberExpression(c.callee) || !t.isIdentifier(c.callee.object, { name: superName }) || c.callee.computed || !t.isThisExpression(c.arguments[0])) return null;
  const m = c.callee.property.name;
  if (m === 'call') return c.arguments.slice(1);
  if (m === 'apply' && c.arguments.length === 2 && t.isIdentifier(c.arguments[1], { name: 'arguments' })) return [t.spreadElement(t.identifier('arguments'))];
  return null;
}

// Gevşek süper erişimleri: S.prototype.m.call(this, …) / S.m.call(this, …) / S.prototype.m
// superMembers: süper erişime dönüşecek S.prototype.m düğümleri (metot adının çağrı dışı okunması sayılmaz)
function looseSuperEdits(fnPath, superName, isStatic, superMembers = []) {
  const edits = [];
  let ok = true;
  fnPath.traverse({
    Identifier(q) {
      if (q.node.name !== superName || !q.isReferencedIdentifier()) return;
      let m = q.parentPath;
      let target = null;
      if (!isStatic) {
        if (!m.isMemberExpression({ object: q.node }) || memberKey(m.node) !== 'prototype' || m.node.computed) return;
        target = m.parentPath;
      } else target = m;
      if (!target.isMemberExpression() || target.node.computed || !t.isIdentifier(target.node.property)) { ok = false; return q.stop(); }
      const owner = q.getFunctionParent();
      if (owner.node !== fnPath.node && !owner.isArrowFunctionExpression()) { ok = false; return q.stop(); }
      const key = target.node.property.name;
      const call = target.parentPath;
      superMembers.push(target.node);
      if (call.isMemberExpression({ object: target.node }) && memberKey(call.node) === 'call' && call.parentPath.isCallExpression({ callee: call.node }) &&
        t.isThisExpression(call.parent.arguments[0])) {
        edits.push([call.parentPath, t.callExpression(superMember(key), call.parent.arguments.slice(1))]);
      } else if (!target.parentPath.isAssignmentExpression({ left: target.node })) {
        edits.push([target, superMember(key)]);
      } else { ok = false; q.stop(); }
    },
  });
  return ok ? edits : null;
}

export async function run(ast, { onLog, bump, naming = {} }) {
  if (naming.classes === false) return;
  // Babel yardımcılarının gövdeleri (Object.setPrototypeOf, dinamik erişim) kullanıcı metotlarını okumaz
  const info = scan(ast, { ignore: collectHelpers(ast).helperNodes });
  let n = 0;
  traverse(ast, {
    FunctionDeclaration(p) {
      const fn = p.node;
      if (!fn.id || fn.async || fn.generator || !p.inList) return;
      const container = p.parentPath;
      // sloppy modda blok içi fonksiyon bildirimi (Annex B) farklı kapsamlanır
      if (!(container.isProgram() || container.parentPath?.isFunction()) && !isStrict(p)) return;
      const name = fn.id.name;
      const list = container.node[p.listKey];
      let k = p.key + 1;
      // _inheritsLoose(Foo, S)
      let superName = null;
      let inheritsIdx = -1;
      const inh = list[k];
      if (t.isExpressionStatement(inh) && t.isCallExpression(inh.expression) && isInheritsLoose(p, inh.expression.callee) &&
        t.isIdentifier(inh.expression.arguments[0], { name }) && t.isIdentifier(inh.expression.arguments[1])) {
        superName = inh.expression.arguments[1].name;
        inheritsIdx = k;
        k++;
      }
      // var _proto = Foo.prototype;
      let alias = null;
      let aliasIdx = -1;
      const al = list[k];
      if (t.isVariableDeclaration(al) && al.declarations.length === 1 && t.isIdentifier(al.declarations[0].id) &&
        t.isMemberExpression(al.declarations[0].init) && t.isIdentifier(al.declarations[0].init.object, { name }) && memberKey(al.declarations[0].init) === 'prototype') {
        alias = al.declarations[0].id.name;
        aliasIdx = k;
        k++;
      }
      const methods = [];
      for (; k < list.length; k++) {
        const m = protoMethod(list[k], name, alias);
        if (!m) break;
        methods.push({ ...m, index: k });
      }
      if (!methods.length && !superName) return;
      const b = p.scope.getBinding(name);
      if (!b || b.kind !== 'hoisted' || !b.constant || renameBlocker(info, b)) return;
      if (alias) {
        const ab = container.scope.getBinding(alias);
        const defs = new Set(methods.map((m) => m.member.object));
        if (!ab?.constant || !ab.referencePaths.every((r) => defs.has(r.node))) return;
      }
      if (superName) {
        if (!es5Function(container.get(`${p.listKey}.${inheritsIdx}.expression.arguments.1`))) return;
        // gevşek kalıtım constructor özelliğini sayılabilir yazar: for-in/yansıma olmamalı
        if (info.forIn || info.reflective || info.dynamicMember) return;
      }
      const lastIdx = Math.max(p.key, inheritsIdx, aliasIdx, ...methods.map((m) => m.index));
      const end = list[lastIdx].end;
      const memberNodes = new Set(methods.map((m) => m.member.object));
      const inheritsArg = inheritsIdx >= 0 ? list[inheritsIdx].expression.arguments[0] : null;
      const aliasInit = aliasIdx >= 0 ? list[aliasIdx].declarations[0].init.object : null;
      for (const r of b.referencePaths) {
        if (memberNodes.has(r.parent) || r.node === inheritsArg || r.node === aliasInit) continue;
        if (!runsAfter(r, end, container, info)) return;
        const par = r.parentPath;
        if (par.isNewExpression({ callee: r.node })) continue;
        if (par.isBinaryExpression({ operator: 'instanceof', right: r.node })) continue;
        if (par.isClass({ superClass: r.node })) continue;
        if (par.isReturnStatement() && container.parentPath?.isFunctionExpression()) {
          // Babel IIFE'si: dış değişkenin kullanımları da sınıf kullanımı olmalı
          if (!outerOk(container.parentPath, (x) => classUse(x))) return;
          continue;
        }
        if (par.isMemberExpression({ object: r.node })) {
          const key = memberKey(par.node);
          if (!key || ['call', 'apply', 'bind', 'caller', 'arguments'].includes(key)) return;
          // Foo.prototype.x = değer (veri özelliği) sınıfta da aynı çalışır; başka prototype erişimi yok
          if (key === 'prototype') {
            const outer = par.parentPath;
            if (!(outer.isMemberExpression({ object: par.node }) && outer.parentPath.isAssignmentExpression({ left: outer.node }) &&
              !t.isFunction(outer.parent.right))) return;
          }
          continue;
        }
        return;
      }
      // metot adları programda yalnızca çağrılıyor olmalı (tanımlayan atamalar ve süper'e dönüşecek erişimler hariç)
      const allowed = new Set(methods.map((m) => m.member));
      if (superName) {
        const sm = [];
        looseSuperEdits(p, superName, false, sm);
        for (const m of methods) looseSuperEdits(container.get(`${p.listKey}.${m.index}.expression.right`), superName, false, sm);
        for (const x of sm) allowed.add(x);
      }
      for (const m of methods) {
        if (!callOnlyProperty(info, m.key, allowed)) return;
        if (m.fn.id && container.get(`${p.listKey}.${m.index}.expression.right`).scope.getBinding(m.fn.id.name)?.referencePaths.length) return;
      }
      if (!isStrict(p)) {
        if (!strictSafe(p)) return;
        for (const m of methods) if (!strictSafe(container.get(`${p.listKey}.${m.index}.expression.right`))) return;
      }

      // türetilmiş kurucu ve süper erişimleri (önce doğrula, sonra uygula)
      let ctorBody = fn.body;
      const edits = [];
      if (superName) {
        const body = fn.body.body;
        let thisVar = null;
        let start = 0;
        if (t.isVariableDeclaration(body[0]) && body[0].declarations.length === 1 && !body[0].declarations[0].init && t.isIdentifier(body[0].declarations[0].id)) {
          thisVar = body[0].declarations[0].id.name;
          start = 1;
        }
        let idx = -1;
        let args = null;
        for (let i = start; i < body.length; i++) {
          const st = body[i];
          if (t.isReturnStatement(st) && st.argument) args = superFromCall(st.argument, superName);
          else if (thisVar && t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression, { operator: '=' }) && t.isIdentifier(st.expression.left, { name: thisVar })) {
            args = superFromCall(st.expression.right, superName);
          }
          if (args) { idx = i; break; }
          let touches = false;
          t.traverseFast(st, (x) => { if (t.isThisExpression(x) || (thisVar && t.isIdentifier(x, { name: thisVar }))) touches = true; });
          if (touches) return;
        }
        if (idx < 0) return;
        const returns = t.isReturnStatement(body[idx]);
        const ctorEdits = looseSuperEdits(p, superName, false);
        if (!ctorEdits) return;
        edits.push(...ctorEdits.filter(([path]) => !path.findParent((x) => x.node === body[idx])));
        for (const m of methods) {
          const e = looseSuperEdits(container.get(`${p.listKey}.${m.index}.expression.right`), superName, false);
          if (!e) return;
          edits.push(...e);
        }
        for (const [path, rep] of edits) path.replaceWith(rep);
        const before = body.slice(start, idx);
        const after = returns ? [] : body.slice(idx + 1);
        const out = [...before, t.expressionStatement(t.callExpression(t.super(), args)), ...after];
        if (thisVar) {
          let captured = false;
          for (const st of after) traverseOwn(st, (x, nested) => { if (nested && t.isIdentifier(x, { name: thisVar })) captured = true; });
          if (captured) {
            out.splice(before.length + 1, 0, t.expressionStatement(t.assignmentExpression('=', t.identifier(thisVar), t.thisExpression())));
            out.unshift(t.variableDeclaration('var', [t.variableDeclarator(t.identifier(thisVar))]));
            const last = out.at(-1);
            if (t.isReturnStatement(last) && t.isIdentifier(last.argument, { name: thisVar })) out.pop();
          } else {
            for (const st of after) replaceThisVar(st, thisVar);
            const last = out.at(-1);
            if (t.isReturnStatement(last) && t.isThisExpression(last.argument)) out.pop();
          }
        }
        const isDefault = returns && !before.length && fn.params.length === 0 && args.length === 1 && t.isSpreadElement(args[0]);
        ctorBody = isDefault ? null : t.blockStatement(out, fn.body.directives);
      }

      const body = [];
      if (ctorBody && (fn.params.length || ctorBody.body.length || ctorBody.directives.length)) {
        body.push(t.classMethod('constructor', t.identifier('constructor'), fn.params, ctorBody));
      }
      for (const m of methods) {
        const cm = t.classMethod('method', t.identifier(m.key), m.fn.params, m.fn.body, false, false, m.fn.generator, m.fn.async);
        t.inheritsComments(cm, list[m.index]);
        body.push(cm);
      }
      const cls = t.classDeclaration(t.identifier(name), superName ? t.identifier(superName) : null, t.classBody(body));
      t.inheritsComments(cls, fn);
      const drop = [...methods.map((m) => m.index), aliasIdx, inheritsIdx].filter((x) => x >= 0).sort((a, c) => c - a);
      for (const i of drop) container.get(`${p.listKey}.${i}`).remove();
      // eski fonksiyon binding'i kalkmazsa Babel aynı adlı class'ı "duplicate declaration" sayar
      b.scope.removeOwnBinding(name);
      p.replaceWith(cls);
      n++;
    },
  });
  if (n) onLog(`classes: ${n} prototype yapısı class oldu`, 'info');
  bump('classes', n);
}

const classUse = (r) => {
  const par = r.parentPath;
  if (par.isNewExpression({ callee: r.node })) return true;
  if (par.isBinaryExpression({ operator: 'instanceof', right: r.node })) return true;
  if (par.isClass({ superClass: r.node })) return true;
  // başka bir sınıf IIFE'sinin argümanı: parametre yalnızca extends olarak kullanılıyor
  if (par.isCallExpression() && t.isFunctionExpression(par.node.callee) && par.node.arguments.includes(r.node)) {
    const param = par.node.callee.params[par.node.arguments.indexOf(r.node)];
    const pb = t.isIdentifier(param) ? par.get('callee').scope.getBinding(param.name) : null;
    return Boolean(pb?.constant) && pb.referencePaths.every((x) => x.parentPath.isClass({ superClass: x.node }));
  }
  return par.isMemberExpression({ object: r.node }) && !par.node.computed && !['prototype', 'call', 'apply', 'bind'].includes(par.node.property.name);
};

// var Foo = function (…) { …; return Foo; }(…);  dış değişkenin her kullanımı uygun mu?
function outerOk(fnPath, ok) {
  const call = fnPath.parentPath;
  if (!call?.isCallExpression({ callee: fnPath.node })) return false;
  const decl = call.parentPath;
  if (!decl.isVariableDeclarator({ init: call.node }) || !t.isIdentifier(decl.node.id)) return false;
  const b = decl.scope.getBinding(decl.node.id.name);
  return Boolean(b?.constant) && b.referencePaths.every(ok);
}
