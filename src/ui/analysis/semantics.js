import { getLang } from '../../i18n.js';

// Rapor: semantik model (E-U), veri akışı ve analiz altyapısı (E-V). render(root, data): data = report.semantics
// Analizden gelen teknik etiketler (Türkçe) olduğu gibi gösterilir; başlıklar iki dilli.

const L = {
  tr: {
    model: 'Semantik model', flow: 'Veri akışı', infra: 'Analiz altyapısı', item: 'Konu', count: '#', detail: 'Ayrıntı',
    none: 'Bu programda ilgili yapı yok.', dead: 'Ölü atamalar', consts: 'Sabit kullanımlar', copies: 'Kopya yayılımı',
    sinks: 'Tehlikeli çağrılara giden değerler (talep odaklı)', rationale: 'Dönüşüm gerekçeleri', provenance: 'Köken (girdi satırı)',
    notes: 'Düğüm notları', matrix: 'Pass etkileşimleri (A → B etkinleştirdi / bozdu)', order: 'Olay döngüsü sırası', hazards: 'Minifier tehlikeleri',
    regex: 'Düzenli ifade motor farkları', yes: 'evet', no: 'hayır',
  },
  en: {
    model: 'Semantic model', flow: 'Data flow', infra: 'Analysis infrastructure', item: 'Topic', count: '#', detail: 'Details',
    none: 'No related construct in this program.', dead: 'Dead assignments', consts: 'Constant uses', copies: 'Copy propagation',
    sinks: 'Values reaching dangerous calls (demand-driven)', rationale: 'Transformation rationale', provenance: 'Provenance (input line)',
    notes: 'Node notes', matrix: 'Pass interactions (A → B enabled / broke)', order: 'Event loop order', hazards: 'Minifier hazards',
    regex: 'RegExp engine differences', yes: 'yes', no: 'no',
  },
};
const tx = (k) => (L[getLang()] ?? L.tr)[k];

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

function table(headers, rows, classes = []) {
  return el('table', { class: 'rep-table' },
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows.slice(0, 60).map((r) => el('tr', {}, ...r.map((c, i) => el('td', { class: classes[i] ?? '' }, String(c ?? '–')))))));
}

const chips = (list) => el('div', { class: 'chips' }, ...list.map((x) => el('span', { class: 'chip' }, String(x))));
const ln = (x) => (x?.line ? `:${x.line}` : '');

