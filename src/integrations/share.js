// Paylaşım bağlantısı (J196, G152): girdi sıkıştırılıp URL'nin # kısmına yazılır. Fragment sunucuya
// hiç gönderilmez, PEEL hiçbir yere yükleme yapmaz. Parola verilirse içerik PBKDF2-SHA256 (600k) ile
// türetilen anahtarla AES-256-GCM şifrelenir; parola bağlantıyla birlikte değil, ayrı bir kanaldan iletilmeli.
// Biçimler:  #peel=z1.<base64url(deflate-raw(json))>   #peel=e1.<base64url(salt16|iv12|şifreli)>

export const PREFIX = 'peel=';
export const MAX_FRAGMENT = 1_500_000; // daha uzun bağlantıyı tarayıcılar ve sohbet uygulamaları kırpar
const MAX_JSON = 16 * 1024 * 1024; // açılan içerik sınırı: sıkıştırma bombasına karşı
const PBKDF2_ITERATIONS = 600_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Geçersiz paylaşım verisi');
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function pipe(bytes, stream, limit = Infinity) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > limit) {
      await reader.cancel();
      throw new Error('Paylaşım içeriği çok büyük');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const deflate = (b) => pipe(b, new CompressionStream('deflate-raw'));
const inflate = (b) => pipe(b, new DecompressionStream('deflate-raw'), MAX_JSON);

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function validatePayload(p) {
  if (!p || typeof p !== 'object' || p.v !== 1 || typeof p.input !== 'string') throw new Error('Geçersiz paylaşım içeriği');
  const out = { v: 1, input: p.input };
  for (const k of ['output', 'name', 'note']) if (typeof p[k] === 'string') out[k] = p[k];
  return out;
}

/**
 * @param {{input: string, output?: string, name?: string, note?: string}} payload
 * @param {{password?: string}} [o]
 * @returns {Promise<string>}  "peel=..." (başına # konarak URL'ye eklenir)
 */
export async function encodeShare(payload, { password } = {}) {
  const body = enc.encode(JSON.stringify(validatePayload({ v: 1, ...payload })));
  const packed = await deflate(body);
  if (!password) return `${PREFIX}z1.${b64url(packed)}`;
  if (password.length < 8) throw new Error('Parola en az 8 karakter olmalı');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, packed));
  const all = new Uint8Array(28 + ct.length);
  all.set(salt, 0);
  all.set(iv, 16);
  all.set(ct, 28);
  return `${PREFIX}e1.${b64url(all)}`;
}

/** Fragment parola istiyor mu? */
export const isEncrypted = (fragment) => stripPrefix(fragment)?.startsWith('e1.') ?? false;

function stripPrefix(fragment) {
  const f = String(fragment ?? '').replace(/^#/, '');
  return f.startsWith(PREFIX) ? f.slice(PREFIX.length) : null;
}

/**
 * @returns {Promise<{v: 1, input: string, output?: string, name?: string, note?: string} | null>}  fragment PEEL paylaşımı değilse null
 */
export async function decodeShare(fragment, { password } = {}) {
  const body = stripPrefix(fragment);
  if (body === null) return null;
  if (body.length > MAX_FRAGMENT * 2) throw new Error('Paylaşım verisi çok uzun');
  let packed;
  if (body.startsWith('z1.')) {
    packed = unb64url(body.slice(3));
  } else if (body.startsWith('e1.')) {
    if (!password) throw new Error('Bu paylaşım parola ile şifrelenmiş');
    const all = unb64url(body.slice(3));
    if (all.length < 28 + 16) throw new Error('Geçersiz şifreli paylaşım');
    const key = await deriveKey(password, all.subarray(0, 16));
    try {
      packed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(16, 28) }, key, all.subarray(28)));
    } catch {
      throw new Error('Parola yanlış ya da veri bozulmuş');
    }
  } else {
    throw new Error('Bilinmeyen paylaşım sürümü');
  }
  return validatePayload(JSON.parse(dec.decode(await inflate(packed))));
}

/** Uygulama adresine fragment ekler; çok uzunsa hata verir (dosya olarak paylaşılmalı). */
export function shareUrl(base, fragment) {
  if (fragment.length > MAX_FRAGMENT) throw new Error(`Bağlantı çok uzun (${fragment.length} karakter): dosya olarak paylaş`);
  const u = new URL(base);
  u.hash = fragment;
  return u.toString();
}
