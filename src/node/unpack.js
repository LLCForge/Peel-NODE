// Node'a özgü paket açıcılar: pkg, nexe, Node SEA, bytenode .jsc, npm .tgz, asar, zip.
// Tarayıcıda ve Node'da çalışır (Node modülü kullanılmaz); her şey bellekte açılır, diske yazılmaz.
// Biçimler gerçek araç çıktılarıyla doğrulandı (test/unpack.test.js): @yao-pkg/pkg 6.25, nexe 5.0.0-beta.4,
// Node 25.8 SEA (postject), bytenode (Node 25), npm pack, @electron/asar.
//
// Sözleşme:
//   unpack(bytes, name) → { kind, files: [{ path, code, bytes, entry?, note? }], meta, notes }
//   kind: 'js' | 'jsc' | 'pkg' | 'nexe' | 'sea' | 'npm-tgz' | 'asar' | 'zip' | 'unknown'
//   code: metin dosyalarında UTF-8 içerik (bytes null); ikili dosyalarda null (bytes dolu)
import { decompress } from '../compress/index.js';
import { parseTar, parseZip } from '../security/archive.js';
import { readAsar } from '../integrations/asar.js';
import { isV8Cache, v8CacheReport, extractStrings, stringIocs } from './v8cache.js';

const MAX_FILES = 20_000;
const MAX_TEXT = 32 << 20;
const enc = new TextEncoder();
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
// 64 bit uzunluk: üst yarı sıfır değilse geçersiz say (blob'lar 4 GB'tan küçük)
const u64 = (b, o) => (o + 8 <= b.length && u32(b, o + 4) === 0 ? u32(b, o) : -1);
const f64 = (b, o) => new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0, true);

function decodeText(b) {
  if (b.length > MAX_TEXT) return null;
  const head = b.subarray(0, Math.min(b.length, 8192));
  if (head.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b).replace(/^﻿/, ''); } catch { return null; }
}

/** Uint8Array içinde bayt dizisi arar (ilk bayt için yerel indexOf) */
export function findBytes(hay, needle, from = 0) {
  const n = typeof needle === 'string' ? enc.encode(needle) : needle;
  for (let i = hay.indexOf(n[0], from); i >= 0 && i + n.length <= hay.length; i = hay.indexOf(n[0], i + 1)) {
    let k = 1;
    while (k < n.length && hay[i + k] === n[k]) k++;
    if (k === n.length) return i;
  }
  return -1;
}

export function findLastBytes(hay, needle, from = hay.length) {
  const n = typeof needle === 'string' ? enc.encode(needle) : needle;
  for (let i = hay.lastIndexOf(n[0], from - n.length); i >= 0; i = hay.lastIndexOf(n[0], i - 1)) {
    let k = 1;
    while (k < n.length && hay[i + k] === n[k]) k++;
    if (k === n.length) return i;
    if (i === 0) break;
  }
  return -1;
}

