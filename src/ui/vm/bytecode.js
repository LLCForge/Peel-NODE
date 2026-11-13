import { el, table, pre, details, button, download } from './dom.js';
import { renderDebugger } from './debugger.js';
import { assemble } from '../../core/vm/semantics.js';
import { isaFromFinding, encoderFor } from '../../core/vm/report.js';

// Tek bir bytecode VM'in rapor paneli: düzen, handler adları/anlamları, disassembly, IR, çevrilmiş kod,
// segmentler, sabit havuzu, host çağrıları, iz hata ayıklayıcısı, assembler aracı ve dışa aktarma.

const yesNo = (v) => (v === true ? 'evet' : v === false ? 'hayır' : '–');

export function renderBytecodeVm(root, f) {
  root.textContent = '';
  const head = el('dl', { class: 'kv' });
  const row = (k, v) => head.append(el('dt', {}, k), el('dd', {}, v == null ? '–' : String(v)), el('dd', {}, ''));
  row('dağıtım', `${f.dispatch?.style ?? f.style} · döngü ${f.dispatch?.loop ?? f.loop}`);
  row('opcode okuma', f.dispatch?.fetch);
  row('fonksiyon', f.fn);
  row('bytecode', `${f.origin?.bytecode ?? '?'}${f.codeLength !== undefined ? ` · ${f.codeKind}, ${f.codeLength} öğe` : ''}`);
  row('iç içe derinlik', f.origin?.depth ?? 1);
  row('düz koda çevrildi', yesNo(f.lifted));
  row('çağrı dönüşleriyle doğrulandı', yesNo(f.verified));
  if (f.reason) row('neden', f.reason);
  if (f.coverage) row('kapsam (iz)', `${f.coverage.executed} / ${f.coverage.total} komut`);
  if (f.maxDepth !== undefined) row('en büyük yığın derinliği', f.maxDepth);
  if (f.registers) row('register sayısı', f.registers.count);
  if (f.roundTrip) row('assembler gidiş-dönüş', f.roundTrip.ok ? 'aynı bytecode' : `farklı ${f.roundTrip.errors?.join('; ') ?? ''}`);
  root.append(head);

  if (f.layout?.length) root.append(el('h4', {}, 'Bellek düzeni'), table(['Rol', 'Ad', 'Ayrıntı'], f.layout.map((x) => [x.role, x.name, x.detail]), ['', 'mono', 'rep-muted']));

  root.append(el('h4', {}, 'Handler\'lar'), table(['Opcode', 'Statik ad', 'İzden ad', 'Uyum', 'Anlam'],
    (f.handlers ?? []).map((h) => [h.key, h.staticName ?? '?', h.dynName ?? '–', h.agree === null ? '–' : h.agree ? '✓' : '≠', h.semantics]),
    ['num', 'mono', 'mono', '', 'mono']));
  const aliases = (f.clusters ?? []).filter((c) => c.alias);
  root.append(el('p', { class: 'rep-muted' }, aliases.length
    ? `Aynı anlamlı handler kümeleri: ${aliases.map((c) => c.keys.join('=')).join(' · ')}`
    : `${f.clusters?.length ?? 0} handler kümesi, takma ad yok`));
  if (f.unusedHandlers?.length) root.append(el('p', { class: 'rep-muted' }, `Bytecode'da hiç kullanılmayan handler'lar: ${f.unusedHandlers.join(', ')}`));
  if (f.signature) root.append(el('p', { class: 'rep-muted mono' }, `imza: motor ${f.signature.engine} · tablo ${f.signature.table}`));
  if (f.alphabet) root.append(el('p', { class: 'rep-muted mono' }, `opcode alfabesi: ${f.alphabet.join(' ')}`));
  if (f.isa?.length) root.append(details('Komut kümesi', table(['Opcode', 'Ham değer', 'Mnemonic', 'İşlenen'],
    f.isa.map((x) => [x.op, f.opcodeMap?.find((m) => String(m.op) === String(x.op))?.raw, x.mnemonic, x.operands]), ['num', 'num', 'mono', 'num'])));

  if (f.listing) root.append(details('Disassembly', pre(f.listing)));
  if (f.blocks?.length) root.append(details(`Temel bloklar (${f.blocks.length})`, pre(f.blocks.map((b) => `${b.start}: ${b.pcs.join(' ')}`).join('\n'))));
  if (f.gaps?.length) root.append(el('p', { class: 'rep-muted' }, `Komut olarak erişilmeyen aralıklar (veri / ölü kod): ${f.gaps.map(([a, b]) => `${a}–${b}`).join(', ')}`));
  if (f.loops?.length) root.append(el('p', { class: 'rep-muted' }, `Döngüler (geri kenar): ${f.loops.map((l) => `${l.latch} → ${l.head}`).join(', ')}`));
  if (f.exits) root.append(el('p', { class: 'rep-muted' }, `Çıkışlar: ${[...new Set(f.exits.paths.map((x) => `${x.pc}: ${x.kind}`))].join(', ') || '–'}${f.exits.handlers.length ? ` · çıkış handler'ları ${f.exits.handlers.join(', ')}` : ''}`));
  if (f.ir?.length) root.append(details('Ara gösterim (IR)', pre(f.ir.map((x) => `${String(x.pc).padStart(5, '0')} ${x.mnemonic}\n${x.lines.map((l) => `      ${l}`).join('\n')}`).join('\n'))));
  if (f.liftedCode) root.append(details('Çevrilmiş kod', pre(f.liftedCode)));
  if (f.readable) root.append(details('Okunur yorumlayıcı', pre(f.readable)));
  if (f.constPool?.length) root.append(details(`Sabit havuzu (${f.constPool.length})`, table(['#', 'Değer'], f.constPool.map((c) => [c.i, c.value]), ['num', 'mono'])));
  if (f.hostCalls?.length) root.append(el('h4', {}, 'VM\'nin çağırdığı API\'ler'), table(['Çağrı', 'Tür', '#'], f.hostCalls.map((c) => [c.name, c.kind, c.count]), ['mono', '', 'num']));

  if (f.trace?.length) {
    const dbg = el('div');
    root.append(el('h4', {}, 'Adım adım iz'), dbg);
    renderDebugger(dbg, { steps: f.trace.map((s) => ({ pc: s.pc, mnemonic: s.mnemonic, depth: s.depth, top: s.top, regs: s.regs })) });
  }

  // assembler aracı: listeyi düzenle, yeniden derle, orijinalle karşılaştır
  if (f.assembly && f.isa) {
    const area = el('textarea', { rows: '10', spellcheck: 'false', 'aria-label': 'Assembly' });
    area.value = f.assembly;
    area.style.width = '100%';
    area.className = 'mono';
    const out = el('pre', { class: 'mono' });
    const run = () => {
      const r = assemble(area.value, isaFromFinding(f), encoderFor(f));
      const text = typeof r.code === 'string' ? JSON.stringify(r.code) : JSON.stringify(r.code);
      const same = typeof f.bytecode === 'string' ? r.code === f.bytecode : JSON.stringify(r.code) === JSON.stringify(f.bytecode);
      out.textContent = `${r.errors.length ? `hatalar: ${r.errors.join('; ')}\n` : ''}${same ? 'orijinal bytecode ile aynı' : 'orijinalden farklı'}\n${text}`;
    };
    root.append(details('Assembler', area, el('div', { class: 'rep-actions' }, button('Derle', run)), out));
  }

  const vmName = `vm${f.index ?? 0}`;
  root.append(el('div', { class: 'rep-actions' },
    f.bytecode !== undefined ? button('Bytecode\'u indir (.json)', () => download(`${vmName}-bytecode.json`, JSON.stringify({ kind: f.codeKind, bytecode: f.bytecode, consts: f.constPool?.map((c) => c.value) ?? [] }, null, 1))) : null,
    f.assembly ? button('Assembly indir (.asm)', () => download(`${vmName}.asm`, f.assembly, 'text/plain')) : null,
    f.rawSource ? button('Ham yorumlayıcıyı indir', () => download(`${vmName}-ham.js`, f.rawSource, 'text/javascript')) : null,
    f.readable ? button('Okunur yorumlayıcıyı indir', () => download(`${vmName}-okunur.js`, f.readable, 'text/javascript')) : null));
}
