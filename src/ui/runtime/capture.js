import { el, tx, section, muted, table } from './dom.js';

// C53 parmak izi, C54 taint, C55 üretilen kod, C64 WASM, C66 worker, E730 kancalar, E729 etki günlüğü.
export function render(root, dynamic) {
  root.textContent = '';
  const c = dynamic?.capture;
  if (!c?.ok) { root.append(section(tx('runtime'), muted(c?.error ?? tx('noSandbox')))); return; }
  const list = (title, rows) => (rows ? section(title, rows) : null);
  const wasm = [...(c.wasm ?? []).map((w) => ({ ...w, source: 'runtime' })), ...(dynamic.staticWasm ?? [])];
  root.append(...[
    section(tx('taint'), c.taint.length
      ? table(['kaynak', 'çıkış', 'kodlama', 'değer'], c.taint.map((t) => [t.source, t.sink, t.via, t.value]), ['mono', 'mono', '', 'mono'])
      : muted(tx('none'))),
    section(tx('dyncode'), c.dynamicCode.length
      ? el('div', {}, ...c.dynamicCode.slice(0, 30).map((d) => el('details', {}, el('summary', {}, `${d.via} · ${d.length} · ${d.hash}`),
        el('pre', { class: 'mono', style: 'white-space:pre-wrap;max-height:200px;overflow:auto' }, d.code))))
      : muted(tx('none'))),
    section(tx('fp'), c.fingerprint.length
      ? el('div', { class: 'chips' }, ...Object.entries(c.fingerprint.reduce((a, f) => ({ ...a, [f.api]: (a[f.api] ?? 0) + 1 }), {})).map(([k, n]) => el('span', { class: 'chip' }, k, el('b', {}, String(n)))))
      : muted(tx('none'))),
    section(tx('wasm'), wasm.length
      ? el('div', {}, ...wasm.map((w) => el('div', {},
        el('p', {}, `${w.source ?? 'runtime'} · ${w.size ?? '?'} B${w.error ? ` · ${w.error}` : ''}`),
        w.imports?.length ? table(['import', 'kind', 'signature'], w.imports.map((i) => [`${i.module}.${i.name}`, i.kind, i.signature ?? '']), ['mono', '', 'mono']) : null,
        w.exports?.length ? table(['export', 'kind', 'signature'], w.exports.map((x) => [x.name, x.kind, x.signature ?? '']), ['mono', '', 'mono']) : null,
        w.calls?.length ? muted(`çağrılar: ${w.calls.map((k) => `${k.name}(${k.args.join(', ')})`).join('; ')}`) : null)))
      : muted(tx('none'))),
    section(tx('workers'), c.workers.length
      ? el('div', {}, ...c.workers.map((w) => el('details', {}, el('summary', {}, `${w.kind} ${w.url.slice(0, 80)} · ${w.skipped ?? `${w.rounds?.length ?? 0} tur`}`),
        w.code ? el('pre', { class: 'mono', style: 'white-space:pre-wrap;max-height:160px;overflow:auto' }, w.code) : null,
        w.rounds?.length ? table(['gelen', 'yanıt', 'örnek'], w.rounds.map((r) => [r.received, r.replied, r.replies.slice(0, 3).join(' | ')]), ['num', 'num', 'mono']) : null,
        w.net?.length ? muted(`ağ: ${w.net.map((n) => `${n.api} ${n.url}`).join(', ')}`) : null,
        w.out?.length ? muted(`console: ${w.out.join(' | ')}`) : null)))
      : muted(tx('none'))),
    list(tx('hooks'), c.hooks.length ? table(['', 'path', ''], c.hooks.map((h) => [h.kind, h.path, h.value ?? (h.args ?? []).join(', ')]), ['', 'mono', 'mono']) : null),
    section(tx('effects'), c.effects.length
      ? el('details', {}, el('summary', {}, `${c.effects.length}`),
        table(['#', 'kind', 'target', 'detail'], c.effects.map((e) => [e.seq, e.kind, e.target, e.detail]), ['num', 'mono', 'mono', 'mono'], 300))
      : muted(tx('none'))),
  ].filter(Boolean));
}
