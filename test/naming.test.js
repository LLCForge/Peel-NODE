// Anlamlandırma modüllerinin birim testleri (D ve E-H maddeleri)
import assert from 'node:assert/strict';
import { parse } from '../src/core/parse.js';
import { raw, pretty } from '../src/core/emit.js';
import { traverse } from '../src/util/ast.js';
import { renameAll, applyNameMap, listSuggestions, serializeNameMap, parseNameMap } from '../src/naming/names.js';
import { scan, renameBlocker } from '../src/naming/scope.js';
import { createInferer, toDts } from '../src/naming/types.js';
import { summarizeFunction, programSummary } from '../src/naming/summary.js';
import { explain } from '../src/naming/explain.js';
import { sequence } from '../src/naming/sequence.js';
import { readability, complexity, compareReadability } from '../src/naming/metrics.js';
import { unresolved } from '../src/naming/unresolved.js';
import { deadRegions } from '../src/naming/deadcode.js';
import { splitBundle } from '../src/core/bundle.js';
import { zip, crc32 } from '../src/naming/zip.js';
import { annotatedDiff, lineDiff } from '../src/naming/diffnotes.js';
import { libraryVersions } from '../src/naming/libversion.js';
import { pickModel, parseModelNames, suggestNames, webgpuStatus } from '../src/naming/llm.js';
import { canonical } from '../src/passes/98-dedupe.js';
import { machineSwitch, decompile } from '../src/naming/regenerator.js';
import * as comments from '../src/passes/99-comments.js';
import * as magic from '../src/passes/98-magic.js';
import { namingReport } from '../src/naming/index.js';

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}
const noop = { onLog: () => {}, bump: () => {} };
const bindingNamed = (ast, name) => {
  let b = null;
  traverse(ast, { Identifier(p) { if (!b && p.node.name === name && p.scope.getBinding(name)) b = p.scope.getBinding(name); } });
  return b;
};

await test('72/E222–E226: kural tabanlı ad önerisi', () => {
  const code = `var _0x1 = document.getElementById("login-btn");
function _0x2(_0x3) { _0x3.preventDefault(); return fetch("/api/user/profile").then(function (_0x4) { return _0x4.json(); }); }
_0x1.addEventListener("click", _0x2);
["a"].forEach(function (_0x5, _0x6) {});
var _0x7 = new XMLHttpRequest();
function _0x8(_0x9) { return _0x9 > 3; }`;
  const ast = parse(code);
  const { renamed } = renameAll(ast);
  const to = Object.fromEntries(renamed.map((r) => [r.from, r.to]));
  assert.equal(to._0x1, 'loginBtn');      // E225
  assert.equal(to._0x2, 'onClick');       // E226
  assert.equal(to._0x3, 'event');         // E223
  assert.equal(to._0x4, 'response');      // E222 (fetch().then)
  assert.equal(to._0x5, 'item');
  assert.equal(to._0x6, 'index');
  assert.equal(to._0x7, 'xhr');
  assert.match(to._0x8, /^is\w*Valid$|^check$/); // E224: boolean döndüren fiil
});

await test('E227/E228/E230: with, window.x ve eval kapsamları korunur', () => {
  const ast = parse(`var _0xa = 1; var _0xb = 2; console.log(window._0xa);
function f(_0xc) { return eval("_0xc"); }
function g(o) { with (o) { var _0xd = 1; } return _0xd; }
function h(_0xe) { return _0xe + 1; }`);
  const info = scan(ast);
  assert.ok(renameBlocker(info, bindingNamed(ast, '_0xa'))); // with/eval varken global'ler korunur
  assert.equal(renameBlocker(info, bindingNamed(ast, '_0xc')), 'eval');
  assert.equal(renameBlocker(info, bindingNamed(ast, '_0xd')), 'with');
  assert.equal(renameBlocker(info, bindingNamed(ast, '_0xe')), null);
  const ast2 = parse('var _0xa = 1; var _0xb = 2; console.log(window._0xa, _0xb);');
  const info2 = scan(ast2);
  assert.equal(renameBlocker(info2, bindingNamed(ast2, '_0xa')), 'window.x');
  assert.equal(renameBlocker(info2, bindingNamed(ast2, '_0xb')), null);
});

