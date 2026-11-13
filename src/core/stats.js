// E617–E630: kripto/istatistik araçları. Gömülü veri bloklarının entropisi, sıkıştırılabilirliği,
// karakter dağılımı, rastgelelik testleri, ECB tekrarları, Kasiski / tesadüf indeksi, XOR anahtar
// kurtarma (korelasyon, bilinen düz metin, küçük anahtar uzayında kaba kuvvet) ve doğal dil tespiti.

import { decompressAny } from '../compress/index.js';

const toBytes = (x) => (typeof x === 'string' ? Uint8Array.from(x, (c) => c.charCodeAt(0) & 255) : Uint8Array.from(x));

// --- E617 / E618: entropi ---
export function shannon(data) {
  const sym = typeof data === 'string' ? [...data] : Array.from(data);
  if (!sym.length) return 0;
  const counts = new Map();
  for (const s of sym) counts.set(s, (counts.get(s) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) { const p = c / sym.length; h -= p * Math.log2(p); }
  return h;
}

// Alfabe boyutuna göre normalize entropi ve eşik sınıflandırması.
// Eşikler: bayt verisi için 7.2 bit üstü şifreli/sıkıştırılmış, 4.5 altı düz metin; string için alfabe tavanına oran.
export const ENTROPY_THRESHOLDS = { random: 0.92, encoded: 0.75, text: 0.6 };
export function entropyVerdict(data, thresholds = ENTROPY_THRESHOLDS) {
  const h = shannon(data);
  const n = typeof data === 'string' ? [...data].length : data.length;
  const alphabet = new Set(typeof data === 'string' ? [...data] : Array.from(data)).size;
  // örneklem küçükse ulaşılabilecek en yüksek entropi log2(min(n, 256))
  const ceiling = Math.log2(Math.max(2, Math.min(n, typeof data === 'string' ? Math.max(alphabet, 2) : 256)));
  const norm = ceiling ? h / ceiling : 0;
  const bytesLike = typeof data !== 'string';
  let verdict;
  if (bytesLike) verdict = h >= 7.2 || (n < 256 && norm >= thresholds.random) ? 'random' : h >= 5 ? 'encoded' : 'text';
  else verdict = alphabet <= 16 && norm >= thresholds.encoded ? 'hex' : alphabet <= 66 && h >= 5.2 ? 'base64' : h >= 4.6 ? 'encoded' : 'text';
  return { entropy: Number(h.toFixed(3)), normalized: Number(norm.toFixed(3)), alphabet, length: n, verdict };
}

// Kayan pencere entropisi: blob içindeki yüksek entropili bölgeleri bulur
export function entropyWindows(data, size = 256, step = 128) {
  const b = toBytes(data);
  const out = [];
  for (let i = 0; i + size <= b.length || (i === 0 && b.length); i += step) {
    out.push({ offset: i, entropy: Number(shannon(b.subarray(i, i + size)).toFixed(3)) });
    if (i + size >= b.length) break;
  }
  return out;
}

// --- E619: sıkıştırma oranı ---
// Senkron tahmin: açgözlü LZ77 (32 KB pencere, en az 3 bayt eşleşme); literal 9 bit, eşleşme 24 bit varsayılır.
export function compressionEstimate(data) {
  const b = toBytes(data);
  if (!b.length) return 1;
  const head = new Map();
  let bits = 0;
  for (let i = 0; i < b.length;) {
    let best = 0;
    if (i + 3 <= b.length) {
      const k = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
      const cands = head.get(k) ?? [];
      for (let j = cands.length - 1, tries = 0; j >= 0 && tries < 16; j--, tries++) {
        const p = cands[j];
        if (i - p > 32768) break;
        let l = 0;
        while (i + l < b.length && l < 258 && b[p + l] === b[i + l]) l++;
        if (l > best) best = l;
      }
      cands.push(i);
      if (cands.length > 64) cands.shift();
      head.set(k, cands);
    }
    if (best >= 3) { bits += 24; i += best; } else { bits += 9; i++; }
  }
  return Number(Math.min(1.2, bits / 8 / b.length).toFixed(3));
}

// Gerçek oran: CompressionStream varsa deflate-raw ile ölçülür, yoksa tahmin
export async function compressionRatio(data) {
  const b = toBytes(data);
  if (!b.length) return { ratio: 1, method: 'boş' };
  if (typeof CompressionStream === 'function') {
    try {
      const stream = new Blob([b]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const out = new Uint8Array(await new Response(stream).arrayBuffer());
      return { ratio: Number((out.length / b.length).toFixed(3)), method: 'deflate' };
    } catch { /* tahmine düş */ }
  }
  return { ratio: compressionEstimate(b), method: 'lz77-tahmin' };
}

// --- E623: karakter dağılımı ---
export function charDistribution(s) {
  const classes = { upper: 0, lower: 0, digit: 0, space: 0, punct: 0, control: 0, nonAscii: 0 };
  const counts = new Map();
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const c = ch.codePointAt(0);
    if (c > 126) classes.nonAscii++;
    else if (c < 32 && c !== 9 && c !== 10 && c !== 13) classes.control++;
    else if (/[A-Z]/.test(ch)) classes.upper++;
    else if (/[a-z]/.test(ch)) classes.lower++;
    else if (/[0-9]/.test(ch)) classes.digit++;
    else if (/\s/.test(ch)) classes.space++;
    else classes.punct++;
  }
  const alphabet = [...counts.keys()];
  const all = (re) => alphabet.every((c) => re.test(c));
  const family = all(/[0-9a-fA-F]/) ? 'hex' : all(/[01]/) ? 'binary' : all(/[0-9]/) ? 'decimal'
    : all(/[A-Z2-7=]/) ? 'base32' : all(/[A-Za-z0-9+/=]/) ? 'base64' : all(/[A-Za-z0-9_=-]/) ? 'base64url'
      : all(/[!-u]/) ? 'base85' : all(/[\x20-\x7e\s]/) ? 'ascii' : 'unicode';
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([ch, n]) => ({ ch, n }));
  return { length: [...s].length, classes, alphabetSize: alphabet.length, family, top };
}

