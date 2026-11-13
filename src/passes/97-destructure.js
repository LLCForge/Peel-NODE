import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { scan, renameBlocker } from '../naming/scope.js';

// 78: var a = o.a, b = o.b;  →  var { a, b } = o;
// Kanıt: o sabit bir yerel binding ve nesne/dizi literali ya da new ile başlatılmış (null/undefined olamaz,
// hata mesajı farkı doğmaz; o bir kez okunur ama değişmediği için fark yok). Özellik okuma sırası aynıdır.
// Dizi deseni ([a, b] = arr) üretilmez: yineleyici protokolü indeks okumasından farklı davranabilir.
export async function run(ast, { onLog, bump, naming = {} }) {
  if (naming.destructure === false) return;
  const info = scan(ast);
  let n = 0;
  traverse(ast, {
    VariableDeclaration(p) {
      if (p.parentPath.isForStatement() || p.parentPath.isForXStatement()) return;
      const decls = p.node.declarations;
      const out = [];
      let i = 0;
      let changed = false;
      while (i < decls.length) {
        const src = sourceOf(decls[i], p, info);
        let j = i;
        while (j + 1 < decls.length && src && sourceOf(decls[j + 1], p, info) === src) j++;
        const group = decls.slice(i, j + 1);
        const targets = new Set(group.map((d) => d.id.name));
        if (src && group.length >= 2 && !targets.has(src) && new Set(group.map((d) => keyOf(d.init))).size === group.length) {
          const props = group.map((d) => {
            const k = keyOf(d.init);
            const key = t.isValidIdentifier(k) ? t.identifier(k) : t.stringLiteral(k);
            return t.objectProperty(key, t.identifier(d.id.name), false, t.isIdentifier(key) && k === d.id.name);
          });
          out.push(t.variableDeclarator(t.objectPattern(props), t.identifier(src)));
          changed = true;
          n++;
        } else {
          out.push(...group);
        }
        i = j + 1;
      }
      if (changed) p.node.declarations = out;
    },
  });
  if (n) onLog(`destructure: ${n} nesne ayrıştırma deseni`, 'info');
  bump('destructure', n);
}

const keyOf = (m) => (!m.computed && t.isIdentifier(m.property) ? m.property.name : m.property.value);

// x = o.k biçimindeki bildirimin kaynağı (uygunsa o'nun adı)
function sourceOf(d, p, info) {
  if (!t.isIdentifier(d.id) || !t.isMemberExpression(d.init) || !t.isIdentifier(d.init.object)) return null;
  const m = d.init;
  if (m.computed && !t.isStringLiteral(m.property)) return null;
  if (!m.computed && !t.isIdentifier(m.property)) return null;
  if (keyOf(m) === '__proto__') return null;
  const b = p.scope.getBinding(m.object.name);
  if (!b || !b.constant || renameBlocker(info, b)) return null;
  const init = b.path.isVariableDeclarator() ? b.path.node.init : null;
  if (!init || !(t.isObjectExpression(init) || t.isArrayExpression(init) || t.isNewExpression(init))) return null;
  return m.object.name;
}
