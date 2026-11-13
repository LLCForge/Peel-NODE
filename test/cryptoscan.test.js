// Kripto taraması: sabit tanıma, anahtar/IV/mod/dolgu tespiti ve gömülü verinin çözümü: node test/cryptoscan.test.js
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { cryptoScan, cryptoConstants } from '../src/core/cryptoscan.js';
import { aesCipher } from '../src/crypto/aes.js';
import { desCipher } from '../src/crypto/des.js';
import { blowfishCipher } from '../src/crypto/blowfish.js';
import { xxteaEncrypt } from '../src/crypto/tea.js';
import { cbcEncrypt, ecbEncrypt, pkcs7Pad } from '../src/crypto/modes.js';
import { evpBytesToKey } from '../src/crypto/stream.js';
import { utf8 } from '../src/crypto/index.js';
import { modPow } from '../src/crypto/rsa.js';
import { parse } from '../src/core/parse.js';
import { traverse } from '../src/util/ast.js';

const b64 = (u8) => Buffer.from(u8).toString('base64');
const hex = (u8) => Buffer.from(u8).toString('hex');
const strings = (code) => {
  const out = [];
  traverse(parse(code), { StringLiteral(p) { out.push(p.node.value); } });
  return out;
};
const scan = (code, extra = {}) => cryptoScan({ code, strings: strings(code), ...extra });

// E611/E612: sabit imzaları
const aesSbox = '[0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,0xca]';
const names = cryptoConstants(`var S=${aesSbox}; var h=[0x67452301,0xefcdab89,0x98badcfe,0x10325476]; var k=[0xd76aa478,0xe8c7b756];
  var d=0x9e3779b9; var c="expand 32-byte k"; var w=[0x428a2f98,0x71374491]; var crc=0xedb88320;`).map((c) => c.name);
for (const n of ['AES S-box', 'MD5', 'MD5/SHA-1 başlangıç değeri', 'TEA/XTEA/XXTEA delta', 'ChaCha20/Salsa20 sabiti', 'SHA-256', 'CRC32']) assert.ok(names.includes(n), n);
assert.ok(cryptoConstants('var d = -1640531527;').some((c) => c.name === 'TEA/XTEA/XXTEA delta'), 'işaretli delta');
assert.deepEqual(cryptoConstants('var x = 1 + 2;'), []);

// E75: CryptoJS AES-CBC (anahtar ve IV Utf8.parse ile koddan)
const key = '0123456789abcdef';
const iv = 'fedcba9876543210';
const ct = b64(cbcEncrypt(aesCipher(utf8(key)), pkcs7Pad(utf8('https://c2.example/beacon'), 16), utf8(iv)));
let r = scan(`var k = CryptoJS.enc.Utf8.parse("${key}");
  var out = CryptoJS.AES.decrypt("${ct}", k, { iv: CryptoJS.enc.Utf8.parse("${iv}"), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }).toString(CryptoJS.enc.Utf8);`);
assert.equal(r.decrypted[0].text, 'https://c2.example/beacon');
assert.equal(r.decrypted[0].mode, 'CBC');
assert.equal(r.decrypted[0].padding, 'pkcs7');
assert.ok(r.modes.some((m) => m.mode === 'AES-CBC'));
assert.ok(r.paddings.some((p) => p.startsWith('pkcs7')));
assert.ok(r.ivs.length >= 1);

// CryptoJS parola modu (Salted__ + EVP_BytesToKey) — E614 tuz tespiti
const salt = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2]);
const { key: dk, iv: div } = evpBytesToKey(utf8('s3cret'), salt, 32, 16);
const salted = b64([...utf8('Salted__'), ...salt, ...cbcEncrypt(aesCipher(dk), pkcs7Pad(utf8('steal()'), 16), div)]);
r = scan(`var p = CryptoJS.AES.decrypt("${salted}", "s3cret").toString(CryptoJS.enc.Utf8);`);
assert.equal(r.decrypted[0].text, 'steal()');
assert.ok(r.salts.some((s) => s.kind === 'OpenSSL Salted__' && s.salt === '0908070605040302'));

// AES-CTR (Node crypto ile şifrelenmiş, createDecipheriv çağrısından)
const k32 = nodeCrypto.randomBytes(32);
const ctr = nodeCrypto.randomBytes(16);
const c = nodeCrypto.createCipheriv('aes-256-ctr', k32, ctr);
const ctrData = Buffer.concat([c.update('document.cookie gönder'), c.final()]);
r = scan(`var d = require("crypto").createDecipheriv("aes-256-ctr", Buffer.from("${hex(k32)}", "hex"), Buffer.from("${hex(ctr)}", "hex"));
  var blob = "${b64(ctrData)}"; var key2 = "x"; d.update(blob);`);
