import { t, getLang, setLang, LANGS } from '../i18n.js';
import { h, modal } from './dom.js';
import { settings, update, resetSettings } from './settings.js';
import { openShortcuts } from './commands.js';

// Ayarlar penceresi: görünüm, editör, düzen, biçimlendirme, dil, gizlilik.
// Her değişiklik anında uygulanır (onSettings dinleyicileri).

const field = (label, control, hint) => h('label', { class: 'set-row' }, h('span', { class: 'set-label' }, label, hint ? h('small', {}, hint) : null), control);

function select(key, options, { path = null, numeric = false } = {}) {
  const cur = path ? settings()[path][key] : settings()[key];
  const el = h('select', { class: 'field small' }, options.map(([v, label]) => h('option', { value: String(v), selected: String(v) === String(cur) }, label)));
  el.addEventListener('change', () => {
    const v = numeric ? Number(el.value) : el.value;
    update(path ? { [path]: { [key]: v } } : { [key]: v });
  });
  return el;
}
function toggle(key, path = null) {
  const cur = path ? settings()[path][key] : settings()[key];
  const el = h('input', { type: 'checkbox', checked: cur });
  el.addEventListener('change', () => update(path ? { [path]: { [key]: el.checked } } : { [key]: el.checked }));
  return el;
}
function number(key, min, max, path = null) {
  const cur = path ? settings()[path][key] : settings()[key];
  const el = h('input', { class: 'field small num', type: 'number', min: String(min), max: String(max), value: String(cur) });
  el.addEventListener('change', () => {
    const v = Math.max(min, Math.min(max, Number(el.value) || min));
    el.value = String(v);
    update(path ? { [path]: { [key]: v } } : { [key]: v });
  });
  return el;
}

export function openSettings({ onClearSession } = {}) {
  return modal(t('settings.title'), (close) => {
    const hosts = h('ul', { class: 'host-list' });
    const renderHosts = () => {
      const list = settings().approvedHosts;
      hosts.replaceChildren(...list.map((host) => h('li', {}, h('span', { class: 'mono' }, host),
        h('button', { type: 'button', class: 'tiny', 'aria-label': t('settings.hosts.remove', { h: host }), onclick: () => { update({ approvedHosts: settings().approvedHosts.filter((x) => x !== host) }); renderHosts(); } }, '✕'))));
      if (!list.length) hosts.append(h('li', { class: 'rep-muted' }, t('settings.hosts.none')));
    };
    renderHosts();
    const lang = h('select', { class: 'field small' }, LANGS.map(([v, label]) => h('option', { value: v, selected: v === getLang() }, label)));
    lang.addEventListener('change', () => setLang(lang.value));
    const section = (title, ...rows) => h('fieldset', { class: 'set-group' }, h('legend', {}, title), ...rows);
    return h('div', { class: 'dlg-body settings' },
      section(t('settings.appearance'),
        field(t('settings.lang'), lang),
        field(t('settings.theme'), select('theme', [['dark', t('settings.theme.dark')], ['light', t('settings.theme.light')], ['contrast', t('settings.theme.contrast')], ['system', t('settings.theme.system')]])),
        field(t('settings.palette'), select('palette', [['default', t('settings.palette.default')], ['deutan', t('settings.palette.deutan')], ['protan', t('settings.palette.protan')], ['tritan', t('settings.palette.tritan')]]), t('settings.palette.hint')),
        field(t('settings.fontSize'), number('fontSize', 9, 32)),
        field(t('settings.ligatures'), toggle('ligatures'), t('settings.ligatures.hint'))),
      section(t('settings.editor'),
        field(t('settings.wrap'), toggle('wrap')),
        field(t('settings.invisibles'), toggle('invisibles')),
        field(t('settings.hexLines'), toggle('hexLines')),
        field(t('settings.minimap'), toggle('minimap')),
        field(t('settings.indentGuides'), toggle('indentGuides')),
        field(t('settings.activeLine'), toggle('activeLine')),
        field(t('settings.syncScroll'), toggle('syncScroll')),
        field(t('settings.mapToInput'), toggle('mapToInput'), t('settings.mapToInput.hint'))),
      section(t('settings.layers'),
        field(t('settings.scopeColors'), toggle('scopeColors')),
        field(t('settings.deadLayer'), toggle('deadLayer')),
        field(t('settings.trustLayer'), toggle('trustLayer'), t('settings.trustLayer.hint'))),
      section(t('settings.layout'),
        field(t('settings.layout.panes'), select('layout', [[2, t('settings.layout.2')], [3, t('settings.layout.3')], [4, t('settings.layout.4')]], { numeric: true })),
        field(t('settings.reading'), toggle('reading'))),
      section(t('settings.format'),
        field(t('settings.format.printWidth'), number('printWidth', 40, 240, 'format')),
        field(t('settings.format.tabWidth'), number('tabWidth', 1, 8, 'format')),
        field(t('settings.format.semi'), toggle('semi', 'format')),
        field(t('settings.format.singleQuote'), toggle('singleQuote', 'format')),
        field(t('settings.format.bracketSpacing'), toggle('bracketSpacing', 'format')),
        field(t('settings.format.trailingComma'), select('trailingComma', [['all', 'all'], ['es5', 'es5'], ['none', 'none']], { path: 'format' })),
        field(t('settings.format.arrowParens'), select('arrowParens', [['always', 'always'], ['avoid', 'avoid']], { path: 'format' })),
        h('p', { class: 'rep-muted small' }, t('settings.format.hint'))),
      section(t('settings.engine'),
        field(t('settings.autoProfile'), toggle('autoProfile'), t('settings.autoProfile.hint'))),
      section(t('settings.privacy'),
        field(t('settings.persist'), toggle('persist'), t('settings.persist.hint')),
        h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, t('settings.hosts')), hosts),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'ghost small danger', onclick: () => onClearSession?.() }, t('settings.clearSession')))),
      h('div', { class: 'dlg-actions' },
        h('button', { type: 'button', class: 'ghost', onclick: () => { close(); openShortcuts(); } }, t('settings.shortcuts')),
        h('button', { type: 'button', class: 'ghost', onclick: () => { resetSettings(); close(); openSettings({ onClearSession }); } }, t('settings.reset')),
        h('button', { type: 'button', class: 'ghost accent', onclick: () => close() }, t('ui.done'))));
  }, { wide: true });
}
