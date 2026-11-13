// E98 / E103 / E107: sandbox'ta işaretli (canary) verilerle iki çalıştırma.
//  - Exfiltration haritası: çerez, depolama, user-agent gibi kaynaklara konan işaretlerin hangi ağ
//    çağrısında (düz, base64, URL kodlu, hex, ters) dışarı çıktığı → kaynak → hedef tablosu.
//  - Anti-bot raporu: aynı program gerçek tarayıcı ve headless bot profiliyle çalıştırılır; ağ, çıktı ve
//    hata farkları + statik bot tespiti API'leri ve bilinen bot koruma sağlayıcıları.
//  - Phishing kit uç noktaları: kimlik alanlarıyla birlikte veri gönderilen hedeflerin sınıflandırması.
import { PROFILES, POST_SCRIPT } from '../core/threat.js';

const CANARY = {
  cookie: 'PEELCKIE7Q2',
  storage: 'PEELSTOR4K9',
  userAgent: 'PEELUAGT3X8',
};

const b64 = (s) => (typeof btoa === 'function' ? btoa(s) : Buffer.from(s).toString('base64'));
const hex = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');

// İşaretin kodlanmış biçimleri: düz, base64 (kayık hizalamalar dahil), hex, ters, rot13
function variants(token) {
  const out = [['düz', token], ['hex', hex(token)], ['ters', [...token].reverse().join('')],
    ['rot13', token.replace(/[a-z]/gi, (c) => String.fromCharCode((c <= 'Z' ? 65 : 97) + ((c.charCodeAt(0) - (c <= 'Z' ? 65 : 97) + 13) % 26)))]];
  // base64 içinde işaret herhangi bir hizalamada olabilir: 3 kaydırmanın ortak çekirdeği aranır
  for (let shift = 0; shift < 3; shift++) {
    // yalnızca tamamen işaret baytlarından oluşan 3 baytlık grupların karakterleri
    const enc = b64('x'.repeat(shift) + token).slice(shift ? 4 : 0, Math.floor((shift + token.length) / 3) * 4);
    if (enc.length >= 8) out.push([`base64`, enc]);
  }
  return out;
}

function findCanaries(text) {
  const hits = [];
  const hay = String(text ?? '');
  let decoded = hay;
  try { decoded = decodeURIComponent(hay.replace(/\+/g, ' ')); } catch { /* bozuk kaçış */ }
  for (const [source, token] of Object.entries(CANARY)) {
    for (const [encoding, v] of variants(token)) {
      if (hay.includes(v) || decoded.includes(v)) { hits.push({ source, encoding }); break; }
    }
  }
  return hits;
}

const config = (profile) => ({
  cookie: `session=${CANARY.cookie}; theme=dark`,
  storage: { token: CANARY.storage, user: 'demo' },
  profile: { ...profile, navigator: { ...profile.navigator, userAgent: `${profile.navigator.userAgent} ${CANARY.userAgent}` } },
});

async function runWith(sandbox, text, profileName) {
  const r = await sandbox.run(`try {\n${text}\n} catch (e) { __res.push({ __thrown: String(e) }); }`,
    { timeoutMs: 5000, post: POST_SCRIPT, config: config(PROFILES[profileName]) });
  return {
    ok: r.ok,
    error: r.error ?? null,
    network: r.net ?? [],
    console: r.out ?? [],
    thrown: (r.res ?? []).filter((x) => x && x.__thrown).map((x) => x.__thrown),
    reads: Object.keys(r.reads ?? {}),
  };
}

