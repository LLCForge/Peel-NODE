// E541 pass bağımlılık DAG'ı, E542 çakışma tespiti, E543 etkileşim matrisi, E544 maliyet modeliyle sıralama.

/**
 * Pass → kendisinden önce (aynı turda) çalışması gereken pass'ler ve gerekçesi.
 * Kayıt defterinde (registry) olup burada olmayan pass'ler kısıtsız sayılır ve raporda belirtilir.
 */
export const PASS_DEPS = {
  unpack: { after: ['normalize'], why: 'sarmalayıcı açma normalleştirilmiş metin üzerinde' },
  predecoders: { after: ['unpack'], why: 'ön decoder\'lar açılmış katmanı okur' },
  literals: { after: ['predecoders'], why: 'AST pass\'leri metin katmanları açıldıktan sonra' },
  'const-arrays': { after: ['literals'], why: 'dizi elemanları normalleştirilmiş literal olmalı' },
  'const-objects': { after: ['const-arrays'], why: 'nesne değerleri satır içi dizilerden gelebilir' },
  wrappers: { after: ['const-objects'], why: 'sarmalayıcı gövdeleri sabit tablolara başvurur' },
  'string-array': { after: ['literals', 'wrappers'], why: 'decoder çağrıları sarmalayıcılardan arındırılmış olmalı' },
  'runtime-decoders': { after: ['string-array'], why: 'string tablosu çözülmeden çalışma anı decoder\'ı tanınmaz' },
  'runtime-functions': { after: ['runtime-decoders'], why: 'decoder sonuçları satır içi olmalı' },
  proxy: { after: ['string-array', 'wrappers'], why: 'proxy anahtarları çözülmüş string olmalı' },
  'const-fold': { after: ['proxy', 'runtime-decoders'], why: 'katlanacak ifadeler proxy\'lerden arınmış olmalı' },
  'dead-code': { after: ['const-fold'], why: 'koşullar önce sabite katlanır' },
  opaque: { after: ['const-fold'], why: 'opak yüklemler katlanmış sabitlerle tanınır' },
  'state-var': { after: ['const-fold'], why: 'durum değişkeni değerleri sabit olmalı' },
  'vm-lift': { after: ['state-var', 'const-fold'], why: 'bytecode ve sabit havuzu katlanmış literal olmalı' },
  unflatten: { after: ['state-var', 'vm-lift'], why: 'durum değişkeni çözümlenmeden düzleştirme geri alınamaz; vm-lift çıktısındaki pc makinesini de yapılandırır' },
  vm: { after: ['unflatten'], why: 'VM tespiti düzleştirilmiş akışı varsayar' },
  'anti-timing': { after: ['vm'], why: 'zamanlama kontrolleri açılmış akışta tanınır' },
  'control-flow': { after: ['unflatten'], why: 'switch dağıtıcıları unflatten\'dan sonra kalanlar' },
  simplify: { after: ['dead-code', 'control-flow'], why: 'sadeleştirme son yapı üzerinde' },
  unused: { after: ['simplify'], why: 'kullanılmayanlar sadeleştirmeden sonra belli olur' },
  rename: { after: ['unused'], why: 'adlandırma en son, kalan binding\'ler üzerinde' },
  'opaque-smt': { after: ['opaque'], why: 'sabit testler taşındıktan sonra kalan koşullar SMT ile kanıtlanır' },
  'ssa-opt': { after: ['dead-code', 'opaque-smt'], why: 'SSA kafesleri ölü dallar ve kanıtlı koşullar ayıklandıktan sonra' },
  'loop-opt': { after: ['ssa-opt'], why: 'IV/aralık tespiti SCCP ve kopya yayılımı sonrası sade döngüde' },
  specialize: { after: ['loop-opt'], why: 'kısmi değerlendirme sadeleşmiş gövde üzerinde' },
  'cfg-opt': { after: ['simplify'], why: 'if-dönüşümü ve ipekleme son sadeleştirilmiş yapıda' },
  integrity: { after: ['predecoders'], why: 'özet denetimleri kaynak metni değiştiren her AST pass\'inden önce açılmalı' },
  'iife-args': { after: ['literals'], why: 'jfogs önsözü normalleştirilmiş literal argümanlarla çalıştırılır' },
  'eval-inline': { after: ['runtime-decoders'], why: 'eval argümanı ancak string tablosu çözülünce sabit olur' },
  rgf: { after: ['runtime-decoders'], why: 'RGF tablosundaki kod string\'leri çözülmüş olmalı' },
  'flat-fns': { after: ['confuser'], why: 'dispatcher açılınca flatten kabuğu doğrudan çağrıya döner' },
  webpack: { after: ['unused'], why: 'adlar ölü bağlamalar silindikten sonra geri verilir' },
  'confuser-runtime': { after: ['dead-code'], why: 'yardımcı ancak string çağrıları çözülüp ölü dallar silinince kullanılmaz olur' },
  'cff-scope': { after: ['unflatten'], why: 'kapsam nesneleri durum makinesi açıldıktan sonra yerel değişkenlere bölünür' },
};

