// Madde 30: opaque-smt z3 ile (Node'da z3-solver kuruluysa) ve yerleşik çözücünün bağımsız kanıtıyla: node test/opaque-z3.test.js
import assert from 'node:assert/strict';
import { parse } from '../src/core/parse.js';
import { traverse, generate } from '../src/util/ast.js';
import { run as opaqueSmt, proveOpaque } from '../src/passes/62-opaque-smt.js';
import { z3Available, shutdownZ3 } from '../src/symbolic/z3/z3.js';

const code = `function f(a, b) {
  var x = a & 0xffff;
  var y = b | 0;
  var r = 0;
  if ((x * (x + 1)) % 2 === 1) r = 1;
  if (((y | 1) & 1) !== 1) r = 2;
  if (x > 10) r = 3;
  return r;
}`;

if (!(await z3Available())) {
  console.log('opaque-z3: z3-solver yok (isteğe bağlı bağımlılık), z3 yolu denenemedi');
} else {
  // z3 + yerleşik: iki kanıt da var, katlanır; gerçekten koşullu dal (x > 10) dokunulmaz
  const ast = parse(code);
  let fn = null;
  traverse(ast, { Function(p) { fn ??= p; } });
  const items = await proveOpaque(fn);
  assert.equal(items.length, 2);
  for (const it of items) {
    assert.equal(it.backend, 'z3 + yerleşik');
    assert.equal(it.fold, true);
    assert.equal(it.value, false);
    assert.ok(it.proof.method === 'sat-drup' ? it.proof.checked : true, 'katlama yalnızca denetlenmiş yerleşik kanıtla');
  }
  // z3 kapalıyken aynı yüklemler yalnız yerleşik çözücüyle
  const fn2 = (() => { let p = null; traverse(parse(code), { Function(q) { p ??= q; } }); return p; })();
  assert.ok((await proveOpaque(fn2, { useZ3: false })).every((x) => x.backend === 'yerleşik'));
  // pass: günlükte arka uç, çıktıda katlanmış koşullar
  const logs = [];
  const ast3 = parse(code);
  await opaqueSmt(ast3, { onLog: (m) => logs.push(m), bump: () => {} });
  const out = generate(ast3).code;
  assert.ok(logs.filter((l) => l.includes('[z3 + yerleşik]')).length === 2, logs.join('\n'));
  assert.ok(/if \(false\) r = 1/.test(out) && /if \(false\) r = 2/.test(out) && /x > 10/.test(out));
  await shutdownZ3();
}
console.log('opaque-z3: ok');
