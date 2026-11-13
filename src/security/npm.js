// E105: npm supply-chain karşılaştırması. Kullanıcı açıkça istediğinde registry.npmjs.org'dan paketin
// yayımlanmış sürümü indirilir (yalnızca bu adres), bütünlüğü (dist.integrity, SHA-512) doğrulanır, tar
// bellekte açılır ve analiz edilen betik yayımlanan dosyayla karşılaştırılır: eklenen satırlar, yeni IOC'ler
// ve şüpheli API'ler, kurulum betikleri.
import { decompress } from '../compress/index.js';
import { parseTar } from './archive.js';

export const REGISTRY = 'https://registry.npmjs.org';
// npm paket adı kuralları: isteğe bağlı @kapsam/, küçük harf, URL güvenli karakterler, en fazla 214
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION = /^(latest|next|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

export function validatePackage(name, version) {
  if (typeof name !== 'string' || name.length > 214 || !NAME.test(name)) return 'geçersiz paket adı';
  if (typeof version !== 'string' || !VERSION.test(version)) return 'geçersiz sürüm (ör. 1.2.3 ya da latest)';
  return null;
}

/** İstekten önce kullanıcıya gösterilecek tam adres */
export function metadataUrl(name, version) {
  const err = validatePackage(name, version);
  if (err) throw new Error(err);
  const enc = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  return `${REGISTRY}/${enc}/${encodeURIComponent(version)}`;
}

async function sha(alg, bytes) {
  return new Uint8Array(await crypto.subtle.digest(alg, bytes));
}
const toB64 = (u8) => btoa(String.fromCharCode(...u8));
const toHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function verifyIntegrity(bytes, integrity) {
  if (!integrity) return { ok: null, reason: 'bütünlük bilgisi yok' };
  for (const part of integrity.split(/\s+/)) {
    const m = part.match(/^(sha512|sha384|sha256|sha1)-(.+)$/);
    if (!m) continue;
    const alg = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' }[m[1]];
    const got = toB64(await sha(alg, bytes));
    return { ok: got === m[2], alg: m[1], reason: got === m[2] ? 'eşleşiyor' : 'UYUŞMUYOR' };
  }
  return { ok: null, reason: 'desteklenen özet yok' };
}

/**
 * Yayımlanan paketi indirir. fetchImpl test için değiştirilebilir.
 * @returns {{ name, version, tarball, integrity, files: Map<string, Uint8Array>, packageJson }}
 */
export async function fetchPublished(name, version, { fetchImpl = fetch, signal } = {}) {
  const url = metadataUrl(name, version);
  const res = await fetchImpl(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`registry yanıtı ${res.status}`);
  const meta = await res.json();
  const tarball = meta?.dist?.tarball;
  // yalnızca registry.npmjs.org üzerindeki tarball indirilir (metadata başka bir hosta yönlendiremez)
  let tUrl;
  try { tUrl = new URL(tarball); } catch { throw new Error('tarball adresi geçersiz'); }
  if (tUrl.protocol !== 'https:' || tUrl.hostname !== 'registry.npmjs.org') throw new Error(`beklenmeyen tarball adresi: ${tarball}`);
  const tRes = await fetchImpl(tUrl.href, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!tRes.ok) throw new Error(`tarball yanıtı ${tRes.status}`);
  const gz = new Uint8Array(await tRes.arrayBuffer());
  if (gz.length > 50 << 20) throw new Error('tarball 50 MB sınırını aşıyor');
  const integrity = await verifyIntegrity(gz, meta.dist.integrity);
  if (integrity.ok === false) throw new Error('tarball bütünlük doğrulaması başarısız (dist.integrity)');
  const tar = await decompress(gz, 'gzip');
  const files = new Map();
  for (const f of parseTar(tar)) files.set(f.name.replace(/^[^/]+\//, ''), f.data); // "package/" öneki
  let packageJson = null;
  try { packageJson = JSON.parse(new TextDecoder().decode(files.get('package.json'))); } catch { /* yok/bozuk */ }
  return { name: meta.name ?? name, version: meta.version ?? version, tarball: tUrl.href, integrity, files, packageJson };
}

// --- karşılaştırma ---
const SUSPICIOUS = [
  [/\beval\s*\(|new\s+Function\s*\(/, 'dinamik kod'],
  [/child_process|\bexecSync?\s*\(|\bspawn\s*\(/, 'süreç çalıştırma'],
  [/process\.env/, 'ortam değişkenleri'],
  [/require\(\s*["'](https?|net|dns|tls)["']\s*\)|\bfetch\s*\(|XMLHttpRequest/, 'ağ erişimi'],
  [/Buffer\.from\([^)]*["']base64["']\)|\batob\s*\(/, 'base64 çözme'],
  [/\.npmrc|\.ssh|id_rsa|\.aws\/credentials|wallet\.dat|Local Storage\/leveldb/i, 'kimlik/cüzdan dosyaları'],
  [/os\.(homedir|hostname|userInfo)\(|os\.networkInterfaces/, 'sistem bilgisi toplama'],
  [/fs\.(writeFile|appendFile|unlink|rm)/, 'dosya yazma/silme'],
  [/discord(app)?\.com\/api\/webhooks|api\.telegram\.org\/bot/i, 'webhook ile dışarı gönderim'],
];
const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`<>\\)]{3,}/gi;

function lineDiff(a, b) {
  const A = a.split(/\r?\n/);
  const B = b.split(/\r?\n/);
  const count = (lines) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map());
  const ca = count(A);
  const cb = count(B);
  const added = [];
  const removed = [];
  for (const l of B) { const n = ca.get(l) ?? 0; if (n > 0) ca.set(l, n - 1); else if (l.trim()) added.push(l); }
  for (const l of A) { const n = cb.get(l) ?? 0; if (n > 0) cb.set(l, n - 1); else if (l.trim()) removed.push(l); }
  return { added, removed };
}

const jaccard = (a, b) => {
  const A = new Set(a.split(/\W+/).filter(Boolean));
  const B = new Set(b.split(/\W+/).filter(Boolean));
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.max(1, A.size + B.size - inter);
};

/**
 * @param {string} local     analiz edilen betik
 * @param {object} published fetchPublished sonucu
 * @param {string|null} path paket içindeki dosya yolu; yoksa en benzer .js dosyası seçilir
 */
export async function compareWithPublished(local, published, path = null) {
  const decode = (b) => new TextDecoder().decode(b);
  let chosen = path && published.files.has(path) ? path : null;
  let similarity = null;
  if (!chosen) {
    let best = -1;
    for (const [p, data] of published.files) {
      if (!/\.(c|m)?js$/.test(p) || data.length > 5 << 20) continue;
      const s = jaccard(local, decode(data));
      if (s > best) { best = s; chosen = p; }
    }
    similarity = best < 0 ? null : Number(best.toFixed(3));
  }
  const pkg = published.packageJson ?? {};
  const scripts = Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter(([k]) => /^(pre|post)?install$|^prepare$/.test(k)));
  if (!chosen) return { file: null, similarity, identical: false, installScripts: scripts, added: [], removed: [], newUrls: [], newApis: [] };
  const remote = decode(published.files.get(chosen));
  const enc = new TextEncoder();
  const [lh, rh] = await Promise.all([sha('SHA-256', enc.encode(local)), sha('SHA-256', enc.encode(remote))]);
  const identical = toHex(lh) === toHex(rh);
  const { added, removed } = identical ? { added: [], removed: [] } : lineDiff(remote, local);
  const addedText = added.join('\n');
  const remoteUrls = new Set(remote.match(URL_RE) ?? []);
  return {
    file: chosen,
    similarity,
    identical,
    localSha256: toHex(lh),
    publishedSha256: toHex(rh),
    installScripts: scripts,
    addedCount: added.length,
    removedCount: removed.length,
    added: added.slice(0, 200),
    removed: removed.slice(0, 200),
    newUrls: [...new Set(addedText.match(URL_RE) ?? [])].filter((u) => !remoteUrls.has(u)),
    newApis: SUSPICIOUS.filter(([re]) => re.test(addedText) && !re.test(remote)).map(([, label]) => label),
    verdict: identical ? 'yayımlanan dosyayla aynı' : added.length ? 'yayımlanan sürümde olmayan kod var' : 'yalnızca silinmiş satırlar',
  };
}
