import * as t from '@babel/types';
import { traverse } from '../util/ast.js';

// switch (P + Q + R) → __peelS = P + Q + R; switch (__peelS)
// Atama switch'ten hemen önce yapıldığı için ifade, orijinaldeki ile aynı anda ve aynı kapsamda
// (with dahil) hesaplanır: semantik birebir korunur. Amaç VM pass'ine tek bir durum değişkeni vermek.
// Sayaç aritmetiği (madde 29, E180): toplama dışında çıkarma, XOR, çarpım, bit işlemleri ve kaydırma;
// sayaçlar yerel değişken ya da nesne alanı (s.a) olabilir.

const OPS = new Set(['+', '-', '*', '^', '|', '&', '<<', '>>', '>>>', '%']);

const pathOf = (n) => {
  if (t.isIdentifier(n)) return n.name;
  if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
    const b = pathOf(n.object);
    return b && `${b}.${n.property.name}`;
  }
  return null;
};

// Sayaç adları: tanımlayıcı/üye zinciri ve sayısal literal'lerden, yukarıdaki işleçlerle kurulan ifade
function counterNames(node, out = []) {
  if (t.isNumericLiteral(node)) return out;
  if (t.isParenthesizedExpression(node)) return counterNames(node.expression, out);
  if (t.isUnaryExpression(node) && ['-', '~'].includes(node.operator)) return counterNames(node.argument, out);
  const p = pathOf(node);
  if (p) { out.push(p); return out; }
  if (t.isBinaryExpression(node) && OPS.has(node.operator)) {
    return counterNames(node.left, out) && counterNames(node.right, out);
  }
  return null;
}

function mutatesAny(switchPath, names) {
  let hit = false;
  switchPath.traverse({
    AssignmentExpression(p) {
      if (names.includes(pathOf(p.node.left))) { hit = true; p.stop(); }
    },
    UpdateExpression(p) {
      if (names.includes(pathOf(p.node.argument))) { hit = true; p.stop(); }
    },
  });
  return hit;
}

export async function run(ast, { onLog, bump }) {
  let n = 0;
  let seq = 0;
  traverse(ast, {
    SwitchStatement(p) {
      const d = p.node.discriminant;
      if (!t.isBinaryExpression(d) || !OPS.has(d.operator)) return;
      const names = counterNames(d);
      if (!names || !names.length) return;
      // tek sayaçlı toplamayı (P + 1) ayrıca değişkene almaya gerek yok; diğer işleçler ve çok sayaç alınır
      if (new Set(names).size < 2 && d.operator === '+') return;
      if (!p.findParent((x) => x.isLoop())) return;
      if (!mutatesAny(p, names)) return;

      let name;
      do { name = `__peelS${seq++ || ''}`; } while (p.scope.hasBinding(name) || p.scope.hasGlobal(name));
      (p.scope.getFunctionParent() ?? p.scope.getProgramParent()).push({ id: t.identifier(name) });

      const assign = t.expressionStatement(t.assignmentExpression('=', t.identifier(name), d));
      p.node.discriminant = t.identifier(name);

      let target = p;
      while (target.parentPath.isLabeledStatement()) target = target.parentPath;
      if (Array.isArray(target.container)) target.insertBefore(assign);
      else target.replaceWith(t.blockStatement([assign, target.node]));
      n++;
    },
  });
  if (n) onLog(`state-var: ${n} durum ifadesi tek değişkene alındı`, 'info');
  bump('stateVar', n);
}
