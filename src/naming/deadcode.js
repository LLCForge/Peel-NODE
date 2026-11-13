import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { isLiteralTree } from '../util/pure.js';

// 84: ölü kodu katlanmış gösterme. Çıktıda kalan ölü bölgeler satır aralığı ve nedeniyle bulunur;
// arayüz bu aralıkları katlanmış (açılabilir) gösterir. Kod silinmez: yalnızca görünüm.

export function deadRegions(ast) {
  const regions = [];
  const add = (node, reason) => {
    const s = node.loc?.start.line;
    const e = node.loc?.end.line;
    if (s && e) regions.push({ start: s, end: e, reason });
  };
  traverse(ast, {
    // return/throw/break/continue sonrası erişilemeyen deyimler (hoist edilen fonksiyon bildirimleri hariç)
    'BlockStatement|Program|SwitchCase'(p) {
      const list = p.isSwitchCase() ? p.node.consequent : p.node.body;
      const idx = list.findIndex((s) => t.isReturnStatement(s) || t.isThrowStatement(s) || t.isBreakStatement(s) || t.isContinueStatement(s));
      if (idx < 0 || idx === list.length - 1) return;
      const rest = list.slice(idx + 1).filter((s) => !t.isFunctionDeclaration(s) && !(t.isVariableDeclaration(s, { kind: 'var' }) && s.declarations.every((d) => !d.init)));
      if (rest.length) add({ loc: { start: rest[0].loc?.start, end: rest.at(-1).loc?.end } }, 'erişilemeyen kod');
    },
    IfStatement(p) {
      const v = constTruth(p.node.test);
      if (v === true && p.node.alternate) add(p.node.alternate, 'koşul hep doğru: else dalı çalışmaz');
      if (v === false) add(p.node.consequent, 'koşul hep yanlış: dal çalışmaz');
    },
    'WhileStatement|ForStatement'(p) {
      if (p.node.test && constTruth(p.node.test) === false) add(p.node.body, 'döngü koşulu hep yanlış');
    },
    ConditionalExpression(p) {
      const v = constTruth(p.node.test);
      if (v === true) add(p.node.alternate, 'koşul hep doğru');
      if (v === false) add(p.node.consequent, 'koşul hep yanlış');
    },
    FunctionDeclaration(p) {
      const b = p.parentPath.scope.getBinding(p.node.id.name);
      if (!b || b.referenced || p.parentPath.isExportNamedDeclaration() || p.parentPath.isExportDefaultDeclaration()) return;
      // program düzeyinde global olabilir: yine de çağrılmıyorsa işaretle (başka betik çağırabilir notuyla)
      add(p.node, b.scope.path.isProgram() ? 'hiç çağrılmayan fonksiyon (başka betikten çağrılabilir)' : 'hiç çağrılmayan fonksiyon');
    },
    VariableDeclarator(p) {
      if (!t.isIdentifier(p.node.id) || !p.node.init || !isLiteralTree(p.node.init)) return;
      const b = p.scope.getBinding(p.node.id.name);
      if (!b || b.referenced || b.scope.path.isProgram()) return;
      add(p.parentPath.node, 'kullanılmayan değişken');
    },
  });
  // iç içe aralıkları birleştir: dıştaki kalır
  regions.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const r of regions) {
    const last = out.at(-1);
    if (last && r.start >= last.start && r.end <= last.end) continue;
    out.push(r);
  }
  return out;
}

function constTruth(n) {
  if (t.isBooleanLiteral(n)) return n.value;
  if (t.isNumericLiteral(n)) return n.value !== 0;
  if (t.isStringLiteral(n)) return n.value !== '';
  if (t.isNullLiteral(n)) return false;
  if (t.isUnaryExpression(n, { operator: '!' })) {
    if (t.isArrayExpression(n.argument) || t.isObjectExpression(n.argument)) return false;
    const v = constTruth(n.argument);
    return v === null ? null : !v;
  }
  if (t.isIdentifier(n, { name: 'undefined' })) return false;
  return null;
}
