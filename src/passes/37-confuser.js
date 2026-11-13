import * as t from '@babel/types';
import { machineSite } from './76-unflatten.js';
import { traverse, gen } from '../util/ast.js';

// A-9:  js-confuser dispatcher fonksiyonları → ayrı fonksiyonlar
// A-21: js-confuser `function f(...M) { M.length = 2; … M[0] … }` → gerçek parametreler
// A-22: tslib/TypeScript `__generator` durum makinesi → function*

// ── ortak ───────────────────────────────────────────────

const strKey = (k, computed) => (!computed && t.isIdentifier(k) ? k.name : t.isStringLiteral(k) ? k.value : null);

// Fonksiyon (iç ok fonksiyonları dahil, iç normal fonksiyonlar hariç) this / arguments kullanıyor mu?
function usesThisOrArguments(fnNode) {
  let found = false;
  const walk = (n, top) => {
    if (!n || typeof n !== 'object' || found) return;
    if (!top && t.isFunction(n) && !t.isArrowFunctionExpression(n)) return;
    if (t.isThisExpression(n) || t.isIdentifier(n, { name: 'arguments' }) || t.isMetaProperty(n)) { found = true; return; }
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, false)); else walk(v, false);
    }
  };
  walk(fnNode.body, true);
  for (const p of fnNode.params) walk(p, true);
  return found;
}

// arguments (iç normal fonksiyonlar hariç)
function usesArguments(node) {
  let found = false;
  const walk = (n) => {
    if (!n || typeof n !== 'object' || found) return;
    if (t.isFunction(n) && !t.isArrowFunctionExpression(n)) return;
    if (t.isIdentifier(n, { name: 'arguments' })) { found = true; return; }
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk); else walk(v);
    }
  };
  walk(node);
  return found;
}

// Programdaki tüm bağlama adları ve bağsız (global) referanslar: yeni ad hiçbirini gölgelememeli
function allNames(ast) {
  const names = new Set();
  traverse(ast, {
    Program(p) { for (const g of Object.keys(p.scope.globals)) names.add(g); },
    Scopable(p) { for (const k of Object.keys(p.scope.bindings)) names.add(k); },
  });
  return names;
}

// ── A-9: dispatcher ─────────────────────────────────────

// opaquePredicates kalıntısı: if (true && flag === "…")
const flagTest = (test) => (t.isLogicalExpression(test, { operator: '&&' }) && t.isBooleanLiteral(test.left, { value: true }) ? test.right : test);
const isFlagTest = (test, param) => t.isBinaryExpression(flagTest(test), { operator: '===' }) &&
  t.isIdentifier(flagTest(test).left, { name: param }) && t.isStringLiteral(flagTest(test).right);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// a.b.c → "a.b.c" (yalnızca hesaplanmamış üyeler)
function memberPath(n) {
  if (t.isIdentifier(n)) return n.name;
  if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
    const base = memberPath(n.object);
    return base && `${base}.${n.property.name}`;
  }
  return null;
}

