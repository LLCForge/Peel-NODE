// Blowfish (Schneier 1993). Başlangıç P-dizisi ve S-kutuları pi'nin kesirli kısmının onaltılık
// basamaklarıdır: tablo gömmek yerine BigInt ile Machin formülünden bir kez hesaplanır.

const WORDS = 18 + 4 * 256;
let INIT = null;

// pi'nin kesirli kısmının ilk `bits` biti (BigInt sabit noktalı arctan serisi)
function piFraction(bits) {
  const guard = 64n;
  const one = 1n << (BigInt(bits) + guard);
  const atanInv = (x) => {
    const x2 = BigInt(x * x);
    let term = one / BigInt(x);
    let sum = term;
    for (let k = 1n; term; k++) {
      term /= x2;
      sum += (k & 1n ? -term : term) / (2n * k + 1n);
    }
    return sum;
  };
  const pi = 4n * (4n * atanInv(5) - atanInv(239));
  return (pi - 3n * one) >> guard;
}

export function blowfishInit() {
  if (INIT) return INIT;
  const bits = WORDS * 32;
  let frac = piFraction(bits);
  const out = new Uint32Array(WORDS);
  for (let i = WORDS - 1; i >= 0; i--) { out[i] = Number(frac & 0xffffffffn); frac >>= 32n; }
  INIT = out;
  return out;
}

export function blowfishCipher(key) {
  if (key.length < 1 || key.length > 72) throw new Error('Blowfish anahtarı 1–72 bayt olmalı');
  const init = blowfishInit();
  const P = init.slice(0, 18);
  const S = [0, 1, 2, 3].map((i) => init.slice(18 + i * 256, 18 + (i + 1) * 256));
  const F = (x) => ((((S[0][x >>> 24] + S[1][(x >>> 16) & 255]) >>> 0) ^ S[2][(x >>> 8) & 255]) + S[3][x & 255]) >>> 0;
  const enc = (l, r) => {
    for (let i = 0; i < 16; i++) { l = (l ^ P[i]) >>> 0; r = (r ^ F(l)) >>> 0; [l, r] = [r, l]; }
    [l, r] = [r, l];
    return [(l ^ P[17]) >>> 0, (r ^ P[16]) >>> 0];
  };
  const dec = (l, r) => {
    for (let i = 17; i > 1; i--) { l = (l ^ P[i]) >>> 0; r = (r ^ F(l)) >>> 0; [l, r] = [r, l]; }
    [l, r] = [r, l];
    return [(l ^ P[0]) >>> 0, (r ^ P[1]) >>> 0];
  };
  let j = 0;
  for (let i = 0; i < 18; i++) {
    let d = 0;
    for (let k = 0; k < 4; k++) { d = ((d << 8) | key[j]) >>> 0; j = (j + 1) % key.length; }
    P[i] = (P[i] ^ d) >>> 0;
  }
  let l = 0;
  let r = 0;
  for (let i = 0; i < 18; i += 2) { [l, r] = enc(l, r); P[i] = l; P[i + 1] = r; }
  for (const box of S) for (let i = 0; i < 256; i += 2) { [l, r] = enc(l, r); box[i] = l; box[i + 1] = r; }
  const io = (fn) => (b) => {
    const dv = new DataView(Uint8Array.from(b).buffer);
    const [a, c] = fn(dv.getUint32(0), dv.getUint32(4));
    const out = new Uint8Array(8);
    const ov = new DataView(out.buffer);
    ov.setUint32(0, a);
    ov.setUint32(4, c);
    return out;
  };
  return { blockSize: 8, encrypt: io(enc), decrypt: io(dec) };
}