const isScriptPath = (p) => /\.(?:c|m)?js$/i.test(p);
const normPath = (p) => p.replace(/\\/g, '/').replace(/^(?:[A-Za-z]:)?\/*(?:snapshot\/)?/, '').replace(/^\.\//, '');

function fileOf(path, data, extra = {}) {
  const code = decodeText(data);
  return { path, code, bytes: code === null ? data : null, ...extra };
}

function executableFormat(b) {
  if (b[0] === 0x4d && b[1] === 0x5a) return 'PE';
  if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return 'ELF';
  const m = u32(b, 0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(m)) return 'Mach-O';
  return null;
}

// --- Node SEA ------------------------------------------------------------------------------------
// NODE_SEA_BLOB (PE kaynağı, ELF notu ya da Mach-O bölümü; postject) biçimi, Node 25 ile doğrulandı:
//   u32 magic 0x0143DA20 | u32 bayraklar | [Node 24+: 2 bayt uzantı] | u64+bayt kod yolu | u64+bayt ana betik
//   | bayrak 4: u64+bayt kod önbelleği | bayrak 8: u64 sayı, (u64+bayt ad, u64+bayt veri)* varlıklar
// Kapsayıcı ayrıştırılmaz: sihirli sayı taranır, yapı doğrulanır (kod içindeki aynı sabit elenir).
const SEA_MAGIC = Uint8Array.of(0x20, 0xda, 0x43, 0x01);
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const SEA_FLAGS = { disableWarning: 1, useSnapshot: 2, useCodeCache: 4, includeAssets: 8, execArgv: 16 };

const printablePath = (b) => b.length > 0 && b.every((c) => c >= 0x20 && c !== 0x7f);

function parseSeaBlob(b, off) {
  const flags = u32(b, off + 4);
  if (flags > 0xff) return null;
  for (const ext of [2, 0, 1]) {
    let p = off + 8 + ext;
    const pathLen = u64(b, p);
    if (pathLen <= 0 || pathLen > 4096 || !printablePath(b.subarray(p + 8, p + 8 + pathLen))) continue;
    const codePath = new TextDecoder().decode(b.subarray(p + 8, p + 8 + pathLen));
    p += 8 + pathLen;
    const codeLen = u64(b, p);
    if (codeLen < 0 || p + 8 + codeLen > b.length) continue;
    const main = b.subarray(p + 8, p + 8 + codeLen);
    p += 8 + codeLen;
    const out = { offset: off, flags, flagNames: Object.keys(SEA_FLAGS).filter((k) => flags & SEA_FLAGS[k]), headerExtra: ext, codePath, main, codeCache: null, assets: [], notes: [] };
    if (flags & SEA_FLAGS.useCodeCache) {
      const n = u64(b, p);
      if (n >= 0 && p + 8 + n <= b.length) { out.codeCache = b.subarray(p + 8, p + 8 + n); p += 8 + n; } else out.notes.push('kod önbelleği uzunluğu okunamadı');
    }
    if (flags & SEA_FLAGS.includeAssets) {
      const count = u64(b, p);
      p += 8;
      for (let i = 0; i < count && i < MAX_FILES; i++) {
        const kl = u64(b, p);
        if (kl <= 0 || kl > 4096 || p + 8 + kl > b.length) { out.notes.push('varlık tablosu okunamadı'); break; }
        const key = new TextDecoder().decode(b.subarray(p + 8, p + 8 + kl));
        p += 8 + kl;
        const vl = u64(b, p);
        if (vl < 0 || p + 8 + vl > b.length) { out.notes.push('varlık verisi okunamadı'); break; }
        out.assets.push({ key, data: b.subarray(p + 8, p + 8 + vl) });
        p += 8 + vl;
      }
    }
    // shortcut: execArgv (bayrak 16) listesi yerel Node 25 çıktısında yer almadı; görülürse yalnızca not düşülür
    if (flags & SEA_FLAGS.execArgv) out.notes.push('execArgv bayrağı var: komut satırı argümanları ayrıştırılmadı');
    return out;
  }
  return null;
}

function unpackSea(b) {
  let blob = null;
  for (let i = findBytes(b, SEA_MAGIC); i >= 0 && !blob; i = findBytes(b, SEA_MAGIC, i + 1)) blob = parseSeaBlob(b, i);
  if (!blob) return null;
  const fuse = findBytes(b, SEA_FUSE);
  const files = [];
  const notes = [];
  const mainPath = normPath(blob.codePath) || 'main.js';
  if (blob.flags & SEA_FLAGS.useSnapshot) {
    files.push({ path: `${mainPath}.snapshot`, code: null, bytes: blob.main, entry: true, note: 'ana betik V8 başlangıç anlık görüntüsü (useSnapshot): kaynak yok' });
    notes.push('SEA anlık görüntü (snapshot) ile derlenmiş: kaynak metin gömülü değil, yalnızca dizgeler çıkarıldı');
  } else {
    const code = decodeText(blob.main);
    files.push({ path: mainPath, code, bytes: code === null ? blob.main : null, entry: true });
  }
  let codeCache = null;
  if (blob.codeCache) {
    codeCache = v8CacheReport(blob.codeCache);
    files.push({ path: `${mainPath}.codecache`, code: null, bytes: blob.codeCache, note: 'V8 kod önbelleği (useCodeCache): kaynak zaten gömülü, önbellek yalnızca hızlandırma içindir' });
    notes.push('kod önbelleği var (useCodeCache): kaynak metin yine de gömülü');
  }
  for (const a of blob.assets) files.push(fileOf(`assets/${a.key.replace(/^[/\\]+/, '')}`, a.data, { note: 'SEA varlığı (sea.getAsset)' }));
  notes.push(...blob.notes);
  return {
    kind: 'sea',
    files,
    meta: {
      container: executableFormat(b),
      blobOffset: blob.offset,
      flags: blob.flags,
      flagNames: blob.flagNames,
      codePath: blob.codePath,
      fuse: fuse >= 0 ? { offset: fuse, enabled: b[fuse + SEA_FUSE.length + 1] === 0x31 } : null,
      codeCache: codeCache && { header: codeCache.header, strings: codeCache.strings.length },
      strings: blob.flags & SEA_FLAGS.useSnapshot ? extractStrings(blob.main).slice(0, 2000) : undefined,
    },
    notes,
  };
}

// --- pkg (vercel/pkg, yao-pkg) -------------------------------------------------------------------
// Taban ikili + yük (dosya parçaları art arda) + prelude. Prelude şu imzayla başlar ve sonunda satır satır
// JSON değerleri taşır: VFS, giriş noktası, sembolik bağlar, sözlük (yol sıkıştırma), sıkıştırma kodu.
// VFS: { "<snapshot yolu>": { "0": [ofset, boy] (bytecode), "1": içerik, "2": dizin listesi, "3": stat } }
// Ofsetler yük başlangıcına göredir; yük, prelude'dan hemen öncedir.
const PKG_PRELUDE = '(function(process, require, console, EXECPATH_FD, PAYLOAD_POSITION, PAYLOAD_SIZE) {';
const PKG_STORE = { blob: '0', content: '1', links: '2', stat: '3' };
const PKG_COMPRESS = { 0: null, 1: 'gzip', 2: 'brotli', 3: 'zstd' };

function pkgTail(text) {
  const lines = text.replace(/\s+$/, '').split('\n');
  if (lines.at(-1)?.trim() !== '})' || lines.at(-2)?.trim() !== ');') return null;
  const values = [];
  for (let i = lines.length - 3; i >= 0 && values.length < 8; i--) {
    const line = lines[i].trim();
    if (line === ',') continue;
    try { values.unshift(JSON.parse(line)); } catch { break; }
  }
  return values;
}

async function unpackPkg(b) {
  const start = findLastBytes(b, PKG_PRELUDE);
  if (start < 0) return null;
  const text = new TextDecoder().decode(b.subarray(start));
  const values = pkgTail(text);
  const vfs = values?.find((v) => v && typeof v === 'object' && !Array.isArray(v));
  if (!vfs) return null;
  const rest = values.slice(values.indexOf(vfs) + 1);
  const entrypoint = typeof rest[0] === 'string' ? rest[0] : null;
  const symlinks = rest[1] && typeof rest[1] === 'object' ? rest[1] : {};
  const dict = rest[2] && typeof rest[2] === 'object' ? rest[2] : {};
  const compress = typeof rest[3] === 'number' ? rest[3] : 0;
  const notes = [];
  let payloadSize = 0;
  for (const stores of Object.values(vfs)) {
    for (const v of Object.values(stores ?? {})) if (Array.isArray(v)) payloadSize = Math.max(payloadSize, v[0] + v[1]);
  }
  const payload = start - payloadSize;
  if (payload < 0) return null;
  // sözlükle sıkıştırılmış anahtarlar ("0/1/2") özgün yol parçalarına çevrilir
  const rev = Object.fromEntries(Object.entries(dict).map(([k, v]) => [v, k]));
  const dictUsed = Object.keys(rev).length > 0;
  const original = (key) => (dictUsed ? key.split('/').map((x) => rev[x] ?? x).join('/') : key);
  const codec = PKG_COMPRESS[compress];
  if (codec === undefined) notes.push(`bilinmeyen sıkıştırma kodu ${compress}`);
  const read = async (off, size) => {
    const raw = b.subarray(payload + off, payload + off + size);
    if (!codec) return raw;
    if (codec === 'zstd') throw new Error('zstd sıkıştırma desteklenmiyor');
    return decompress(raw, codec);
  };
  const files = [];
  const bytecodeStrings = [];
  const bytecodeFiles = [];
  const entry = entrypoint ? normPath(entrypoint) : null;
  for (const [key, stores] of Object.entries(vfs)) {
    if (files.length >= MAX_FILES) { notes.push(`${MAX_FILES} dosya sınırında kesildi`); break; }
    const path = normPath(original(key));
    const isEntry = path === entry;
    try {
      if (stores[PKG_STORE.content]) {
        const [o, s] = stores[PKG_STORE.content];
        files.push(fileOf(path, await read(o, s), isEntry ? { entry: true } : {}));
      } else if (stores[PKG_STORE.blob]) {
        const [o, s] = stores[PKG_STORE.blob];
        const data = await read(o, s);
        const rep = v8CacheReport(data);
        bytecodeStrings.push(...rep.strings);
        bytecodeFiles.push({ path, size: data.length, header: rep.header, strings: rep.strings.slice(0, 500), iocs: rep.iocs });
        files.push({ path, code: null, bytes: data, ...(isEntry ? { entry: true } : {}),
          note: 'V8 bytecode olarak derlenmiş (pkg varsayılanı): kaynak gömülü değil; dizgeler meta.bytecode altında' });
      }
    } catch (e) {
      files.push({ path, code: null, bytes: null, note: `okunamadı: ${e.message}` });
    }
  }
  if (bytecodeFiles.length) notes.push(`${bytecodeFiles.length} dosya V8 bytecode: kaynağa çevrilemez (V8 sürümüne bağlı), yalnızca dizgeler çıkarıldı`);
  if (codec) notes.push(`yük ${codec} ile sıkıştırılmış`);
  return {
    kind: 'pkg',
    files,
    meta: {
      container: executableFormat(b),
      preludeOffset: start,
      payloadOffset: payload,
      payloadSize,
      entrypoint: entry,
      compression: codec ?? 'none',
      symlinks: Object.keys(symlinks).length,
      bytecode: bytecodeFiles,
      iocs: stringIocs(bytecodeStrings),
    },
    notes,
  };
}

// --- nexe ----------------------------------------------------------------------------------------
// Dosya sonu: "<nexe~~sentinel>" + f64 içerik boyu + f64 kaynak boyu. İçerik (önyükleyici + giriş) ve kaynaklar
// sentinel'den hemen öncedir. nexe 5: kaynaklar "snapshot/..." yollu ZIP; eski sürümlerde içerikteki
// process.__nexe = {"resources": {yol: [ofset, boy]}} tablosu (eski biçim yerelde doğrulanmadı).
const NEXE_SENTINEL = '<nexe~~sentinel>';

function unpackNexe(b) {
  const pos = findLastBytes(b, NEXE_SENTINEL, b.length);
  if (pos < 0 || pos + 32 > b.length) return null;
  const contentSize = f64(b, pos + 16);
  const resourceSize = f64(b, pos + 24);
  if (![contentSize, resourceSize].every((x) => Number.isSafeInteger(x) && x >= 0)) return null;
  const contentStart = pos - resourceSize - contentSize;
  if (contentStart < 0) return null;
  const content = new TextDecoder().decode(b.subarray(contentStart, contentStart + contentSize));
  const resources = b.subarray(contentStart + contentSize, pos);
  const notes = [];
  const files = [];
  const entryMatch = content.match(/path\.resolve\(\s*path\.dirname\(\s*process\.execPath\s*\)\s*,\s*("(?:[^"\\]|\\.)*")\s*\)/);
  let entry = null;
  if (entryMatch) { try { entry = normPath(JSON.parse(entryMatch[1])); } catch { /* bozuk */ } }
  let format = 'unknown';
  if (resources.length >= 4 && u32(resources, 0) === 0x04034b50) {
    format = 'zip';
    for (const e of parseZip(resources)) {
      const path = normPath(e.name);
      if (!e.data) { files.push({ path, code: null, bytes: null, note: e.encrypted ? 'şifreli ZIP girdisi' : `desteklenmeyen sıkıştırma ${e.unsupported}` }); continue; }
      files.push(fileOf(path, e.data, path === entry ? { entry: true } : {}));
    }
  } else {
    const m = content.match(/process\.__nexe\s*=\s*(\{[^\n]*?\})\s*;?\s*\n/);
    let table = null;
    try { table = m ? JSON.parse(m[1]).resources : null; } catch { /* JSON değil */ }
    if (table && typeof table === 'object') {
      format = 'legacy';
      notes.push('eski nexe kaynak tablosu: bu biçim yerelde gerçek çıktıyla doğrulanmadı');
      for (const [p, v] of Object.entries(table)) {
        if (!Array.isArray(v) || files.length >= MAX_FILES) continue;
        const [o, s] = v;
        if (o < 0 || o + s > resources.length) continue;
        const path = normPath(p);
        files.push(fileOf(path, resources.subarray(o, o + s), path === entry ? { entry: true } : {}));
      }
    }
  }
  // nexe 5'te içerik nexe'nin kendi fs yamasıdır (webpack paketi): kaynak varsa çözülmez, yalnızca not düşülür
  const runtimeOnly = files.length > 0 && /fsPatcher|shimFs\(process\.__nexe\)/.test(content);
  files.unshift({ path: 'nexe/content.js', code: runtimeOnly ? null : content, bytes: runtimeOnly ? b.subarray(contentStart, contentStart + contentSize) : null,
    ...(files.length ? {} : { entry: true }),
    note: runtimeOnly ? 'nexe çalışma zamanı (sanal fs yaması + giriş yükleyici); kullanıcı kodu kaynaklarda' : 'nexe içerik paketi (giriş kodu burada)' });
  if (entry && !files.some((f) => f.entry)) notes.push(`giriş dosyası kaynaklarda bulunamadı: ${entry}`);
  return { kind: 'nexe', files, meta: { container: executableFormat(b), sentinelOffset: pos, contentStart, contentSize, resourceSize, resourceFormat: format, entrypoint: entry }, notes };
}

