import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { literalValue } from '../util/pure.js';
import { readDispatcher } from './37-confuser.js';

// js-confuser controlFlowFlattening, durum makinesi açıldıktan sonra kalan "kapsam nesneleri":
//   function M(states, scope = { K: {} }, runtime, arg) { scope.K.x = 1; scope.K.f = function (...a) {
//     return M2(seq, { K: scope.K, L: {} }, runtime, a); }; … }
//   function M2(states, scope = { K: {} }, runtime, arg) { [scope.L.n] = arg; return scope.K.x + scope.L.n; }
// Değişkenler kapsam nesnesinin özellikleridir; iç fonksiyonlar dış kapsamın nesnesini argümanla alır.
// 1) Tek çağrı yeri bir kabuk fonksiyondaki "return M2(…)" olan makine kopyası o kabuğun gövdesine taşınır
//    (parametreler aynı sırada değerlendirilen var bildirimleri olur): kapanış ilişkisi sözdizimine döner.
// 2) Kapsam kökü (varsayılan değeri ya da başlangıcı { K: {}, L: P.K } olan bağ): takma ad özellikleri (L: P.K)
//    kaynağa çevrilir, taze nesneler ({}) yerel değişkenlere bölünür: scope.K.x → x.
// Koşullar: kök ve nesneler yalnızca sabit adlı üye erişimiyle kullanılır (aktarım, delete, in, for-in yok);
// üye çağrısı (scope.K.f()) yalnızca atanan her değer this kullanmayan bir fonksiyonsa düz çağrıya döner.

const keyOf = (m) => (!m.computed && t.isIdentifier(m.property) ? m.property.name : t.isStringLiteral(m.property) ? m.property.value : null);

function usesThisOrArguments(fn) {
  let hit = false;
  const walk = (n, top) => {
    if (!n || typeof n !== 'object' || hit) return;
    if (!top && (t.isFunctionDeclaration(n) || t.isFunctionExpression(n) || t.isObjectMethod(n) || t.isClassMethod(n) || t.isClassPrivateMethod(n))) return;
    if (t.isThisExpression(n) || t.isSuper(n) || t.isMetaProperty(n) || t.isIdentifier(n, { name: 'arguments' })) { hit = true; return; }
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, false)); else walk(v, false);
    }
  };
  walk(fn.body, false);
  for (const p of fn.params) walk(p, false);
  return hit;
}

// Yan etkisiz argüman: literal, sabit anahtarlı literal nesne/dizi, ya da js-confuser durum dizisi parçası
//   ...slice(1, 9)   (function slice(a, b) { return SEQ.slice(a, b); }, SEQ hiç değişmeyen literal dizi)
function isSeqSlice(call, program) {
  if (!t.isCallExpression(call) || !t.isIdentifier(call.callee) || !call.arguments.every((a) => t.isNumericLiteral(a))) return false;
  const b = program.scope.getBinding(call.callee.name);
  const fn = b?.constant ? b.path.node : null;
  if (!t.isFunctionDeclaration(fn) || fn.body.body.length !== 1 || !t.isReturnStatement(fn.body.body[0])) return false;
  const r = fn.body.body[0].argument;
  if (!t.isCallExpression(r) || !t.isMemberExpression(r.callee) || r.callee.computed || !t.isIdentifier(r.callee.property, { name: 'slice' }) ||
      !t.isIdentifier(r.callee.object)) return false;
  const sb = b.path.scope.getBinding(r.callee.object.name);
  return Boolean(sb?.constant && sb.path.isVariableDeclarator() && t.isArrayExpression(sb.path.node.init) &&
    sb.referencePaths.every((x) => x.parentPath.isMemberExpression({ object: x.node }) && !x.parentPath.node.computed &&
      t.isIdentifier(x.parentPath.node.property, { name: 'slice' }) && x.parentPath.parentPath.isCallExpression()));
}
// Durum dizisinin değeri statik olarak: [n, -n, ...slice(a, b)] → sayı dizisi (SEQ literal sayı dizisiyse), yoksa null
export function staticStates(n, where) {
  if (!t.isArrayExpression(n) || !pureArg(n, where)) return null;
  const num = (e) => (t.isNumericLiteral(e) ? e.value : t.isUnaryExpression(e, { operator: '-' }) && t.isNumericLiteral(e.argument) ? -e.argument.value : null);
  const out = [];
  for (const e of n.elements) {
    if (t.isSpreadElement(e)) {
      const fb = where.scope.getBinding(e.argument.callee.name);
      const r = fb.path.node.body.body[0].argument;
      const sb = fb.path.scope.getBinding(r.callee.object.name);
      const seq = sb.path.node.init.elements.map(num);
      if (seq.some((x) => x === null)) return null;
      // slice(min, max) → parametre sırası fonksiyonun kendi parametrelerine göre
      const ps = fb.path.node.params.map((x) => x.name);
      const args = Object.fromEntries(ps.map((p, i) => [p, e.argument.arguments[i]?.value]));
      const at = (x) => (t.isIdentifier(x) ? args[x.name] : t.isNumericLiteral(x) ? x.value : undefined);
      const lo = at(r.arguments[0]);
      const hi = r.arguments.length > 1 ? at(r.arguments[1]) : seq.length;
      if (typeof lo !== 'number' || typeof hi !== 'number' || r.arguments.length > 2) return null;
      out.push(...seq.slice(lo, hi));
    } else {
      const v = num(e);
      if (v === null) return null;
      out.push(v);
    }
  }
  return out;
}

export function pureArg(n, program) {
  if (t.isLiteral(n) && !t.isTemplateLiteral(n)) return true;
  if (t.isUnaryExpression(n, { operator: '-' }) || t.isUnaryExpression(n, { operator: 'void' })) return pureArg(n.argument, program);
  if (t.isArrayExpression(n)) return n.elements.every((e) => e && (t.isSpreadElement(e) ? isSeqSlice(e.argument, program) : pureArg(e, program)));
  if (t.isObjectExpression(n)) return n.properties.every((p) => t.isObjectProperty(p) && (!p.computed || t.isStringLiteral(p.key)) && pureArg(p.value, program));
  return false;
}

