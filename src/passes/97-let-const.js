import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { scan, renameBlocker, runsAfter } from '../naming/scope.js';

// E233 / 78: var → let/const, yalnızca kanıtlanabildiğinde:
// - tek bildirim, tüm okumalar/yazmalar bildirimin bloğu içinde ve bildirimden sonra (TDZ yok)
// - döngü içindeyse kapanış yakalaması yok ve başlangıç değeri var (her turda sıfırlanmaz)
// - program düzeyinde (script) global nesne özelliği oluşturduğu için dokunulmaz; with/eval kapsamları atlanır
const LOOPS = ['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement'];

export async function run(ast, { onLog, bump, naming = {} }) {
  if (naming.letConst === false) return;
  const info = scan(ast);
  let n = 0;
  traverse(ast, {
    VariableDeclaration(p) {
      if (p.node.kind !== 'var') return;
      const head = (p.parentPath.isForStatement({ init: p.node }) || p.parentPath.isForXStatement({ left: p.node })) ? p.parentPath : null;
      if (!head && !(p.parentPath.isBlockStatement() || p.parentPath.isProgram() || p.parentPath.isExportNamedDeclaration())) return;
      const holder = p.parentPath.isExportNamedDeclaration() ? p.parentPath : p;
      const kinds = p.get('declarations').map((d) => verdict(d, head, holder, info));
      if (kinds.every((k) => k)) {
        const kind = kinds.every((k) => k === 'const') ? 'const' : 'let';
        // for (const i = 0; …) yalnızca güncellenmiyorsa; verdict bunu zaten kontrol eder
        p.node.kind = kind;
        n += kinds.length;
        return;
      }
      if (head || holder !== p || !kinds.some(Boolean)) return;
      // karışık: sırayı koruyarak ayrı bildirimlere böl
      const groups = [];
      p.node.declarations.forEach((d, i) => {
        const k = kinds[i] || 'var';
        const last = groups.at(-1);
        if (last && last.kind === k) last.declarations.push(d);
        else groups.push(t.variableDeclaration(k, [d]));
      });
      n += kinds.filter(Boolean).length;
      p.replaceWithMultiple(groups);
      p.skip();
    },
  });
  if (n) onLog(`let-const: ${n} var bildirimi let/const oldu`, 'info');
  bump('letConst', n);
}

function verdict(d, head, holder, info) {
  if (!t.isIdentifier(d.node.id)) return null;
  const b = d.scope.getBinding(d.node.id.name);
  if (!b || b.kind !== 'var' || b.path !== d) return null;
  // program düzeyindeki var, script'te global nesne özelliği oluşturur (window.x, diğer script'ler): dokunulmaz
  if (b.scope.path.isProgram()) return null;
  if (renameBlocker(info, b)) return null;
  // aynı ad başka bildirimle tekrar tanımlanıyorsa (var x; var x;) dokunma
  if (b.constantViolations.some((v) => v.isVariableDeclarator() || v.isFunctionDeclaration() || v.isCatchClause())) return null;
  const container = head ?? holder.parentPath;
  if (container.isSwitchCase()) return null;
  const fnOf = (x) => x.getFunctionParent() ?? x.scope.getProgramParent().path;
  const declFn = fnOf(d);
  const inLoop = Boolean(head) || loopBetween(d, declFn);
  const pos = d.node.end;
  const uses = [...b.referencePaths, ...b.constantViolations];
  for (const u of uses) {
    if (!u.findParent((x) => x.node === container.node)) return null;
    if (head && head.isForXStatement() && (u.node === head.node.right || u.findParent((x) => x.node === head.node.right))) return null;
    if (!runsAfter(u, pos, container, info)) return null;
    if (inLoop && fnOf(u).node !== declFn.node) return null;
  }
  if (inLoop && !head && !d.node.init) return null;
  const reassigned = b.constantViolations.length > 0;
  if (head && head.isForStatement()) return reassigned ? 'let' : (d.node.init ? 'const' : 'let');
  if (head) return reassigned ? 'let' : 'const';
  return !reassigned && d.node.init ? 'const' : 'let';
}

// Bildirim ile fonksiyonu arasında döngü var mı?
function loopBetween(d, fn) {
  for (let x = d.parentPath; x && x.node !== fn.node; x = x.parentPath) if (LOOPS.includes(x.type)) return true;
  return false;
}
