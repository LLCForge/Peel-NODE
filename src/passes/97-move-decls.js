import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { isLiteralTree } from '../util/pure.js';
import { scan, renameBlocker } from '../naming/scope.js';

// E236: tanımı kullanıma yaklaştırma. Literal başlangıçlı tek bildirim, aynı bloktaki ilk kullanımın hemen önüne taşınır.
// Koşullar: başlangıç yan etkisiz literal (taşımak değeri değiştirmez), tüm kullanımlar aynı fonksiyonda
// (iç fonksiyon erken çağrılıp eski değeri okuyamaz) ve aradaki deyimler binding'e hiç dokunmuyor.
export async function run(ast, { onLog, bump, naming = {} }) {
  if (naming.moveDecls === false) return;
  const info = scan(ast);
  let n = 0;
  traverse(ast, {
    // çıkışta: iç blokların taşımaları bitmiş olur; gövde tek seferde yeniden sıralanır
    'BlockStatement|Program': {
      exit(p) {
        const body = p.get('body');
        const target = new Map(); // bildirim indeksi → önüne taşınacağı deyim indeksi
        for (let i = 0; i < body.length - 1; i++) {
          const st = body[i];
          if (!st.isVariableDeclaration() || st.node.declarations.length !== 1) continue;
          const d = st.get('declarations.0');
          if (!t.isIdentifier(d.node.id) || (d.node.init && !isLiteralTree(d.node.init))) continue;
          const b = st.scope.getBinding(d.node.id.name);
          if (!b || b.path.node !== d.node || renameBlocker(info, b)) continue;
          const fn = st.getFunctionParent()?.node ?? null;
          const uses = [...b.referencePaths, ...b.constantViolations];
          if (!uses.length) continue;
          let first = Infinity;
          let ok = true;
          for (const u of uses) {
            if ((u.getFunctionParent()?.node ?? null) !== fn) { ok = false; break; }
            const idx = body.findIndex((s2, k) => k > i && (s2.node === u.node || u.findParent((x) => x.node === s2.node)));
            if (idx < 0) { ok = false; break; }
            first = Math.min(first, idx);
          }
          // arada yalnızca bildirimler varsa taşınmaz: iki komşu bildirim her turda yer değiştirip salınırdı
          if (ok && first > i + 1 && body.slice(i + 1, first).some((s2) => !s2.isVariableDeclaration())) target.set(i, first);
        }
        if (!target.size) return;
        // literal başlangıçlar tanımlayıcı içermez: taşınan bildirimler birbirinin kullanım yeri olamaz
        const out = [];
        body.forEach((s2, j) => {
          for (const [i, to] of target) if (to === j) out.push(body[i].node);
          if (!target.has(j)) out.push(s2.node);
        });
        p.node.body = out;
        n += target.size;
      },
    },
  });
  if (n) onLog(`move-decls: ${n} bildirim kullanımına yaklaştırıldı`, 'info');
  bump('moveDecls', n);
}
