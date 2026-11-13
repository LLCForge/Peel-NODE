// Node ortamı öykünmesinin host tarafı: QuickJS içindeki zlib/crypto taklitleri ağır saf hesapları (inflate, özet,
// AES) bu köprüye devreder. Yalnızca string alır, string verir (baytlar latin1); yan etkisi yok, ağ ve dosya yok.
// Sözleşme: __peelHostNode(op, JSON) → JSON { ok: true, v } | { ok: false, e }.
import { inflateRaw, inflateZlib, gunzip, isGzip, isZlib, adler32, crc32 } from '../compress/inflate.js';
import { aesCipher } from '../crypto/aes.js';
import { md5, evpBytesToKey } from '../crypto/stream.js';
import { ecbDecrypt, ecbEncrypt, cbcDecrypt, cbcEncrypt, ctrCrypt, cfbDecrypt, ofbCrypt } from '../crypto/modes.js';

const MAX_IN = 8 << 20;
const MAX_OUT = 16 << 20;
const MAX_KDF_WORK = 2_000_000; // pbkdf2 iterasyon × blok sayısı üst sınırı (host'u kilitlemesin)

const bytes = (s) => Uint8Array.from(String(s ?? ''), (c) => c.charCodeAt(0) & 255);
function str(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return s;
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// brotli çözücü büyük (sözlük): ilk yüklemede tembel; senkron çağrı geldiğinde hazır değilse hata döner
let brotli = null;
import('brotli/decompress.js').then((m) => { brotli = m.default ?? m; }).catch(() => {});

// --- özetler ---
function sha1(m) {
  const H = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const W = new Uint32Array(80);
  const p = pad64(m, false);
  const dv = new DataView(p.buffer);
  for (let o = 0; o < p.length; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 80; i++) { const x = W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16]; W[i] = (x << 1) | (x >>> 31); }
    let [a, b, c, d, e] = H;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + k + W[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0; H[4] = (H[4] + e) >>> 0;
  }
  return words32(H);
}

const K256 = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70,
  0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
function sha256(m, init = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]) {
  const H = init.slice();
  const W = new Uint32Array(64);
  const p = pad64(m, false);
  const dv = new DataView(p.buffer);
  const r = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < p.length; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = r(W[i - 15], 7) ^ r(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = r(W[i - 2], 17) ^ r(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + W[i]) >>> 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) >>> 0; });
  }
  return words32(H);
}
const sha224 = (m) => sha256(m, [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4]).subarray(0, 28);

const K512 = [
  '428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc', '3956c25bf348b538', '59f111f1b605d019', '923f82a4af194f9b', 'ab1c5ed5da6d8118',
  'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2', '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694',
  'e49b69c19ef14ad2', 'efbe4786384f25e3', '0fc19dc68b8cd5b5', '240ca1cc77ac9c65', '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5',
  '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4', 'c6e00bf33da88fc2', 'd5a79147930aa725', '06ca6351e003826f', '142929670a0e6e70',
  '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df', '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b',
  'a2bfe8a14cf10364', 'a81a664bbc423001', 'c24b8b70d0f89791', 'c76c51a30654be30', 'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
  '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8', '391c0cb3c5c95a63', '4ed8aa4ae3418acb', '5b9cca4f7763e373', '682e6ff3d6b2b8a3',
  '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec', '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b',
  'ca273eceea26619c', 'd186b8c721c0c207', 'eada7dd6cde0eb1e', 'f57d4f7fee6ed178', '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b',
  '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c', '4cc5d4becb3e42b6', '597f299cfc657e2a', '5fcb6fab3ad6faec', '6c44198c4a475817',
].map((h) => BigInt(`0x${h}`));
const M64 = (1n << 64n) - 1n;
function sha512(m, init = ['6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1', '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179'], outLen = 64) {
  const H = init.map((h) => BigInt(`0x${h}`));
  const p = pad64(m, true);
  const dv = new DataView(p.buffer);
  const r = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M64;
  const W = new Array(80);
  for (let o = 0; o < p.length; o += 128) {
    for (let i = 0; i < 16; i++) W[i] = dv.getBigUint64(o + i * 8);
    for (let i = 16; i < 80; i++) {
      const s0 = r(W[i - 15], 1) ^ r(W[i - 15], 8) ^ (W[i - 15] >> 7n);
      const s1 = r(W[i - 2], 19) ^ r(W[i - 2], 61) ^ (W[i - 2] >> 6n);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) & M64;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 80; i++) {
      const t1 = (h + (r(e, 14) ^ r(e, 18) ^ r(e, 41)) + ((e & f) ^ (~e & M64 & g)) + K512[i] + W[i]) & M64;
      const t2 = ((r(a, 28) ^ r(a, 34) ^ r(a, 39)) + ((a & b) ^ (a & c) ^ (b & c))) & M64;
      h = g; g = f; f = e; e = (d + t1) & M64; d = c; c = b; b = a; a = (t1 + t2) & M64;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) & M64; });
  }
  const out = new Uint8Array(64);
  const odv = new DataView(out.buffer);
  H.forEach((v, i) => odv.setBigUint64(i * 8, v));
  return out.subarray(0, outLen);
}
const sha384 = (m) => sha512(m, ['cbbb9d5dc1059ed8', '629a292a367cd507', '9159015a3070dd17', '152fecd8f70e5939', '67332667ffc00b31', '8eb44a8768581511', 'db0c2e0d64f98fa7', '47b5481dbefa4fa4'], 48);