// 1) makine kopyasını kabuğuna taşı
function inlineClones(ast) {
  let n = 0;
  let program = null;
  traverse(ast, { Program(p) { program = p; p.stop(); } });
  const used = new Set();
  // program düzeyi ya da fonksiyon gövdesi düzeyi (js-confuser pack: tüm program bir IIFE'nin içinde) bildirimler
  const decls = [];
  traverse(ast, {
    Identifier(q) { used.add(q.node.name); },
    FunctionDeclaration(q) {
      if (q.parentPath.isProgram() || (q.parentPath.isBlockStatement() && q.parentPath.parentPath.isFunction())) decls.push(q);
    },
  });
  for (const mPath of decls) {
    const m = mPath.node;
    if (!m || !t.isFunctionDeclaration(m) || m.async || m.generator || m.params.length < 2) continue;
    if (!m.params.every((x) => t.isIdentifier(x) || (t.isAssignmentPattern(x) && t.isIdentifier(x.left) && t.isObjectExpression(x.right)))) continue;
    const declScope = mPath.parentPath.isProgram() ? program.scope : mPath.parentPath.parentPath.scope;
    const b = declScope.getBinding(m.id.name);
    if (!b?.constant || b.referencePaths.length !== 1) continue;
    const call = b.referencePaths[0].parentPath;
    if (!call.isCallExpression({ callee: b.referencePaths[0].node }) || call.node.arguments.length > m.params.length) continue;
    const ret = call.parentPath;
    const shell = ret.parentPath?.parentPath;
    if (!ret.isReturnStatement() || !(shell?.isFunctionExpression() || shell?.isFunctionDeclaration()) || !t.isBlockStatement(shell.node.body)) continue;
    // tek deyimlik kabuk, ya da çağrı kabuğun son deyimi (pack IIFE'si: return M(seq, …) program gövdesinin sonunda)
    const shellBody = shell.node.body.body;
    const single = shellBody.length === 1 && shell.isFunctionExpression();
    // son deyim biçimi yalnızca makine imzasında (states, scope = {…}, …): dispatcher gibi sıradan fonksiyonlar
    // çağrı yerine gömülmez (confuser onları ayrı fonksiyonlara açar)
    if (!single && (shellBody[shellBody.length - 1] !== ret.node || !t.isAssignmentPattern(m.params[1]) || !t.isObjectExpression(m.params[1].right))) continue;
    if (shell.node.async || shell.node.generator || usesThisOrArguments(m) || readDispatcher(mPath)) continue;
    const args = call.node.arguments;
    if (args.some((a) => t.isSpreadElement(a))) continue;
    // varsayılan değerli parametreye undefined olabilecek değer geçiyorsa varsayılanın anlamı korunamaz
    // (argüman hiç verilmediyse varsayılan her zaman kullanılır: bildirimin başlangıcı olur)
    if (m.params.some((x, i) => t.isAssignmentPattern(x) && i < args.length && !(t.isObjectExpression(args[i]) || t.isArrayExpression(args[i])))) continue;
    // gövdenin serbest adları kabuğun yerinde aynı bağa gitmeli
    const locals = new Set(Object.keys(mPath.scope.bindings));
    let leak = false;
    mPath.traverse({
      Identifier(q) {
        if (!q.isReferencedIdentifier() || locals.has(q.node.name)) return;
        const own = q.scope.getBinding(q.node.name);
        // kopyanın kendi iç bağları
        if (own && (own.scope.path === mPath || own.scope.path.findParent((x) => x === mPath))) return;
        if (shell.scope.getBinding(q.node.name) !== own) { leak = true; q.stop(); }
      },
    });
    if (leak) continue;
    // parametre adları argüman ifadelerindeki (kabuğun kapsamındaki) aynı adları gölgelemesin: kopyanın
    // parametreleri benzersiz adlara çevrilir (var p = { K: p.K } kendi bildirimini okurdu)
    for (const x of m.params) {
      const old = t.isAssignmentPattern(x) ? x.left.name : x.name;
      let fresh = `${old}_1`;
      for (let i = 2; used.has(fresh); i++) fresh = `${old}_${i}`;
      used.add(fresh);
      mPath.scope.rename(old, fresh);
    }
    // kabukta başka deyimler varsa kopyanın kendi bildirimleri (yükseltilince) kabuğun adlarıyla çakışmasın
    if (!single) {
      const outside = new Set();
      shell.traverse({ Identifier(q) { if (!q.findParent((x) => x === mPath)) outside.add(q.node.name); } });
      for (const name of Object.keys(mPath.scope.bindings)) {
        if (!outside.has(name)) continue;
        let fresh = `${name}_1`;
        for (let i = 2; used.has(fresh); i++) fresh = `${name}_${i}`;
        used.add(fresh);
        mPath.scope.rename(name, fresh);
      }
    }
    // gövdede okunmayan parametre: argümanı yan etkisizse (literal ya da js-confuser durum dizisi) bildirilmez
    const decls = [];
    m.params.forEach((x, i) => {
      const name = t.isAssignmentPattern(x) ? x.left.name : x.name;
      const arg = args[i] ?? (t.isAssignmentPattern(x) ? x.right : undefined);
      if (!mPath.scope.getBinding(name)?.referenced && (!arg || pureArg(arg, call))) return;
      decls.push(t.variableDeclarator(t.identifier(name), arg ?? t.unaryExpression('void', t.numericLiteral(0))));
    });
    const inlined = [...(decls.length ? [t.variableDeclaration('var', decls)] : []), ...m.body.body];
    mPath.remove();
    // yol API'si: aynı gövdedeki diğer bildirim yollarının konumları güncel kalsın
    if (single) shell.node.body.body = inlined;
    else ret.replaceWithMultiple(inlined);
    n++;
  }
  return n;
}