// [kimlik, ad, sayı, ayrıntı] — sayısı sıfır olan satırlar gösterilmez
function modelRows(d) {
  const s = d.semantics ?? {};
  const rt = d.runtime && d.runtime.ok !== false ? d.runtime : null;
  const rows = [];
  const add = (id, name, n, detail) => { if (n) rows.push([id, name, n, detail]); };
  add('E501/E536', 'ToPrimitive · BigInt (sandbox\'sız katlama)', d.folds?.count, (d.folds?.samples ?? []).slice(0, 3).map((x) => `${x.expr} → ${x.value}`).join(' · '));
  add('E502', 'sıkı/gevşek mod', s.strict?.differences?.length, `sıkı ${s.strict?.strictFunctions ?? 0} / gevşek ${s.strict?.sloppyFunctions ?? 0} fonksiyon · ${(s.strict?.differences ?? []).slice(0, 4).map((x) => `${x.construct}${ln(x)}`).join(', ')}`);
  add('E503', 'TDZ', (s.tdz?.sites?.length ?? 0) + (d.dataflow?.tdz?.length ?? 0), [...(s.tdz?.sites ?? []), ...(d.dataflow?.tdz ?? [])].slice(0, 4).map((x) => `${x.name}${ln(x)} ${x.kind ?? (x.definite ? 'kesin' : 'olası')}`).join(', '));
  add('E504', 'getter/setter yan etkisi', s.accessors?.definitions?.length, `${(s.accessors?.definitions ?? []).filter((x) => x.effectful).length} yan etkili · ${s.accessors?.effectfulReads?.length ?? 0} okuma`);
  add('E505', 'Proxy tuzakları', s.proxies?.sites?.length, (s.proxies?.sites ?? []).slice(0, 3).map((x) => `${x.bound ?? 'proxy'}: ${(x.traps ?? ['?']).join('/')}`).join(' · '));
  add('E506', 'Symbol anahtarlar', (s.symbols?.wellKnown?.length ?? 0) + (s.symbols?.keyOrders?.length ?? 0), (s.symbols?.wellKnown ?? []).slice(0, 4).map((x) => x.symbol).join(', '));
  add('E507', 'özel alanlar', s.privateFields?.classes?.length, (s.privateFields?.classes ?? []).slice(0, 3).map((x) => `${x.name}: ${x.members.join(', ')}`).join(' · '));
  add('E508', 'with kapsamı', s.with?.statements, s.with ? `özellik ${s.with.resolution.property} · binding ${s.with.resolution.binding} · dinamik ${s.with.resolution.dynamic}` : '');
  add('E509', 'eval kapsamı', (s.eval?.direct?.length ?? 0) + (s.eval?.indirect?.length ?? 0) + (s.eval?.functionCtor?.length ?? 0), `doğrudan ${s.eval?.direct?.length ?? 0} · dolaylı ${s.eval?.indirect?.length ?? 0} · Function ${s.eval?.functionCtor?.length ?? 0}`);
  add('E510', 'realm', (s.realm?.sources?.length ?? 0) + (s.realm?.freshNatives?.length ?? 0), (s.realm?.freshNatives ?? []).slice(0, 3).map((x) => `${x.native}${ln(x)}`).join(', ') || `${s.realm?.checks?.length ?? 0} realm'e duyarlı denetim`);
  add('E511', 'modül ad alanı', (s.moduleNamespace?.imports?.length ?? 0) + (s.moduleNamespace?.writes?.length ?? 0), (s.moduleNamespace?.ownExports ?? []).join(', '));
  add('E512', 'top-level await', s.topLevelAwait?.sites?.length, rt?.topLevelAwait ? 'sandbox\'ta async sarmalayıcıyla çalıştırıldı' : '');
  add('E513', 'iterator protokolü', s.iterators?.sites?.length, `${s.iterators?.userIterators?.length ?? 0} kullanıcı yineleyici · ${s.iterators?.earlyExits?.length ?? 0} erken çıkış (return())`);
  add('E514', 'async iterator', (s.asyncIterators?.forAwait?.length ?? 0) + (s.asyncIterators?.asyncGenerators ?? 0), `${s.asyncIterators?.forAwait?.length ?? 0} for await · ${s.asyncIterators?.asyncGenerators ?? 0} async üreteç`);
  add('E515', 'thenable çözümü', (s.thenables?.definitions?.length ?? 0) + (rt?.thenables?.length ?? 0), `${s.thenables?.adoptions?.length ?? 0} statik · ${rt?.thenables?.length ?? 0} çalışma anında`);
  add('E516', 'mikrogörev sırası', rt ? rt.microtasks + rt.macrotasks : s.microtasks?.micro, rt ? `${rt.microtasks} mikro · ${rt.macrotasks} makro görev` : '');
  add('E517', 'yakalanmamış ret', (rt?.unhandled?.length ?? 0) + (s.rejections?.candidates?.length ?? 0), rt ? (rt.unhandled.map((u) => `${u.where}: ${u.reason}`).join(' · ') || `${s.rejections?.candidates?.length ?? 0} statik aday`) : `${s.rejections?.candidates?.length ?? 0} statik aday`);
  add('E518', 'yığın izi', (s.stackTraces?.reads?.length ?? 0) + (rt?.stacks?.length ?? 0), `${s.stackTraces?.inspected?.length ?? 0} inceleme (ortam tespiti)`);
  add('E519', 'Error.captureStackTrace', (s.stackTraces?.capture?.length ?? 0) + (s.stackTraces?.prepare?.length ?? 0) + (s.stackTraces?.limit?.length ?? 0), 'V8 semantiği sandbox\'ta modellendi');
  add('E520', 'arguments.callee', s.callee?.sites?.length, (s.callee?.sites ?? []).slice(0, 3).map((x) => `${ln(x)} ${x.effect}`).join(' · '));
  add('E521', 'function.length/caller', (s.functionProps?.lengths?.length ?? 0) + (s.functionProps?.callers?.length ?? 0), (s.functionProps?.lengths ?? []).slice(0, 4).map((x) => `${x.fn}.length = ${x.value ?? 'sahte'}`).join(', '));
  add('E522', 'new.target', s.newTarget?.functions?.length, (s.newTarget?.functions ?? []).slice(0, 3).map((x) => `${x.name}: new ${x.withNew} / çağrı ${x.withoutNew}`).join(' · '));
  add('E523/E524', 'sınıf başlatma sırası · statik bloklar', s.classes?.orders?.length, (s.classes?.orders ?? []).slice(0, 2).map((x) => `${x.name}: ${x.instance.join(' → ')}${x.hazards.length ? ` ⚠ ${x.hazards.join(', ')}` : ''}`).join(' · '));
  add('E525', 'dekoratörler', s.decorators?.classes?.length, (s.decorators?.classes ?? []).slice(0, 2).map((x) => `${x.name}: ${x.apply.join(' → ')}`).join(' · '));
  add('E526', 'RegExp motor farkları', d.regexEngines?.differences?.length, `${d.regexEngines?.compared ?? 0} desen karşılaştırıldı`);
  add('E527', 'Unicode özellik kaçışları', s.unicodeEscapes?.escapes?.length, (s.unicodeEscapes?.escapes ?? []).slice(0, 4).map((x) => `${x.escape} (${x.valid === false ? 'geçersiz' : x.meaning})`).join(', '));
  add('E528', 'lastIndex durumu', (s.regex?.stateful?.length ?? 0) + (s.regex?.lastIndex?.length ?? 0), (s.regex?.stateful ?? []).slice(0, 3).map((x) => `${x.name}/${x.flags} × ${x.uses}`).join(', '));
  add('E529/E534', 'saat dilimi · performance.now', (s.time?.localDate?.length ?? 0) + (s.time?.timezone?.length ?? 0) + (s.time?.performance?.length ?? 0), 'sandbox: UTC (yapılandırılabilir), monoton deterministik saat');
  add('E530/E531', 'toLocaleString · Intl.NumberFormat', (s.locale?.toLocale?.length ?? 0) + (s.locale?.intl?.length ?? 0) + (rt?.intl ?? 0), [...new Set((s.locale?.intl ?? []).map((x) => x.api))].join(', '));
  add('E537', 'TypedArray takma adı', s.typedArrays?.groups?.length, (s.typedArrays?.groups ?? []).slice(0, 2).map((g) => `${g.buffer}: ${g.views.map((v) => v.view).join(', ')}`).join(' · '));
  add('E538', 'ayrılmış ArrayBuffer', (s.detached?.transfers?.length ?? 0) + (s.detached?.usesAfter?.length ?? 0), `${s.detached?.usesAfter?.length ?? 0} ayırma sonrası kullanım`);
  add('E539', 'SharedArrayBuffer · Atomics', (s.shared?.sab?.length ?? 0) + (s.shared?.atomics?.length ?? 0), `${rt?.atomics ?? 0} çalışma anı işlemi`);
  add('E540', 'WeakRef · FinalizationRegistry', (s.weak?.weakRefs?.length ?? 0) + (s.weak?.registries?.length ?? 0), 'GC zamanlaması belirsiz: sandbox hiç toplamaz');
  return rows;
}

