// Saf JS DEFLATE çözücü (RFC 1951) + zlib (RFC 1950) ve gzip (RFC 1952) sarmalayıcıları.
// DecompressionStream olmayan ortamlarda ve senkron kodlama zinciri tespitinde kullanılır.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Kanonik Huffman tablosu: uzunluk başına sayılar + sembollerin sıralı listesi
function huffman(lengths) {
  const counts = new Uint16Array(16);
  for (const l of lengths) counts[l]++;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  const symbols = new Uint16Array(lengths.length);
  lengths.forEach((l, s) => { if (l) symbols[offs[l]++] = s; });
  return { counts, symbols };
}

class Bits {
  constructor(buf) { this.buf = buf; this.pos = 0; this.bit = 0; this.cnt = 0; }
  need(n) {
    while (this.cnt < n) {
      if (this.pos >= this.buf.length) throw new Error('deflate: veri erken bitti');
      this.bit |= this.buf[this.pos++] << this.cnt;
      this.cnt += 8;
    }
  }
  read(n) {
    if (!n) return 0;
    this.need(n);
    const v = this.bit & ((1 << n) - 1);
    this.bit >>>= n;
    this.cnt -= n;
    return v;
  }
  align() { this.bit = 0; this.cnt = 0; }
  sym(h) {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.read(1);
      const count = h.counts[len];
      if (code - count < first) return h.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('deflate: geçersiz Huffman kodu');
  }
}

let FIXED = null;
function fixedTables() {
  if (FIXED) return FIXED;
  const l = new Array(288);
  l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
  FIXED = { lit: huffman(l), dist: huffman(new Array(30).fill(5)) };
  return FIXED;
}

function dynamicTables(bs) {
  const hlit = bs.read(5) + 257;
  const hdist = bs.read(5) + 1;
  const hclen = bs.read(4) + 4;
  const cl = new Array(19).fill(0);
  for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bs.read(3);
  const clh = huffman(cl);
  const lens = [];
  while (lens.length < hlit + hdist) {
    const s = bs.sym(clh);
    if (s < 16) lens.push(s);
    else if (s === 16) {
      if (!lens.length) throw new Error('deflate: tekrar edilecek uzunluk yok');
      const prev = lens[lens.length - 1];
      for (let r = 3 + bs.read(2); r; r--) lens.push(prev);
    } else if (s === 17) for (let r = 3 + bs.read(3); r; r--) lens.push(0);
    else for (let r = 11 + bs.read(7); r; r--) lens.push(0);
  }
  if (lens.length > hlit + hdist) throw new Error('deflate: uzunluk taşması');
  return { lit: huffman(lens.slice(0, hlit)), dist: huffman(lens.slice(hlit)) };
}

/** Ham DEFLATE akışı. maxOut: sıkıştırma bombasına karşı çıktı sınırı */
export function inflateRaw(data, { maxOut = 64 << 20 } = {}) {
  const bs = new Bits(data);
  let out = new Uint8Array(Math.max(1024, data.length * 4));
  let n = 0;
  const ensure = (k) => {
    if (n + k > maxOut) throw new Error('deflate: çıktı sınırı aşıldı');
    if (n + k <= out.length) return;
    const next = new Uint8Array(Math.min(maxOut, Math.max(out.length * 2, n + k)));
    next.set(out.subarray(0, n));
    out = next;
  };
  let final = 0;
  while (!final) {
    final = bs.read(1);
    const type = bs.read(2);
    if (type === 0) {
      bs.align();
      if (bs.pos + 4 > data.length) throw new Error('deflate: saklı blok başlığı eksik');
      const len = data[bs.pos] | (data[bs.pos + 1] << 8);
      const nlen = data[bs.pos + 2] | (data[bs.pos + 3] << 8);
      if ((len ^ 0xffff) !== nlen) throw new Error('deflate: saklı blok uzunluğu bozuk');
      bs.pos += 4;
      if (bs.pos + len > data.length) throw new Error('deflate: saklı blok kesik');
      ensure(len);
      out.set(data.subarray(bs.pos, bs.pos + len), n);
      n += len;
      bs.pos += len;
      continue;
    }
    if (type === 3) throw new Error('deflate: geçersiz blok tipi');
    const { lit, dist } = type === 1 ? fixedTables() : dynamicTables(bs);
    for (;;) {
      const s = bs.sym(lit);
      if (s < 256) { ensure(1); out[n++] = s; continue; }
      if (s === 256) break;
      const li = s - 257;
      if (li >= 29) throw new Error('deflate: geçersiz uzunluk sembolü');
      const len = LEN_BASE[li] + bs.read(LEN_EXTRA[li]);
      const di = bs.sym(dist);
      if (di >= 30) throw new Error('deflate: geçersiz mesafe sembolü');
      const d = DIST_BASE[di] + bs.read(DIST_EXTRA[di]);
      if (d > n) throw new Error('deflate: mesafe çıktıdan uzun');
      ensure(len);
      for (let i = 0; i < len; i++, n++) out[n] = out[n - d];
    }
  }
  return { data: out.slice(0, n), consumed: bs.pos };
}

export function adler32(data) {
  let a = 1;
  let b = 0;
  for (const x of data) { a = (a + x) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export const CRC32_TABLE = CRC;
export function crc32(data) {
  let c = 0xffffffff;
  for (const x of data) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const isZlib = (d) => d.length > 2 && (d[0] & 0x0f) === 8 && (d[0] >> 4) <= 7 && ((d[0] << 8) | d[1]) % 31 === 0;
export const isGzip = (d) => d.length > 18 && d[0] === 0x1f && d[1] === 0x8b && d[2] === 8;

export function inflateZlib(d, opts) {
  if (!isZlib(d)) throw new Error('zlib başlığı değil');
  if (d[1] & 0x20) throw new Error('zlib: önceden ayarlı sözlük desteklenmez');
  const r = inflateRaw(d.subarray(2), opts);
  const tail = d.subarray(2 + r.consumed, 2 + r.consumed + 4);
  if (tail.length === 4 && ((tail[0] << 24) | (tail[1] << 16) | (tail[2] << 8) | tail[3]) >>> 0 !== adler32(r.data)) {
    throw new Error('zlib: adler32 uyuşmuyor');
  }
  return r.data;
}

// gzip: birden çok üye ardışık olabilir
export function gunzip(d, opts) {
  const parts = [];
  let off = 0;
  while (off < d.length && isGzip(d.subarray(off))) {
    const flg = d[off + 3];
    let p = off + 10;
    if (flg & 4) p += 2 + (d[p] | (d[p + 1] << 8));
    if (flg & 8) { while (d[p]) p++; p++; }
    if (flg & 16) { while (d[p]) p++; p++; }
    if (flg & 2) p += 2;
    const r = inflateRaw(d.subarray(p), opts);
    const end = p + r.consumed;
    const crc = (d[end] | (d[end + 1] << 8) | (d[end + 2] << 16) | (d[end + 3] << 24)) >>> 0;
    if (end + 8 <= d.length && crc !== crc32(r.data)) throw new Error('gzip: crc32 uyuşmuyor');
    parts.push(r.data);
    off = end + 8;
  }
  if (!parts.length) throw new Error('gzip başlığı değil');
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
