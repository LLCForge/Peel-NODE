// Blok şifre modları (ECB/CBC/CTR/CFB/OFB) ve dolgular. cipher: { blockSize, encrypt(block), decrypt(block) }

const xorWith = (a, b) => a.map((x, i) => x ^ b[i]);

function blocks(cipher, data, fn) {
  const n = cipher.blockSize;
  if (data.length % n) throw new Error('veri blok boyutunun katı değil');
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += n) out.set(fn(data.subarray(i, i + n)), i);
  return out;
}

export const ecbDecrypt = (cipher, data) => blocks(cipher, data, (b) => cipher.decrypt(b));
export const ecbEncrypt = (cipher, data) => blocks(cipher, data, (b) => cipher.encrypt(b));

export function cbcDecrypt(cipher, data, iv) {
  let prev = Uint8Array.from(iv);
  return blocks(cipher, data, (b) => {
    const p = xorWith(cipher.decrypt(b), prev);
    prev = Uint8Array.from(b);
    return p;
  });
}

export function cbcEncrypt(cipher, data, iv) {
  let prev = Uint8Array.from(iv);
  return blocks(cipher, data, (b) => (prev = cipher.encrypt(xorWith(Uint8Array.from(b), prev))));
}

// CTR: sayaç bloğun tamamı üzerinde büyük-uçlu artar (NIST SP 800-38A, CryptoJS ile aynı)
export function ctrCrypt(cipher, data, counter) {
  const n = cipher.blockSize;
  const ctr = Uint8Array.from(counter);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += n) {
    const ks = cipher.encrypt(ctr);
    for (let j = 0; j < n && i + j < data.length; j++) out[i + j] = data[i + j] ^ ks[j];
    for (let k = n - 1; k >= 0; k--) { ctr[k] = (ctr[k] + 1) & 0xff; if (ctr[k]) break; }
  }
  return out;
}

export function cfbDecrypt(cipher, data, iv) {
  const n = cipher.blockSize;
  const out = new Uint8Array(data.length);
  let prev = Uint8Array.from(iv);
  for (let i = 0; i < data.length; i += n) {
    const ks = cipher.encrypt(prev);
    const block = data.subarray(i, i + n);
    for (let j = 0; j < block.length; j++) out[i + j] = block[j] ^ ks[j];
    if (block.length === n) prev = Uint8Array.from(block);
  }
  return out;
}

export function ofbCrypt(cipher, data, iv) {
  const n = cipher.blockSize;
  const out = new Uint8Array(data.length);
  let ks = Uint8Array.from(iv);
  for (let i = 0; i < data.length; i += n) {
    ks = cipher.encrypt(ks);
    for (let j = 0; j < n && i + j < data.length; j++) out[i + j] = data[i + j] ^ ks[j];
  }
  return out;
}

// E616: dolgu tespiti — çözülmüş düz metnin son bloğuna bakarak hangi dolgunun tutarlı olduğu
export function detectPadding(plain, blockSize) {
  if (!plain.length) return 'none';
  const last = plain[plain.length - 1];
  if (last >= 1 && last <= blockSize && last <= plain.length) {
    const t = plain.subarray(plain.length - last);
    if (t.every((b) => b === last)) return 'pkcs7';
    if (t.subarray(0, last - 1).every((b) => b === 0)) return 'ansix923';
  }
  if (last === 0) {
    let k = plain.length - 1;
    while (k >= 0 && plain[k] === 0) k--;
    if (k >= 0 && plain[k] === 0x80 && plain.length - k <= blockSize) return 'iso7816';
    return 'zero';
  }
  if (last === 0x80) return 'iso7816';
  return 'none';
}

export function unpad(plain, padding) {
  switch (padding) {
    case 'pkcs7': case 'ansix923': return plain.subarray(0, plain.length - plain[plain.length - 1]);
    case 'iso7816': { let k = plain.length - 1; while (k > 0 && plain[k] === 0) k--; return plain.subarray(0, k); }
    case 'zero': { let k = plain.length; while (k && plain[k - 1] === 0) k--; return plain.subarray(0, k); }
    default: return plain;
  }
}

export function pkcs7Pad(data, blockSize) {
  const p = blockSize - (data.length % blockSize);
  const out = new Uint8Array(data.length + p);
  out.set(data);
  out.fill(p, data.length);
  return out;
}
