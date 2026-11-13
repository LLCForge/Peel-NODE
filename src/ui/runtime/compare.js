import { el, tx, section, muted, table } from './dom.js';

// C47: bot / gerçek kullanıcı profili yan yana karşılaştırma ekranı. data = compareProfiles sonucu.
export function render(root, data) {
  root.textContent = '';
  if (!data) return;
  const [a, b] = data.profiles;
  const rows = [
    ['console', data.a.console.join('\n') || '–', data.b.console.join('\n') || '–'],
    ['network', data.a.network.join('\n') || '–', data.b.network.join('\n') || '–'],
    ['fingerprint', data.a.fingerprint.join(', ') || '–', data.b.fingerprint.join(', ') || '–'],
    ['taint', data.a.taint.join('\n') || '–', data.b.taint.join('\n') || '–'],
    ['error', data.a.error ?? '–', data.b.error ?? '–'],
    ['hash', data.a.hash, data.b.hash],
  ];
  const only = (o) => [...o.console.map((x) => `console: ${x}`), ...o.network.map((x) => `ağ: ${x}`)];
  root.append(section(`${tx('compare')}: ${a} ↔ ${b}`,
    el('p', { class: data.same ? 'rep-muted' : 'rep-error' }, data.same ? 'Davranış iki profilde aynı.' : 'Davranış profile göre değişiyor.'),
    table(['', a, b], rows, ['', 'mono', 'mono']),
    data.same ? null : table([`yalnızca ${a}`, `yalnızca ${b}`], [[only(data.onlyA).join('\n') || '–', only(data.onlyB).join('\n') || '–']], ['mono', 'mono']),
    data.diff.ops.length ? el('details', {}, el('summary', {}, JSON.stringify(data.diff.summary)),
      table(['op', a, b], data.diff.ops.map((o) => [o.op, o.a ? `${o.a.kind} ${o.a.target} ${o.a.detail}` : '', o.b ? `${o.b.kind} ${o.b.target} ${o.b.detail}` : '']), ['', 'mono', 'mono'])) : muted('fark yok')));
}
