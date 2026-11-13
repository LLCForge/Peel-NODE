// Obfuscator imza veritabanı, otomatik profil, ayar geri çıkarma, sürüm, decoder zinciri, pass güveni:
// node test/detect.test.js
import assert from 'node:assert/strict';
import JavaScriptObfuscator from 'javascript-obfuscator';
import JsConfuser from 'js-confuser';
import { obfuscatorSettings } from '../src/core/engine-report.js';
import { detectTools, autoProfile, detectVersions, decoderChains, passConfidence, TOOL_COUNT, PROFILES } from '../src/core/detect.js';
import { PASSES } from '../src/core/registry.js';

const SRC = 'function greet(n){return "Hello, "+n+"!";} var config={endpoint:"https://api.example.com/v1/collect",retries:3}; function sum(a,b){return a+b;} console.log(greet("PEEL"), config.endpoint, sum(1,2));';
const io = (o) => JavaScriptObfuscator.obfuscate(SRC, o).getObfuscatedCode();
// E28 engine-report.obfuscatorSettings içinde: burada eklenen yetenekler (kodlanmış splitStrings, selfDefending denetleyicisi) denetlenir
const recoverConfig = (code) => obfuscatorSettings(code, code).settings;
const opt = (cfg, name) => cfg[name];

assert.ok(TOOL_COUNT >= 40, `imza sayısı ${TOOL_COUNT}`);
// profil pass adları kayıtlı pass'lerle tutarlı
const ids = new Set(PASSES.map((p) => p.id));
for (const [name, list] of Object.entries(PROFILES)) for (const id of list ?? []) assert.ok(ids.has(id), `${name}: ${id} kayıtlı değil`);

const b64 = io({ stringArrayEncoding: ['base64'], stringArrayThreshold: 1, stringArrayRotate: true });
const det = detectTools(b64);
assert.equal(det[0].name, 'obfuscator.io');
assert.ok(det[0].score >= 70);
assert.equal(autoProfile(det).profile, 'obfuscator-io');
assert.equal(autoProfile([]).passes, null, 'bilinmeyen araç: tüm pass\'ler');
let cfg = recoverConfig(b64);
assert.equal(opt(cfg, 'stringArrayEncoding'), 'base64');
assert.equal(opt(cfg, 'rotateStringArray'), true);
assert.equal(opt(cfg, 'identifierNamesGenerator'), 'hexadecimal');
assert.ok(opt(cfg, 'stringArrayThreshold') >= 0.75);

const rc4 = io({ stringArrayEncoding: ['rc4'], stringArrayThreshold: 1, splitStrings: true, splitStringsChunkLength: 4, identifierNamesGenerator: 'mangled', selfDefending: true });
cfg = recoverConfig(rc4);
assert.equal(opt(cfg, 'stringArrayEncoding'), 'rc4');
assert.equal(opt(cfg, 'identifierNamesGenerator'), 'mangled');
assert.equal(opt(cfg, 'splitStrings'), true);
assert.equal(opt(cfg, 'selfDefending'), true);

const wrapped = io({ stringArrayThreshold: 1, stringArrayIndexShift: true, stringArrayWrappersCount: 2, stringArrayWrappersType: 'function' });
assert.equal(opt(recoverConfig(wrapped), 'stringArrayWrappersType'), 'function');
assert.ok(detectVersions(wrapped).some((v) => v.version.startsWith('≥ 2.13')));
assert.ok(detectVersions(b64).some((v) => v.version.startsWith('≥ 2.10')));
assert.ok(decoderChains(wrapped).maxDepth >= 2, 'sarmalayıcı + decoder = en az 2 katman');
assert.equal(decoderChains(b64).maxDepth, 1);
// eski sürüm biçimi (0.x/1.x): global var dizi ve sayaçlı rotasyon
assert.ok(detectVersions("var _0x1a2b=['a','b'];(function(_0x1,_0x2){var _0x3=function(_0x4){while(--_0x4){_0x1['push'](_0x1['shift']());}};_0x3(++_0x2);}(_0x1a2b,0x1f));")
  .some((v) => v.version === '0.x – 1.x'));

const jc = await JsConfuser.obfuscate(SRC, { target: 'browser', dispatcher: true });
const jcDet = detectTools(jc.code ?? jc);
assert.equal(jcDet[0].name, 'js-confuser');
assert.ok(detectVersions(jc.code ?? jc).some((v) => v.tool === 'js-confuser' && v.version === '2.x'));

for (const [code, name] of [
  ['eval(function(p,a,c,k,e,d){return p}("x",1,1,"".split("|"),0,{}))', 'Dean Edwards packer'],
  ['var __webpack_require__ = 1; self.webpackChunk = [];', 'webpack'],
  ['var x = 1; // jsjiami.com.v7', 'jsjiami (sojson v6/v7)'],
  ['var __awaiter = (this && this.__awaiter) || function () {};', 'TypeScript'],
]) assert.equal(detectTools(code)[0].name, name, name);

// E27: güven skoru — doğrulanan çalışma yüksek, geri alınan pass düşük
const events = [{ id: 'literals', state: 'ok' }, { id: 'vm', state: 'ok' }, { id: 'vm', state: 'fail' }, { id: 'unused', state: 'skip' }];
const conf = passConfidence(events, { verified: true });
const lit = conf.find((c) => c.id === 'literals');
const vm = conf.find((c) => c.id === 'vm');
assert.ok(lit.score > 95 && lit.score <= 100);
assert.ok(vm.score < lit.score);
assert.ok(!conf.some((c) => c.id === 'unused'), 'yalnızca atlanan pass skorlanmaz');
assert.ok(passConfidence(events, { verified: false }).find((c) => c.id === 'literals').score < lit.score);

console.log('detect: ok');
