// Motor stratejileri: pass sırası arama, kademeli saldırı, geri alma zinciri, bölge çözme: node test/search.test.js
import assert from 'node:assert/strict';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { getQuickJS } from 'quickjs-emscripten';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { obfuscationScore, candidateOrders, searchPassOrder, cascade, rollbackChain, deobfuscateRegion } from '../src/core/search.js';
import { PASSES } from '../src/core/registry.js';

const host = createHost(await getQuickJS());
const sandbox = sandboxApi(async (msg) => host.handle(msg));

const SRC = 'function greet(n){return "Hello, "+n+"!";} var config={endpoint:"https://api.example.com/v1/collect"}; console.log(greet("PEEL"), config.endpoint);';
const obf = JavaScriptObfuscator.obfuscate(SRC, { stringArrayThreshold: 1, stringArrayEncoding: ['base64'] }).getObfuscatedCode();

assert.ok(obfuscationScore(obf) > obfuscationScore(SRC));
const orders = candidateOrders(2);
assert.equal(orders.length, 6);
const astIds = PASSES.filter((p) => p.kind === 'ast').map((p) => p.id).sort();
for (const o of orders) assert.deepEqual([...o.order].sort(), astIds, `${o.name} tüm pass'leri içermeli`);

// E32
const s = await searchPassOrder(obf, { sandbox, extra: 0 });
assert.equal(s.tried.length, 4);
assert.ok(s.best.verified);
assert.ok(s.best.code.includes('"Hello, "'));
assert.ok(s.best.score < obfuscationScore(obf));

// E33
const c = await cascade(obf, { sandbox });
assert.equal(c.stages.length, 4);
assert.ok(c.score < obfuscationScore(obf));
assert.ok(c.code.includes('https://api.example.com/v1/collect'));

// E34: davranışı bozan anlık görüntü ve ona bağlı sonraki değişiklik
const input = 'var a = 2; console.log(a * 3);';
const snaps = [
  { id: 'girdi', round: 0, code: input },
  { id: 'literals', round: 1, code: 'var a = 2;\nconsole.log(a * 3);' },
  { id: 'simplify', round: 1, code: 'var a = 2;\nconsole.log(a * 4);' },
  { id: 'unused', round: 1, code: 'console.log(2 * 4);' },
];
const rb = await rollbackChain(input, snaps, { sandbox });
assert.equal(rb.culprit.id, 'simplify');
assert.deepEqual(rb.dependents, ['unused']);
assert.equal(rb.fixed, true);
assert.equal((await rollbackChain(input, snaps.slice(0, 2), { sandbox })).culprit, null);

// E36: yalnızca seçili fonksiyon çözülür
const regionSrc = [
  'var _0xkey = "\\x68\\x69";',
  'function untouched() { return "\\x61\\x62"; }',
  'function target() { return String.fromCharCode(104, 101, 108, 108, 111) + _0xkey; }',
  'console.log(untouched(), target());',
].join('\n');
const at = regionSrc.indexOf('fromCharCode');
const reg = await deobfuscateRegion(regionSrc, at, at + 5, { sandbox });
assert.equal(reg.ok, true, reg.reason);
assert.ok(reg.code.includes('function untouched() { return "\\x61\\x62"; }'), 'bölge dışı aynen kalmalı');
// "hello" + _0xkey: okunabilirlik aşaması (modern-syntax) şablon string'e çevirir
assert.ok(reg.after.includes('`hello${_0xkey}`'), reg.after);
assert.ok(!reg.after.includes('peel:region'));
// program seviyesi seçim: decoder ve tablo seçim dışında, bölge tüm programın bağlamıyla çözülür
const prog = [
  'var _0xt = ["\\x61\\x62", "\\x63\\x64", "\\x65"];',
  'function _0xd(i) { return _0xt[i - 1]; }',
  'console.log(_0xd(1) + _0xd(2));',
  'console.log(_0xd(3));',
].join('\n');
const at2 = prog.indexOf('console.log(_0xd(3))');
const pr = await deobfuscateRegion(prog, at2, at2 + 8, { sandbox });
assert.equal(pr.ok, true, pr.reason);
assert.match(pr.after, /console\.log\("e"\)/);
assert.ok(pr.code.startsWith(prog.slice(0, at2)), 'seçim öncesi aynen kalmalı');
assert.ok(!pr.after.includes("peel:region"));
assert.equal(pr.region.from, at2);

console.log('search: ok');
