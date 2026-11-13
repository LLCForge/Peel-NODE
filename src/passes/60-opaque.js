import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { literalValue } from '../util/pure.js';

const COMPARE = new Set(['===', '!==', '==', '!=', '<', '>', '<=', '>=']);

// Referans bir koşul testinin içinde mi? (if/?:/while/for testine kadar mantıksal/karşılaştırma zinciri)
function inTestPosition(ref) {
  let cur = ref;
  for (;;) {
    const parent = cur.parentPath;
    if (!parent) return false;
    if ((parent.isIfStatement() || parent.isConditionalExpression() || parent.isWhileStatement() ||
         parent.isDoWhileStatement() || parent.isForStatement()) && parent.node.test === cur.node) return true;
    if (parent.isLogicalExpression() || parent.isUnaryExpression({ operator: '!' }) ||
        (parent.isBinaryExpression() && COMPARE.has(parent.node.operator))) {
      cur = parent;
      continue;
    }
    return false;
  }
}

// Bildirim, kullanımlardan önce koşulsuz çalışıyor mu? (aynı fonksiyon gövdesinin üst seviyesi + kaynakta önce)
function declaredBefore(declPath, refs) {
  const stmt = declPath.parentPath;
  const owner = stmt.parentPath;
  if (!(owner.isProgram() || (owner.isBlockStatement() && owner.parentPath.isFunction()))) return false;
  const fn = declPath.getFunctionParent();
  return refs.every((r) => r.node.start > stmt.node.end && r.getFunctionParent() === fn);
}

// var _0xa = 1; if (_0xa === 1) ...  →  if (1 === 1) ...  (const-fold ve dead-code gerisini halleder)
export async function run(ast, { onLog, bump }) {
  let n = 0;
  traverse(ast, {
    VariableDeclarator(p) {
      const { id, init } = p.node;
      if (!t.isIdentifier(id) || !init || !literalValue(init).ok) return;
      const b = p.scope.getBinding(id.name);
      if (!b?.constant || !b.referencePaths.length || b.referencePaths.length > 200) return;
      if (!b.referencePaths.every(inTestPosition)) return;
      if (!declaredBefore(p, b.referencePaths)) return;
      for (const ref of b.referencePaths) ref.replaceWith(t.cloneNode(init, true));
      n += b.referencePaths.length;
      p.remove();
    },
  });
  if (n) onLog(`opaque: ${n} sabit test içine taşındı`, 'info');
  bump('opaque', n);
}
