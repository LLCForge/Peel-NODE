import * as t from '@babel/types';
import { parse } from '../core/parse.js';
import { raw } from '../core/emit.js';
import { traverse } from '../util/ast.js';
import { inlineSourceMap, decodeMappings, segmentAt } from '../util/sourcemap.js';

// A-25: kısmi kaynak haritasıyla isim kurtarma. Satır içi (data: URL) haritada bağlamanın bildirim konumu için
// bir ad varsa bağlama o ada çevrilir. Harita yalnızca bazı konumları kapsıyorsa yalnızca onlar adlandırılır.
// Çakışma (aynı adın kapsamda ya da iç kapsamlarda kullanılması) varsa o bağlamaya dokunulmaz.
// Konumlar orijinal metne aittir: bu yüzden metin pass'i olarak, kod yeniden üretilmeden önce çalışır.

const RESERVED = new Set(['arguments', 'eval', 'undefined', 'NaN', 'Infinity']);

export async function run(code, { onLog, bump }) {
  const found = inlineSourceMap(code);
  if (!found || !Array.isArray(found.map.names) || !found.map.names.length) return code;
  let ast;
  let lines;
  try {
    ast = parse(code);
    lines = decodeMappings(found.map.mappings);
  } catch {
    return code;
  }
  const names = found.map.names;
  let n = 0;
  traverse(ast, {
    Scopable(p) {
      for (const [current, binding] of Object.entries(p.scope.bindings)) {
        if (binding.scope !== p.scope) continue;
        const loc = binding.identifier.loc?.start;
        if (!loc) continue;
        const seg = segmentAt(lines, loc.line - 1, loc.column);
        // ad yalnızca tam bu konumdan başlayan segmentteyse güvenilir
        if (!seg || seg[0] !== loc.column || seg.length < 5) continue;
        const original = names[seg[4]];
        if (typeof original !== 'string' || original === current || !t.isValidIdentifier(original) || RESERVED.has(original)) continue;
        if (p.scope.hasBinding(original) || p.scope.hasGlobal(original) || p.scope.hasReference(original)) continue;
        // iç kapsamlarda aynı ad kullanılıyorsa (yerel ya da serbest) yeniden adlandırma onu yakalayabilir
        let clash = false;
        p.traverse({ Identifier(q) { if (q.node.name === original) { clash = true; q.stop(); } } });
        if (clash) continue;
        p.scope.rename(current, original);
        n++;
      }
    },
  });
  if (!n) return code;
  onLog(`sourcemap: kaynak haritasından ${n} isim kurtarıldı`, 'info');
  bump('sourcemapNames', n);
  // eskiyen harita yorumu kaldırılır
  ast.comments = (ast.comments ?? []).filter((c) => !c.value.includes('sourceMappingURL='));
  t.traverseFast(ast, (node) => {
    for (const key of ['leadingComments', 'trailingComments', 'innerComments']) {
      if (node[key]) node[key] = node[key].filter((c) => !c.value.includes('sourceMappingURL='));
    }
  });
  return raw(ast);
}
