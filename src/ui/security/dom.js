// Güvenlik paneli için küçük DOM yardımcıları (rapordaki sınıfları kullanır, yeni görünüm tanımlamaz)
import { getLang } from '../../i18n.js';

const MAX_ROWS = 60;

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

export const muted = (text) => el('p', { class: 'rep-muted' }, text);
export const h4 = (text) => el('h4', {}, text);

export function table(headers, rows, classes = []) {
  if (!rows.length) return null;
  return el('table', { class: 'rep-table' },
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { scope: 'col' }, h)))),
    el('tbody', {}, ...rows.slice(0, MAX_ROWS).map((r) => el('tr', {}, ...r.map((c, i) => el('td', { class: classes[i] ?? '' }, String(c ?? '–')))))));
}

export function button(label, onclick, cls = 'ghost') {
  return el('button', { type: 'button', class: cls, onclick }, label);
}

export const chips = (list) => (list.length ? el('div', { class: 'chips' }, ...list.map((x) => el('span', { class: 'chip' }, x))) : null);

export function section(title, ...body) {
  return el('section', { class: 'rep-section' }, el('h3', {}, title), ...body);
}

// Katlanabilir araç bölümü (yerel <details>: klavye ve ekran okuyucu desteği hazır)
export function tool(title, ...body) {
  return el('details', { class: 'sec-tool' }, el('summary', {}, title), el('div', { class: 'sec-body' }, ...body));
}

export function field(label, input) {
  const id = `sec-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return el('label', { class: 'sec-field', for: id }, el('span', {}, label), input);
}

export const status = () => el('p', { class: 'rep-muted sec-status', role: 'status', 'aria-live': 'polite' });

// Basit iki dilli metin: güvenlik modülü kendi sözlüğünü taşır (paylaşılan i18n dosyasını büyütmemek için)
export function tr(trText, enText) {
  return getLang() === 'en' ? enText : trText;
}
