// VM rapor modüllerinin paylaştığı küçük DOM yardımcıları (uygulamanın mevcut sınıflarını kullanır)

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null && c !== false) node.append(c);
  return node;
}

export function table(headers, rows, classes = []) {
  return el('table', { class: 'rep-table' },
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((c, i) => el('td', { class: classes[i] ?? '' }, c == null ? '–' : String(c)))))));
}

export const pre = (text) => el('pre', { class: 'mono' }, text);

export function details(summary, ...body) {
  return el('details', {}, el('summary', {}, summary), ...body);
}

export function button(label, onClick) {
  return el('button', { type: 'button', class: 'ghost small', onclick: onClick }, label);
}

// Tarayıcıda dosya indir (veri yerelde üretilir)
export function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