// --- E624: tekrar eden blok (ECB) ---
export function ecbRepeats(data, blockSize = 16) {
  const b = toBytes(data);
  const seen = new Map();
  let repeats = 0;
  for (let i = 0; i + blockSize <= b.length; i += blockSize) {
    const k = Array.from(b.subarray(i, i + blockSize)).join(',');
    if (seen.has(k)) repeats++;
    else seen.set(k, i);
  }
  const blocks = Math.floor(b.length / blockSize);
  return { blockSize, blocks, repeats, ecbLikely: blocks >= 2 && repeats > 0 && b.length % blockSize === 0 };
}

// --- E625: rastgelelik testleri (NIST SP 800-22 frekans ve koşu testleri, ki-kare, seri korelasyon) ---
function erfc(x) {
  // Abramowitz-Stegun 7.1.26 (|hata| < 1.5e-7)
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? 1 - y : 1 + y;
}

export function randomnessTests(data) {
  const b = toBytes(data);
  const n = b.length * 8;
  if (b.length < 16) return null;
  let ones = 0;
  const bit = (i) => (b[i >> 3] >> (7 - (i & 7))) & 1;
  for (let i = 0; i < n; i++) ones += bit(i);
  const sObs = Math.abs(2 * ones - n) / Math.sqrt(n);
  const monobitP = erfc(sObs / Math.SQRT2);
  const pi = ones / n;
  let runsP = 0;
  if (Math.abs(pi - 0.5) < 2 / Math.sqrt(n)) {
    let v = 1;
    for (let i = 0; i < n - 1; i++) if (bit(i) !== bit(i + 1)) v++;
    runsP = erfc(Math.abs(v - 2 * n * pi * (1 - pi)) / (2 * Math.sqrt(2 * n) * pi * (1 - pi)));
  }
  const counts = new Array(256).fill(0);
  for (const x of b) counts[x]++;
  const e = b.length / 256;
  const chi = counts.reduce((a, c) => a + (c - e) ** 2 / e, 0);
  // seri korelasyon katsayısı (ent aracı ile aynı tanım)
  let t1 = 0, t2 = 0, t3 = 0;
  for (let i = 0; i < b.length; i++) {
    const u = b[i];
    const w = b[(i + 1) % b.length];
    t1 += u * w; t2 += u; t3 += u * u;
  }
  const den = b.length * t3 - t2 * t2;
  const serial = den === 0 ? 1 : (b.length * t1 - t2 * t2) / den;
  const mean = b.reduce((a, x) => a + x, 0) / b.length;
  return {
    monobitP: Number(monobitP.toFixed(4)),
    runsP: Number(runsP.toFixed(4)),
    chiSquare: Number(chi.toFixed(1)),
    serialCorrelation: Number(serial.toFixed(4)),
    mean: Number(mean.toFixed(2)),
    // örneklem 256 baytın altındaysa ki-kare anlamsız: yalnızca bit testleri kullanılır
    looksRandom: monobitP >= 0.01 && runsP >= 0.01 && Math.abs(serial) < 0.2 && (b.length < 256 || chi < 400),
  };
}

