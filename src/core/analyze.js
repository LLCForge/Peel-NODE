import * as t from '@babel/types';
import { parse } from './parse.js';
import { traverse } from '../util/ast.js';
import { fnv1a } from '../util/hash.js';
import { encodingReport } from './encodings.js';
import { runtimeExtras } from '../verify/run.js';
import { analysisReport } from '../analysis/report.js';
import { POST_SCRIPT, classify, riskScore, privacy, yaraRule, idsRules, libraries, missingGlobals } from './threat.js';
import { symbolicReport } from '../symbolic/report.js';
import { detectTools, autoProfile, detectVersions, decoderChains, passConfidence } from './detect.js';
import { cryptoScan } from './cryptoscan.js';
import { blobReport } from './stats.js';
import { securityRuntime } from '../security/runtime.js';
import { vmReport } from './vm/report.js';
import { analyzeStringTables, crossCheck, serializeTables } from './vm/strtable.js';
import { namingReport } from '../naming/index.js';
import { engineReport } from './engine-report.js';

// Çözülmüş kod hakkında rapor: obfuscator tespiti, IOC'ler, şüpheli API'ler, ağ çağrıları,
// fingerprint okumaları ve kalite metrikleri. Statik kısım AST'den, dinamik kısım sandbox'tan gelir.

