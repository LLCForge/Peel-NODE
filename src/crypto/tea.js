// TEA, XTEA ve XXTEA (Corrected Block TEA). Kelimeler 32 bit; bayt sırası parametreyle seçilir
// (referans test vektörleri büyük-uçlu, JS kütüphanelerinin çoğu küçük-uçlu kullanır).

export const TEA_DELTA = 0x9e3779b9;

const words = (bytes, little) => {
  if (bytes.length % 4) throw new Error('veri 4 baytın katı değil');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  return Array.from({ length: bytes.length / 4 }, (_, i) => dv.getUint32(i * 4, little));
};
const fromWords = (w, little) => {
  const out = new Uint8Array(w.length * 4);
  const dv = new DataView(out.buffer);
  w.forEach((x, i) => dv.setUint32(i * 4, x >>> 0, little));
  return out;
};

export function teaCipher(key, { little = false, rounds = 32 } = {}) {
  if (key.length !== 16) throw new Error('TEA anahtarı 16 bayt olmalı');
  const k = words(Uint8Array.from(key), little);
  return {
    blockSize: 8,
    encrypt(b) {
      let [v0, v1] = words(Uint8Array.from(b), little);
      let sum = 0;
      for (let i = 0; i < rounds; i++) {
        sum = (sum + TEA_DELTA) >>> 0;
        v0 = (v0 + ((((v1 << 4) + k[0]) ^ (v1 + sum) ^ ((v1 >>> 5) + k[1])) >>> 0)) >>> 0;
        v1 = (v1 + ((((v0 << 4) + k[2]) ^ (v0 + sum) ^ ((v0 >>> 5) + k[3])) >>> 0)) >>> 0;
      }
      return fromWords([v0, v1], little);
    },
    decrypt(b) {
      let [v0, v1] = words(Uint8Array.from(b), little);
      let sum = Math.imul(TEA_DELTA, rounds) >>> 0;
      for (let i = 0; i < rounds; i++) {
        v1 = (v1 - ((((v0 << 4) + k[2]) ^ (v0 + sum) ^ ((v0 >>> 5) + k[3])) >>> 0)) >>> 0;
        v0 = (v0 - ((((v1 << 4) + k[0]) ^ (v1 + sum) ^ ((v1 >>> 5) + k[1])) >>> 0)) >>> 0;
        sum = (sum - TEA_DELTA) >>> 0;
      }
      return fromWords([v0, v1], little);
    },
  };
}

export function xteaCipher(key, { little = false, rounds = 32 } = {}) {
  if (key.length !== 16) throw new Error('XTEA anahtarı 16 bayt olmalı');
  const k = words(Uint8Array.from(key), little);
  return {
    blockSize: 8,
    encrypt(b) {
      let [v0, v1] = words(Uint8Array.from(b), little);
      let sum = 0;
      for (let i = 0; i < rounds; i++) {
        v0 = (v0 + (((((v1 << 4) ^ (v1 >>> 5)) + v1) ^ (sum + k[sum & 3])) >>> 0)) >>> 0;
        sum = (sum + TEA_DELTA) >>> 0;
        v1 = (v1 + (((((v0 << 4) ^ (v0 >>> 5)) + v0) ^ (sum + k[(sum >>> 11) & 3])) >>> 0)) >>> 0;
      }
      return fromWords([v0, v1], little);
    },
    decrypt(b) {
      let [v0, v1] = words(Uint8Array.from(b), little);
      let sum = Math.imul(TEA_DELTA, rounds) >>> 0;
      for (let i = 0; i < rounds; i++) {
        v1 = (v1 - (((((v0 << 4) ^ (v0 >>> 5)) + v0) ^ (sum + k[(sum >>> 11) & 3])) >>> 0)) >>> 0;
        sum = (sum - TEA_DELTA) >>> 0;
        v0 = (v0 - (((((v1 << 4) ^ (v1 >>> 5)) + v1) ^ (sum + k[sum & 3])) >>> 0)) >>> 0;
      }
      return fromWords([v0, v1], little);
    },
  };
}

// XXTEA: tüm veri tek blok (en az 8 bayt, 4'ün katı)
const mx = (sum, y, z, p, e, k) => ((((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^ ((sum ^ y) + (k[(p & 3) ^ e] ^ z))) >>> 0;

export function xxteaEncrypt(data, key, { little = true } = {}) {
  const v = words(Uint8Array.from(data), little);
  const k = words(Uint8Array.from(key), little);
  const n = v.length;
  if (n < 2) throw new Error('XXTEA en az 8 bayt ister');
  let rounds = 6 + Math.floor(52 / n);
  let sum = 0;
  let z = v[n - 1];
  while (rounds-- > 0) {
    sum = (sum + TEA_DELTA) >>> 0;
    const e = (sum >>> 2) & 3;
    for (let p = 0; p < n; p++) {
      const y = v[(p + 1) % n];
      z = v[p] = (v[p] + mx(sum, y, z, p, e, k)) >>> 0;
    }
  }
  return fromWords(v, little);
}

export function xxteaDecrypt(data, key, { little = true } = {}) {
  const v = words(Uint8Array.from(data), little);
  const k = words(Uint8Array.from(key), little);
  const n = v.length;
  if (n < 2) throw new Error('XXTEA en az 8 bayt ister');
  const rounds = 6 + Math.floor(52 / n);
  let sum = Math.imul(rounds, TEA_DELTA) >>> 0;
  let y = v[0];
  while (sum !== 0) {
    const e = (sum >>> 2) & 3;
    for (let p = n - 1; p >= 0; p--) {
      const z = v[(p + n - 1) % n];
      y = v[p] = (v[p] - mx(sum, y, z, p, e, k)) >>> 0;
    }
    sum = (sum - TEA_DELTA) >>> 0;
  }
  return fromWords(v, little);
}

// xxtea-js (yaygın JS kütüphanesi) biçimi: düz metnin sonuna uzunluk kelimesi eklenir, anahtar 16 bayta tamamlanır
export function xxteaJsDecrypt(data, key) {
  const k = new Uint8Array(16);
  k.set(Uint8Array.from(key).subarray(0, 16));
  if (data.length % 4 || data.length < 8) return null;
  const out = xxteaDecrypt(data, k, { little: true });
  const n = new DataView(out.buffer).getUint32(out.length - 4, true);
  if (n > out.length - 4 || n < out.length - 7) return null;
  return out.subarray(0, n);
}
