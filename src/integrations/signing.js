// H166: imzalı eklenti paylaşımı. Eklenti, kaynağı ve manifest'iyle tek bir .peelplugin (JSON) dosyasında
// taşınır ve Ed25519 ile imzalanır. Yükleme kapalı-varsayılandır: imza geçerli VE imzalayan anahtar
// kullanıcının güvendiği anahtarlar listesinde olmalıdır. Aksi halde kod hiç çalıştırılmaz.
// Not: imza kimin yazdığını kanıtlar, kodun zararsız olduğunu değil; eklenti PEEL'in yetkileriyle çalışır.

export const FORMAT = 'peel-plugin';
const MAX_CODE = 2 * 1024 * 1024;
const enc = new TextEncoder();

const toB64 = (buf) => {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('Geçersiz base64');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};

function manifestOf(m) {
  if (!m || typeof m !== 'object') throw new Error('manifest nesne olmalı');
  const out = {};
  for (const [k, max] of [['id', 50], ['name', 100], ['version', 30], ['description', 1000], ['author', 200], ['homepage', 500]]) {
    if (m[k] === undefined) continue;
    if (typeof m[k] !== 'string' || m[k].length > max) throw new Error(`manifest.${k} geçersiz`);
    out[k] = m[k];
  }
  if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(out.id ?? '')) throw new Error('manifest.id geçersiz');
  if (!/^\d+\.\d+\.\d+([-+][\w.]+)?$/.test(out.version ?? '')) throw new Error('manifest.version semver olmalı');
  return out;
}

// İmzalanan baytlar: alan sırası sabit, böylece JSON biçimlendirmesi imzayı bozmaz
const signedBytes = (manifest, code) => enc.encode(JSON.stringify({ format: FORMAT, manifest, code }));

/** Ed25519 anahtar çifti: publicKey ham 32 bayt, privateKey PKCS#8; ikisi de base64. */
export async function generateKeyPair() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    publicKey: toB64(await crypto.subtle.exportKey('raw', kp.publicKey)),
    privateKey: toB64(await crypto.subtle.exportKey('pkcs8', kp.privateKey)),
  };
}

/**
 * @param {{manifest: object, code: string, privateKey: string, publicKey: string}} o
 * @returns {Promise<object>}  .peelplugin içeriği
 */
export async function signPlugin({ manifest, code, privateKey, publicKey }) {
  if (typeof code !== 'string' || !code.length || code.length > MAX_CODE) throw new Error('Eklenti kodu boş ya da çok büyük');
  const m = manifestOf(manifest);
  const key = await crypto.subtle.importKey('pkcs8', fromB64(privateKey), { name: 'Ed25519' }, false, ['sign']);
  const signature = toB64(await crypto.subtle.sign({ name: 'Ed25519' }, key, signedBytes(m, code)));
  const bundle = { format: FORMAT, manifest: m, code, publicKey, signature };
  // yanlış açık anahtarla paketlenmiş dosya üretmemek için hemen doğrula
  await verifyPlugin(bundle, [publicKey]);
  return bundle;
}

/**
 * @param {object|string} bundle   .peelplugin nesnesi ya da JSON metni
 * @param {string[]} trustedKeys   güvenilen açık anahtarlar (base64)
 * @returns {Promise<{manifest: object, code: string, publicKey: string}>}
 */
export async function verifyPlugin(bundle, trustedKeys) {
  const b = typeof bundle === 'string' ? JSON.parse(bundle) : bundle;
  if (!b || b.format !== FORMAT) throw new Error('.peelplugin dosyası değil');
  if (typeof b.code !== 'string' || b.code.length > MAX_CODE) throw new Error('Eklenti kodu geçersiz');
  const manifest = manifestOf(b.manifest);
  if (!Array.isArray(trustedKeys) || !trustedKeys.includes(b.publicKey)) {
    throw new Error(`İmzalayan anahtar güvenilenler listesinde değil: ${String(b.publicKey).slice(0, 16)}…`);
  }
  const raw = fromB64(b.publicKey);
  if (raw.length !== 32) throw new Error('Açık anahtar 32 bayt olmalı');
  const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, fromB64(b.signature), signedBytes(manifest, b.code));
  if (!ok) throw new Error('İmza geçersiz: eklenti değiştirilmiş ya da başka anahtarla imzalanmış');
  return { manifest, code: b.code, publicKey: b.publicKey };
}

/** Anahtar parmak izi: SHA-256'nın ilk 16 baytı, onaltılık */
export async function fingerprint(publicKey) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', fromB64(publicKey)));
  return [...h.subarray(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join(':');
}
