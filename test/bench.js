// Gerçek obfuscator.io (javascript-obfuscator) ve js-confuser çıktılarıyla PEEL benchmark'ı.
// Kullanım: node bench.mjs [filtre]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import JavaScriptObfuscator from 'javascript-obfuscator';
import JsConfuser from 'js-confuser';

// Gerçek obfuscator çıktıları üzerinde uçtan uca ölçüm. Kullanım: npm run bench [filtre]
import { newQuickJSWASMModule } from 'quickjs-emscripten';
import { deobfuscate } from '../src/core/pipeline.js';
import { createHost, sandboxApi } from '../src/sandbox/core.js';

const SOURCE = `
function greet(name) { return "Hello, " + name + "!"; }
var config = { endpoint: "https://api.example.com/v1/collect", retries: 3, debug: false };
function sum(list) { var s = 0; for (var i = 0; i < list.length; i++) s += list[i]; return s; }
class Counter { constructor() { this.n = 0; } inc() { this.n++; return this.n; } }
var c = new Counter(); c.inc(); c.inc();
var words = ["alpha", "beta", "gamma"].map(function (w) { return w.toUpperCase(); });
console.log(greet("PEEL"));
console.log(config.endpoint, config.retries * 2, sum([1, 2, 3, 4]));
console.log(words.join("-"), c.n, typeof config.debug);
if (config.debug) { console.log("debug mode"); } else { console.log("production"); }
`;
// greet("PEEL") sabit sonucuna katlanabilir ("Hello, PEEL!"): ikisi de kabul
const NEEDLES = ['"Hello, ', '"https://api.example.com/v1/collect"', '"alpha"', '"production"', 'toUpperCase', '.join(', 'console.log'];

// Etiket, nesne anahtarları, sınıf alanları, şablon, regex, try/catch, switch: SOURCE'un kapsamadığı dönüşümler için
const RICH = `
var settings = { mode: "fast", limits: { max: 10, min: 2 }, tags: ["x", "y"] };
var re = /a(b+)c/g;
class Shape {
  static count = 0;
  #secret = "hidden";
  constructor(w, h) { this.w = w; this.h = h; Shape.count++; }
  get area() { return this.w * this.h; }
  reveal() { return this.#secret; }
}
function classify(n) {
  switch (n % 3) { case 0: return "fizz"; case 1: return "one"; default: return "other"; }
}
function scan(rows) {
  var found = -1;
  outer: for (var i = 0; i < rows.length; i++) {
    for (var j = 0; j < rows[i].length; j++) {
      if (rows[i][j] === 7) { found = i * 10 + j; break outer; }
    }
  }
  return found;
}
var { mode, limits: { max } } = settings;
var s = new Shape(3, 4);
var label = \`area=\${s.area} mode=\${mode}\`;
try { JSON.parse("{bad"); } catch (e) { console.log("caught", e.name); }
console.log(label, max, settings.tags.length, Shape.count, s.reveal());
console.log([0, 1, 2, 5].map(classify).join(","), scan([[1, 2], [3, 7]]));
console.log("abbc-abc".replace(re, function (m, g) { return g.length; }));
`;
const NEEDLES_RICH = ['"fast"', '"hidden"', '"fizz"', '"caught"', 'JSON.parse', 'console.log', '.join('];