export function readDispatcher(fnPath) {
  const fn = fnPath.node;
  if (fn.async || fn.generator || fn.params.length < 3) return null;
  const [nameP, flagP, retP] = fn.params;
  if (![nameP, flagP, retP].every((x) => t.isIdentifier(x))) return null;
  const body = fn.body.body;
  let fns = null;
  let fnsName = null;
  let clearFlag = null;
  let fnFlag = null;
  let retFlag = null;
  let retKey = null;
  let payload = null;
  let lengthHelper = null;
  let clearDirty = false;
  let retOpaque = null;
  let refOpaque = false;
  for (const s of body) {
    // movedDeclarations: var fns = {…} yerine kullanılmayan bir parametreye atama: P = {…}
    // (ya da CFF açıldıktan sonra başlangıçsız bildirilmiş yerele: let fns; fns = {…})
    const movedFns = t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression, { operator: '=' }) &&
      t.isIdentifier(s.expression.left) && t.isObjectExpression(s.expression.right) &&
      (fn.params.slice(3).some((x) => t.isIdentifier(x, { name: s.expression.left.name }) || (t.isAssignmentPattern(x) && t.isIdentifier(x.left, { name: s.expression.left.name }))) ||
        (() => { const lb = fnPath.scope.getBinding(s.expression.left.name); return lb?.scope === fnPath.scope && lb.path.isVariableDeclarator() && !lb.path.node.init && lb.constantViolations.length === 1; })());
    // kapsam nesnesi bölünemediyse tablo dispatcher'ın yerel kapsam kökünde: S.K.fns = {…}
    // (let S = { K: {} }; — her çağrıda taze, yalnızca bu fonksiyonun yereli)
    const pathFns = !movedFns && !fns && t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression, { operator: '=' }) &&
      t.isMemberExpression(s.expression.left) && t.isObjectExpression(s.expression.right) && s.expression.right.properties.length > 0 && (() => {
      const path = memberPath(s.expression.left);
      const root = path && fnPath.scope.getBinding(path.split('.')[0]);
      return Boolean(root?.scope === fnPath.scope && root.path.isVariableDeclarator() && t.isObjectExpression(root.path.node.init));
    })();
    if (pathFns) {
      const obj = s.expression.right;
      if (!obj.properties.every((p) => t.isObjectProperty(p) && strKey(p.key, p.computed) !== null && t.isFunctionExpression(p.value))) return null;
      fns = new Map(obj.properties.map((p) => [strKey(p.key, p.computed), p.value]));
      fnsName = memberPath(s.expression.left);
    }
    if (movedFns) {
      const obj = s.expression.right;
      if (!obj.properties.every((p) => t.isObjectProperty(p) && strKey(p.key, p.computed) !== null && t.isFunctionExpression(p.value))) return null;
      fns = new Map(obj.properties.map((p) => [strKey(p.key, p.computed), p.value]));
      fnsName = s.expression.left.name;
    }
    if (t.isVariableDeclaration(s) && s.declarations.length === 1 && t.isObjectExpression(s.declarations[0].init) &&
        s.declarations[0].init.properties.length && t.isIdentifier(s.declarations[0].id)) {
      const obj = s.declarations[0].init;
      if (!obj.properties.every((p) => t.isObjectProperty(p) && strKey(p.key, p.computed) !== null && t.isFunctionExpression(p.value))) return null;
      fns = new Map(obj.properties.map((p) => [strKey(p.key, p.computed), p.value]));
      fnsName = s.declarations[0].id.name;
    }
    if (!t.isIfStatement(s)) continue;
    const cons = t.isBlockStatement(s.consequent) ? s.consequent.body : [s.consequent];
    if (isFlagTest(s.test, flagP.name)) {
      const src = gen(s.consequent);
      // deadCode yanına ölü kod koyabilir: payload = [] dışında başka deyimler varsa temizleme bayraklı çağrılar
      // açılmaz (o deyimler atlanırdı); diğer çağrılar etkilenmez
      const clr = cons[cons.length - 1];
      if (t.isExpressionStatement(clr) && t.isAssignmentExpression(clr.expression, { operator: '=' }) &&
          t.isIdentifier(clr.expression.left) && t.isArrayExpression(clr.expression.right) && !clr.expression.right.elements.length) {
        clearFlag = flagTest(s.test).right.value;
        clearDirty = !cons.slice(0, -1).every((x) => t.isFunctionDeclaration(x));
        payload = clr.expression.left.name;
      } else if (s.alternate && fnsName && new RegExp(`=${escapeRe(fnsName)}\\[${escapeRe(nameP.name)}\\]\\(\\)`).test(gen(s.alternate).replace(/\s+/g, ''))) {
        fnFlag = flagTest(s.test).right.value;
        // fonksiyon üretme dalı CFF makinesinin içinde kalmışsa (.apply(this) görünmüyor) referans çağrıları açılmaz
        refOpaque = !/\.apply\(this\)/.test(src);
        // createFunction içindeki length ayarlayıcı: helper(fn, fnLength)
        t.traverseFast(s.consequent, (n) => {
          if (t.isCallExpression(n) && t.isIdentifier(n.callee) && n.arguments.length === 2 && t.isIdentifier(n.arguments[0]) &&
              t.isIdentifier(n.arguments[1]) && /length/i.test(n.arguments[1].name)) lengthHelper = n.callee.name;
        });
      }
    } else if (isFlagTest(s.test, retP.name) && cons.length === 1 && t.isReturnStatement(cons[0]) &&
        t.isObjectExpression(cons[0].argument) && cons[0].argument.properties.length === 1) {
      retFlag = flagTest(s.test).right.value;
      retKey = strKey(cons[0].argument.properties[0].key, cons[0].argument.properties[0].computed);
    } else if (isFlagTest(s.test, retP.name)) {
      // okunamayan dönüş sarmalı (anahtar hiç çalışmamış decoder çağrısı): bu bayrakla yapılan çağrılar açılmaz
      retOpaque = flagTest(s.test).right.value;
    }
  }
  // CFF açıldıktan sonra: return ret === "…" ? { key: out } : out;
  const last = body[body.length - 1];
  if (retFlag === null && t.isReturnStatement(last) && t.isConditionalExpression(last.argument) &&
      isFlagTest(last.argument.test, retP.name) && t.isObjectExpression(last.argument.consequent) &&
      last.argument.consequent.properties.length === 1 && t.isObjectProperty(last.argument.consequent.properties[0])) {
    const prop = last.argument.consequent.properties[0];
    // dönen değer her iki kolda aynı ifade (yerel ad ya da kapsam yolu)
    const v = last.argument.alternate;
    if ((t.isIdentifier(v) || memberPath(v)) && gen(prop.value) === gen(v)) {
      retFlag = flagTest(last.argument.test).right.value;
      retKey = strKey(prop.key, prop.computed);
    }
  }
  if (!fns || fnFlag === null || !payload) return null;
  return { fns, fnsName, clearFlag, clearDirty, fnFlag, retFlag, retKey, retOpaque, refOpaque, payload, lengthHelper, params: fn.params.length };
}

