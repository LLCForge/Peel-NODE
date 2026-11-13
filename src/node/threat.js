// Node tehdit analizi: npm yaşam döngüsü, ortam/token sızdırma, kimlik dosyaları, Discord/tarayıcı hırsızlığı,
// cüzdan/clipper, ters kabuk, indirici-çalıştırıcı, kalıcılık, typosquatting, bağımlılık karışıklığı, anti-analiz.
// Kaynaklar: (1) çözülmüş çıktının statik metni, (2) sandbox etki günlüğü (__peelEffects), (3) unpack meta'sı
// (package.json). Her sınıf kanıtlarıyla döner; sezgiseldir, kesin hüküm değildir.

// Sandbox etki türü → kategori. Node taklitleri (src/sandbox/node-stubs.js) 'node.exec', 'node.fs.write',
// 'node.env.read', 'node.require' gibi türler kaydeder; adlar birleşmede değişirse yalnızca bu tablo güncellenir.
// Tam eşleşme yoksa türün en uzun öneki aranır ('node.fs.write.sync' → 'node.fs.write').
export const NODE_EFFECT_KINDS = {
  'node.exec': 'exec',
  'node.spawn': 'exec',
  'node.fork': 'exec',
  'node.child_process': 'exec',
  'node.fs.write': 'fsWrite',
  'node.fs.append': 'fsWrite',
  'node.fs.copy': 'fsWrite',
  'node.fs.chmod': 'fsWrite',
  'node.fs.unlink': 'fsDelete',
  'node.fs.rm': 'fsDelete',
  'node.fs.read': 'fsRead',
  'node.fs.readdir': 'fsRead',
  'node.fs.stat': 'fsRead',
  'node.fs.exists': 'fsRead',
  'node.env.read': 'envRead',
  'node.env.enum': 'envRead',
  'node.env': 'envRead',
  'node.require': 'require',
  'node.net': 'netConnect',
  'node.net.connect': 'netConnect',
  'node.socket': 'netConnect',
  'node.tls.connect': 'netConnect',
  'node.http': 'http',
  'node.https': 'http',
  'node.http.request': 'http',
  'node.https.request': 'http',
  'node.fetch': 'http',
  'node.dns': 'dns',
  'node.os': 'sysinfo',
  'node.clipboard': 'clipboard',
  'node.process.exit': 'exit',
  // src/sandbox/node-stubs.js'in gerçek adları
  'node.fs.delete': 'fsDelete',
  'node.fs.list': 'fsRead',
  'node.fs.open': 'fsRead',
  'node.fs.watch': 'fsRead',
  'node.fs.mkdir': 'fsWrite',
  'node.fs.rename': 'fsWrite',
  'node.fs.link': 'fsWrite',
  'node.env.write': 'envRead',
  'node.exit': 'exit',
  'node.worker': 'exec',
};

// öykünme ağ çağrılarını tek "net" türüyle kaydeder, API hedeftedir (https.request, net.connect, dns.lookup)
function netCategory(target) {
  const t = String(target ?? '');
  if (/^dns\b|lookup|resolve/.test(t)) return 'dns';
  if (/^(https?|http2|fetch|undici)\b/.test(t)) return 'http';
  return 'netConnect';
}

export function effectCategory(kind, target) {
  if (kind === 'net') return netCategory(target);
  let k = String(kind ?? '');
  while (k) {
    if (Object.hasOwn(NODE_EFFECT_KINDS, k)) return NODE_EFFECT_KINDS[k];
    const i = k.lastIndexOf('.');
    if (i < 0) break;
    k = k.slice(0, i);
  }
  return null;
}

/** Etki günlüğünü kategorilere ayırır: { exec: [{kind,target,detail,seq}], ... } */
export function groupEffects(effects = []) {
  const out = {};
  for (const e of effects ?? []) {
    const c = effectCategory(e?.kind, e?.target);
    if (c) (out[c] ??= []).push(e);
  }
  return out;
}

