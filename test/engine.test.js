// Çözme motoru birim testleri: sandbox'sız statik çözme ve rapor analizleri (fixture'larla sınanamayanlar)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import JO from 'javascript-obfuscator';
import { deobfuscate } from '../src/core/pipeline.js';
import { obfuscatorSettings, flowReport, integrityReport, deadCodeReport } from '../src/core/engine-report.js';
import { splitBundle } from '../src/core/bundle.js';
import { parse } from '@babel/parser';
import { generate } from '../src/util/ast.js';

let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}

const SRC = `function greet(name){ var msg = "Hello, " + name + "!"; console.log(msg); return msg.length; }
console.log(greet("world")); console.log("second string here");`;
const obf = (o) => JO.obfuscate(SRC, { compact: true, seed: 7, stringArray: true, stringArrayThreshold: 1, rotateStringArray: true, ...o }).getObfuscatedCode();

// A-3 / A-5: sandbox yokken RC4/base64 string dizisi, ofset ve rotasyon statik çözülür
for (const enc of ['none', 'base64', 'rc4']) {
  await check(`statik string dizisi (${enc}, sandbox yok)`, async () => {
    const code = obf({ stringArrayEncoding: [enc], stringArrayWrappersCount: 2, stringArrayWrappersType: 'function', numbersToExpressions: true });
    const r = await deobfuscate(code, { level: 4, sandbox: null });
    assert.ok(r.stats.staticStrings > 0, 'staticStrings sayacı yok');
    assert.ok(r.code.includes('"Hello, "'), r.code.slice(0, 300));
    assert.ok(r.code.includes('"second string here"'));
    assert.ok(!/_0x[0-9a-f]+\(/.test(r.code), 'decoder çağrısı kaldı');
  });
}

// A-2: ayar çıkarımı
await check('obfuscator.io ayar çıkarımı', () => {
  const code = obf({ stringArrayEncoding: ['rc4'], controlFlowFlattening: true, controlFlowFlatteningThreshold: 1, numbersToExpressions: true });
  const r = obfuscatorSettings(code, '');
  assert.ok(r, 'tespit yok');
  assert.equal(r.settings.stringArray, true);
  assert.equal(r.settings.stringArrayEncoding, 'rc4');
  assert.equal(r.settings.rotateStringArray, true);
  assert.equal(r.settings.identifierNamesGenerator, 'hexadecimal');
  assert.equal(r.settings.numbersToExpressions, true);
  assert.equal(typeof r.settings.stringArrayIndexOffset, 'number');
});

// A-24: paket bölme
await check('webpack 4 modül dizisi', () => {
  const code = `(function (modules) { var installedModules = {}; function __webpack_require__(id) { var m = { exports: {} }; modules[id].call(m.exports, m, m.exports, __webpack_require__); return m.exports; } return __webpack_require__(0); })([
    function (module, exports, __webpack_require__) { var util = __webpack_require__(1); console.log(util.twice(2)); },
    function (module, exports) { exports.twice = function (x) { return x * 2; }; }
  ]);`;
  const b = splitBundle(code);
  assert.equal(b.kind, 'webpack');
  assert.equal(b.modules.length, 2);
  assert.deepEqual(b.modules[0].deps, ['1']);
  assert.ok(b.modules[1].code.includes('exports.twice'));
});
await check('webpack 5 chunk push', () => {
  const code = `(self["webpackChunkapp"] = self["webpackChunkapp"] || []).push([[179], { 42: (e, t, n) => { const a = n(7); e.exports = a + 1; }, 7: (e) => { e.exports = 41; } }]);`;
  const b = splitBundle(code);
  assert.equal(b.kind, 'webpack');
  assert.deepEqual(b.modules.map((m) => m.id).sort(), ['42', '7']);
  assert.deepEqual(b.modules.find((m) => m.id === '42').deps, ['7']);
});
await check('esbuild __commonJS', () => {
  const code = `var __commonJS = (cb, mod) => function __require() { return mod || (0, cb[Object.keys(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports; };
  var require_math = __commonJS({ "src/math.js"(exports, module) { module.exports = { add: (a, b) => a + b }; } });
  var require_main = __commonJS({ "src/main.js"(exports) { var m = require_math(); console.log(m.add(1, 2)); } });
  require_main();`;
  const b = splitBundle(code);
  assert.equal(b.kind, 'esbuild');
  assert.deepEqual(b.modules.find((m) => m.id === 'src/main.js').deps, ['src/math.js']);
});
await check('browserify', () => {
  const code = `(function () { function r(e, n, t) { return e; } return r; })()({ 1: [function (require, module, exports) { var b = require("./b"); console.log(b); }, { "./b": 2 }], 2: [function (require, module, exports) { module.exports = 5; }, {}] }, {}, [1]);`;
  const b = splitBundle(code);
  assert.equal(b.kind, 'browserify');
  assert.deepEqual(b.modules.find((m) => m.id === '1').deps, ['2']);
});
await check('yol yorumlu kapsam birleştirmeli paket', () => {
  const code = `(function () {\n  // src/util.js\n  function double(x) { return x * 2; }\n  // src/main.js\n  console.log(double(4));\n})();`;
  const b = splitBundle(code);
  assert.equal(b.kind, 'scope-hoisted');
  assert.deepEqual(b.modules.find((m) => m.id === 'src/main.js').deps, ['src/util.js']);
});

await check('kaynak haritalı (Rollup tipi) paket', () => {
  const files = { 'src/util.js': 'function triple(x) { return x * 3; }', 'src/main.js': 'console.log(triple(2));' };
  const bodies = Object.entries(files).flatMap(([name, code]) => parse(code, { sourceFilename: name }).program.body);
  const out = generate({ type: 'File', program: { type: 'Program', body: bodies, directives: [], sourceType: 'script' } }, { sourceMaps: true }, files);
  const code = `${out.code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(out.map)).toString('base64')}`;
  const b = splitBundle(code);
  assert.equal(b.kind, 'source-map');
  assert.deepEqual(b.modules.map((m) => m.id), ['src/util.js', 'src/main.js']);
  assert.deepEqual(b.modules[1].deps, ['src/util.js']);
});

// E173 / E174 / E175: akış raporu
await check('akış raporu: özyineleme ve açılamayan makine', () => {
  const code = `function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }
  function even(n) { return n === 0 ? true : odd(n - 1); }
  function odd(n) { return n === 0 ? false : even(n - 1); }
  function machine(input) { var s = 0; while (s !== 9) { switch (s) { case 0: s = input() ? 3 : 5; break; case 3: s += 6; break; case 5: return 1; } } return 0; }`;
  const f = flowReport(code, code);
  assert.ok(f.recursion.some((r) => r.kind === 'direct' && r.functions.includes('fact')));
  assert.ok(f.recursion.some((r) => r.kind === 'mutual' && r.functions.includes('even') && r.functions.includes('odd')));
  assert.equal(f.unresolved.length, 1);
  assert.ok(f.unresolved[0].mermaid.startsWith('flowchart TD'));
  assert.ok(f.unresolved[0].dot.includes('"3" -> "9"'));
  assert.ok(f.unresolved[0].dot.includes('"0" -> "5"'));
  assert.ok(f.functions >= 4 && f.loops === 1);
});

// E204 / E205 / E207: bütünlük ve konsol
await check('bütünlük ve konsol raporu', () => {
  const text = readFileSync(new URL('./fixtures/jc-integrity.js', import.meta.url), 'utf8');
  const r = integrityReport(text, 'console.log(1);', { integrity: 2 });
  assert.equal(r.checks.filter((c) => c.kind === 'hash').length, 2);
  assert.equal(r.neutralized, 2);
  assert.equal(r.remaining, 0);
  const c = integrityReport('var m = ["log","warn","info","error","exception","table","trace"]; setInterval(function () { console.clear(); }, 10);', '', {});
  assert.ok(c.console.some((x) => x.kind === 'disableConsoleOutput'));
  assert.ok(c.console.some((x) => x.kind === 'consoleClearLoop'));
});

// E220: ölü kod türleri
await check('ölü kod türleri', () => {
  const d = deadCodeReport({ 'dead.debugger': 2, 'dead.unreachable': 5, deadCode: 7, 'dead.noop': 0 });
  assert.deepEqual(d, [{ type: 'unreachable', count: 5 }, { type: 'debugger', count: 2 }]);
});

console.log(fail ? `\n${fail} başarısız` : '\ntümü geçti');
process.exit(fail ? 1 : 0);
