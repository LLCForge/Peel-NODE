// Test yardımcısı: lz-string 1.4 sıkıştırıcısının birebir aktarımı (çözücüyü bağımsız biçimde doğrulamak için)
function compress(uncompressed, bitsPerChar, getCharFromInt) {
  const dict = {};
  const toCreate = {};
  let w = '';
  let enlargeIn = 2;
  let dictSize = 3;
  let numBits = 2;
  const data = [];
  let val = 0;
  let pos = 0;
  const writeBit = (b) => {
    val = (val << 1) | b;
    if (pos === bitsPerChar - 1) { pos = 0; data.push(getCharFromInt(val)); val = 0; } else pos++;
  };
  const writeBits = (n, value) => { for (let i = 0; i < n; i++) { writeBit(value & 1); value >>= 1; } };
  const emitW = () => {
    if (Object.hasOwn(toCreate, w)) {
      const code = w.charCodeAt(0);
      if (code < 256) { writeBits(numBits, 0); writeBits(8, code); } else { writeBits(numBits, 1); writeBits(16, code); }
      enlargeIn--;
      if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits++; }
      delete toCreate[w];
    } else {
      writeBits(numBits, dict[w]);
    }
    enlargeIn--;
    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits++; }
  };
  for (const c of uncompressed) {
    if (!Object.hasOwn(dict, c)) { dict[c] = dictSize++; toCreate[c] = true; }
    const wc = w + c;
    if (Object.hasOwn(dict, wc)) { w = wc; continue; }
    emitW();
    dict[wc] = dictSize++;
    w = c;
  }
  if (w !== '') emitW();
  writeBits(numBits, 2);
  for (;;) {
    val <<= 1;
    if (pos === bitsPerChar - 1) { data.push(getCharFromInt(val)); break; } else pos++;
  }
  return data.join('');
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
export function compressToBase64(input) {
  const res = compress(input, 6, (a) => B64.charAt(a));
  switch (res.length % 4) {
    case 1: return `${res}===`;
    case 2: return `${res}==`;
    case 3: return `${res}=`;
    default: return res;
  }
}
export const compressToUTF16 = (input) => `${compress(input, 15, (a) => String.fromCharCode(a + 32))} `;
