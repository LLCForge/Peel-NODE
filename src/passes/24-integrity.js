import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';

// A-11 / E206: bütünlük (hash) kontrollerini etkisizleştirme.
//   function add() { var h = add.p || (add.p = hash(impl, 2432744)); if (h === 803393648862986) { return impl(...arguments); } else { while (true) {} } }
// Hash fonksiyonu korunan fonksiyonun kaynağını (toString) özetler; çözme sırasında kaynak değişince kontrol
// tutmaz ve program kilitlenir. Testin orijinal programdaki sonucu değerlendirme bağlamında (orijinal kaynakla)
// hesaplanır; if, o sonuçta seçilen dalla değiştirilir. Böylece davranış orijinalle birebir aynı kalır ve
// sonraki pass'ler korunan fonksiyonu güvenle değiştirebilir. Bu pass ilk AST pass'i olmalı.
// Ayrıca js-confuser lock.selfDefending: (function () { var f = function () { if (new RegExp("\n").test(f)) while (true) {} }; return f(); })();
// Sıkıştırılmış özgün kodda fonksiyon metninde satır sonu yoktur, test hiç tutmaz; çözülmüş (biçimlenmiş) kodda
// sonsuz döngüye girer. Deyim kaldırılır: özgün çalışmayla aynı (etkisiz) sonuç. Sandbox gerekmez.

const MAX_GUARD_SRC = 1500;

const isInfiniteEmptyLoop = (n) => (t.isWhileStatement(n) && t.isBooleanLiteral(n.test, { value: true }) ||
  t.isForStatement(n) && !n.test) && (t.isEmptyStatement(n.body) || (t.isBlockStatement(n.body) && !n.body.body.length));

function isSelfDefendingIife(stmt) {
  if (!t.isExpressionStatement(stmt)) return false;
  let e = stmt.expression;
  if (t.isUnaryExpression(e)) e = e.argument;
  if (!t.isCallExpression(e) || e.arguments.length || !t.isFunctionExpression(e.callee)) return false;
  // başında başka kilit deyimleri (lock.startDate vb.) olabilir: yalnızca son iki deyim koruma kalıbıdır
  const body = e.callee.body.body.slice(-2);
  if (body.length !== 2 || !t.isVariableDeclaration(body[0]) || !t.isReturnStatement(body[1])) return false;
  const [decl] = body[0].declarations;
  if (body[0].declarations.length !== 1 || !t.isIdentifier(decl.id) || !t.isFunctionExpression(decl.init)) return false;
  const ret = body[1].argument;
  if (!t.isCallExpression(ret) || !t.isIdentifier(ret.callee, { name: decl.id.name }) || ret.arguments.length) return false;
  const src = gen(e.callee);
  if (src.length > MAX_GUARD_SRC) return false;
  let newline = false;
  let loop = false;
  t.traverseFast(decl.init, (n) => {
    if (t.isStringLiteral(n, { value: '\n' }) || (t.isRegExpLiteral(n) && n.pattern === '\\n')) newline = true;
    if (isInfiniteEmptyLoop(n)) loop = true;
  });
  return newline && loop && /test/.test(src);
}

// integrity özgün fonksiyonu G'ye taşıyıp kabuğu function F() { return G(...arguments); } bırakır.
// G yalnızca buradan çağrılıyor, aynı kapsamda ve this/arguments/new.target/super kullanmıyorsa F'nin
// parametreleri ve gövdesi G'ninki olur. (F.length 0'dı, G'nin parametre sayısı olur.)
function collapseForwarder(fPath) {
  const { node } = fPath;
  if (node.params.length || node.body.body.length !== 1) return;
  const ret = node.body.body[0];
  const call = ret.argument;
  if (!t.isReturnStatement(ret) || !t.isCallExpression(call) || !t.isIdentifier(call.callee) || call.arguments.length !== 1 ||
      !t.isSpreadElement(call.arguments[0]) || !t.isIdentifier(call.arguments[0].argument, { name: 'arguments' })) return;
  // gövde az önce değişti: özet çağrısındaki G referansı bağlardan düşsün
  fPath.scope.getProgramParent().crawl();
  const gb = fPath.scope.getBinding(call.callee.name);
  if (!gb?.constant || !gb.path.isFunctionDeclaration() || gb.referencePaths.length !== 1) return;
  const g = gb.path;
  if (g.node.async !== node.async || g.node.generator !== node.generator || g.scope.parent !== fPath.scope.parent) return;
  let bad = false;
  g.traverse({
    ThisExpression(q) { if (q.findParent((x) => x.isFunction() && !x.isArrowFunctionExpression()) === g) bad = true; },
    Super() { bad = true; },
    MetaProperty() { bad = true; },
    Identifier(q) {
      if (q.isReferencedIdentifier()) {
        if (q.node.name === 'arguments' && q.findParent((x) => x.isFunction() && !x.isArrowFunctionExpression()) === g) bad = true;
        if (q.node.name === g.node.id.name && q.scope.getBinding(q.node.name) === gb) bad = true;
      }
    },
  });
  if (bad) return;
  node.params = g.node.params;
  node.body = g.node.body;
  g.remove();
}

