// Node paket açıcı testleri: node test/unpack.test.js
// Örnekler gerçek araç çıktılarından üretildi (scripts/make-node-samples.js): @yao-pkg/pkg 6.25, nexe 5.0.0-beta.4,
// Node 25.8.1 SEA (postject), bytenode, npm pack, @electron/asar, Compress-Archive. Yürütülebilirler seyrek saklanır
// (okunmayan bölgeler sıfır), gerçek ofsetler korunur. Hepsi XOR+base64 kodlu, yalnızca bellekte çözülür.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFixture } from './helpers/fixture-codec.js';
import { unpack, isContainer, scriptTargets } from '../src/node/unpack.js';
import { parseV8CacheHeader, extractStrings } from '../src/node/v8cache.js';
import { safeRel } from '../src/cli/run.js';

function sample(name) {
  const { size, chunks } = JSON.parse(decodeFixture(readFileSync(new URL(`./node-samples/${name}.b64`, import.meta.url), 'utf8')).toString());
  const out = new Uint8Array(size);
  for (const [off, b64] of chunks) out.set(Buffer.from(b64, 'base64'), off);
  return out;
}
const byPath = (r, p) => r.files.find((f) => f.path === p);

// --- Node SEA ---
{
  const r = await unpack(sample('sea'), 'sea.exe');
  assert.equal(r.kind, 'sea');
  assert.equal(r.meta.container, 'PE');
  assert.equal(r.meta.codePath, 'app/sea-main.js');
  assert.ok(r.meta.fuse?.enabled, 'SEA sigortası açık');
  const main = byPath(r, 'app/sea-main.js');
  assert.ok(main.entry && main.code.includes('peel-sea-marker-4412'), 'ana betik çıkarıldı');
  // koddaki aynı sihirli sayı yanlış pozitif olarak atlanmalı (örnekte iki tane var)
  assert.ok(r.meta.blobOffset > 90_000_000);
}
{
  const r = await unpack(sample('sea-codecache'), 'sea-cc.exe');
  assert.deepEqual(r.meta.flagNames, ['disableWarning', 'useCodeCache', 'includeAssets']);
  assert.ok(byPath(r, 'app/sea-main.js').code.includes('peel-sea-marker'));
  assert.equal(byPath(r, 'app/sea-main.js.codecache').code, null);
  assert.ok(r.meta.codeCache.header.complete);
  assert.match(byPath(r, 'assets/data.txt').code, /"peel-sample"/);
  assert.ok(r.notes.some((n) => n.includes('kod önbelleği')));
}

// --- pkg ---
{
  const r = await unpack(sample('pkg-bytecode'), 'app.exe');
  assert.equal(r.kind, 'pkg');
  assert.equal(r.meta.entrypoint, 'app/index.js');
  const idx = byPath(r, 'app/index.js');
  assert.ok(idx.entry && idx.code === null && /bytecode/.test(idx.note), 'bytecode: kaynak yok, not var');
  assert.match(byPath(r, 'app/package.json').code, /peel-sample/);
  const bc = r.meta.bytecode.find((b) => b.path === 'app/index.js');
  assert.ok(bc.strings.includes('peel-sample-marker-7731'), 'bytecode dizgeleri');
  assert.deepEqual(r.meta.iocs.urls, ['https://example.org/peel-sample']);
  assert.equal(bc.header.sourceLength, 258);
  assert.ok(r.notes.some((n) => n.includes('kaynağa çevrilemez')));
}
{
  const r = await unpack(sample('pkg-gzip'), 'app.exe');
  assert.equal(r.meta.compression, 'gzip');
  assert.ok(byPath(r, 'app/index.js').code.includes("require('./lib/helper.js')"), 'gzip + sözlük anahtarları çözüldü');
  assert.match(byPath(r, 'app/lib/helper.js').code, /hello-from-helper/);
}

// --- nexe ---
{
  const r = await unpack(sample('nexe'), 'app.exe');
  assert.equal(r.kind, 'nexe');
  assert.equal(r.meta.resourceFormat, 'zip');
  assert.equal(r.meta.entrypoint, 'app/index.js');
  assert.ok(byPath(r, 'app/index.js').entry);
  assert.match(byPath(r, 'app/lib/helper.js').code, /hello-from-helper/);
  assert.equal(byPath(r, 'nexe/content.js').code, null, 'nexe çalışma zamanı çözülmez');
}

