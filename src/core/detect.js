// E26/E29/E30/E40/E27: obfuscator imza veritabanı, skor eşiğiyle otomatik pass profili,
// sürüm ayırt etme, decoder zinciri derinliği ve pass başına güven skoru.
// Hepsi kanıtıyla birlikte raporlanan sezgiler; kesin hüküm değildir.

// Profil: araç tanındığında çalıştırılacak pass'ler (skor eşiği aşılırsa). 'all' = bilinmeyen araç modu (E31).
export const PROFILES = {
  all: null,
  'obfuscator-io': ['normalize', 'sourcemap', 'unpack', 'predecoders', 'literals', 'static-decode', 'integrity', 'const-arrays', 'const-objects', 'wrappers', 'static-strings',
    'string-array', 'runtime-decoders', 'proxy', 'indirection', 'const-fold', 'dead-code', 'opaque', 'state-var', 'unflatten',
    'control-flow', 'flow', 'simplify', 'restructure', 'dead-extra', 'unused'],
  'js-confuser': ['normalize', 'sourcemap', 'unpack', 'predecoders', 'literals', 'static-decode', 'integrity', 'const-arrays', 'const-objects', 'wrappers', 'string-array',
    'runtime-decoders', 'runtime-functions', 'confuser', 'proxy', 'indirection', 'const-fold', 'dead-code', 'opaque', 'state-var',
    'unflatten', 'vm', 'control-flow', 'flow', 'simplify', 'restructure', 'dead-extra', 'unused'],
  packer: ['normalize', 'sourcemap', 'unpack', 'predecoders', 'literals', 'static-decode', 'const-fold', 'simplify'],
  encoder: ['normalize', 'sourcemap', 'unpack', 'predecoders', 'literals', 'static-decode', 'const-fold'],
  minifier: ['normalize', 'sourcemap', 'unpack', 'predecoders', 'literals', 'static-decode', 'const-fold', 'indirection', 'flow', 'simplify', 'restructure', 'rename'],
  bundler: ['normalize', 'sourcemap', 'unpack', 'predecoders', 'literals', 'static-decode', 'indirection', 'simplify', 'restructure'],
  transpiler: ['normalize', 'sourcemap', 'unpack', 'predecoders', 'literals', 'static-decode', 'confuser', 'indirection', 'flow', 'regenerator', 'simplify', 'restructure'],
};

