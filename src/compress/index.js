// E90: sıkıştırılmış blob çözümü. gzip/zlib/raw deflate için tarayıcının DecompressionStream'i,
// yoksa ya da hata verirse saf JS inflate; brotli için tarayıcı desteği yoksa `brotli` paketi (tembel yüklenir);
// LZString için statik çözücü.
import { inflateRaw, inflateZlib, gunzip, isGzip, isZlib } from './inflate.js';
import { decompressFromBase64, decompressFromUTF16, decompressFromEncodedURIComponent, decompress as lzRaw } from './lzstring.js';

const MAX_OUT = 16 << 20;

async function viaStream(bytes, format) {
  if (typeof DecompressionStream !== 'function') return null;
  let ds;
  try { ds = new DecompressionStream(format); } catch { return null; } // biçim desteklenmiyor
  const reader = new Blob([bytes]).stream().pipeThrough(ds).getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_OUT) { await reader.cancel(); throw new Error('çıktı sınırı aşıldı'); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

let brotliLib = null;
async function brotliDecode(bytes) {
  const native = await viaStream(bytes, 'brotli').catch(() => null);
  if (native) return native;
  if (!brotliLib) brotliLib = (await import('brotli/decompress.js')).default;
  const out = brotliLib(bytes);
  if (!out || out.length > MAX_OUT) throw new Error('brotli çözülemedi');
  return Uint8Array.from(out);
}

const SYNC = {
  gzip: (b) => gunzip(b, { maxOut: MAX_OUT }),
  deflate: (b) => inflateZlib(b, { maxOut: MAX_OUT }),
  'deflate-raw': (b) => inflateRaw(b, { maxOut: MAX_OUT }).data,
};

/** Tek biçimle çöz (async). format: gzip | deflate | deflate-raw | brotli */
export async function decompress(bytes, format) {
  if (format === 'brotli') return brotliDecode(bytes);
  try {
    const r = await viaStream(bytes, format);
    if (r) return r;
  } catch { /* yerel akış başarısız: saf JS ile dene */ }
  return SYNC[format](bytes);
}

// Senkron çözüm (kodlama zinciri taraması için): yalnızca saf JS deflate ailesi
export function decompressSync(bytes) {
  const order = isGzip(bytes) ? ['gzip'] : isZlib(bytes) ? ['deflate'] : ['deflate-raw'];
  for (const f of order) {
    try {
      if (f !== 'deflate-raw') return { format: f, data: SYNC[f](bytes) };
      // ham deflate rastgele veride de bazen "başarılı" olur: girdinin tamamı tüketilmiş olmalı
      const r = inflateRaw(bytes, { maxOut: MAX_OUT });
      if (r.consumed < bytes.length - 1 || !r.data.length) return null;
      return { format: f, data: r.data };
    } catch { /* sonraki */ }
  }
  return null;
}

/** Bayt dizisinin hangi sıkıştırma biçimi olduğunu dener; ilk başarılıyı döndürür */
export async function decompressAny(bytes) {
  if (bytes.length < 4) return null;
  const sync = decompressSync(bytes);
  if (sync) {
    const data = await decompress(bytes, sync.format).catch(() => sync.data);
    return { format: sync.format, data };
  }
  try {
    const data = await brotliDecode(bytes);
    if (data.length) return { format: 'brotli', data };
  } catch { /* brotli değil */ }
  return null;
}

// LZString biçimleri: hangisi geçerli ve okunabilir sonuç veriyorsa
export function lzStringCandidates(s) {
  const out = [];
  const tries = [];
  if (/^[A-Za-z0-9+/=]+$/.test(s)) tries.push(['lzstring-base64', decompressFromBase64]);
  if (/^[A-Za-z0-9+\-$ ]+$/.test(s)) tries.push(['lzstring-uri', decompressFromEncodedURIComponent]);
  if ([...s].some((c) => c.charCodeAt(0) > 0x7f)) tries.push(['lzstring-utf16', decompressFromUTF16], ['lzstring', lzRaw]);
  for (const [name, fn] of tries) {
    try {
      const text = fn(s);
      if (text && text.length >= 2) out.push({ format: name, text });
    } catch { /* biçim değil */ }
  }
  return out;
}

export { inflateRaw, inflateZlib, gunzip, isGzip, isZlib };
