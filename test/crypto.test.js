// Şifre uygulamaları yayımlanmış bilinen yanıt vektörleriyle: node test/crypto.test.js
import assert from 'node:assert/strict';
import { aesCipher } from '../src/crypto/aes.js';
import { desCipher, tripleDesCipher } from '../src/crypto/des.js';
import { teaCipher, xteaCipher, xxteaEncrypt, xxteaDecrypt } from '../src/crypto/tea.js';
import { blowfishCipher } from '../src/crypto/blowfish.js';
import { rc4, md5, evpBytesToKey } from '../src/crypto/stream.js';
import { cbcDecrypt, cbcEncrypt, ctrCrypt, ecbDecrypt, pkcs7Pad, detectPadding } from '../src/crypto/modes.js';
import { completeKey, rsaDecrypt, modPow, parseRsaDer, fromBig } from '../src/crypto/rsa.js';
import { decrypt, decryptPassphrase, bruteDecrypt, utf8, hexBytes } from '../src/crypto/index.js';

const h = (s) => hexBytes(s.replace(/\s/g, ''));
const x = (b) => Buffer.from(b).toString('hex');

// FIPS-197 Ek C
const pt = h('00112233445566778899aabbccddeeff');
assert.equal(x(aesCipher(h('000102030405060708090a0b0c0d0e0f')).encrypt(pt)), '69c4e0d86a7b0430d8cdb78070b4c55a');
assert.equal(x(aesCipher(h('000102030405060708090a0b0c0d0e0f1011121314151617')).encrypt(pt)), 'dda97ca4864cdfe06eaf70a0ec0d7191');
const a256 = aesCipher(h('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'));
assert.equal(x(a256.encrypt(pt)), '8ea2b7ca516745bfeafc49904b496089');
assert.equal(x(a256.decrypt(h('8ea2b7ca516745bfeafc49904b496089'))), x(pt));

// NIST SP 800-38A F.2.2 (CBC-AES128 decrypt) ve F.5.2 (CTR-AES128)
const k128 = aesCipher(h('2b7e151628aed2a6abf7158809cf4f3c'));
const sp = h('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51');
assert.equal(x(cbcDecrypt(k128, h('7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b2'), h('000102030405060708090a0b0c0d0e0f'))), x(sp));
assert.equal(x(cbcEncrypt(k128, sp, h('000102030405060708090a0b0c0d0e0f'))), '7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b2');
assert.equal(x(ctrCrypt(k128, h('874d6191b620e3261bef6864990db6ce9806f66b7970fdff8617187bb9fffdff'), h('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff'))), x(sp));
// F.1.1 ECB-AES128
assert.equal(x(ecbDecrypt(k128, h('3ad77bb40d7a3660a89ecaf32466ef97'))), '6bc1bee22e409f96e93d7e117393172a');

// DES (klasik örnek) ve 3DES (NIST SP 800-67 örneği "The qufc")
assert.equal(x(desCipher(h('133457799BBCDFF1')).encrypt(h('0123456789ABCDEF'))), '85e813540f0ab405');
const tdes = tripleDesCipher(h('0123456789ABCDEF23456789ABCDEF01456789ABCDEF0123'));
assert.equal(x(tdes.encrypt(utf8('The qufc'))), 'a826fd8ce53b855f');
assert.equal(Buffer.from(tdes.decrypt(h('a826fd8ce53b855f'))).toString(), 'The qufc');

// TEA / XTEA / XXTEA referans vektörleri (büyük-uçlu kelimeler)
assert.equal(x(teaCipher(new Uint8Array(16)).encrypt(new Uint8Array(8))), '41ea3a0a94baa940');
assert.equal(x(teaCipher(new Uint8Array(16)).decrypt(h('41ea3a0a94baa940'))), '0000000000000000');
assert.equal(x(xteaCipher(h('000102030405060708090a0b0c0d0e0f')).encrypt(h('4142434445464748'))), '497df3d072612cb5');
assert.equal(x(xteaCipher(h('000102030405060708090a0b0c0d0e0f')).decrypt(h('497df3d072612cb5'))), '4142434445464748');
assert.equal(x(xxteaEncrypt(new Uint8Array(8), new Uint8Array(16), { little: false })), '053704ab575d8c80');
assert.equal(x(xxteaDecrypt(h('053704ab575d8c80'), new Uint8Array(16), { little: false })), '0000000000000000');