// javascript-obfuscator: her seçenek ayrı ayrı, kombinasyonlar ve hazır ayarlar.
// src: 'rich' → RICH kaynağı. self: true → beklenen çıktı kaynağın değil gizlenmiş kodun kendi çıktısı
// (disableConsoleOutput/domainLock gibi davranışı bilerek değiştiren seçenekler).
const OBF_IO = {
  'io-default': {},
  'io-preset-low': { self: true, optionsPreset: 'low-obfuscation' },
  'io-preset-medium': { self: true, optionsPreset: 'medium-obfuscation' },
  'io-preset-high': { self: true, optionsPreset: 'high-obfuscation' },
  'io-nostrarray': { stringArray: false },
  'io-base64': { stringArray: true, stringArrayEncoding: ['base64'], stringArrayThreshold: 1 },
  'io-rc4': { stringArray: true, stringArrayEncoding: ['rc4'], stringArrayThreshold: 1 },
  'io-mixenc': { stringArray: true, stringArrayEncoding: ['none', 'base64', 'rc4'], stringArrayThreshold: 1 },
  'io-norotate': { stringArray: true, stringArrayRotate: false, stringArrayShuffle: false, stringArrayIndexShift: false, stringArrayThreshold: 1 },
  'io-idxstring': { stringArray: true, stringArrayIndexesType: ['hexadecimal-numeric-string'], stringArrayThreshold: 1 },
  'io-idxmix': { stringArray: true, stringArrayIndexesType: ['hexadecimal-number', 'hexadecimal-numeric-string'], stringArrayThreshold: 1 },
  'io-wrappers': { stringArray: true, stringArrayThreshold: 1, rotateStringArray: true, shuffleStringArray: true, stringArrayWrappersCount: 2, stringArrayWrappersType: 'function', stringArrayWrappersChainedCalls: true, stringArrayIndexShift: true },
  'io-wrap-var': { stringArray: true, stringArrayThreshold: 1, stringArrayWrappersCount: 3, stringArrayWrappersType: 'variable', stringArrayWrappersChainedCalls: false },
  'io-wrap-varchain': { stringArray: true, stringArrayThreshold: 1, stringArrayWrappersCount: 3, stringArrayWrappersType: 'variable', stringArrayWrappersChainedCalls: true },
  'io-wrap-fn5': { stringArray: true, stringArrayThreshold: 1, stringArrayWrappersCount: 5, stringArrayWrappersType: 'function', stringArrayWrappersParametersMaxCount: 5, stringArrayWrappersChainedCalls: false, stringArrayEncoding: ['base64'] },
  'io-callstx': { stringArray: true, stringArrayThreshold: 1, stringArrayCallsTransform: true, stringArrayCallsTransformThreshold: 1 },
  'io-cff': { controlFlowFlattening: true, controlFlowFlatteningThreshold: 1, stringArrayThreshold: 1 },
  'io-cff-rich': { src: 'rich', controlFlowFlattening: true, controlFlowFlatteningThreshold: 1, stringArrayThreshold: 1 },
  'io-deadcode': { deadCodeInjection: true, deadCodeInjectionThreshold: 1, stringArrayThreshold: 1 },
  'io-protect': { selfDefending: true, debugProtection: true, disableConsoleOutput: false },
  'io-selfdef': { selfDefending: true },
  'io-debugprot': { debugProtection: true },
  'io-debugint': { debugProtection: true, debugProtectionInterval: 4000 },
  'io-noconsole': { self: true, disableConsoleOutput: true },
  'io-domainlock': { self: true, domainLock: ['example.com', '.peel.dev'], domainLockRedirectUrl: 'https://example.org/blocked' },
  'io-domainlock-miss': { self: true, domainLock: ['cuiqingcai.com'] },
  'io-objkeys': { transformObjectKeys: true, stringArrayThreshold: 1 },
  'io-objkeys-rich': { src: 'rich', transformObjectKeys: true, stringArrayThreshold: 1 },
  'io-renameprops': { src: 'rich', renameProperties: true, renamePropertiesMode: 'safe' },
  'io-renameprops-unsafe': { src: 'rich', renameProperties: true, renamePropertiesMode: 'unsafe' },
  'io-renameglobals': { renameGlobals: true, stringArrayThreshold: 1 },
  'io-numbers': { numbersToExpressions: true, simplify: true },
  'io-numbers-nosimp': { numbersToExpressions: true, simplify: false, stringArray: false },
  'io-split': { splitStrings: true, splitStringsChunkLength: 3, stringArrayThreshold: 1 },
  'io-split1': { splitStrings: true, splitStringsChunkLength: 1, stringArray: false },
  'io-unicode': { unicodeEscapeSequence: true, stringArrayThreshold: 1 },
  'io-unicode-only': { unicodeEscapeSequence: true, stringArray: false },
  'io-names-mangled': { identifierNamesGenerator: 'mangled', stringArrayThreshold: 1 },
  'io-names-shuffled': { identifierNamesGenerator: 'mangled-shuffled', stringArrayThreshold: 1 },
  'io-names-dict': { identifierNamesGenerator: 'dictionary', identifiersDictionary: ['foo', 'bar', 'baz', 'qux', 'quux', 'corge', 'grault', 'garply', 'waldo', 'fred', 'plugh', 'xyzzy', 'thud'], stringArrayThreshold: 1 },
  'io-names-prefix': { identifiersPrefix: 'peel', renameGlobals: true, stringArrayThreshold: 1 },
  'io-target-node': { target: 'node', selfDefending: true, debugProtection: true, stringArrayEncoding: ['rc4'], stringArrayThreshold: 1 },
  'io-target-noeval': { target: 'browser-no-eval', selfDefending: true, debugProtection: true, stringArrayThreshold: 1 },
  'io-target-sw': { target: 'service-worker', debugProtection: true, stringArrayThreshold: 1 },
  'io-nosimplify': { simplify: false, stringArrayThreshold: 1, controlFlowFlattening: true, controlFlowFlatteningThreshold: 1 },
  'io-reserved': { reservedStrings: ['alpha'], reservedNames: ['^greet$'], stringArrayThreshold: 1 },
  'io-high': { compact: true, controlFlowFlattening: true, controlFlowFlatteningThreshold: 1, deadCodeInjection: true, deadCodeInjectionThreshold: 1, numbersToExpressions: true, simplify: true, splitStrings: true, splitStringsChunkLength: 5, stringArray: true, stringArrayCallsTransform: true, stringArrayCallsTransformThreshold: 1, stringArrayEncoding: ['rc4'], stringArrayIndexShift: true, stringArrayRotate: true, stringArrayShuffle: true, stringArrayWrappersCount: 5, stringArrayWrappersChainedCalls: true, stringArrayWrappersParametersMaxCount: 5, stringArrayWrappersType: 'function', stringArrayThreshold: 1, transformObjectKeys: true },
  'io-everything': { src: 'rich', compact: true, controlFlowFlattening: true, controlFlowFlatteningThreshold: 1, deadCodeInjection: true, deadCodeInjectionThreshold: 1, debugProtection: true, debugProtectionInterval: 2000, identifierNamesGenerator: 'mangled-shuffled', numbersToExpressions: true, renameGlobals: true, renameProperties: true, selfDefending: true, splitStrings: true, splitStringsChunkLength: 4, stringArrayCallsTransform: true, stringArrayCallsTransformThreshold: 1, stringArrayEncoding: ['base64', 'rc4'], stringArrayIndexesType: ['hexadecimal-numeric-string'], stringArrayWrappersCount: 3, stringArrayWrappersType: 'function', stringArrayThreshold: 1, transformObjectKeys: true, unicodeEscapeSequence: true },
};
// js-confuser 2.1.3: her dönüşüm tek başına, kilitler ayrı ayrı, isim üreticileri ve hazır ayarlar
const CONFUSER = {
  'jc-low': { target: 'browser', preset: 'low' },
  'jc-medium': { target: 'browser', preset: 'medium' },
  'jc-high': { target: 'browser', preset: 'high' },
  'jc-high-rich': { src: 'rich', target: 'browser', preset: 'high' },
  'jc-node': { target: 'node', preset: 'medium' },
  'jc-strings': { target: 'browser', stringConcealing: true, stringEncoding: true, stringSplitting: true },
  'jc-concealing': { target: 'browser', stringConcealing: true },
  'jc-encoding': { target: 'browser', stringEncoding: true },
  'jc-splitting': { target: 'browser', stringSplitting: true },
  'jc-custom-enc': { target: 'browser', stringConcealing: true, customStringEncodings: [{ code: 'function {fnName}(s) { return s.split("").reverse().join(""); }', encode: (s) => s.split('').reverse().join('') }] },
  'jc-flatten': { target: 'browser', flatten: true, dispatcher: true },
  'jc-flatten-only': { target: 'browser', flatten: true },
  'jc-dispatcher': { target: 'browser', dispatcher: true },
  'jc-cff': { target: 'browser', controlFlowFlattening: true },
  'jc-cff-rich': { src: 'rich', target: 'browser', controlFlowFlattening: true },
  'jc-globals': { target: 'browser', globalConcealing: true, renameVariables: true },
  'jc-globalconceal': { target: 'browser', globalConcealing: true },
  'jc-calc': { target: 'browser', calculator: true, duplicateLiteralsRemoval: true, objectExtraction: true },
  'jc-calculator': { target: 'browser', calculator: true },
  'jc-dupliterals': { target: 'browser', duplicateLiteralsRemoval: true },
  'jc-objextract': { src: 'rich', target: 'browser', objectExtraction: true },
  'jc-opaque': { target: 'browser', opaquePredicates: true, deadCode: true },
  'jc-opaque-only': { target: 'browser', opaquePredicates: true },
  'jc-deadcode': { target: 'browser', deadCode: true },
  'jc-moved': { target: 'browser', movedDeclarations: true },
  'jc-rgf': { target: 'browser', rgf: true },
  'jc-varmask': { target: 'browser', variableMasking: true },
  'jc-pack': { target: 'browser', pack: true },
  'jc-minify': { src: 'rich', target: 'browser', minify: true },
  'jc-scrambler': { target: 'browser', astScrambler: true },
  'jc-hexnum': { target: 'browser', hexadecimalNumbers: true, compact: false },
  'jc-fnlength': { target: 'browser', flatten: true, rgf: true, dispatcher: true, preserveFunctionLength: true },
  'jc-labels': { src: 'rich', target: 'browser', renameLabels: true },
  'jc-rename-hex': { target: 'browser', renameVariables: true, renameGlobals: true, identifierGenerator: 'hexadecimal' },
  'jc-rename-mangled': { target: 'browser', renameVariables: true, renameGlobals: true, identifierGenerator: 'mangled' },
  'jc-rename-number': { target: 'browser', renameVariables: true, renameGlobals: true, identifierGenerator: 'number' },
  'jc-rename-zerowidth': { target: 'browser', renameVariables: true, renameGlobals: true, identifierGenerator: 'zeroWidth' },
  'jc-rename-chinese': { target: 'browser', renameVariables: true, renameGlobals: true, identifierGenerator: 'chinese' },
  'jc-lock-selfdef': { target: 'browser', lock: { selfDefending: true } },
  'jc-lock-antidebug': { target: 'browser', lock: { antiDebug: true } },
  'jc-lock-tamper': { target: 'browser', lock: { tamperProtection: true } },
  'jc-lock-dates': { target: 'browser', lock: { startDate: new Date('2000-01-01'), endDate: new Date('2100-01-01') } },
  'jc-lock-domain': { self: true, target: 'browser', lock: { domainLock: ['example.com'] } },
  'jc-lock-integrity': { target: 'browser', lock: { integrity: true } },
  'jc-lock-all': { self: true, target: 'browser', lock: { selfDefending: true, antiDebug: true, integrity: true, tamperProtection: true, domainLock: [/example\.com$/], startDate: new Date('2000-01-01'), endDate: new Date('2100-01-01') } },
};
// Bir kez üretilip depoya konan örnekler: test/corpus/<araç>/*.js (jfogs, webpack-obfuscator paketi, eski
// javascript-obfuscator 0.18, JSFuck/AAEncode/JJEncode). Beklenen davranış girdinin kendi çıktısıdır;
// dosyada "// NEEDLES: a | b" satırı varsa çıktıda bu parçalar aranır.
const CORPUS = new URL('./corpus/', import.meta.url);