assert.equal(r.calls[0].alg, 'AES');
assert.equal(r.calls[0].mode, 'CTR');
// veri ayrı değişkende: genel deneme CTR'yi IV adayıyla çözer
assert.ok(r.decrypted.some((x) => x.text === 'document.cookie gönder'), JSON.stringify(r.decrypted));

// E76: DES-ECB ve 3DES (Node), E79: Blowfish-CBC, E78: XXTEA
const desCt = b64(ecbEncrypt(desCipher(utf8('8bytekey')), pkcs7Pad(utf8('des gizli'), 8)));
r = scan(`CryptoJS.DES.decrypt("${desCt}", CryptoJS.enc.Utf8.parse("8bytekey"), { mode: CryptoJS.mode.ECB });`);
assert.equal(r.decrypted[0].text, 'des gizli');
const k24 = nodeCrypto.randomBytes(24);
const iv8 = nodeCrypto.randomBytes(8);
const c3 = nodeCrypto.createCipheriv('des-ede3-cbc', k24, iv8);
const tdesCt = Buffer.concat([c3.update('3des gizli metin'), c3.final()]);
r = scan(`CryptoJS.TripleDES.decrypt("${b64(tdesCt)}", CryptoJS.enc.Hex.parse("${hex(k24)}"), { iv: CryptoJS.enc.Hex.parse("${hex(iv8)}") });`);
assert.equal(r.decrypted[0].text, '3des gizli metin');
assert.equal(r.decrypted[0].alg, '3DES');
const bfCt = b64(cbcEncrypt(blowfishCipher(utf8('blowkey!')), pkcs7Pad(utf8('blowfish ile saklandı'), 8), utf8('initvect')));
r = scan(`CryptoJS.Blowfish.decrypt("${bfCt}", CryptoJS.enc.Utf8.parse("blowkey!"), { iv: CryptoJS.enc.Utf8.parse("initvect") });`);
assert.equal(r.decrypted[0].text, 'blowfish ile saklandı');
const plainX = utf8('xxtea yükü');
const padded = new Uint8Array(Math.ceil((plainX.length + 4) / 4) * 4);
padded.set(plainX);
new DataView(padded.buffer).setUint32(padded.length - 4, plainX.length, true);
const xxCt = b64(xxteaEncrypt(padded, utf8('anahtar-16-bayt!')));
r = scan(`var s = XXTEA.decryptToString("${xxCt}", "anahtar-16-bayt!");`);
assert.equal(r.decrypted[0].text, 'xxtea yükü');

// Genel deneme: API yok, anahtar isimsiz string, veri base64
const loose = b64(cbcEncrypt(aesCipher(utf8('k3y_k3y_k3y_k3y_')), pkcs7Pad(utf8('gizli uç nokta: /gate.php'), 16), new Uint8Array(16)));
r = scan(`var a = ["k3y_k3y_k3y_k3y_", "${loose}"]; f(a[0], a[1]);`);
assert.ok(r.decrypted.some((x) => x.text === 'gizli uç nokta: /gate.php' && x.source === 'kaba deneme'));

// E77: RSA — PEM özel anahtarla PKCS#1 v1.5 çözüm
const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
const rsaCt = nodeCrypto.publicEncrypt({ key: publicKey, padding: nodeCrypto.constants.RSA_PKCS1_PADDING }, Buffer.from('rsa ile korunan komut')).toString('base64');
r = scan(`var jse = new JSEncrypt(); jse.setPrivateKey(${JSON.stringify(pem)}); var m = jse.decrypt("${rsaCt}");`);
assert.equal(r.rsa[0].private, true);
assert.equal(r.rsa[0].decrypted[0].text, 'rsa ile korunan komut');
assert.equal(r.rsa[0].decrypted[0].padding, 'pkcs1');
// yalnızca açık anahtar parçaları: küçük modül çarpanlarına ayrılır
const p = 4294967311n;
const q = 4294967357n;
const n = p * q;
const msg = BigInt(`0x${Buffer.from('hi!').toString('hex')}`);
const rsaC = modPow(msg, 65537n, n).toString(16).padStart(16, '0');
r = scan(`var pub = { n: "${n.toString(16)}", e: 65537 }; var c = "${rsaC}";`);
assert.equal(r.rsa[0].recovered, 'factor');
assert.equal(r.rsa[0].decrypted[0].text, 'hi!');

// E624/E615: ECB tekrarları moddan bağımsız raporlanır
const blk = ecbEncrypt(aesCipher(utf8(key)), new Uint8Array(48));
r = scan(`var z = "${b64(blk)}";`);
assert.ok(r.modes.some((m) => m.mode.startsWith('ECB')));

console.log('cryptoscan: ok');