// --- E628: tesadüf indeksi ---
export function indexOfCoincidence(data, letters = typeof data === 'string') {
  const sym = letters ? [...String(data).toLowerCase()].filter((c) => c >= 'a' && c <= 'z') : Array.from(toBytes(data));
  const n = sym.length;
  if (n < 2) return 0;
  const counts = new Map();
  for (const s of sym) counts.set(s, (counts.get(s) ?? 0) + 1);
  let sum = 0;
  for (const c of counts.values()) sum += c * (c - 1);
  return Number((sum / (n * (n - 1))).toFixed(4));
}

// --- E627: Kasiski incelemesi ---
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
export function kasiski(data, { minLen = 3, maxKey = 20 } = {}) {
  const sym = typeof data === 'string' ? [...data.toLowerCase().replace(/[^a-z]/g, '')] : Array.from(toBytes(data));
  const pos = new Map();
  const distances = [];
  for (let i = 0; i + minLen <= sym.length; i++) {
    const k = sym.slice(i, i + minLen).join('\u0001');
    const prev = pos.get(k);
    if (prev !== undefined) distances.push(i - prev);
    pos.set(k, i);
    if (distances.length > 2000) break;
  }
  const votes = new Map();
  for (const d of distances) for (let f = 2; f <= maxKey; f++) if (d % f === 0) votes.set(f, (votes.get(f) ?? 0) + 1);
  const ranked = [...votes].sort((a, b) => b[1] - a[1] || b[0] - a[0]).slice(0, 5).map(([len, n]) => ({ len, votes: n }));
  const g = distances.length ? distances.reduce(gcd) : 0;
  return { repeats: distances.length, gcd: g, candidates: ranked };
}

// --- İngilizce bayt puanı (XOR anahtar korelasyonu için) ---
const FREQ = {
  ' ': 13, e: 10.2, t: 7.5, a: 6.5, o: 6.2, i: 5.7, n: 5.7, s: 5.3, r: 5, h: 5, l: 3.3, d: 3.3, u: 2.3, c: 2.2,
  m: 2, f: 1.8, w: 1.7, g: 1.6, y: 1.6, p: 1.5, b: 1.2, '.': 1, ',': 1, v: 0.8, k: 0.6, '"': 0.5, "'": 0.4,
  '(': 0.5, ')': 0.5, ';': 0.5, '=': 0.5, '/': 0.4, ':': 0.3, x: 0.15, j: 0.1, q: 0.1, z: 0.07,
};
export function byteScore(b) {
  if (b >= 65 && b <= 90) return (FREQ[String.fromCharCode(b + 32)] ?? 0.1) * 0.6;
  const ch = String.fromCharCode(b);
  if (FREQ[ch] !== undefined) return FREQ[ch];
  if (b >= 48 && b <= 57) return 0.6;
  if (b === 10 || b === 13 || b === 9) return 0.8;
  if (b >= 32 && b < 127) return 0.2;
  return -8;
}
const textScore = (bytes) => bytes.reduce((a, b) => a + byteScore(b), 0) / Math.max(1, bytes.length);

// --- E626: korelasyonla XOR anahtarı ---
const hamming = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) { let x = a[i] ^ b[i]; while (x) { d += x & 1; x >>= 1; } } return d; };
export function xorKeyLengths(data, maxLen = 32) {
  const b = toBytes(data);
  const out = [];
  for (let k = 1; k <= Math.min(maxLen, Math.floor(b.length / 4)); k++) {
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i + 2 * k <= b.length && pairs < 40; i += k, pairs++) sum += hamming(b.subarray(i, i + k), b.subarray(i + k, i + 2 * k)) / k;
    if (pairs) out.push({ len: k, distance: sum / pairs });
  }
  return out.sort((a, c) => a.distance - c.distance);
}