// [regex, kanıt, ağırlık(0–100), en az eşleşme]
const TOOLS = [
  { name: 'obfuscator.io', profile: 'obfuscator-io', tests: [
    [/\b_0x[0-9a-f]{4,6}\b/g, 'çok sayıda _0x tanımlayıcısı', 35, 20],
    [/\.push\(\s*_0x[0-9a-f]+\.shift\(\)\s*\)|\['push'\]\(\w+\['shift'\]\(\)\)/, 'string dizisi rotasyonu', 30],
    [/parseInt\(\w+\(0x[0-9a-f]+(?:,\s*'[^']*')?\)\)\s*\/\s*0x/, 'rotasyon checksum döngüsü', 35],
    [/while\s*\(\s*!!\[\]\s*\)/, 'while(!![]) dispatcher', 15],
    [/['"]\d+(\|\d+)+['"]\.split\(['"]\|['"]\)|\['split'\]\('\|'\)/, '"2|0|1".split akış düzleştirme', 20],
    [/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\+\/=/, 'küçük harf önce base64 alfabesi', 25],
  ] },
  { name: 'js-confuser', profile: 'js-confuser', tests: [
    [/__p_[A-Za-z0-9]{4}_/g, '__p_XXXX_ önekli adlar', 45, 2],
    [/function\s*\w*\(\.\.\.(\w+)\)\s*\{\s*\1\.length\s*=\s*(0x)?[0-9a-f]+/g, 'rest parametre + length hilesi', 35, 3],
    [/Object\.defineProperty\(\w+,\s*["'](\\x6c\\x65\\x6e\\x67\\x74\\x68|length)["']/, 'fonksiyon length sahteciliği', 20],
    [/with\s*\(\s*\w+\.\w+\s*\|\|\s*\w+\s*\)/, 'with tabanlı durum makinesi', 25],
    [/get\s*["']\w+["']\s*\(\)\s*\{\s*return\s+(define|module|require)/, 'global gizleme tablosu', 25],
    [/decompressFromUTF16|compressToUTF16/, 'LZString ile sıkıştırılmış string tablosu', 15],
    [/_dispatcher_\d+\(\s*name\s*,\s*flagArg/, 'dispatcher fonksiyonu', 40],
    [/0x9e3779b9[\s\S]{0,200}0x243f6a88/, 'tamper/integrity hash fonksiyonu', 50],
    [/^\s*Function\(\s*["'][A-Za-z$_]{4,}["']\s*,\s*["']/, 'Function("ad", "gövde") sarmalı (integrity/RGF)', 30],
    [/__p_[A-Za-z0-9]{4}_flat_/, 'flatten (_flat_ yardımcıları)', 40],
  ] },
  { name: 'JSFuck', profile: 'encoder', tests: [[/^[\s[\]()!+]{200,};?\s*$/, 'yalnızca []()!+ karakterleri', 100]] },
  { name: 'aaencode', profile: 'encoder', tests: [[/ﾟДﾟ|ﾟΘﾟ|ﾟｰﾟ/, 'japonca emoji karakterleri', 100]] },
  { name: 'jjencode', profile: 'encoder', tests: [[/\$=~\[\];/, '$=~[]; başlangıcı', 100]] },
  { name: 'Hieroglyphy', profile: 'encoder', tests: [[/^[\s[\]()!+{}]{200,};?\s*$/, 'yalnızca []()!+{} karakterleri', 80]] },
  { name: 'Dean Edwards packer', profile: 'packer', tests: [[/eval\(function\(p,a,c,k,e,[dr]\)/, 'eval(function(p,a,c,k,e,d)', 100]] },
  { name: 'Wise packer', profile: 'packer', tests: [[/eval\(function\(w,i,s,e\)/, 'eval(function(w,i,s,e)', 100]] },
  { name: 'Hunter packer', profile: 'packer', tests: [[/eval\(function\(h,u,n,t,e,r\)/, 'eval(function(h,u,n,t,e,r)', 100]] },
  { name: 'JSCrush / RegPack', profile: 'packer', tests: [[/for\s*\(\s*\w+\s*=\s*['"][^'"]{20,}['"]\s*;\s*\w+\s*=\s*\/\[[^\]]+\]\/\.exec\(/, 'RegPack açma döngüsü', 90], [/with\s*\(\s*\w+\.split\(\w+\)\s*\)\s*\w+\s*=\s*join\(shift\(\)\)/, 'with(split) join(shift()) açma', 90]] },
  { name: 'Base62/escape packer', profile: 'packer', tests: [[/eval\(unescape\(['"]%[0-9a-f]{2}/i, 'eval(unescape("%..")) sarmalayıcı', 80]] },
  { name: 'eval sarmalayıcı', profile: 'encoder', tests: [[/^\s*eval\s*\(/, 'program eval(...) ile başlıyor', 60]] },
  { name: 'Function sarmalayıcı', profile: 'encoder', tests: [[/^[\s;]*(new\s+)?Function\s*\(/, 'program Function(...) ile başlıyor', 60]] },
  { name: 'atob/base64 sarmalayıcı', profile: 'encoder', tests: [[/eval\(\s*atob\(|Function\(\s*atob\(/, 'eval(atob(...))', 80]] },
  { name: 'jsjiami (sojson v6/v7)', profile: 'obfuscator-io', tests: [[/jsjiami\.com\.v[5-7]/, 'jsjiami.com.vN imzası', 100], [/var\s+_0xod[0-9a-z]+\s*=/, '_0xod değişkeni', 40]] },
  { name: 'sojson v4/v5', profile: 'obfuscator-io', tests: [[/\['sojson\.v[45]'\]|sojson\.v[45]/, 'sojson.vN imzası', 100]] },
  { name: 'JShaman', profile: 'obfuscator-io', tests: [[/jshaman/i, 'JShaman imzası', 90], [/_0x[0-9a-f]{6}\[\d+\]\s*\^\s*_0x/, 'XOR tabanlı sayısal kodlama', 20]] },
  { name: 'JScrambler', profile: 'js-confuser', tests: [[/\b[A-Za-z]\d[A-Za-z]{3}\.[A-Za-z]\d\w{2,4}\(\d+\)/g, 'X1abc.Y2d(sayı) string erişimi', 40, 10], [/\b(?:[A-Z]\d{2}[A-Za-z]){2}\b/g, 'JScrambler tanımlayıcı biçimi', 20, 15], [/__jscrambler|jscrambler/i, 'JScrambler imzası', 100]] },
  { name: 'javascriptobfuscator.com', profile: 'obfuscator-io', tests: [[/var\s+_0x[0-9a-f]{4}\s*=\s*\[\s*"(\\x[0-9A-F]{2})+"/, 'var _0xabcd=["\\x.."] dizisi', 90]] },
  { name: 'JSObfu (Metasploit)', profile: 'obfuscator-io', tests: [[/String\.fromCharCode\(\s*(\d+\s*[-+*^]\s*\d+\s*,\s*){10,}/, 'aritmetikli fromCharCode zinciri', 60]] },
  { name: 'Closure Compiler', profile: 'minifier', tests: [[/\$jscomp|\$jscomp\$/, '$jscomp polyfill', 90], [/goog\.(provide|require|module)\(/, 'goog.provide/require', 70]] },
  { name: 'UglifyJS / Terser', profile: 'minifier', tests: [[/^(?:!function\(|\(function\(\)\{)/, 'kısa IIFE başlangıcı', 15], [/(?:[;{}(,=]![01]\b)/g, '!0/!1 boolean', 20, 5], [/void 0/g, 'void 0', 15, 3], [/\b[a-z]\.[a-z]=\w+,/g, 'tek harfli zincir atamalar', 20, 10]] },
  { name: 'esbuild', profile: 'bundler', tests: [[/__defProp\s*=\s*Object\.defineProperty|__toESM|__commonJS\s*=/, 'esbuild yardımcıları (__toESM/__commonJS)', 90]] },
  { name: 'webpack', profile: 'bundler', tests: [[/__webpack_require__|webpackChunk|webpackJsonp/, 'webpack çalışma zamanı', 95]] },
  { name: 'Rollup', profile: 'bundler', tests: [[/Object\.defineProperty\(exports,\s*['"]__esModule['"]|\(function \(global, factory\)/, 'Rollup UMD/CJS çerçevesi', 60]] },
  { name: 'Parcel', profile: 'bundler', tests: [[/parcelRequire|\$parcel\$/, 'parcelRequire', 95]] },
  { name: 'Browserify', profile: 'bundler', tests: [[/\(function\(\)\{function r\(e,n,t\)\{function o\(i,f\)/, 'browserify ön yükleyici', 95], [/typeof require=="function"&&require/, 'browserify require kontrolü', 50]] },
  { name: 'Vite / SystemJS', profile: 'bundler', tests: [[/__vitePreload|import\.meta\.hot|System\.register\(/, 'Vite/SystemJS çalışma zamanı', 80]] },
  { name: 'RequireJS / AMD', profile: 'bundler', tests: [[/\bdefine\(\s*\[[^\]]*\]\s*,\s*function/, 'AMD define([...], function)', 50]] },
  { name: 'Babel', profile: 'transpiler', tests: [[/_classCallCheck|_createClass|_interopRequireDefault|_asyncToGenerator/, 'Babel yardımcıları', 80], [/regeneratorRuntime|_regeneratorRuntime\(\)/, 'regenerator çalışma zamanı', 60]] },
  { name: 'TypeScript', profile: 'transpiler', tests: [[/var __awaiter = \(this && this\.__awaiter\)|__extends = \(this && this\.__extends\)|__decorate/, 'tsc yardımcıları (__awaiter/__extends)', 90]] },
  { name: 'SWC', profile: 'transpiler', tests: [[/_swc_|@swc\/helpers/, 'SWC yardımcıları', 90]] },
  { name: 'CoffeeScript', profile: 'transpiler', tests: [[/Generated by CoffeeScript|__hasProp = \{\}\.hasOwnProperty/, 'CoffeeScript imzası', 90]] },
  { name: 'Emscripten', profile: 'transpiler', tests: [[/Module\[['"]asm['"]\]|EMSCRIPTEN|HEAPU8\s*=/, 'Emscripten çalışma zamanı', 90]] },
  { name: 'GopherJS', profile: 'transpiler', tests: [[/\$packages\[["']github\.com|\$go\(|\$gopherjs/, 'GopherJS çalışma zamanı', 90]] },
  { name: 'Kotlin/JS', profile: 'transpiler', tests: [[/kotlin\.js|Kotlin\.defineModule|\$\$importsForInline\$\$/, 'Kotlin/JS çalışma zamanı', 90]] },
  { name: 'dart2js', profile: 'transpiler', tests: [[/dart2js|\$isDartObject|H\.throwExpression/, 'dart2js çalışma zamanı', 90]] },
  { name: 'Haxe', profile: 'transpiler', tests: [[/\$hxClasses|haxe_Exception/, 'Haxe çalışma zamanı', 90]] },
  { name: 'Elm', profile: 'transpiler', tests: [[/_Platform_export|\$elm\$core/, 'Elm çalışma zamanı', 90]] },
  { name: 'Unicode kaçış gizleme', profile: 'encoder', tests: [[/(\\u[0-9a-f]{4}){30,}/i, 'uzun \\uXXXX dizileri', 50], [/(\\x[0-9a-f]{2}){40,}/i, 'uzun \\xNN dizileri', 50]] },
  { name: 'fromCharCode kodlayıcı', profile: 'encoder', tests: [[/String\.fromCharCode\((\s*\d+\s*,){40,}/, 'uzun fromCharCode listesi', 70]] },
  { name: 'XOR string kodlayıcı', profile: 'encoder', tests: [[/charCodeAt\([^)]*\)\s*\^\s*\w+(\.charCodeAt\(|\[)/, 'charCodeAt ^ anahtar döngüsü', 50]] },
  { name: 'CryptoJS ile şifrelenmiş yük', profile: 'encoder', tests: [[/CryptoJS\.(AES|DES|TripleDES|Rabbit|RC4)\.decrypt\(/, 'CryptoJS.*.decrypt', 60], [/U2FsdGVkX1/, 'OpenSSL Salted__ base64', 40]] },
  { name: 'Magecart/skimmer gizleyici', profile: 'obfuscator-io', tests: [[/atob\(\s*['"][A-Za-z0-9+/=]{100,}['"]\s*\)/, 'büyük atob literal', 30], [/onepage|onestepcheckout|checkout/i, 'ödeme sayfası yolu', 20]] },
  { name: 'Self-defending / anti-debug koruması', profile: 'obfuscator-io', tests: [[/\(\(\(\.\+\)\+\)\+\)\+\$/, 'self-defending regex', 70], [/setInterval\([^)]*debugger|debugger;?\s*\}\s*,\s*\d+\)/, 'debugger döngüsü', 50]] },
  { name: 'Packed WebAssembly yükleyici', profile: 'encoder', tests: [[/WebAssembly\.(instantiate|compile)\(\s*(Uint8Array\.from\(|new Uint8Array\(|atob)/, 'gömülü wasm yükleme', 70]] },
  { name: 'LZString paketleyici', profile: 'encoder', tests: [[/LZString\.decompress(FromBase64|FromUTF16|FromEncodedURIComponent)?\(/, 'LZString.decompress* çağrısı', 70]] },
  { name: 'pako/gzip paketleyici', profile: 'encoder', tests: [[/pako\.(inflate|ungzip|inflateRaw)\(|new DecompressionStream\(/, 'pako/DecompressionStream açma', 70], [/['"]H4sI[A-Za-z0-9+/]{20,}/, 'gzip base64 imzası (H4sI)', 50]] },
];

export const TOOL_COUNT = TOOLS.length;

/** E26/E29: tüm imzaları uygular, 0–100 skor ve kanıtlarla sıralı liste döndürür */
export function detectTools(code) {
  const sample = code.length > 600_000 ? code.slice(0, 600_000) : code;
  const out = [];
  for (const tool of TOOLS) {
    const evidence = [];
    let score = 0;
    for (const [re, label, weight, min = 1] of tool.tests) {
      const hits = re.global ? (sample.match(re) ?? []).length : (re.test(sample) ? 1 : 0);
      if (hits >= min) { evidence.push(label); score += weight; }
    }
    if (evidence.length) out.push({ name: tool.name, score: Math.min(100, score), evidence, profile: tool.profile });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** E26: skor eşiğini aşan en iyi tespitin profili; yoksa tüm pass'ler (bilinmeyen araç modu) */
export function autoProfile(detections, threshold = 70) {
  const top = detections.find((d) => d.score >= threshold);
  if (!top) return { profile: 'all', passes: null, reason: 'eşiği aşan tespit yok: tüm pass\'ler' };
  // birden çok aracın eşiği aştığı durumda profillerin birleşimi (ör. webpack + obfuscator.io)
  const hit = detections.filter((d) => d.score >= threshold);
  const passes = [...new Set(hit.flatMap((d) => PROFILES[d.profile] ?? []))];
  return { profile: hit.map((d) => d.profile).join('+'), passes: passes.length ? passes : null, reason: `${hit.map((d) => `${d.name} ${d.score}`).join(', ')} ≥ ${threshold}` };
}

// E28 (obfuscator.io ayarlarının geri çıkarılması) engine-report.js obfuscatorSettings içindedir.

// --- E30: sürüm ayırt etme ---
export function detectVersions(code) {
  const out = [];
  // obfuscator.io: dizi tanımı biçimi ve rotasyon algoritması sürümler arasında değişti
  if (/function\s+(_0x\w+|[a-z]{1,3})\(\)\{(?:var|const)\s+\w+=\[[\s\S]{0,200000}?\1=function\(\)\{return \w+;\};return \1\(\);\}/.test(code)) {
    out.push({ tool: 'obfuscator.io', version: '≥ 2.10 (4.x dahil)', evidence: 'kendini önbelleğe alan getter fonksiyonu içinde string dizisi' });
  } else if (/var\s+_0x[0-9a-f]+\s*=\s*\[/.test(code) && /while\s*\(\s*--_0x\w+\s*\)/.test(code)) {
    out.push({ tool: 'obfuscator.io', version: '0.x – 1.x', evidence: 'global var dizi + sayaçlı (while(--n)) rotasyon' });
  } else if (/var\s+_0x[0-9a-f]+\s*=\s*\[/.test(code) && /parseInt\(_0x\w+\(/.test(code)) {
    out.push({ tool: 'obfuscator.io', version: '2.0 – 2.9', evidence: 'global var dizi + parseInt checksum rotasyonu' });
  }
  if (/_0x\w+\(_0x\w+\s*-\s*-0x[0-9a-f]+/.test(code) || /return _0x\w+\(_0x\w+\s*-\s*0x[0-9a-f]+,_0x\w+\)/.test(code)) {
    out.push({ tool: 'obfuscator.io', version: '≥ 2.13 (stringArrayIndexShift / function wrappers)', evidence: 'parametre ofsetli sarmalayıcı fonksiyonlar' });
  }
  // js-confuser 2.x Babel tabanlı yeniden yazım: __p_XXXX_ önekleri; 1.x: __getGlobal / __globalObject
  if (/__p_[A-Za-z0-9]{4}_/.test(code)) out.push({ tool: 'js-confuser', version: '2.x', evidence: '__p_XXXX_ önekli yardımcı adlar' });
  else if (/__getGlobal|__globalObject|__p_\w+\s*=\s*\{/.test(code)) out.push({ tool: 'js-confuser', version: '1.x', evidence: '__getGlobal/__globalObject yardımcıları' });
  const jj = code.match(/jsjiami\.com\.v(\d)/);
  if (jj) out.push({ tool: 'jsjiami', version: `v${jj[1]}`, evidence: `jsjiami.com.v${jj[1]}` });
  const sj = code.match(/sojson\.v(\d)/);
  if (sj) out.push({ tool: 'sojson', version: `v${sj[1]}`, evidence: `sojson.v${sj[1]}` });
  if (/eval\(function\(p,a,c,k,e,d\)/.test(code)) out.push({ tool: 'Dean Edwards packer', version: /\.replace\(\/\^\/,String\)/.test(code) ? '3.0+' : '2.x', evidence: 'p,a,c,k,e,d açıcı gövdesi' });
  if (/webpackChunk/.test(code)) out.push({ tool: 'webpack', version: '5.x', evidence: 'self.webpackChunk dizisi' });
  else if (/webpackJsonp/.test(code)) out.push({ tool: 'webpack', version: '2.x – 4.x', evidence: 'webpackJsonp' });
  else if (/__webpack_require__\.(r|d|n)\b/.test(code)) out.push({ tool: 'webpack', version: '4.x+', evidence: '__webpack_require__.r/d yardımcıları' });
  return out;
}

// --- E40: çok katmanlı decoder zinciri ---
// decoder (string tablosundan okuyan fonksiyon) ve onu çağıran sarmalayıcı katmanları: derinlik raporlanır
export function decoderChains(code) {
  const fns = new Map();
  for (const m of code.matchAll(/function\s+([\w$]+)\(([^)]*)\)\{([^{}]{0,400}?)\}/g)) fns.set(m[1], m[3]);
  const decoders = new Set();
  for (const m of code.matchAll(/function\s+([\w$]+)\(([\w$]+)(?:,[\w$]+)?\)\{\2=\2-(?:\(?-?)0x[0-9a-f]+/g)) decoders.add(m[1]);
  if (!decoders.size) return { decoders: [], maxDepth: 0, chains: [] };
  const depth = new Map([...decoders].map((d) => [d, 1]));
  // sarmalayıcı: gövdesi tek return D(...) olan fonksiyonlar; zincir sabit noktaya kadar genişler
  let changed = true;
  for (let guard = 0; changed && guard < 20; guard++) {
    changed = false;
    for (const [name, body] of fns) {
      const m = body.match(/^\s*return\s+([\w$]+)\(/);
      if (!m || !depth.has(m[1]) || name === m[1]) continue;
      const d = depth.get(m[1]) + 1;
      if ((depth.get(name) ?? 0) < d) { depth.set(name, d); changed = true; }
    }
  }
  const chains = [...depth].filter(([, d]) => d > 1).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, d]) => ({ name, depth: d }));
  return { decoders: [...decoders], maxDepth: Math.max(...depth.values()), chains };
}

// --- E27: pass başına 0–100 güven skoru ---
// Taban: pass türü (statik dönüşüm > tek çalıştırma gözlemi). Davranış doğrulaması geçtiyse artar,
// geri alma oranı ve sandbox gözlemine dayanması düşürür.
const BASE = {
  normalize: 95, unpack: 90, predecoders: 85, literals: 98, 'const-arrays': 90, 'const-objects': 88, wrappers: 88,
  'string-array': 85, 'runtime-decoders': 70, 'runtime-functions': 60, proxy: 85, 'const-fold': 92, 'dead-code': 80,
  opaque: 80, 'state-var': 75, unflatten: 72, vm: 60, 'control-flow': 75, simplify: 95, unused: 85, rename: 90,
  'static-decode': 97, restructure: 92, 'static-strings': 93, regenerator: 88, confuser: 85, indirection: 88, flow: 90,
  'dead-extra': 88, integrity: 80, sourcemap: 95,
};
export function passConfidence(events, { verified = false } = {}) {
  const byPass = new Map();
  for (const e of events) {
    const s = byPass.get(e.id) ?? { ok: 0, fail: 0, skip: 0 };
    s[e.state] = (s[e.state] ?? 0) + 1;
    byPass.set(e.id, s);
  }
  return [...byPass].filter(([, s]) => s.ok || s.fail).map(([id, s]) => {
    let score = BASE[id] ?? 75;
    const reasons = [];
    if (verified) { score += Math.round((100 - score) * 0.6); reasons.push('davranış karşılaştırması geçti'); }
    else reasons.push('davranış doğrulanmadı (yalnızca sözdizimi)');
    if (s.fail) {
      const penalty = Math.min(40, Math.round((s.fail / (s.ok + s.fail)) * 50));
      score -= penalty;
      reasons.push(`${s.fail} geri alma`);
    }
    return { id, score: Math.max(0, Math.min(100, score)), ok: s.ok, fail: s.fail, reasons };
  }).sort((a, b) => a.score - b.score);
}
