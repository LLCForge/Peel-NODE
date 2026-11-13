// Gizleme teknikleri ansiklopedisi (J193). Her girdi: ne olduğu, neden kullanıldığı, küçük bir gerçek örnek,
// PEEL'in hangi pass'le çözdüğü ve ham girdide tespit desenleri. Eğitim modu (J191), "neden gizlenmiş" (J199)
// ve sürümler arası "yeni teknik" uyarısı (G148) bu tabloyu kullanır.
// detect: RegExp ya da (kod) => boolean. expect: örneğin çözümünde bulunması gereken parça (test/techniques.test.js her örneği gerçekten çözer).

export const TECHNIQUES = [
  {
    id: 'string-array',
    name: { tr: 'String dizisi', en: 'String array' },
    summary: {
      tr: 'Tüm string\'ler tek bir diziye taşınır, kodda yalnızca indeksle erişilen bir çözücü fonksiyon çağrısı kalır.',
      en: 'All strings are moved into one array; the code only keeps calls to an index-based accessor function.',
    },
    why: {
      tr: 'URL, API adı gibi anlamlı metinleri aramayla bulunamaz hale getirir.',
      en: 'Hides meaningful text such as URLs and API names from simple searches.',
    },
    example: `var _0x1a = ["log", "merhaba"];
function _0x2b(i) { return _0x1a[i]; }
console[_0x2b(0)](_0x2b(1));`,
    expect: 'console.log("merhaba")',
    passes: ['string-array', 'const-arrays'],
    detect: [/var\s+_0x[0-9a-f]+\s*=\s*\[\s*(['"][^'"]*['"]\s*,\s*){4,}/, /function\s+_0x[0-9a-f]+\(\s*[\w$]+\s*\)\s*\{[^}]{0,200}_0x[0-9a-f]+\[/],
  },
  {
    id: 'string-array-rotation',
    name: { tr: 'Dizi rotasyonu', en: 'Array rotation' },
    summary: {
      tr: 'String dizisi çalışma anında belirli sayıda döndürülür; statik okuma yanlış indeksleri verir.',
      en: 'The string array is rotated at runtime, so a static read yields wrong indexes.',
    },
    why: { tr: 'Diziyi elle okuyarak çözmeyi engeller.', en: 'Defeats decoding the array by hand.' },
    example: `var _0x3c = ["b", "c", "a"];
(function (arr, n) { while (--n) { arr.push(arr.shift()); } }(_0x3c, 0x3));
function _0x4d(i) { return _0x3c[i]; }
console.log(_0x4d(0) + _0x4d(1) + _0x4d(2));`,
    expect: 'console.log("abc")',
    passes: ['string-array'],
    detect: [/\.push\(\s*[\w$]+\.shift\(\)\s*\)/, /\[['"]push['"]\]\(\s*[\w$]+\[['"]shift['"]\]\(\)\s*\)/],
  },
  {
    id: 'base64-strings',
    name: { tr: 'Base64 kodlu string', en: 'Base64-encoded strings' },
    summary: {
      tr: 'String\'ler base64 olarak saklanır ve kullanılmadan hemen önce atob ya da gömülü bir çözücüyle açılır.',
      en: 'Strings are stored as base64 and decoded with atob or an embedded decoder right before use.',
    },
    why: { tr: 'Metinleri okunmaz kılar, imza tabanlı taramayı zorlaştırır.', en: 'Makes text unreadable and complicates signature scanning.' },
    example: `var _0x9 = ["Y29uc29sZQ==", "bG9n", "UEVFTA=="];
function _0x8(i) { return atob(_0x9[i]); }
window[_0x8(0)][_0x8(1)](_0x8(2));`,
    expect: '"PEEL"',
    passes: ['string-array', 'runtime-decoders'],
    detect: [/atob\(/, /["'][A-Za-z0-9+/]{12,}={0,2}["']/],
  },
  {
    id: 'rc4-strings',
    name: { tr: 'RC4 şifreli string', en: 'RC4-encrypted strings' },
    summary: {
      tr: 'Her string farklı bir anahtarla RC4 şifrelenir; çözücü çağrısı indeks ve anahtar alır.',
      en: 'Each string is RC4-encrypted with its own key; the decoder takes an index and a key.',
    },
    why: { tr: 'Base64\'ten daha güçlü gizleme; anahtar olmadan string tablosu anlamsızdır.', en: 'Stronger than base64; the table is meaningless without the keys.' },
    example: null,
    expect: null,
    passes: ['string-array', 'runtime-decoders'],
    detect: [/%\s*0x100/, /fromCharCode\([^)]*\^\s*_0x[0-9a-f]+\[/],
  },
  {
    id: 'escaped-literals',
    name: { tr: 'Kaçışlı literal', en: 'Escaped literals' },
    summary: {
      tr: 'String\'ler \\x / \\u kaçışlarıyla, sayılar onaltılık yazılır.',
      en: 'Strings are written with \\x / \\u escapes and numbers in hexadecimal.',
    },
    why: { tr: 'Gözle okumayı yavaşlatır; davranışı değiştirmez.', en: 'Slows down reading; does not change behaviour.' },
    example: `var s = "\\x68\\x65\\x6c\\x6c\\x6f"; var n = 0x2a;
console.log(s, n);`,
    expect: '"hello"',
    passes: ['literals'],
    detect: [/\\x[0-9a-f]{2}(\\x[0-9a-f]{2}){3,}/i, /\\u[0-9a-f]{4}(\\u[0-9a-f]{4}){3,}/i],
  },
  {
    id: 'identifier-mangling',
    name: { tr: 'Ad karıştırma', en: 'Identifier mangling' },
    summary: {
      tr: 'Değişken ve fonksiyon adları _0x1a2b gibi anlamsız onaltılık adlarla değiştirilir.',
      en: 'Variable and function names are replaced with meaningless hex names such as _0x1a2b.',
    },
    why: { tr: 'Kodun niyetini anlatan isimleri yok eder; geri alınamaz, yalnızca okunur adlar verilebilir.', en: 'Destroys names that reveal intent; it cannot be reversed, only readable names can be assigned.' },
    example: `function _0xabc1(_0xd1, _0xd2) { var _0xe1 = _0xd1 + _0xd2; return _0xe1; }
console.log(_0xabc1(1, 2));`,
    expect: 'function compute(num, num2)',
    passes: ['rename'],
    detect: [/\b_0x[0-9a-f]{4,6}\b/],
  },
  {
    id: 'proxy-functions',
    name: { tr: 'Vekil fonksiyonlar', en: 'Proxy functions' },
    summary: {
      tr: 'İkili işlemler ve çağrılar, yalnızca işi ileten küçük fonksiyonların arkasına saklanır (çoğu zaman bir nesnede toplanır).',
      en: 'Binary operations and calls are hidden behind tiny forwarding functions (often grouped in an object).',
    },
    why: { tr: 'Veri ve kontrol akışını izlemeyi zorlaştırır.', en: 'Makes data and control flow harder to follow.' },
    example: `var _0xo = { "aB": function (a, b) { return a + b; }, "cD": function (f, x) { return f(x); } };
console.log(_0xo["aB"](2, 3), _0xo["cD"](String, 7));`,
    expect: 'console.log(5, "7")',
    passes: ['proxy', 'const-objects'],
    detect: [/\{\s*['"]?\w{2,8}['"]?\s*:\s*function\s*\(\s*\w+\s*,\s*\w+\s*\)\s*\{\s*return\s+\w+\s*[-+*/%<>=!&|^]{1,3}\s*\w+/],
  },
  {
    id: 'control-flow-flattening',
    name: { tr: 'Kontrol akışı düzleştirme', en: 'Control-flow flattening' },
    summary: {
      tr: 'Ardışık deyimler bir switch içine dağıtılır, sıra "2|0|1" gibi bir dizgeden ya da durum değişkeninden okunur.',
      en: 'Sequential statements are scattered into a switch; the order comes from a string like "2|0|1" or a state variable.',
    },
    why: { tr: 'Kodun gerçek yürütme sırasını gizler.', en: 'Hides the real execution order.' },
    example: `function run() {
  var order = "2|0|1".split("|"), i = 0;
  while (true) {
    switch (order[i++]) {
      case "0": console.log("ikinci"); continue;
      case "1": console.log("üçüncü"); continue;
      case "2": console.log("birinci"); continue;
    }
    break;
  }
}
run();`,
    expect: 'console.log("birinci");\n  console.log("ikinci");',
    passes: ['control-flow', 'state-var', 'unflatten'],
    detect: [/['"]\d+(\|\d+)+['"]\.split\(['"]\|['"]\)/, /while\s*\(\s*!!\[\]\s*\)/, /switch\s*\(\s*\w+\[\s*\w+\+\+\s*\]\s*\)/],
  },
  {
    id: 'opaque-predicates',
    name: { tr: 'Opak koşullar', en: 'Opaque predicates' },
    summary: {
      tr: 'Sonucu hep aynı olan ama öyle görünmeyen koşullar eklenir ("abc" === "abc" gibi).',
      en: 'Conditions that always evaluate the same way but do not look like it are inserted ("abc" === "abc").',
    },
    why: { tr: 'Sahte dallar ekleyerek analizi yanıltır.', en: 'Adds fake branches to mislead analysis.' },
    example: `if ("xYz" === "xYz") { console.log("gerçek"); } else { console.log("sahte"); }`,
    expect: 'console.log("gerçek")',
    passes: ['opaque', 'const-fold', 'dead-code'],
    detect: [/if\s*\(\s*(['"])(\w+)\1\s*[!=]==\s*(['"])\w+\3\s*\)/],
  },
  {
    id: 'dead-code-injection',
    name: { tr: 'Ölü kod ekleme', en: 'Dead-code injection' },
    summary: {
      tr: 'Hiç çalışmayan, gerçek koda benzeyen bloklar eklenir.',
      en: 'Blocks that never run but look like real code are added.',
    },
    why: { tr: 'Kodu şişirir ve okuyanı yanlış yola sokar.', en: 'Bloats the code and sends readers down the wrong path.' },
    example: `if (false) { fetch("https://sahte.example/"); }
console.log("kalan");`,
    expect: 'console.log("kalan")',
    passes: ['dead-code', 'unused'],
    detect: [/if\s*\(\s*(false|!!\[\]\s*===?\s*false|!\[\])\s*\)/],
  },
  {
    id: 'debug-protection',
    name: { tr: 'Hata ayıklama koruması', en: 'Debug protection' },
    summary: {
      tr: 'Sürekli tetiklenen debugger deyimleri DevTools açıkken sayfayı kilitler.',
      en: 'Repeatedly triggered debugger statements freeze the page while DevTools is open.',
    },
    why: { tr: 'Dinamik analizi (adım adım izleme) engeller.', en: 'Blocks dynamic analysis (stepping through code).' },
    example: `setInterval(function () { debugger; }, 4000);
console.log("iş");`,
    expect: 'console.log("iş")',
    passes: ['dead-code'],
    detect: [/debugger/, /constructor\(\s*['"]debugger['"]\s*\)/],
  },
  {
    id: 'self-defending',
    name: { tr: 'Kendini savunma', en: 'Self-defending' },
    summary: {
      tr: 'Kod kendi kaynağını bir regex ile sınar; biçimlendirilirse sonsuz döngüye girer.',
      en: 'The code tests its own source with a regex and loops forever if it is reformatted.',
    },
    why: { tr: 'Güzelleştirme (beautify) sonrası çalışmayı bozar.', en: 'Breaks execution after beautification.' },
    example: null,
    expect: null,
    passes: ['dead-code', 'unused'],
    detect: [/\(\(\(\.\+\)\+\)\+\)\+\$/, /toString\(\)\.search\(/],
  },
  {
    id: 'eval-wrapper',
    name: { tr: 'eval / Function sarmalayıcı', en: 'eval / Function wrapper' },
    summary: {
      tr: 'Asıl program bir string olarak eval ya da Function ile çalıştırılır; çoğu zaman kodlanmıştır.',
      en: 'The real program is a string executed via eval or Function, usually encoded.',
    },
    why: { tr: 'Statik araçlar string içindeki kodu görmez.', en: 'Static tools do not see code inside strings.' },
    example: `eval(atob("Y29uc29sZS5sb2coImljZXJpZGUiKQ=="));`,
    expect: 'console.log("iceride")',
    passes: ['unpack', 'predecoders'],
    detect: [/^\s*eval\s*\(/, /^[\s;]*(new\s+)?Function\s*\(/, /eval\(\s*(atob|unescape|decodeURIComponent|String\.fromCharCode)\(/],
  },
  {
    id: 'packer',
    name: { tr: 'Dean Edwards packer', en: 'Dean Edwards packer' },
    summary: {
      tr: 'Kelime sözlüğü ile sıkıştırılmış kod eval(function(p,a,c,k,e,d){...}) ile açılır.',
      en: 'Dictionary-compressed code unpacked with eval(function(p,a,c,k,e,d){...}).',
    },
    why: { tr: 'Boyut küçültme ve hafif gizleme.', en: 'Size reduction and light obfuscation.' },
    example: null,
    expect: null,
    passes: ['unpack'],
    detect: [/eval\(function\(p,a,c,k,e,[dr]\)/],
  },
  {
    id: 'jsfuck',
    name: { tr: 'JSFuck', en: 'JSFuck' },
    summary: { tr: 'Program yalnızca []()!+ karakterleriyle yazılır.', en: 'The program is written using only []()!+.' },
    why: { tr: 'Filtre atlatma ve şaşırtma.', en: 'Filter evasion and confusion.' },
    example: null,
    expect: null,
    passes: ['unpack', 'predecoders'],
    detect: [/^[\s[\]()!+]{200,};?\s*$/],
  },
  {
    id: 'aaencode',
    name: { tr: 'aaencode / jjencode', en: 'aaencode / jjencode' },
    summary: { tr: 'Kod emoji benzeri ya da $ tabanlı ifadelerle kodlanır ve kendini çalıştırır.', en: 'Code is encoded as emoticon-like or $-based expressions that run themselves.' },
    why: { tr: 'Şaşırtma ve filtre atlatma.', en: 'Confusion and filter evasion.' },
    example: null,
    expect: null,
    passes: ['unpack', 'predecoders'],
    detect: [/ﾟДﾟ|ﾟΘﾟ|ﾟｰﾟ/, /\$=~\[\];/],
  },
  {
    id: 'vm',
    name: { tr: 'Sanal makine (bytecode)', en: 'Virtual machine (bytecode)' },
    summary: {
      tr: 'Program özel bir bytecode\'a derlenir ve gömülü bir yorumlayıcı döngüsüyle çalıştırılır.',
      en: 'The program is compiled to a custom bytecode run by an embedded interpreter loop.',
    },
    why: { tr: 'En güçlü gizleme: asıl mantık JavaScript olarak hiç görünmez.', en: 'The strongest form: the real logic never appears as JavaScript.' },
    example: null,
    expect: null,
    passes: ['vm'],
    // akış düzleştirmeden ayırmak için: sonsuz döngü + çok sayıda sayısal opcode case'i
    detect: [/PEEL VM/, (s) => /while\s*\(\s*(true|!!\[\]|1)\s*\)/.test(s) && (s.match(/\bcase\s+(0x[0-9a-f]+|\d+)\s*:/gi)?.length ?? 0) >= 30],
  },
  {
    id: 'rest-length',
    name: { tr: 'Rest parametre + length hilesi', en: 'Rest parameter + length trick' },
    summary: {
      tr: 'js-confuser fonksiyonları (...args) ile tanımlar ve args.length\'i sabitleyerek imzayı gizler.',
      en: 'js-confuser defines functions as (...args) and pins args.length to hide the signature.',
    },
    why: { tr: 'Parametre adlarını ve sayısını gizler.', en: 'Hides parameter names and count.' },
    example: null,
    expect: null,
    passes: ['wrappers', 'simplify'],
    detect: [/function\s*\w*\(\.\.\.(\w+)\)\s*\{\s*\1\.length\s*=/],
  },
  {
    id: 'global-concealing',
    name: { tr: 'Global gizleme', en: 'Global concealing' },
    summary: {
      tr: 'window, document gibi global\'ler bir tablo fonksiyonu üzerinden dolaylı olarak alınır.',
      en: 'Globals such as window and document are fetched indirectly through a lookup function.',
    },
    why: { tr: 'Hangi tarayıcı API\'lerinin kullanıldığını gizler.', en: 'Hides which browser APIs are used.' },
    example: null,
    expect: null,
    passes: ['runtime-functions', 'wrappers'],
    detect: [/get\s*["']\w+["']\s*\(\)\s*\{\s*return\s+(define|module|require|window|document)/],
  },
  {
    id: 'compressed-strings',
    name: { tr: 'Sıkıştırılmış string tablosu', en: 'Compressed string table' },
    summary: { tr: 'String tablosu LZString ile sıkıştırılır.', en: 'The string table is compressed with LZString.' },
    why: { tr: 'Boyutu küçültür ve tabloyu okunmaz yapar.', en: 'Shrinks size and makes the table unreadable.' },
    example: null,
    expect: null,
    passes: ['runtime-decoders'],
    detect: [/decompressFromUTF16|compressToUTF16|decompressFromBase64/],
  },
  {
    id: 'split-strings',
    name: { tr: 'Bölünmüş string', en: 'Split strings' },
    summary: { tr: 'String\'ler küçük parçalara bölünüp + ile birleştirilir.', en: 'Strings are split into small chunks joined with +.' },
    why: { tr: 'Tam metin aramasını boşa çıkarır.', en: 'Defeats full-text search.' },
    example: `console.log("ht" + "tp" + "s:" + "//" + "a.b");`,
    expect: '"https://a.b"',
    passes: ['const-fold'],
    detect: [/(['"])[^'"]{1,4}\1\s*\+\s*(['"])[^'"]{1,4}\2\s*\+\s*(['"])[^'"]{1,4}\3/],
  },
  {
    id: 'unicode-escapes-identifiers',
    name: { tr: 'Hesaplanmış özellik erişimi', en: 'Computed member access' },
    summary: { tr: 'obj.prop yerine obj["prop"] yazılır, çoğu zaman string tablosuyla birlikte.', en: 'obj["prop"] is used instead of obj.prop, often together with a string table.' },
    why: { tr: 'Özellik adlarını string tablosuna taşıyabilmek için.', en: 'Lets property names move into the string table.' },
    example: `window["console"]["log"]("nokta");`,
    expect: 'console.log("nokta")',
    passes: ['simplify'],
    detect: [/\w\[\s*['"][A-Za-z_$][\w$]*['"]\s*\]\[\s*['"][A-Za-z_$][\w$]*['"]\s*\]/],
  },
];

const SAMPLE_LIMIT = 400_000;

/** Ham girdide görülen teknikler (sezgisel). */
export function detectTechniques(code) {
  const sample = code.length > SAMPLE_LIMIT ? code.slice(0, SAMPLE_LIMIT) : code;
  const out = [];
  for (const tq of TECHNIQUES) {
    const hits = tq.detect.filter((d) => (typeof d === 'function' ? d(sample) : d.test(sample))).length;
    if (hits) out.push({ id: tq.id, name: tq.name.en, nameTr: tq.name.tr, hits });
  }
  return out;
}

export const techniqueById = (id) => TECHNIQUES.find((x) => x.id === id) ?? null;
