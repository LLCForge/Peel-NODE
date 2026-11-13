import { el, tx, section, muted, table, kb } from './dom.js';
import { failureMarkdown } from '../../verify/failure.js';

// I176 güven skoru, I181 pass risk rozetleri, I184 başarı metriği, E719–E723 denetimler, E721 başarısız kanıt,
// E718 gerekçeler, I188 bellek göstergesi, E749 telemetri.

const RISK_CLASS = { high: 'risk-high', medium: 'risk-medium', low: 'risk-low' };

export function memoryMeter(mem) {
  if (!mem) return muted(tx('none'));
  const pct = Math.min(100, (mem.used / mem.limit) * 100);
  const bar = el('i');
  bar.style.width = `${Math.max(1, pct)}%`;
  return el('div', { class: 'bars' }, el('div', { class: 'bar', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(mem.limit), 'aria-valuenow': String(mem.used), 'aria-label': tx('memoryUse') },
    el('span', {}, tx('memoryUse')), el('span', {}, bar), el('span', {}, `${kb(mem.used)} / ${kb(mem.limit)} (%${pct.toFixed(1)})`)));
}

function checkRows(v) {
  const c = v?.checks ?? {};
  const st = (ok) => (ok === true ? tx('passed') : ok === false ? tx('failed') : '–');
  const rows = [];
  if (c.trace) rows.push(['iz denkliği (E708)', st(c.trace.equivalent), c.trace.equivalent ? `${c.trace.length ?? 0}` : `#${c.trace.index}`]);
  if (c.effects) rows.push(['etki farkı (E715)', st(c.effects.equal), JSON.stringify(c.effects.summary)]);
  if (c.bisimulation) rows.push(['bisimülasyon (E707)', st(c.bisimulation.bisimilar), c.bisimulation.brokenAt ?? `${c.bisimulation.steps.length} adım`]);
  if (c.determinism) rows.push(['determinizm (E709)', st(c.determinism.deterministic), [c.determinism.dependsOnTime && 'zamana bağlı', c.determinism.dependsOnRandom && 'rastgeleliğe bağlı'].filter(Boolean).join(', ') || '–']);
  if (c.functions) rows.push(['fonksiyon denkliği (I179/E701)', st(c.functions.differs === 0), `${c.functions.tested} test, ${c.functions.proved} kanıt, ${c.functions.differs} farklı`]);
  if (c.fuzz) rows.push(['diferansiyel fuzz (I178)', st(c.fuzz.equivalent), `${c.fuzz.iterations} ortam, ${c.fuzz.crashes.length} çökme sınıfı`]);
  if (c.mutation) rows.push([tx('mutation'), c.mutation.score == null ? '–' : `%${Math.round(c.mutation.score * 100)}`, `${c.mutation.killed}/${c.mutation.mutants}`]);
  for (const s of v?.skipped ?? []) rows.push([s.check, tx('skipped'), s.reason]);
  for (const e of v?.errors ?? []) rows.push([e.check, tx('failed'), e.error]);
  return rows;
}

export function render(root, report) {
  root.textContent = '';
  const v = report?.verification;
  if (!v) return;
  const trust = el('div', { class: `risk ${RISK_CLASS[v.trust.level] ?? ''}` }, el('b', {}, String(v.trust.score)), el('span', {}, `${tx('trust')} · ${tx('level')}: ${v.level}`));
  const badges = v.passRisk.length
    ? el('div', { class: 'chips' }, ...v.passRisk.map((p) => el('span', { class: `chip ${RISK_CLASS[p.risk]}`, title: p.reasons.join(' · ') }, p.id, el('b', {}, p.risk))))
    : muted(tx('none'));
  const success = table(['', 'önce', 'sonra', ''], v.success.parts.map((p) => [p.label, p.before ?? '–', p.after, `%${Math.round(p.score * 100)}`]), ['', 'num', 'num', 'num']);
  const ver = v.verification;
  const checks = ver ? table(['', '', ''], checkRows(ver), ['', '', 'rep-muted']) : muted(tx('skipped'));
  const plan = ver?.plan ? muted(`${ver.plan.start} → ${ver.plan.target}${ver.plan.reasons.length ? ` (${ver.plan.reasons.join(', ')})` : ''} · ${tx('budget')}: ${ver.budget?.elapsedMs ?? 0} ${tx('ms')}, ${ver.budget?.runs ?? 0} run`) : null;
  const failure = ver?.failure && !ver.failure.ok
    ? el('pre', { class: 'mono', style: 'white-space:pre-wrap;max-height:260px;overflow:auto' }, failureMarkdown(ver.failure)) : null;
  const rationale = v.rationale.length
    ? table(['pass', '#', '', ''], v.rationale.map((r) => [r.pass, r.round, r.accepted ? '✓' : '✗', r.why]), ['mono', 'num', '', 'rep-muted'])
    : muted(tx('none'));
  const d = report.dynamic;
  const tel = d?.telemetry;
  const telemetry = tel ? table(['', 'n', tx('ms'), tx('failed')], Object.entries(tel.messages).map(([k, m]) => [k, m.count, m.ms, m.failed]), ['mono', 'num', 'num', 'num']) : null;
  root.append(section(tx('trust'), trust, el('ul', {}, ...v.trust.reasons.map((r) => el('li', {}, r)))),
    section(tx('passRisk'), badges),
    section(`${tx('success')}: ${v.success.score}`, success),
    section(tx('checks'), plan, checks, failure ? el('h4', {}, tx('failure')) : null, failure),
    section(tx('rationale'), rationale),
    section(tx('memoryUse'), memoryMeter(d?.capture?.mem ?? d?.coverage?.mem ?? null),
      tel ? muted(`peak ${kb(tel.peakMemory)} · interrupts ${tel.interrupts} · leaked ${tel.leaked} · contexts ${tel.contexts}`) : null,
      tel ? el('h4', {}, tx('telemetry')) : null, telemetry));
}