// E98: kaynak → hedef
export function exfilMap(network) {
  const rows = [];
  for (const n of network) {
    const hits = [...findCanaries(n.url), ...findCanaries(n.body)];
    const seen = new Set();
    for (const h of hits) {
      const k = `${h.source}|${h.encoding}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ source: h.source, encoding: h.encoding, api: n.api, method: n.method || (n.api === 'image' ? 'GET' : ''), url: n.url, where: findCanaries(n.body).some((x) => x.source === h.source) ? 'gövde' : 'URL' });
    }
  }
  return rows;
}

// --- E103: bot tespiti ---
const BOT_APIS = [
  [/navigator\.webdriver|\bwebdriver\b/, 'navigator.webdriver'],
  [/callPhantom|_phantom|phantomjs/i, 'PhantomJS izleri'],
  [/__nightmare/, 'Nightmare izi'],
  [/domAutomation(Controller)?/, 'domAutomation (ChromeDriver)'],
  [/\$cdc_|cdc_adoQpoasnfa76pfcZLmcfl/, 'ChromeDriver $cdc_ değişkeni'],
  [/__selenium_(unwrapped|evaluate)|__webdriver_(evaluate|script_fn)|__fxdriver/, 'Selenium/WebDriver izleri'],
  [/HeadlessChrome/, 'HeadlessChrome UA denetimi'],
  [/navigator\.plugins\.length|plugins\.length\s*===?\s*0/, 'eklenti sayısı denetimi'],
  [/navigator\.languages(\.length|\s*===?\s*["']{2})/, 'dil listesi denetimi'],
  [/window\.chrome(\.runtime)?\b|\bchrome\.runtime\b/, 'window.chrome varlığı'],
  [/permissions\.query\(\s*\{\s*name\s*:\s*["']notifications/, 'izin tutarsızlığı (notifications)'],
  [/outerWidth\s*===?\s*0|outerHeight\s*===?\s*0/, 'pencere boyutu sıfır denetimi'],
  [/getParameter\(\s*(37445|37446|0x9245|0x9246)\)|UNMASKED_(VENDOR|RENDERER)_WEBGL/, 'WebGL sağlayıcı/renderer'],
  [/hardwareConcurrency|deviceMemory/, 'donanım parmak izi'],
  [/\.toString\(\)\.indexOf\(["']\[native code\]/, 'native code (hook) denetimi'],
  [/Notification\.permission/, 'bildirim izni denetimi'],
];
const VENDORS = [
  [/_px\d?|px-captcha|perimeterx|PXAppId/i, 'PerimeterX (HUMAN)'],
  [/\bbmak\b|_abck|ak_bmsc|akam\//, 'Akamai Bot Manager'],
  [/datadome|dd_cookie_test/i, 'DataDome'],
  [/cf_chl|__cf_bm|turnstile|challenges\.cloudflare\.com/i, 'Cloudflare (Bot Management / Turnstile)'],
  [/grecaptcha|recaptcha\/api/i, 'Google reCAPTCHA'],
  [/hcaptcha/i, 'hCaptcha'],
  [/KPSDK|x-kpsdk/i, 'Kasada'],
  [/incap_ses|___utmvc|reese84/i, 'Imperva (Incapsula)'],
  [/tmx_profiling|ThreatMetrix|online-metrix\.net/i, 'ThreatMetrix'],
  [/arkoselabs|funcaptcha|fc-token/i, 'Arkose Labs'],
  [/FingerprintJS|fpjs\.io|getVisitorId/, 'FingerprintJS'],
  [/__sift|cdn\.sift\.com|_sift\b/, 'Sift'],
  [/ftr__|forter/i, 'Forter'],
  [/riskified/i, 'Riskified'],
  [/__xr_bmobdb|shapesecurity|F5_cspm/i, 'F5 Shape'],
];

export function botSignals(code) {
  return {
    apis: BOT_APIS.filter(([re]) => re.test(code)).map(([, label]) => label),
    vendors: VENDORS.filter(([re]) => re.test(code)).map(([, label]) => label),
  };
}

function diffRuns(human, bot) {
  const key = (n) => `${n.api} ${n.method} ${n.url}`;
  const hk = new Set(human.network.map(key));
  const bk = new Set(bot.network.map(key));
  return {
    onlyHuman: human.network.filter((n) => !bk.has(key(n))).map(key),
    onlyBot: bot.network.filter((n) => !hk.has(key(n))).map(key),
    consoleDiffers: human.console.join('\n') !== bot.console.join('\n'),
    thrownDiffers: human.thrown.join('\n') !== bot.thrown.join('\n') || human.error !== bot.error,
    humanOutput: human.console.slice(0, 20),
    botOutput: bot.console.slice(0, 20),
  };
}

// --- E107: phishing kit uç noktaları ---
const ENDPOINT_KINDS = [
  [/api\.telegram\.org\/bot[\w:-]+\/(sendMessage|sendDocument)/i, 'Telegram bot API'],
  [/discord(app)?\.com\/api\/webhooks\//i, 'Discord webhook'],
  [/hooks\.slack\.com\/services\//i, 'Slack webhook'],
  [/script\.google\.com\/macros\//i, 'Google Apps Script'],
  [/formspree\.io|getform\.io|formsubmit\.co|api\.emailjs\.com|submit-form\.com|basin\.com/i, 'form toplama hizmeti'],
  [/firebaseio\.com|firestore\.googleapis\.com/i, 'Firebase'],
  [/ngrok(-free)?\.(io|app|dev)|trycloudflare\.com|loca\.lt|serveo\.net/i, 'tünel hizmeti'],
  [/pastebin\.com|paste\.ee|hastebin/i, 'paste sitesi'],
  [/\.(php|asp|aspx|jsp|cgi)(\?|$)/i, 'sunucu betiği (gate)'],
  [/^https?:\/\/\d{1,3}(\.\d{1,3}){3}/, 'çıplak IP adresi'],
  [/^mailto:/i, 'e-posta'],
];
const CRED_KEYS = /(pass(word|wd)?|pwd|user(name)?|login|e-?mail|otp|pin|card|cvv|cvc|ssn|token)/i;

export function phishingEndpoints({ code, network = [], urls = [] }) {
  const out = new Map();
  const credFieldsInCode = CRED_KEYS.test(code) && /\.value\b/.test(code);
  const consider = (url, via, body = '') => {
    if (!url) return;
    const kinds = ENDPOINT_KINDS.filter(([re]) => re.test(url)).map(([, label]) => label);
    const credsInBody = CRED_KEYS.test(body);
    if (!kinds.length && !credsInBody) return;
    const prev = out.get(url) ?? { url, kinds: new Set(), via: new Set(), credentials: false };
    kinds.forEach((k) => prev.kinds.add(k));
    prev.via.add(via);
    prev.credentials ||= credsInBody;
    out.set(url, prev);
  };
  for (const n of network) consider(n.url, `${n.api}${n.method ? ` ${n.method}` : ''}`, n.body);
  for (const u of urls) consider(u, 'statik');
  // form action="..." hedefleri
  for (const m of code.matchAll(/\.action\s*=\s*["']([^"']+)["']|action=\\?["']([^"'\\]+)/g)) consider(m[1] ?? m[2], 'form action');
  return [...out.values()].map((e) => ({
    url: e.url,
    kinds: [...e.kinds],
    via: [...e.via],
    credentials: e.credentials || (credFieldsInCode && e.kinds.length > 0),
    verdict: e.credentials ? 'kimlik bilgisi gönderiliyor' : credFieldsInCode && e.kinds.length ? 'kimlik alanları okunuyor, hedef şüpheli' : 'şüpheli hedef',
  }));
}

/** Analiz girişi: sandbox varsa iki çalıştırma yapar, yoksa yalnızca statik sinyaller */
export async function securityRuntime({ sandbox, text, code, urls = [] }) {
  const signals = botSignals(code);
  if (!sandbox) {
    return { exfil: [], antibot: { ...signals, diff: null, profiles: null }, phishing: phishingEndpoints({ code, urls }) };
  }
  const human = await runWith(sandbox, text, 'chrome-win');
  const bot = await runWith(sandbox, text, 'headless-bot');
  const exfil = exfilMap([...human.network, ...bot.network]).filter((r, i, a) => a.findIndex((x) => x.source === r.source && x.url === r.url && x.encoding === r.encoding) === i);
  const diff = diffRuns(human, bot);
  const detectsBot = diff.onlyHuman.length > 0 || diff.onlyBot.length > 0 || diff.consoleDiffers || diff.thrownDiffers;
  return {
    exfil,
    antibot: { ...signals, diff, detectsBot, profiles: ['chrome-win', 'headless-bot'] },
    phishing: phishingEndpoints({ code, network: [...human.network, ...bot.network], urls }),
  };
}

export const __test = { CANARY, findCanaries, variants };
