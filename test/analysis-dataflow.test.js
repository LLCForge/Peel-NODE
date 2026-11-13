// Veri akışı öz-denetimi (E554/E555/E575–E580): node test/analysis-dataflow.test.js
import assert from 'node:assert/strict';
import { parse } from '../src/core/parse.js';
import { traverse } from '../src/util/ast.js';
import { raw } from '../src/core/emit.js';
import { analyzeFunction, applyCopyPropagation } from '../src/analysis/defs.js';
import { dataflowReport } from '../src/analysis/index.js';

function fn(code, name = 'f') {
  const ast = parse(code);
  let found;
  traverse(ast, { FunctionDeclaration(p) { if (p.node.id.name === name) { found = p; p.stop(); } } });
  return { ast, r: analyzeFunction(found) };
}

const nameOf = (d) => d.entry ? `entry:${d.kind}` : `L${d.path.node.loc.start.line}`;

// ulaşan tanımlar + def-use: iki daldan gelen tanımlar birleşir
{
  const { r } = fn(`function f(c) {
  var x = 1;
  if (c) x = 2;
  return x;
}`);
  const use = r.uses.find((u) => u.e.path.node.loc.start.line === 4);
  assert.deepEqual(use.defs.map(nameOf).sort(), ['L2', 'L3']);
  const d2 = r.defs.find((d) => !d.entry && d.path.node.loc.start.line === 3);
  assert.equal(r.defUses.get(d2.id).length, 1);
}

// canlılık + ölü atama: üzerine yazılan değer ölü; döngüde okunan değil
{
  const { r } = fn(`function f(n) {
  var a = 1;
  a = 2;
  var s = 0;
  for (var i = 0; i < n; i++) s += i;
  return a + s;
}`);
  const dead = r.deadAssignments.map((d) => `${d.binding.identifier.name}@${d.def.path.node.loc.start.line}`);
  assert.ok(dead.includes('a@2'), 'a = 1 ölü');
  assert.ok(!dead.includes('a@3'));
  assert.ok(!dead.some((x) => x.startsWith('s@')), 'döngü taşıdığı s canlı');
  assert.ok(!dead.some((x) => x.startsWith('i@')), 'i döngü koşulunda okunur');
}

// istisna kenarı: try içinde atanan değer catch'te okunuyorsa canlı
{
  const { r } = fn(`function f(g) {
  var x = 1;
  try { x = 2; g(); x = 3; } catch (e) { return x; }
  return 0;
}`);
  const dead = r.deadAssignments.map((d) => d.def.path.node.loc.start.line);
  assert.ok(!dead.includes(3), "x=2 catch'e ulaşabilir");
}

// yakalanan değişken izlenmez (iç fonksiyon her an okuyabilir)
{
  const { r } = fn(`function f() { var x = 1; x = 2; return function () { return x; }; }`);
  assert.ok(!r.bindings.some((b) => b.identifier.name === 'x'));
}

// kopya yayılımı: b = a sonrası a değişmediyse b → a; döngüde değişen a için yok
{
  const { ast, r } = fn(`function f(a, c) {
  var b = a;
  var y = b + 1;
  var q = c;
  while (y) { c = y; y = q; }
  return y;
}`);
  const lines = r.copies.map((c) => `${c.from.identifier.name}->${c.to.identifier.name}@${c.use.node.loc.start.line}`);
  assert.ok(lines.includes('b->a@3'));
  assert.ok(!lines.some((l) => l.startsWith('q->')), 'c döngüde değişiyor');
  assert.equal(applyCopyPropagation([r]), 1);
  assert.match(raw(ast), /var y = a \+ 1/);
}

// sabit yayılımı: dallarda aynı değer → sabit; farklı → bilinmez; BigInt ve dizi modelleri
{
  const { r } = fn(`function f(c) {
  let k = 2n ** 10n;
  var s = [] + {};
  var x = 5;
  if (c) x = 2 + 3;
  var y = c ? 1 : 2;
  return [k, s, x, y];
}`);
  const v = Object.fromEntries(r.constants.filter((c) => c.use.node.loc.start.line === 7).map((c) => [c.binding.identifier.name, c.value]));
  assert.equal(v.k, 1024n);
  assert.equal(v.s, '[object Object]');
  assert.equal(v.x, 5);
  assert.ok(!('y' in v));
}

// TDZ: girişteki TDZ ile atanmış değer birleşince atanmış değer kalır
{
  const { r } = fn(`function f() { let t = 7; return t; }`);
  assert.equal(r.constants.find((c) => c.binding.identifier.name === 't').value, 7);
}

// deterministik sıra (E555): aynı girdi iki kez aynı raporu üretir
{
  const code = `function f(a){var x=a;for(var i=0;i<3;i++){if(i)x=i;else continue;}return x}function g(){var u=1;u=2;return u}`;
  const a = JSON.stringify({ ...dataflowReport(parse(code)), ms: 0 });
  const b = JSON.stringify({ ...dataflowReport(parse(code)), ms: 0 });
  assert.equal(a, b);
}

console.log('analysis-dataflow: ok');
