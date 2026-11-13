// analyze() raporundaki semantik bölümü (E-U/E-V kablolaması): node test/analysis-report.test.js
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { parse } from '../src/core/parse.js';
import { deobfuscate } from '../src/core/pipeline.js';
import { analyze } from '../src/core/analyze.js';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { createTrace } from '../src/analysis/trace.js';
import { staticFolds, sinkQueries } from '../src/analysis/report.js';

// E501/E536: sandbox'sız katlama adayları
{
  const f = staticFolds(parse('var a = ([] + {})[1]; var d = 1n * 2n; var b = x + 1; var c = -1;'));
  assert.equal(f.count, 2);
  assert.deepEqual(f.samples.map((s) => s.value), ['"o"', '2n']);
}

// E552: tehlikeli çağrıya giden argümanın tanımları yalnızca ilgili birim analiz edilerek bulunur
{
  const s = sinkQueries(parse('function a(){ var x = 1; } function run(){ var code = "alert(1)"; new Function(code); } function c(){}'));
  assert.equal(s.sinks.length, 1);
  assert.equal(s.sinks[0].constant, '"alert(1)"');
  assert.deepEqual(s.sinks[0].defs.map((d) => d.kind), ['init']);
  assert.equal(s.analyzedUnits, 1);
  assert.equal(s.units, 4);
}

const host = createHost(await getQuickJS());
const sandbox = sandboxApi(async (msg) => host.handle(msg));
const input = `var _0x1 = ['log', 'hi'];
function f(c) { var x = 1; x = 2; if (c) { return new Date(0).getHours(); } return x; }
console[_0x1[0]](_0x1[1], f(0), /(?<=a)b/.test('ab'));
Promise.reject(new Error('r'));
setTimeout(function later() {}, 0);`;
const trace = createTrace({ keepComments: true });
const res = await deobfuscate(input, { level: 4, sandbox, trace });
const report = await analyze({ input, text: res.text, output: res.code, events: res.events, sandbox, trace });
const s = report.semantics;
assert.ok(s.semantics.strict && s.semantics.regex && s.semantics.time);
assert.ok(s.dataflow.functions >= 2);
assert.ok(s.shadow && typeof s.shadow.total === 'number');
assert.ok(s.minify && typeof s.minify.safe === 'boolean');
assert.equal(s.infra.serialization.roundTrip, true);
assert.deepEqual(s.infra.dag.violations, []);
assert.ok(s.infra.trace.rationale.length > 0);
assert.ok(s.runtime.ok, s.runtime.reason ?? s.runtime.error);
assert.ok(s.runtime.unhandled.some((u) => u.reason === 'r'));
assert.ok(s.runtime.order.some((o) => o.phase === 'makro'));
assert.ok(s.regexEngines.compared >= 1);
// rapor JSON'a dönüşebilmeli (dışa aktarma)
assert.doesNotThrow(() => JSON.stringify(report));

console.log('analysis-report: ok');