// fns girdisi: function () { var [a, b] = payload; ... }  → { params, body } (yoksa null)
function readEntry(entryPath, payload, dispatcherPath) {
  const fnNode = entryPath.node;
  if (fnNode.async || fnNode.generator || usesThisOrArguments(fnNode)) return null;
  // movedDeclarations: yereller kullanılmayan parametrelere taşınmış olabilir (fns[name]() argümansız çağrılır):
  // yeniden yerel var olurlar
  if (!fnNode.params.every((x) => t.isIdentifier(x))) return null;
  let movedNames = fnNode.params.map((x) => x.name);
  const body = fnNode.body.body.filter((x) => !(t.isExpressionStatement(x) && t.isUnaryExpression(x.expression, { operator: '!' }) && t.isIdentifier(x.expression.argument)));
  const okEl = (e) => e && (t.isIdentifier(e) || t.isArrayPattern(e) || t.isObjectPattern(e) || t.isAssignmentPattern(e) || (t.isRestElement(e) && t.isIdentifier(e.argument)));
  let params = [];
  let rest = body;
  // variableMasking açılınca: başta başlatıcısız yerel bildirimler, ardından atama biçimi [a, [b]] = payload
  let lead = 0;
  while (t.isVariableDeclaration(body[lead]) && body[lead].kind !== 'const' && body[lead].declarations.every((d) => t.isIdentifier(d.id) && !d.init)) lead++;
  const first = body[lead];
  const firstExpr = t.isExpressionStatement(first) ? first.expression : null;
  if (!lead && t.isVariableDeclaration(first) && first.declarations.length === 1 && t.isArrayPattern(first.declarations[0].id) &&
      t.isIdentifier(first.declarations[0].init, { name: payload })) {
    const els = first.declarations[0].id.elements;
    // iç içe kalıplar da parametre olabilir: flatten + dispatcher → var [flatObject, [a, b]] = payload
    if (!els.every(okEl)) return null;
    params = els;
    rest = body.slice(1);
  } else if (t.isAssignmentExpression(firstExpr, { operator: '=' }) && t.isArrayPattern(firstExpr.left) && t.isIdentifier(firstExpr.right, { name: payload })) {
    const els = firstExpr.left.elements;
    if (!els.every(okEl)) return null;
    // hedefler yalnızca bu fonksiyonun yerelleri (baştaki bildirimler ya da taşınmış parametreler) olmalı
    const targets = Object.keys(t.getBindingIdentifiers(firstExpr.left));
    const locals = new Set([...movedNames, ...body.slice(0, lead).flatMap((d) => d.declarations.map((x) => x.id.name))]);
    let lv = true;
    t.traverseFast(firstExpr.left, (n) => { if (t.isMemberExpression(n)) lv = false; });
    if (!lv || !targets.every((x) => locals.has(x)) || new Set(targets).size !== targets.length) return null;
    params = els;
    // parametre olan adlar yerel bildirimlerden düşer (let parametreyi yeniden bildiremez)
    const decls = body.slice(0, lead).map((d) => t.variableDeclaration(d.kind, d.declarations.filter((x) => !targets.includes(x.id.name)))).filter((d) => d.declarations.length);
    movedNames = movedNames.filter((x) => !targets.includes(x));
    rest = [...decls, ...body.slice(lead + 1)];
  }
  const moved = movedNames.length ? [t.variableDeclaration('var', movedNames.map((x) => t.variableDeclarator(t.identifier(x))))] : [];
  rest = [...moved, ...rest];
  // payload başka yerde okunmamalı; dispatcher'ın yerel adlarına (fns, output, name...) bakmamalı
  let bad = false;
  t.traverseFast(t.blockStatement(rest), (n) => { if (t.isIdentifier(n, { name: payload })) bad = true; });
  if (bad) return null;
  entryPath.traverse({
    Identifier(q) {
      if (!q.isReferencedIdentifier() && !q.parentPath.isAssignmentExpression({ left: q.node })) return;
      const b = q.scope.getBinding(q.node.name);
      if (b && b.scope === dispatcherPath.scope) { bad = true; q.stop(); }
    },
  });
  if (bad) return null;
  return { params, rest, node: fnNode };
}

// İfadenin bulunduğu deyimde ondan önce hiçbir şey değerlendirilmiyorsa o deyim (return X / X; / var v = X / v = X)
function firstEvaluated(target) {
  const par = target.parentPath;
  if (par.isReturnStatement() || par.isExpressionStatement()) return par;
  if (par.isVariableDeclarator({ init: target.node }) && t.isIdentifier(par.node.id) && par.parent.declarations[0] === par.node) return par.parentPath;
  if (par.isAssignmentExpression({ operator: '=', right: target.node }) && t.isIdentifier(par.node.left) && par.parentPath.isExpressionStatement()) return par.parentPath;
  return null;
}

