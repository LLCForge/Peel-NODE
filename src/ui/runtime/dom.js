import { t } from '../../i18n.js';

// Çalışma anı arayüz modülleri için küçük DOM yardımcıları. Tüm metinler textContent ile yazılır (rapor verisi
// sandbox'tan gelir: güvenilmez). Uygulamanın mevcut sınıfları kullanılır; yeni stil eklenmez.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}


// metinler src/i18n.js içinde 'rt.' önekiyle
export const tx = (k) => t(`rt.${k}`);

export function section(title, ...body) {
  return el('section', { class: 'rep-section' }, el('h3', {}, title), ...body);
}

export const muted = (text) => el('p', { class: 'rep-muted' }, text);

export function table(headers, rows, classes = [], max = 60) {
  return el('table', { class: 'rep-table' },
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows.slice(0, max).map((r) => el('tr', {}, ...r.map((c, i) => el('td', { class: classes[i] ?? '' }, c instanceof Node ? c : String(c ?? '')))))));
}

export function button(label, onClick) {
  return el('button', { type: 'button', class: 'ghost', onclick: onClick }, label);
}

export function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  el('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
