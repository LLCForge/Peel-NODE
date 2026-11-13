import { el, table, details } from './dom.js';
import { renderGraph } from './graph.js';
import { renderTransitionTable } from './table.js';
import { renderDebugger } from './debugger.js';
import { renderBytecodeVm } from './bytecode.js';

// VM ve durum makinesi raporu (E199/E660): bytecode VM panelleri, VM sürüm karşılaştırması, durum makineleri
// (grafik, aranabilir geçiş tablosu, adım adım iz, case özetleri) ve zamanlama anti-debug kayıtları.

function machinePanel(root, m) {
  const head = el('dl', { class: 'kv' });
  const row = (k, v) => head.append(el('dt', {}, k), el('dd', {}, v == null ? '–' : String(v)), el('dd', {}, ''));
  row('fonksiyon', m.fn);
  row('durum ifadesi', m.discriminant);
  row('durum adları', m.stateNames?.join(', '));
  row('sonuç', m.outcome ?? 'işaretlendi');
  row('statik keşif', m.complete ? 'tam' : m.staticReason ? `kısmi: ${m.staticReason}` : 'yok');
  row('zorlanmış çalıştırma', m.concolicRuns ?? 0);
  if (m.proxied?.length) row('Proxy ile izlenen nesne', m.proxied.join(', '));
  root.append(head);

  const nodes = [...new Set(m.edges.flatMap((e) => [String(e.from), String(e.to)]))].map((id) => ({ id }));
  if (m.edges.length) {
    const g = el('div');
    root.append(el('h4', {}, 'Geçiş grafiği'), g);
    renderGraph(g, { id: `${m.fn}-${m.line}`, nodes, edges: m.edges });
    const tb = el('div');
    root.append(el('h4', {}, 'Geçiş tablosu'), tb);
    renderTransitionTable(tb, { edges: m.edges });
  }
  root.append(el('h4', {}, 'Durumlar'), table(['Case', 'Geçiş şablonu', 'Çağrılar', 'Durum dışı yazmalar', 'Uç'],
    m.cases.map((c) => [c.label, c.template, c.calls.join(', ') || '–', c.writes.join(', ') || '–', c.returns ? 'return' : c.throws ? 'throw' : '–']),
    ['mono', '', 'mono', 'mono', '']));
  if (m.unreachable?.length) root.append(el('p', { class: 'rep-muted' }, `Ulaşılmayan case'ler: ${m.unreachable.map((u) => `${u.label} (${u.certainty})`).join(', ')}`));
  if (m.terminators?.length) root.append(el('p', { class: 'rep-muted' }, `Uçlar: ${[...new Set(m.terminators.map((x) => `${x.from} → ${x.kind}${x.cond ? ` [${x.cond}]` : ''}`))].slice(0, 30).join(' · ')}`));
  if (m.defaultHits?.length) root.append(el('p', { class: 'rep-muted' }, `default dalına düşen durumlar: ${m.defaultHits.join(', ')}`));
  if (m.native?.length) root.append(el('p', { class: 'rep-muted' }, `Native API çağrıları: ${m.native.map((x) => `${x.name} ×${x.count}`).join(', ')}`));
  if (m.regions?.length > 1) {
    root.append(el('h4', {}, 'Giriş noktalarına göre bölgeler'), table(['Giriş', 'Ulaşılan durumlar'], m.regions.map((r) => [r.entry, r.states.join(' ')]), ['mono', 'mono']));
    if (m.sharedStates?.length) root.append(el('p', { class: 'rep-muted' }, `Ortak durumlar: ${m.sharedStates.join(' ')}`));
  }
  if (m.proxyWrites?.length) root.append(el('p', { class: 'rep-muted mono' }, `Proxy ile gözlenen yazmalar: ${m.proxyWrites.map((w) => `${w.prop}=${w.value}`).join(', ')}`));
  if (m.steps?.length) {
    const d = el('div');
    root.append(el('h4', {}, 'Adım adım iz'), d);
    renderDebugger(d, { steps: m.steps });
  }
}

export function renderVmReport(root, data) {
  root.textContent = '';
  if (!data) return;
  const s = data.summary;
  root.append(el('div', { class: 'chips' },
    el('span', { class: 'chip' }, 'bytecode VM', el('b', {}, String(s.vms))),
    el('span', { class: 'chip' }, 'çevrilen', el('b', {}, String(s.lifted))),
    el('span', { class: 'chip' }, 'doğrulanan', el('b', {}, String(s.verified))),
    el('span', { class: 'chip' }, 'iç içe', el('b', {}, String(s.nested))),
    el('span', { class: 'chip' }, 'durum makinesi', el('b', {}, String(s.machines))),
    el('span', { class: 'chip' }, 'zamanlama kontrolü', el('b', {}, String(s.timing)))));

  data.bytecode.forEach((f, i) => {
    const box = el('div');
    root.append(details(`Bytecode VM #${i} · ${f.fn} · ${f.disasm?.length ?? '?'} komut${f.lifted ? ' · düz koda çevrildi' : ''}`, box));
    renderBytecodeVm(box, f);
  });
  if (data.compare?.length) {
    root.append(el('h4', {}, 'VM sürüm karşılaştırması'), table(['VM', 'VM', 'Sonuç', 'Benzerlik', 'Eklenen / çıkan handler'],
      data.compare.map((c) => [`#${c.a}`, `#${c.b}`, c.verdict, c.similarity, `+${c.added.length} / -${c.removed.length}`]), ['mono', 'mono', '', 'num', 'mono']));
  }
  data.machines.forEach((m, i) => {
    const box = el('div');
    root.append(details(`Durum makinesi #${i} · ${m.fn} · ${m.cases.length} case · ${m.edges.length} geçiş`, box));
    machinePanel(box, m);
  });
  if (data.timing?.length) {
    root.append(el('h4', {}, 'Kaldırılan zamanlama tabanlı anti-debug kontrolleri'), table(['Koşul', 'Eylem', 'Yerine'],
      data.timing.map((x) => [x.test, x.action, x.kept ?? 'kaldırıldı']), ['mono', 'mono', '']));
  }
  if (data.proxy?.some((p) => p.byTrial)) {
    root.append(el('h4', {}, 'Proxy tabloları'), table(['Proxy', 'Case', 'Çözülen anahtar', 'Denemeyle'],
      data.proxy.map((p) => [p.name, p.entries, p.resolved, p.byTrial]), ['mono', 'num', 'num', 'num']));
  }
  if (data.strings?.length) {
    data.strings.forEach((st) => {
      const box = el('div');
      root.append(details(`String tablosu · ${st.table} · ${st.decoder} · ${st.entries.length} değer`, box));
      if (st.rotation) box.append(el('p', { class: 'rep-muted' }, `Rotasyon: ${st.rotation.text}${st.crossCheck ? ` · ${st.crossCheck}` : ''}`));
      if (st.shape) box.append(el('p', { class: 'rep-muted' }, `Decoder biçimi: ${st.shape}`));
      if (st.inverse) box.append(details(`Decoder tersi (kodlayıcı) · gidiş-dönüş ${st.inverseVerified}`, el('pre', { class: 'mono' }, st.inverse)));
      box.append(el('p', { class: 'rep-muted' }, `Kurtarılan ${st.recovered} / ${st.total}; ${st.duplicates} tekrar birleştirildi${st.missing?.length ? `; çözülemeyen indeksler: ${st.missing.slice(0, 40).join(', ')}` : ''}`));
      box.append(table(['İndeks / çağrı', 'Değer'], st.entries.slice(0, 400).map((e) => [e.keys.join(', '), e.value]), ['mono', 'mono']));
    });
  }
}