function dispatchers(ast, onLog) {
  let n = 0;
  const names = allNames(ast);
  traverse(ast, {
    // function D(name, flag, ret, …) {…}  ya da yüksek ayarda (CFF açıldıktan sonra) tek kez atanan V = function (…) {…}
    'FunctionDeclaration|FunctionExpression'(p) {
      // program düzeyi ya da (pack/IIFE içindeki) fonksiyon gövdesi; blok içi bildirimler Annex B nedeniyle atlanır
      const site = machineSite(p);
      if (!site) return;
      const where = site.anchor.parentPath;
      if (!where.isProgram() && !(where.isBlockStatement() && where.parentPath.isFunction())) return;
      const d = readDispatcher(p);
      if (!d) return;
      const binding = site.binding;
      if (p.isFunctionDeclaration() && !binding.constant) return;
      const entries = new Map();
      const byNode = new Map([...d.fns].map(([k, v]) => [v, k]));
      // fns yalnızca fns[name]() ve fns[name].apply(this) ile kullanılıyorsa girdiler hep argümansız çağrılır
      // (tablo kapsam yolundaysa: S.K.fns'in bütün okumaları)
      const fb = d.fnsName.includes('.') ? null : p.scope.getBinding(d.fnsName);
      const fnsRefs = [];
      if (fb) fnsRefs.push(...fb.referencePaths);
      else {
        p.traverse({
          MemberExpression(q) {
            if (memberPath(q.node) !== d.fnsName) return;
            if (q.parentPath.isAssignmentExpression({ left: q.node }) && q.parentPath.parentPath.isExpressionStatement()) return;
            fnsRefs.push(q);
            q.skip();
          },
        });
      }
      const zeroArgs = (Boolean(fb) || d.fnsName.includes('.')) && fnsRefs.every((r) => {
        const m = r.parentPath;
        if (!m.isMemberExpression({ object: r.node, computed: true })) return false;
        const c = m.parentPath;
        if (c.isCallExpression({ callee: m.node })) return !c.node.arguments.length;
        const ap = c.isMemberExpression({ object: m.node }) && strKey(c.node.property, c.node.computed) === 'apply' ? c.parentPath : null;
        return Boolean(ap?.isCallExpression({ callee: c.node }) && ap.node.arguments.length === 1 && t.isThisExpression(ap.node.arguments[0]));
      });
      p.traverse({
        FunctionExpression(q) {
          if (!byNode.has(q.node)) return;
          if (zeroArgs) {
            unmaskRest(q, true);
            // argümansız çağrılan girdide parametreye taşınmış fonksiyon: if (!P) P = function … → P = function …
            for (const s of q.get('body.body')) {
              const m = s.isIfStatement() ? movedFnAssign(s) : null;
              const b = m && s.scope.getBinding(m.name);
              if (b?.kind === 'param' && q.node.params.includes(b.path.node) && t.isIdentifier(b.path.node) && b.constantViolations.length === 1 &&
                  (q.isArrowFunctionExpression() || !usesOwnArguments(q))) s.replaceWith(t.expressionStatement(m.asg));
            }
          }
          const e = readEntry(q, d.payload, p);
          if (e) entries.set(byNode.get(q.node), e);
          q.skip();
        },
      });
      // çağrı yerlerini sınıflandır
      const sites = [];
      for (const ref of binding.referencePaths) {
        if (ref.findParent((x) => x === p)) continue;
        const c = ref.parentPath;
        if (!(c.isCallExpression() || c.isNewExpression()) || c.node.callee !== ref.node) continue;
        const args = c.node.arguments;
        if (!args.length || !t.isStringLiteral(args[0]) || !entries.has(args[0].value)) continue;
        if (args.slice(1).some((a) => !t.isStringLiteral(a) && !t.isObjectExpression(a))) continue;
        const flag = t.isStringLiteral(args[1]) ? args[1].value : undefined;
        const ret = t.isStringLiteral(args[2]) ? args[2].value : undefined;
        const mode = flag === d.fnFlag ? 'ref' : 'call';
        if ((flag !== undefined && flag === d.clearFlag && d.clearDirty) || (ret !== undefined && ret === d.retOpaque) || (mode === 'ref' && d.refOpaque)) continue;
        let target = c;
        if (ret !== undefined && ret === d.retFlag) {
          const m = c.parentPath;
          if (!m.isMemberExpression({ object: c.node }) || strKey(m.node.property, m.node.computed) !== d.retKey) continue;
          target = m;
        }
        // new D(...) yalnızca dönüş değeri nesneyse (retFlag sarmalı) düz çağrıyla aynıdır
        if (mode === 'call' && c.isNewExpression() && target === c) continue;
        sites.push({ key: args[0].value, mode, target, clear: flag === d.clearFlag, lengths: args.length > 3 });
      }
      // ref sitesi olan girdide .length gözlenebilir: sarmalayıcının length'i 0 (ayarlayıcı boş ve fnLengths yoksa)
      const helperEmpty = !d.lengthHelper || (() => {
        const hb = p.parentPath.scope.getBinding(d.lengthHelper);
        return hb?.path.isFunctionDeclaration() && !hb.path.node.body.body.length;
      })();
      const restForm = new Set();
      for (const s of sites) {
        if (s.mode !== 'ref') continue;
        if (!helperEmpty || s.lengths) s.skip = true; else restForm.add(s.key);
      }

      const made = new Map();
      const nameFor = (key) => {
        if (made.has(key)) return made.get(key);
        let base = t.isValidIdentifier(key) ? key : `fn_${key.replace(/[^\w$]/g, '_')}`;
        let name = base;
        for (let i = 2; names.has(name); i++) name = `${base}${i}`;
        names.add(name);
        made.set(key, name);
        return name;
      };
      let done = 0;
      for (const s of sites) {
        if (s.skip || !s.target.node) continue;
        const e = entries.get(s.key);
        if (s.mode === 'ref') {
          s.target.replaceWith(t.identifier(nameFor(s.key)));
          done++;
          continue;
        }
        // çağrı: (payload = [a, b], D("k")) → k(a, b)
        let args = null;
        let seq = null;
        if (s.clear || !e.params.length) args = [];
        const par = s.target.parentPath;
        if (!s.clear && par.isSequenceExpression()) {
          const i = par.node.expressions.indexOf(s.target.node);
          const prev = par.node.expressions[i - 1];
          if (i > 0 && t.isAssignmentExpression(prev, { operator: '=' }) && t.isIdentifier(prev.left, { name: d.payload }) &&
              t.isArrayExpression(prev.right) && prev.right.elements.every((x) => x !== null)) {
            args = prev.right.elements;
            seq = { par, i };
          }
        }
        // ayrı deyim biçimi: payload = [a, b]; return new D("k", f, r).ret; — çağrı deyimde ilk değerlendirilen ifade
        let prevStmt = null;
        if (!args && !s.clear) {
          const stmt = firstEvaluated(s.target);
          const prev = stmt && Array.isArray(stmt.container) && stmt.key > 0 ? stmt.getSibling(stmt.key - 1) : null;
          const pe = prev?.isExpressionStatement() ? prev.node.expression : null;
          if (t.isAssignmentExpression(pe, { operator: '=' }) && t.isIdentifier(pe.left, { name: d.payload }) &&
              t.isArrayExpression(pe.right) && pe.right.elements.every((x) => x !== null)) {
            args = pe.right.elements;
            prevStmt = prev;
          }
        }
        if (!args) continue;
        const call = t.callExpression(t.identifier(nameFor(s.key)), args);
        if (seq) {
          const exprs = seq.par.node.expressions.slice();
          exprs.splice(seq.i - 1, 2, call);
          seq.par.replaceWith(exprs.length === 1 ? exprs[0] : t.sequenceExpression(exprs));
        } else {
          s.target.replaceWith(call);
          if (prevStmt) prevStmt.remove();
        }
        done++;
      }
      if (!done) return;
      const decls = [...made].map(([key, name]) => {
        const e = entries.get(key);
        const body = e.rest.map((x) => t.cloneNode(x, true));
        if (restForm.has(key) && e.params.length) {
          const argsId = t.identifier(`${name}Args`);
          return t.functionDeclaration(t.identifier(name), [t.restElement(argsId)], t.blockStatement([
            t.variableDeclaration('var', [t.variableDeclarator(t.arrayPattern(e.params.map((x) => t.cloneNode(x, true))), t.cloneNode(argsId))]),
            ...body,
          ]));
        }
        return t.functionDeclaration(t.identifier(name), e.params.map((x) => t.cloneNode(x, true)), t.blockStatement(body));
      });
      site.anchor.insertAfter(decls);
      n += done;
      onLog(`confuser: dispatcher ${site.name} — ${done} çağrı ${made.size} ayrı fonksiyona bağlandı`, 'info');
      where.scope.crawl();
      const after = where.scope.getBinding(site.name);
      if (after && after.referencePaths.every((r) => r.findParent((x) => x === p))) site.anchor.remove();
    },
  });
  return n;
}

