import { PROFILES } from '../../core/threat.js';
import { VERIFY_LEVELS, LIMITS, validateSettings, defaultSettings } from '../../sandbox/settings.js';
import { el, tx, section, button } from './dom.js';

// C46/C50/C67/C70 + E720: sandbox ayar formu. onChange doğrulanmış ayarları alır (kaydetme çağıranın işi).
export function render(root, data, onChange) {
  root.textContent = '';
  const s = data ?? defaultSettings();
  const id = (k) => `peel-rt-${k}`;
  const field = (k, label, input) => el('div', { class: 'rt-field' }, el('label', { for: id(k) }, label), input);
  const toLocal = (ms) => (ms == null ? '' : new Date(ms).toISOString().slice(0, 19));
  const inputs = {
    profile: el('select', { id: id('profile') }, ...['default', ...Object.keys(PROFILES)].map((p) => el('option', { value: p, selected: p === s.profile }, p))),
    now: el('input', { id: id('now'), type: 'datetime-local', step: '1', value: toLocal(s.now) }),
    seed: el('input', { id: id('seed'), type: 'number', min: '0', max: String(0x7fffffff), value: s.seed ?? '', placeholder: '12345' }),
    cookie: el('input', { id: id('cookie'), type: 'text', value: s.cookie, spellcheck: 'false', autocomplete: 'off' }),
    storage: el('textarea', { id: id('storage'), rows: '3', spellcheck: 'false', class: 'mono' }),
    responses: el('textarea', { id: id('responses'), rows: '3', spellcheck: 'false', class: 'mono' }),
    memoryMB: el('input', { id: id('memoryMB'), type: 'number', min: String(LIMITS.memoryMB[0]), max: String(LIMITS.memoryMB[1]), value: s.memoryMB ?? '', placeholder: tx('engineDefault') }),
    timeoutMs: el('input', { id: id('timeoutMs'), type: 'number', min: String(LIMITS.timeoutMs[0]), max: String(LIMITS.timeoutMs[1]), step: '100', value: s.timeoutMs ?? '', placeholder: tx('engineDefault') }),
    verifyLevel: el('select', { id: id('verifyLevel') }, ...VERIFY_LEVELS.map((l) => el('option', { value: l, selected: l === s.verifyLevel }, l))),
    watch: el('input', { id: id('watch'), type: 'text', value: s.watch.join(', '), spellcheck: 'false' }),
  };
  inputs.storage.value = JSON.stringify(s.storage);
  inputs.responses.value = JSON.stringify(s.responses);
  const status = el('p', { class: 'rep-muted', role: 'status', 'aria-live': 'polite' });
  const num = (v) => (v === '' ? null : Number(v));
  const json = (v, key, fallback) => {
    try { return v.trim() ? JSON.parse(v) : fallback; } catch { throw new Error(`${tx('invalid')}: ${key}`); }
  };
  const collect = () => ({
    profile: inputs.profile.value,
    now: inputs.now.value ? `${inputs.now.value}Z` : null,
    seed: num(inputs.seed.value),
    cookie: inputs.cookie.value,
    storage: json(inputs.storage.value, tx('storage'), {}),
    responses: json(inputs.responses.value, tx('responses'), []),
    memoryMB: num(inputs.memoryMB.value),
    timeoutMs: num(inputs.timeoutMs.value),
    verifyLevel: inputs.verifyLevel.value,
    watch: inputs.watch.value.split(',').map((x) => x.trim()).filter(Boolean),
  });
  const save = () => {
    try {
      const { settings, errors } = validateSettings(collect());
      if (errors.length) { status.textContent = `${tx('invalid')}: ${errors.join(', ')}`; return; }
      onChange(settings);
      status.textContent = tx('saved');
    } catch (e) {
      status.textContent = e.message;
    }
  };
  const form = el('form', { class: 'rt-settings', onsubmit: (e) => { e.preventDefault(); save(); } },
    field('profile', tx('profile'), inputs.profile),
    field('now', tx('now'), inputs.now),
    field('seed', tx('seed'), inputs.seed),
    field('cookie', tx('cookie'), inputs.cookie),
    field('storage', tx('storage'), inputs.storage),
    field('responses', tx('responses'), inputs.responses),
    field('memoryMB', tx('memory'), inputs.memoryMB),
    field('timeoutMs', tx('timeout'), inputs.timeoutMs),
    field('verifyLevel', tx('verifyLevel'), inputs.verifyLevel),
    field('watch', tx('watch'), inputs.watch),
    el('div', { class: 'rep-actions' }, el('button', { type: 'submit', class: 'ghost' }, tx('save')),
      button(tx('reset'), () => { onChange(defaultSettings()); render(root, defaultSettings(), onChange); })),
    status);
  root.append(section(tx('settings'), form));
  return form;
}