// 2) kapsam nesnelerini yerel değişkenlere böl
// Fonksiyon ifadesinin çağrı yerleri: var V; V = function (...R) {…}; … V(x) / (1, V)(x)  → çağrı düğümleri (yoksa null)
function callSitesOfAssignedFn(fnPath) {
  const asg = fnPath.parentPath;
  if (!asg.isAssignmentExpression({ operator: '=', right: fnPath.node }) || !t.isIdentifier(asg.node.left)) return null;
  const vb = asg.scope.getBinding(asg.node.left.name);
  if (!vb || vb.constantViolations.length !== 1 || vb.constantViolations[0] !== asg || (vb.path.isVariableDeclarator() && vb.path.node.init)) return null;
  const calls = [];
  for (const r of vb.referencePaths) {
    let callee = r;
    if (r.parentPath.isSequenceExpression() && r.parentPath.node.expressions.length === 2 && r.parentPath.node.expressions[1] === r.node &&
        t.isNumericLiteral(r.parentPath.node.expressions[0])) callee = r.parentPath;
    if (!callee.parentPath.isCallExpression({ callee: callee.node })) return null;
    calls.push(callee.parentPath.node);
  }
  return calls;
}

// [a, S = { K: {} }, c] = R  (R fonksiyonun tek rest parametresi): varsayılan, o konuma argüman verilmeyince kullanılır
function destructuredDefault(binding) {
  if (binding.kind !== 'var' || binding.constantViolations.length !== 1 || binding.path.node.init) return null;
  const v = binding.constantViolations[0];
  if (!v.isAssignmentExpression({ operator: '=' }) || !t.isArrayPattern(v.node.left) || !t.isIdentifier(v.node.right)) return null;
  const idx = v.node.left.elements.findIndex((e) => t.isAssignmentPattern(e) && t.isIdentifier(e.left, { name: binding.identifier.name }));
  const el = v.node.left.elements[idx];
  if (idx < 0 || !t.isObjectExpression(el.right)) return null;
  const fn = v.getFunctionParent();
  if (!fn || fn.node.params.length !== 1 || !t.isRestElement(fn.node.params[0]) || !t.isIdentifier(fn.node.params[0].argument, { name: v.node.right.name })) return null;
  const rb = fn.scope.getBinding(v.node.right.name);
  if (!rb || rb.constantViolations.length || rb.referencePaths.length !== 1) return null;
  const calls = callSitesOfAssignedFn(fn);
  if (!calls || !calls.every((c) => c.arguments.length <= idx && !c.arguments.some((a) => t.isSpreadElement(a)))) return null;
  return el.right;
}

function rootObject(binding) {
  const p = binding.path;
  const dd = destructuredDefault(binding);
  if (dd) return dd;
  if (p.isVariableDeclarator() && t.isObjectExpression(p.node.init)) return p.node.init;
  const ap = p.isAssignmentPattern() ? p : p.parentPath.isAssignmentPattern() ? p.parentPath : null;
  if (binding.kind === 'param' && ap && t.isObjectExpression(ap.node.right)) {
    // varsayılan yalnızca argüman verilmeyince kullanılır: fonksiyon o konuma hiç argüman almamalı
    const fn = ap.parentPath;
    const idx = fn.node.params.indexOf(ap.node);
    // js-confuser makine imzası: (states, scope = {…}, runtime, args) — kapsam ikinci parametre
    if (idx !== 1 || fn.node.params.length < 3) return null;
    const fb = fn.isFunctionDeclaration() ? fn.parentPath.scope.getBinding(fn.node.id.name) : null;
    if (!fb?.constant || !fb.referencePaths.every((r) => r.parentPath.isCallExpression({ callee: r.node }) && r.parentPath.node.arguments.length <= idx &&
      !r.parentPath.node.arguments.some((a) => t.isSpreadElement(a)))) return null;
    return ap.node.right;
  }
  return null;
}

// Kapsam nesnesi biçimi: { K: {} } taze nesneler ve { L: root.K } takma adlar (yan etkisiz değerlendirme)
const scopeShaped = (obj) => t.isObjectExpression(obj) && obj.properties.length > 0 && obj.properties.every((p) => t.isObjectProperty(p) &&
  (!p.computed || t.isStringLiteral(p.key)) && ((t.isObjectExpression(p.value) && !p.value.properties.length) ||
  (t.isMemberExpression(p.value) && t.isIdentifier(p.value.object) && keyOf(p.value) !== null)));

