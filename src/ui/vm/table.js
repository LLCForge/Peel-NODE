import { el } from './dom.js';

// Geçiş tablosunda arama (madde 42): serbest metin ya da alan sorgusu (from:3 to:ÇIKIŞ cond:x>2 kaynak:statik)

const FIELDS = { from: 'from', to: 'to', cond: 'cond', kaynak: 'sources', source: 'sources' };

export function matches(row, query) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  return terms.every((term) => {
    const m = term.match(/^(\w+):(.*)$/);
    if (m && FIELDS[m[1]]) {
      const v = row[FIELDS[m[1]]];
      const text = Array.isArray(v) ? v.join(' ') : String(v ?? '');
      return m[1] === 'from' || m[1] === 'to' ? text === m[2] : text.toLowerCase().includes(m[2].toLowerCase());
    }
    const all = `${row.from} ${row.to} ${row.cond ?? ''} ${(row.sources ?? []).join(' ')}`.toLowerCase();
    return all.includes(term.toLowerCase());
  });
}

export function renderTransitionTable(root, data) {
  root.textContent = '';
  const rows = data.edges ?? [];
  const input = el('input', { type: 'search', placeholder: 'ara: 3  ya da  from:3 to:ÇIKIŞ cond:x kaynak:zorlanmış', 'aria-label': 'Geçiş tablosunda ara' });
  input.style.width = '100%';
  input.style.margin = '0 0 8px';
  const count = el('p', { class: 'rep-muted' });
  const body = el('tbody');
  const draw = () => {
    body.textContent = '';
    const hit = rows.filter((r) => matches(r, input.value));
    count.textContent = `${hit.length} / ${rows.length} geçiş`;
    for (const r of hit.slice(0, 500)) {
      body.append(el('tr', {},
        el('td', { class: 'mono' }, String(r.from)),
        el('td', { class: 'mono' }, String(r.to)),
        el('td', { class: 'mono' }, r.cond ?? '–'),
        el('td', { class: 'rep-muted' }, (r.sources ?? []).join(', ') || '–'),
        el('td', { class: 'num' }, r.count ? String(r.count) : '')));
    }
  };
  input.addEventListener('input', draw);
  root.append(input, count, el('table', { class: 'rep-table' },
    el('thead', {}, el('tr', {}, ...['Kaynak durum', 'Hedef', 'Koşul', 'Bulunduğu yer', '#'].map((h) => el('th', {}, h)))), body));
  draw();
}
