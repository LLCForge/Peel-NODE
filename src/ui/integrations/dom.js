import { getLang } from '../../i18n.js';

// Küçük DOM kurucu: içerik her zaman textContent/öznitelik olarak yazılır (innerHTML yok, XSS yüzeyi yok).
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'multiple' || k === 'readOnly') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export const L = () => (getLang() === 'en' ? 'en' : 'tr');
// iki dilli metin: { tr, en } nesnesi ya da (tr, en) çifti
export const tx = (a, b) => (typeof a === 'object' ? a[L()] ?? a.tr : L() === 'en' ? b : a);

export function download(name, data, type) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFiles({ accept = '.js,.mjs,.cjs', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple });
    input.addEventListener('change', () => resolve([...input.files]));
    input.click();
  });
}

export const MAX_FILE = 50 * 1024 * 1024;
export async function readText(file) {
  if (file.size > MAX_FILE) throw new Error(tx('Dosya çok büyük (en fazla 50 MB)', 'File too large (max 50 MB)'));
  return file.text();
}

export const pre = (text, cls = '') => h('pre', { class: `pi-pre ${cls}`.trim() }, text);

/** Bir eylemi meşgul durumu ve hata mesajıyla çalıştırır. */
export async function busy(button, out, fn) {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  out?.replaceChildren();
  try {
    return await fn();
  } catch (e) {
    out?.replaceChildren(h('p', { class: 'pi-err', role: 'alert' }, e.message));
    return undefined;
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

export const field = (label, control, hint) => h('label', { class: 'pi-field' }, h('span', {}, label), control, hint ? h('small', {}, hint) : null);
