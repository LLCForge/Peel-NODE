#!/usr/bin/env node
// test/node-samples/*.b64 üreticisi: gerçek araç çıktılarından (pkg, nexe, SEA, bytenode, npm pack, asar, zip)
// küçük, kodlu test örnekleri. Yürütülebilir dosyalar (~95 MB) seyrek saklanır: yalnızca açıcının okuduğu
// bölgeler (başlıklar, yük, prelude, sentinel, blob) gerçek ofsetleriyle tutulur, aradaki baytlar testte sıfırla
// doldurulur. Dosyalar XOR+base64 kodludur (antivirüs imzalarına takılmasın diye), yalnızca bellekte çözülür.
// Kullanım: node scripts/make-node-samples.js <ad>=<dosya> [...]   (ad: sea-*, pkg-*, nexe-*, ya da tam dosya)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { encodeFixture } from '../test/helpers/fixture-codec.js';
import { unpack, findBytes } from '../src/node/unpack.js';

const OUT = new URL('../test/node-samples/', import.meta.url);
mkdirSync(OUT, { recursive: true });

function sparse(buf, ranges) {
  const merged = [];
  for (const [a, b] of ranges.map(([a, b]) => [Math.max(0, a), Math.min(buf.length, b)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else merged.push([a, b]);
  }
  return { size: buf.length, chunks: merged.map(([a, b]) => [a, buf.subarray(a, b).toString('base64')]) };
}

for (const arg of process.argv.slice(2)) {
  const [name, file] = arg.split('=');
  const buf = readFileSync(file);
  const r = await unpack(new Uint8Array(buf), file);
  let data;
  if (r.kind === 'sea') {
    const m = r.meta;
    const ranges = [[0, 4096], [m.fuse.offset - 32, m.fuse.offset + 96], [m.blobOffset, m.blobOffset + 8192]];
    // koddaki aynı sihirli sayı (yanlış pozitif) da tutulur: açıcının doğrulaması test edilsin
    const magic = Uint8Array.of(0x20, 0xda, 0x43, 0x01);
    for (let i = findBytes(buf, magic); i >= 0 && i !== m.blobOffset; i = findBytes(buf, magic, i + 1)) ranges.push([i - 32, i + 64]);
    data = sparse(buf, ranges);
  } else if (r.kind === 'pkg') {
    const m = r.meta;
    data = sparse(buf, [[0, 4096], [m.payloadOffset - 512, m.preludeOffset + 256], [buf.length - 8192, buf.length]]);
  } else if (r.kind === 'nexe') {
    const m = r.meta;
    data = sparse(buf, [[0, 4096], [m.contentStart, m.contentStart + 512], [m.contentStart + m.contentSize - 4096, buf.length]]);
  } else {
    data = { size: buf.length, chunks: [[0, buf.toString('base64')]] };
  }
  writeFileSync(new URL(`${name}.b64`, OUT), encodeFixture(Buffer.from(JSON.stringify(data))));
  console.log(`${name}: ${r.kind}, ${data.chunks.length} parça, ${data.chunks.reduce((a, c) => a + c[1].length, 0)} b64 karakter`);
}
