// Arşiv okuyucular: zip (store/deflate), crx (Chrome eklentisi = başlıklı zip) ve HAR.
// Dosyalar güvenilmez girdidir: girdi sayısı, dosya başına ve toplam açılmış boyut sınırlıdır (zip bombası).

export const LIMITS = { entries: 2000, fileBytes: 20 * 1024 * 1024, totalBytes: 120 * 1024 * 1024, jsFiles: 400 };
export const isJsName = (name) => /\.(m|c)?jsx?$/i.test(name);

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export const isZip = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
export const isCrx = (b) => b.length >= 16 && b[0] === 0x43 && b[1] === 0x72 && b[2] === 0x32 && b[3] === 0x34; // "Cr24"

/** CRX2/CRX3 başlığını atıp içindeki zip baytlarını döner */
export function crxToZip(b) {
  if (!isCrx(b)) throw new Error('crx: imza yok');
  const version = u32(b, 4);
  let off;
  if (version === 2) off = 16 + u32(b, 8) + u32(b, 12);
  else if (version === 3) off = 12 + u32(b, 8);
  else throw new Error(`crx: desteklenmeyen sürüm ${version}`);
  if (off >= b.length) throw new Error('crx: bozuk başlık');
  return b.subarray(off);
}

async function inflateRaw(data, expected) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > LIMITS.fileBytes || size > expected * 1.01 + 1024) {
      await reader.cancel();
      throw new Error('zip: açılmış boyut bildirileni ya da sınırı aşıyor');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

/**
 * Zip girdilerini okur. filter(name) true dönenler açılır. Sonuç: [{name, data: Uint8Array}].
 * Şifreli ve zip64 arşivler desteklenmez (açık hata).
 */
export async function readZip(bytes, filter = () => true) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: dizin sonu bulunamadı');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip64 desteklenmiyor');
  if (count > LIMITS.entries) throw new Error(`zip: ${count} girdi (sınır ${LIMITS.entries})`);
  const out = [];
  let total = 0;
  const decoder = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw new Error('zip: bozuk merkez dizin');
    const flags = u16(b, p + 8);
    const method = u16(b, p + 10);
    const csize = u32(b, p + 20);
    const usize = u32(b, p + 24);
    const nlen = u16(b, p + 28);
    const xlen = u16(b, p + 30);
    const clen = u16(b, p + 32);
    const local = u32(b, p + 42);
    const name = decoder.decode(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/') || !filter(name)) continue;
    if (flags & 1) throw new Error(`zip: şifreli girdi (${name})`);
    if (usize > LIMITS.fileBytes) continue;
    total += usize;
    if (total > LIMITS.totalBytes) throw new Error('zip: toplam açılmış boyut sınırı aşıldı');
    if (u32(b, local) !== 0x04034b50) throw new Error('zip: bozuk yerel başlık');
    const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
    const raw = b.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw, usize);
    else throw new Error(`zip: desteklenmeyen sıkıştırma ${method} (${name})`);
    out.push({ name, data });
  }
  return out;
}

const decodeBase64 = (s) => {
  const bin = atob(s.replace(/\s+/g, ''));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(u);
};

/** HAR içindeki JavaScript yanıtları: [{name, url, text}] */
export function harScripts(json) {
  const entries = json?.log?.entries;
  if (!Array.isArray(entries)) throw new Error('HAR: log.entries yok');
  const out = [];
  const names = new Map();
  for (const e of entries) {
    const url = typeof e?.request?.url === 'string' ? e.request.url : '';
    const content = e?.response?.content;
    const mime = String(content?.mimeType ?? '').toLowerCase();
    if (typeof content?.text !== 'string' || !content.text) continue;
    if (!/javascript|ecmascript/.test(mime) && !/\.(m|c)?js(\?|#|$)/i.test(url)) continue;
    let text;
    try { text = content.encoding === 'base64' ? decodeBase64(content.text) : content.text; } catch { continue; }
    if (text.length > LIMITS.fileBytes) continue;
    let base = 'script.js';
    try { base = new URL(url).pathname.split('/').filter(Boolean).pop() || new URL(url).hostname; } catch { /* göreli ya da bozuk URL */ }
    const n = (names.get(base) ?? 0) + 1;
    names.set(base, n);
    out.push({ name: n > 1 ? `${base} (${n})` : base, url, text });
    if (out.length >= LIMITS.jsFiles) break;
  }
  return out;
}