function runNode(code) {
  const out = [];
  // zamanlayıcılar çalıştırılmaz (debugProtectionInterval / antiDebug döngüleri)
  const ctx = { console: { log: (...a) => out.push(a.map(String).join(' ')) }, setInterval: () => 0, clearInterval: () => {} };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  try { vm.runInNewContext(code, ctx, { timeout: 3000 }); } catch (e) { out.push(`!THROW ${e.message}`); }
  return out.join('\n');
}

const filter = process.argv[2];
const outDir = new URL('./bench-out/', import.meta.url);
mkdirSync(outDir, { recursive: true });
const expected = runNode(SOURCE);
const expectedRich = runNode(RICH);

const rows = [];
async function bench(name, obfuscated, { expect = expected, needles = NEEDLES } = {}) {
  const file = name.replace(/[^\w.-]/g, '_');
  writeFileSync(new URL(`${file}.in.js`, outDir), obfuscated);
  const t0 = performance.now();
  const logs = [];
  // her örneğe taze WASM modülü: kesilen/taşan bir çalıştırma modülü kirletip sonraki örnekleri düşürmesin
  const host = createHost(await newQuickJSWASMModule());
  const sandbox = sandboxApi(async (msg) => host.handle(msg));
  let r;
  try {
    r = await deobfuscate(obfuscated, { level: 4, sandbox, deep: true, onLog: (m, lv) => logs.push(`[${lv}] ${m}`) });
  } catch (e) {
    rows.push({ name, ok: false, why: e.message });
    return;
  }
  writeFileSync(new URL(`${file}.out.js`, outDir), r.code);
  writeFileSync(new URL(`${file}.log`, outDir), logs.join('\n'));
  const same = runNode(r.code) === expect;
  const found = needles.filter((n) => r.code.includes(n)).length;
  rows.push({
    name, same, score: `${found}/${needles.length}`, inKB: (obfuscated.length / 1024).toFixed(1),
    outKB: (r.code.length / 1024).toFixed(1), ms: Math.round(performance.now() - t0),
    rollbacks: logs.filter((l) => l.includes('geri alındı')).length,
  });
}

