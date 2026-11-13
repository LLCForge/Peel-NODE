import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { specialize } from '../opt/pe.js';
import { hasDynamicScope, nodeSize } from '../opt/util.js';
import { collectHelpers } from './96-babel.js';

// E603: fonksiyon özelleştirme. Sabit argümanlarla çağrılan fonksiyonun, o sabitlerle kısmi değerlendirilmiş
// (E602) kopyası üretilir ve yalnızca o çağrı yerleri kopyaya yönlendirilir. Kopya, özgünle aynı kapsamda bildirilir
// (aynı closure), parametreleri yalnızca dinamik argümanlardır. Özgün fonksiyona dokunulmaz.

const MAX_PER_FN = 3;

const constArg = (a) => {
  if (t.isNumericLiteral(a) || t.isStringLiteral(a) || t.isBooleanLiteral(a)) return { v: a.value };
  if (t.isNullLiteral(a)) return { v: null };
  if (t.isUnaryExpression(a, { operator: '-' }) && t.isNumericLiteral(a.argument)) return { v: -a.argument.value };
  if (t.isUnaryExpression(a, { operator: 'void' }) && t.isNumericLiteral(a.argument)) return { v: undefined };
  return null;
};

export async function run(ast, { onLog, bump }) {
  if (hasDynamicScope(ast, traverse)) return;
  let n = 0;
  const fns = [];
  traverse(ast, { FunctionDeclaration(p) { fns.push(p); } });
  // Babel yardımcıları özelleştirilmez: kopyalar (_createClass_s) okunabilirlik aşamasında yardımcı olarak tanınmaz
  const { helperNodes } = collectHelpers(ast);
  for (const p of fns) {
    const node = p.node;
    if (helperNodes.has(node)) continue;
    if (!node?.id || node.async || node.generator || !node.params.length || !node.params.every((x) => t.isIdentifier(x))) continue;
    const scope = p.parentPath.scope;
    const b = scope.getBinding(node.id.name);
    if (!b || b.constantViolations.length || b.path !== p) continue;
    // program kapsamındaki fonksiyon diğer betiklerden de çağrılabilir: yalnızca çağrı yerleri yönlendirilir, özgün kalır
    const groups = new Map();
    for (const r of b.referencePaths) {
      const call = r.parentPath;
      if (!call.isCallExpression({ callee: r.node }) || call.node.arguments.some((a) => t.isSpreadElement(a))) continue;
      if (r.findParent((x) => x === p)) continue; // özyinelemeli çağrılar özgüne gider
      const args = call.node.arguments;
      const stat = new Map();
      node.params.forEach((_, i) => {
        if (i >= args.length) stat.set(i, undefined);
        else { const c = constArg(args[i]); if (c) stat.set(i, c.v); }
      });
      // tüm argümanlar sabitse kopya programın sonucunu hesaplar: kullanıcı fonksiyonu kaybolur, okunurluk düşer
      if (!stat.size || node.params.every((_, i) => stat.has(i))) continue;
      const key = JSON.stringify([...stat].map(([i, v]) => [i, v === undefined ? '__u' : typeof v === 'number' && !Number.isFinite(v) ? String(v) : v, typeof v]));
      if (!groups.has(key)) groups.set(key, { stat, calls: [] });
      groups.get(key).calls.push(call);
    }
    // çok sayıda farklı sabitle çağrılan fonksiyon (decoder, arama tablosu) özelleştirmeyle şişer: atla.
    // Önceki turlarda üretilmiş kopyalar da sınıra sayılır.
    const prefix = new RegExp(`^_${node.id.name.replace(/\$/g, '\\$')}_s\\d*$`);
    const existing = Object.keys(scope.bindings).filter((k) => prefix.test(k)).length;
    if (groups.size + existing > 6) continue;
    let made = existing;
    for (const { stat, calls } of groups.values()) {
      if (made >= MAX_PER_FN) break;
      const name = scope.generateUidIdentifier(`${node.id.name}_s`).name;
      const r = specialize(p, stat, name);
      if (!r) continue;
      // fayda: en az bir dal budanmış ya da döngü açılmış olmalı; boyut patlamamalı
      if (!r.stats.branches && !r.stats.unrolled) continue;
      if (nodeSize(r.fn.body) > nodeSize(node.body) * 2 + 40) continue;
      p.insertAfter(r.fn);
      for (const call of calls) {
        const args = call.node.arguments;
        // sabit argümanlar literal (yan etkisiz); fazla argümanlar değerlendirilmeye devam eder
        const keep = args.filter((_, i) => !stat.has(i));
        call.replaceWith(t.callExpression(t.identifier(name), keep));
      }
      onLog(`specialize: ${node.id.name} → ${name} (${calls.length} çağrı, ${r.stats.branches} dal, ${r.stats.unrolled} döngü)`, 'info');
      made++;
      n++;
    }
    if (made > existing) scope.crawl();
  }
  bump('specialize', n);
}