function splitScopes(ast) {
  let n = 0;
  traverse(ast, {
    // kullanılmayan kapsam nesnesinin kalıntısı: ({ K: {}, L: root.K });  — takma ad kökü bir kapsam kökü olmalı
    // var A = root.K;  (ssa-opt'un skaler değiştirmesi takma ad nesnesini değişkene çıkarır): A yalnızca üye
    // erişimiyle kullanılıyorsa her A yerine root.K yazılır, bildirim silinir (root ve root.K hiç değişmez)
    VariableDeclarator(p) {
      const { id, init } = p.node;
      if (!t.isIdentifier(id) || !t.isMemberExpression(init) || !t.isIdentifier(init.object) || keyOf(init) === null) return;
      const rb = p.scope.getBinding(init.object.name);
      if (!rb || !(rb.constant || destructuredDefault(rb)) || !rootObject(rb)) return;
      const ab = p.scope.getBinding(id.name);
      if (!ab?.constant || !ab.referencePaths.every((r) => r.parentPath.isMemberExpression({ object: r.node }))) return;
      // A'nın kullanıldığı yerde root adı başka bir bağa gitmemeli
      if (!ab.referencePaths.every((r) => r.scope.getBinding(init.object.name) === rb)) return;
      for (const r of ab.referencePaths) r.replaceWith(t.cloneNode(init, true));
      p.remove();
      n++;
    },
    ExpressionStatement(p) {
      const e = p.node.expression;
      // root.K;  — skaler değiştirme (ssa-opt) sonrası kalan takma ad okuması: kapsam nesnesinde yan etkisiz
      if (t.isMemberExpression(e) && t.isIdentifier(e.object) && keyOf(e) !== null && Array.isArray(p.container)) {
        const b = p.scope.getBinding(e.object.name);
        if ((b?.constant || (b && destructuredDefault(b))) && rootObject(b)) { p.remove(); n++; }
        return;
      }
      if (!scopeShaped(e) || !Array.isArray(p.container)) return;
      const rootsOk = e.properties.every((x) => !t.isMemberExpression(x.value) || (() => {
        const b = p.scope.getBinding(x.value.object.name);
        return Boolean(b?.constant && rootObject(b));
      })());
      if (!rootsOk) return;
      p.remove();
      n++;
    },
    Scopable(sp) {
      for (const [name, b] of Object.entries(sp.scope.bindings)) {
        if (!b.constant && !destructuredDefault(b)) continue;
        const obj = rootObject(b);
        if (!obj || !obj.properties.length) continue;
        // hiç okunmayan kök: bildirimi (taze nesneler, takma ad okumaları) yan etkisiz
        if (!b.referencePaths.length && b.path.isVariableDeclarator() && scopeShaped(obj)) {
          const pattern = b.constantViolations[0]?.node.left;
          if (pattern && t.isArrayPattern(pattern)) {
            // [a, S = { K: {} }] = R  → [a, S] = R  (varsayılan nesne artık okunmuyor; değerlendirmesi yan etkisiz)
            const i = pattern.elements.findIndex((e) => t.isAssignmentPattern(e) && e.right === obj);
            if (i >= 0) { pattern.elements[i] = pattern.elements[i].left; n++; }
            continue;
          }
          b.path.remove();
          n++;
          continue;
        }
        const props = new Map();
        let ok = obj.properties.every((p) => {
          if (!t.isObjectProperty(p) || (p.computed && !t.isStringLiteral(p.key))) return false;
          const k = !p.computed && t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null;
          if (k === null) return false;
          if (t.isObjectExpression(p.value) && !p.value.properties.length) props.set(k, { fresh: true });
          else if (t.isMemberExpression(p.value) && t.isIdentifier(p.value.object) && keyOf(p.value) !== null) props.set(k, { alias: p.value });
          else return false;
          return true;
        });
        if (!ok) continue;
        // her kullanım root.K (K bilinen anahtar). js-confuser blok kapsamlarını bloğa girerken kurar:
        // root.L = {};  — sonradan kurulan (ya da yeniden kurulan) taze nesne de bölünür; deyim, L'nin yerel
        // değişkenlerini undefined'a çeken atamaya döner (taze nesnenin her özelliği okununca undefined'dı)
        const uses = [];
        const lazy = [];
        let unknownKey = false;
        for (const r of b.referencePaths) {
          const m = r.parentPath;
          const k = m.isMemberExpression({ object: r.node }) ? keyOf(m.node) : null;
          const asg = m.parentPath;
          if (k !== null && asg.isAssignmentExpression({ operator: '=', left: m.node }) && t.isObjectExpression(asg.node.right) &&
              !asg.node.right.properties.length && asg.parentPath.isExpressionStatement() && Array.isArray(asg.parentPath.container) &&
              (!props.has(k) || props.get(k).fresh)) {
            if (!props.has(k)) props.set(k, { fresh: true });
            lazy.push({ stmt: asg.parentPath, k });
            continue;
          }
          if (k === null) { ok = false; break; }
          // bilinmeyen anahtar (hiç çalışmayan, açılamamış makine kalıntısı): takma adlar yine çözülür, bölme yapılmaz
          if (!props.has(k)) unknownKey = true;
          uses.push({ m, k });
        }
        if (!ok || (!uses.length && !lazy.length)) continue;
        // takma adlar: root.L → kaynak ifade (kaynak kök değişmiyorsa ve kaynak özelliği yeniden atanmıyorsa)
        let aliased = 0;
        for (const u of uses) {
          const e = props.get(u.k);
          if (!e?.alias) continue;
          const src = sp.scope.getBinding(e.alias.object.name);
          if (!src?.constant) { ok = false; break; }
          const par = u.m.parentPath;
          if (par.isAssignmentExpression({ left: u.m.node }) || par.isUpdateExpression()) { ok = false; break; }
          u.m.replaceWith(t.cloneNode(e.alias, true));
          aliased++;
        }
        if (!ok) continue;
        if (aliased) {
          // takma ad özellikleri artık okunmuyor; değerleri yan etkisiz üye okuması: nesneden çıkarılır
          obj.properties = obj.properties.filter((p) => !t.isMemberExpression(p.value));
          n += aliased;
          continue; // bağlar bayat: bölme bir sonraki turda
        }
        // taze nesneler: root.K.x → x (anahtar başına: root.K değer olarak geçiyorsa — makine kopyasına
        // { K: root.K } — ya da bilinmeyen anahtarsa o anahtar yerinde kalır, diğerleri bölünür)
        const names = new Map();
        const taken = new Set();
        const fnPath = b.scope.path;
        fnPath.traverse({ Identifier(q) { taken.add(q.node.name); } });
        const fresh = (base) => {
          let v = t.isValidIdentifier(base) ? base : `v_${base.replace(/[^\w$]/g, '_')}`;
          for (let i = 2; taken.has(v) || fnPath.scope.hasBinding(v); i++) v = `${base}_${i}`;
          taken.add(v);
          return v;
        };
        const escaping = new Set();
        const cand = [];
        for (const u of uses) {
          if (!props.get(u.k)?.fresh) { escaping.add(u.k); continue; }
          const outer = u.m.parentPath;
          const k2 = outer.isMemberExpression({ object: u.m.node }) ? keyOf(outer.node) : null;
          const par = outer.parentPath;
          // Object.prototype'tan gelen ad ilk okumada undefined değildir
          if (k2 === null || k2 in Object.prototype || par.isUnaryExpression({ operator: 'delete' }) || par.isForXStatement({ left: outer.node }) ||
              par.isBinaryExpression({ operator: 'in', right: u.m.node })) { escaping.add(u.k); continue; }
          cand.push({ k: u.k, k2, outer, par });
        }
        // üye çağrısında this kapsam nesnesiydi: atanan her değer this kullanmayan fonksiyon olmalı
        const thisOk = (list) => {
          const calls = list.filter((c) => c.par.isCallExpression({ callee: c.outer.node }));
          if (!calls.length) return true;
          const writes = list.filter((c) => c.par.isAssignmentExpression({ left: c.outer.node })).map((c) => c.par.node.right);
          return writes.length > 0 && writes.every((w) => (t.isFunctionExpression(w) && !usesThisOrArguments(w)) || t.isArrowFunctionExpression(w));
        };
        const byId = new Map();
        for (const c of cand) {
          const id = `${c.k}\u0000${c.k2}`;
          if (!byId.has(id)) byId.set(id, []);
          byId.get(id).push(c);
        }
        for (const [id, list] of byId) if (!thisOk(list)) escaping.add(id.split('\u0000')[0]);
        const edits = [];
        for (const [id, list] of byId) {
          const [k, k2] = id.split('\u0000');
          if (escaping.has(k)) continue;
          const rec = { name: fresh(k2) };
          names.set(id, rec);
          for (const c of list) edits.push({ outer: c.outer, rec });
        }
        if (!edits.length && !lazy.some((l) => !escaping.has(l.k))) continue;
        for (const e of edits) e.outer.replaceWith(t.identifier(e.rec.name));
        for (const { stmt, k } of lazy.filter((l) => !escaping.has(l.k))) {
          const reset = [...names].filter(([id]) => id.startsWith(`${k}\u0000`)).map(([, r]) => r.name);
          if (!reset.length) { stmt.remove(); continue; }
          stmt.replaceWith(t.expressionStatement(reset.reduceRight((acc, nm) => t.assignmentExpression('=', t.identifier(nm), acc), t.identifier('undefined'))));
        }
        n += lazy.filter((l) => !escaping.has(l.k)).length;
        const body = fnPath.isFunction() ? fnPath.get('body') : fnPath;
        if (!body.isBlockStatement() && !body.isProgram()) continue;
        if (names.size) body.unshiftContainer('body', t.variableDeclaration('var', [...names.values()].map((r) => t.variableDeclarator(t.identifier(r.name)))));
        // kök artık kullanılmıyor: bildirim/varsayılan kalır, unused/dead-extra temizler
        n += edits.length;
      }
    },
  });
  return n;
}

