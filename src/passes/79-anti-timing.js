import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';

// Zamanlama tabanlı anti-debug nötralizasyonu (madde 44).
//
//   var t0 = Date.now(); … if (Date.now() - t0 > 100) { debugger; while (true) {} }
//
// Ölçüm, kod adım adım izlenirken (debugger açıkken) uzar; normal çalıştırmada koşul yanlıştır. Gövdesi yalnızca
// anti-debug eylemlerinden (debugger, sonsuz döngü, throw, sayfa yenileme/yönlendirme/kapatma) oluşan böyle bir
// kontrol kaldırılır; else dalı varsa yerine o konur (normal yol). Deep doğrulama çıktının aynı kaldığını denetler.
// E203: ölçüm (var t0 = CLOCK) testten hemen önceyse ve arada yalnızca debugger/boş deyim varsa normal çalışmada geçen
// süre ~0'dır: eşik (≥ 20 ms) aşılamaz, gövde ne olursa olsun normal dal kalır. Yalnızca kaldırılan testlerde okunan
// saat değişkenlerinin bildirimleri de silinir (saat okuması yan etkisiz).

const CLOCK = (n) =>
  (t.isCallExpression(n) && t.isMemberExpression(n.callee) && !n.callee.computed &&
    ((t.isIdentifier(n.callee.object, { name: 'Date' }) && t.isIdentifier(n.callee.property, { name: 'now' })) ||
     (t.isIdentifier(n.callee.object, { name: 'performance' }) && t.isIdentifier(n.callee.property, { name: 'now' })) ||
     (t.isNewExpression(n.callee.object) && t.isIdentifier(n.callee.object.callee, { name: 'Date' }) && t.isIdentifier(n.callee.property, { name: 'getTime' })))) ||
  (t.isNewExpression(n) && t.isIdentifier(n.callee, { name: 'Date' }) && !n.arguments.length) ||
  (t.isUnaryExpression(n, { operator: '+' }) && t.isNewExpression(n.argument) && t.isIdentifier(n.argument.callee, { name: 'Date' }));

// a - b: ikisi de saat okuması ya da saat okumasıyla başlatılmış değişken
function isElapsed(n, clockVars) {
  if (!t.isBinaryExpression(n, { operator: '-' })) return false;
  const side = (x) => CLOCK(x) || (t.isIdentifier(x) && clockVars.has(x.name));
  return side(n.left) && side(n.right);
}

function timingTest(test, clockVars) {
  if (!t.isBinaryExpression(test) || !['>', '>=', '<', '<='].includes(test.operator)) return false;
  const big = ['>', '>='].includes(test.operator);
  const [elapsed, limit] = big ? [test.left, test.right] : [test.right, test.left];
  return isElapsed(elapsed, clockVars) && t.isNumericLiteral(limit);
}

