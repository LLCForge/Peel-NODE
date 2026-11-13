// RC4 akış şifresi ve MD5 (OpenSSL EVP_BytesToKey türetmesi için; CryptoJS parola modu bunu kullanır).

export function rc4(key, data, drop = 0) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  let i = 0;
  let j = 0;
  for (let n = -drop; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    if (n >= 0) out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

// MD5 sabitleri: T[i] = floor(|sin(i+1)| * 2^32)
export const MD5_T = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

export function md5(input) {
  const bytes = Uint8Array.from(input);
  const len = bytes.length;
  const padded = new Uint8Array((((len + 8) >> 6) + 1) * 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, (len * 8) >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(len / 0x20000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < padded.length; off += 64) {
    const m = Array.from({ length: 16 }, (_, i) => dv.getUint32(off + i * 4, true));
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const s = MD5_S[(i >> 4) * 4 + (i % 4)];
      const x = (a + f + MD5_T[i] + m[g]) >>> 0;
      a = d; d = c; c = b;
      b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((w, i) => ov.setUint32(i * 4, w, true));
  return out;
}

// OpenSSL EVP_BytesToKey (MD5, 1 iterasyon): "Salted__" + 8 bayt tuz biçimindeki CryptoJS/openssl çıktısı için
export function evpBytesToKey(password, salt, keyLen, ivLen) {
  const out = new Uint8Array(keyLen + ivLen);
  let prev = new Uint8Array(0);
  let filled = 0;
  while (filled < out.length) {
    prev = md5(Uint8Array.from([...prev, ...password, ...salt]));
    out.set(prev.subarray(0, Math.min(prev.length, out.length - filled)), filled);
    filled += prev.length;
  }
  return { key: out.subarray(0, keyLen), iv: out.subarray(keyLen) };
}
