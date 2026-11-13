// I189: SBOM üreteci ve sürüm iş akışı: node test/sbom.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSbom } from '../scripts/sbom.js';
import { passHashes } from '../scripts/regress-select.js';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const bom = buildSbom(lock, { prodOnly: true, timestamp: '2026-01-01T00:00:00Z' });
assert.equal(bom.bomFormat, 'CycloneDX');
assert.equal(bom.specVersion, '1.5');
const qjs = bom.components.find((c) => c.name === 'quickjs-emscripten');
assert.ok(qjs && /^pkg:npm\/quickjs-emscripten@/.test(qjs.purl) && qjs.hashes[0].alg === 'SHA-512' && /^[0-9a-f]{128}$/.test(qjs.hashes[0].content));
assert.ok(bom.components.some((c) => c.purl.startsWith('pkg:npm/%40babel/parser@')));
assert.ok(!bom.components.some((c) => c.name === 'vite'), '--prod geliştirme bağımlılıklarını dışlar');
assert.equal(bom.components.find((c) => c.name === 'z3-solver').scope, 'optional');
assert.ok(bom.dependencies[0].dependsOn.length >= 8);
assert.deepEqual(buildSbom(lock, { timestamp: 'x' }), buildSbom(lock, { timestamp: 'x' }), 'deterministik');
const wf = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
for (const s of ['id-token: write', 'attest-build-provenance', 'attest-sbom', 'scripts/sbom.js', 'SHA256SUMS', 'npm ci']) assert.ok(wf.includes(s), s);
// E714: pass kaynak özetleri regresyon seçimine girer
assert.ok(Object.values(passHashes()).every((h) => /^[0-9a-f]+$/.test(h)));
console.log('sbom: ok');