const FAMILIES = [
  {
    name: 'obfuscator.io',
    tests: [
      [/\b_0x[0-9a-f]{4,6}\b/g, 'çok sayıda _0x tanımlayıcısı', 20],
      [/\.push\(\s*_0x[0-9a-f]+\.shift\(\)\s*\)/, 'string dizisi rotasyonu'],
      [/parseInt\(_0x[0-9a-f]+\(0x[0-9a-f]+\)\)\s*\//, 'rotasyon checksum döngüsü'],
      [/while\s*\(\s*!!\[\]\s*\)/, 'while(!![]) dispatcher'],
      [/['"]\d+(\|\d+)+['"]\.split\(['"]\|['"]\)/, '"2|0|1".split akış düzleştirme'],
    ],
  },
  {
    name: 'js-confuser',
    tests: [
      [/function\s*\w*\(\.\.\.(\w+)\)\s*\{\s*\1\.length\s*=\s*(0x)?[0-9a-f]+/g, 'rest parametre + length hilesi', 3],
      [/Object\.defineProperty\(\w+,\s*["'](\\x6c\\x65\\x6e\\x67\\x74\\x68|length)["']/, 'fonksiyon length sahteciliği'],
      [/with\s*\(\s*\w+\.\w+\s*\|\|\s*\w+\s*\)/, 'with tabanlı durum makinesi'],
      [/get\s*["']\w+["']\s*\(\)\s*\{\s*return\s+(define|module|require)/, 'global gizleme tablosu'],
      [/decompressFromUTF16|compressToUTF16/, 'LZString ile sıkıştırılmış string tablosu'],
    ],
  },
  { name: 'JSFuck', tests: [[/^[\s[\]()!+]{200,};?\s*$/, 'yalnızca []()!+ karakterleri']] },
  { name: 'aaencode', tests: [[/ﾟДﾟ|ﾟΘﾟ|ﾟｰﾟ/, 'japonca emoji karakterleri']] },
  { name: 'jjencode', tests: [[/\$=~\[\];/, '$=~[]; başlangıcı']] },
  { name: 'Dean Edwards packer', tests: [[/eval\(function\(p,a,c,k,e,[dr]\)/, 'eval(function(p,a,c,k,e,d)']] },
  { name: 'eval sarmalayıcı', tests: [[/^\s*eval\s*\(/, 'program eval(...) ile başlıyor']] },
  { name: 'Function sarmalayıcı', tests: [[/^[\s;]*(new\s+)?Function\s*\(/, 'program Function(...) ile başlıyor']] },
  { name: 'webpack bundle', tests: [[/__webpack_require__|webpackChunk/, 'webpack çalışma zamanı']] },
];

export function fingerprint(input) {
  const sample = input.length > 400_000 ? input.slice(0, 400_000) : input;
  const found = [];
  for (const fam of FAMILIES) {
    const evidence = [];
    for (const [re, label, min = 1] of fam.tests) {
      const hits = re.global ? (sample.match(re) ?? []).length : (re.test(sample) ? 1 : 0);
      if (hits >= min) evidence.push(label);
    }
    if (evidence.length) found.push({ name: fam.name, confidence: Math.min(1, evidence.length / fam.tests.length + 0.25), evidence });
  }
  return found.sort((a, b) => b.confidence - a.confidence);
}

const IOC_PATTERNS = {
  urls: /\b(?:https?|wss?):\/\/[^\s"'`<>\\)]{3,}/gi,
  ips: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  emails: /\b[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+\b/g,
  wallets: /\b(?:bc1[ac-hj-np-z02-9]{25,59}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|0x[a-fA-F0-9]{40})\b/g,
  jwts: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g,
};
const DOMAIN = /\b(?:[a-z0-9-]{1,63}\.)+(?:com|net|org|io|dev|app|co|ru|cn|xyz|top|info|biz|tr|de|uk|me|ai|cloud|site|online|store)\b/gi;

const SUSPICIOUS = {
  eval: 'kod çalıştırma', Function: 'kod çalıştırma', 'document.write': 'DOM enjeksiyonu',
  WebSocket: 'kalıcı bağlantı', sendBeacon: 'arka planda veri gönderimi', XMLHttpRequest: 'ağ isteği',
  fetch: 'ağ isteği', 'document.cookie': 'çerez erişimi', localStorage: 'kalıcı depolama',
  toDataURL: 'canvas fingerprint', getImageData: 'canvas fingerprint', AudioContext: 'ses fingerprint',
  OfflineAudioContext: 'ses fingerprint', RTCPeerConnection: 'yerel IP sızıntısı', webdriver: 'bot tespiti',
  'crypto.subtle': 'kriptografi', importKey: 'kriptografi', debugger: 'anti-debug', setInterval: 'zamanlayıcı',
  atob: 'base64 çözme', postMessage: 'çerçeveler arası mesaj', 'navigator.plugins': 'fingerprint',
  hardwareConcurrency: 'fingerprint', deviceMemory: 'fingerprint', getBattery: 'fingerprint',
};

function memberName(node) {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property)) {
    const obj = memberName(node.object);
    return obj ? `${obj}.${node.property.name}` : node.property.name;
  }
  return null;
}

function staticScan(code) {
  const strings = new Set();
  const apis = new Map();
  const regexes = new Set();
  let ast;
  try { ast = parse(code); } catch { return { strings: [], apis: [], regexes: [], obfuscatedIds: 0, hexCalls: 0, vmMarks: 0, functions: 0 }; }
  let obfuscatedIds = 0;
  let hexCalls = 0;
  let functions = 0;
  const bump = (name) => { if (Object.hasOwn(SUSPICIOUS, name)) apis.set(name, (apis.get(name) ?? 0) + 1); };
  traverse(ast, {
    StringLiteral(p) { if (p.node.value.length >= 4) strings.add(p.node.value); },
    TemplateElement(p) { if (p.node.value.cooked?.length >= 4) strings.add(p.node.value.cooked); },
    RegExpLiteral(p) { regexes.add(`/${p.node.pattern}/${p.node.flags}`); },
    Identifier(p) {
      if (/^_0x[0-9a-f]+$/i.test(p.node.name)) obfuscatedIds++;
      if (p.isReferencedIdentifier()) bump(p.node.name);
    },
    MemberExpression(p) {
      const full = memberName(p.node);
      if (!full) return;
      bump(full);
      const last = full.split('.').slice(-2).join('.');
      if (last !== full) bump(last);
      if (!p.node.computed) bump(p.node.property.name);
    },
    DebuggerStatement() { bump('debugger'); },
    CallExpression(p) {
      const a = p.node.arguments;
      if (t.isIdentifier(p.node.callee) && a.length && a.every((x) => t.isNumericLiteral(x) && /^0x/i.test(x.extra?.raw ?? ''))) hexCalls++;
    },
    Function() { functions++; },
  });
  const vmMarks = (code.match(/PEEL VM/g) ?? []).length;
  return {
    strings: [...strings],
    apis: [...apis].map(([name, count]) => ({ name, count, why: SUSPICIOUS[name] })).sort((a, b) => b.count - a.count),
    regexes: [...regexes].slice(0, 200),
    obfuscatedIds,
    hexCalls,
    vmMarks,
    functions,
  };
}

function iocs(strings, code) {
  const haystack = `${strings.join('\n')}\n${code}`;
  const out = {};
  for (const [k, re] of Object.entries(IOC_PATTERNS)) out[k] = [...new Set(haystack.match(re) ?? [])].slice(0, 200);
  const domains = new Set();
  const validHost = (h) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h);
  out.urls = out.urls.filter((u) => {
    try {
      const host = new URL(u.replace(/^wss?:/, 'https:')).hostname;
      if (!validHost(host)) return false; // "https://www." gibi birleştirme parçaları
      domains.add(host);
      return true;
    } catch {
      return false;
    }
  });
  for (const s of strings) for (const d of s.match(DOMAIN) ?? []) domains.add(d.toLowerCase());
  out.domains = [...domains].slice(0, 200);
  // uzun base64/hex string'ler: gömülü anahtar ya da şifreli veri adayı
  out.secrets = strings.filter((s) => s.length >= 32 && s.length <= 4096 &&
    (/^[A-Za-z0-9+/=_-]+$/.test(s) || /^[0-9a-f]+$/i.test(s))).slice(0, 50);
  return out;
}

async function runtimeScan(sandbox, text, config) {
  if (!sandbox) return { ok: false, network: [], reads: [], console: [], crypto: [], thrown: [], post: null };
  // program zaman aşımına uğrasa da kayıtlar sandbox'tan ayrıca okunur (core: net/reads).
  // Analiz sonrası betik: zamanlayıcılar ve olay işleyicileri tetiklenir, eklenen global'ler listelenir.
  const r = await sandbox.run(`try {\n${text}\n} catch (e) { __res.push({ __thrown: String(e) }); }`,
    { timeoutMs: 8000, post: POST_SCRIPT, config });
  const res = r.res ?? [];
  const network = r.net ?? [];
  const reads = r.reads ?? {};
  return {
    ok: r.ok,
    error: r.error,
    network,
    reads: Object.entries(reads).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    console: (r.out ?? []).slice(0, 100),
    crypto: r.crypto ?? [],
    thrown: res.filter((x) => x && x.__thrown).map((x) => x.__thrown),
    post: res.find((x) => x && x.__post) ?? null,
  };
}

// Girdideki string tabloları: statik rotasyon, tekil tablo, kısmi kurtarma, ters kodlayıcı (sandbox ile çapraz denetim)
async function stringTables(code, sandbox) {
  if (code.length > 2_000_000) return [];
  try {
    const ast = parse(code);
    const rep = analyzeStringTables(ast);
    await crossCheck(sandbox, ast, rep);
    return serializeTables(rep);
  } catch {
    return [];
  }
}

export async function analyze({ input, text, output, events = [], sandbox = null, config = null, stats = null, trace = null, verified = false, findings = null }) {
  const before = staticScan(text ?? input);
  const after = staticScan(output);
  const runtime = await runtimeScan(sandbox, text ?? input, config);
  const passTimes = {};
  for (const e of events) passTimes[e.id] = (passTimes[e.id] ?? 0) + e.ms;
  const found = iocs(after.strings, output);
  const classes = classify({ code: output, runtime, iocs: found, apis: after.apis });
  // E-U/E-V: semantik modeller, veri akışı ve analiz altyapısı (trace verilmişse pass kayıtları)
  const semantics = await analysisReport({ text: text ?? input, output, sandbox, config, trace });
  const report = {
    fingerprint: fingerprint(input),
    iocs: found,
    threat: {
      classes,
      risk: riskScore(classes, runtime),
      privacy: privacy({ runtime, iocs: found, apis: after.apis }),
      libraries: libraries(output),
      missingGlobals: missingGlobals(runtime),
      yara: yaraRule({ strings: after.strings, iocs: found, hash: fnv1a(output) }),
      ids: idsRules({ runtime, iocs: found }),
    },
    // shortcut: en fazla 300 string denenir (her biri XOR/Vigenère araması yapar); büyük çıktılarda örnekleme gerekirse artır
    encodings: encodingReport(after.strings.slice(0, 300)),
    apis: after.apis,
    regexes: after.regexes,
    runtime,
    rollbacks: events.filter((e) => e.state === 'fail'),
    // VM / durum makinesi / string tablosu bulguları (E199, E660, E632–E637)
    vm: vmReport(findings, { strings: await stringTables(text ?? input, sandbox) }),
    // çözme motoru analizleri: obfuscator ayarları, akış, bütünlük, paket modülleri (stats verilmezse ölü kod dağılımı rapor tarafında stats'tan)
    engine: engineReport({ input, text, output, stats }),
    passTimes: Object.entries(passTimes).map(([id, ms]) => ({ id, ms })).sort((a, b) => b.ms - a.ms),
    metrics: {
      inBytes: input.length,
      outBytes: output.length,
      obfuscatedIdsBefore: before.obfuscatedIds,
      obfuscatedIdsAfter: after.obfuscatedIds,
      hexCallsBefore: before.hexCalls,
      hexCallsAfter: after.hexCalls,
      vmMarks: after.vmMarks,
      functions: after.functions,
      outputHash: fnv1a(output),
    },
    // anlamlandırma: özet, okunabilirlik, çözülemeyenler, kütüphane sürümleri, modüller, ad önerileri
    naming: namingReport({ input, text, output, threat: { classes, risk: riskScore(classes, runtime) } }),
    semantics,
    // sembolik yürütme, concolic, SMT kanıtları, nokta/etki/taint, değişmezler: pahalı, isteğe bağlı
    // report.symbolic() ilk çağrıda hesaplar (rapor bölümü açılınca); sonuç report.symbolicData'ya yazılır
    symbolic: lazySymbolic({ text: text ?? input, output, sandbox }),
    // E26/E29/E30/E40: araç tespiti, otomatik profil, ayarlar, sürümler, decoder zinciri; E27: pass güveni
    detection: (() => {
      const tools = detectTools(input);
      return { tools, profile: autoProfile(tools), versions: detectVersions(input), chains: decoderChains(input) };
    })(),
    passConfidence: passConfidence(events, { verified }),
    // E611–E616, E75–E79: kripto sabitleri, anahtar/IV/mod/dolgu, gömülü şifreli verinin çözümü
    crypto: cryptoScan({ code: output, strings: after.strings, runtimeCrypto: runtime.crypto }),
    // E617–E630: blob istatistikleri ('stats' adı main.js'te pass sayaçlarına ayrılmış)
    statistics: await blobReport(after.strings.slice(0, 500), output),
    // E98/E103/E107: canary'li exfiltration haritası, bot/insan profil farkı, phishing uç noktaları
    security: await securityRuntime({ sandbox, text: text ?? input, code: output, urls: found.urls }),
  };
  // çalışma anı (coverage, taint, worker, WASM…) ve doğrulama (güven, pass riski, denetimler) bölümleri
  Object.assign(report, await runtimeExtras({ report, input, text, output, events, sandbox, config }));
  return report;
}

// Tek seferlik tembel hesap: fonksiyon (JSON dışa aktarımda görünmez), sonuç önbellekte
export function lazySymbolic(args) {
  let p = null;
  const fn = () => (p ??= symbolicReport(args).catch((e) => ({ skipped: e.message })).then((r) => { fn.data = r; return r; }));
  return fn;
}

// Eklenti analizi ve diğer modüller için: statik tarama ve IOC çıkarımı
export { staticScan, iocs as extractIocs };