// ── A-21: rest parametre (variableMasking) ───────────

// js-confuser variableMasking (1.x "stack"): parametreler ve yereller tek rest dizisinin elemanlarına taşınır:
//   function sum(...M) { M.length = 1; M.a = 0; for (M[2] = 0; …) M.a += M[0][M[2]]; return M.a; }
// Sayısal indeksler parametre, adlı anahtarlar yerel değişken olur. Gövde başındaki "M.length = N" fazla
// argümanları siler: o zaman N ve üstü indeksler yereldir; bu deyim yoksa en büyük indekse kadar her indeks
// parametre kalır (fazla argüman gelirse aynı değeri alsın). Atlanır: M başka biçimde kullanılıyorsa
// (M.length okuması, aktarım, dinamik anahtar, M.x() çağrısı, prototipten gelen ad), gövde arguments kullanıyorsa.
// Not: rest parametreli fonksiyonun length'i 0'dı, açılınca parametre sayısı olur.

const MAX_MASK_INDEX = 64;

function maskKey(member) {
  if (!member.computed && t.isIdentifier(member.property)) return member.property.name;
  if (member.computed && t.isNumericLiteral(member.property) && Number.isInteger(member.property.value)) return member.property.value;
  // M[-82]: negatif indeks hiçbir argümana karşılık gelmez, yereldir
  if (member.computed && t.isUnaryExpression(member.property, { operator: '-' }) && t.isNumericLiteral(member.property.argument) &&
      Number.isInteger(member.property.argument.value) && member.property.argument.value > 0) return -member.property.argument.value;
  if (member.computed && t.isStringLiteral(member.property)) {
    const v = member.property.value;
    return /^(0|[1-9]\d*)$/.test(v) ? Number(v) : v;
  }
  return null;
}

function usesOwnArguments(fnPath) {
  let hit = false;
  fnPath.traverse({
    Identifier(p) {
      if (p.node.name === 'arguments' && p.isReferencedIdentifier() && !p.scope.getBinding('arguments')) {
        const owner = p.getFunctionParent();
        if (owner === fnPath || (owner?.isArrowFunctionExpression() && owner.findParent((x) => x === fnPath))) { hit = true; p.stop(); }
      }
    },
  });
  return hit;
}

function restParams(ast) {
  let n = 0;
  traverse(ast, {
    Function(fn) {
      if (unmaskRest(fn)) n++;
    },
  });
  return n;
}

// allLocal: fonksiyon yalnızca argümansız çağrılıyor (dispatcher girdisi fns[name]()): dizi taze ve boştur,
// her anahtar yereldir (M.length = 0 varmış gibi)
function unmaskRest(fn, allLocal = false) {
      const { params } = fn.node;
      if (params.length !== 1 || !t.isRestElement(params[0]) || !t.isIdentifier(params[0].argument)) return false;
      if (!t.isBlockStatement(fn.node.body)) return false;
      const mask = params[0].argument.name;
      const b = fn.scope.getBinding(mask);
      if (!b || b.constantViolations.length || !b.referencePaths.length) return false;

      const body = fn.get('body.body');
      // gövde başındaki M.length = N
      let limit = null;
      let lengthStmt = null;
      const first = body[0]?.node;
      if (t.isExpressionStatement(first) && t.isAssignmentExpression(first.expression, { operator: '=' }) &&
          t.isMemberExpression(first.expression.left) && t.isIdentifier(first.expression.left.object, { name: mask }) &&
          maskKey(first.expression.left) === 'length' && t.isNumericLiteral(first.expression.right) &&
          Number.isInteger(first.expression.right.value)) {
        limit = first.expression.right.value;
        lengthStmt = body[0];
      }
      if (allLocal) limit = 0;

      const refs = [];
      for (const r of b.referencePaths) {
        if (lengthStmt && r.findParent((x) => x === lengthStmt)) continue;
        const m = r.parentPath;
        if (!m.isMemberExpression({ object: r.node })) return false;
        const key = maskKey(m.node);
        // M.length = N varsa N ve üstü indeksler yereldir, büyüklükleri parametre sayısını etkilemez
        if (key === null || key === 'length' || (typeof key === 'number' && key > MAX_MASK_INDEX && (limit === null || key < limit))) return false;
        if (typeof key === 'string' && (!t.isValidIdentifier(key) || ['arguments', 'eval'].includes(key))) return false;
        // dizi/nesne prototipinden gelen ad (M.map) ilk okumada undefined değildir
        if (typeof key === 'string' && key in []) return false;
        if (m.parentPath.isUnaryExpression({ operator: 'delete' })) return false;
        // M.x() çağrısı this olarak M'yi verir: değişkene dönünce this değişir
        if (m.parentPath.isCallExpression({ callee: m.node }) || m.parentPath.isOptionalCallExpression({ callee: m.node })) return false;
        refs.push({ m, key });
      }
      if (!fn.isArrowFunctionExpression() && usesOwnArguments(fn)) return false;

      const numeric = refs.filter((r) => typeof r.key === 'number' && r.key >= 0).map((r) => r.key);
      const maxIdx = numeric.length ? Math.max(...numeric) : -1;
      const paramCount = limit === null ? maxIdx + 1 : Math.min(limit, maxIdx + 1);

      // ad üretimi: işlev içinde ve dış kapsamlarda kullanılmayan adlar
      const taken = new Set();
      fn.traverse({ Identifier(p) { if (p.isReferencedIdentifier() || p.isBindingIdentifier()) taken.add(p.node.name); } });
      const fresh = (base) => {
        let name = base;
        for (let i = 2; taken.has(name) || fn.scope.hasBinding(name); i++) name = `${base}_${i}`;
        taken.add(name);
        return name;
      };
      const names = new Map();
      const nameOf = (key) => {
        if (!names.has(key)) names.set(key, fresh(typeof key !== 'number' ? key : key < 0 ? `local${-key}` : (limit !== null && key >= limit) ? `local${key}` : `arg${key}`));
        return names.get(key);
      };
      for (let i = 0; i < paramCount; i++) nameOf(i);
      for (const { key } of refs) nameOf(key);

      const locals = [...names.entries()].filter(([k]) => !(typeof k === 'number' && k >= 0 && k < paramCount)).map(([, v]) => v);
      for (const { m, key } of refs) m.replaceWith(t.identifier(names.get(key)));
      fn.node.params = Array.from({ length: paramCount }, (_, i) => t.identifier(names.get(i)));
      if (lengthStmt) lengthStmt.remove();
      if (locals.length) fn.get('body').unshiftContainer('body', t.variableDeclaration('var', locals.map((x) => t.variableDeclarator(t.identifier(x)))));
      return true;
}

