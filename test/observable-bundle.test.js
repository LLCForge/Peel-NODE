// H168: tek dosyalık ESM paketini derler, yalnızca o dosyayı içe aktarır ve gerçek bir örneği çözer.
// Paket başka dosyaya (wasm, parça) referans vermemeli: Observable'a tek FileAttachment olarak eklenir.
// node test/observable-bundle.test.js
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = await mkdtemp(join(tmpdir(), 'peel-lib-'));
try {
  await build({ root, configFile: join(root, 'vite.lib.config.js'), logLevel: 'error', build: { outDir: out } });
  assert.deepEqual(await readdir(out), ['peel.js'], 'paket tek dosya olmalı');
  const text = await readFile(join(out, 'peel.js'), 'utf8');
  assert.ok(text.includes('data:application/wasm;base64'), 'QuickJS wasm gömülü olmalı');
  assert.ok(!/\bimport\s*\(\s*["'`]\.{0,2}\//.test(text) && !/^import .* from ["']/m.test(text), 'göreli içe aktarma kalmamalı');

  const p = await import(pathToFileURL(join(out, 'peel.js')).href);
  const r = await p.peel('var _0x1 = ["aHR0cHM6Ly9ldmlsLmV4YW1wbGUvYw==", "bG9n"]; function _0x2(i) { return atob(_0x1[i]); } console[_0x2(1)](_0x2(0));');
  assert.equal(r.code, 'console.log("https://evil.example/c");\n');
  assert.equal(r.verified, true);
  assert.deepEqual(r.report.iocs.urls, ['https://evil.example/c']);
  assert.equal(p.semanticDiff('function a(x) { return x + 1; }', 'function b(y) { return y + 1; }').summary.equivalent, true);
  assert.ok(p.detectTechniques('var _0x1 = ["a"]; atob("aGk=")').some((x) => x.id === 'base64-strings'));
} finally {
  await rm(out, { recursive: true, force: true });
}
console.log('observable-bundle: ok');