export function xorByCorrelation(data, maxLen = 32) {
  const b = toBytes(data);
  if (b.length < 16) return null;
  let best = null;
  const lengths = xorKeyLengths(b, maxLen).slice(0, 6).map((x) => x.len);
  for (const len of lengths) {
    const key = [];
    for (let i = 0; i < len; i++) {
      const col = b.filter((_, j) => j % len === i);
      let top = { k: 0, s: -Infinity };
      for (let k = 0; k < 256; k++) {
        const s = col.reduce((a, x) => a + byteScore(x ^ k), 0);
        if (s > top.s) top = { k, s };
      }
      key.push(top.k);
    }
    const plain = b.map((x, j) => x ^ key[j % len]);
    // daha kısa periyotlu anahtar aynı sonucu veriyorsa kısaltılır (abcabc → abc)
    let period = len;
    for (let p = 1; p < len; p++) if (len % p === 0 && key.every((v, i) => v === key[i % p])) { period = p; break; }
    const score = textScore(plain);
    if (!best || score > best.score + 0.05) best = { key: key.slice(0, period), score, plain };
  }
  return best && { key: best.key, score: Number(best.score.toFixed(3)), text: String.fromCharCode(...best.plain.slice(0, 400)) };
}

// --- E629: bilinen düz metin saldırısı (tekrarlı XOR) ---
export const CRIBS = ['function', 'https://', 'http://', 'return ', 'document.', 'window.', 'var ', 'const ', '<script', 'eval(', '{"'];
export function knownPlaintextXor(data, cribs = CRIBS, maxKey = 16) {
  const b = toBytes(data);
  const results = [];
  for (const crib of cribs) {
    const p = toBytes(crib);
    for (let off = 0; off + p.length <= b.length && off < 4096; off++) {
      const ks = p.map((x, i) => x ^ b[off + i]);
      for (let len = 1; len <= Math.min(maxKey, ks.length); len++) {
        // anahtar akışı periyodik mi (crib uzunluğu içinde)?
        if (!ks.every((v, i) => v === ks[i % len])) continue;
        const key = new Array(len);
        for (let i = 0; i < len; i++) key[(off + i) % len] = ks[i];
        const plain = b.map((x, j) => x ^ key[j % len]);
        const score = textScore(plain);
        if (score > 2) results.push({ crib, offset: off, key, score: Number(score.toFixed(3)), text: String.fromCharCode(...plain.slice(0, 400)) });
        break;
      }
      if (results.length > 20) break;
    }
  }
  return results.sort((a, c) => c.score - a.score)[0] ?? null;
}

// --- E630: küçük anahtar uzayında kaba kuvvet ---
export function bruteForceSmall(data, { sample = 96 } = {}) {
  const b = toBytes(data);
  if (b.length < 4) return [];
  const head = b.subarray(0, sample);
  const cands = [];
  const consider = (name, key, fn) => {
    const s = textScore(head.map((x, i) => fn(x, i)));
    if (s > 2) cands.push({ name, key, s, fn });
  };
  for (let k = 1; k < 256; k++) {
    consider('xor8', k, (x) => x ^ k);
    consider('add8', k, (x) => (x + k) & 255);
    consider('xor-artan', k, (x, i) => x ^ ((k + i) & 255));
  }
  for (let r = 1; r < 8; r++) consider('rol', r, (x) => ((x << r) | (x >> (8 - r))) & 255);
  // 16 bit XOR: 65536 anahtar yalnızca ilk 32 bayt üzerinde puanlanır
  const h32 = b.subarray(0, 32);
  for (let k = 0; k < 65536; k++) {
    const k0 = k >> 8;
    const k1 = k & 255;
    if (k0 === k1) continue;
    let s = 0;
    for (let i = 0; i < h32.length; i++) s += byteScore(h32[i] ^ (i & 1 ? k1 : k0));
    if (s / h32.length > 2.5) consider('xor16', `${k0.toString(16).padStart(2, '0')}${k1.toString(16).padStart(2, '0')}`, (x, i) => x ^ (i & 1 ? k1 : k0));
  }
  return cands.sort((a, c) => c.s - a.s).slice(0, 5).map((c) => ({
    method: c.name, key: c.key, score: Number(c.s.toFixed(3)), text: String.fromCharCode(...b.map((x, i) => c.fn(x, i)).slice(0, 400)),
  }));
}

