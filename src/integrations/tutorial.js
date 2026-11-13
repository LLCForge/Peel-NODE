import { TECHNIQUES } from './techniques.js';

// Eğitim modu (J191): her pass'in ne yaptığı ve bir dersin adım adım oynatılması.
// Ders, ansiklopedideki gerçek örneği gerçek motorla çözer; her anlık görüntü (onSnapshot) bir adım olur
// ve o adımı üreten pass'in açıklamasıyla gösterilir.

export const PASS_DOCS = {
  normalize: {
    tr: 'Parse edilemeyen girdiyi düzeltir (BOM, HTML yorum işaretleri gibi). Geçerli koda dokunmaz.',
    en: 'Repairs input that does not parse (BOM, HTML comment markers). Leaves valid code untouched.',
  },
  unpack: {
    tr: 'eval(...), Function(...) ve packer gibi programı string içinde taşıyan sarmalayıcıları açar.',
    en: 'Unwraps eval(...), Function(...) and packer wrappers that carry the program inside a string.',
  },
  predecoders: {
    tr: 'JSFuck, aaencode, jjencode gibi kendini çalıştıran kodlamaları sandbox\'ta çalıştırıp içindeki programı çıkarır.',
    en: 'Runs self-executing encodings (JSFuck, aaencode, jjencode) in the sandbox and extracts the inner program.',
  },
  literals: {
    tr: 'Okunabilirlik: 0x1f → 31, "\\x48" → "H", a["b"] → a.b; anlamı değiştirmez.',
    en: 'Readability: 0x1f → 31, "\\x48" → "H", a["b"] → a.b; meaning is unchanged.',
  },
  'const-arrays': {
    tr: 'Hiç değiştirilmeyen ve yalnızca sabit indeksle okunan literal dizilerinin elemanlarını yerine yazar.',
    en: 'Inlines elements of literal arrays that are never mutated and only read with constant indexes.',
  },
  'const-objects': {
    tr: 'Sabit değer ve küçük vekil fonksiyon taşıyan nesneleri (obfuscator.io kontrol nesneleri) yerine yazar.',
    en: 'Inlines objects holding constants and tiny proxy functions (obfuscator.io control objects).',
  },
  wrappers: {
    tr: 'Argümanları yalnızca başka bir çağrıya ileten sarmalayıcı fonksiyonları kaldırır.',
    en: 'Removes wrapper functions that only forward their arguments to another call.',
  },
  'string-array': {
    tr: 'String dizisini ve çözücüsünü sandbox\'ta çalıştırır (rotasyon dahil), her çağrıyı gerçek string\'le değiştirir.',
    en: 'Runs the string array and its decoder in the sandbox (rotation included) and replaces each call with the real string.',
  },
  'runtime-decoders': {
    tr: 'Closure içindeki çözücüleri çalışma anında yakalar ve literal argümanlı çağrıları sonuçlarıyla değiştirir.',
    en: 'Captures decoders hidden in closures at runtime and replaces calls with literal arguments by their results.',
  },
  'runtime-functions': {
    tr: 'Çalışma anında new Function ile üretilen fonksiyonların kaynağını yakalayıp koda geri koyar.',
    en: 'Captures the source of functions generated at runtime with new Function and puts it back into the code.',
  },
  proxy: {
    tr: 'Yalnızca bir işlemi ya da çağrıyı ileten vekil fonksiyonları kullanıldıkları yere açar.',
    en: 'Inlines proxy functions that only forward one operation or call.',
  },
  'const-fold': {
    tr: 'Sabit ifadeleri hesaplar ("a" + "b" → "ab", 3 * 4 → 12); şüpheli olanları sandbox\'ta doğrular.',
    en: 'Evaluates constant expressions ("a" + "b" → "ab", 3 * 4 → 12), checking doubtful ones in the sandbox.',
  },
  'dead-code': {
    tr: 'Hiç çalışmayan dalları, debugger korumalarını ve kendini savunma kodunu kaldırır.',
    en: 'Removes branches that never run, debugger protection and self-defending code.',
  },
  opaque: {
    tr: 'Sonucu her zaman aynı olan koşulları ("x" === "x") sabitine indirger.',
    en: 'Reduces conditions that always have the same result ("x" === "x") to constants.',
  },
  'state-var': {
    tr: 'switch(P + Q + R) gibi hesaplanan durumları tek bir durum değişkenine toplar; sonraki pass\'lere zemin hazırlar.',
    en: 'Gathers computed switch states such as switch(P + Q + R) into one state variable for later passes.',
  },
  unflatten: {
    tr: 'Durum makinesine çevrilmiş kodu, durum geçişlerini izleyerek yeniden düz koda çevirir.',
    en: 'Turns state-machine code back into straight-line code by following the state transitions.',
  },
  vm: {
    tr: 'Döngü içindeki durum makinelerini tespit eder ve gözlenen geçişleri koda yorum olarak yazar; kodu değiştirmez.',
    en: 'Detects state machines in loops and writes observed transitions as comments; does not change code.',
  },
  'vm-lift': {
    tr: 'Bytecode yorumlayıcılarını (jsvmp tarzı VM) bulur, bytecode dizisini yakalar, komutları adlandırır ve yorumlayıcıyı doğrulanmış düz koda çevirir.',
    en: 'Finds bytecode interpreters (jsvmp-style VMs), captures the bytecode, names the opcodes and lifts the VM to verified plain code.',
  },
  'anti-timing': {
    tr: 'Date.now / performance.now farkıyla hata ayıklayıcıyı yakalayan anti-debug kontrollerini kaldırır (normal yol korunur).',
    en: 'Removes anti-debug checks that detect a debugger via Date.now / performance.now differences (the normal path is kept).',
  },
  'control-flow': {
    tr: '"2|0|1".split("|") ile sıralanan switch döngülerini gerçek sıraya dizer.',
    en: 'Reorders switch loops driven by "2|0|1".split("|") into their real order.',
  },
  simplify: {
    tr: 'Anlamı birebir koruyan küçük sadeleştirmeler: !0 → true, void 0 → undefined, virgül ifadelerini deyimlere ayırma.',
    en: 'Small meaning-preserving cleanups: !0 → true, void 0 → undefined, splitting comma expressions.',
  },
  unused: {
    tr: 'Hiç kullanılmayan değişken ve fonksiyonları siler (eval/with varsa dokunmaz).',
    en: 'Deletes variables and functions that are never used (skipped when eval/with is present).',
  },
  rename: {
    tr: 'Üretilmiş _0x adlarını kullanım kanıtından çıkarılan adlarla (compute, num, index), kanıt yoksa türüne göre (fn1, arg1, v1) değiştirir; anlamlı adlara dokunmaz.',
    en: 'Renames generated _0x names with names inferred from usage (compute, num, index), or by kind (fn1, arg1, v1) without evidence; meaningful names are left alone.',
  },
  sourcemap: {
    tr: 'Girdideki satır içi kaynak haritasında adı bulunan bağlamaları özgün adlarına geri çevirir; çakışan adlara dokunmaz.',
    en: 'Restores original names for bindings listed in an inline source map; conflicting names are left alone.',
  },
  integrity: {
    tr: 'Kaynağın hash\'ini denetleyen bütünlük kontrollerini, orijinal programdaki sonuca göre seçilen dalla değiştirir.',
    en: 'Replaces integrity (source hash) checks with the branch the original program actually takes.',
  },
  'static-decode': {
    tr: 'Sandbox gerektirmeyen çözücü çağrılarını katlar: decodeURIComponent, parseInt, String.fromCharCode, join/split.',
    en: 'Folds decoder calls that need no sandbox: decodeURIComponent, parseInt, String.fromCharCode, join/split.',
  },
  'static-strings': {
    tr: 'obfuscator.io string dizisini sandbox olmadan çözer (ofset, base64/RC4, rotasyon checksum\'ı statik yürütülür).',
    en: 'Decodes the obfuscator.io string array without a sandbox (offset, base64/RC4, rotation checksum run statically).',
  },
  confuser: {
    tr: 'js-confuser dispatcher\'larını ayrı fonksiyonlara, rest+length hilesini gerçek parametrelere, __generator\'ı function*\'a çevirir.',
    en: 'Turns js-confuser dispatchers into separate functions, the rest+length trick into real parameters, __generator into function*.',
  },
  indirection: {
    tr: 'Dolaylılıkları söker: destructuring atamaları, sabit nesneli with, getter/this/bind proxy\'leri, Reflect ve Object.create.',
    en: 'Removes indirection: destructuring assignments, constant-object with, getter/this/bind proxies, Reflect and Object.create.',
  },
  'opaque-smt': {
    tr: 'Dal koşullarını bit-vektör çözücüyle kanıtlar; her zaman doğru/yanlış olduğu denetlenmiş kanıtla gösterilen koşulu katlar.',
    en: 'Proves branch conditions with a bit-vector solver and folds those shown always true/false by a checked proof.',
  },
  'ssa-opt': {
    tr: 'SSA üzerinde sabit ve kopya yayılımı, ölü atama eleme, GVN/CSE/PRE ve kaçmayan nesnelerin skalerlere bölünmesi.',
    en: 'SSA-based constant and copy propagation, dead store elimination, GVN/CSE/PRE and scalar replacement of non-escaping objects.',
  },
  'loop-opt': {
    tr: 'Döngü değişmezlerini dışarı taşır, sabit turlu döngüleri açar, indüksiyon değişkenlerini sadeleştirir; durum makinesi döngülerine dokunmaz.',
    en: 'Hoists loop invariants, unrolls constant-trip loops and simplifies induction variables; state-machine loops are left alone.',
  },
  specialize: {
    tr: 'Sabit argümanla çağrılan fonksiyonun o çağrılar için kısmi değerlendirilmiş kopyasını üretir (en az bir dinamik argüman kalırsa).',
    en: 'Creates a partially evaluated copy of a function for calls with constant arguments (when a dynamic argument remains).',
  },
  flow: {
    tr: 'Akışı normalleştirir: try/catch ile gizlenmiş akış, küçük switch → if zinciri, break/continue ve guard cümleleri.',
    en: 'Normalises control flow: try/catch-hidden flow, small switch → if chain, break/continue and guard clauses.',
  },
  regenerator: {
    tr: 'Babel/regenerator durum makinelerini function* ve async function\'a geri çevirir (try/catch/finally, döngü, yield*).',
    en: 'Turns Babel/regenerator state machines back into function* and async functions (try/catch/finally, loops, yield*).',
  },
  'cfg-opt': {
    tr: 'Kontrol akışı düzeyi dönüşümler: switch normalizasyonu, kuyruk çoğaltma, atlama ipekleme, basit if → koşul ifadesi.',
    en: 'Control-flow level rewrites: switch normalisation, tail duplication, jump threading, simple if → conditional expression.',
  },
  restructure: {
    tr: 'Yapısal gizlemeyi geri alır: iç içe koşul ifadeleri → if/else zinciri, void 0 → undefined, console destructuring.',
    en: 'Undoes structural hiding: nested conditionals → if/else chains, void 0 → undefined, console destructuring.',
  },
  'dead-extra': {
    tr: 'Kullanılmayan parametre, import ve özel sınıf üyelerini, return sonrası erişilemeyen kodu ve fazla argümanları siler.',
    en: 'Deletes unused parameters, imports and private class members, code after return and surplus arguments.',
  },
  babel: {
    tr: 'Babel yardımcı kalıntılarını geri çevirir: _classCallCheck/_createClass → class, _slicedToArray → [a, b], _objectSpread → {...a}.',
    en: 'Reverses Babel helper residue: _classCallCheck/_createClass → class, _slicedToArray → [a, b], _objectSpread → {...a}.',
  },
  classes: {
    tr: 'Foo.prototype.m = function … ve gevşek mod kalıtımını class … extends … sözdizimine çevirir (yalnızca kanıtlanabildiğinde).',
    en: 'Turns Foo.prototype.m = function … and loose-mode inheritance into class … extends … (only when provable).',
  },
  'let-const': {
    tr: 'var bildirimlerini kanıtlanabildiğinde let/const yapar; program düzeyindeki var\'a dokunmaz (global özellik oluşturur).',
    en: 'Turns var into let/const when provable; program-level var is kept (it creates a global property).',
  },
  'merge-vars': {
    tr: 'Bildirim ile ilk atamayı birleştirir (var a; a = 1 → var a = 1) ve takma ad değişkenleri kaldırır.',
    en: 'Merges a declaration with its first assignment (var a; a = 1 → var a = 1) and removes alias variables.',
  },
  'move-decls': {
    tr: 'Literal başlangıçlı bildirimleri aynı bloktaki ilk kullanımlarının hemen önüne taşır.',
    en: 'Moves literal-initialised declarations right before their first use in the same block.',
  },
  'modern-syntax': {
    tr: 'ES5 → modern sözdizimi: ok fonksiyonu, şablon string, kısa özellik ve kısa metot (kanıtlanabilir alt küme).',
    en: 'ES5 → modern syntax: arrow functions, template strings, shorthand properties and methods (provable subset).',
  },
  destructure: {
    tr: 'var a = o.a, b = o.b; biçimini var { a, b } = o; nesne ayrıştırmasına çevirir.',
    en: 'Turns var a = o.a, b = o.b; into the object destructuring var { a, b } = o;.',
  },
  dedupe: {
    tr: 'Yerel adları dışında birebir aynı iki fonksiyonu birleştirir; ikincisinin çağrıları birincisine gider.',
    en: 'Merges two functions identical except for local names; calls to the second go to the first.',
  },
  extract: {
    tr: 'Aynı fonksiyonda birebir tekrar eden deyim dizilerini tek bir yardımcı fonksiyona çıkarır.',
    en: 'Extracts statement sequences repeated verbatim in a function into a single helper.',
  },
  magic: {
    tr: 'Tanınan sihirli sayıları adlandırılmış sabitlere bağlar (13 → KEY_ENTER, 86400000 → MS_PER_DAY).',
    en: 'Binds well-known magic numbers to named constants (13 → KEY_ENTER, 86400000 → MS_PER_DAY).',
  },
  annotate: {
    tr: 'Fonksiyonlara açıklama ve JSDoc tip yorumları, programa bölüm başlıkları ekler; davranışı değiştirmez.',
    en: 'Adds summary and JSDoc type comments to functions and section headers to the program; behaviour is unchanged.',
  },
  comments: {
    tr: 'Dönüşümler sırasında kaybolan girdi yorumlarını, bağlı oldukları bildirim hâlâ duruyorsa geri koyar.',
    en: 'Restores input comments lost during transforms when the declaration they belonged to still exists.',
  },
  sourcemap: {
    tr: 'Satır içi kaynak haritasında adı bulunan bağlamalara özgün adlarını geri verir.',
    en: 'Restores original names for bindings that an inline source map names.',
  },
  integrity: {
    tr: 'Kaynak metninin özetine bakan bütünlük denetimlerini özgün sonuçlarıyla değiştirir, js-confuser selfDefending denetimini kaldırır.',
    en: 'Replaces source-hash integrity checks with their original outcome and removes js-confuser selfDefending checks.',
  },
  'static-decode': {
    tr: 'decodeURIComponent, parseInt gibi saf global çağrıları sabit argümanlarla sandbox olmadan katlar.',
    en: 'Folds pure global calls such as decodeURIComponent and parseInt with constant arguments, without a sandbox.',
  },
  'iife-args': {
    tr: 'jfogs: değerleri parametreye taşıyan IIFE\'nin çözücü önsözünü çalıştırıp değerleri kullanım yerlerine yazar.',
    en: 'jfogs: runs the decoder prelude of the parameter-hoisting IIFE and writes the values back to their uses.',
  },
  'static-strings': {
    tr: 'obfuscator.io string dizisini ofset, kodlama ve rotasyonu statik çözerek sandbox olmadan açar.',
    en: 'Decodes the obfuscator.io string array without a sandbox by solving offset, encoding and rotation statically.',
  },
  'eval-inline': {
    tr: 'Fonksiyonun tek deyimi olan sabit eval("…") kodunu (webpack eval devtool) fonksiyon gövdesine yerleştirir.',
    en: 'Inlines a constant eval("…") that is a function\'s only statement (webpack eval devtool) into the body.',
  },
  rgf: {
    tr: 'js-confuser RGF: eval ile üretilen string fonksiyonları gerçek fonksiyona, kabukları özgün gövdeye çevirir.',
    en: 'js-confuser RGF: turns eval-generated string functions into real functions and shells back into their bodies.',
  },
  confuser: {
    tr: 'js-confuser dispatcher\'ını ve variableMasking rest dizisini açar, __generator durum makinesini function*\'a çevirir.',
    en: 'Unpacks the js-confuser dispatcher and variableMasking rest array, turns __generator machines into function*.',
  },
  indirection: {
    tr: 'Getter/this/bind proxy\'leri ve destructuring ile gizlenmiş atamalar gibi dolaylılıkları söker.',
    en: 'Removes indirections such as getter/this/bind proxies and destructuring-hidden assignments.',
  },
  'flat-fns': {
    tr: 'js-confuser flatten: program düzeyine taşınan gövdeyi düz nesneden arındırıp kabuğuna geri koyar.',
    en: 'js-confuser flatten: moves the hoisted body back into its shell, resolving the flat object.',
  },
  'opaque-smt': {
    tr: 'Kalan opak koşulları bit-vektör çözücüyle kanıtlayıp sabite çevirir.',
    en: 'Proves remaining opaque conditions with a bit-vector solver and replaces them with constants.',
  },
  'ssa-opt': {
    tr: 'SSA üzerinde sabit yayılımı, kopya yayılımı, ortak alt ifade ve ölü atama eleme.',
    en: 'Constant and copy propagation, common subexpression and dead store elimination on SSA.',
  },
  'loop-opt': {
    tr: 'Döngü değişmezi taşıma, indüksiyon değişkeni sadeleştirme ve sabit turlu döngüleri açma.',
    en: 'Loop-invariant motion, induction variable simplification and unrolling of constant-trip loops.',
  },
  specialize: {
    tr: 'Sabit argümanlarla çağrılan fonksiyonun o sabitlerle sadeleşmiş kopyasını üretir.',
    en: 'Creates a copy of a function specialised for the constant arguments it is called with.',
  },
  flow: {
    tr: 'try/catch ile gizlenmiş akış, küçük switch\'ler ve zamanlama tabanlı anti-debug gibi akış biçimlerini düzeltir.',
    en: 'Normalises flow such as try/catch-hidden jumps, small switches and timing-based anti-debug.',
  },
  regenerator: {
    tr: 'regenerator durum makinesini yield/await kullanan düz fonksiyona çevirir.',
    en: 'Turns a regenerator state machine back into a plain function using yield/await.',
  },
  'cfg-opt': {
    tr: 'switch normalizasyonu, atlama ipekleme ve if-dönüşümü gibi kontrol akışı sadeleştirmeleri.',
    en: 'Control-flow clean-ups such as switch normalisation, jump threading and if-conversion.',
  },
  restructure: {
    tr: 'Literal kaynaklı destructuring gibi yapısal gizlemeleri anlamı koruyarak düz biçime çevirir.',
    en: 'Rewrites structural disguises such as literal-sourced destructuring into plain form.',
  },
  'dead-extra': {
    tr: 'Kullanılmayan parametre, import, yinelenen tanım ve erişilemeyen kod gibi fazlalıkları siler.',
    en: 'Deletes leftovers such as unused parameters and imports, duplicate definitions and unreachable code.',
  },
  'confuser-runtime': {
    tr: 'js-confuser stringConcealing\'in string\'ler çözüldükten sonra ölü kalan çalışma anı yardımcısını (getGlobal, UTF-8 çözücü) siler.',
    en: 'Removes the js-confuser stringConcealing runtime helper (getGlobal, UTF-8 decoder) left dead once strings are decoded.',
  },
  'cff-scope': {
    tr: 'js-confuser kontrol akışı düzleştirmesinin makine kopyalarını kabuklarına taşır, kapsam nesnesi özelliklerini yerel değişkenlere böler.',
    en: 'Moves js-confuser flattening machine copies back into their shells and splits scope-object properties into locals.',
  },
  webpack: {
    tr: 'webpack paketinde modül tablosunu ve require fonksiyonunu tanır, webpack adlarını geri verir, modülleri işaretler.',
    en: 'Recognises the webpack module table and require function, restores webpack names and marks modules.',
  },
};

export const LESSONS = TECHNIQUES.filter((x) => x.example);

/**
 * Dersi gerçek motorla oynatır ve adımları döndürür.
 * @param {string} id  teknik kimliği
 * @param {(input: string, o: object) => Promise<object>} deobfuscate  pipeline.deobfuscate
 * @param {object} [o]  deobfuscate seçenekleri (sandbox vb.)
 * @returns {Promise<{lesson: object, steps: Array<{pass: string, round: number, code: string, doc: {tr: string, en: string}}>, result: string}>}
 */
export async function playLesson(id, deobfuscate, o = {}) {
  const lesson = LESSONS.find((x) => x.id === id);
  if (!lesson) throw new Error(`Ders bulunamadı: ${id}`);
  const steps = [];
  const res = await deobfuscate(lesson.example, {
    level: 4,
    deep: Boolean(o.sandbox),
    ...o,
    onSnapshot: (s) => steps.push({
      pass: s.id,
      round: s.round,
      code: s.code,
      doc: PASS_DOCS[s.id] ?? { tr: 'Parse edilmiş girdi.', en: 'Parsed input.' },
    }),
  });
  return { lesson, steps, result: res.code, solved: res.code.includes(lesson.expect) };
}
