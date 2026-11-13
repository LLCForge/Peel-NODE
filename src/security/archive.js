// Tarayıcı içinde arşiv açma: ZIP (XPI, CRX içindeki zip), CRX2/CRX3 başlığı ve tar (npm paketleri).
// Dosyalar diske yazılmaz; yalnızca bellekte okunur. Boyut ve girdi sayısı sınırlıdır (zip bombası).
import { inflateRaw, crc32 } from '../compress/inflate.js';

const MAX_ENTRIES = 5000;
const MAX_TOTAL = 200 << 20;

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const utf8 = (b) => new TextDecoder('utf-8').decode(b);

export function parseZip(bytes) {
  // Merkezi dizin sonu (EOCD): sondan en fazla 64 KB yorum
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP merkezi dizini bulunamadı');
  const count = u16(bytes, eocd + 10);
  let off = u32(bytes, eocd + 16);
  if (count > MAX_ENTRIES) throw new Error(`ZIP çok fazla girdi içeriyor (${count})`);
  const entries = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (u32(bytes, off) !== 0x02014b50) throw new Error('ZIP merkezi dizin girdisi bozuk');
    const flags = u16(bytes, off + 8);
    const method = u16(bytes, off + 10);
    const csize = u32(bytes, off + 20);
    const usize = u32(bytes, off + 24);
    const nlen = u16(bytes, off + 28);
    const xlen = u16(bytes, off + 30);
    const clen = u16(bytes, off + 32);
    const local = u32(bytes, off + 42);
    const name = utf8(bytes.subarray(off + 46, off + 46 + nlen));
    off += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (flags & 1) { entries.push({ name, size: usize, encrypted: true, data: null }); continue; }
    if (u32(bytes, local) !== 0x04034b50) throw new Error(`ZIP yerel başlık bozuk: ${name}`);
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    const raw = bytes.subarray(start, start + csize);
    total += usize;
    if (total > MAX_TOTAL) throw new Error('ZIP açılmış boyutu sınırı aşıyor');
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRaw(raw, { maxOut: Math.min(MAX_TOTAL, usize + 1024) }).data;
    else { entries.push({ name, size: usize, unsupported: method, data: null }); continue; }
    entries.push({ name, size: data.length, data });
  }
  return entries;
}

// CRX2: "Cr24" v2, açık anahtar ve imza uzunlukları; CRX3: "Cr24" v3, protobuf başlık uzunluğu
export function unpackCrx(bytes) {
  if (u32(bytes, 0) !== 0x34327243) return { format: 'zip', zip: bytes };
  const version = u32(bytes, 4);
  if (version === 2) return { format: 'crx2', zip: bytes.subarray(16 + u32(bytes, 8) + u32(bytes, 12)) };
  if (version === 3) return { format: 'crx3', zip: bytes.subarray(12 + u32(bytes, 8)) };
  throw new Error(`desteklenmeyen CRX sürümü ${version}`);
}

// tar (ustar + pax yol uzantısı)
export function parseTar(bytes) {
  const files = [];
  let off = 0;
  let paxPath = null;
  let total = 0;
  const str = (o, n) => utf8(bytes.subarray(o, o + n)).replace(/\0[\s\S]*$/, '');
  while (off + 512 <= bytes.length) {
    if (bytes.subarray(off, off + 512).every((b) => b === 0)) break;
    const name = str(off, 100);
    const size = parseInt(str(off + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(bytes[off + 156] || 48);
    const prefix = str(off + 257, 6).startsWith('ustar') ? str(off + 345, 155) : '';
    const data = bytes.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (!Number.isFinite(size) || size < 0) throw new Error('tar başlığı bozuk');
    if (type === 'x') {
      const m = utf8(data).match(/\d+ path=([^\n]*)\n/);
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === 'g' || type === '5') continue;
    total += size;
    if (total > MAX_TOTAL || files.length > MAX_ENTRIES) throw new Error('tar boyut/girdi sınırı aşıldı');
    files.push({ name: paxPath ?? (prefix ? `${prefix}/${name}` : name), size, data });
    paxPath = null;
  }
  return files;
}

// Sıkıştırmasız (stored) ZIP yazıcı: ayrılmış modülleri tek dosyada indirmek için
export function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.text === 'string' ? enc.encode(f.text) : f.data;
    const crc = crc32(data);
    const local = new Uint8Array(30);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, name.length, true);
    const cd = new Uint8Array(46);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, off, true);
    parts.push(local, name, data);
    central.push(cd, name);
    off += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((a, p) => a + p.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, off, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}