function flow(d) {
  const f = d.dataflow;
  if (!f || f.error) return el('p', { class: 'rep-muted' }, f?.error ?? tx('none'));
  const dl = el('dl', { class: 'kv' });
  const row = (k, v) => dl.append(el('dt', {}, k), el('dd', {}, String(v)), el('dd', {}, ''));
  row('E575 def-use', `${f.chains} zincir · ${f.defs} tanım · ${f.tracked} değişken · ${f.functions} birim${f.partial ? ' (bütçe doldu)' : ''}`);
  row('E576/E577', `${f.iterations} worklist adımı (E554) · ${f.ms} ms`);
  row('E578', f.deadCount);
  row('E579', f.copyCount);
  row('E580', f.constantCount);
  if (d.shadow && !d.shadow.error) row('E571', `${d.shadow.total} gölgeleme (${d.shadow.builtins} yerleşik${d.shadow.valueNames.length ? `, ${d.shadow.valueNames.map((v) => v.name).join('/')} gölgeleniyor` : ''})`);
  return el('div', {}, dl,
    f.dead.length ? el('h4', {}, tx('dead')) : null,
    f.dead.length ? chips(f.dead.map((x) => `${x.name}${ln(x)}`)) : null,
    f.constants.length ? el('h4', {}, tx('consts')) : null,
    f.constants.length ? chips(f.constants.slice(0, 30).map((x) => `${x.name}${ln(x)} = ${x.value}`)) : null,
    f.copies.length ? el('h4', {}, tx('copies')) : null,
    f.copies.length ? chips(f.copies.slice(0, 30).map((x) => `${x.from}${ln(x)} → ${x.to}`)) : null);
}