/** Kayıt defteri sırasını bağımlılıklarla denetler; topolojik sıra, döngüler ve ihlaller. */
export function passDag(passes, deps = PASS_DEPS) {
  const ids = passes.map((p) => p.id);
  const present = new Set(ids);
  const edges = [];
  for (const id of ids) for (const d of deps[id]?.after ?? []) if (present.has(d)) edges.push({ from: d, to: id, why: deps[id].why });
  const undeclared = ids.filter((id) => !deps[id] && id !== 'normalize');
  // Kahn: aynı anda hazır olanlar kayıt sırasıyla (deterministik)
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const e of edges) indeg.set(e.to, indeg.get(e.to) + 1);
  const order = [];
  const ready = ids.filter((id) => indeg.get(id) === 0);
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const e of edges.filter((x) => x.from === id)) {
      indeg.set(e.to, indeg.get(e.to) - 1);
      if (indeg.get(e.to) === 0) ready.splice(ids.indexOf(e.to) >= 0 ? sortedIndex(ready, e.to, ids) : ready.length, 0, e.to);
    }
  }
  const cycles = ids.filter((id) => !order.includes(id));
  const pos = new Map(ids.map((id, i) => [id, i]));
  const violations = edges.filter((e) => pos.get(e.from) > pos.get(e.to));
  return { nodes: ids, edges, order, cycles, violations, undeclared };
}

function sortedIndex(list, id, ids) {
  const k = ids.indexOf(id);
  let i = 0;
  while (i < list.length && ids.indexOf(list[i]) < k) i++;
  return i;
}

/** Verilen sıra bağımlılıklara uyuyor mu? (pipeline'ın passOrder seçeneği bununla doğrulanır) */
export function validOrder(order, deps = PASS_DEPS) {
  const pos = new Map(order.map((id, i) => [id, i]));
  for (const id of order) for (const d of deps[id]?.after ?? []) if (pos.has(d) && pos.get(d) > pos.get(id)) return false;
  return true;
}

/**
 * E542: çakışmalar. records: [{ id, round, state, before, after, ms }] (before/after: kod hash'i).
 *  - geri alma: B'nin çıktısı, A'nın değiştirdiği koddan önceki hâle eşit
 *  - salınım: aynı kod hash'i farklı turlarda yeniden oluşuyor (döngü kırıcı devreye girer)
 */
