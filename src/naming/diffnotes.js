// 95: açıklamalı fark. Pipeline'ın her kabul edilen adımı (anlık görüntü) bir öncekiyle karşılaştırılır;
// her değişiklik bloğu, onu yapan pass'in ne yaptığını anlatan açıklamayla gösterilir.

const MAX_CELLS = 2_000_000;

export const PASS_NOTES = {
  girdi: { tr: 'Metin katmanları açılmış girdi', en: 'Input after text layers were unpacked' },
  literals: { tr: 'Kaçışlı string/sayı literal\'leri okunur hale getirildi', en: 'Escaped string/number literals made readable' },
  'const-arrays': { tr: 'Sabit dizi okumaları değerleriyle değiştirildi', en: 'Constant array reads replaced with values' },
  'const-objects': { tr: 'Sabit nesne özellikleri değerleriyle değiştirildi', en: 'Constant object properties inlined' },
  wrappers: { tr: 'Gereksiz sarmalayıcı fonksiyonlar açıldı', en: 'Wrapper functions inlined' },
  'string-array': { tr: 'Gizli string tablosu çözüldü', en: 'Hidden string table decoded' },
  'runtime-decoders': { tr: 'Decoder çağrıları sandbox\'ta çalıştırılıp sonuçlarıyla değiştirildi', en: 'Decoder calls evaluated in the sandbox and replaced' },
  'runtime-functions': { tr: 'Çalışma anında üretilen fonksiyonlar kaynağa döndü', en: 'Runtime-generated functions restored to source' },
  proxy: { tr: 'Proxy fonksiyon/nesne çağrıları doğrudan işlemle değiştirildi', en: 'Proxy calls replaced by direct operations' },
  'const-fold': { tr: 'Sabit ifadeler hesaplanıp katlandı', en: 'Constant expressions folded' },
  'dead-code': { tr: 'Ölü kod ve koruma tuzakları silindi', en: 'Dead code and guard traps removed' },
  opaque: { tr: 'Sonucu sabit koşullar (opaque predicate) sadeleşti', en: 'Opaque predicates simplified' },
  'state-var': { tr: 'Durum değişkeni kullanımları sadeleşti', en: 'State variable uses simplified' },
  unflatten: { tr: 'Düzleştirilmiş kontrol akışı yeniden yapılandırıldı', en: 'Flattened control flow restructured' },
  vm: { tr: 'Sanal makine (VM) yorumlayıcısı açıldı', en: 'Virtual machine interpreter unpacked' },
  'control-flow': { tr: '"2|0|1".split akış düzleştirmesi geri çevrildi', en: 'Split-string control flow restored' },
  simplify: { tr: 'Anlam koruyan sadeleştirmeler', en: 'Meaning-preserving simplifications' },
  unused: { tr: 'Kullanılmayan bildirimler kaldırıldı', en: 'Unused declarations removed' },
  rename: { tr: 'Üretilmiş isimler kullanım kanıtına göre adlandırıldı', en: 'Generated names renamed from usage evidence' },
  babel: { tr: 'Babel/regenerator kalıntıları async/generator/class\'a döndü', en: 'Babel/regenerator output turned back into async/generator/class' },
  classes: { tr: 'Prototype yapıları class\'a çevrildi', en: 'Prototype patterns converted to classes' },
  'let-const': { tr: 'var bildirimleri kanıtlanabildiği yerde let/const oldu', en: 'var declarations became let/const where provable' },
  'merge-vars': { tr: 'Bildirim+atama ve takma ad değişkenler birleşti', en: 'Declaration+assignment and alias variables merged' },
  'move-decls': { tr: 'Tanımlar ilk kullanımlarının yanına taşındı', en: 'Declarations moved next to their first use' },
  'modern-syntax': { tr: 'Ok fonksiyonu, şablon string ve kısa yazımlar', en: 'Arrow functions, template literals and shorthands' },
  destructure: { tr: 'Ardışık özellik okumaları nesne ayrıştırmaya döndü', en: 'Consecutive property reads became destructuring' },
  dedupe: { tr: 'Kopya fonksiyonlar birleştirildi', en: 'Duplicate functions merged' },
  extract: { tr: 'Tekrar eden deyim dizileri fonksiyona çıkarıldı', en: 'Repeated statement sequences extracted to functions' },
  magic: { tr: 'Sihirli sayılar adlandırılmış sabitlere bağlandı', en: 'Magic numbers bound to named constants' },
  annotate: { tr: 'Fonksiyon açıklamaları, tipler ve bölüm başlıkları eklendi', en: 'Function summaries, types and section headers added' },
  comments: { tr: 'Kaybolan yorumlar geri yüklendi', en: 'Lost comments restored' },
};

export function lineDiff(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  // ortak baş ve son: LCS tablosunu küçült
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  if (a2.length * b2.length > MAX_CELLS) return null;
  const n = a2.length;
  const m = b2.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a2[i] === b2[j]) { ops.push(['same', a2[i], pre + i + 1]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['del', a2[i], pre + i + 1]); i++; }
    else { ops.push(['add', b2[j], pre + j + 1]); j++; }
  }
  while (i < n) { ops.push(['del', a2[i], pre + i + 1]); i++; }
  while (j < m) { ops.push(['add', b2[j], pre + j + 1]); j++; }
  // değişiklik blokları (bağlam: 2 satır)
  const hunks = [];
  let cur = null;
  ops.forEach((op, k) => {
    if (op[0] === 'same') return;
    if (cur && k - cur.last <= 4) { cur.ops.push(...ops.slice(cur.last + 1, k + 1)); cur.last = k; return; }
    if (cur) hunks.push(cur);
    cur = { start: op[2], ops: ops.slice(Math.max(0, k - 2), k + 1), last: k };
  });
  if (cur) hunks.push(cur);
  for (const h of hunks) {
    h.ops.push(...ops.slice(h.last + 1, h.last + 3).filter((o) => o[0] === 'same'));
    delete h.last;
  }
  const added = ops.filter((o) => o[0] === 'add').length;
  const removed = ops.filter((o) => o[0] === 'del').length;
  return { hunks, added, removed };
}

/**
 * @param {{ id: string, round: number, code: string }[]} snapshots  pipeline onSnapshot sırası
 * @param {'tr'|'en'} lang
 */
export function annotatedDiff(snapshots, lang = 'tr') {
  const steps = [];
  for (let k = 1; k < snapshots.length; k++) {
    const prev = snapshots[k - 1];
    const cur = snapshots[k];
    const d = lineDiff(prev.code, cur.code);
    const note = PASS_NOTES[cur.id]?.[lang] ?? cur.id;
    steps.push({ pass: cur.id, round: cur.round, note, tooBig: !d, ...(d ?? { hunks: [], added: 0, removed: 0 }) });
  }
  return steps;
}
