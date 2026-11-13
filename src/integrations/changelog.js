// J200: yeni kalıplar changelog'u. Her giriş, PEEL'in tanıyıp çözmeyi öğrendiği gizleme kalıplarını
// ve ilgili pass'leri listeler; commit kimliği depo geçmişindeki karşılığıdır. Arayüz, kullanıcının
// son gördüğü girişten sonra eklenenleri "yeni" olarak işaretler (seq artan sıradır).
// Yeni bir pass ya da tespit eklendiğinde bu listeye bir giriş eklenmelidir.

export const PATTERN_CHANGELOG = [
  {
    seq: 1, commit: 'c6bc1a9', date: '2026-11-12', passes: ['unpack', 'predecoders', 'string-array', 'control-flow', 'proxy', 'opaque', 'dead-code', 'rename'],
    tr: ['obfuscator.io string dizisi ve rotasyonu', 'eval / Function / Dean Edwards packer sarmalayıcıları', 'JSFuck, aaencode, jjencode', '"2|0|1".split akış düzleştirme', 'vekil fonksiyonlar, opak koşullar, debugger koruması'],
    en: ['obfuscator.io string array and rotation', 'eval / Function / Dean Edwards packer wrappers', 'JSFuck, aaencode, jjencode', '"2|0|1".split control-flow flattening', 'proxy functions, opaque predicates, debugger protection'],
  },
  {
    seq: 2, commit: '043dad5', date: '2026-11-12', passes: ['wrappers', 'string-array', 'runtime-decoders'],
    tr: ['RC4 kodlu string dizileri', 'zincirli string dizisi sarmalayıcıları (stringArrayWrappersType: function)', 'indeks kaydırma (stringArrayIndexShift)'],
    en: ['RC4-encoded string arrays', 'chained string array wrappers (stringArrayWrappersType: function)', 'index shift (stringArrayIndexShift)'],
  },
  {
    seq: 3, commit: 'debd387', date: '2026-11-12', passes: ['const-arrays', 'control-flow'],
    tr: ['js-confuser sabit literal dizileri (duplicateLiteralsRemoval)', 'js-confuser akış düzleştirme string\'leri'],
    en: ['js-confuser constant literal arrays (duplicateLiteralsRemoval)', 'js-confuser control-flow strings'],
  },
  {
    seq: 4, commit: '0d92421', date: '2026-11-12', passes: ['state-var', 'unflatten'],
    tr: ['switch tabanlı durum makinelerini düz koda çevirme'],
    en: ['turning switch-based state machines back into straight code'],
  },
  {
    seq: 5, commit: '7122bc7', date: '2026-11-12', passes: ['unflatten', 'runtime-functions'],
    tr: ['döngü içeren durum makineleri', 'js-confuser global gizleme (globalConcealing)'],
    en: ['state machines containing loops', 'js-confuser global concealing'],
  },
  {
    seq: 6, commit: '622a5a4', date: '2026-11-12', passes: ['unflatten', 'runtime-functions'],
    tr: ['durum makinelerinde birleşme noktaları', 'js-confuser çalışma anında üretilen fonksiyonlar (rgf)'],
    en: ['merge points in state machines', 'js-confuser runtime-generated functions (rgf)'],
  },
  {
    seq: 7, commit: 'd84acc6', date: '2026-11-12', passes: ['runtime-decoders', 'const-arrays'],
    tr: ['kapsam yolu üzerinden erişilen decoder\'lar', 'kapsam nesnesindeki literal dizileri'],
    en: ['decoders reached through a scope path', 'literal arrays inside scope objects'],
  },
  {
    seq: 8, commit: '28d4f15', date: '2026-11-12', passes: ['runtime-decoders', 'const-arrays'],
    tr: ['az çağrılan yollardaki decoder\'lar', 'başka bir kökten okunan diziler'],
    en: ['decoders on rarely called paths', 'arrays read from another root'],
  },
  {
    seq: 9, commit: '5eb4ed8', date: '2026-11-12', passes: ['const-objects', 'wrappers', 'simplify'],
    tr: ['nesne vekilleri (transformObjectKeys / kontrol nesneleri)', 'fonksiyon sarmalayıcıları', 'eşdeğerliği korunan sadeleştirmeler'],
    en: ['object proxies (transformObjectKeys / control objects)', 'function wrappers', 'equivalence-preserving simplifications'],
  },
  {
    seq: 10, commit: 'f6a564e', date: '2026-11-12', passes: [],
    tr: ['raporda kodlanmış string tanıma: base64, hex, XOR, Vigenère adayları'],
    en: ['encoded string recognition in the report: base64, hex, XOR, Vigenère candidates'],
  },
  {
    seq: 11, commit: 'entegrasyon', date: '2026-11-12', passes: [],
    tr: ['kullanıcı tanımlı dönüşüm kuralları (kural dili) ve imzalı pass eklentileri', 'sürümler arası yeni teknik uyarısı'],
    en: ['user-defined transformation rules (rule language) and signed pass plugins', 'new-technique warning across versions'],
  },
];

export const latestSeq = () => PATTERN_CHANGELOG.at(-1).seq;

/** lastSeen'den sonra eklenen girişler (yeni rozet için). */
export const unseen = (lastSeen = 0) => PATTERN_CHANGELOG.filter((e) => e.seq > lastSeen);

export function formatChangelog(lang = 'tr', entries = PATTERN_CHANGELOG) {
  return entries.slice().reverse().map((e) => `${e.date} (${e.commit})\n${e[lang].map((x) => `  - ${x}`).join('\n')}${e.passes.length ? `\n  pass: ${e.passes.join(', ')}` : ''}`).join('\n\n');
}