// Gövdesinde parametresinin toString'ini çağıran (kaynağı okuyan) fonksiyon adları
function sourceHashers(ast) {
  const names = new Set();
  traverse(ast, {
    Function(p) {
      const id = p.node.id ?? (p.parentPath.isVariableDeclarator() && t.isIdentifier(p.parent.id) ? p.parent.id : null);
      if (!id) return;
      const params = new Set(p.node.params.map((x) => (t.isAssignmentPattern(x) ? x.left : x)).filter((x) => t.isIdentifier(x)).map((x) => x.name));
      let reads = false;
      p.traverse({
        MemberExpression(q) {
          const prop = q.node.computed ? (t.isStringLiteral(q.node.property) ? q.node.property.value : null) : q.node.property.name;
          if (prop === 'toString' && t.isIdentifier(q.node.object) && params.has(q.node.object.name)) { reads = true; q.stop(); }
        },
      });
      if (reads) names.add(id.name);
    },
  });
  return names;
}

// İfade içinde bir hash çağrısı: hash(fn, ...) — ilk argüman bir fonksiyon adı
function hashCall(node, hashers) {
  let found = null;
  t.traverseFast(node, (n) => {
    if (!found && t.isCallExpression(n) && t.isIdentifier(n.callee) && hashers.has(n.callee.name) &&
        n.arguments.length >= 1 && t.isIdentifier(n.arguments[0]) && n.arguments.every((a) => t.isIdentifier(a) || t.isLiteral(a))) found = n;
  });
  return found;
}

const isConst = (n) => t.isNumericLiteral(n) || t.isStringLiteral(n);

export function findIntegrityChecks(ast) {
  const hashers = sourceHashers(ast);
  if (!hashers.size) return [];
  const checks = [];
  traverse(ast, {
    IfStatement(p) {
      const test = p.node.test;
      if (!t.isBinaryExpression(test) || !['===', '!==', '==', '!='].includes(test.operator)) return;
      const [side, other] = isConst(test.right) ? [test.left, test.right] : [test.right, test.left];
      if (!isConst(other)) return;
      let call = null;
      let holder = null;
      if (t.isCallExpression(side)) call = hashCall(side, hashers);
      else if (t.isIdentifier(side)) {
        const b = p.scope.getBinding(side.name);
        if (b?.constant && b.path.isVariableDeclarator() && b.path.node.init && b.references === 1) {
          call = hashCall(b.path.node.init, hashers);
          holder = b.path;
        }
      }
      if (!call) return;
      const fn = p.getFunctionParent();
      checks.push({
        path: p, call, holder, operator: test.operator, expected: other.value,
        protects: call.arguments[0].name, inFunction: fn?.node.id?.name ?? null, hasher: call.callee.name,
      });
    },
  });
  return checks;
}

export async function run(ast, { onLog, bump, sandbox, ctx }) {
  let guards = 0;
  traverse(ast, {
    ExpressionStatement(p) {
      if (!isSelfDefendingIife(p.node)) return;
      // IIFE deyimdir, dönüş değeri kullanılmaz: koruma kalıbı (son iki deyim) çıkarılır, önceki deyimler kalır
      const fnBody = (t.isUnaryExpression(p.node.expression) ? p.node.expression.argument : p.node.expression).callee.body.body;
      fnBody.splice(-2, 2);
      if (!fnBody.length) { if (Array.isArray(p.container)) p.remove(); else p.replaceWith(t.emptyStatement()); }
      guards++;
    },
  });
  if (guards) onLog(`integrity: ${guards} js-confuser selfDefending denetimi kaldırıldı`, 'info');
  bump('integrity', guards);
  if (!ctx) return;
  const checks = findIntegrityChecks(ast);
  if (!checks.length) return;
  const r = await sandbox.batchIn(ctx, checks.map((c) => gen(c.call)));
  if (!r.ok) return;
  let n = 0;
  const shells = [];
  checks.forEach((c, i) => {
    const v = r.results[i];
    if (!v?.ok || v.opaque || (v.type !== 'number' && v.type !== 'string')) return;
    // eslint-disable-next-line eqeqeq
    const eq = c.operator.length === 3 ? v.value === c.expected : v.value == c.expected;
    const pass = c.operator.startsWith('=') ? eq : !eq;
    const owner = c.path.getFunctionParent();
    const branch = pass ? c.path.node.consequent : c.path.node.alternate;
    const stmts = !branch ? [] : t.isBlockStatement(branch) ? branch.body : [branch];
    if (stmts.some((s) => t.isFunctionDeclaration(s) || (t.isVariableDeclaration(s) && s.kind !== 'var') || t.isClassDeclaration(s))) {
      c.path.replaceWith(t.blockStatement(stmts));
    } else if (Array.isArray(c.path.container)) {
      if (stmts.length) c.path.replaceWithMultiple(stmts); else c.path.remove();
    } else {
      c.path.replaceWith(t.blockStatement(stmts));
    }
    if (c.holder?.node) c.holder.remove();
    if (owner?.isFunctionDeclaration()) shells.push(owner);
    n++;
    onLog(`integrity: ${c.inFunction ?? 'program'} içindeki ${c.hasher}(${c.protects}) bütünlük kontrolü etkisizleştirildi (orijinalde ${pass ? 'geçiyor' : 'tutmuyor'})`, 'info');
  });
  for (const sp of shells) if (sp.node) collapseForwarder(sp);
  bump('integrity', n);
  bump('dead.integrity', n);
}