// js-confuser yüksek ayar: fonksiyon ifadesi argümanlarını tek rest dizisinden açar:
//   function (...R) { let a, b, c; [a, b = { K: {} }, ...c] = R; … }  →  function (a, b = { K: {} }, ...c) { … }
// Koşullar: R yalnızca bu atamada okunur, hedefler başlangıçsız let/var bildirimleriyle bildirilmiş adlardır,
// varsayılanlar ad içermez (parametre kapsamı gövde bağlarını göremez), fonksiyon arguments kullanmaz.
// (length 0'dan parametre sayısına döner; Function.length kabulü.)
function restDestructure(ast) {
  let n = 0;
  traverse(ast, {
    Function(fn) {
      const { params } = fn.node;
      if (params.length !== 1 || !t.isRestElement(params[0]) || !t.isIdentifier(params[0].argument) || !t.isBlockStatement(fn.node.body)) return;
      const rest = params[0].argument.name;
      const rb = fn.scope.getBinding(rest);
      if (!rb || rb.constantViolations.length || rb.referencePaths.length !== 1) return;
      const body = fn.node.body.body;
      let lead = 0;
      while (t.isVariableDeclaration(body[lead]) && body[lead].kind !== 'const' && body[lead].declarations.every((d) => t.isIdentifier(d.id) && !d.init)) lead++;
      const e = t.isExpressionStatement(body[lead]) ? body[lead].expression : null;
      if (!t.isAssignmentExpression(e, { operator: '=' }) || !t.isArrayPattern(e.left) || !t.isIdentifier(e.right, { name: rest }) ||
          rb.referencePaths[0].node !== e.right) return;
      const els = e.left.elements;
      const noNames = (x) => (t.isLiteral(x) && !t.isTemplateLiteral(x)) || (t.isArrayExpression(x) && x.elements.every((q) => q && noNames(q))) ||
        (t.isObjectExpression(x) && x.properties.every((q) => t.isObjectProperty(q) && !q.computed && noNames(q.value)));
      if (!els.every((x, i) => x && (t.isIdentifier(x) || (t.isAssignmentPattern(x) && t.isIdentifier(x.left) && noNames(x.right)) ||
        (t.isRestElement(x) && t.isIdentifier(x.argument) && i === els.length - 1)))) return;
      const targets = els.map((x) => (t.isIdentifier(x) ? x.name : t.isAssignmentPattern(x) ? x.left.name : x.argument.name));
      const declared = new Set(body.slice(0, lead).flatMap((d) => d.declarations.map((x) => x.id.name)));
      if (new Set(targets).size !== targets.length || !targets.every((x) => declared.has(x) && fn.scope.getBinding(x)?.scope === fn.scope)) return;
      if (!fn.isArrowFunctionExpression() && usesOwnArguments(fn)) return;
      fn.node.params = els.map((x) => t.cloneNode(x, true));
      const decls = body.slice(0, lead).map((d) => t.variableDeclaration(d.kind, d.declarations.filter((x) => !targets.includes(x.id.name))))
        .filter((d) => d.declarations.length);
      fn.node.body.body = [...decls, ...body.slice(lead + 1)];
      n++;
    },
  });
  return n;
}

// js-confuser movedDeclarations, fonksiyon bildirimleri: function F(a, …, P) { if (!P) { P = function (…) {…}; } … }
// P hiçbir çağrıda verilmeyen bir parametredir (her çağrı yeri P'nin konumundan az argüman geçer): giriş anında
// undefined'dır, test her zaman tutar → P = function (…) {…};  (P başka yerde yazılmıyor, arguments kullanılmıyor)
// if (!P) { P = function (…) {…}; }  → { name, asg } (yoksa null)
function movedFnAssign(ip) {
  const { test, consequent, alternate } = ip.node;
  if (alternate || !t.isUnaryExpression(test, { operator: '!' }) || !t.isIdentifier(test.argument)) return null;
  const body = t.isBlockStatement(consequent) ? consequent.body : [consequent];
  const asg = body.length === 1 && t.isExpressionStatement(body[0]) ? body[0].expression : null;
  if (!t.isAssignmentExpression(asg, { operator: '=' }) || !t.isIdentifier(asg.left, { name: test.argument.name }) || !t.isFunctionExpression(asg.right)) return null;
  return { name: test.argument.name, asg };
}