const SHELL = /(?:^|[\\/\s'"])(?:sh|bash|zsh|dash|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh)(?:$|[\s'"])/i;
const CRED_FILES = /\.npmrc|\.ssh[\\/]|id_rsa|id_ed25519|id_ecdsa|\.aws[\\/](?:credentials|config)|\.git-credentials|\.netrc|\.docker[\\/]config\.json|\.kube[\\/]config|\.pypirc|gh[\\/]hosts\.yml|\.config[\\/]gcloud/i;

const STATIC = {
  childProcess: [/require\(\s*['"](?:node:)?child_process['"]\s*\)|\bchild_process\b|(?<![.\w$])(?:execSync|execFileSync|spawnSync|execFile|spawn|fork)\s*\(/, 'child_process kullanımı'],
  shell: [/['"`](?:\/bin\/)?(?:ba|z)?sh['"`]|['"`](?:cmd|powershell|pwsh)(?:\.exe)?['"`]|\b(?:cmd(?:\.exe)?\s*\/c|powershell(?:\.exe)?\s+-)/i, 'kabuk (sh/cmd/powershell)'],
  netSocket: [/\bnet\.(?:connect|createConnection|Socket)\b|new\s+(?:net\.)?Socket\s*\(|require\(\s*['"](?:node:)?net['"]\s*\)/, 'ham TCP soketi (net)'],
  pipeShell: [/\.pipe\(\s*[\w$.]+\.stdin\s*\)|\.stdout\.pipe\(|\.stderr\.pipe\(|\.stdin\.write\(/, 'soket ↔ süreç akış bağlantısı'],
  envAll: [/JSON\.stringify\(\s*process\.env\s*\)|Object\.(?:keys|entries|values|assign)\([^)]*process\.env\s*\)|\.\.\.\s*process\.env\b|[:=(,]\s*process\.env\s*[,;})\]]/, 'process.env tamamı okunuyor'],
  envSecrets: [/process\.env\.(?:NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN|AWS_[A-Z_]+|[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z_]*)\b/, 'gizli ortam değişkeni'],
  network: [/require\(\s*['"](?:node:)?(?:https?|net|dns|tls|dgram|http2)['"]\s*\)|\b(?:https?|axios|got|needle|superagent)\.(?:get|post|put|request)\s*\(|\bfetch\s*\(|new\s+WebSocket\(|XMLHttpRequest|\brequest\(\s*\{/, 'ağ erişimi'],
  download: [/\bhttps?\.get\s*\(|\bfetch\s*\(|axios\.get\s*\(|\b(?:curl|wget)\s+[^'"]*https?:|Invoke-WebRequest|DownloadFile|DownloadString|certutil[^'"]*-urlcache|bitsadmin[^'"]*\/transfer/i, 'uzaktan indirme'],
  fsWrite: [/\b(?:writeFileSync|writeFile|createWriteStream|appendFileSync|appendFile|copyFileSync|renameSync)\s*\(/, 'dosya yazma'],
  chmod: [/\bchmodSync?\s*\(|chmod\s+\+?[0-7x]+/, 'çalıştırılabilir izin (chmod)'],
  credFiles: [CRED_FILES, 'kimlik dosyası yolu (.npmrc/.ssh/.aws/.git-credentials…)'],
  discord: [/discord(?:canary|ptb)?['"\\/\s,]+Local Storage|Local Storage[\\/]+leveldb|discord(?:app)?\.com\/api\/v\d+\/users\/@me|\[\\w-\]\{2[46]\}\\\.\[\\w-\]\{6\}|mfa\\\.\[\\w-\]\{84\}|dQw4w9WgXcQ/i, 'Discord token konumu/deseni'],
  browserPaths: [/Google[\\/]+Chrome[\\/]+User Data|BraveSoftware|Microsoft[\\/]+Edge[\\/]+User Data|Opera Software|YandexBrowser|Mozilla[\\/]+Firefox[\\/]+Profiles|Chromium[\\/]+User Data/i, 'tarayıcı profil dizini'],
  browserCreds: [/Login Data|Web Data|Local State|os_crypt|encrypted_key|CryptUnprotectData|ProtectedData\.Unprotect|key4\.db|logins\.json|[\\/]Network[\\/]Cookies/, 'kayıtlı şifre/çerez veritabanı'],
  clipboard: [/clipboardy|\bclipboard\.(?:readText|writeText|readSync|writeSync)\b|Get-Clipboard|Set-Clipboard|\bpbpaste\b|\bpbcopy\b|\bxclip\b|\bxsel\b|wl-(?:copy|paste)|['"`]clip(?:\.exe)?['"`]/, 'pano erişimi'],
  walletPattern: [/0x\[a-fA-F0-9\]\{40\}|\[13\]\[a-km-zA-HJ-NP-Z1-9\]\{2[5-9]|bc1\[a-z0-9|bc1q\[|\^4\[0-9AB\]|T\[A-Za-z1-9\]\{33\}|\[1-9A-HJ-NP-Za-km-z\]\{3[2-9]/, 'cüzdan adresi deseni (regex)'],
  walletFiles: [/wallet\.dat|Exodus[\\/]+exodus\.wallet|Electrum[\\/]+wallets|atomic[\\/]+Local Storage|nkbihfbeogaeaoehlefnkodbefgpgknn|bfnaelmomeimhlpmgjnjophhpkkoljpa|ibnejdfjmmkpcnlpebklmnkoeoihofec|Ledger Live|keystore[\\/]+UTC--|solana[\\/]+id\.json/i, 'cüzdan dosyası/eklenti kimliği'],
  sysinfo: [/os\.(?:hostname|userInfo|networkInterfaces|homedir|release|arch)\(\)/g, 'sistem bilgisi'],
};

const PERSISTENCE = [
  [/Start Menu[\\/]+Programs[\\/]+Startup|Microsoft[\\/]+Windows[\\/]+Start Menu[\\/]+Programs[\\/]+Startup/i, 'Windows Başlangıç klasörü'],
  [/\breg(?:\.exe)?['"`\s,]+(?:\[\s*['"`])?add\b|CurrentVersion\\{1,2}Run(?:Once)?\b/i, 'kayıt defteri Run anahtarı (reg add)'],
  [/schtasks(?:\.exe)?['"`\s,]+(?:\[\s*['"`])?\/create/i, 'zamanlanmış görev (schtasks /create)'],
  [/\bcrontab\b|\/etc\/cron/i, 'cron'],
  [/LaunchAgents|LaunchDaemons|launchctl\s+(?:load|bootstrap)/, 'launchd'],
  [/systemctl\s+(?:--user\s+)?enable|\/etc\/systemd\/system|\.config\/systemd\/user/, 'systemd hizmeti'],
  [/['"`/\\]\.(?:bashrc|zshrc|bash_profile|profile)['"`]/, 'kabuk başlangıç dosyası'],
];

const ANTI_ANALYSIS = [
  [/VBOX|VirtualBox|VBoxService|vboxguest/i, 'VirtualBox kontrolü'],
  [/VMware|vmtoolsd/i, 'VMware kontrolü'],
  [/\bQEMU\b|qemu-ga|KVMKVMKVM|Hyper-V|\bXen\b/, 'hipervizör kontrolü'],
  [/wmic\s+(?:computersystem|bios|diskdrive)|Win32_ComputerSystem|SystemManufacturer/i, 'donanım üreticisi sorgusu'],
  [/WDAGUtilityAccount|SbieDll|Sandboxie|cuckoo|joe ?sandbox|any\.run/i, 'bilinen sandbox kullanıcı/modülü'],
  [/cpus\(\)\.length\s*<=?\s*\d|totalmem\(\)\s*(?:\/[^<>]{0,30})?<=?\s*\d/, 'çekirdek/bellek eşiği'],
  [/execArgv[\s\S]{0,40}inspect|inspector\.url\(\)|process\.debugPort/, 'hata ayıklayıcı tespiti'],
  [/uptime\(\)\s*<=?\s*\d/, 'çalışma süresi eşiği'],
];

// popüler paketler (typosquatting karşılaştırması için; düşük güvenli sezgi)
export const POPULAR_PACKAGES = ['lodash', 'react', 'react-dom', 'express', 'axios', 'chalk', 'commander', 'debug', 'request', 'moment',
  'webpack', 'typescript', 'vue', 'jquery', 'underscore', 'async', 'bluebird', 'uuid', 'yargs', 'dotenv', 'colors', 'minimist',
  'mkdirp', 'rimraf', 'glob', 'semver', 'fs-extra', 'body-parser', 'cookie-parser', 'cross-env', 'nodemon', 'eslint', 'prettier',
  'babel-core', 'jest', 'mocha', 'chai', 'sinon', 'mongoose', 'mongodb', 'mysql', 'mysql2', 'pg', 'redis', 'ioredis', 'socket.io',
  'ws', 'node-fetch', 'cheerio', 'puppeteer', 'electron', 'next', 'nuxt', 'angular', 'rxjs', 'tslib', 'core-js', 'classnames',
  'prop-types', 'styled-components', 'graphql', 'apollo-server', 'jsonwebtoken', 'bcrypt', 'bcryptjs', 'passport', 'nodemailer',
  'sharp', 'multer', 'cors', 'helmet', 'morgan', 'winston', 'pino', 'ethers', 'web3', 'discord.js', 'node-ipc', 'ua-parser-js',
  'coa', 'rc', 'event-stream', 'crypto-js', 'faker', 'inquirer', 'ora', 'boxen', 'execa', 'got', 'superagent', 'qs', 'cookie',
  'path-to-regexp', 'serve-static', 'yaml', 'js-yaml', 'xml2js', 'validator', 'date-fns', 'dayjs', 'luxon', 'immer', 'redux',
  'react-redux', 'zustand', 'zod', 'joi', 'ajv', 'esbuild', 'vite', 'rollup', 'parcel', 'babel-loader', 'css-loader',
  'style-loader', 'sass', 'less', 'postcss', 'autoprefixer', 'tailwindcss', 'bootstrap', 'npm', 'yarn', 'pnpm', 'node-sass',
  'electron-builder', 'pkg', 'nexe', 'bytenode', 'shelljs', 'cross-spawn', 'signale', 'nx', 'left-pad', 'is-promise'];

// Damerau-Levenshtein (bitişik yer değiştirme bir işlem)
export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Paket adı popüler bir pakete benziyor mu: tek düzenleme uzaklığı, ayırıcı/ek oyunları */
export function typosquatCandidates(name) {
  if (typeof name !== 'string' || !name) return [];
  const bare = name.replace(/^@[^/]+\//, '').toLowerCase();
  if (POPULAR_PACKAGES.includes(bare) && !name.startsWith('@')) return [];
  const squash = (s) => s.replace(/[-_.]/g, '');
  const out = [];
  for (const p of POPULAR_PACKAGES) {
    if (p === bare) { if (name.startsWith('@')) out.push({ target: p, why: 'kapsamlı ad popüler paketi taklit ediyor' }); continue; }
    if (p.length >= 4 && editDistance(bare, p) === 1) out.push({ target: p, why: 'tek harf farkı' });
    else if (squash(bare) === squash(p)) out.push({ target: p, why: 'ayırıcı farkı (-, _, .)' });
    else if (p.length >= 4 && [`${p}-js`, `${p}js`, `node-${p}`, `${p}-node`, `${p}2`, `${p}-cli`].includes(bare)) out.push({ target: p, why: 'ek/önek ile türetilmiş ad' });
  }
  return out.slice(0, 5);
}

// Bilinen npm zararlı aileleri: yalnızca doğrulanabilir, ailenin yayımlanmış analizlerinde geçen işaretler.
// Tek işaret = düşük güven; iki ve üzeri ayrı işaret = orta; ağ IOC'si eşleşirse yüksek.
const FAMILIES = [
  { name: 'event-stream / flatmap-stream (2018)', markers: [[/flatmap-stream/, 'flatmap-stream modülü'], [/npm_package_description/, 'anahtar olarak npm_package_description'], [/copay-dash|copay/i, 'Copay hedefi']] },
  { name: 'ua-parser-js ele geçirmesi (2021)', markers: [[/159\.148\.186\.228/, 'indirme IP\'si', true], [/jsextension/, 'jsextension yükü'], [/sdd\.dll/, 'sdd.dll']] },
  { name: 'coa / rc ele geçirmesi (2021)', markers: [[/sdd\.dll/, 'sdd.dll'], [/compile\.bat/, 'compile.bat'], [/citationsherbe\.at|pastorcryptograph\.at/, 'C2 alan adı', true]] },
  { name: 'node-ipc peacenotwar (2022)', markers: [[/peacenotwar/i, 'peacenotwar modülü'], [/WITH-LOVE-FROM-AMERICA/, 'bırakılan dosya adı'], [/api\.ipgeolocation\.io/, 'konum sorgusu', true]] },
  { name: 'Shai-Hulud solucanı (2025)', markers: [[/Shai-Hulud/i, 'Shai-Hulud adı'], [/trufflehog/i, 'trufflehog ile gizli tarama'], [/shai-hulud-workflow\.yml/i, 'GitHub Actions iş akışı'], [/webhook\.site\/[0-9a-f-]{36}/, 'webhook.site sızdırma adresi', true]] },
  { name: 's1ngularity / Nx ele geçirmesi (2025)', markers: [[/s1ngularity/i, 's1ngularity deposu'], [/--dangerously-skip-permissions|--yolo|--trust-all-tools/, 'AI CLI izinsiz çalıştırma bayrakları'], [/\/tmp\/inventory\.txt/, 'inventory.txt hedef listesi']] },
];

export function knownFamilies(code) {
  const out = [];
  for (const f of FAMILIES) {
    const hits = f.markers.filter(([re]) => re.test(code));
    if (!hits.length) continue;
    const confidence = hits.some((h) => h[2]) ? 'high' : hits.length >= 2 ? 'medium' : 'low';
    out.push({ name: f.name, confidence, evidence: hits.map((h) => h[1]) });
  }
  return out;
}

const DISCORD_WEBHOOK = /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[\w-]{10,}/gi;
const TELEGRAM = /https?:\/\/api\.telegram\.org\/bot\d{6,12}:[\w-]{30,}[^\s"'`]*/gi;
const TELEGRAM_TOKEN = /\b\d{8,10}:AA[\w-]{33}\b/g;
const DOWNLOAD_HOSTS = /^(?:raw\.githubusercontent\.com|gist\.githubusercontent\.com|github\.com|objects\.githubusercontent\.com|codeload\.github\.com|registry\.npmjs\.org|registry\.yarnpkg\.com|unpkg\.com|cdn\.jsdelivr\.net|pastebin\.com|paste\.ee|hastebin\.com|ghostbin\.\w+|rentry\.co|transfer\.sh|file\.io|cdn\.discordapp\.com|media\.discordapp\.net|bitbucket\.org|gitlab\.com|dropbox\.com|dl\.dropboxusercontent\.com|drive\.google\.com|mega\.nz|anonfiles\.com|ngrok(?:-free)?\.(?:io|app)|[\w-]+\.ngrok(?:-free)?\.(?:io|app)|webhook\.site|pipedream\.net|[\w-]+\.m\.pipedream\.net|requestbin\.\w+|interact\.sh|[\w-]+\.oast\.\w+|burpcollaborator\.net)$/i;

/** Node'a özgü IOC'ler: Discord webhook, Telegram bot, indirme/paste/tünel adresleri */
export function nodeIocs(code, urls = []) {
  const uniq = (a) => [...new Set(a)].slice(0, 100);
  const all = uniq([...urls, ...(code.match(/\b(?:https?|wss?):\/\/[^\s"'`<>\\)]{3,}/gi) ?? [])]);
  const downloads = all.filter((u) => {
    try { return DOWNLOAD_HOSTS.test(new URL(u).hostname); } catch { return false; }
  });
  return {
    discordWebhooks: uniq(code.match(DISCORD_WEBHOOK) ?? []),
    telegram: uniq([...(code.match(TELEGRAM) ?? []), ...(code.match(TELEGRAM_TOKEN) ?? [])]),
    downloads,
    pastes: downloads.filter((u) => /pastebin|paste\.ee|hastebin|ghostbin|rentry/i.test(u)),
  };
}

const fmtFx = (e) => `çalışma: ${e.kind} ${e.target}${e.detail ? ` (${String(e.detail).slice(0, 80)})` : ''}`.slice(0, 240);

/** Paket düzeyi sınıflar (package.json): yaşam döngüsü, typosquatting, bağımlılık karışıklığı */
export function packageThreats(pkg) {
  const out = [];
  if (!pkg) return out;
  const hooks = Object.entries(pkg.lifecycle ?? {}).filter(([k]) => ['preinstall', 'install', 'postinstall', 'prepare'].includes(k));
  if (hooks.length) {
    const risky = hooks.filter(([, c]) => /curl|wget|powershell|Invoke-|https?:\/\/|node\s+-e|\beval\b|base64|\|\s*(?:ba)?sh\b|\bnc\b|bash\s+-c/i.test(c));
    out.push({ id: 'npm-lifecycle', score: risky.length ? 50 : 20, confidence: risky.length ? 'medium' : 'low',
      evidence: hooks.map(([k, c]) => `paket: ${k}: ${c.slice(0, 200)}`) });
  }
  const squat = typosquatCandidates(pkg.name);
  if (squat.length) out.push({ id: 'typosquatting', score: 30, confidence: 'low', evidence: squat.map((s) => `paket: "${pkg.name}" ≈ "${s.target}" (${s.why})`) });
  const major = Number(String(pkg.version ?? '').split('.')[0]);
  if (Number.isFinite(major) && major >= 90) {
    out.push({ id: 'dependency-confusion', score: hooks.length ? 50 : 35, confidence: hooks.length ? 'medium' : 'low',
      evidence: [`paket: olağandışı yüksek sürüm ${pkg.version} (iç paket adını gölgeleme)`, hooks.length && 'paket: kurulum betiği de var'].filter(Boolean) });
  }
  return out;
}

/**
 * @param {object} a
 * @param {string} a.code       çözülmüş çıktı
 * @param {Array}  a.effects    sandbox etki günlüğü ({kind,target,detail})
 * @param {object} a.iocs       analyze IOC'leri (urls, wallets…)
 * @param {object} [a.unpack]   CLI'dan: { kind, meta, file: { path, entry, note } }
 */
export function nodeThreatReport({ code = '', effects = [], iocs = {}, unpack = null }) {
  const fx = groupEffects(effects);
  const S = Object.fromEntries(Object.entries(STATIC).map(([k, [re, label]]) => {
    const hits = re.global ? (code.match(re) ?? []).length : (re.test(code) ? 1 : 0);
    return [k, hits ? { hits, label: `statik: ${label}` } : null];
  }));
  const ev = (...xs) => xs.flat(Infinity).filter(Boolean).map((x) => (typeof x === 'string' ? x : x.label));
  const out = [];
  const add = (id, score, evidence, confidence = 'medium') => { if (evidence.length) out.push({ id, score, confidence, evidence: [...new Set(evidence)].slice(0, 20) }); };
  const n = nodeIocs(code, iocs?.urls ?? []);
  const fxNet = [...(fx.http ?? []), ...(fx.netConnect ?? []), ...(fx.dns ?? [])];
  const net = S.network || fxNet.length || n.discordWebhooks.length || n.telegram.length;
  const netEv = [S.network, fxNet.slice(0, 3).map(fmtFx), n.discordWebhooks.length && 'statik: Discord webhook adresi', n.telegram.length && 'statik: Telegram bot adresi'];
  const runtimeBoost = (c) => (c === 'medium' ? 'high' : c);

  // ortam değişkeni / token sızdırma
  const envFx = fx.envRead ?? [];
  const env = S.envAll || S.envSecrets || envFx.length >= 5;
  if (env && net) add('env-exfil', 60, ev(S.envAll, S.envSecrets, envFx.length && `çalışma: ${envFx.length} ortam değişkeni okundu (${envFx.slice(0, 5).map((e) => e.target).join(', ')})`, netEv), envFx.length && fxNet.length ? 'high' : 'medium');

  // kimlik dosyaları
  const credFx = [...(fx.fsRead ?? []), ...(fx.fsWrite ?? [])].filter((e) => CRED_FILES.test(`${e.target} ${e.detail}`));
  if (S.credFiles || credFx.length) {
    const names = [...new Set((code.match(new RegExp(CRED_FILES.source, 'gi')) ?? []).map((x) => x.toLowerCase()))].slice(0, 8);
    add('credential-files', net ? 65 : 45, ev(S.credFiles && `statik: kimlik dosyaları ${names.join(', ')}`, credFx.slice(0, 5).map(fmtFx), net && netEv), credFx.length ? 'high' : 'medium');
  }

  // Discord / tarayıcı token ve şifre çalma
  if (S.discord && (net || S.credFiles)) add('discord-token-stealer', 70, ev(S.discord, netEv));
  if (S.browserPaths && S.browserCreds) add('browser-stealer', 70, ev(S.browserPaths, S.browserCreds, net && netEv));

  // kripto cüzdan / clipper
  const clipFx = fx.clipboard ?? [];
  if ((S.clipboard || clipFx.length) && (S.walletPattern || (iocs?.wallets ?? []).length)) {
    add('crypto-clipper', 65, ev(S.clipboard, clipFx.slice(0, 3).map(fmtFx), S.walletPattern, (iocs?.wallets ?? []).length && `statik: ${(iocs.wallets).length} cüzdan adresi`), clipFx.length ? 'high' : 'medium');
  }
  if (S.walletFiles) add('wallet-stealer', 60, ev(S.walletFiles, net && netEv));

  // ters kabuk: ham soket + kabuk süreci + akış bağlantısı
  const execFx = fx.exec ?? [];
  const shellFx = execFx.filter((e) => SHELL.test(` ${e.target} `) || SHELL.test(` ${e.detail} `));
  const sockFx = fx.netConnect ?? [];
  if ((S.netSocket || sockFx.length) && (S.shell || shellFx.length) && (S.pipeShell || (sockFx.length && shellFx.length))) {
    add('reverse-shell', 85, ev(S.netSocket, S.shell, S.pipeShell, sockFx.slice(0, 2).map(fmtFx), shellFx.slice(0, 2).map(fmtFx)), sockFx.length && shellFx.length ? 'high' : 'medium');
  }

  // indirici / çalıştırıcı: indirme → dosya yazma → çalıştırma (çalışma anında sıra da denetlenir)
  const firstSeq = (a) => (a?.length ? Math.min(...a.map((e) => e.seq ?? 0)) : null);
  const httpSeq = firstSeq(fx.http);
  const writeAfter = (fx.fsWrite ?? []).filter((e) => httpSeq !== null && (e.seq ?? 0) >= httpSeq);
  const execAfter = execFx.filter((e) => writeAfter.length && (e.seq ?? 0) >= Math.min(...writeAfter.map((w) => w.seq ?? 0)));
  const runtimeDropper = writeAfter.length && execAfter.length;
  if ((S.download && S.fsWrite && (S.childProcess || S.chmod)) || runtimeDropper) {
    add('dropper', 70, ev(S.download, S.fsWrite, S.childProcess, S.chmod, runtimeDropper && [fmtFx(fx.http[0]), fmtFx(writeAfter[0]), fmtFx(execAfter[0])], n.downloads.slice(0, 3).map((u) => `statik: indirme adresi ${u}`)), runtimeDropper ? 'high' : 'medium');
  }

  // kalıcılık
  const persist = PERSISTENCE.filter(([re]) => re.test(code)).map(([, l]) => `statik: ${l}`);
  const persistFx = [...execFx, ...(fx.fsWrite ?? [])].filter((e) => PERSISTENCE.some(([re]) => re.test(`${e.target} ${e.detail}`)));
  if (persist.length || persistFx.length) add('persistence', 50, [...persist, ...persistFx.slice(0, 3).map(fmtFx)], persistFx.length ? 'high' : 'medium');

  // anti-analiz: en az iki ayrı işaret
  const anti = ANTI_ANALYSIS.filter(([re]) => re.test(code)).map(([, l]) => `statik: ${l}`);
  if (anti.length >= 2) add('anti-analysis', 25, anti, 'low');

  // keşif: çok sayıda sistem bilgisi + ağ
  if (S.sysinfo?.hits >= 3 && net) add('host-recon', 15, ev(`statik: ${S.sysinfo.hits} sistem bilgisi okuması`, netEv), 'low');

  // komut çalıştırma (genel)
  if (S.childProcess || execFx.length) add('node-exec', 15, ev(S.childProcess, execFx.slice(0, 5).map(fmtFx)), execFx.length ? 'high' : 'medium');

  // Discord/Telegram ile dışarı gönderim (veri çalma kanalları)
  if (n.discordWebhooks.length || n.telegram.length) add('chat-exfil', 30, ev(n.discordWebhooks.length && `statik: Discord webhook ${n.discordWebhooks[0]}`, n.telegram.length && 'statik: Telegram bot API'));

  // paket düzeyi: package.json ve bu dosyanın yaşam döngüsünde çalışıp çalışmadığı
  const pkg = unpack?.meta?.package ?? null;
  const pkgClasses = packageThreats(pkg);
  const path = unpack?.file?.path;
  const hooks = Object.entries(unpack?.meta?.lifecycleTargets ?? {}).filter(([k, t]) => ['preinstall', 'install', 'postinstall', 'prepare'].includes(k) && t.includes(path)).map(([k]) => k);
  const life = pkgClasses.find((c) => c.id === 'npm-lifecycle');
  if (life && hooks.length) {
    const dangerous = out.filter((c) => c.score >= 50 || ['node-exec', 'chat-exfil'].includes(c.id));
    life.evidence.unshift(`paket: bu dosya kurulumda çalışır (${hooks.join(', ')})`);
    if (dangerous.length || net) {
      life.score = 60;
      life.confidence = 'high';
      life.evidence.push(`kurulumda çalışan dosyada: ${[...dangerous.map((c) => c.id), net && 'ağ erişimi'].filter(Boolean).join(', ')}`);
    }
  }
  // paket sınıfları her dosyada risk şişirmesin: yalnızca kurulumda çalışan, main/bin dosyasında ya da dosya bağlamı yokken
  if (!path || hooks.length || /main|bin:/.test(unpack?.file?.note ?? '')) out.push(...pkgClasses);

  for (const c of out) if (c.evidence.some((e) => e.startsWith('çalışma:'))) c.confidence = runtimeBoost(c.confidence);
  const families = knownFamilies(code);
  if (families.some((f) => f.confidence !== 'low')) {
    out.push({ id: 'known-family', score: 40, confidence: families.some((f) => f.confidence === 'high') ? 'high' : 'medium',
      evidence: families.filter((f) => f.confidence !== 'low').map((f) => `aile: ${f.name} — ${f.evidence.join(', ')}`) });
  }
  return {
    classes: out.sort((a, b) => b.score - a.score),
    families,
    iocs: n,
    effects: Object.fromEntries(Object.entries(fx).map(([k, v]) => [k, v.length])),
    package: pkg ? { name: pkg.name, version: pkg.version, lifecycle: pkg.lifecycle, typosquat: typosquatCandidates(pkg.name) } : null,
    file: path ? { path, lifecycleHooks: hooks } : null,
  };
}
