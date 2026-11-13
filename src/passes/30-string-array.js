import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { isLiteralTree, literalValue } from '../util/pure.js';

const MIN_TABLE = 5;
const MAX_CALLS = 20000;
const MAX_HELPER_SRC = 500_000;

const isStringArray = (node) =>
  t.isArrayExpression(node) && node.elements.length >= MIN_TABLE && node.elements.every((e) => t.isStringLiteral(e));

// Program seviyesindeki deyimi bul (yoksa null)
const topStatement = (p) => p.findParent((x) => x.parentPath?.isProgram()) ?? (p.parentPath?.isProgram() ? p : null);

// Rotasyon IIFE'si: (function(a, n){ ... })(DIZI, 0x1f) ya da !function(){}(DIZI)
function rotatorCall(stmt, name) {
  if (!t.isExpressionStatement(stmt)) return false;
  let e = stmt.expression;
  if (t.isUnaryExpression(e)) e = e.argument;
  return t.isCallExpression(e) &&
    (t.isFunctionExpression(e.callee) || t.isArrowFunctionExpression(e.callee)) &&
    e.arguments.some((a) => t.isIdentifier(a, { name }));
}

// Probe'da tanımlanacak güvenli üst seviye deyimler: fonksiyon bildirimleri ve literal başlangıçlı değişkenler
function isHelper(stmt) {
  if (t.isFunctionDeclaration(stmt)) return true;
  return t.isVariableDeclaration(stmt) &&
    stmt.declarations.every((d) => !d.init || isLiteralTree(d.init) || t.isFunctionExpression(d.init));
}

export async function run(ast, { onLog, bump, sandbox }) {
  const tables = [];
  let programPath = null;
  traverse(ast, {
    Program(p) { programPath = p; },
    VariableDeclarator(p) {
      if (t.isIdentifier(p.node.id) && isStringArray(p.node.init) && p.parentPath.parentPath.isProgram()) {
        tables.push(p);
      }
    },
  });

  for (const tablePath of tables) {
    const name = tablePath.node.id.name;
    const binding = tablePath.scope.getBinding(name);
    if (!binding) continue;

    const program = ast.program.body;
    const rotators = program.filter((s) => rotatorCall(s, name));

    // diziye dokunan üst seviye fonksiyonlar decoder adayıdır
    const decoders = new Map();
    for (const ref of binding.referencePaths) {
      const top = topStatement(ref);
      if (!top) continue;
      if (top.isFunctionDeclaration()) decoders.set(top.node.id.name, top);
      else if (top.isVariableDeclaration() && top.node.declarations.length === 1 &&
               t.isFunctionExpression(top.node.declarations[0].init) && t.isIdentifier(top.node.declarations[0].id)) {
        decoders.set(top.node.declarations[0].id.name, top);
      }
    }
    if (!decoders.size) continue;

    // decoder çağrıları: tüm argümanları literal olanlar
    const calls = [];
    for (const [decName, decPath] of decoders) {
      const b = decPath.isFunctionDeclaration() ? decPath.parentPath.scope.getBinding(decName) : decPath.scope.getBinding(decName);
      if (!b) continue;
      for (const ref of b.referencePaths) {
        const call = ref.parentPath;
        if (!call.isCallExpression() || call.node.callee !== ref.node) continue;
        if (ref.findParent((x) => x === decPath)) continue;
        if (!call.node.arguments.length || !call.node.arguments.every((a) => literalValue(a).ok)) continue;
        calls.push(call);
        if (calls.length >= MAX_CALLS) break;
      }
    }
    if (!calls.length) continue;

    const unique = [...new Set(calls.map((c) => gen(c.node)))];
    let helpers = '';
    for (const stmt of program) {
      if (isHelper(stmt) || rotators.includes(stmt)) helpers += `${gen(stmt)}\n`;
    }
    if (helpers.length > MAX_HELPER_SRC) {
      onLog(`string array ${name}: yardımcı kod çok büyük, atlandı`, 'warn');
      continue;
    }
    const probes = unique
      .map((src) => `__res.push((function () { try { var v = ${src}; return typeof v === "string" ? v : null; } catch (e) { return null; } })());`)
      .join('\n');

    const r = await sandbox.run(`${helpers}\n${probes}`, { timeoutMs: 6000 });
    if (!r.ok) {
      onLog(`string array ${name}: probe başarısız (${r.error})`, 'warn');
      continue;
    }
    const values = new Map(unique.map((src, i) => [src, r.res[i]]));

    let n = 0;
    for (const call of calls) {
      if (!call.node) continue;
      const v = values.get(gen(call.node));
      if (typeof v !== 'string') continue;
      call.replaceWith(t.stringLiteral(v));
      n++;
    }
    if (!n) continue;
    bump('stringArray', n);
    onLog(`string array ${name}: ${n}/${calls.length} çağrı çözüldü`, 'info');

    // temizlik: artık çağrılmayan decoder'lar, sonra sadece rotasyonda kalan dizi
    programPath.scope.crawl();
    for (const [decName, decPath] of decoders) {
      if (!decPath.node) continue;
      const b = programPath.scope.getBinding(decName);
      if (b && b.referencePaths.every((r2) => r2.findParent((x) => x === decPath))) decPath.remove();
    }
    programPath.scope.crawl();
    const tb = programPath.scope.getBinding(name);
    const rotatorPaths = programPath.get('body').filter((p) => rotatorCall(p.node, name));
    if (tb && tb.referencePaths.every((r2) => rotatorPaths.some((rp) => r2.findParent((x) => x === rp)))) {
      for (const rp of rotatorPaths) rp.remove();
      if (tablePath.node) tablePath.remove();
      onLog(`string array ${name}: dizi ve rotasyon kaldırıldı`, 'info');
    }
  }
}