// Afin şifre (harfler üzerinde, 312 anahtar): E630 metin varyantı
export function affineBrute(s) {
  const inv = (a) => { for (let x = 1; x < 26; x++) if ((a * x) % 26 === 1) return x; return null; };
  let best = null;
  for (const a of [1, 3, 5, 7, 9, 11, 15, 17, 19, 21, 23, 25]) {
    const ai = inv(a);
    for (let b = 0; b < 26; b++) {
      if (a === 1 && b === 0) continue;
      const text = s.replace(/[a-z]/gi, (c) => {
        const base = c <= 'Z' ? 65 : 97;
        return String.fromCharCode(base + ((ai * ((c.charCodeAt(0) - base) - b)) % 26 + 26) % 26);
      });
      const score = textScore(toBytes(text.toLowerCase()));
      if (!best || score > best.score) best = { a, b, text, score: Number(score.toFixed(3)) };
    }
  }
  return best;
}

// --- E622: doğal dil tespiti ---
const SCRIPTS = [
  ['Kiril', /[Ѐ-ӿ]/g], ['Yunan', /[Ͱ-Ͽ]/g], ['Arap', /[؀-ۿ]/g], ['İbrani', /[֐-׿]/g],
  ['Çince/Japonca', /[぀-ヿ一-鿿]/g], ['Korece', /[가-힯]/g], ['Tay', /[฀-๿]/g],
  ['Devanagari', /[ऀ-ॿ]/g], ['Latin', /[a-zA-ZÀ-ɏ]/g],
];
const STOPWORDS = {
  en: ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'for', 'it', 'with', 'you', 'are', 'this', 'on', 'be', 'not'],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'da', 'de', 'çok', 'olan', 'gibi', 'daha', 'ama', 'mi', 'ne', 'var', 'şifre'],
  de: ['der', 'die', 'und', 'das', 'ist', 'nicht', 'ein', 'zu', 'mit', 'sie', 'den', 'ich', 'auf', 'für'],
  fr: ['le', 'la', 'les', 'et', 'des', 'est', 'une', 'un', 'pour', 'que', 'dans', 'pas', 'vous', 'sur'],
  es: ['el', 'la', 'los', 'que', 'y', 'en', 'es', 'por', 'una', 'para', 'con', 'no', 'las', 'del'],
  it: ['il', 'che', 'di', 'la', 'e', 'per', 'non', 'una', 'sono', 'con', 'del', 'gli', 'della'],
  pt: ['o', 'que', 'de', 'não', 'uma', 'para', 'com', 'os', 'em', 'você', 'do', 'da', 'por'],
  nl: ['de', 'het', 'een', 'en', 'van', 'niet', 'is', 'dat', 'op', 'te', 'zijn', 'voor', 'met'],
};
const LANG_CHARS = { tr: /[ğışĞİŞ]/g, de: /[äöüßÄÖÜ]/g, fr: /[éèêàçœ]/g, es: /[ñ¿¡áíóú]/g, pt: /[ãõâêç]/g };

export function detectLanguage(text) {
  const s = String(text);
  let script = null;
  let best = 0;
  for (const [name, re] of SCRIPTS) {
    const n = (s.match(re) ?? []).length;
    if (n > best) { best = n; script = name; }
  }
  const letters = best;
  const words = s.toLowerCase().match(/[a-zçğıöşüäßéèêàñáíóúãõâœ]+/g) ?? [];
  const spaces = (s.match(/\s/g) ?? []).length;
  // doğal dil: harf oranı yüksek, kelime ortalaması 2–10, boşluk oranı makul
  const avgWord = words.length ? words.reduce((a, w) => a + w.length, 0) / words.length : 0;
  const natural = s.length >= 8 && letters / s.length > 0.55 && (script !== 'Latin' || (spaces / s.length > 0.08 && avgWord >= 2 && avgWord <= 10));
  if (script !== 'Latin') return { natural, script, lang: null, confidence: natural ? 0.6 : 0 };
  const scores = {};
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    scores[lang] = words.filter((w) => set.has(w)).length / Math.max(1, words.length);
    if (LANG_CHARS[lang]) scores[lang] += ((s.match(LANG_CHARS[lang]) ?? []).length / Math.max(1, letters)) * 3;
  }
  const [lang, sc] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return { natural, script, lang: natural && sc > 0 ? lang : null, confidence: Number(Math.min(1, sc * 3).toFixed(2)) };
}

