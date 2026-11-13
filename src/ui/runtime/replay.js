import { el, tx, section, table, button, download } from './dom.js';

// E728 zaman yolculuğu: kaydedilen oturumun adımları arasında kaydırıcıyla gezinme; her adımda etkiler ve
// önceki adıma göre yığın farkı. data = { steps: timeline(session), record, replayResult? }
export function render(root, data, onChange = () => {}) {
  root.textContent = '';
  if (!data?.steps?.length) return;
  const view = el('div');
  const label = el('output', { 'aria-live': 'polite' });
  const slider = el('input', { type: 'range', min: '0', max: String(data.steps.length - 1), value: '0', 'aria-label': tx('step') });
  const show = (i) => {
    const s = data.steps[i];
    label.textContent = `${tx('step')} ${s.step}: ${s.kind} · heap ${s.heapHash}`;
    view.textContent = '';
    const fx = s.effects.map((e) => [e.kind, e.target, e.detail]);
    const diff = [...s.diff.added.map((d) => ['+', d.path, d.value]), ...s.diff.removed.map((d) => ['−', d.path, d.value]), ...s.diff.changed.map((d) => ['~', d.path, `${d.from} → ${d.to}`])];
    view.append(fx.length ? table(['kind', 'target', 'detail'], fx, ['mono', 'mono', 'mono']) : el('p', { class: 'rep-muted' }, '–'),
      diff.length ? table(['', 'path', 'value'], diff, ['', 'mono', 'mono']) : el('p', { class: 'rep-muted' }, 'yığın değişmedi'));
    onChange({ step: i });
  };
  slider.addEventListener('input', () => show(Number(slider.value)));
  const rep = data.replayResult;
  root.append(section(tx('replay'), el('div', { class: 'rep-actions' }, slider, label,
    button(tx('download'), () => download('peel-replay.json', JSON.stringify(data.record)))),
    rep ? el('p', { class: rep.ok ? 'rep-muted' : 'rep-error' }, rep.ok ? `replay: ${rep.results.length} adım birebir aynı` : `replay ${rep.divergedAt}. adımda ayrıştı`) : null,
    view));
  show(0);
}
