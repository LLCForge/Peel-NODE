// Semantik yama sentezi öz-denetimi: node test/patch.test.js
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { synthesizeRule, validateRule, applyRule } from '../src/verify/patch.js';

const host = createHost(await getQuickJS());
const sandbox = sandboxApi(async (msg) => host.handle(msg));
const evaluate = async (list) => (await sandbox.batch(list)).results;

// iki örnekten genelleşen kural: tekrar eden sabit aynı metadeğişkene bağlanır
const rule = synthesizeRule([
  { before: 'x ^ 5 ^ 5', after: 'x | 0' },
  { before: 'a.b ^ 7 ^ 7', after: 'a.b | 0' },
]);
assert.equal(rule.pattern, '$0^$1^$1');
assert.equal(rule.replacement, '$0|0');
assert.deepEqual(rule.holes.map((h) => h.bindings), [['x', 'a.b'], ['5', '7']]);

const v = await validateRule(rule, { evaluate });
assert.equal(v.valid, true);
assert.equal(v.method, 'smt+test');

// yeni koda uygulanır (iç içe eşleşme dahil); yan etkili bağ dokunulmaz kalır
const out = applyRule('var r = (n ^ 9 ^ 9) + (o.p ^ (q ^ 3 ^ 3) ^ (q ^ 3 ^ 3)); var s = k ^ f() ^ f();', rule);
assert.equal(out.count, 4); // iç ikisi açılınca dıştaki o.p ^ (q | 0) ^ (q | 0) de eşleşir
assert.match(out.code, /n \| 0/);
assert.match(out.code, /o\.p \| 0/);
assert.match(out.code, /k \^ f\(\) \^ f\(\)/);

// int32'de doğru ama string girdide yanlış kural testle çürütülür
const naive = synthesizeRule([{ before: 'x ^ 5 ^ 5', after: 'x' }, { before: 'y ^ 2 ^ 2', after: 'y' }]);
assert.equal((await validateRule(naive)).method, 'smt');
const nv = await validateRule(naive, { evaluate });
assert.equal(nv.valid, false);
assert.equal(nv.method, 'test');

// SMT çürütmesi ve ifade edilemeyen sonraki ifade
const wrong = synthesizeRule([{ before: 'x + 1 - 1', after: 'x + 1' }, { before: 'y + 1 - 1', after: 'y + 1' }]);
assert.equal((await validateRule(wrong)).valid, false);
assert.ok(synthesizeRule([{ before: 'x * 2', after: 'z' }, { before: 'y * 2', after: 'w' }]).error);

console.log('patch: ok');
