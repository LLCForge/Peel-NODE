import { el, button } from './dom.js';

// Adım adım durum makinesi / VM hata ayıklayıcısı (madde 41): sandbox'ta kaydedilen iz üzerinde
// ileri-geri adım, kaydırıcı ve kesme noktası (durum değeri, pc ya da komut adı).
// data: { title, steps: [{ state|pc, label|mnemonic, source?, effects?, depth?, top?, regs? }] }

export function renderDebugger(root, data) {
  root.textContent = '';
  const steps = data.steps ?? [];
  if (!steps.length) {
    root.append(el('p', { class: 'rep-muted' }, 'Kayıtlı iz yok (çalıştırmada bu makineye girilmedi).'));
    return;
  }
  let i = 0;
  const view = el('div');
  const pos = el('span', { class: 'mono' });
  const range = el('input', { type: 'range', min: '0', max: String(steps.length - 1), value: '0', 'aria-label': 'Adım' });
  const bp = el('input', { type: 'text', placeholder: 'kesme noktası: durum / pc / komut', 'aria-label': 'Kesme noktası' });
  const keyOf = (s) => [s.state, s.pc, s.label, s.mnemonic].filter((x) => x !== undefined && x !== null).map(String);

  const show = () => {
    const s = steps[i];
    pos.textContent = `${i + 1} / ${steps.length}`;
    range.value = String(i);
    view.textContent = '';
    const dl = el('dl', { class: 'kv' });
    const row = (k, v) => { if (v !== undefined && v !== null && v !== '') dl.append(el('dt', {}, k), el('dd', {}, String(v)), el('dd', {}, '')); };
    row('durum', s.state);
    row('pc', s.pc);
    row('case / komut', s.label ?? s.mnemonic);
    row('yığın derinliği', s.depth);
    if (s.top?.length) row('yığın tepesi', s.top.join('  ·  '));
    if (s.regs?.length) row('register', s.regs.map((r, k) => `r${k}=${r}`).join(' '));
    if (s.effects?.length) row('yan etkiler', s.effects.join(', '));
    view.append(dl);
    if (s.source) view.append(el('pre', { class: 'mono' }, s.source));
  };
  const go = (n) => { i = Math.max(0, Math.min(steps.length - 1, n)); show(); };
  const runTo = (dir) => {
    const target = bp.value.trim();
    if (!target) return;
    for (let k = i + dir; k >= 0 && k < steps.length; k += dir) {
      if (keyOf(steps[k]).includes(target)) { go(k); return; }
    }
  };
  range.addEventListener('input', () => go(Number(range.value)));
  root.addEventListener('keydown', (ev) => {
    if (ev.target === bp) return;
    if (ev.key === 'ArrowRight') { ev.preventDefault(); go(i + 1); }
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); go(i - 1); }
  });
  root.append(
    el('div', { class: 'rep-actions' },
      button('⏮ Başa', () => go(0)), button('◀ Geri', () => go(i - 1)), button('İleri ▶', () => go(i + 1)), button('Sona ⏭', () => go(steps.length - 1)),
      bp, button('◀ Kesmeye', () => runTo(-1)), button('Kesmeye ▶', () => runTo(1)), pos),
    range, view);
  range.style.width = '100%';
  show();
}
