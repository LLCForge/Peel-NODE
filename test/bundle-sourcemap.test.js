// Bundle eklentileri (Parcel, modül dosyaları/ZIP) ve source map (harici harita ile isim kurtarma, çıktı haritası):
// node test/bundle-sourcemap.test.js
import assert from 'node:assert/strict';
import { splitBundle, moduleFiles } from '../src/core/bundle.js';
import { generateSourceMap, attachInlineMap, vlqEncode } from '../src/core/sourcemap.js';
import { decodeMappings } from '../src/util/sourcemap.js';
import { parseZip, zipStore } from '../src/security/archive.js';
import { deobfuscate } from '../src/core/pipeline.js';

// --- E58: Parcel ve indirilebilir modül dosyaları
const parcel = 'parcelRegister("abc", function(module, exports) { var d = parcelRequire("def"); module.exports = d + 1; });\nparcelRegister("def", function(module, exports) { module.exports = 1; });';
const s = splitBundle(parcel);
assert.equal(s.kind, 'parcel');
assert.deepEqual(s.modules.map((m) => m.id), ['abc', 'def']);
assert.deepEqual(s.modules[0].deps, ['def']);
const wp5 = '(()=>{var __webpack_modules__=({"./src/util.js":(module)=>{module.exports=function(){return 1}},"./src/index.js":(__unused,__exports,__webpack_require__)=>{const u=__webpack_require__("./src/util.js");console.log(u())}});})();';
const files = moduleFiles(splitBundle(wp5));
assert.deepEqual(files.map((f) => f.name), ['src/util.js', 'src/index.js']);
const z = zipStore(files);
assert.deepEqual(parseZip(z).map((e) => e.name), ['src/util.js', 'src/index.js']);
assert.equal(new TextDecoder().decode(parseZip(z)[1].data), files[1].text);

// --- E59: harici .map satır içi haritaya eklenip 05-sourcemap pass'iyle isimler kurtarılır
const gen = 'function a(b){var c=b+1;return c}globalThis.a=a;';
const col = (x) => gen.indexOf(x);
const raw = [[col('a('), 0, 0, 9, 0], [col('b)'), 0, 0, 13, 1], [col('c='), 0, 0, 30, 2]];
let prev = [0, 0, 0, 0, 0];
const mappings = raw.map((r) => { const e = r.map((v, i) => vlqEncode(v - prev[i])).join(''); prev = r; return e; }).join(',');
assert.deepEqual(decodeMappings(mappings)[0].map((x) => x[4]), [0, 1, 2]);
const withMap = attachInlineMap(gen, JSON.stringify({ version: 3, sources: ['inc.js'], names: ['inc', 'count', 'next'], mappings }));
const r = await deobfuscate(withMap, { only: ['sourcemap'], sandbox: null });
assert.match(r.code, /function inc\(count\)/);
assert.match(r.code, /var next = count \+ 1/);
assert.throws(() => attachInlineMap(gen, '{"version":2}'));

// --- E60: çıktı → girdi haritası
const input = 'var _0x1=["hi"];function f(){return _0x1[0]}console.log(f());';
const output = 'function f() {\n  return "hi";\n}\nconsole.log(f());\n';
const sm = generateSourceMap(input, output);
assert.equal(sm.map.version, 3);
assert.equal(sm.map.sourcesContent[0], input);
assert.ok(sm.coverage > 0.6, `kapsam ${sm.coverage}`);
const lines = decodeMappings(sm.map.mappings);
const consoleSeg = lines[3]?.find((x) => x[0] === 0);
assert.ok(consoleSeg, 'console satırı eşlenmeli');
assert.equal(consoleSeg[3], input.indexOf('console'));
assert.ok(sm.map.names.includes('console'));

console.log('bundle-sourcemap: ok');
