import './integrations.css';
import { h, tx } from './dom.js';
import { renderCompare } from './compare.js';
import { renderHistory, recordRun } from './history.js';
import { renderShare, loadSharedFragment } from './share.js';
import { renderLearn, changelogBadge } from './learn.js';
import { renderFiles } from './files.js';
import { renderExtend, createExtensionState } from './extend.js';
import { registerServiceWorker } from './pwa.js';

// Entegrasyon araçları: başlığa "Araçlar" düğmesi ve bölmeli bir iletişim kutusu ekler.
// main.js'in yapması gereken yalnızca: mountIntegrations(ctx), çözmeye plugins: tools.plugins() ve
// onSnapshot: tools.snapshot vermek, çözüm bitince tools.onResult(...) çağırmak.
//
// ctx: { getInput(), setInput(text), getOutput(), setOutput(text), getSandbox(), deobfuscate, log(msg, level), notify(msg, kind) }

const SECTIONS = [
  ['compare', () => tx('Karşılaştır', 'Compare'), renderCompare],
  ['history', () => tx('Geçmiş', 'History'), renderHistory],
  ['share', () => tx('Paylaş ve dışa aktar', 'Share & export'), renderShare],
  ['files', () => tx('Dosyalar', 'Files'), renderFiles],
  ['extend', () => tx('Kurallar ve eklentiler', 'Rules & plugins'), null],
  ['learn', () => tx('Öğren', 'Learn'), renderLearn],
];

export function mountIntegrations(base) {
  const ext = createExtensionState();
  let name = '';
  let project = null;
  let last = null;
  let snapshots = [];

  const ctx = {
    ...base,
    setInput(text, fileName) {
      name = fileName ?? '';
      base.setInput(text);
    },
    name: () => name,
    last: () => last,
    project: () => project,
    setProject(p) { project = p; },
    rulesText: () => ext.rulesText,
    setRulesText: (v) => ext.setRulesText(v),
  };

  const content = h('div', { class: 'pi-body', role: 'tabpanel', tabindex: '0' });
  const nav = h('div', { class: 'pi-nav', role: 'tablist', 'aria-orientation': 'vertical' });
  const title = h('h2', { id: 'pi-title' });
  const close = h('button', { type: 'button', class: 'tiny', 'aria-label': tx('Kapat', 'Close') }, '✕');
  const dialog = h('dialog', { class: 'pi-dialog', 'aria-labelledby': 'pi-title' },
    h('header', { class: 'pi-head' }, title, close), h('div', { class: 'pi-main' }, nav, content));
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  let active = 'compare';
  const open = (id) => {
    active = id;
    const s = SECTIONS.find((x) => x[0] === id);
    title.textContent = `PEEL · ${s[1]()}`;
    for (const b of nav.children) {
      const on = b.dataset.id === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    content.setAttribute('aria-label', s[1]());
    if (id === 'extend') renderExtend(content, ctx, ext);
    else s[2](content, ctx);
  };
  const drawNav = () => {
    nav.replaceChildren(...SECTIONS.map(([id, label]) => {
      const b = h('button', { type: 'button', role: 'tab', 'data-id': id }, label(), id === 'learn' && changelogBadge() ? h('span', { class: 'pi-dot', 'aria-label': tx('yeni', 'new') }) : null);
      b.addEventListener('click', () => open(id));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const i = SECTIONS.findIndex((x) => x[0] === id) + (e.key === 'ArrowDown' ? 1 : -1);
        const next = SECTIONS[(i + SECTIONS.length) % SECTIONS.length][0];
        open(next);
        nav.querySelector(`[data-id="${next}"]`).focus();
      });
      return b;
    }));
  };

  const button = h('button', { type: 'button', id: 'btn-tools', class: 'ghost', 'aria-haspopup': 'dialog' }, tx('Araçlar', 'Tools'));
  button.addEventListener('click', () => {
    drawNav();
    open(active);
    dialog.showModal();
  });
  document.querySelector('.topbar .actions')?.prepend(button);
  document.body.append(dialog);

  // dil değişince düğme ve açık bölme yeniden yazılır
  new MutationObserver(() => {
    button.textContent = tx('Araçlar', 'Tools');
    if (dialog.open) { drawNav(); open(active); }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

  // dosya adı sürüm takibinin anahtarıdır: dosya seçimi ve sürükle-bırak adını yakala
  document.getElementById('file')?.addEventListener('change', (e) => { name = e.target.files?.[0]?.name ?? name; });
  document.addEventListener('drop', (e) => { name = e.dataTransfer?.files?.[0]?.name ?? name; }, true);

  registerServiceWorker();
  loadSharedFragment(ctx);

  return {
    /** deobfuscate'e verilecek eklentiler (kurallar + imzalı eklentiler) */
    plugins: () => ext.plugins(),
    /** onSnapshot: git dışa aktarımı için pass adımları */
    snapshot(s) {
      if (s.id === 'girdi') snapshots = [];
      snapshots.push(s);
    },
    /** Çözüm bitince: geçmişe kaydet, "daha önce görüldü" ve yeni sürüm uyarısı */
    async onResult({ input, output, report = null, stats = null }) {
      last = { input, output, report, stats, snapshots };
      try {
        const r = await recordRun({ input, output, name, stats });
        if (r.warning) base.notify(r.warning, 'warn');
        if (r.change) base.log(`${tx('Önceki sürüme göre', 'Compared to previous version')}:\n${r.change}`, 'info');
      } catch (e) {
        base.log(`history: ${e.message}`, 'warn');
      }
    },
    /** Kullanıcı dosya açtığında adı (sürüm takibi bu adla yapılır) */
    setName(fileName) { name = fileName ?? ''; },
  };
}