// --- Rapor: gömülü veri blokları ve kodun genel istatistikleri ---
const b64ToBytes = (s) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t) || t.length % 4 === 1) return null;
  try { return Uint8Array.from(atob(t.padEnd(Math.ceil(t.length / 4) * 4, '=')), (c) => c.charCodeAt(0)); } catch { return null; }
};
const hexToBytes = (s) => (/^(?:[0-9a-f]{2})+$/i.test(s) ? Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16)) : null);
const hexKey = (k) => k.map((x) => x.toString(16).padStart(2, '0')).join('');
function readableText(bytes) {
  let s;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  const printable = [...s].filter((c) => c >= ' ' || c === '\n' || c === '\r' || c === '\t').length;
  return s.length && printable / [...s].length >= 0.9 ? s : null;
}

export async function blobReport(strings, code = '') {
  const rows = [];
  for (const s of strings) {
    if (s.length < 24 || s.length > 65536 || rows.length >= 20) continue;
    const textVerdict = entropyVerdict(s);
    if (textVerdict.verdict === 'text') continue;
    const bytes = hexToBytes(s) ?? b64ToBytes(s);
    const row = { value: s.slice(0, 80), length: s.length, string: textVerdict, distribution: charDistribution(s) };
    if (bytes && bytes.length >= 16) {
      row.bytes = entropyVerdict(bytes);
      row.compression = await compressionRatio(bytes);
      // E90: sıkıştırılmış blob (gzip/zlib/deflate DecompressionStream ya da saf JS; brotli)
      const dz = await decompressAny(bytes).catch(() => null);
      const dzText = dz ? readableText(dz.data) : null;
      if (dzText) row.decompressed = { format: dz.format, size: dz.data.length, text: dzText.slice(0, 300), language: detectLanguage(dzText) };
      row.ecb = [ecbRepeats(bytes, 16), ecbRepeats(bytes, 8)].find((e) => e.ecbLikely) ?? null;
      row.randomness = randomnessTests(bytes);
      row.ioc = indexOfCoincidence(bytes, false);
      row.kasiski = kasiski(bytes).candidates.slice(0, 3);
      // anahtar kurtarma yalnızca rastgele görünmeyen (zayıf şifreli) bloklarda anlamlı
      if (!row.randomness?.looksRandom || row.bytes.entropy < 7) {
        const kp = knownPlaintextXor(bytes);
        const corr = kp ? null : xorByCorrelation(bytes);
        const brute = kp || (corr && corr.score > 2) ? [] : bruteForceSmall(bytes);
        const best = kp ? { method: `bilinen düz metin (${kp.crib})`, key: hexKey(kp.key), text: kp.text }
          : corr && corr.score > 2 ? { method: `XOR korelasyonu (${corr.key.length} bayt)`, key: hexKey(corr.key), text: corr.text }
            : brute[0] ? { method: `kaba kuvvet ${brute[0].method}`, key: String(brute[0].key), text: brute[0].text } : null;
        if (best) row.recovered = { ...best, language: detectLanguage(best.text) };
      }
    } else {
      row.ioc = indexOfCoincidence(s);
      row.kasiski = kasiski(s).candidates.slice(0, 3);
      row.language = detectLanguage(s);
      if (row.ioc > 0.03 && row.ioc < 0.05) row.affine = affineBrute(s);
    }
    rows.push(row);
  }
  const sample = code.slice(0, 200000);
  return {
    code: sample ? { entropy: entropyVerdict(sample), distribution: charDistribution(sample), compression: await compressionRatio(sample) } : null,
    blobs: rows,
  };
}
