// Statik semantik modeli öz-denetimi (E502–E540): node test/analysis-semantics.test.js
import assert from 'node:assert/strict';
import { parse } from '../src/core/parse.js';
import { traverse } from '../src/util/ast.js';
import { shadowReport, shadowChain, shadowsBuiltin } from '../src/analysis/shadow.js';
import {
  semanticsReport, isStrict, ownKeysOrder, resolveInWith, namespaceKeys, wrapTopLevelAwait, functionLength,
  classInitOrder, decoratorOrder, regexFeatures, unicodePropertyEscapes,
} from '../src/analysis/semantics.js';

const rep = (code) => semanticsReport(parse(code));
const first = (ast, type) => { let n; traverse(ast, { [type](p) { n = p; p.stop(); } }); return n; };

// E502
{
  const ast = parse('function a(){ "use strict"; return function(){ return this; }; } function b(){ x = 1; return this; }');
  const fns = [];
  traverse(ast, { Function(p) { fns.push(isStrict(p)); } });
  assert.deepEqual(fns, [true, true, false]);
  const r = rep('function b(){ undeclared = 1; with (o) {} return arguments.callee; }');
  assert.ok(r.strict.differences.some((d) => d.construct.includes('undeclared')));
  assert.ok(r.strict.differences.some((d) => d.construct === 'with'));
  assert.ok(isStrict(first(parse('class A { m() { x; } }'), 'Identifier')), 'sınıf gövdesi sıkı');
}

// E503
{
  const r = rep('function f(){ g(); let v = 1; function g(){ return v; } } { y; let y = 2; }');
  assert.ok(r.tdz.sites.some((s) => s.name === 'v' && s.kind === 'olası'));
  assert.ok(r.tdz.sites.some((s) => s.name === 'y' && s.kind === 'kesin'));
}

// E504
{
  const r = rep('var o = { get a() { log.push(1); return 1; }, get b() { return 2; } }; o.a; o.b; Object.defineProperty(o, "c", { get: function () { n++; } });');
  const a = r.accessors.definitions.find((d) => d.name === 'a');
  assert.equal(a.effectful, true);
  assert.equal(r.accessors.definitions.find((d) => d.name === 'b').effectful, false);
  assert.ok(r.accessors.definitions.some((d) => d.name === 'c' && d.via === 'Object.defineProperty'));
  assert.ok(r.accessors.effectfulReads.some((x) => x.name === 'a'));
  assert.ok(!r.accessors.effectfulReads.some((x) => x.name === 'b'));
}

// E505
{
  const r = rep('var p = new Proxy({}, { get(t, k) { return 1; }, gett() {} });');
  assert.deepEqual(r.proxies.sites[0].traps, ['get', 'gett']);
  assert.deepEqual(r.proxies.sites[0].unknownTraps, ['gett']);
  assert.equal(r.proxies.sites[0].bound, 'p');
}

// E506
{
  const ast = parse('({ b: 1, 2: 0, [Symbol.iterator]: f, a: 1, 1: 0, __proto__: null })');
  assert.deepEqual(ownKeysOrder(first(ast, 'ObjectExpression').node), ['1', '2', 'b', 'a', 'Symbol.iterator']);
  const r = rep('var o = { [Symbol.toPrimitive]() { return 1; } }; o[Symbol.iterator]; Symbol("x");');
  assert.ok(r.symbols.wellKnown.some((w) => w.symbol === 'Symbol.toPrimitive' && w.defined));
  assert.equal(r.symbols.created, 1);
  assert.equal(r.symbols.keyed, 1);
}

// E507
{
  const r = rep('class A { #x = 1; static #y; #m() {} get #g() { return 1; } has(o) { return #x in o && this.#x; } }');
  assert.equal(r.privateFields.brandChecks, 1);
  assert.equal(r.privateFields.classes[0].members.length, 4);
}

// E508
{
  const ast = parse('var q = 1; with ({ a: 1 }) { a; q; toString; } with (obj) { z; }');
  const res = {};
  traverse(ast, { Identifier(p) { if (p.isReferencedIdentifier() && p.findParent((x) => x.isWithStatement())) res[p.node.name] = resolveInWith(p); } });
  assert.deepEqual(res, { a: 'property', q: 'binding', toString: 'property', obj: 'binding', z: 'dynamic' });
}

// E509
{
  const r = rep('function f(){ eval("var x"); } (0, eval)("1"); window.eval("2"); var e = eval; e("3"); new Function("a", "b"); setTimeout("x()", 1);');
  assert.equal(r.eval.direct.length, 1);
  assert.equal(r.eval.direct[0].strict, false);
  assert.equal(r.eval.indirect.length, 3);
  assert.equal(r.eval.functionCtor.length, 1);
  assert.equal(r.eval.stringTimers.length, 1);
}

