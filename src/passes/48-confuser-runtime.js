import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { literalValue } from '../util/pure.js';

// js-confuser stringConcealing'in çalışma anı yardımcısı, string çağrıları çözüldükten sonra ölü kalır:
//   G = getGlobal() || {};  G.TextDecoder; G.Uint8Array; G.Buffer;  S = G.String || String;  A = G.Array || A;
//   (function () { function main() { var t = new A(128), f = S.fromCodePoint || S.fromCharCode, b = [];
//     ret = true; return function (array) { …UTF-8 çözücü… }; } var ret; var res = main(); if (ret) return res; })();
// Sonucu kullanılmayan IIFE, okunmayan değişkene atama ve tek başına standart global okuması etkisizdir:
// çalıştırılan her ifade literal, yerel atama, yerel fonksiyon çağrısı, Array/String yerleşiklerinden `new A(n)`
// ya da `S.fromCharCode` okumasıdır. getGlobal globalThis/window/global döndüren fonksiyonları sırayla dener.

const STD_GLOBALS = new Set(['TextDecoder', 'TextEncoder', 'Uint8Array', 'Buffer', 'String', 'Array', 'Object', 'Number', 'Math', 'JSON', 'Symbol']);

// getGlobal: yalnızca global nesneyi döndüren fonksiyonlar dizisini deneyen yardımcı (metinsel parmak izi)
function isGetGlobal(fn) {
  if (!t.isFunction(fn) || fn.params.length) return false;
  let returnsGlobal = 0;
  let calls = 0;
  t.traverseFast(fn.body, (n) => {
    if (t.isReturnStatement(n) && (t.isIdentifier(n.argument, { name: 'globalThis' }) || t.isIdentifier(n.argument, { name: 'window' }) ||
      t.isIdentifier(n.argument, { name: 'global' }))) returnsGlobal++;
    if (t.isCallExpression(n) || t.isNewExpression(n)) calls++;
  });
  // dizideki elemanı çağırma (array[i]()), push ve global döndüren fonksiyonlar dışında çağrı yok
  return (returnsGlobal >= 2 && calls <= 4) || globalThisFirst(fn);
}

// Aday dizisinin ilk elemanı function () { return globalThis; } ise (ES2020+ her ortamda tanımlı, String özelliği
// var) döngü ilk adayda döner: diğer adaylar (CFF/string gizlemeyle şişmiş new Function("return this") vb.) hiç
// çalışmaz, çağrı etkisizdir.
function globalThisFirst(fn) {
  if (!t.isBlockStatement(fn.body)) return false;
  // var A = [...]  ya da (let A, …; A = [...])
  let arr = null;
  let init = null;
  // başta fonksiyon bildirimleri (gizlenmiş string yardımcıları) ve başlangıçsız bildirimler olabilir
  for (const st of fn.body.body.filter((x) => !t.isFunctionDeclaration(x)).slice(0, 2)) {
    if (t.isVariableDeclaration(st) && st.declarations[0]?.init) { arr = st.declarations[0].id; init = st.declarations[0].init; break; }
    if (t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression, { operator: '=' })) { arr = st.expression.left; init = st.expression.right; break; }
  }
  const c0 = t.isArrayExpression(init) ? init.elements[0] : null;
  if (!t.isIdentifier(arr) || !t.isFunctionExpression(c0) || c0.params.length || c0.body.body.length !== 1 || !t.isReturnStatement(c0.body.body[0]) ||
      !t.isIdentifier(c0.body.body[0].argument, { name: 'globalThis' })) return false;
  let loopCall = false;
  t.traverseFast(fn.body, (n) => {
    if (t.isLabeledStatement(n) && t.isForStatement(n.body)) {
      t.traverseFast(n.body, (m) => {
        if (t.isCallExpression(m) && !m.arguments.length && t.isMemberExpression(m.callee, { computed: true }) &&
            t.isIdentifier(m.callee.object, { name: arr.name })) loopCall = true;
      });
    }
  });
  return loopCall;
}

const unshadowed = (scope, name) => !scope.getBinding(name);