// Merkle–Damgård dolgusu (büyük uçlu uzunluk); wide: 128 baytlık blok (SHA-512 ailesi)
function pad64(m, wide) {
  const block = wide ? 128 : 64;
  const lenBytes = wide ? 16 : 8;
  const total = Math.ceil((m.length + 1 + lenBytes) / block) * block;
  const p = new Uint8Array(total);
  p.set(m);
  p[m.length] = 0x80;
  const dv = new DataView(p.buffer);
  dv.setUint32(total - 4, (m.length * 8) >>> 0);
  dv.setUint32(total - 8, Math.floor(m.length / 0x20000000));
  return p;
}
function words32(H) {
  const out = new Uint8Array(H.length * 4);
  const dv = new DataView(out.buffer);
  H.forEach((v, i) => dv.setUint32(i * 4, v));
  return out;
}

const HASHES = { md5: { fn: md5, block: 64 }, sha1: { fn: sha1, block: 64 }, sha224: { fn: sha224, block: 64 }, sha256: { fn: sha256, block: 64 }, sha384: { fn: sha384, block: 128 }, sha512: { fn: sha512, block: 128 } };
function hashOf(alg) {
  const h = HASHES[String(alg).toLowerCase().replace(/-/g, '').replace(/^rsa/, '')];
  if (!h) throw new Error(`Digest method not supported: ${alg}`);
  return h;
}
function hmac(alg, key, data) {
  const { fn, block } = hashOf(alg);
  let k = key.length > block ? fn(key) : key;
  k = concat(k, new Uint8Array(block - k.length));
  return fn(concat(k.map((b) => b ^ 0x5c), fn(concat(k.map((b) => b ^ 0x36), data))));
}
function pbkdf2(alg, pass, salt, iter, len) {
  const { fn } = hashOf(alg);
  const hl = fn(new Uint8Array(0)).length;
  const blocks = Math.ceil(len / hl);
  if (iter * blocks > MAX_KDF_WORK) throw new Error('pbkdf2: iş sınırı aşıldı');
  const out = new Uint8Array(blocks * hl);
  for (let b = 1; b <= blocks; b++) {
    let u = hmac(alg, pass, concat(salt, Uint8Array.of(b >>> 24, b >>> 16, b >>> 8, b)));
    const acc = Uint8Array.from(u);
    for (let i = 1; i < iter; i++) { u = hmac(alg, pass, u); for (let j = 0; j < acc.length; j++) acc[j] ^= u[j]; }
    out.set(acc, (b - 1) * hl);
  }
  return out.subarray(0, len);
}

