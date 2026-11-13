// G154: Electron .asar arşivi okuma/yazma (saf JS, tarayıcı ve Node). Biçim:
//   [u32 4][u32 başlıkBoyu] [u32 yükBoyu][u32 jsonUzunluğu][json, 4'e hizalı] [dosya verisi...]
// Dosya ofsetleri başlıktan sonraki veri bölgesine göredir. "unpacked" dosyalar app.asar.unpacked
// klasöründedir ve arşivde verisi yoktur.

const MAX_HEADER = 64 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const SAFE_NAME = /^[^/\\\0]+$/;

const u32 = (buf, off) => buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] * 0x1000000);

function checkName(name) {
  if (!SAFE_NAME.test(name) || name === '.' || name === '..') throw new Error(`Geçersiz asar girdi adı: ${JSON.stringify(name)}`);
}

/**
 * @param {Uint8Array} buf
 * @returns {{files: Array<{path: string, size: number, offset: number, unpacked: boolean, executable: boolean, link?: string}>, read(path: string): Uint8Array, readText(path: string): string}}
 */
export function readAsar(buf) {
  if (!(buf instanceof Uint8Array)) throw new TypeError('Uint8Array bekleniyor');
  if (buf.length < 16 || u32(buf, 0) !== 4) throw new Error('asar arşivi değil');
  const headerSize = u32(buf, 4);
  const jsonLen = u32(buf, 12);
  if (headerSize > MAX_HEADER || jsonLen > headerSize - 8 || 8 + headerSize > buf.length) throw new Error('asar başlığı bozuk');
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(buf.subarray(16, 16 + jsonLen)));
  } catch {
    throw new Error('asar başlığı JSON değil');
  }
  const base = 8 + headerSize;
  const files = [];
  const index = new Map();
  const walk = (node, prefix) => {
    if (!node || typeof node.files !== 'object' || node.files === null) return;
    for (const [name, entry] of Object.entries(node.files)) {
      checkName(name);
      if (files.length >= MAX_ENTRIES) throw new Error('asar çok fazla girdi içeriyor');
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry && typeof entry.files === 'object') { walk(entry, path); continue; }
      if (entry && typeof entry.link === 'string') { files.push({ path, size: 0, offset: 0, unpacked: false, executable: false, link: entry.link }); continue; }
      const size = Number(entry?.size);
      const offset = Number(entry?.offset ?? 0);
      const unpacked = Boolean(entry?.unpacked);
      if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(offset) || offset < 0) throw new Error(`asar girdisi bozuk: ${path}`);
      if (!unpacked && base + offset + size > buf.length) throw new Error(`asar girdisi arşiv dışına taşıyor: ${path}`);
      const f = { path, size, offset, unpacked, executable: Boolean(entry?.executable) };
      files.push(f);
      index.set(path, f);
    }
  };
  walk(header, '');
  const read = (path) => {
    const f = index.get(path);
    if (!f) throw new Error(`asar içinde yok: ${path}`);
    if (f.unpacked) throw new Error(`dosya app.asar.unpacked içinde: ${path}`);
    return buf.subarray(base + f.offset, base + f.offset + f.size);
  };
  return { files, read, readText: (path) => new TextDecoder().decode(read(path)) };
}

/**
 * Test ve yeniden paketleme için asar yazar.
 * @param {Record<string, Uint8Array|string>} entries  "dizin/dosya.js" -> içerik
 */
export function writeAsar(entries) {
  const root = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const [path, content] of Object.entries(entries)) {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const parts = path.split('/');
    parts.forEach(checkName);
    let dir = root;
    for (const p of parts.slice(0, -1)) dir = (dir.files[p] ??= { files: {} });
    dir.files[parts.at(-1)] = { size: data.length, offset: String(offset) };
    chunks.push(data);
    offset += data.length;
  }
  const json = new TextEncoder().encode(JSON.stringify(root));
  const padded = (json.length + 3) & ~3;
  const headerSize = 8 + padded;
  const out = new Uint8Array(8 + headerSize + offset);
  const put = (off, v) => { out[off] = v & 255; out[off + 1] = (v >>> 8) & 255; out[off + 2] = (v >>> 16) & 255; out[off + 3] = (v >>> 24) & 255; };
  put(0, 4);
  put(4, headerSize);
  put(8, 4 + padded);
  put(12, json.length);
  out.set(json, 16);
  let o = 8 + headerSize;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export const isScript = (path) => /\.(c|m)?js$/i.test(path) && !/\.min\.map$/i.test(path);