// --- bytenode .jsc: çözülemez, yalnızca dizgeler ---
{
  const r = await unpack(sample('bytenode'), 'bn.jsc');
  assert.equal(r.kind, 'jsc');
  assert.equal(r.files[0].code, null);
  assert.equal(r.meta.v8.v8, 'V8 14.1.146 (Node 25.8.x)');
  assert.equal(r.meta.v8.headerSize, 32);
  assert.ok(r.meta.strings.includes('peel-sample-marker-7731'));
  assert.ok(r.notes[0].startsWith('çözülemez, yalnızca dizgeler'));
  const ioc = await unpack(sample('bytenode-ioc'), 'ioc.jsc');
  assert.ok(ioc.meta.iocs.urls.some((u) => u.includes('discord.com/api/webhooks/')), 'webhook dizgesi');
  assert.ok(ioc.meta.iocs.commands.some((c) => c.includes('whoami')));
  assert.deepEqual(ioc.meta.iocs.ips, ['203.0.113.77']);
  assert.equal(parseV8CacheHeader(Uint8Array.of(1, 2, 3)), null);
}

// --- npm .tgz ---
{
  const r = await unpack(sample('npm'), 'lodahs-99.1.0.tgz');
  assert.equal(r.kind, 'npm-tgz');
  assert.equal(r.meta.package.name, 'lodahs');
  assert.deepEqual(r.meta.package.lifecycle, { postinstall: 'node scripts/setup.js' });
  assert.deepEqual(r.meta.lifecycleTargets, { postinstall: ['scripts/setup.js'] });
  assert.ok(byPath(r, 'scripts/setup.js').entry, 'yaşam döngüsü dosyası entry');
  assert.ok(!byPath(r, 'lib/index.js').entry && /main/.test(byPath(r, 'lib/index.js').note));
  assert.match(byPath(r, 'bin/cli.js').note, /bin: lodahs/);
  assert.ok(r.notes.some((n) => n.includes('postinstall')));
}
assert.deepEqual(scriptTargets('node ./install && node lib/post.js --x', (p) => ['install.js', 'lib/post.js'].includes(p)), ['install.js', 'lib/post.js']);

// --- asar / zip ---
{
  const r = await unpack(sample('asar'), 'app.asar');
  assert.equal(r.kind, 'asar');
  assert.ok(byPath(r, 'index.js').entry);
  const z = await unpack(sample('zip'), 'app.zip');
  assert.equal(z.kind, 'zip');
  assert.match(byPath(z, 'lib/helper.js').code, /hello-from-helper/);
}

// --- düz JS, bilinmeyen, kapsayıcı tespiti ---
{
  const r = await unpack(new TextEncoder().encode('console.log(1)'), 'a.js');
  assert.equal(r.kind, 'js');
  assert.equal(r.files[0].code, 'console.log(1)');
  const u = await unpack(Uint8Array.of(0x4d, 0x5a, 0, 0, 1, 2, 3), 'x.exe');
  assert.equal(u.kind, 'unknown');
  assert.ok(isContainer(Uint8Array.of(0x1f, 0x8b, 8, 0), 'x'));
  assert.ok(!isContainer(new TextEncoder().encode('var a=1'), 'a.js'));
  assert.ok(extractStrings(new TextEncoder().encode('\x01\x02hello world\x00')).includes('hello world'));
}

// --- CLI: kapsayıcı yolları çıktı dizininden kaçamaz; asar uçtan uca ---
assert.equal(safeRel('../../etc/passwd'), 'etc/passwd');
assert.equal(safeRel('C:\\snapshot\\a\\b.js'), 'C_/snapshot/a/b.js');
{
  const dir = mkdtempSync(join(tmpdir(), 'peel-unpack-'));
  try {
    const asar = join(dir, 'app.asar');
    writeFileSync(asar, sample('asar'));
    const bin = fileURLToPath(new URL('../bin/peel-node.js', import.meta.url));
    const r = spawnSync(process.execPath, [bin, asar, '--json', '--no-sandbox', '-q', '-d', join(dir, 'out')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(r.stdout);
    const manifest = res.find((x) => x.unpack?.kind === 'asar' && x.unpack.files);
    assert.ok(manifest, 'kapsayıcı özeti JSON çıktısında');
    const idx = res.find((x) => x.unpack?.path === 'index.js');
    assert.ok(idx.ok && idx.unpack.entry && idx.out.replace(/\\/g, '/').endsWith('out/app.asar.unpacked/index.js'));
    assert.match(readFileSync(join(dir, 'out', 'app.asar.unpack.json'), 'utf8'), /"kind": "asar"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log('unpack: ok');
