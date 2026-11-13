import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { scan, renameBlocker, runsAfter } from '../naming/scope.js';

// E235: değişken birleştirme
//  1) var a; a = e;          → var a = e;          (e, a'yı okumuyorsa: let'te TDZ'ye düşmesin)
//  2) var b = a; (takma ad) → b'nin kullanımları a olur, bildirim silinir
//     a ve b hiç yeniden atanmıyor, a b'den önce kesin başlatılıyor, döngü yok, kullanımlar bildirimden sonra
const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);

export async function run(ast, { onLog, bump, naming = {} }) {
  if (naming.mergeVars === false) return;
  const info = scan(ast);
  let joined = 0;
  let aliases = 0;

  traverse(ast, {
    // 1) bildirim + hemen ardından gelen ilk atama
    VariableDeclaration(p) {
      if (p.node.kind === 'const' || !p.inList) return;
      const last = p.node.declarations.at(-1);
      if (!t.isIdentifier(last.id) || last.init) return;
      const next = p.getSibling(p.key + 1);
      if (!next.isExpressionStatement()) return;
      const e = next.node.expression;
      if (!t.isAssignmentExpression(e, { operator: '=' }) || !t.isIdentifier(e.left, { name: last.id.name })) return;
      const b = p.scope.getBinding(last.id.name);
      if (!b || next.scope.getBinding(last.id.name) !== b || renameBlocker(info, b)) return;
      let reads = false;
      next.get('expression.right').traverse({
        Identifier(q) { if (q.node.name === last.id.name && q.isReferencedIdentifier()) { reads = true; q.stop(); } },
      });
      if (reads || t.isIdentifier(e.right, { name: last.id.name })) return;
      last.init = e.right;
      next.remove();
      joined++;
    },
  });

  traverse(ast, {
    // 2) takma ad birleştirme
    VariableDeclarator(p) {
      const { id, init } = p.node;
      if (!t.isIdentifier(id) || !t.isIdentifier(init) || id.name === init.name) return;
      const decl = p.parentPath;
      if (!decl.inList || decl.parentPath.isSwitchCase()) return;
      const b = p.scope.getBinding(id.name);
      const a = p.scope.getBinding(init.name);
      if (!b || !a || b.path !== p || !b.constant || !a.constant) return;
      if (renameBlocker(info, a) || renameBlocker(info, b)) return;
      if (decl.parentPath.isExportNamedDeclaration()) return;
      const fnOf = (x) => x.getFunctionParent() ?? x.scope.getProgramParent().path;
      const bFn = fnOf(p);
      if (inLoop(p, bFn)) return;
      if (!initializedBefore(a, p, bFn, fnOf)) return;
      const container = decl.parentPath;
      for (const r of b.referencePaths) {
        if (!r.findParent((x) => x.node === container.node)) return;
        if (!runsAfter(r, p.node.end, container, info)) return;
        if (r.scope.getBinding(init.name) !== a) return;
        if (!r.isIdentifier()) return; // export { b } gibi özel referanslar
      }
      for (const r of b.referencePaths) r.replaceWith(t.identifier(init.name));
      if (decl.node.declarations.length === 1) decl.remove();
      else p.remove();
      aliases++;
    },
  });

  if (joined || aliases) onLog(`merge-vars: ${joined} bildirim+atama, ${aliases} takma ad birleşti`, 'info');
  bump('mergeVars', joined + aliases);
}

function inLoop(p, fn) {
  for (let x = p.parentPath; x && x.node !== fn.node; x = x.parentPath) if (LOOPS.has(x.type)) return true;
  return false;
}

// a, b'nin bildirimi çalıştığında kesin başlatılmış mı?
function initializedBefore(a, bPath, bFn, fnOf) {
  if (a.kind === 'param') return Boolean(bPath.findParent((x) => x.node === a.scope.path.node));
  if (a.kind === 'hoisted') {
    return (a.scope.path.isFunction() || a.scope.path.isProgram()) && Boolean(bPath.findParent((x) => x.node === a.scope.path.node));
  }
  if (!['var', 'let', 'const'].includes(a.kind) || !a.path.isVariableDeclarator()) return false;
  if (fnOf(a.path).node !== bFn.node || inLoop(a.path, bFn)) return false;
  const aDecl = a.path.parentPath;
  if (!aDecl.inList || aDecl.parentPath.isSwitchCase()) return false;
  if (a.path.node.end > bPath.node.start) return false;
  // a'nın bildirim bloğu b'yi kapsamalı: blok içinde sırayla yürütülür
  return Boolean(bPath.findParent((x) => x.node === aDecl.parentPath.node));
}