// Gövde yalnızca anti-debug eylemleri mi?
function onlyAntiDebug(node) {
  const list = t.isBlockStatement(node) ? node.body : [node];
  if (!list.length) return false;
  return list.every((s) => {
    if (t.isDebuggerStatement(s) || t.isThrowStatement(s)) return true;
    if ((t.isWhileStatement(s) || t.isForStatement(s)) && (!s.test || t.isBooleanLiteral(s.test, { value: true }) ||
        (t.isUnaryExpression(s.test, { operator: '!' }) && t.isArrayExpression(s.test.argument)))) return true;
    if (t.isExpressionStatement(s)) {
      const src = gen(s.expression);
      return /^(window\.)?location\.(reload|replace|assign)\(|^(window\.)?location(\.href)?\s*=|^window\.close\(\)|^document\.(body\.)?innerHTML\s*=|^document\.write\(/.test(src);
    }
    return false;
  });
}

const asList = (s) => (!s ? [] : t.isBlockStatement(s) ? s.body : [s]);
const isLexical = (s) => t.isFunctionDeclaration(s) || t.isClassDeclaration(s) || (t.isVariableDeclaration(s) && s.kind !== 'var');
// saat okuması gölgelenmiş bir Date/performance'a gitmiyor
const realClock = (p, n) => CLOCK(n) && !p.scope.getBinding('Date') && !p.scope.getBinding('performance');

// E203: var t0 = CLOCK; [debugger;] if (CLOCK - t0 > N) …  →  normal dal (true: test doğruysa yavaş yol)
function adjacentTiming(p) {
  const test = p.node.test;
  if (!Array.isArray(p.container) || !t.isBinaryExpression(test) || !['>', '>=', '<', '<='].includes(test.operator)) return null;
  const diff = (d) => (t.isBinaryExpression(d, { operator: '-' }) && realClock(p, d.left) && t.isIdentifier(d.right) ? d.right.name : null);
  let name = diff(test.left);
  let num = test.right;
  let slow = ['>', '>='].includes(test.operator);
  if (!name) { name = diff(test.right); num = test.left; slow = ['<', '<='].includes(test.operator); }
  if (!name || !t.isNumericLiteral(num) || num.value < 20) return null;
  const b = p.scope.getBinding(name);
  if (!b?.constant || b.references !== 1 || !b.path.isVariableDeclarator() || !realClock(p, b.path.node.init)) return null;
  const decl = b.path.parentPath;
  if (decl.parentPath !== p.parentPath || decl.node.declarations.length !== 1) return null;
  const between = p.container.slice(decl.key + 1, p.key);
  if (!between.every((s) => t.isDebuggerStatement(s) || t.isEmptyStatement(s))) return null;
  return { normal: slow ? p.node.alternate : p.node.consequent };
}

export async function run(ast, { onLog, bump, findings }) {
  const clockVars = new Set();
  traverse(ast, {
    VariableDeclarator(p) {
      if (t.isIdentifier(p.node.id) && p.node.init && realClock(p, p.node.init)) clockVars.add(p.node.id.name);
    },
    AssignmentExpression(p) {
      if (t.isIdentifier(p.node.left) && realClock(p, p.node.right)) clockVars.add(p.node.left.name);
    },
  });
  let n = 0;
  traverse(ast, {
    IfStatement(p) {
      if (!p.node) return;
      let normal;
      const unshadowed = !p.scope.getBinding('Date') && !p.scope.getBinding('performance');
      if (unshadowed && timingTest(p.node.test, clockVars) && onlyAntiDebug(p.node.consequent)) normal = p.node.alternate;
      else { const e = adjacentTiming(p); if (!e) return; normal = e.normal; }
      if (findings) (findings.timing ??= []).push({ test: gen(p.node.test), action: gen(p.node.consequent).slice(0, 200), line: p.node.loc?.start.line ?? null, kept: normal ? 'normal dal' : null });
      const keep = asList(normal);
      if (!Array.isArray(p.container) || keep.some(isLexical)) p.replaceWith(t.blockStatement(keep));
      else if (keep.length) p.replaceWithMultiple(keep);
      else p.remove();
      n++;
    },
  });
  if (n) {
    // yalnızca kaldırılan testlerde okunan saat değişkenleri: artık okunmayan bildirim gereksiz
    traverse(ast, {
      Program(p) { p.scope.crawl(); },
      VariableDeclarator(p) {
        if (!t.isIdentifier(p.node.id) || !clockVars.has(p.node.id.name) || !p.node.init || !realClock(p, p.node.init)) return;
        const b = p.scope.getBinding(p.node.id.name);
        if (!b || b.referenced || b.constantViolations.length || b.path !== p) return;
        if (p.parentPath.node.declarations.length === 1 && !p.parentPath.parentPath.isFor()) p.parentPath.remove();
        else p.remove();
      },
    });
  }
  if (n) onLog(`anti-timing: ${n} zamanlama tabanlı anti-debug kontrolü kaldırıldı`, 'info');
  bump('antiTiming', n);
}
