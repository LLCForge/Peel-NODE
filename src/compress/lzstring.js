// LZString (pieroxy/lz-string 1.4) çözücüsü: base64, UTF16, EncodedURIComponent ve ham biçimler.
// Programın kendi kodu çalıştırılmadan statik çözüm için.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const URI = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$';
const MAX_OUT = 8 << 20;

function core(length, resetValue, getNext) {
  const dict = [0, 1, 2];
  let enlargeIn = 4;
  let dictSize = 4;
  let numBits = 3;
  let entry;
  const result = [];
  let outLen = 0;
  const data = { val: getNext(0), position: resetValue, index: 1 };
  const bits = (n) => {
    let b = 0;
    let power = 1;
    const max = 2 ** n;
    while (power !== max) {
      const resb = data.val & data.position;
      data.position >>= 1;
      if (data.position === 0) {
        if (data.index > length) throw new Error('lzstring: veri erken bitti');
        data.position = resetValue;
        data.val = getNext(data.index++);
      }
      b |= (resb > 0 ? 1 : 0) * power;
      power <<= 1;
    }
    return b;
  };

  let c;
  switch (bits(2)) {
    case 0: c = String.fromCharCode(bits(8)); break;
    case 1: c = String.fromCharCode(bits(16)); break;
    case 2: return '';
    default: throw new Error('lzstring: geçersiz başlangıç');
  }
  dict[3] = c;
  let w = c;
  result.push(c);
  for (;;) {
    if (data.index > length) throw new Error('lzstring: veri erken bitti');
    let code = bits(numBits);
    switch (code) {
      case 0: dict[dictSize++] = String.fromCharCode(bits(8)); code = dictSize - 1; enlargeIn--; break;
      case 1: dict[dictSize++] = String.fromCharCode(bits(16)); code = dictSize - 1; enlargeIn--; break;
      case 2: return result.join('');
      default: break;
    }
    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits++; }
    if (dict[code]) entry = dict[code];
    else if (code === dictSize) entry = w + w.charAt(0);
    else throw new Error('lzstring: geçersiz sözlük kodu');
    result.push(entry);
    outLen += entry.length;
    if (outLen > MAX_OUT) throw new Error('lzstring: çıktı sınırı aşıldı');
    dict[dictSize++] = w + entry.charAt(0);
    enlargeIn--;
    w = entry;
    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits++; }
  }
}

const viaAlphabet = (alphabet) => (input) => {
  if (!input) return '';
  const map = new Map([...alphabet].map((ch, i) => [ch, i]));
  for (const ch of input) if (!map.has(ch)) throw new Error('lzstring: alfabe dışı karakter');
  return core(input.length, 32, (i) => map.get(input.charAt(i)));
};

export const decompressFromBase64 = viaAlphabet(B64);
export const decompressFromEncodedURIComponent = (s) => viaAlphabet(URI)(s.replace(/ /g, '+'));
export const decompressFromUTF16 = (s) => (s ? core(s.length, 16384, (i) => s.charCodeAt(i) - 32) : '');
export const decompress = (s) => (s ? core(s.length, 32768, (i) => s.charCodeAt(i)) : '');

export function decompressFromUint8Array(bytes) {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] * 256 + bytes[i + 1]);
  return decompress(s);
}
