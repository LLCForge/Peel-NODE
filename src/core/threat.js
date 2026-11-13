// Tehdit analizi: çalışma anı kayıtları + statik bulgulardan sınıflandırma, risk skoru,
// YARA / Suricata kuralları, gizlilik özeti, bilinen kütüphaneler ve paylaşım öncesi maskeleme.
// Hepsi sezgisel: kanıtlarıyla birlikte raporlanır, kesin hüküm değildir.

// Program bittikten sonra sandbox'ta çalışır: setInterval geri çağrıları ve kayıtlı olay işleyicileri
// sentetik olaylarla bir kez tetiklenir, programın eklediği global'ler listelenir.
export const POST_SCRIPT = `(function () {
  var fired = 0;
  __peelTimers.slice(0, 50).forEach(function (f) { try { f(); fired++; } catch (e) {} });
  function ev(type, target) {
    return { type: type, target: target, currentTarget: target, key: "a", code: "KeyA", keyCode: 65, which: 65,
      clientX: 10, clientY: 10, isTrusted: true, preventDefault: function () {}, stopPropagation: function () {} };
  }
  __peelHandlers.slice(0, 200).forEach(function (h) { try { h.fn.call(h.target, ev(h.type, h.target)); fired++; } catch (e) {} });
  var base = {};
  __peelBaseGlobals.forEach(function (k) { base[k] = true; });
  var globals = Object.getOwnPropertyNames(globalThis).filter(function (k) {
    return !base[k] && k.indexOf("__peel") !== 0;
  }).slice(0, 200).map(function (k) {
    var v; try { v = globalThis[k]; } catch (e) {}
    return { name: k, type: v === null ? "null" : Array.isArray(v) ? "array" : typeof v };
  });
  __res.push({ __post: true, fired: fired, handlers: __peelHandlers.map(function (h) { return h.type; }), timers: __peelTimers.length, globals: globals });
})();`;