export function passConflicts(records) {
  const undo = [];
  const producedBy = new Map(); // hash → { id, round, from }
  const seen = new Map();
  const oscillation = [];
  for (const r of records) {
    if (r.state !== 'ok') continue;
    const prev = producedBy.get(r.before);
    if (prev && prev.from === r.after && prev.id !== r.id) undo.push({ a: prev.id, b: r.id, round: r.round, note: `${r.id}, ${prev.id} değişikliğini geri aldı` });
    producedBy.set(r.after, { id: r.id, round: r.round, from: r.before });
    if (seen.has(r.after) && seen.get(r.after).round !== r.round) oscillation.push({ id: r.id, round: r.round, firstRound: seen.get(r.after).round, firstBy: seen.get(r.after).id });
    if (!seen.has(r.after)) seen.set(r.after, { round: r.round, id: r.id });
  }
  // hata/geri alma: aynı pass'in ardından tekrar tekrar başarısız olan pass
  const failAfter = new Map();
  let lastChanger = null;
  for (const r of records) {
    if (r.state === 'ok') lastChanger = r.id;
    if (r.state === 'fail' && lastChanger) {
      const k = `${lastChanger}→${r.id}`;
      failAfter.set(k, (failAfter.get(k) ?? 0) + 1);
    }
  }
  return { undo, oscillation, failAfter: [...failAfter].map(([k, n]) => ({ pair: k, count: n })).sort((a, b) => b.count - a.count) };
}

/**
 * E543: etkileşim matrisi. m[A][B]: B'nin başarılı (kodu değiştiren) çalışmalarında, B'nin önceki çalışmasından beri
 * kodu değiştirmiş olan A sayısı. A, B'yi "etkinleştirdi". fail[A][B]: aynı koşulda B başarısız oldu.
 */
export function interactionMatrix(records) {
  const ids = [...new Set(records.map((r) => r.id))];
  const m = Object.fromEntries(ids.map((a) => [a, Object.fromEntries(ids.map((b) => [b, 0]))]));
  const fail = Object.fromEntries(ids.map((a) => [a, Object.fromEntries(ids.map((b) => [b, 0]))]));
  const sinceLast = new Map(ids.map((id) => [id, new Set()]));
  for (const r of records) {
    const changers = sinceLast.get(r.id);
    if (r.state === 'ok') for (const a of changers) if (a !== r.id) m[a][r.id]++;
    if (r.state === 'fail') for (const a of changers) if (a !== r.id) fail[a][r.id]++;
    sinceLast.set(r.id, new Set());
    if (r.state === 'ok') for (const [id, s] of sinceLast) if (id !== r.id) s.add(r.id);
  }
  return { ids, enables: m, breaks: fail };
}

/**
 * E544: maliyet modeli. maliyet = ortalama ms; fayda = değişiklik oranı + başkalarını etkinleştirme oranı.
 * Bağımlılıklara uyan, hazır pass'ler arasında fayda/maliyeti yüksek olanı önce seçen topolojik sıra.
 */
export function costOrder(passes, records, deps = PASS_DEPS) {
  const ids = passes.map((p) => p.id);
  const stats = new Map(ids.map((id) => [id, { runs: 0, ok: 0, ms: 0 }]));
  for (const r of records) {
    const s = stats.get(r.id);
    if (!s) continue;
    s.runs++;
    s.ms += r.ms ?? 0;
    if (r.state === 'ok') s.ok++;
  }
  const { enables } = interactionMatrix(records);
  const score = new Map();
  for (const id of ids) {
    const s = stats.get(id);
    const cost = s.runs ? Math.max(1, s.ms / s.runs) : 1;
    const enabled = enables[id] ? Object.values(enables[id]).reduce((a, x) => a + x, 0) : 0;
    const benefit = s.runs ? (s.ok + enabled) / s.runs : 0.5; // hiç çalışmamış pass: nötr
    score.set(id, { cost, benefit, value: benefit / cost });
  }
  const present = new Set(ids);
  const pending = new Set(ids);
  const order = [];
  while (pending.size) {
    const ready = [...pending].filter((id) => (deps[id]?.after ?? []).every((d) => !present.has(d) || !pending.has(d)));
    if (!ready.length) { order.push(...[...pending]); break; } // döngü: kayıt sırasıyla
    ready.sort((a, b) => score.get(b).value - score.get(a).value || ids.indexOf(a) - ids.indexOf(b));
    order.push(ready[0]);
    pending.delete(ready[0]);
  }
  return { order, scores: ids.map((id) => ({ id, ...score.get(id), ...stats.get(id) })) };
}
