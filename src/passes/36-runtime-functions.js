import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { parse } from '../core/parse.js';

// js-confuser "rgf" (Runtime-Generated Functions): fonksiyon kaynağı kodlanmış string'lerde saklanır ve
// çalışma anında new Function(<kaynak>) ile üretilir. Program sandbox'ta, Function çağrıları izlenerek
// çalıştırılır; her çağrı yerine verilen kaynak yakalanır ve çağrı gerçek bir function ifadesiyle değiştirilir.
//
// Doğruluk şartları: Function ile üretilen kod global kapsamda çalışır, bu yüzden kaynağın serbest
// isimlerinden hiçbiri çağrı yerinde yerel bir binding'e çözülmemeli; çağrı yeri strict modda olmamalı
// (Function gövdesi gevşek moddadır). Kaynak, gözlenen tek çalıştırmaya dayanır.

const MAX_SOURCE = 500_000;

const isFunctionCtor = (p) => (p.isNewExpression() || p.isCallExpression()) &&
  t.isIdentifier(p.node.callee, { name: 'Function' }) && !p.scope.getBinding('Function') &&
  p.node.arguments.length > 0 && !p.node.arguments.some((a) => t.isSpreadElement(a));

// Kaynak bir fonksiyon parametresinden geliyorsa (make(src) → new Function(src)) farklı çağrılarda farklı
// kod üretir: tek gözleme göre sabitlemek yanlış olur. js-confuser'da argümanlar decoder çağrılarıdır ve
// önceki pass'ler onları literal'e çevirir.
function dependsOnParams(p) {
  let found = false;
  p.traverse({
    Identifier(q) {
      if (q.isReferencedIdentifier() && q.scope.getBinding(q.node.name)?.kind === 'param') { found = true; q.stop(); }
    },
  });
  return found;
}

// Üretilen fonksiyonun serbest (kendi içinde bağlanmamış) isimleri
function freeNames(fnExpr) {
  const free = new Set();
  const ast = t.file(t.program([t.expressionStatement(fnExpr)]));
  traverse(ast, {
    Identifier(p) {
      if (p.isReferencedIdentifier() && !p.scope.getBinding(p.node.name)) free.add(p.node.name);
    },
  });
  return free;
}

export async function run(ast, { onLog, bump, sandbox }) {
  const sites = [];
  traverse(ast, {
    'NewExpression|CallExpression'(p) {
      if (isFunctionCtor(p) && !dependsOnParams(p)) sites.push(p);
    },
  });
  if (!sites.length) return;

  // __peelFn(k, a, b, …): kaynağı kaydet, gerçek Function'ı üret
  const saved = sites.map((p, k) => {
    const old = { callee: p.node.callee, args: p.node.arguments, type: p.node.type };
    p.node.type = 'CallExpression';
    p.node.callee = t.identifier('__peelFn');
    p.node.arguments = [t.numericLiteral(k), ...old.args];
    return [p.node, old];
  });
  const code = gen(ast);
  for (const [node, old] of saved) {
    node.type = old.type;
    node.callee = old.callee;
    node.arguments = old.args;
  }

  const prelude = `var __peelFns2 = {};
var __peelCtor = Function;
function __peelFn(k) {
  var args = Array.prototype.slice.call(arguments, 1).map(String);
  var s = JSON.stringify(args);
  if (!(k in __peelFns2)) __peelFns2[k] = s; else if (__peelFns2[k] !== s) __peelFns2[k] = null;
  return __peelCtor.apply(null, args);
}`;
  const r = await sandbox.run(`${prelude}\ntry {\n${code}\n} catch (e) {}\n__res.push(__peelFns2);`, { timeoutMs: 8000 });
  const seen = r.res?.[0] ?? {};

  let n = 0;
  sites.forEach((p, k) => {
    const json = seen[k];
    if (typeof json !== 'string' || !p.node || json.length > MAX_SOURCE) return;
    if (p.isInStrictMode()) return;
    const args = JSON.parse(json);
    const params = args.slice(0, -1).join(',');
    const body = args[args.length - 1];
    let fn;
    try {
      fn = parse(`(function (${params}\n) {\n${body}\n})`).program.body[0].expression;
    } catch {
      onLog(`runtime-functions: #${k} kaynağı parse edilemedi`, 'warn');
      return;
    }
    const clash = [...freeNames(fn)].find((name) => p.scope.getBinding(name));
    if (clash) {
      onLog(`runtime-functions: #${k} atlandı (serbest isim "${clash}" çağrı yerinde yerel)`, 'warn');
      return;
    }
    p.replaceWith(fn);
    n++;
  });
  if (n) onLog(`runtime-functions: ${n}/${sites.length} new Function çağrısı gerçek fonksiyona çevrildi (kaynak çalışma anında gözlendi)`, 'info');
  bump('runtimeFunction', n);
}