// 3) Hiç okunmayan kapsam özelliğine atanmış fonksiyon (const-fold'un katladığı çağrıların artık ölü kalan
// fonksiyonu): scope.K.f = function () { … }  deyimi silinir. Kapsam nesneleri yalnızca sabit adlı üye erişimiyle
// ya da makine kopyalarına { K: scope.K } argümanıyla geçiyorsa ve f adı programın hiçbir yerinde okunmuyorsa.
function deadStores(ast) {
  let program = null;
  traverse(ast, { Program(p) { program = p; p.stop(); } });
  const isRootParam = (fnNode, idx) => {
    const prm = fnNode?.params?.[idx];
    return t.isAssignmentPattern(prm) && t.isIdentifier(prm.left) && t.isObjectExpression(prm.right);
  };
  const roots = [];
  traverse(ast, {
    Scopable(sp) {
      for (const b of Object.values(sp.scope.bindings)) {
        const p = b.path;
        const ap = p.isAssignmentPattern() ? p : p.parentPath?.isAssignmentPattern() ? p.parentPath : null;
        const obj = p.isVariableDeclarator() ? p.node.init : b.kind === 'param' && ap ? ap.node.right : null;
        if (t.isObjectExpression(obj) && obj.properties.length && obj.properties.every((x) => t.isObjectProperty(x) &&
          (t.isObjectExpression(x.value) && !x.value.properties.length || t.isMemberExpression(x.value)))) roots.push(b);
      }
    },
  });
  if (!roots.length) return 0;
  const stores = [];
  for (const b of roots) {
    for (const r of b.referencePaths) {
      const m = r.parentPath;
      if (!m.isMemberExpression({ object: r.node }) || keyOf(m.node) === null) return 0;
      const outer = m.parentPath;
      if (outer.isMemberExpression({ object: m.node })) {
        if (keyOf(outer.node) === null) return 0;
        const asg = outer.parentPath;
        if (asg.isAssignmentExpression({ left: outer.node, operator: '=' }) && asg.parentPath.isExpressionStatement() &&
            (t.isFunctionExpression(asg.node.right) || t.isArrowFunctionExpression(asg.node.right))) stores.push({ stmt: asg.parentPath, name: keyOf(outer.node) });
        continue;
      }
      // bloğa girerken kurulan kapsam: root.L = {};
      if (outer.isAssignmentExpression({ operator: '=', left: m.node }) && t.isObjectExpression(outer.node.right) &&
          !outer.node.right.properties.length && outer.parentPath.isExpressionStatement()) continue;
      // { K: root.K } yalnızca bir makinenin kapsam parametresine argüman olarak ya da başka bir kökün
      // başlangıcı olarak (kopya kabuğuna taşınınca: var S2 = { K: root.K, L: {} })
      const prop = outer;
      const objE = prop.parentPath;
      const call = objE?.parentPath;
      if (!prop.isObjectProperty({ value: m.node }) || !objE.isObjectExpression()) return 0;
      if (call?.isVariableDeclarator({ init: objE.node }) && t.isIdentifier(call.node.id) &&
          roots.includes(call.scope.getBinding(call.node.id.name))) continue;
      if (!call?.isCallExpression() || !t.isIdentifier(call.node.callee)) return 0;
      const fb = call.scope.getBinding(call.node.callee.name);
      // makine: function M(…) ya da tek kez atanan V = function (…) {…}
      const fnNode = fb?.path.isFunctionDeclaration() ? fb.path.node
        : ((fb?.path.isVariableDeclarator() && !fb.path.node.init) || (fb?.kind === 'param' && t.isIdentifier(fb.path.node))) && fb.constantViolations.length === 1 &&
          fb.constantViolations[0].isAssignmentExpression({ operator: '=' }) && t.isFunctionExpression(fb.constantViolations[0].node.right)
          ? fb.constantViolations[0].node.right : null;
      if (!fnNode || !isRootParam(fnNode, call.node.arguments.indexOf(objE.node))) return 0;
    }
  }
  if (!stores.length) return 0;
  // Ölü küme: birbirini çağıran ama dışarıdan hiç okunmayan kapsam özelliği atamaları ve fonksiyon bildirimleri
  // (çözülen string decoder'ının makineleri). Her aday, dışarıda (başka bir canlı yerde) kullanılıyorsa canlıdır.
  const uses = new Map(); // özellik adı → okuma yolları
  const stringNames = new Set();
  traverse(ast, {
    MemberExpression(p) {
      const k = keyOf(p.node);
      if (k === null) return;
      if (p.parentPath.isAssignmentExpression({ left: p.node, operator: '=' }) && stores.some((s) => s.stmt.node.expression === p.parent)) return;
      if (!uses.has(k)) uses.set(k, []);
      uses.get(k).push(p);
    },
    StringLiteral(p) { if (!p.parentPath.isMemberExpression({ property: p.node })) stringNames.add(p.node.value); },
    'ObjectProperty|ObjectMethod|ClassMethod|ClassProperty'(p) { const k = p.node.key; if (t.isIdentifier(k)) stringNames.add(k.name); },
  });
  const cands = stores.filter((s) => !stringNames.has(s.name)).map((s) => ({ kind: 'store', path: s.stmt, body: s.stmt.get('expression.right'), refs: uses.get(s.name) ?? [] }));
  // iç içe fonksiyon bildirimleri (program düzeyi global olabilir: dokunulmaz)
  traverse(ast, {
    FunctionDeclaration(fp) {
      if (!fp.node.id || fp.parentPath.isProgram()) return;
      const b = fp.parentPath.scope.getBinding(fp.node.id.name);
      if (!b || b.constantViolations.some((v) => v.node !== fp.node)) return;
      cands.push({ kind: 'fn', path: fp, body: fp, refs: b.referencePaths });
    },
  });
  const dead = new Set(cands);
  const insideDead = (r) => [...dead].some((c) => r === c.body || r.findParent((x) => x === c.body));
  for (let changed = true; changed;) {
    changed = false;
    for (const c of [...dead]) {
      if (c.refs.some((r) => !insideDead(r))) { dead.delete(c); changed = true; }
    }
  }
  let n = 0;
  for (const c of dead) {
    if (!c.path.node) continue;
    // yalnızca kapsam özelliği ataması içeren kümeler silinir; düz fonksiyon kümeleri unused'a kalır
    if (c.kind === 'fn' && ![...dead].some((x) => x.kind === 'store')) continue;
    c.path.remove();
    n++;
  }
  return n;
}