export async function run(ast, { onLog, bump, level = 2 }) {
  let n = 0;
  // 1) G = getGlobal() || {}  bağları ve onlardan türeyen yerleşik takma adlar (S = G.String || String)
  const globalish = new Set();
  const builtin = new Map(); // binding → 'Array' | 'String'
  const fnOf = (scope, id) => {
    const b = t.isIdentifier(id) ? scope.getBinding(id.name) : null;
    if (!b) return null;
    if (b.path.isFunctionDeclaration()) return b.path.node;
    const vals = [b.path.isVariableDeclarator() ? b.path.node.init : null, ...b.constantViolations.map((v) => v.node.right)].filter(Boolean);
    return vals.length === 1 && t.isFunction(vals[0]) ? vals[0] : null;
  };
  const valuesOf = (b) => [b.path.isVariableDeclarator() ? b.path.node.init : null,
    ...b.constantViolations.map((v) => (v.isAssignmentExpression({ operator: '=' }) ? v.node.right : undefined))].filter((x) => x !== null);
  traverse(ast, {
    Scopable(sp) {
      for (const b of Object.values(sp.scope.bindings)) {
        const vals = valuesOf(b);
        if (vals.length !== 1 || vals[0] === undefined) continue;
        const v = vals[0];
        if (t.isLogicalExpression(v, { operator: '||' }) && t.isCallExpression(v.left) && !v.left.arguments.length &&
            isGetGlobal(fnOf(sp.scope, v.left.callee)) && t.isObjectExpression(v.right) && !v.right.properties.length) globalish.add(b);
      }
    },
  });
  // yalnızca js-confuser yardımcısının izi (getGlobal) varken: başka koddaki (Babel yardımcıları vb.) "okunmayan
  // değişkene fonksiyon ataması" gibi kalıplar bu pass'in konusu değil
  let marker = globalish.size > 0;
  if (!marker) traverse(ast, { Function(q) { if (isGetGlobal(q.node)) { marker = true; q.stop(); } } });
  if (!marker) return;
  const isGlobalish = (scope, id) => t.isIdentifier(id) && globalish.has(scope.getBinding(id.name));
  traverse(ast, {
    Scopable(sp) {
      for (const b of Object.values(sp.scope.bindings)) {
        const vals = valuesOf(b);
        if (vals.length !== 1 || vals[0] === undefined) continue;
        const v = vals[0];
        // G.Array || Array
        if (t.isLogicalExpression(v, { operator: '||' }) && t.isMemberExpression(v.left) && !v.left.computed && isGlobalish(sp.scope, v.left.object) &&
            t.isIdentifier(v.right, { name: v.left.property.name }) && ['Array', 'String'].includes(v.right.name) && unshadowed(sp.scope, v.right.name)) {
          builtin.set(b, v.right.name);
        }
      }
    },
  });

  // Çalıştırıldığında gözlenebilir etki üretmeyen ifade (yerleşikler ve yerel bağlar bağlamında)
  const pureVal = (p, locals) => {
    const e = p.node;
    if (literalValue(e).ok || t.isRegExpLiteral(e) || t.isFunction(e)) return true;
    if (t.isIdentifier(e)) return Boolean(p.scope.getBinding(e.name)) || ['undefined', 'String', 'Array'].includes(e.name);
    if (t.isArrayExpression(e)) return p.get('elements').every((x) => x.node && !t.isSpreadElement(x.node) && pureVal(x, locals));
    if (t.isObjectExpression(e)) return p.get('properties').every((x) => x.isObjectProperty() && !x.node.computed && pureVal(x.get('value'), locals));
    if (t.isNewExpression(e) && t.isIdentifier(e.callee)) {
      const b = p.scope.getBinding(e.callee.name);
      const isArray = (b && builtin.get(b) === 'Array') || (!b && e.callee.name === 'Array');
      return isArray && e.arguments.length === 1 && t.isNumericLiteral(e.arguments[0]) && e.arguments[0].value >= 0 && e.arguments[0].value < 1e6;
    }
    if (t.isMemberExpression(e) && !e.computed && t.isIdentifier(e.object) && ['fromCodePoint', 'fromCharCode'].includes(e.property.name)) {
      const b = p.scope.getBinding(e.object.name);
      return (b && builtin.get(b) === 'String') || (!b && e.object.name === 'String');
    }
    if (t.isLogicalExpression(e)) return pureVal(p.get('left'), locals) && pureVal(p.get('right'), locals);
    // yerel (IIFE içinde bildirilmiş) fonksiyonun çağrısı: o fonksiyonun gövdesi de etkisiz olmalı
    // (function () { …etkisiz… })()  — IIFE değeri
    if (t.isCallExpression(e) && !e.arguments.length && t.isFunctionExpression(e.callee) && !e.callee.async && !e.callee.generator) return pureBody(p.get("callee"), locals);
    if (t.isCallExpression(e) && !e.arguments.length && t.isIdentifier(e.callee)) {
      const b = p.scope.getBinding(e.callee.name);
      return Boolean(b && locals.has(b) && b.path.isFunctionDeclaration() && pureBody(b.path, locals));
    }
    return false;
  };
  const visiting = new Set();
  // gövdenin çalıştırılan deyimleri (iç fonksiyon gövdeleri hariç)
  function pureBody(fnPath, locals) {
    if (visiting.has(fnPath.node)) return false;
    visiting.add(fnPath.node);
    for (const b of Object.values(fnPath.scope.bindings)) locals.add(b);
    const ok = fnPath.get('body.body').every((s) => {
      if (s.isFunctionDeclaration() || s.isEmptyStatement()) return true;
      if (s.isVariableDeclaration()) return s.get('declarations').every((d) => t.isIdentifier(d.node.id) && (!d.node.init || pureVal(d.get('init'), locals)));
      if (s.isReturnStatement()) return !s.node.argument || pureVal(s.get('argument'), locals);
      if (s.isExpressionStatement() && s.get('expression').isAssignmentExpression({ operator: '=' })) {
        const a = s.get('expression');
        const left = a.node.left;
        const tb = t.isIdentifier(left) ? a.scope.getBinding(left.name) : null;
        if (tb) return locals.has(tb) && pureVal(a.get('right'), locals);
        // variableMasking: fonksiyonun kendi (taze) rest dizisine sabit anahtarlı yazma — M.a = …, M[-24] = …
        const ob = t.isMemberExpression(left) && t.isIdentifier(left.object) && (!left.computed || literalValue(left.property).ok)
          ? a.scope.getBinding(left.object.name) : null;
        return Boolean(ob && locals.has(ob) && ob.kind === 'param' && !ob.constantViolations.length &&
          (t.isRestElement(ob.path.node) || t.isRestElement(ob.path.parent))) && pureVal(a.get('right'), locals);
      }
      if (s.isIfStatement() && !s.node.alternate && t.isIdentifier(s.node.test) && locals.has(s.scope.getBinding(s.node.test.name))) {
        const c = s.get('consequent');
        const stmts = c.isBlockStatement() ? c.get('body') : [c];
        return stmts.every((x) => x.isReturnStatement() && (!x.node.argument || pureVal(x.get('argument'), locals)));
      }
      return false;
    });
    visiting.delete(fnPath.node);
    return ok;
  }

  const stdRead = (scope, e) => t.isMemberExpression(e) && !e.computed && isGlobalish(scope, e.object) && STD_GLOBALS.has(e.property.name);
  const stdName = (scope, e) => t.isIdentifier(e) && STD_GLOBALS.has(e.name) && !scope.getBinding(e.name) && e.name !== 'Buffer';
  traverse(ast, {
    // if (!G.String) String;  — okunmayan "G.String || String" ataması sadeleştirildikten sonra kalan biçim
    IfStatement(p) {
      const { test, consequent, alternate } = p.node;
      const body = t.isBlockStatement(consequent) && consequent.body.length === 1 ? consequent.body[0] : consequent;
      // if (!getGlobal()) ({});  — okunmayan "G = getGlobal() || {}" ataması sadeleştirildikten sonra
      const emptyObj = t.isExpressionStatement(body) && t.isObjectExpression(body.expression) && !body.expression.properties.length;
      if (!alternate && Array.isArray(p.container) && t.isUnaryExpression(test, { operator: '!' }) && t.isCallExpression(test.argument) &&
          !test.argument.arguments.length && isGetGlobal(fnOf(p.scope, test.argument.callee)) && (emptyObj || t.isEmptyStatement(body))) {
        p.remove();
        n++;
        return;
      }
      if (alternate || !Array.isArray(p.container) || !t.isUnaryExpression(test, { operator: '!' }) || !stdRead(p.scope, test.argument) ||
          !t.isExpressionStatement(body) || !stdName(p.scope, body.expression)) return;
      p.remove();
      n++;
    },
    ExpressionStatement(p) {
      if (!Array.isArray(p.container)) return;
      const e = p.get('expression');
      // G.TextDecoder;  — standart global özelliği okuması
      if (e.isMemberExpression() && !e.node.computed && isGlobalish(p.scope, e.node.object) && STD_GLOBALS.has(e.node.property.name)) {
        p.remove(); n++; return;
      }
      // getGlobal();  — sonucu kullanılmayan çağrı (ilk adayda döner, etkisiz)
      if (e.isCallExpression() && !e.node.arguments.length && t.isIdentifier(e.node.callee) && isGetGlobal(fnOf(p.scope, e.node.callee))) {
        p.remove(); n++; return;
      }
      // (function () { …etkisiz… })();
      if (e.isCallExpression() && !e.node.arguments.length && e.get('callee').isFunctionExpression() &&
          !e.node.callee.async && !e.node.callee.generator && pureBody(e.get('callee'), new Set())) {
        p.remove(); n++; return;
      }
      // hiç okunmayan değişkene etkisiz değer: V = G.String || String;  V = getGlobal() || {};  V = function () {…}
      if (e.isAssignmentExpression({ operator: '=' }) && t.isIdentifier(e.node.left)) {
        const b = p.scope.getBinding(e.node.left.name);
        if (!b || b.referenced || b.kind === 'param' || (b.scope.path.isProgram() && level < 4)) return;
        const r = e.get('right');
        const call = r.isLogicalExpression({ operator: '||' }) ? r.node.left : r.node;
        const getGlobalCall = t.isCallExpression(call) && !call.arguments.length && isGetGlobal(fnOf(p.scope, call.callee));
        if (getGlobalCall || builtin.has(b) || stdRead(p.scope, r.node) || pureVal(r, new Set())) { p.remove(); n++; }
      }
    },
  });
  if (n) onLog(`confuser-runtime: js-confuser string yardımcısının ${n} ölü parçası kaldırıldı`, 'info');
  bump('confuserRuntime', n);
}