function movedFunctions(ast) {
  let n = 0;
  traverse(ast, {
    IfStatement(ip) {
      const mf = movedFnAssign(ip);
      if (!mf) return;
      const { asg } = mf;
      const test = ip.node.test;
      const fn = ip.parentPath.parentPath;
      if (!fn?.isFunction() || !ip.parentPath.isBlockStatement() || !Array.isArray(ip.container)) return;
      const b = ip.scope.getBinding(test.argument.name);
      const idx = fn.node.params.indexOf(b?.path.node);
      if (!b || b.kind !== 'param' || idx < 0 || !t.isIdentifier(fn.node.params[idx]) || b.constantViolations.length !== 1) return;
      if (!fn.isArrowFunctionExpression() && usesOwnArguments(fn)) return;
      // fonksiyonun her çağrısı (bildirimi ya da tek kez atanan ifadesi) P'nin konumuna argüman vermez
      const site = machineSite(fn);
      if (!site) return;
      if (!site.binding.referencePaths.every((r) => {
        const c = r.parentPath;
        return (c.isCallExpression({ callee: r.node }) || c.isNewExpression({ callee: r.node })) && c.node.arguments.length <= idx &&
          !c.node.arguments.some((a) => t.isSpreadElement(a));
      })) return;
      ip.replaceWith(t.expressionStatement(asg));
      n++;
    },
  });
  return n;
}

// ── A-22: __generator → function* ───────────────────────

function generatorHelpers(ast) {
  const names = new Set();
  traverse(ast, {
    'FunctionDeclaration|VariableDeclarator'(p) {
      const id = p.isFunctionDeclaration() ? p.node.id : p.node.id;
      if (!t.isIdentifier(id)) return;
      const src = gen(p.node);
      if (src.includes('Generator is already executing') && src.length < 4000) {
        const b = (p.isFunctionDeclaration() ? p.parentPath.scope : p.scope).getBinding(id.name);
        if (b?.constant) names.add(id.name);
      }
    },
  });
  return names;
}

class NoGen extends Error {}
const nogen = (why) => { throw new NoGen(why); };

// _a.sent()
const isSent = (n, a) => t.isCallExpression(n) && !n.arguments.length && t.isMemberExpression(n.callee) && !n.callee.computed &&
  t.isIdentifier(n.callee.object, { name: a }) && t.isIdentifier(n.callee.property, { name: 'sent' });

function opOf(ret) {
  const arg = ret.argument;
  if (!t.isArrayExpression(arg) || !arg.elements.length || !t.isNumericLiteral(arg.elements[0]) || arg.elements.length > 2) return nogen('dönüş biçimi');
  return { op: arg.elements[0].value, value: arg.elements[1] ?? null };
}

// [2, e] dönüşlerini `return e`'ye çevirir; iç fonksiyonlara girmez. [4, …] ve diğer işlemler burada yasak.
function rewriteReturns(node, a) {
  const walk = (n) => {
    if (!n || typeof n !== 'object') return n;
    if (t.isFunction(n)) return n;
    if (t.isReturnStatement(n)) {
      const { op, value } = opOf(n);
      if (op !== 2) nogen(`iç işlem ${op}`);
      return t.returnStatement(value ? walk(value) : null);
    }
    if (t.isMemberExpression(n) && t.isIdentifier(n.object, { name: a })) nogen('_a kullanımı');
    if ((t.isBreakStatement(n) || t.isContinueStatement(n)) && n.label) nogen('etiketli atlama');
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) n[k] = v.map(walk); else n[k] = walk(v);
    }
    return n;
  };
  return walk(t.cloneNode(node, true));
}

// switch'i hedefleyen etiketsiz break (iç döngü/switch dışında) var mı?
function breaksSwitch(stmts) {
  let found = false;
  const walk = (n, nested) => {
    if (!n || typeof n !== 'object' || found || t.isFunction(n)) return;
    if (t.isBreakStatement(n) && !n.label && !nested) { found = true; return; }
    const inner = nested || t.isLoop(n) || t.isSwitchStatement(n);
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, inner)); else walk(v, inner);
    }
  };
  stmts.forEach((s) => walk(s, false));
  return found;
}

// _a.sent() içeren ilk deyim: yield ifadesini sonucun yerine koy
function placeYield(stmt, a, yieldExpr) {
  if (t.isExpressionStatement(stmt) && isSent(stmt.expression, a)) return t.expressionStatement(yieldExpr);
  if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression, { operator: '=' }) &&
      t.isIdentifier(stmt.expression.left) && isSent(stmt.expression.right, a)) {
    return t.expressionStatement(t.assignmentExpression('=', stmt.expression.left, yieldExpr));
  }
  if (t.isVariableDeclaration(stmt) && stmt.declarations.length === 1 && t.isIdentifier(stmt.declarations[0].id) &&
      isSent(stmt.declarations[0].init, a)) {
    return t.variableDeclaration(stmt.kind, [t.variableDeclarator(stmt.declarations[0].id, yieldExpr)]);
  }
  if (t.isReturnStatement(stmt) && t.isArrayExpression(stmt.argument) && stmt.argument.elements.length === 2 &&
      t.isNumericLiteral(stmt.argument.elements[0], { value: 2 }) && isSent(stmt.argument.elements[1], a)) {
    return t.returnStatement(yieldExpr);
  }
  return null;
}

function containsSent(node, a) {
  let found = false;
  t.traverseFast(node, (n) => { if (isSent(n, a)) found = true; });
  return found;
}

