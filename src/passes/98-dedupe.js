import * as t from '@babel/types';
import { traverse, generate } from '../util/ast.js';
import { scan, renameBlocker } from '../naming/scope.js';

// 85: kopya fonksiyonları birleştirme. Aynı kapsamda, yerel isimleri dışında birebir aynı iki fonksiyon bildiriminden
// ikincisinin çağrıları birincisine yönlendirilir ve ikincisi silinir.
// Kanıt: aynı kapsamda oldukları için serbest isimler aynı binding'lere çözülür; ikinci fonksiyon yalnızca çağrılıyor
// (kimlik karşılaştırması, özellik, new, name/length okuması yok) ve hiç yeniden atanmıyor.

// Fonksiyonun yerel isimleri sıraya göre $0, $1… ile, kendi adı $self ile değiştirilmiş biçimi
export function canonical(path) {
  const node = path.node;
  const renames = [];
  const map = new Map();
  const selfName = node.id?.name;
  path.traverse({
    Identifier(p) {
      const b = p.scope.getBinding(p.node.name);
      let name = null;
      if (b && (b.scope === path.scope || b.scope.path.findParent((x) => x.node === node))) {
        if (!map.has(b)) map.set(b, `$${map.size}`);
        name = map.get(b);
      } else if (b && selfName && p.node.name === selfName && b.path.node === node) {
        name = '$self';
      }
      if (name && name !== p.node.name) renames.push([p.node, p.node.name, name]);
    },
  });
  for (const [n, , to] of renames) n.name = to;
  const id = node.id;
  node.id = null;
  // yorumlar karşılaştırmaya girmez
  const code = generate(node, { compact: true, comments: false, jsescOption: { minimal: true } }).code;
  node.id = id;
  for (const [n, from] of renames) n.name = from;
  return code;
}

export async function run(ast, { onLog, bump, naming = {} }) {
  if (naming.dedupe === false) return;
  const info = scan(ast);
  let n = 0;
  const seen = new WeakSet();
  traverse(ast, {
    Scopable(p) {
      if (seen.has(p.scope)) return;
      seen.add(p.scope);
      const groups = new Map();
      for (const b of Object.values(p.scope.bindings)) {
        if (b.kind !== 'hoisted' || b.scope !== p.scope || !b.path.isFunctionDeclaration() || !b.constant) continue;
        if (renameBlocker(info, b) || (b.scope.path.isProgram() && !info.module && info.globalNames.has(b.identifier.name))) continue;
        // arguments.callee ve Function.prototype.toString gövdeyi ayırt eder
        const code = canonical(b.path);
        if (code.includes('arguments.callee') || code.length < 20) continue;
        if (!groups.has(code)) groups.set(code, []);
        groups.get(code).push(b);
      }
      for (const list of groups.values()) {
        if (list.length < 2) continue;
        list.sort((a, b) => a.path.node.start - b.path.node.start);
        const keep = list[0];
        for (const dup of list.slice(1)) {
          if (!dup.referencePaths.every((r) => r.parentPath.isCallExpression({ callee: r.node }) &&
            r.scope.getBinding(keep.identifier.name) === keep)) continue;
          for (const r of dup.referencePaths) r.replaceWith(t.identifier(keep.identifier.name));
          dup.path.remove();
          n++;
        }
      }
    },
  });
  if (n) onLog(`dedupe: ${n} kopya fonksiyon birleştirildi`, 'info');
  bump('dedupe', n);
}