// 4) Giriş makinesinin kullanılmayan parametreleri (states, scope = {…}, runtime, arg) ve yan etkisiz durum
// dizisi argümanı; (1, f)(x) → f(x) (tanımlayıcıyla çağrıda this zaten undefined).
// Parametreler yalnızca fonksiyon hiç değer olarak kullanılmıyorsa (length gözlenemez) kaldırılır.
function tidyEntries(ast) {
  let n = 0;
  let program = null;
  traverse(ast, { Program(p) { program = p; p.stop(); } });
  traverse(ast, {
    CallExpression(p) {
      const c = p.node.callee;
      if (t.isSequenceExpression(c) && c.expressions.length === 2 && t.isNumericLiteral(c.expressions[0]) && t.isIdentifier(c.expressions[1])) {
        p.node.callee = c.expressions[1];
        n++;
      }
    },
    // f = function (...R) { var a, b; [a, b] = R; … }  a, b hiç okunmuyor ve her çağrının argümanları yan etkisiz
    //   → parametresiz, argümansız (R yalnızca o atamada kullanılır)
    FunctionExpression(fp) {
      const { node } = fp;
      if (node.params.length !== 1 || !t.isRestElement(node.params[0]) || !t.isIdentifier(node.params[0].argument)) return;
      const rb = fp.scope.getBinding(node.params[0].argument.name);
      if (!rb || rb.constantViolations.length || rb.referencePaths.length !== 1) return;
      const asg = rb.referencePaths[0].parentPath;
      if (!asg.isAssignmentExpression({ operator: '=' }) || !t.isArrayPattern(asg.node.left) || !asg.parentPath.isExpressionStatement() ||
          asg.parentPath.parentPath.node !== node.body) return;
      const els = asg.node.left.elements;
      if (!els.every((e) => e === null || (t.isIdentifier(e) && !fp.scope.getBinding(e.name)?.referenced))) return;
      const calls = callSitesOfAssignedFn(fp);
      if (!calls || !calls.every((c) => c.arguments.every((a) => !t.isSpreadElement(a) && pureArg(a, fp.parentPath)))) return;
      asg.parentPath.remove();
      node.params = [];
      for (const c of calls) c.arguments = [];
      n++;
    },
    FunctionDeclaration(fp) {
      const { node } = fp;
      if (!node.params.length || node.params.some((x) => !(t.isIdentifier(x) || (t.isAssignmentPattern(x) && t.isIdentifier(x.left))))) return;
      const names = node.params.map((x) => (t.isIdentifier(x) ? x.name : x.left.name));
      if (names.some((nm) => fp.scope.getBinding(nm)?.referenced)) return;
      if (node.params.some((x) => t.isAssignmentPattern(x) && !pureArg(x.right, fp))) return;
      if (usesThisOrArguments(node)) return;
      const b = fp.parentPath.scope.getBinding(node.id.name);
      if (!b?.constant || !b.referencePaths.length) return;
      const calls = b.referencePaths.map((r) => r.parentPath);
      if (!calls.every((c, i) => c.isCallExpression({ callee: b.referencePaths[i].node }) && c.node.arguments.every((a) => !t.isSpreadElement(a) && pureArg(a, c)))) return;
      node.params = [];
      for (const c of calls) c.node.arguments = [];
      n++;
    },
  });
  return n;
}

