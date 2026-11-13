// Panel düzeni: ayırıcılar (fare, dokunma, klavye), sürükle-bırak katmanı, mobil panel geçişi ve kaydırma jestleri.

const main = document.getElementById('main');
const divider = document.getElementById('divider');
const divider2 = document.getElementById('divider2');

function resizable(el, { get, set, axis = () => 'x', min, max }) {
  let drag = false;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    drag = true;
    el.classList.add('drag');
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = main.getBoundingClientRect();
    const rtl = document.documentElement.dir === 'rtl';
    const pct = axis() === 'y' ? ((e.clientY - r.top) / r.height) * 100 : ((rtl ? r.right - e.clientX : e.clientX - r.left) / r.width) * 100;
    set(pct);
  });
  const end = () => { drag = false; el.classList.remove('drag'); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (e) => {
    const back = axis() === 'y' ? 'ArrowUp' : document.documentElement.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    const fwd = axis() === 'y' ? 'ArrowDown' : document.documentElement.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    if (e.key !== back && e.key !== fwd) return;
    e.preventDefault();
    set(get() + (e.key === back ? -5 : 5));
  });
  return { clamp: (v) => Math.max(min, Math.min(max, v)) };
}

/**
 * onSplit(pct): girdi/çıktı oranı; onTools(pct): araç paneli genişliği (3'lü) ya da alt sıra yüksekliği (4'lü)
 */
export function initPanels({ split = 50, tools = 30, onSplit, onTools, onFiles, onPane }) {
  let s1 = split;
  let s2 = tools;
  const apply = () => {
    main.style.setProperty('--split', `${s1}%`);
    main.style.setProperty('--tools', `${s2}%`);
    main.style.setProperty('--split-f', String(s1 / 100));
    divider.setAttribute('aria-valuenow', String(Math.round(s1)));
    divider2.setAttribute('aria-valuenow', String(Math.round(s2)));
  };
  // 3'lü düzende girdi+çıktı alanı araç panelinin dışındaki kısımdır: oran o alana göre
  const base = () => (main.dataset.layout === '3' ? (100 - s2) / 100 : 1);
  resizable(divider, { get: () => s1 * base(), set: (v) => { s1 = Math.max(20, Math.min(80, v / base())); apply(); onSplit?.(s1); }, min: 20, max: 80 });
  resizable(divider2, {
    axis: () => (main.dataset.layout === '4' ? 'y' : 'x'),
    get: () => 100 - s2,
    // 3'lü: sağdaki araç paneli genişliği; 4'lü: alt sıra yüksekliği (ikisi de 100 - konum)
    set: (v) => { s2 = Math.max(15, Math.min(60, 100 - v)); apply(); onTools?.(s2); },
    min: 15,
    max: 60,
  });
  apply();

  // sürükle-bırak: tüm pencere; dosya, klasör, zip/crx/har
  const drop = document.createElement('div');
  drop.id = 'drop';
  const label = document.createElement('span');
  label.dataset.i18n = 'drop';
  drop.appendChild(label);
  document.body.appendChild(drop);
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; drop.classList.add('on'); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) drop.classList.remove('on'); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    drop.classList.remove('on');
    onFiles?.(e.dataTransfer);
  });

  // mobil: tek panel görünür; sekme düğmeleri ve yatay kaydırma jesti
  const panes = ['in', 'out', 'tools'];
  const switches = [...document.querySelectorAll('.mobile-switch [role="tab"]')];
  const setPane = (p, focus = false) => {
    main.dataset.mobile = p;
    for (const b of switches) {
      const on = b.dataset.pane === p;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    onPane?.(p);
  };
  for (const b of switches) {
    b.addEventListener('click', () => setPane(b.dataset.pane));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = panes.indexOf(b.dataset.pane) + (e.key === 'ArrowRight' ? 1 : -1);
      setPane(panes[(i + panes.length) % panes.length], true);
    });
  }
  // kaydırma jesti: panel başlıklarında ve geçiş çubuğunda (editör içi kaydırmayla çakışmaz)
  let sx = null;
  let sy = 0;
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !e.target.closest('.ph, .mobile-switch, .empty')) { sx = null; return; }
    sx = e.clientX;
    sy = e.clientY;
  });
  document.addEventListener('pointerup', (e) => {
    if (sx === null || e.pointerType !== 'touch') return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    sx = null;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    const rtl = document.documentElement.dir === 'rtl';
    const i = panes.indexOf(main.dataset.mobile) + ((dx < 0) !== rtl ? 1 : -1);
    if (i >= 0 && i < panes.length) setPane(panes[i]);
  });

  return { setPane, get pane() { return main.dataset.mobile; } };
}