// --- AES (CBC/ECB/CTR/CFB/OFB/GCM) ---
// GF(2^128) çarpımı (GCM GHASH)
const R = 0xe1n << 120n;
function gmul(x, y) {
  let z = 0n;
  let v = y;
  for (let i = 127; i >= 0; i--) {
    if ((x >> BigInt(i)) & 1n) z ^= v;
    v = v & 1n ? (v >> 1n) ^ R : v >> 1n;
  }
  return z;
}
const big = (b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const unbig = (v) => Uint8Array.from({ length: 16 }, (_, i) => Number((v >> BigInt(8 * (15 - i))) & 0xffn));
function ghash(h, aad, ct) {
  let y = 0n;
  const feed = (d) => { for (let i = 0; i < d.length; i += 16) { const blk = new Uint8Array(16); blk.set(d.subarray(i, i + 16)); y = gmul(y ^ big(blk), h); } };
  feed(aad);
  feed(ct);
  const lens = new Uint8Array(16);
  const dv = new DataView(lens.buffer);
  dv.setUint32(4, (aad.length * 8) >>> 0);
  dv.setUint32(12, (ct.length * 8) >>> 0);
  return gmul(y ^ big(lens), h);
}
function gcm(cipher, iv, data, aad, decrypt) {
  const h = big(cipher.encrypt(new Uint8Array(16)));
  const j0 = iv.length === 12 ? concat(iv, Uint8Array.of(0, 0, 0, 1)) : unbig(ghash(h, new Uint8Array(0), iv));
  const ctr = Uint8Array.from(j0);
  const inc = (c) => { for (let k = 15; k >= 12; k--) { c[k] = (c[k] + 1) & 255; if (c[k]) break; } };
  inc(ctr);
  const out = ctrCrypt(cipher, data, ctr);
  const ct = decrypt ? data : out;
  const s = big(cipher.encrypt(j0));
  return { out, tag: unbig(ghash(h, aad, ct) ^ s) };
}

function cipherSpec(name) {
  const m = /^aes-?(128|192|256)(?:-(cbc|ecb|ctr|cfb|cfb8|ofb|gcm))?$/i.exec(String(name).trim());
  if (!m) throw new Error(`Unknown cipher: ${name}`);
  return { keyLen: Number(m[1]) / 8, mode: (m[2] ?? 'cbc').toLowerCase() };
}
function pkcs7(d) {
  const n = 16 - (d.length % 16);
  return concat(d, new Uint8Array(n).fill(n));
}
function unpkcs7(d) {
  const n = d[d.length - 1];
  if (!d.length || n < 1 || n > 16 || n > d.length || !d.subarray(d.length - n).every((b) => b === n)) throw new Error('bad decrypt');
  return d.subarray(0, d.length - n);
}
// o.final false: blok kiplerinde yalnızca tam bloklar dolgusuz işlenir (update akışı); true: dolgu uygulanır/kaldırılır
function cipherOp(o) {
  const { keyLen, mode } = cipherSpec(o.alg);
  let key = bytes(o.key);
  let iv = o.iv == null ? null : bytes(o.iv);
  if (o.password != null) {
    const d = evpBytesToKey(bytes(o.password), new Uint8Array(0), keyLen, mode === 'ecb' ? 0 : 16);
    key = d.key;
    iv = mode === 'ecb' ? null : d.iv;
  }
  if (key.length !== keyLen) throw new Error('Invalid key length');
  const c = aesCipher(key);
  const data = bytes(o.data);
  if (mode === 'gcm') {
    if (!iv?.length) throw new Error('Invalid initialization vector');
    const r = gcm(c, iv, data, bytes(o.aad), o.decrypt);
    return { v: str(r.out), tag: str(r.tag) };
  }
  if (mode !== 'ecb' && (!iv || iv.length !== 16)) throw new Error('Invalid initialization vector');
  if (mode === 'ctr') return { v: str(ctrCrypt(c, data, iv)) };
  if (mode === 'ofb') return { v: str(ofbCrypt(c, data, iv)) };
  if (mode === 'cfb' || mode === 'cfb8') {
    if (o.decrypt) return { v: str(cfbDecrypt(c, data, iv)) };
    const out = new Uint8Array(data.length);
    let prev = Uint8Array.from(iv);
    for (let i = 0; i < data.length; i += 16) {
      const ks = c.encrypt(prev);
      const blk = new Uint8Array(16);
      for (let j = 0; j < 16 && i + j < data.length; j++) out[i + j] = blk[j] = data[i + j] ^ ks[j];
      prev = blk;
    }
    return { v: str(out) };
  }
  const pad = o.final && o.padding !== false;
  if (o.decrypt) {
    if (data.length % 16) throw new Error(pad ? 'wrong final block length' : 'data not multiple of block length');
    const plain = mode === 'ecb' ? ecbDecrypt(c, data) : cbcDecrypt(c, data, iv);
    return { v: str(pad ? unpkcs7(plain) : plain) };
  }
  const input = pad ? pkcs7(data) : data;
  if (input.length % 16) throw new Error('data not multiple of block length');
  return { v: str(mode === 'ecb' ? ecbEncrypt(c, input) : cbcEncrypt(c, input, iv)) };
}

// --- zlib ---
// Saklı (sıkıştırmasız) DEFLATE blokları: geçerli akış, gerçek zlib ile açılabilir
function deflateStored(d) {
  const parts = [];
  for (let i = 0; i === 0 || i < d.length; i += 0xffff) {
    const chunk = d.subarray(i, i + 0xffff);
    const last = i + 0xffff >= d.length ? 1 : 0;
    parts.push(Uint8Array.of(last, chunk.length & 255, chunk.length >> 8, ~chunk.length & 255, (~chunk.length >> 8) & 255), chunk);
  }
  return concat(...parts);
}
const be32 = (v) => Uint8Array.of(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const le32 = (v) => Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24);
const ZLIB = {
  inflate: (d) => inflateZlib(d, { maxOut: MAX_OUT }),
  inflateRaw: (d) => inflateRaw(d, { maxOut: MAX_OUT }).data,
  gunzip: (d) => gunzip(d, { maxOut: MAX_OUT }),
  unzip: (d) => (isGzip(d) ? gunzip(d, { maxOut: MAX_OUT }) : inflateZlib(d, { maxOut: MAX_OUT })),
  deflate: (d) => concat(Uint8Array.of(0x78, 0x01), deflateStored(d), be32(adler32(d))),
  deflateRaw: (d) => deflateStored(d),
  gzip: (d) => concat(Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0x0b), deflateStored(d), le32(crc32(d)), le32(d.length >>> 0)),
  brotliDecompress: (d) => {
    if (!brotli) throw new Error('brotli çözücü yüklenmedi');
    const out = brotli(d);
    if (!out || out.length > MAX_OUT) throw new Error('brotli çözülemedi');
    return Uint8Array.from(out);
  },
};

const OPS = {
  zlib: (o) => {
    const f = ZLIB[o.op];
    if (!f) throw new Error(`zlib: ${o.op} desteklenmiyor`);
    return { v: str(f(bytes(o.data))) };
  },
  hash: (o) => ({ v: str(hashOf(o.alg).fn(bytes(o.data))) }),
  hmac: (o) => ({ v: str(hmac(o.alg, bytes(o.key), bytes(o.data))) }),
  pbkdf2: (o) => ({ v: str(pbkdf2(o.alg ?? 'sha1', bytes(o.pass), bytes(o.salt), Math.max(1, o.iter | 0), Math.max(0, o.len | 0))) }),
  cipher: cipherOp,
  isZlib: (o) => ({ v: isZlib(bytes(o.data)) ? '1' : '' }),
};

export function nodeBridge(op, json) {
  try {
    if (json.length > MAX_IN * 2) throw new Error('girdi çok büyük');
    const f = OPS[op];
    if (!f) throw new Error(`bilinmeyen işlem: ${op}`);
    return JSON.stringify({ ok: true, ...f(JSON.parse(json)) });
  } catch (e) {
    return JSON.stringify({ ok: false, e: String(e?.message ?? e) });
  }
}