// 5) Tek atamalı değişken (js-confuser movedDeclarations: var a, b; … a = false;): atama kapsamın gövdesinde
// düz bir deyimse, aynı gövdede ondan SONRAKİ deyimlerdeki (iç fonksiyonlar hariç) okumalar literal olur.
// Başka yazma yok; okuma atamadan sonra sırayla çalışır.
function propagateOnce(ast, level) {
  let n = 0;
  traverse(ast, {
    Scopable(sp) {
      // program değişkeni globaldir (window.x ile de yazılabilir): yalnızca seviye 4
      if (sp.isProgram() && level < 4) return;
      const body = sp.isProgram() ? sp.get('body') : sp.isFunction() && sp.get('body').isBlockStatement() ? sp.get('body.body') : null;
      if (!body) return;
      for (const b of Object.values(sp.scope.bindings)) {
        if (b.kind !== 'var' || b.path.node.init || b.constantViolations.length !== 1) continue;
        const v = b.constantViolations[0];
        const stmt = v.parentPath;
        if (!v.isAssignmentExpression({ operator: '=' }) || !stmt.isExpressionStatement()) continue;
        const i = body.indexOf(body.find((s) => s.node === stmt.node));
        if (i < 0) continue;
        const r = v.node.right;
        const lit = literalValue(r);
        if (!lit.ok || (t.isIdentifier(r) && sp.scope.getBinding(r.name))) continue;
        const fn = sp.isProgram() ? null : sp;
        for (const ref of b.referencePaths) {
          if (ref.getFunctionParent() !== fn) continue;
          const top = ref.findParent((x) => x.parentPath?.node === (sp.isProgram() ? sp.node : sp.node.body));
          const j = top ? body.findIndex((s) => s.node === top.node) : -1;
          if (j <= i) continue;
          // döngü içindeki okuma da atamadan sonradır (atama döngü dışında, önce)
          ref.replaceWith(t.cloneNode(r, true));
          n++;
        }
      }
    },
  });
  return n;
}

// 5) Dönüş bayrağı: makine açılınca dış fonksiyonun sonunda kalan protokol
//      F = undefined; V = inner(); if (F) { return V; }
//      function inner() { …; F = true; return X; … }
//    inner'ın her değerli dönüşü hemen önünde F = true kurar; bayraksız dönüşler değersizdir (dış fonksiyon da
//    undefined döner), sona düşmek dışarıda da sona düşmektir. Bu durumda inner'ın gövdesi (bayrak atamaları
//    silinmiş) dış gövdenin sonuna yerleşir; çakışan iç adlar yeniden adlandırılır.
const isUndef = (n) => t.isIdentifier(n, { name: 'undefined' }) || (t.isUnaryExpression(n, { operator: 'void' }) && t.isNumericLiteral(n.argument));