function linearize(bodyFn) {
  const a = bodyFn.params.length ? (t.isIdentifier(bodyFn.params[0]) ? bodyFn.params[0].name : nogen('parametre')) : '__none';
  if (bodyFn.params.length > 1 || bodyFn.async || bodyFn.generator || t.isArrowFunctionExpression(bodyFn)) nogen('gövde biçimi');
  if (usesArguments(bodyFn.body)) nogen('arguments');
  const stmts = bodyFn.body.body;
  let cases;
  if (stmts.length === 1 && t.isSwitchStatement(stmts[0])) {
    const d = stmts[0].discriminant;
    if (!t.isMemberExpression(d) || d.computed || !t.isIdentifier(d.object, { name: a }) || !t.isIdentifier(d.property, { name: 'label' })) nogen('switch');
    cases = stmts[0].cases.map((c, i) => {
      if (!t.isNumericLiteral(c.test, { value: i })) nogen('etiket sırası');
      return c.consequent;
    });
  } else {
    cases = [stmts];
  }
  const out = [];
  let pendingYield = null;
  cases.forEach((list, ci) => {
    if (breaksSwitch(list)) nogen('break');
    let body = list.slice();
    if (pendingYield) {
      const first = body[0];
      const placed = first && placeYield(first, a, pendingYield);
      if (placed) body = body.slice(1);
      out.push(placed ?? t.expressionStatement(pendingYield));
      pendingYield = null;
    }
    if (body.some((s) => containsSent(s, a))) nogen('_a.sent() konumu');
    const last = body[body.length - 1];
    if (t.isReturnStatement(last)) {
      const { op, value } = opOf(last);
      if (op === 4) {
        if (ci === cases.length - 1) nogen('son yield');
        out.push(...body.slice(0, -1).map((s) => rewriteReturns(s, a)));
        pendingYield = t.yieldExpression(value ? rewriteReturns(value, a) : null);
        return;
      }
    } else if (ci === cases.length - 1) nogen('son case dönüşsüz');
    out.push(...body.map((s) => rewriteReturns(s, a)));
  });
  return out;
}

function generators(ast, onLog) {
  const helpers = generatorHelpers(ast);
  if (!helpers.size) return 0;
  let n = 0;
  traverse(ast, {
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      if (!t.isIdentifier(callee) || !helpers.has(callee.name) || p.scope.getBinding(callee.name)?.scope.path.isProgram() === false) return;
      if (args.length !== 2 || !t.isThisExpression(args[0]) || !t.isFunctionExpression(args[1])) return;
      const ret = p.parentPath;
      if (!ret.isReturnStatement()) return;
      const fnPath = ret.parentPath.parentPath;
      if (!fnPath?.isFunction() || fnPath.isArrowFunctionExpression() || fnPath.node.async || fnPath.node.generator) return;
      const fnBody = fnPath.node.body.body;
      if (fnBody[fnBody.length - 1] !== ret.node) return;
      // önce çalışan deyimler: yalnızca başlangıçsız var (üreteç gövdesi ilk next()'e kadar ertelenir)
      const prelude = fnBody.slice(0, -1);
      if (!prelude.every((s) => t.isVariableDeclaration(s, { kind: 'var' }) && s.declarations.every((d) => !d.init))) return;
      // üreteç fonksiyonu new ile çağrılamaz: yalnızca çağrılan ya da __awaiter'a verilen fonksiyonlar
      const okUse = (() => {
        if (fnPath.isFunctionDeclaration()) {
          const b = fnPath.parentPath.scope.getBinding(fnPath.node.id.name);
          return b?.constant && b.referencePaths.every((r) => r.parentPath.isCallExpression({ callee: r.node }));
        }
        const par = fnPath.parentPath;
        if (par.isCallExpression() && par.node.arguments.includes(fnPath.node) && t.isIdentifier(par.node.callee) &&
            /awaiter/i.test(par.node.callee.name)) return true;
        if (par.isVariableDeclarator({ init: fnPath.node }) && t.isIdentifier(par.node.id)) {
          const b = par.scope.getBinding(par.node.id.name);
          return b?.constant && b.referencePaths.every((r) => r.parentPath.isCallExpression({ callee: r.node }));
        }
        return false;
      })();
      if (!okUse) return;
      let body;
      try { body = linearize(args[1]); } catch (e) {
        if (!(e instanceof NoGen)) throw e;
        onLog(`confuser: __generator açılamadı (${e.message})`, 'warn');
        return;
      }
      fnPath.node.generator = true;
      fnPath.node.body = t.blockStatement([...prelude, ...body]);
      n++;
    },
  });
  if (n) onLog(`confuser: ${n} __generator durum makinesi function*'a çevrildi`, 'info');
  // kullanılmayan yardımcı: var __generator = (this && this.__generator) || function (...) {...}
  // shortcut: global nesnede __generator getter'ı olmadığı varsayılır (tslib kalıbı; okuma yan etkisiz)
  if (!n) return 0;
  traverse(ast, {
    Program(p) { p.scope.crawl(); },
    VariableDeclarator(p) {
      if (!t.isIdentifier(p.node.id) || !helpers.has(p.node.id.name)) return;
      const b = p.scope.getBinding(p.node.id.name);
      const init = p.node.init;
      if (!b || b.referenced || !t.isLogicalExpression(init, { operator: '||' }) || !t.isFunctionExpression(init.right)) return;
      const left = init.left;
      const member = t.isLogicalExpression(left, { operator: '&&' }) ? left.right : left;
      if (!t.isMemberExpression(member) || member.computed || !t.isIdentifier(member.property, { name: p.node.id.name })) return;
      p.remove();
      n++;
    },
  });
  return n;
}

export async function run(ast, { onLog, bump }) {
  const d = dispatchers(ast, onLog);
  const r = restParams(ast) + restDestructure(ast);
  const mf = movedFunctions(ast);
  if (mf) onLog(`confuser: parametreye taşınmış ${mf} fonksiyon bildirimi düz atamaya çevrildi`, 'info');
  if (r) onLog(`confuser: ${r} fonksiyonda rest parametre + length gerçek parametrelere çevrildi`, 'info');
  const g = generators(ast, onLog);
  bump('dispatcher', d);
  bump('restParams', r);
  bump('generator', g);
}