// --- npm paketi (.tgz) ---------------------------------------------------------------------------
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'preuninstall', 'uninstall', 'postuninstall', 'prepublish', 'prepack', 'postpack'];
// kurulumda kendiliğinden çalışanlar (npm install <paket>)
export const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare'];

/** Betik komutunun çalıştırdığı paket içi dosyalar ("node x.js", "./x.sh", "node x") */
export function scriptTargets(cmd, has) {
  const out = new Set();
  for (const tok of cmd.split(/[\s;&|()<>"'`]+/)) {
    const t = tok.replace(/^\.\//, '');
    if (!t || t.startsWith('-') || /^(node|npm|npx|sh|bash|cmd|powershell|exit|echo|true)$/i.test(t)) continue;
    for (const c of [t, `${t}.js`, `${t}/index.js`]) if (has(c)) { out.add(c); break; }
  }
  return [...out];
}

function packageInfo(pkg, has) {
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const lifecycle = Object.fromEntries(LIFECYCLE.filter((k) => typeof scripts[k] === 'string').map((k) => [k, scripts[k]]));
  const bin = typeof pkg.bin === 'string' ? { [pkg.name ?? 'bin']: pkg.bin } : pkg.bin && typeof pkg.bin === 'object' ? pkg.bin : {};
  const deps = (o) => (o && typeof o === 'object' ? o : {});
  // binding.gyp varsa ve install betiği yoksa npm "node-gyp rebuild" çalıştırır
  const implicitGyp = has('binding.gyp') && !scripts.install && !scripts.preinstall;
  return {
    name: typeof pkg.name === 'string' ? pkg.name : null,
    version: typeof pkg.version === 'string' ? pkg.version : null,
    description: typeof pkg.description === 'string' ? pkg.description.slice(0, 500) : null,
    main: typeof pkg.main === 'string' ? pkg.main : null,
    bin,
    lifecycle,
    implicitGyp,
    dependencies: deps(pkg.dependencies),
    optionalDependencies: deps(pkg.optionalDependencies),
    devDependencies: Object.keys(deps(pkg.devDependencies)).length,
    repository: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? null,
    publishConfig: pkg.publishConfig ?? null,
  };
}

function markPackageEntries(files, info, notes) {
  const index = new Map(files.map((f) => [f.path, f]));
  const has = (p) => index.has(p);
  const tag = (p, entry, note) => {
    const f = index.get(p);
    if (!f) return;
    if (entry) f.entry = true;
    f.note = f.note ? `${f.note}; ${note}` : note;
  };
  const runs = {};
  for (const [hook, cmd] of Object.entries(info.lifecycle)) {
    const targets = scriptTargets(cmd, has);
    runs[hook] = targets;
    for (const t of targets) tag(t, INSTALL_HOOKS.includes(hook), `${hook} betiği çalıştırıyor: ${cmd.slice(0, 200)}`);
    if (INSTALL_HOOKS.includes(hook)) notes.push(`kurulumda çalışır — ${hook}: ${cmd.slice(0, 200)}`);
  }
  const resolve = (p) => {
    const n = p.replace(/^\.\//, '');
    return [n, `${n}.js`, `${n}/index.js`].find(has);
  };
  if (info.main) { const m = resolve(info.main); if (m) tag(m, false, 'package.json main'); }
  else if (has('index.js')) tag('index.js', false, 'varsayılan main');
  for (const [k, v] of Object.entries(info.bin)) { const m = typeof v === 'string' && resolve(v); if (m) tag(m, false, `bin: ${k}`); }
  if (info.implicitGyp) notes.push('binding.gyp var: npm kurulumda node-gyp rebuild çalıştırır (yerel derleme)');
  return runs;
}

async function unpackTgz(b, name) {
  let tar;
  try { tar = await decompress(b, 'gzip'); } catch { return null; }
  let entries;
  try { entries = parseTar(tar); } catch { return null; }
  if (!entries.length) return null;
  // npm pack her şeyi "package/" altına koyar; GitHub tarball'larında farklı tek kök dizin olabilir
  const roots = new Set(entries.map((e) => e.name.split('/')[0]));
  const strip = roots.size === 1 && entries.every((e) => e.name.includes('/'));
  const files = entries.slice(0, MAX_FILES).map((e) => fileOf(strip ? e.name.slice(e.name.indexOf('/') + 1) : e.name, e.data));
  const notes = [];
  const pj = files.find((f) => f.path === 'package.json');
  let info = null;
  let runs = {};
  if (pj?.code) {
    try {
      info = packageInfo(JSON.parse(pj.code), (p) => files.some((f) => f.path === p));
      runs = markPackageEntries(files, info, notes);
    } catch (e) { notes.push(`package.json okunamadı: ${e.message}`); }
  } else notes.push('package.json yok: npm paketi olmayabilir');
  return { kind: 'npm-tgz', files, meta: { root: strip ? [...roots][0] : null, package: info, lifecycleTargets: runs, archive: name }, notes };
}

// --- asar / zip ----------------------------------------------------------------------------------
function unpackAsar(b) {
  let a;
  try { a = readAsar(b); } catch { return null; }
  const notes = [];
  const files = [];
  for (const f of a.files.slice(0, MAX_FILES)) {
    if (f.link) { files.push({ path: f.path, code: null, bytes: null, note: `sembolik bağ → ${f.link}` }); continue; }
    if (f.unpacked) { files.push({ path: f.path, code: null, bytes: null, note: 'app.asar.unpacked içinde (arşivde veri yok)' }); continue; }
    files.push(fileOf(f.path, a.read(f.path)));
  }
  let info = null;
  const pj = files.find((f) => f.path === 'package.json');
  if (pj?.code) {
    try {
      info = packageInfo(JSON.parse(pj.code), (p) => files.some((f) => f.path === p));
      const main = [info.main ?? 'index.js'].map((m) => m.replace(/^\.\//, '')).flatMap((m) => [m, `${m}.js`, `${m}/index.js`]).find((p) => files.some((f) => f.path === p));
      const mf = files.find((f) => f.path === main);
      if (mf) { mf.entry = true; mf.note = 'Electron ana süreç girişi (package.json main)'; }
    } catch (e) { notes.push(`package.json okunamadı: ${e.message}`); }
  }
  const unpacked = a.files.filter((f) => f.unpacked).length;
  if (unpacked) notes.push(`${unpacked} dosya app.asar.unpacked klasöründe: ayrıca verilmeli`);
  return { kind: 'asar', files, meta: { entries: a.files.length, unpacked, package: info }, notes };
}

function unpackZip(b) {
  let entries;
  try { entries = parseZip(b); } catch { return null; }
  const files = entries.slice(0, MAX_FILES).map((e) => (e.data ? fileOf(e.name, e.data)
    : { path: e.name, code: null, bytes: null, note: e.encrypted ? 'şifreli girdi' : `desteklenmeyen sıkıştırma yöntemi ${e.unsupported}` }));
  const notes = [];
  // tek kök dizinli npm paketi ya da Electron uygulaması: package.json girişleri işaretlenir
  const pj = files.find((f) => /^(?:[^/]+\/)?package\.json$/.test(f.path) && f.code);
  let info = null;
  if (pj) {
    const prefix = pj.path.slice(0, pj.path.length - 'package.json'.length);
    try {
      info = packageInfo(JSON.parse(pj.code), (p) => files.some((f) => f.path === prefix + p));
      const sub = files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
      markPackageEntries(sub, info, notes);
      for (const s of sub) if (s.entry || s.note) Object.assign(files.find((f) => f.path === prefix + s.path), { entry: s.entry, note: s.note });
    } catch (e) { notes.push(`package.json okunamadı: ${e.message}`); }
  }
  return { kind: 'zip', files, meta: { entries: entries.length, package: info }, notes };
}

// --- bytenode .jsc -------------------------------------------------------------------------------
function unpackJsc(b, name) {
  const rep = v8CacheReport(b);
  return {
    kind: 'jsc',
    files: [{ path: name || 'input.jsc', code: null, bytes: b, entry: true, note: 'V8 kod önbelleği (bytenode): çözülemez, yalnızca dizgeler' }],
    meta: { v8: rep.header, strings: rep.strings, iocs: rep.iocs },
    notes: [
      'çözülemez, yalnızca dizgeler: V8 bytecode kaynağa çevrilmez (biçim V8 sürümüne bağlı, kapsam dışı)',
      rep.header?.v8 ? `derleyen: ${rep.header.v8}` : `V8 sürüm karması ${rep.header?.versionHash ?? '?'} (bilinen tabloda yok)`,
      ...(rep.header?.complete ? [] : ['başlıktaki yük uzunluğu dosya boyuyla uyuşmuyor: kesik ya da değiştirilmiş olabilir']),
    ],
  };
}

const EXT_KIND = { '.jsc': 'jsc', '.tgz': 'npm-tgz', '.asar': 'asar', '.zip': 'zip', '.nupkg': 'zip', '.crx': 'zip', '.xpi': 'zip' };

/** Girdi bir paket/kapsayıcı mı (CLI: unpack gerekir mi) — sihirli baytlara, yoksa uzantıya bakar */
export function isContainer(bytes, name = '') {
  if (bytes.length >= 4) {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) return true;
    if (u32(bytes, 0) === 0x04034b50) return true;
    if (isV8Cache(bytes)) return true;
    if (executableFormat(bytes)) return true;
    if (u32(bytes, 0) === 4 && bytes.length >= 16 && bytes[16] === 0x7b) return true; // asar: {"files"
  }
  const ext = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  return Boolean(ext && (EXT_KIND[ext] || ext === '.exe'));
}

/**
 * @param {Uint8Array} bytes
 * @param {string} name  dosya adı (uzantı ipucu ve tek dosya yolu için)
 */
export async function unpack(bytes, name = '') {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Uint8Array bekleniyor');
  const base = String(name).split(/[\\/]/).pop();
  const tries = [];
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) tries.push(() => unpackTgz(bytes, base));
  if (bytes.length >= 4 && u32(bytes, 0) === 0x04034b50) tries.push(() => unpackZip(bytes));
  if (bytes.length >= 16 && u32(bytes, 0) === 4) tries.push(() => unpackAsar(bytes));
  if (isV8Cache(bytes)) tries.push(() => unpackJsc(bytes, base));
  if (executableFormat(bytes)) tries.push(() => unpackNexe(bytes), () => unpackPkg(bytes), () => unpackSea(bytes));
  for (const t of tries) {
    const r = await t();
    if (r) return r;
  }
  const text = decodeText(bytes);
  if (text !== null && !executableFormat(bytes)) {
    return { kind: 'js', files: [{ path: base || 'input.js', code: text, bytes: null, entry: true }], meta: {}, notes: [] };
  }
  const fmt = executableFormat(bytes);
  const strings = extractStrings(bytes.length > 64 << 20 ? bytes.subarray(0, 64 << 20) : bytes, { minLen: 6, max: 2000 });
  return {
    kind: 'unknown',
    files: [],
    meta: { container: fmt, size: bytes.length, iocs: stringIocs(strings) },
    notes: [fmt ? `${fmt} ikilisi: pkg, nexe ya da Node SEA imzası bulunamadı` : 'tanınan bir paket biçimi değil'],
  };
}

export { isScriptPath };
