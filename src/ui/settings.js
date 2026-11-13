// Kullanıcı tercihleri. Tarayıcıda (localStorage) kişisel kolaylık olarak saklanır; kod içermez.
// Okuma her zaman doğrulanır: bozuk ya da elle değiştirilmiş kayıt varsayılanlara döner.

const KEY = 'peel.settings';

export const DEFAULTS = Object.freeze({
  theme: 'dark', // dark | light | contrast | system
  palette: 'default', // default | deutan | protan | tritan
  fontSize: 13,
  wrap: false,
  invisibles: false,
  hexLines: false,
  ligatures: false,
  minimap: true,
  indentGuides: true,
  activeLine: true,
  syncScroll: false,
  mapToInput: true,
  autoProfile: false,
  layout: 2, // 2 | 3 | 4
  split: 50,
  reading: false,
  persist: true,
  scopeColors: false,
  deadLayer: false,
  trustLayer: false,
  format: { printWidth: 100, tabWidth: 2, useTabs: false, semi: true, singleQuote: false, trailingComma: 'all', bracketSpacing: true, arrowParens: 'always' },
  passOrder: [],
  passDisabled: [],
  keymap: {},
  approvedHosts: [],
});

const ENUMS = {
  theme: ['dark', 'light', 'contrast', 'system'],
  palette: ['default', 'deutan', 'protan', 'tritan'],
  layout: [2, 3, 4],
};
const FORMAT_ENUMS = { trailingComma: ['all', 'es5', 'none'], arrowParens: ['always', 'avoid'] };

const clampNum = (v, lo, hi, d) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
const strList = (v, max = 200) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= 300).slice(0, max) : []);

/** Güvenilmez nesneyi geçerli ayarlara çevirir (oturum içe aktarmada da kullanılır) */
export function sanitize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const s = structuredClone(DEFAULTS);
  for (const [k, d] of Object.entries(DEFAULTS)) {
    const v = o[k];
    if (ENUMS[k]) { if (ENUMS[k].includes(v)) s[k] = v; } else if (typeof d === 'boolean') { if (typeof v === 'boolean') s[k] = v; }
  }
  s.fontSize = clampNum(o.fontSize, 9, 32, DEFAULTS.fontSize);
  s.split = clampNum(o.split, 20, 80, DEFAULTS.split);
  const f = o.format && typeof o.format === 'object' ? o.format : {};
  s.format.printWidth = clampNum(f.printWidth, 40, 240, DEFAULTS.format.printWidth);
  s.format.tabWidth = clampNum(f.tabWidth, 1, 8, DEFAULTS.format.tabWidth);
  for (const k of ['semi', 'singleQuote', 'bracketSpacing', 'useTabs']) if (typeof f[k] === 'boolean') s.format[k] = f[k];
  for (const [k, allowed] of Object.entries(FORMAT_ENUMS)) if (allowed.includes(f[k])) s.format[k] = f[k];
  s.passOrder = strList(o.passOrder);
  s.passDisabled = strList(o.passDisabled);
  s.approvedHosts = strList(o.approvedHosts).filter((h) => /^[a-z0-9.-]+(:\d+)?$/i.test(h));
  if (o.keymap && typeof o.keymap === 'object') {
    for (const [cmd, key] of Object.entries(o.keymap)) {
      if (typeof cmd === 'string' && cmd.length <= 60 && (typeof key === 'string' && key.length <= 40 || key === null)) s.keymap[cmd] = key;
    }
  }
  return s;
}

let current = (() => {
  try { return sanitize(JSON.parse(localStorage.getItem(KEY) ?? 'null')); } catch { return structuredClone(DEFAULTS); }
})();
const listeners = new Set();

export const settings = () => current;

export function update(patch) {
  current = sanitize({ ...current, ...patch, format: { ...current.format, ...(patch.format ?? {}) } });
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* depolama kapalı */ }
  for (const fn of listeners) fn(current, patch);
  return current;
}

export function onSettings(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function resetSettings() { return update(structuredClone(DEFAULTS)); }