function infra(d) {
  const i = d.infra ?? {};
  const tr = i.trace && !i.trace.error ? i.trace : null;
  const dl = el('dl', { class: 'kv' });
  const row = (k, v) => dl.append(el('dt', {}, k), el('dd', {}, String(v)), el('dd', {}, ''));
  const dag = tr?.dag ?? i.dag;
  if (dag) row('E541', `${dag.order?.join(' → ')}${dag.violations?.length ? ` · ${dag.violations.length} ihlal` : ''}${dag.undeclared?.length ? ` · bağımlılığı bildirilmemiş: ${dag.undeclared.join(', ')}` : ''}`);
  if (tr) {
    row('E542', `${tr.conflicts.undo.length} geri alma · ${tr.conflicts.oscillation.length} salınım${tr.conflicts.failAfter.length ? ` · ${tr.conflicts.failAfter.slice(0, 3).map((x) => `${x.pair} ×${x.count}`).join(', ')}` : ''}`);
    row('E544', tr.cost.order.join(' → '));
    row('E547', tr.checkpoints.map((c) => `tur ${c.round}`).join(', ') || '–');
    row('E548', `${tr.store.snapshots} görüntü · ${tr.store.logicalNodes} düğüm → ${tr.store.storedNodes} saklandı (%${Math.round(tr.store.sharing * 100)} paylaşım)`);
    const inc = tr.incremental.perPass;
    const sum = (k) => inc.reduce((a, x) => a + Math.max(0, x[k] ?? 0), 0);
    row('E549/E550/E553', `${inc.length} pass sonrası: ${sum('changed') + sum('added')} kirli birim · ${sum('analyzed')} yeniden analiz · ${sum('reused')} önbellekten · ${tr.incremental.session.invalidated} geçersizleştirme`);
    row('E559/E562', `${tr.patches.count} yama · ${tr.patches.ops} işlem · ters yama doğrulandı: ${tr.patches.undoVerified === null ? '–' : tx(tr.patches.undoVerified ? 'yes' : 'no')}`);
    row('E563', tr.matching.length ? `ortalama %${Math.round(100 * tr.matching.reduce((a, m) => a + (m.matched ?? 0) / Math.max(1, m.a ?? 1), 0) / tr.matching.length)} düğüm eşlendi` : '–');
    row('E565', tr.comments.enabled ? `${tr.comments.kept} korundu · ${tr.comments.dropped} düştü` : 'kapalı');
    if (tr.light) row('', 'büyük girdi: yalnızca hash ve gerekçe kaydı');
  }
  if (i.ids && !i.ids.error) row('E556', `${i.ids.count} kararlı kimlik · ör. ${i.ids.sample.slice(0, 2).join(', ')}`);
  if (i.serialization && !i.serialization.error) row('E561', `peel-ast v${i.serialization.version} · ${i.serialization.bytes} bayt · gidiş-dönüş ${tx(i.serialization.roundTrip ? 'yes' : 'no')}`);
  if (d.minify && !d.minify.error) row('E570', d.minify.safe ? tx('yes') : `${d.minify.kinds.join(', ')} · seçenekler ${JSON.stringify(d.minify.options)}`);
  if (d.sinks && !d.sinks.error) row('E552', `${d.sinks.analyzedUnits}/${d.sinks.units} birim analiz edildi`);
  const parts = [dl];
  if (d.sinks?.sinks?.length) parts.push(el('h4', {}, tx('sinks')), table(['API', 'arg', 'def', 'sabit'], d.sinks.sinks.map((s) => [`${s.api}${ln(s)}`, s.arg, s.tracked ? s.defs.map((x) => `${x.kind}${ln(x)}`).join(', ') : '?', s.constant ?? '–']), ['mono', 'mono', 'mono', 'mono']));
  if (tr?.matrix.cells.length) parts.push(el('h4', {}, tx('matrix')), table(['A', 'B', '+', '−'], tr.matrix.cells.map((c) => [c.a, c.b, c.enables, c.breaks]), ['mono', 'mono', 'num', 'num']));
  if (tr?.rationale.length) parts.push(el('h4', {}, `${tx('rationale')} (E558)`), table(['pass', '#', 'Δ', 'log'], tr.rationale.filter((r) => r.state !== 'skip').map((r) => [r.id, r.round, r.changes ? `${r.changes.ops} işlem (−${r.changes.removed} +${r.changes.inserted})` : r.reason ?? r.state, r.logs.slice(0, 2).join(' · ')]), ['mono', 'num', '', 'rep-muted']));
  if (tr?.provenance.length) parts.push(el('h4', {}, `${tx('provenance')} (E557)`), chips(tr.provenance.slice(0, 40).map((p) => `${p.name} ← ${p.origin ?? '?'}`)));
  if (tr?.notes.length) parts.push(el('h4', {}, `${tx('notes')} (E564)`), table(['id', '←', ''], tr.notes.slice(0, 40).map((n) => [n.id, n.origin ?? '–', n.notes.join(', ')]), ['mono', 'num', 'mono']));
  if (d.minify?.hazards?.length) parts.push(el('h4', {}, tx('hazards')), table(['', '', ''], d.minify.hazards.map((h) => [h.kind, h.line, h.detail]), ['mono', 'num', 'rep-muted']));
  return el('div', {}, ...parts);
}

export function render(root, data) {
  root.textContent = '';
  if (!data) return;
  const rows = modelRows(data);
  const rt = data.runtime && data.runtime.ok !== false ? data.runtime : null;
  root.append(
    el('h4', {}, tx('model')),
    rows.length ? table([tx('item'), '', tx('count'), tx('detail')], rows, ['mono', '', 'num', 'rep-muted']) : el('p', { class: 'rep-muted' }, tx('none')),
    rt?.order?.length ? el('h4', {}, `${tx('order')} (E516)`) : null,
    rt?.order?.length ? chips(rt.order.slice(0, 40).map((o) => `${o.phase}${o.fn ? `:${o.fn}` : ''}`)) : null,
    data.regexEngines?.differences?.length ? el('h4', {}, `${tx('regex')} (E526)`) : null,
    data.regexEngines?.differences?.length ? table(['', '', 'host', 'sandbox'], data.regexEngines.differences.map((x) => [x.pattern, x.kind, x.host, x.sandbox]), ['mono', '', 'mono', 'mono']) : null,
    el('h4', {}, tx('flow')),
    flow(data),
    el('h4', {}, tx('infra')),
    infra(data),
  );
}