await test('E231/87/88/E232: ad haritası, sözlük, paylaşım ve orijinal ad yorumu', async () => {
  const r = await applyNameMap('function a(b) { return b + 1; } a(1);', { a: 'inc', b: 'value' }, { originalComments: true });
  assert.match(r.code, /function inc \/\* a \*\/\(value \/\* b \*\/\)/);
  assert.equal(r.renamed.length, 2);
  // çakışan ad uygulanmaz
  const c = await applyNameMap('var x = 1; var y = 2; console.log(x, y);', { x: 'y' });
  assert.equal(c.skipped.length, 1);
  const json = serializeNameMap({ a: 'inc' }, 'abc');
  const back = parseNameMap(json);
  assert.deepEqual(back.names, { a: 'inc' });
  assert.equal(back.source, 'abc');
  const bad = parseNameMap('{"ok":"fine","x":"1bad","__proto__":"y"}');
  assert.deepEqual(bad.names, { ok: 'fine' });
  assert.ok(!parseNameMap('[1,2]').ok);
  assert.ok(!parseNameMap('not json').ok);
});

await test('76: tip çıkarımı ve .d.ts', () => {
  const ast = parse('function add(a, b) { return a + b; } add(1, 2); var name = "x"; var list = [1, 2]; class P { constructor(n) { this.n = n; } get() { return this.n; } } new P(3);');
  const dts = toDts(ast);
  assert.match(dts, /declare function add\(a: number, b: number\): number;/);
  assert.match(dts, /declare var name: string;/);
  assert.match(dts, /declare var list: number\[\];/);
  assert.match(dts, /declare class P \{/);
  assert.match(dts, /constructor\(n: number\);/);
  const inf = createInferer();
  let ty;
  traverse(ast, { FunctionDeclaration(p) { ty = inf.fn(p).returns; } });
  assert.equal(ty, 'number');
});

await test('73/81: fonksiyon özeti ve program paragrafı', () => {
  const ast = parse('function save(k, v) { localStorage.setItem(k, v); } function send(d) { return fetch("https://x.example/api", { method: "POST", body: d }); } save("a", 1); send("x");');
  let text = '';
  traverse(ast, { FunctionDeclaration(p) { if (p.node.id.name === 'send') text = summarizeFunction(p).text; } });
  assert.match(text, /ağ isteği yapar/i);
  const para = programSummary(ast);
  assert.match(para, /2 fonksiyon/);
  assert.match(para, /ağ isteği/);
  assert.match(para, /depolama/);
});

await test('80: satır satır açıklama (TR/EN)', () => {
  const ast = parse('var el = document.getElementById("x");\nif (el) {\n  el.textContent = "hi";\n}\nfor (const n of [1]) console.log(n);');
  const tr = explain(ast, 'tr');
  assert.match(tr.find((e) => e.line === 1).text, /"x" kimlikli elemanı bulur/);
  assert.match(tr.find((e) => e.line === 2).text, /Koşul/);
  assert.match(tr.find((e) => e.line === 5).text, /her n için/);
  const en = explain(ast, 'en');
  assert.match(en.find((e) => e.line === 1).text, /finds the element with id "x"/);
});

await test('82: sihirli sayı adlandırma', async () => {
  const ast = parse('function k(e) { return e.keyCode === 13; } setTimeout(k, 60000); var crc = 0xedb88320;');
  await magic.run(ast, noop);
  const out = raw(ast);
  assert.match(out, /const KEY_ENTER = 13;/);
  assert.match(out, /e\.keyCode === KEY_ENTER/);
  assert.match(out, /setTimeout\(k, MS_PER_MINUTE\)/);
  assert.match(out, /var crc = CRC32_POLY;/);
});

await test('84: ölü kod bölgeleri', () => {
  const ast = parse('function f() {\n  return 1;\n  console.log("x");\n}\nif (false) {\n  g();\n}\nfunction unused() {}\nf();');
  const r = deadRegions(ast);
  assert.ok(r.some((x) => x.start === 3 && /erişilemeyen/.test(x.reason)));
  assert.ok(r.some((x) => x.start === 5 || x.start === 6));
  assert.ok(r.some((x) => /çağrılmayan/.test(x.reason)));
});

await test('85: kopya fonksiyonların yapısal eşitliği', () => {
  const ast = parse('function a(x) { var y = x + 1; return y; } function b(p) { var q = p + 1; return q; } function c(p) { return p - 1; }');
  const codes = [];
  traverse(ast, { FunctionDeclaration(p) { codes.push(canonical(p)); } });
  assert.equal(codes[0], codes[1]);
  assert.notEqual(codes[0], codes[2]);
});

await test('86: modül indirme (ZIP) ve AMD paketleri motorun ayırıcısında', () => {
  const amd = splitBundle('define("a", ["b"], function (b) { return b + 1; }); define("b", [], function () { return 1; });');
  assert.equal(amd.kind, 'amd');
  assert.deepEqual(amd.modules.map((m) => [m.id, m.deps]), [['a', ['b']], ['b', []]]);
  const z = zip([{ name: '../evil/a.js', text: 'x' }]);
  assert.equal(new DataView(z.buffer).getUint32(0, true), 0x04034b50);
  assert.ok(!new TextDecoder().decode(z).includes('../'));
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

await test('91: sekans diyagramı', () => {
  const ast = parse('function load() { fetch("/a"); } function init() { load(); console.log("ok"); } init();');
  const seq = sequence(ast);
  assert.deepEqual(seq.participants.slice(0, 3), ['Program', 'init', 'load']);
  const labels = seq.messages.map((m) => `${m.from}>${m.to}`);
  assert.ok(labels.indexOf('Program>init') < labels.indexOf('init>load'));
  assert.ok(labels.includes('load>Ağ'));
  assert.ok(labels.includes('init>Konsol'));
});

await test('92/93/E240: okunabilirlik skoru ve karmaşıklık', () => {
  const ugly = 'var _0x1=function(_0x2,_0x3){if(_0x2){if(_0x3){return 0x1}}return 0x2};';
  const nice = 'function pick(first, second) {\n  if (first && second) return 1;\n  return 2;\n}\n';
  const cmp = compareReadability(ugly, nice);
  assert.ok(cmp.after.score > cmp.before.score);
  assert.ok(cmp.before.hexLiterals === 2);
  assert.equal(readability(nice).meaningfulNames, 1);
  const fns = complexity(parse(nice));
  assert.equal(fns[0].complexity, 3);
});

await test('94: çözülemeyenler', () => {
  const code = 'var _0xabc = 1; var t = tbl[0x1f]; dec(0x12, 0x3); eval(code); debugger;';
  const u = unresolved(parse(code), code);
  for (const k of ['identifier', 'table', 'decoder', 'dynamic-code', 'anti-debug']) assert.ok(u.counts[k] >= 1, k);
});

await test('95: açıklamalı fark', () => {
  const steps = annotatedDiff([{ id: 'girdi', round: 0, code: 'a\nb\nc\nd' }, { id: 'rename', round: 1, code: 'a\nB\nc\nd' }, { id: 'unused', round: 1, code: 'a\nB\nd' }]);
  assert.equal(steps.length, 2);
  assert.match(steps[0].note, /adlandırıldı/);
  assert.equal(steps[0].added, 1);
  assert.equal(steps[1].removed, 1);
  assert.equal(lineDiff('x', 'x').hunks.length, 0);
});

await test('75: kütüphane sürümü (yorum ve sabitten)', () => {
  const ast = parse('/*! jQuery v3.7.1 */\nvar lodash = { VERSION: "4.17.21" };\nvar axios = {}; axios.VERSION = "1.6.0";');
  const v = libraryVersions(ast, ['jQuery', 'lodash', 'axios']);
  const by = Object.fromEntries(v.map((x) => [x.name, x.version]));
  assert.deepEqual(by, { jQuery: '3.7.1', lodash: '4.17.21', axios: '1.6.0' });
});

await test('71: yerel LLM seçimi, çıktı doğrulama ve kural tabanlı geri dönüş', async () => {
  const list = [{ model_id: 'Llama-3-8B-q4f16_1-MLC', vram_required_MB: 5000, low_resource_required: false },
    { model_id: 'Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC', vram_required_MB: 500, low_resource_required: true }];
  assert.equal(pickModel(list), 'Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC');
  assert.equal(pickModel([{ model_id: 'Tiny-q4f16_1-MLC', vram_required_MB: 100, low_resource_required: true }]), 'Tiny-q4f16_1-MLC');
  const names = parseModelNames('Sure! {"_0x1": "userName", "_0x2": "1bad", "other": "x"}', new Set(['_0x1', '_0x2']));
  assert.deepEqual(names, { _0x1: 'userName' });
  assert.equal((await webgpuStatus()).ok, false); // Node'da WebGPU yok
  const r = await suggestNames('var _0x1 = document.getElementById("main-menu");');
  assert.equal(r.source, 'rules');
  assert.equal(r.names._0x1, 'mainMenu');
});

await test('E239: biçim profilleri', async () => {
  const code = 'function f(a){return a+"x"}';
  assert.match(await pretty(code, 'standard'), /return a \+ 'x'\n/);
  assert.match(await pretty(code, 'tabs'), /\n\treturn/);
  assert.match(await pretty(code, 'default'), /return a \+ "x";/);
});

await test('E237: kaybolan yorumun geri yüklenmesi', async () => {
  const source = '/*! lisans */\n// toplama yapar\nfunction add(a, b) { return a + b; }\n// silinen kodun yorumu\nfunction gone() {}\nadd(1, 2);';
  const ast = parse('function add(a, b) { return a + b; }\nadd(1, 2);');
  await comments.run(ast, { ...noop, source });
  const out = raw(ast);
  assert.match(out, /\/\*! lisans \*\//);
  assert.match(out, /\/\/ toplama yapar\s*\nfunction add/);
  assert.ok(!out.includes('silinen kodun yorumu'));
});

await test('79: regenerator durum makinesinin yapılandırılması', () => {
  const code = `function f$(ctx) { while (1) switch (ctx.prev = ctx.next) {
    case 0: i = 0;
    case 1: if (!(i < 3)) { ctx.next = 7; break; } ctx.next = 4; return i;
    case 4: i++; ctx.next = 1; break;
    case 7: case "end": return ctx.stop(); } }`;
  const fn = parse(code).program.body[0];
  const sw = machineSwitch(fn, 'ctx');
  assert.ok(sw);
  const res = decompile(sw, 'ctx', []);
  const out = raw({ type: 'File', program: { type: 'Program', body: res.body, directives: [], sourceType: 'script' }, comments: [] });
  assert.match(out, /while \(i < 3\) \{\s*yield i;\s*i\+\+;\s*\}/);
});

await test('analiz raporu: naming alanı', () => {
  const r = namingReport({ input: 'var _0x1 = 1;', text: 'var _0x1 = 1;', output: 'var _0x1 = 1;\nconsole.log(_0x1);' });
  assert.ok(typeof r.summary === 'string' && r.summary.length > 0);
  assert.ok(r.readability.after.score >= 0);
  assert.ok(r.suggestions.some((x) => x.name === '_0x1'));
  assert.ok(listSuggestions('var a = 1;').length === 1);
});

console.log(failed ? `\n${failed} test başarısız` : '\ntüm anlamlandırma testleri geçti');
process.exit(failed ? 1 : 0);