const pick = (o) => (o.src === 'rich'
  ? { source: RICH, expect: expectedRich, needles: NEEDLES_RICH }
  : { source: SOURCE, expect: expected, needles: NEEDLES });
const strip = ({ src, self, ...o }) => o;

for (const [name, opts] of Object.entries(OBF_IO)) {
  if (filter && !name.includes(filter)) continue;
  const { source, expect, needles } = pick(opts);
  const code = JavaScriptObfuscator.obfuscate(source, { seed: 42, target: 'browser', ...strip(opts) }).getObfuscatedCode();
  await bench(name, code, { expect: opts.self ? runNode(code) : expect, needles });
}
for (const [name, opts] of Object.entries(CONFUSER)) {
  if (filter && !name.includes(filter)) continue;
  const { source, expect, needles } = pick(opts);
  const res = await JsConfuser.obfuscate(source, strip(opts));
  const code = typeof res === 'string' ? res : res.code;
  // js-confuser 2.1.3'ün CFF'si bazı çekimlerde sınıf özel alanını (#secret = "hidden") bozar: gizlenmiş programın
  // kendi davranışıdır. Yalnızca bu satır farklıysa (self ön ayarları gibi) beklenen çıktı gizlenmiş kodunkidir
  // ve "hidden" iğnesi aranmaz; diğer her fark gerçek hata olarak kalır.
  const own = opts.self ? null : runNode(code);
  if (own !== null && own !== expect && privateFieldCorrupted(own, expect)) {
    await bench(`${name} (#secret bozuk)`, code, { expect: own, needles: needles.filter((n) => n !== '"hidden"') });
    continue;
  }
  await bench(name, code, { expect: opts.self ? runNode(code) : expect, needles });
}
function privateFieldCorrupted(own, expect) {
  const a = own.split('\n');
  const b = expect.split('\n');
  return a.length === b.length && a.every((l, i) => l === b[i] || (b[i].endsWith(' hidden') && l.startsWith(b[i].slice(0, -'hidden'.length)) &&
    !l.slice(b[i].length - 'hidden'.length).includes(' ')));
}
if (existsSync(CORPUS)) {
  for (const tool of readdirSync(CORPUS).sort()) {
    for (const f of readdirSync(new URL(`${tool}/`, CORPUS)).filter((x) => x.endsWith('.js')).sort()) {
      const name = `${tool}/${f.slice(0, -3)}`;
      if (filter && !name.includes(filter)) continue;
      const code = readFileSync(new URL(`${tool}/${f}`, CORPUS), 'utf8');
      const needles = (code.match(/^\/\/ NEEDLES: (.*)$/m)?.[1] ?? '').split(' | ').filter(Boolean);
      await bench(name, code, { expect: runNode(code), needles });
    }
  }
}
console.table(rows);
