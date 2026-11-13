// Şifre çözme yüzeyi: algoritma + mod + anahtar + IV ile bayt dizisi çözer, dolguyu tespit eder.
// Bilinmeyen kombinasyonlar için `bruteDecrypt` aday anahtar/IV'lerle tüm algoritmaları dener.
import { aesCipher } from './aes.js';
import { desCipher, tripleDesCipher } from './des.js';
import { blowfishCipher } from './blowfish.js';
import { teaCipher, xteaCipher, xxteaDecrypt, xxteaJsDecrypt } from './tea.js';
import { rc4, evpBytesToKey } from './stream.js';
import { ecbDecrypt, cbcDecrypt, ctrCrypt, cfbDecrypt, ofbCrypt, detectPadding, unpad } from './modes.js';

export const utf8 = (s) => new TextEncoder().encode(s);
export const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
export function hexBytes(s) {
  const t = String(s).replace(/^0x/i, '').replace(/[\s:]/g, '');
  if (!t.length || t.length % 2 || !/^[0-9a-f]+$/i.test(t)) return null;
  return Uint8Array.from(t.match(/../g), (h) => parseInt(h, 16));
}
export function b64Bytes(s) {
  const t = String(s).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!t.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(t) || t.length % 4 === 1) return null;
  try {
    return latin1(atob(t.padEnd(Math.ceil(t.length / 4) * 4, '=')));
  } catch { return null; }
}

// Blok şifreler: anahtar uzunlukları ve kurucu
export const BLOCK_CIPHERS = {
  'AES': { keys: [16, 24, 32], make: aesCipher },
  'DES': { keys: [8], make: desCipher },
  '3DES': { keys: [16, 24], make: tripleDesCipher },
  'Blowfish': { keys: [4, 5, 6, 7, 8, 10, 12, 16, 20, 24, 32, 56], make: blowfishCipher },
  'TEA': { keys: [16], make: (k) => teaCipher(k) },
  'TEA-le': { keys: [16], make: (k) => teaCipher(k, { little: true }) },
  'XTEA': { keys: [16], make: (k) => xteaCipher(k) },
  'XTEA-le': { keys: [16], make: (k) => xteaCipher(k, { little: true }) },
};
export const MODES = ['CBC', 'ECB', 'CTR', 'CFB', 'OFB'];

/**
 * @returns {{ plain: Uint8Array, padding: string } | null}
 */
export function decrypt({ alg, mode = 'CBC', key, iv = null, data, padding = 'auto' }) {
  try {
    if (alg === 'RC4') return { plain: rc4(key, data), padding: 'none' };
    if (alg === 'RC4Drop') return { plain: rc4(key, data, 768 * 4), padding: 'none' };
    if (alg === 'XXTEA') {
      const p = xxteaJsDecrypt(data, key);
      if (p) return { plain: p, padding: 'length' };
      if (key.length !== 16) return null;
      return { plain: xxteaDecrypt(data, key, { little: true }), padding: 'none' };
    }
    const spec = BLOCK_CIPHERS[alg];
    if (!spec || !spec.keys.includes(key.length)) return null;
    const c = spec.make(key);
    const n = c.blockSize;
    const ivb = iv ?? new Uint8Array(n);
    if (mode !== 'ECB' && ivb.length !== n) return null;
    let plain;
    switch (mode) {
      case 'ECB': plain = ecbDecrypt(c, data); break;
      case 'CBC': plain = cbcDecrypt(c, data, ivb); break;
      case 'CTR': return { plain: ctrCrypt(c, data, ivb), padding: 'none' };
      case 'CFB': return { plain: cfbDecrypt(c, data, ivb), padding: 'none' };
      case 'OFB': return { plain: ofbCrypt(c, data, ivb), padding: 'none' };
      default: return null;
    }
    const pad = padding === 'auto' ? detectPadding(plain, n) : padding;
    return { plain: unpad(plain, pad), padding: pad };
  } catch {
    return null;
  }
}