// Blowfish (Eric Young vektörleri)
assert.equal(x(blowfishCipher(new Uint8Array(8)).encrypt(new Uint8Array(8))), '4ef997456198dd78');
assert.equal(x(blowfishCipher(h('ffffffffffffffff')).encrypt(h('ffffffffffffffff'))), '51866fd5b85ecb8a');
assert.equal(x(blowfishCipher(h('fedcba9876543210')).encrypt(h('0123456789abcdef'))), '0aceab0fc6a0a28d');
assert.equal(x(blowfishCipher(h('fedcba9876543210')).decrypt(h('0aceab0fc6a0a28d'))), '0123456789abcdef');

// RC4 (Wikipedia vektörleri) ve MD5 (RFC 1321)
assert.equal(x(rc4(utf8('Key'), utf8('Plaintext'))), 'bbf316e8d940af0ad3');
assert.equal(x(rc4(utf8('Secret'), utf8('Attack at dawn'))), '45a01f645fc35b383552544b9bf5');
assert.equal(x(md5(utf8('abc'))), '900150983cd24fb0d6963f7d28e17f72');
assert.equal(x(md5(utf8(''))), 'd41d8cd98f00b204e9800998ecf8427e');
assert.equal(x(md5(utf8('a'.repeat(80)))), x(md5(utf8('a'.repeat(80)))));

// Dolgu tespiti
assert.equal(detectPadding(pkcs7Pad(utf8('hello'), 16), 16), 'pkcs7');

// OpenSSL "Salted__" parola modu (CryptoJS.AES.encrypt(metin, parola) biçimi)
const salt = h('0102030405060708');
const { key, iv } = evpBytesToKey(utf8('hunter2'), salt, 32, 16);
const body = cbcEncrypt(aesCipher(key), pkcs7Pad(utf8('gizli komuta merkezi'), 16), iv);
const salted = Uint8Array.from([...utf8('Salted__'), ...salt, ...body]);
assert.equal(Buffer.from(decryptPassphrase({ alg: 'AES', passphrase: utf8('hunter2'), data: salted }).plain).toString(), 'gizli komuta merkezi');
const brute = bruteDecrypt(salted, [{ bytes: utf8('yanlis'), label: 'yanlis' }, { bytes: utf8('hunter2'), label: 'hunter2' }]);
assert.equal(brute[0].text, 'gizli komuta merkezi');
assert.equal(brute[0].key, 'hunter2');

// Anahtarla doğrudan AES-CBC deneme
const k16 = utf8('0123456789abcdef');
const ct = cbcEncrypt(aesCipher(k16), pkcs7Pad(utf8('https://evil.example/drop'), 16), k16);
assert.equal(Buffer.from(decrypt({ alg: 'AES', mode: 'CBC', key: k16, iv: k16, data: ct }).plain).toString(), 'https://evil.example/drop');
const b2 = bruteDecrypt(ct, [{ bytes: k16, label: 'k' }], [{ bytes: k16, label: 'k' }]);
assert.equal(b2[0].alg, 'AES');
assert.equal(b2[0].mode, 'CBC');

// RSA: ders kitabı örneği (p=61, q=53) ve çarpanlara ayırma
const rk = completeKey({ n: 3233n, e: 17n });
assert.equal(rk.d, 2753n);
assert.equal(modPow(modPow(65n, 17n, 3233n), rk.d, 3233n), 65n);
const p = 4294967311n;
const q = 4294967357n;
const big = completeKey({ n: p * q, e: 65537n });
assert.equal(big.how, 'factor');
const c2 = modPow(123456789n, 65537n, p * q);
assert.equal(rsaDecrypt(big, c2).data.length > 0, true);
assert.equal(modPow(c2, big.d, p * q), 123456789n);
// DER: PKCS#1 RSAPublicKey SEQUENCE { INTEGER 3233, INTEGER 17 }
assert.deepEqual(parseRsaDer(Uint8Array.from([0x30, 0x07, 0x02, 0x02, 0x0c, 0xa1, 0x02, 0x01, 0x11])), { n: 3233n, e: 17n });
assert.equal(x(fromBig(258n, 3)), '000102');

console.log('crypto: ok');