// E510
{
  const r = rep('var f = document.createElement("iframe"); var F = f.contentWindow.Function; if (x instanceof Array) {}');
  assert.ok(r.realm.sources.some((s) => s.via === 'contentWindow'));
  assert.ok(r.realm.freshNatives.some((s) => s.native === 'Function'));
  assert.ok(r.realm.checks.length === 1);
}

// E511
{
  assert.deepEqual(namespaceKeys(['b', 'B', 'a', '_', 'ä']), ['B', '_', 'a', 'b', 'ä']);
  const r = rep('import * as ns from "./m.js"; ns.x = 1; ns.y; export const z = 1, a = 2; export default 3;');
  assert.equal(r.moduleNamespace.writes.length, 1);
  assert.deepEqual(r.moduleNamespace.imports[0].members, ['x', 'y']);
  assert.deepEqual(r.moduleNamespace.ownExports, ['a', 'default', 'z']);
}

// E512
{
  const code = 'const r = await fetch("x"); for await (const c of s) {}';
  const ast = parse(code);
  const r = semanticsReport(ast);
  assert.equal(r.topLevelAwait.sites.length, 2);
  assert.match(wrapTopLevelAwait(code, ast), /^\(async \(\) => \{/);
  assert.equal(wrapTopLevelAwait('export {}; await 1', parse('export {}; await 1')), null);
}

// E513 / E514 / E515
{
  const r = rep(`function* g(){ yield 1; }
for (const x of [1, 2]) {}
for (const y of g()) { break; }
var it = { [Symbol.iterator]() { return { next() { return { done: true }; } }; } };
[...it];
async function h(){ for await (const z of [p]) {} var th = { then(r) { r(1); } }; await th; }
async function* ag() {}`);
  assert.ok(r.iterators.sites.some((s) => s.form === 'for-of' && s.kind.startsWith('yerleşik')));
  assert.ok(r.iterators.sites.some((s) => s.kind === 'üreteç'));
  assert.equal(r.iterators.userIterators.length, 1);
  assert.equal(r.iterators.earlyExits.length, 1);
  assert.equal(r.asyncIterators.forAwait[0].overSync, true);
  assert.equal(r.asyncIterators.asyncGenerators, 1);
  assert.ok(r.thenables.adoptions.some((a) => a.name === 'th'));
}

// E516 / E517
{
  const r = rep('Promise.resolve().then(a); setTimeout(b); queueMicrotask(c); Promise.reject(1); async function k(){ throw 1; } k();');
  assert.ok(r.microtasks.micro >= 2 && r.microtasks.macro === 1);
  assert.equal(r.rejections.candidates.length, 3);
}

// E518 / E519
{
  const r = rep('var s = new Error().stack; if (s.indexOf("eval") >= 0) {} Error.captureStackTrace(o, F); Error.stackTraceLimit = 0; Error.prepareStackTrace = f;');
  assert.equal(r.stackTraces.reads.length, 1);
  assert.equal(r.stackTraces.inspected.length, 1);
  assert.equal(r.stackTraces.capture.length, 1);
  assert.equal(r.stackTraces.limit.length, 1);
  assert.equal(r.stackTraces.prepare.length, 1);
}

// E520 / E521 / E522
{
  const r = rep(`function a(x, y = 1, z) { return arguments.callee; }
function b() { "use strict"; return arguments.callee; }
function c(p, [q], ...r) {}
a.length; c.length; b.caller;
function d() { if (!new.target) throw 1; } new d(); d();
function e(u) {} Object.defineProperty(e, "length", { value: 9 }); e.length;`);
  assert.deepEqual(r.callee.sites.map((s) => s.strict), [false, true]);
  assert.deepEqual(r.functionProps.lengths.map((l) => [l.fn, l.value]), [['a', 1], ['c', 2], ['e', null]]);
  assert.equal(r.functionProps.callers[0].effect.startsWith('TypeError'), true);
  assert.deepEqual([r.newTarget.functions[0].withNew, r.newTarget.functions[0].withoutNew], [1, 1]);
  assert.equal(functionLength(first(parse('(function (a, b, {c}, d = 1) {})'), 'FunctionExpression').node), 3);
}

// E523 / E524
{
  const ast = parse('class A extends B { static s = 1; a = this.b; static { init(); } b = 2; #p() {} [k()] = 3; constructor() { super(); } }');
  const o = classInitOrder(first(ast, 'ClassDeclaration').node);
  assert.deepEqual(o.definition, ['extends', 'hesaplanmış anahtar [hesaplanmış]', 'yöntem #p', 'statik alan s', 'statik blok #1']);
  assert.deepEqual(o.instance, ['özel yöntem #p', 'alan a', 'alan b', 'alan [hesaplanmış]', 'kurucu gövdesi (super() sonrası kalan)']);
  assert.deepEqual(o.hazards, ['a → this.b henüz tanımsız']);
  assert.equal(rep('class C { static {} static {} }').classes.staticBlocks, 2);
}

// E525
{
  const ast = parse('@outer @inner class A { @f @g m() {} @s static x = 1; }');
  const o = decoratorOrder(first(ast, 'ClassDeclaration').node);
  assert.deepEqual(o.evaluate, ['sınıf: @outer', 'sınıf: @inner', 'm: @f', 'm: @g', 'x: @s']);
  assert.deepEqual(o.apply, ['m: @g', 'm: @f', 'statik x: @s', 'sınıf: @inner', 'sınıf: @outer']);
  assert.equal(rep('@d class Z {}').decorators.classes.length, 1);
}

// E526 / E527 / E528
{
  assert.ok(regexFeatures('(?<=a)b', '').includes('lookbehind'));
  assert.ok(regexFeatures('(a+)+$', '').some((f) => f.includes('niceleyici')));
  assert.ok(regexFeatures('[\\p{L}--[a-z]]', 'v').some((f) => f.startsWith('v bayrağı')));
  const esc = unicodePropertyEscapes('\\p{Script=Greek}\\P{Nope}', 'u');
  assert.deepEqual(esc.map((e) => [e.name, e.valid]), [['Script', true], ['Nope', false]]);
  assert.equal(unicodePropertyEscapes('\\p{L}', '')[0].meaning, 'literal "p{L}"');
  const r = rep('var re = /a/g; re.test(s); re.test(s); re.lastIndex = 0; var once = /b/g; once.test(s); new RegExp("x+", "y");');
  assert.equal(r.regex.stateful.length, 1);
  assert.equal(r.regex.stateful[0].name, 're');
  assert.equal(r.regex.lastIndex.length, 1);
  assert.ok(r.regex.patterns.some((p) => p.flags === 'y'));
}

// E529–E531, E534
{
  const r = rep('new Date().getHours(); d.getTimezoneOffset(); (5).toLocaleString(); new Intl.NumberFormat("tr").format(1); performance.now();');
  assert.equal(r.time.localDate.length, 2);
  assert.equal(r.time.timezone.length, 1);
  assert.equal(r.locale.toLocale.length, 1);
  assert.equal(r.locale.intl[0].api, 'Intl.NumberFormat');
  assert.equal(r.time.performance.length, 1);
}

// E537 / E538 / E539 / E540
{
  const r = rep(`var buf = new ArrayBuffer(8); var u8 = new Uint8Array(buf); var dv = new DataView(buf); var sub = u8.subarray(2);
u8[0] = 1; dv.setUint16(0, 2);
var nb = buf.transfer(); buf.byteLength;
var sab = new SharedArrayBuffer(4); Atomics.add(new Int32Array(sab), 0, 1);
var w = new WeakRef(o); var fr = new FinalizationRegistry(cb);`);
  const g = r.typedArrays.groups[0];
  assert.equal(g.buffer, 'buf');
  assert.deepEqual(g.views.map((v) => v.view), ['u8', 'dv', 'sub']);
  assert.equal(g.writes, 2);
  assert.equal(r.detached.transfers[0].name, 'buf');
  assert.equal(r.detached.usesAfter.length, 1);
  assert.equal(r.shared.sab.length, 1);
  assert.equal(r.shared.atomics[0].op, 'add');
  assert.equal(r.weak.weakRefs.length, 1);
  assert.equal(r.weak.registries.length, 1);
}

// E571
{
  const ast = parse('var x = 1; function f(x) { var undefined = 2; return function () { let x = 3; return x + undefined; }; }');
  const r = shadowReport(ast);
  assert.equal(r.locals, 2);
  assert.equal(r.builtins, 1);
  assert.equal(r.valueNames[0].name, 'undefined');
  let inner;
  traverse(ast, { ReturnStatement(p) { if (t2(p)) inner = p; } });
  assert.equal(shadowChain(inner.get('argument.left'), 'x').length, 3);
  assert.equal(shadowsBuiltin(inner.get('argument.right'), 'undefined'), true);
}
function t2(p) { return p.node.argument?.type === 'BinaryExpression'; }

console.log('analysis-semantics: ok');
