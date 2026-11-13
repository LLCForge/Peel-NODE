// Soyut işlem modeli öz-denetimi (E501/E535/E536): node test/analysis-ops.test.js
import assert from 'node:assert/strict';
import { parseExpression } from '@babel/parser';
import { evaluate, isThrown, toNumber, toString, toPrimitive, arrayModel, objectModel, valueToNode, UNKNOWN } from '../src/analysis/ops.js';
import { gen } from '../src/util/ast.js';

const G = { undefined, NaN, Infinity };
const ev = (src) => evaluate(parseExpression(src), (n) => (Object.hasOwn(G, n.name) ? G[n.name] : UNKNOWN));

// E501: ToPrimitive / ToNumber / ToString — JSFuck tarzı ifadeler host motoruyla aynı sonucu vermeli
const same = [
  '[] + {}', '[] + []', '+[]', '+{}', '[1] + [2]', '+[[]]', '+[1]', '+"0x1f"', '+" 12 "', '+"1e3"', '+""',
  '"b" + "a" + +"a" + "a"', '([] + {})[1]', '[,] + ""', '[null, undefined, 1] + ""', '({}) + 1',
  '1 + null', '"5" * "2"', '[2] * [3]', 'true + true', '"3" - - "3"', '[] == ![]', 'null == 0', 'null == undefined',
  '"" == 0', '[0] == false', '"1" < "12"', '[10] < [9]', '({ toString: 1 }).toString', '`a${[1, 2]}b`',
  '!![] + ""', '(1/0) + ""', '-(0) + ""', 'typeof []', 'typeof null', '/a/g + ""', '[][[]]', '"abc"[1]', '"abc".length',
  '({a: 1}).a', '({a: 1}).b', '[1, [2, [3]]] + ""', '0.1 + 0.2', '2 ** 53 + 1', '-0 === 0', 'NaN !== NaN', '+"Infinity"',
];
for (const src of same) {
  // eslint-disable-next-line no-eval
  const host = (0, eval)(`(${src})`);
  const got = ev(src);
  assert.ok(Object.is(got, host), `${src}: ${String(got)} ≠ ${String(host)}`);
}

// Nesne literal'inde toString/valueOf veri özelliği çağrılamaz → atlanır; ikisi de yoksa TypeError
assert.ok(isThrown(toPrimitive(objectModel([['toString', 1], ['valueOf', 2]]))));
assert.equal(toString(arrayModel([1, arrayModel([2, 3])])), '1,2,3');
assert.equal(toNumber(arrayModel(['  7 '])), 7);
// Kullanıcı tanımlı yöntem modellenmez
assert.equal(ev('({ toString() { return "x"; } }) + ""'), UNKNOWN);
assert.equal(ev('({ __proto__: null }) + ""'), UNKNOWN);

// E535: -0 ve NaN korunur ve düğüme doğru yazılır
assert.ok(Object.is(ev('-0'), -0));
assert.equal(gen(valueToNode(-0)), '-0');
assert.equal(gen(valueToNode(NaN)), '0/0');
assert.ok(Object.is(ev('1 / -Infinity'), -0));

// E536: BigInt semantiği
assert.equal(ev('2n ** 64n'), 18446744073709551616n);
assert.equal(ev('5n / 2n'), 2n);
assert.equal(ev('-7n % 2n'), -1n);
assert.equal(ev('0x10n + 1n'), 17n);
assert.equal(ev('1n < 2'), true);
assert.equal(ev('1n == 1'), true);
assert.equal(ev('1n === 1'), false);
assert.equal(ev('"x" + 1n'), 'x1');
assert.equal(ev('typeof 1n'), 'bigint');
for (const src of ['1n + 1', '+1n', '1n >>> 0n', '1n / 0n', '2n ** -1n']) {
  const r = ev(src);
  assert.ok(isThrown(r), `${src} fırlatmalı`);
}
assert.equal(ev('1n / 0n').name, 'RangeError');
assert.equal(ev('1n + 1').name, 'TypeError');
assert.equal(gen(valueToNode(-5n)), '-5n');
assert.equal(ev('[1n] * 2'), 2);

console.log('analysis-ops: ok');