function returnFlags(ast) {
  let n = 0;
  const all = new Set();
  traverse(ast, { Identifier(q) { all.add(q.node.name); } });
  traverse(ast, {
    Function(fp) {
      if (!t.isBlockStatement(fp.node.body)) return;
      let body = fp.get('body.body');
      // sondaki çıplak return; (fonksiyonun sonundan düşmekle aynı) protokolden sonra kalabilir
      const bare = body.length && body[body.length - 1].isReturnStatement() && !body[body.length - 1].node.argument ? body[body.length - 1] : null;
      if (bare) body = body.slice(0, -1);
      if (body.length < 4) return;
      const [s0, s1, s2] = body.slice(-3);
      const e0 = s0.isExpressionStatement() ? s0.node.expression : null;
      if (!t.isAssignmentExpression(e0, { operator: '=' }) || !t.isIdentifier(e0.left) || !isUndef(e0.right)) return;
      const e1 = s1.isExpressionStatement() ? s1.node.expression : null;
      if (!t.isAssignmentExpression(e1, { operator: '=' }) || !t.isIdentifier(e1.left) || !t.isCallExpression(e1.right) ||
          !t.isIdentifier(e1.right.callee)) return;
      const F = e0.left.name;
      const V = e1.left.name;
      if (F === V) return;
      // if (F) { return V; }  ya da (cfg-opt sonrası) return F ? V : undefined;
      const ternary = !bare && s2.isReturnStatement() && t.isConditionalExpression(s2.node.argument) &&
        t.isIdentifier(s2.node.argument.test, { name: F }) && t.isIdentifier(s2.node.argument.consequent, { name: V }) && isUndef(s2.node.argument.alternate);
      if (!ternary) {
        if (!s2.isIfStatement() || s2.node.alternate || !t.isIdentifier(s2.node.test, { name: F })) return;
        const cons = t.isBlockStatement(s2.node.consequent) ? s2.node.consequent.body : [s2.node.consequent];
        if (cons.length !== 1 || !t.isReturnStatement(cons[0]) || !t.isIdentifier(cons[0].argument, { name: V })) return;
      }
      // inner: aynı gövdede fonksiyon bildirimi ya da tek kez atanan fonksiyon ifadesi (P = function (…) {…};
      // P başlangıçsız yerel ya da hiç verilmeyen parametre — açılmış makine kopyası)
      const ib = fp.scope.getBinding(e1.right.callee.name);
      let inner = null;
      let anchor = null;
      if (ib?.constant && ib.path.isFunctionDeclaration()) {
        inner = ib.path;
        anchor = ib.path;
      } else if (ib?.constantViolations.length === 1) {
        const v = ib.constantViolations[0];
        if (v.isAssignmentExpression({ operator: '=' }) && v.get('right').isFunctionExpression() && !v.node.right.id && v.parentPath.isExpressionStatement() &&
            ((ib.path.isVariableDeclarator() && !ib.path.node.init) || (ib.kind === 'param' && t.isIdentifier(ib.path.node)))) {
          inner = v.get('right');
          anchor = v.parentPath;
        }
      }
      if (!inner || ib.referencePaths.length !== 1 || anchor.parentPath.parentPath !== fp || anchor.key > s1.key) return;
      if (inner.node.async || inner.node.generator || usesThisOrArguments(inner.node)) return;
      // parametreler: çağrıdaki yan etkisiz argümanlar (verilmeyen varsayılanlı parametre varsayılanını alır)
      const callArgs = e1.right.arguments;
      if (callArgs.length > inner.node.params.length || callArgs.some((a) => t.isSpreadElement(a) || !pureArg(a, s1))) return;
      if (!inner.node.params.every((x, i) => t.isIdentifier(x) || (t.isAssignmentPattern(x) && t.isIdentifier(x.left) && t.isObjectExpression(x.right) &&
        (i >= callArgs.length || t.isObjectExpression(callArgs[i]) || t.isArrayExpression(callArgs[i]))))) return;
      const fb = fp.scope.getBinding(F);
      const vb = fp.scope.getBinding(V);
      if (fb?.scope !== fp.scope || vb?.scope !== fp.scope || fb.referencePaths.length !== 1 || vb.referencePaths.length !== 1 ||
          vb.constantViolations.length !== 1) return;
      // F'nin diğer tüm yazımları inner'ın kendi gövdesinde "F = true;" deyimi ve hemen ardından değerli return
      const flagStmts = [];
      for (const v of fb.constantViolations) {
        if (v.node === e0) continue;
        const st = v.parentPath;
        if (!v.isAssignmentExpression({ operator: '=' }) || !t.isBooleanLiteral(v.node.right, { value: true }) || !st.isExpressionStatement() ||
            st.getFunctionParent() !== inner || !Array.isArray(st.container)) return;
        const next = st.container[st.key + 1];
        if (!t.isReturnStatement(next) || !next.argument) return;
        flagStmts.push(st);
      }
      let ok = true;
      inner.traverse({
        Function(q) { q.skip(); },
        TryStatement(q) { if (q.node.finalizer) { ok = false; q.stop(); } },
        ReturnStatement(q) {
          const list = q.container;
          const prev = Array.isArray(list) && q.key > 0 ? list[q.key - 1] : null;
          const flagged = t.isExpressionStatement(prev) && flagStmts.some((s) => s.node === prev);
          if (!flagged && q.node.argument && !isUndef(q.node.argument)) { ok = false; q.stop(); }
        },
      });
      if (!ok) return;
      // iç adlar dış gövdede (inner dışında) geçiyorsa yeniden adlandırılır: inline sonrası var/function yükseltmesi
      const outside = new Set();
      fp.traverse({
        Identifier(q) { if (!q.findParent((x) => x === inner)) outside.add(q.node.name); },
      });
      for (const name of Object.keys(inner.scope.bindings)) {
        if (!outside.has(name)) continue;
        let fresh = `${name}_${2}`;
        for (let i = 3; all.has(fresh); i++) fresh = `${name}_${i}`;
        all.add(fresh);
        inner.scope.rename(name, fresh);
      }
      for (const st of flagStmts) st.remove();
      // okunmayan parametre bildirilmez (argümanlar yan etkisiz: durum dizisi, kapsam nesnesi)
      const paramDecls = inner.node.params.filter((x) => inner.scope.getBinding(t.isAssignmentPattern(x) ? x.left.name : x.name)?.referenced)
        .map((x) => t.variableDeclarator(t.identifier(t.isAssignmentPattern(x) ? x.left.name : x.name),
          callArgs[inner.node.params.indexOf(x)] ?? (t.isAssignmentPattern(x) ? x.right : null)));
      const moved = [...(paramDecls.length ? [t.variableDeclaration('var', paramDecls)] : []), ...inner.node.body.body];
      bare?.remove();
      s2.remove();
      s1.remove();
      s0.remove();
      anchor.remove();
      fp.get('body').pushContainer('body', moved);
      fp.scope.crawl();
      n++;
    },
  });
  return n;
}

export async function run(ast, { onLog, bump, level = 3 }) {
  // eval/with adları dinamik okur: kapsam ve parametre dönüşümleri kanıtlanamaz
  let dynamic = false;
  traverse(ast, {
    WithStatement(p) { dynamic = true; p.stop(); },
    CallExpression(p) { if (t.isIdentifier(p.node.callee, { name: 'eval' }) && !p.scope.getBinding('eval')) { dynamic = true; p.stop(); } },
  });
  if (dynamic) return;
  const a = inlineClones(ast);
  if (a) {
    onLog(`cff-scope: ${a} makine kopyası kabuğuna taşındı`, 'info');
    bump('cffScope', a);
    return; // bağlar değişti: bölme bir sonraki turda taze ağaçla
  }
  const d = deadStores(ast);
  if (d) onLog(`cff-scope: ${d} okunmayan kapsam özelliği ataması silindi`, 'info');
  const s = d ? 0 : splitScopes(ast);
  if (s) onLog(`cff-scope: kapsam nesnesi erişimleri yerel değişkenlere çevrildi (${s})`, 'info');
  const o = s || d ? 0 : propagateOnce(ast, level);
  if (o) onLog(`cff-scope: tek atamalı ${o} okuma literal yapıldı`, "info");
  const e = s || d || o ? 0 : tidyEntries(ast);
  if (e) onLog(`cff-scope: ${e} giriş/çağrı sadeleştirildi`, 'info');
  const r = s || d || o || e ? 0 : returnFlags(ast);
  if (r) onLog(`cff-scope: ${r} dönüş bayrağı protokolü dış fonksiyona açıldı`, 'info');
  bump("cffScope", s + d + e + o + r);
}
