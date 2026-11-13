// E77: RSA parça çözümü. Koda gömülü anahtar parçalarından (PEM/DER, n/e/d ya da p/q sayıları)
// özel anahtarı kurar; yalnızca açık anahtar varsa küçük ya da yakın asal çarpanlı modülü çarpanlarına ayırır.

export const toBig = (bytes) => bytes.reduce((a, b) => (a << 8n) | BigInt(b), 0n);
export function fromBig(n, len = 0) {
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  while (out.length < len) out.unshift(0);
  return Uint8Array.from(out);
}

export function modPow(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

export function modInv(a, m) {
  let [r0, r1] = [((a % m) + m) % m, m];
  let [s0, s1] = [1n, 0n];
  while (r1) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) return null;
  return ((s0 % m) + m) % m;
}

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a < 0n ? -a : a; };

function isqrt(n) {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  if (x === 0n) x = 1n;
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x && x * x <= n && (x + 1n) * (x + 1n) > n) return x;
    x = y;
  }
}

// Pollard rho (Brent değil, Floyd) — bit uzunluğu küçük modüller için; iterasyon sınırlı
function pollardRho(n, limit = 2_000_000) {
  if (n % 2n === 0n) return 2n;
  for (let c = 1n; c < 20n; c++) {
    let x = 2n;
    let y = 2n;
    let d = 1n;
    const f = (v) => (v * v + c) % n;
    for (let i = 0; i < limit && d === 1n; i++) {
      x = f(x);
      y = f(f(y));
      d = gcd(x - y, n);
    }
    if (d !== 1n && d !== n) return d;
  }
  return null;
}

// Fermat: p ve q birbirine yakınsa hızlı
function fermat(n, limit = 1_000_000) {
  let a = isqrt(n);
  if (a * a < n) a++;
  for (let i = 0; i < limit; i++, a++) {
    const b2 = a * a - n;
    const b = isqrt(b2);
    if (b * b === b2) return a - b;
  }
  return null;
}

export function factor(n) {
  const bits = n.toString(2).length;
  const p = (bits <= 100 ? pollardRho(n) : null) ?? fermat(n);
  if (!p || p === 1n || p === n || n % p) return null;
  return [p, n / p];
}

// Eksik parçaları tamamla: { n, e, d, p, q } → tam anahtar ya da null
export function completeKey({ n = null, e = 65537n, d = null, p = null, q = null }) {
  if (!n && p && q) n = p * q;
  if (!n) return null;
  if (d) return { n, e, d, how: 'd' };
  if (p && !q && n % p === 0n) q = n / p;
  if (q && !p && n % q === 0n) p = n / q;
  let how = 'pq';
  if (!p || !q) {
    const f = factor(n);
    if (!f) return null;
    [p, q] = f;
    how = 'factor';
  }
  const phi = (p - 1n) * (q - 1n);
  const dd = modInv(e, phi);
  return dd ? { n, e, d: dd, p, q, how } : null;
}

// RSA çözme + PKCS#1 v1.5 (tip 2) ya da ham çıktı
export function rsaDecrypt(key, cipher) {
  const k = Math.ceil(key.n.toString(16).length / 2);
  const c = typeof cipher === 'bigint' ? cipher : toBig(cipher);
  if (c >= key.n) return null;
  const em = fromBig(modPow(c, key.d, key.n), k);
  if (em[0] === 0 && em[1] === 2) {
    const sep = em.indexOf(0, 2);
    if (sep >= 10) return { padding: 'pkcs1', data: em.subarray(sep + 1) };
  }
  let i = 0;
  while (i < em.length && em[i] === 0) i++;
  return { padding: 'raw', data: em.subarray(i) };
}

// --- DER/PEM ---
function readTlv(buf, off) {
  const tag = buf[off];
  let len = buf[off + 1];
  let head = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 4) throw new Error('DER uzunluğu çok büyük');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i];
    head += n;
  }
  if (off + head + len > buf.length) throw new Error('DER taşması');
  return { tag, start: off + head, end: off + head + len };
}

function children(buf, tlv) {
  const out = [];
  for (let off = tlv.start; off < tlv.end;) {
    const c = readTlv(buf, off);
    out.push(c);
    off = c.end;
  }
  return out;
}

const intOf = (buf, tlv) => toBig(buf.subarray(tlv.start, tlv.end));

// PKCS#1 RSAPrivateKey, PKCS#8 PrivateKeyInfo, PKCS#1 RSAPublicKey ya da SPKI
export function parseRsaDer(der) {
  const top = readTlv(der, 0);
  if (top.tag !== 0x30) return null;
  let items = children(der, top);
  // PKCS#8: version, AlgorithmIdentifier, OCTET STRING(RSAPrivateKey)
  if (items.length === 3 && items[1].tag === 0x30 && items[2].tag === 0x04) return parseRsaDer(der.subarray(items[2].start, items[2].end));
  // SPKI: AlgorithmIdentifier, BIT STRING(RSAPublicKey)
  if (items.length === 2 && items[0].tag === 0x30 && items[1].tag === 0x03) return parseRsaDer(der.subarray(items[1].start + 1, items[1].end));
  if (items.every((x) => x.tag === 0x02)) {
    if (items.length === 2) return { n: intOf(der, items[0]), e: intOf(der, items[1]) };
    if (items.length >= 9) {
      items = items.map((x) => intOf(der, x));
      return { n: items[1], e: items[2], d: items[3], p: items[4], q: items[5] };
    }
  }
  return null;
}

const PEM = /-----BEGIN (RSA )?(PRIVATE|PUBLIC) KEY-----([\s\S]*?)-----END (RSA )?(PRIVATE|PUBLIC) KEY-----/g;

export function parsePemKeys(text, b64decode) {
  const out = [];
  for (const m of text.matchAll(PEM)) {
    try {
      const der = b64decode(m[3].replace(/\\[nr]|[\s"']/g, ''));
      const key = der && parseRsaDer(der);
      if (key) out.push({ ...key, source: `PEM ${m[2].toLowerCase()}` });
    } catch { /* bozuk PEM */ }
  }
  return out;
}