// Tarayıcı profilleri (C46/C47): bot ve gerçek kullanıcı ortamında davranış karşılaştırması için
export const PROFILES = {
  'chrome-win': { navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', platform: 'Win32', vendor: 'Google Inc.', webdriver: false, language: 'en-US', hardwareConcurrency: 8, deviceMemory: 8 }, screen: { width: 1920, height: 1080 } },
  'firefox-linux': { navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0', platform: 'Linux x86_64', vendor: '', webdriver: false, language: 'en-US', hardwareConcurrency: 4 }, screen: { width: 1366, height: 768 } },
  'safari-iphone': { navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1', platform: 'iPhone', vendor: 'Apple Computer, Inc.', webdriver: false, language: 'tr-TR', maxTouchPoints: 5 }, screen: { width: 390, height: 844 } },
  'headless-bot': { navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/124.0 Safari/537.36', platform: 'Linux x86_64', vendor: 'Google Inc.', webdriver: true, language: '', languages: [], plugins: [], hardwareConcurrency: 2 }, screen: { width: 800, height: 600 } },
};

// D74/D75: bilinen kütüphane imzaları; sürüm deseni varsa ilk yakalama grubu sürümdür
const LIBRARIES = [
  { name: 'jQuery', sig: /jQuery|\$\.fn\.jquery/, version: /jQuery v?(\d+\.\d+\.\d+)|jquery:\s*["'](\d+\.\d+\.\d+)/ },
  { name: 'lodash', sig: /lodash|__lodash_hash_undefined__/, version: /lodash[^\d]{0,20}(\d+\.\d+\.\d+)|VERSION\s*=\s*["'](4\.\d+\.\d+)/ },
  { name: 'CryptoJS', sig: /CryptoJS|crypto-js/, version: /crypto-js[^\d]{0,10}(\d+\.\d+\.\d+)/ },
  { name: 'LZString', sig: /LZString|compressToBase64|decompressFromUTF16/, version: null },
  { name: 'pako', sig: /pako|inflateRaw|deflateRaw/, version: /pako[^\d]{0,10}(\d+\.\d+\.\d+)/ },
  { name: 'FingerprintJS', sig: /FingerprintJS|fpjs|getVisitorId/, version: /FingerprintJS[^\d]{0,10}(\d+\.\d+\.\d+)/ },
  { name: 'Google Analytics', sig: /google-analytics\.com|gtag\(|googletagmanager/, version: null },
  { name: 'Facebook Pixel', sig: /connect\.facebook\.net|fbq\(/, version: null },
  { name: 'CoinHive / CryptoLoot', sig: /coinhive|CoinHive|cryptoloot|CryptoLoot|webmine|deepMiner/i, version: null },
  { name: 'React', sig: /react\.production|__REACT_DEVTOOLS|createElement\(["']div/, version: /react[^\d]{0,12}(\d+\.\d+\.\d+)/i },
  { name: 'axios', sig: /axios/, version: /axios[^\d]{0,10}(\d+\.\d+\.\d+)/ },
  { name: 'forge', sig: /node-forge|forge\.cipher/, version: null },
  { name: 'JSEncrypt', sig: /JSEncrypt/, version: /JSEncrypt v?(\d+\.\d+\.\d+)/ },
];

export function libraries(code) {
  const out = [];
  for (const lib of LIBRARIES) {
    if (!lib.sig.test(code)) continue;
    const m = lib.version ? code.match(lib.version) : null;
    out.push({ name: lib.name, version: m ? (m[1] ?? m[2] ?? null) : null });
  }
  return out;
}

const has = (code, re) => re.test(code);

// E96/E97/E107/E108: davranış sınıfları ve kanıtları
export function classify({ code, runtime, iocs, apis }) {
  const net = runtime?.network ?? [];
  const handlers = runtime?.post?.handlers ?? [];
  const apiNames = new Set((apis ?? []).map((a) => a.name));
  const posts = net.filter((n) => /post/i.test(n.method) || n.api === 'beacon' || n.api === 'image' || n.api === 'websocket.send');
  const exfil = posts.length > 0 || net.some((n) => n.api === 'image' && /[?&][^=]+=/.test(n.url));
  const out = [];
  const add = (id, score, evidence) => { if (evidence.length) out.push({ id, score, evidence }); };

  // ödeme formu skimmer'ı / Magecart: kart alanları + form değerleri + dışarı gönderim
  const cardFields = has(code, /cc[_-]?num|card[_-]?number|cardnumber|cvv|cvc|expir|billing|checkout|payment/i);
  const formRead = has(code, /\.value\b/) && has(code, /querySelector|getElementsBy|getElementById|forms\[/);
  // yalnızca dışarı gönderim skimmer kanıtı değildir: kart alanı ya da form okuma şart
  if (cardFields || formRead) add('skimmer', 40, [cardFields && 'kart/ödeme alan adları', formRead && 'form alanı değerleri okunuyor',
    exfil && 'veri dışarı gönderiliyor', has(code, /onepage|onestepcheckout|\/checkout/i) && 'ödeme sayfası yolu'].filter(Boolean));
  if (cardFields && exfil) out.push({ id: 'magecart', score: 70, evidence: ['ödeme alanları ve dışarı gönderim birlikte'] });

  // kripto madenci
  add('miner', 60, [has(code, /stratum\+tcp|cryptonight|coinhive|cryptoloot|minero|webmine|hashrate|xmrig/i) && 'madenci imzası',
    has(code, /WebAssembly\.(instantiate|compile)/) && 'WebAssembly',
    (apiNames.has('Worker') || has(code, /new Worker\(/)) && 'Worker', has(code, /hardwareConcurrency/) && 'çekirdek sayısı okunuyor'].filter((x, i, a) => x && (i === 0 || a[0])));

  // keylogger: tuş olayları + gönderim
  const keyEvents = handlers.some((h) => /key/.test(h)) || has(code, /["'](keydown|keypress|keyup)["']|onkey(down|press|up)/);
  add('keylogger', 50, keyEvents && exfil ? ['tuş olayı dinleniyor', 'veri dışarı gönderiliyor'] : []);

  // phishing / kimlik bilgisi toplama
  const creds = has(code, /password|passwd|login|username|e-?mail/i) && formRead;
  add('credential-harvest', 50, creds && exfil ? ['kimlik bilgisi alanları okunuyor', 'veri dışarı gönderiliyor'] : []);

  // yönlendirme zinciri
  const redirects = net.filter((n) => n.api === 'navigate' || n.api === 'window.open');
  add('redirect', 20, redirects.map((r) => `${r.api} → ${r.url}`));

  // anti-bot / fingerprint
  const fpReads = (runtime?.reads ?? []).filter((r) => /navigator\.(plugins|webdriver|hardwareConcurrency|deviceMemory|languages)|screen\.|canvas\.toDataURL/.test(r.key));
  add('fingerprint', 15, fpReads.length >= 3 ? [`${fpReads.length} parmak izi okuması`] : []);

  // gizli kod yürütme
  add('dynamic-code', 15, [apiNames.has('eval') && 'eval', apiNames.has('Function') && 'Function'].filter(Boolean));
  add('wallet', 30, (iocs?.wallets ?? []).length ? ['kripto cüzdan adresi'] : []);
  return out.sort((a, b) => b.score - a.score);
}

// E109: 0–100 risk skoru (sınıfların ağırlıklı toplamı, üstte sınırlı)
export function riskScore(classes, runtime) {
  let s = classes.reduce((a, c) => a + c.score, 0);
  s += Math.min(20, (runtime?.network ?? []).length * 2);
  const score = Math.min(100, s);
  return { score, level: score >= 70 ? 'high' : score >= 35 ? 'medium' : score > 0 ? 'low' : 'none' };
}

// E104: gizlilik özeti — üçüncü taraf alan adları, çerez/depolama, parmak izi
export function privacy({ runtime, iocs, apis, origin = 'example.com' }) {
  const third = new Set();
  for (const n of runtime?.network ?? []) {
    try {
      const h = new URL(n.url, `https://${origin}/`).hostname;
      if (h && h !== origin) third.add(h);
    } catch { /* geçersiz URL */ }
  }
  const names = new Set((apis ?? []).map((a) => a.name));
  return {
    thirdParties: [...third],
    cookies: names.has('document.cookie'),
    storage: names.has('localStorage') || names.has('sessionStorage'),
    fingerprinting: (runtime?.reads ?? []).filter((r) => /navigator\.(?!sendBeacon)|screen\.|canvas/.test(r.key)).map((r) => r.key),
    contacts: (iocs?.emails ?? []).length,
  };
}

const escYara = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[^\x20-\x7e]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

// E101: çözülmüş çıktıdaki ayırt edici string'lerden YARA kuralı (çözülmüş örneği ya da bellekteki kodu yakalar)
export function yaraRule({ name = 'peel_sample', strings, iocs, hash }) {
  const picked = [...new Set([...(iocs?.urls ?? []), ...(iocs?.domains ?? []), ...strings.filter((s) => s.length >= 8 && s.length <= 120)])]
    .filter((s) => /^[\x20-\x7e]+$/.test(s)).slice(0, 12);
  if (!picked.length) return null;
  const id = name.replace(/[^A-Za-z0-9_]/g, '_');
  return [
    `rule ${id}`,
    '{',
    '  meta:',
    '    author = "PEEL"',
    `    description = "PEEL tarafından çözülmüş örnekten üretildi"`,
    hash ? `    peel_output_hash = "${hash}"` : null,
    '  strings:',
    ...picked.map((s, i) => `    $s${i} = "${escYara(s)}" ascii wide`),
    '  condition:',
    `    ${Math.min(picked.length, Math.max(2, Math.ceil(picked.length / 2)))} of them`,
    '}',
  ].filter((x) => x !== null).join('\n');
}

// E102: Suricata/Snort tarzı ağ imzaları (alan adı ve URL yolu)
export function idsRules({ runtime, iocs, sidBase = 9100000 }) {
  const hosts = new Set(iocs?.domains ?? []);
  const paths = new Set();
  for (const n of runtime?.network ?? []) {
    try {
      const u = new URL(n.url);
      hosts.add(u.hostname);
      if (u.pathname.length > 1) paths.add(u.pathname);
    } catch { /* göreli URL */ }
  }
  let sid = sidBase;
  const rules = [];
  for (const h of [...hosts].slice(0, 30)) {
    rules.push(`alert dns any any -> any any (msg:"PEEL IOC alan adı ${h}"; dns.query; content:"${h}"; nocase; sid:${sid++}; rev:1;)`);
    rules.push(`alert tls any any -> any any (msg:"PEEL IOC SNI ${h}"; tls.sni; content:"${h}"; nocase; sid:${sid++}; rev:1;)`);
  }
  for (const p of [...paths].slice(0, 30)) {
    rules.push(`alert http any any -> any any (msg:"PEEL IOC yol ${p}"; http.uri; content:"${p.replace(/"/g, '')}"; sid:${sid++}; rev:1;)`);
  }
  return rules.join('\n');
}

// E115: paylaşmadan önce anahtar maskeleme — JWT, uzun anahtarlar, e-posta, cüzdan
const SECRET_PATTERNS = [
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, 'JWT'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, 'STRIPE_KEY'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS_KEY'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'GOOGLE_KEY'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, 'GITHUB_TOKEN'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, 'SLACK_TOKEN'],
  [/\b[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+\b/g, 'EMAIL'],
  [/(["'`])([A-Za-z0-9+/=_-]{40,})\1/g, 'SECRET'],
];

export function maskSecrets(code) {
  let count = 0;
  let out = code;
  for (const [re, label] of SECRET_PATTERNS) {
    out = out.replace(re, (m, q, inner) => {
      count++;
      if (label === 'SECRET') return `${q}«${label}:${inner.length}»${q}`;
      return `«${label}»`;
    });
  }
  return { code: out, count };
}

// C51: tanımsız global referansları (sandbox'ta eksik API) hata mesajlarından
export function missingGlobals(runtime) {
  const msgs = [runtime?.error, ...(runtime?.console ?? []), ...(runtime?.thrown ?? [])].filter(Boolean).map(String);
  const names = new Set();
  for (const m of msgs) for (const x of m.matchAll(/'?([A-Za-z_$][\w$]*)'? is not defined/g)) names.add(x[1]);
  return [...names];
}
