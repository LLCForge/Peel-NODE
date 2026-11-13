// V8 kod önbelleği (bytenode .jsc, pkg bytecode, SEA code cache) başlığı ve dizge çıkarımı.
// Bytecode'dan kaynağa çevirme yapılmaz: biçim V8 sürümüne bağlıdır. Yalnızca başlık alanları ve
// sabit havuzundaki okunur dizgeler (URL, webhook, komut gibi IOC'ler için) raporlanır.

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// Yerelde gerçek çıktıyla doğrulanmış sürüm karmaları (bytenode/SEA üretimi, Node 25.8.1)
const KNOWN_VERSION_HASHES = {
  0x6c813788: 'V8 14.1.146 (Node 25.8.x)',
};

/** Kod önbelleği sihirli sayısı: üst 16 bit 0xC0DE, alt bitler V8'in dış referans tablosu boyutu */
export const isV8Cache = (b) => b.length >= 24 && b[2] === 0xde && b[3] === 0xc0;

/**
 * Başlık: magic, sürüm karması, kaynak karması (kaynak uzunluğu), bayrak karması, [salt okunur anlık görüntü
 * sağlaması], yük uzunluğu, sağlama. Eski V8'lerde (Node ≤ 20) başlık 24 bayt, yenilerde 32 bayttır;
 * yük uzunluğu alanı hangisinde tutarlıysa o kabul edilir.
 */
export function parseV8CacheHeader(b) {
  if (!isV8Cache(b)) return null;
  const magic = u32(b, 0);
  let headerSize = null;
  let payloadLength = null;
  if (b.length >= 32 && u32(b, 20) === b.length - 32) { headerSize = 32; payloadLength = u32(b, 20); }
  else if (u32(b, 16) === b.length - 24) { headerSize = 24; payloadLength = u32(b, 16); }
  const versionHash = u32(b, 4);
  const sourceHash = u32(b, 8);
  return {
    magic: `0x${magic.toString(16)}`,
    // alt 16 bit dış referans tablosu boyutudur: aynı V8 ailesini ayırt etmeye yarar
    externalRefs: magic & 0xffff,
    versionHash: `0x${versionHash.toString(16)}`,
    v8: KNOWN_VERSION_HASHES[versionHash] ?? null,
    // kaynak karması = kaynak uzunluğu (+ üst bitlerde köken bayrakları); bytenode bu uzunlukta sahte kaynak üretir
    sourceHash: `0x${sourceHash.toString(16)}`,
    sourceLength: sourceHash & 0x1fffffff,
    flagHash: `0x${u32(b, 12).toString(16)}`,
    headerSize,
    payloadLength,
    complete: headerSize !== null,
  };
}

const PRINTABLE = (c) => c >= 0x20 && c < 0x7f;

/** ASCII ve UTF-16LE okunur dizgeler (en az minLen karakter) */
export function extractStrings(b, { minLen = 4, max = 3000 } = {}) {
  const out = new Set();
  let start = -1;
  for (let i = 0; i <= b.length; i++) {
    if (i < b.length && PRINTABLE(b[i])) { if (start < 0) start = i; continue; }
    if (start >= 0 && i - start >= minLen) {
      out.add(String.fromCharCode(...b.subarray(start, Math.min(i, start + 2000))));
      if (out.size >= max) return [...out];
    }
    start = -1;
  }
  // UTF-16LE: V8 iki baytlık dizgeleri (Türkçe vb. karakter içerenler) bu biçimde saklar
  for (let i = 0; i + 1 < b.length; i++) {
    let j = i;
    let s = '';
    while (j + 1 < b.length && b[j + 1] === 0 && PRINTABLE(b[j]) && s.length < 2000) { s += String.fromCharCode(b[j]); j += 2; }
    if (s.length >= minLen) { out.add(s); if (out.size >= max) break; i = j; }
  }
  return [...out];
}

const URL_RE = /\b(?:https?|wss?|ftp):\/\/[^\s"'`<>\\)]{3,}/gi;
const IP_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const CMD_RE = /\b(?:cmd(?:\.exe)?\s*\/c|powershell(?:\.exe)?|bash\s+-c|sh\s+-c|curl\s|wget\s|reg(?:\.exe)?\s+add|schtasks|crontab|launchctl|chmod\s+\+x|certutil|bitsadmin|mshta|rundll32)\b/i;

/** Dizgelerden IOC adayları: adresler, IP'ler, komutlar */
export function stringIocs(strings) {
  const urls = new Set();
  const ips = new Set();
  const commands = [];
  for (const s of strings) {
    for (const u of s.match(URL_RE) ?? []) urls.add(u);
    for (const ip of s.match(IP_RE) ?? []) if (!/^0\.|^255\./.test(ip)) ips.add(ip);
    if (CMD_RE.test(s) && commands.length < 100) commands.push(s.slice(0, 300));
  }
  return { urls: [...urls].slice(0, 200), ips: [...ips].slice(0, 100), commands };
}

/** Kod önbelleği özeti: başlık + dizgeler + IOC'ler */
export function v8CacheReport(b) {
  const header = parseV8CacheHeader(b);
  const strings = extractStrings(header?.headerSize ? b.subarray(header.headerSize) : b);
  return { header, strings, iocs: stringIocs(strings) };
}