// OpenSSL / CryptoJS parola biçimi: "Salted__" + tuz + şifreli veri
export function openSslSalted(data) {
  const magic = [0x53, 0x61, 0x6c, 0x74, 0x65, 0x64, 0x5f, 0x5f];
  if (data.length < 16 || !magic.every((b, i) => data[i] === b)) return null;
  return { salt: data.subarray(8, 16), body: data.subarray(16) };
}

export function decryptPassphrase({ alg, mode = 'CBC', passphrase, data }) {
  const s = openSslSalted(data);
  if (!s) return null;
  const sizes = { AES: [32, 16], DES: [8, 8], '3DES': [24, 8], Blowfish: [16, 8], RC4: [32, 0] }[alg];
  if (!sizes) return null;
  const { key, iv } = evpBytesToKey(passphrase, s.salt, sizes[0], sizes[1]);
  const r = decrypt({ alg, mode, key, iv: sizes[1] ? iv : null, data: s.body });
  return r && { ...r, key, iv, salt: s.salt };
}

// Düz metin kabul ölçütü: geçerli UTF-8 ve yazdırılabilir karakter oranı yüksek
export function plainText(bytes) {
  if (!bytes || bytes.length < 2) return null;
  let s;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  let ok = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 32 && c !== 127) || c === 9 || c === 10 || c === 13) ok++;
  }
  return ok / [...s].length >= 0.95 ? s : null;
}

/**
 * Aday anahtar/IV'lerle tüm algoritmaları dener; okunabilir düz metin veren ilk kombinasyonları döndürür.
 * keys: [{ bytes, label }], ivs: [{ bytes, label }]
 */
export function bruteDecrypt(data, keys, ivs = [], { limit = 4000 } = {}) {
  const hits = [];
  let tries = 0;
  const salted = openSslSalted(data);
  const attempt = (spec) => {
    if (++tries > limit) return false;
    const r = spec.passphrase ? decryptPassphrase({ ...spec, data }) : decrypt({ ...spec, data });
    const text = r && plainText(r.plain);
    if (text && text.trim().length >= 2) {
      hits.push({ alg: spec.alg, mode: spec.mode ?? null, key: spec.keyLabel, iv: spec.ivLabel ?? null, padding: r.padding, text });
      return true;
    }
    return false;
  };
  for (const k of keys) {
    if (salted) {
      for (const alg of ['AES', 'DES', '3DES', 'Blowfish', 'RC4']) {
        if (attempt({ alg, passphrase: k.bytes, keyLabel: k.label })) break;
      }
      continue;
    }
    for (const [alg, spec] of Object.entries(BLOCK_CIPHERS)) {
      if (!spec.keys.includes(k.bytes.length)) continue;
      const n = alg === 'AES' ? 16 : 8;
      const ivList = [...ivs.filter((v) => v.bytes.length === n), { bytes: new Uint8Array(n), label: 'sıfır IV' }];
      if (data.length % n === 0) {
        if (attempt({ alg, mode: 'ECB', key: k.bytes, keyLabel: k.label })) continue;
        let found = false;
        for (const iv of ivList) if ((found = attempt({ alg, mode: 'CBC', key: k.bytes, iv: iv.bytes, keyLabel: k.label, ivLabel: iv.label }))) break;
        if (found) continue;
        // IV şifreli verinin başında
        if (data.length >= 2 * n) {
          const r = decrypt({ alg, mode: 'CBC', key: k.bytes, iv: data.subarray(0, n), data: data.subarray(n) });
          const text = r && plainText(r.plain);
          if (text) { hits.push({ alg, mode: 'CBC', key: k.label, iv: 'veri başı', padding: r.padding, text }); continue; }
        }
      }
      for (const iv of ivList.filter((v) => v.label !== 'sıfır IV')) if (attempt({ alg, mode: 'CTR', key: k.bytes, iv: iv.bytes, keyLabel: k.label, ivLabel: iv.label })) break;
    }
    if (attempt({ alg: 'XXTEA', key: k.bytes, keyLabel: k.label })) continue;
    attempt({ alg: 'RC4', key: k.bytes, keyLabel: k.label });
    if (tries > limit) break;
  }
  return hits;
}
