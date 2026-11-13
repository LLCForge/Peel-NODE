import { el, tx, section, muted, table, button, download } from './dom.js';
import { render as renderCompare } from './compare.js';
import { render as renderReplay } from './replay.js';
import { PROFILES } from '../../core/threat.js';
import { getSettings } from '../../sandbox/settings.js';

// İsteğe bağlı çalışma anı / doğrulama araçları. Ağır modüller ilk kullanımda yüklenir.
// ctx = { sandbox, report, text, output, deobfuscate? }

function runner(out, label, fn) {
  return button(label, async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.setAttribute('aria-busy', 'true');
    out.textContent = '';
    out.append(muted(tx('running')));
    try {
      out.textContent = '';
      await fn(out);
    } catch (err) {
      out.textContent = '';
      out.append(el('p', { class: 'rep-error' }, String(err?.message ?? err)));
    } finally {
      b.disabled = false;
      b.removeAttribute('aria-busy');
    }
  });
}

export function render(root, ctx) {
  root.textContent = '';
  const { sandbox, report, text, output } = ctx;
  if (!sandbox || text == null) { root.append(section(tx('tools'), muted(tx('noSandbox')))); return; }
  const out = el('div', { 'aria-live': 'polite' });
  const profiles = ['default', ...Object.keys(PROFILES)];
  const pick = (v) => el('select', { 'aria-label': tx('profile') }, ...profiles.map((p) => el('option', { value: p, selected: p === v }, p)));
  const pa = pick('chrome-win');
  const pb = pick('headless-bot');
  const consent = el('input', { type: 'checkbox', id: 'peel-rt-consent' });

  const tools = [
    el('span', {}, pa, ' ↔ ', pb, ' ', runner(out, tx('compare'), async (o) => {
      const { compareProfiles } = await import('../../sandbox/compare.js');
      renderCompare(o, await compareProfiles(sandbox, text, pa.value, pb.value));
    })),
    el('span', {}, consent, el('label', { for: 'peel-rt-consent' }, tx('consent')), ' ',
      runner(out, tx('realdom'), async (o) => {
        if (!consent.checked) throw new Error(tx('consent'));
        const { runRealDom } = await import('../../sandbox/realdom.js');
        const frameBox = el('div');
        o.append(frameBox);
        const r = await runRealDom(output, { consent: true, container: frameBox });
        consent.checked = false; // onay her çalıştırma için ayrı
        o.append(section(tx('realdom'),
          r.ok ? null : el('p', { class: 'rep-error' }, r.error),
          r.navigationBlocked.length ? el('p', { class: 'rep-error' }, `engellenen yönlendirme: ${r.navigationBlocked.map((v) => v.uri).join(', ')}`) : null,
          table(['console'], r.console.map((c) => [c]), ['mono']),
          r.errors.length ? table(['error'], r.errors.map((c) => [c]), ['mono']) : null,
          table(['engellenen', 'uri'], r.blocked.map((b) => [b.directive, b.uri]), ['', 'mono']),
          muted(`DOM değişikliği: ${r.mutations} · engellenen çerçeve: ${r.frames} · dinleyiciler: ${JSON.stringify(r.listeners)}`),
          el('details', {}, el('summary', {}, 'DOM'), el('pre', { class: 'mono', style: 'white-space:pre-wrap;max-height:240px;overflow:auto' }, r.dom))));
      })),
    runner(out, tx('fuzz'), async (o) => {
      const { differentialFuzz } = await import('../../verify/fuzz.js');
      const r = await differentialFuzz(sandbox, text, output, { iterations: 24 });
      o.append(section(tx('fuzz'),
        el('p', { class: r.equivalent ? 'rep-muted' : 'rep-error' }, `${r.iterations} ortam, ${r.runs} çalıştırma, ${r.divergences.length} ayrışma`),
        r.coverage ? muted(`coverage: ${r.coverage.covered}/${r.coverage.statements} · korpus ${r.corpus}`) : null,
        r.divergences.length ? el('pre', { class: 'mono', style: 'white-space:pre-wrap' }, JSON.stringify({ ortam: r.divergences[0].minimized ?? r.divergences[0].env, fark: r.divergences[0].diff.ops.slice(0, 8) }, null, 1)) : null,
        r.crashes.length ? table(['taraf', 'imza', 'n'], r.crashes.map((c) => [c.side, c.signature, c.count]), ['', 'mono', 'num']) : null));
    }),
    runner(out, tx('equiv'), async (o) => {
      const { functionEquivalence } = await import('../../verify/equiv.js');
      const r = await functionEquivalence(sandbox, text, output, { smt: true });
      o.append(section(tx('equiv'), r.note ? muted(r.note) : table(['girdi', 'çıktı', 'eşleşme', 'durum', 'örnek', 'karşı örnek'],
        r.pairs.map((p) => [p.a, p.b, p.by, p.status, p.samples ?? '', p.minimized ? JSON.stringify(p.minimized) : p.proof?.backend ?? '']), ['mono', 'mono', '', '', 'num', 'mono'])));
    }),
    runner(out, tx('determinism'), async (o) => {
      const [{ executionDeterminism, pipelineDeterminism, idempotence }, { deobfuscate }] = await Promise.all([import('../../verify/determinism.js'), import('../../core/pipeline.js')]);
      const ex = await executionDeterminism(sandbox, output);
      const opts = { level: 4, sandbox, deep: true };
      const pd = await pipelineDeterminism(deobfuscate, ctx.input ?? text, opts);
      const id = await idempotence(deobfuscate, output, opts);
      o.append(section(tx('determinism'), table(['', '', ''], [
        ['çalıştırma (E709)', ex.deterministic ? tx('passed') : tx('failed'), [ex.dependsOnTime && 'zamana bağlı', ex.dependsOnRandom && 'rastgeleliğe bağlı'].filter(Boolean).join(', ') || '–'],
        ['deobfuscation (I186)', pd.reproducible ? tx('passed') : tx('failed'), `SHA-256 ${pd.sha256}`],
        ['idempotans (E710)', id.idempotent ? tx('passed') : tx('failed'), id.idempotent ? '–' : `${id.changedLines} satır; ${id.passes.join(', ')}`],
      ], ['', '', 'mono'])));
    }),
    runner(out, tx('replay'), async (o) => {
      const { recordDefault, timeline, replay, snapshot, closeSession } = await import('../../sandbox/replay.js');
      const s = await recordDefault(sandbox, output, { config: (await import('../../sandbox/dynamic.js')).analysisConfig() });
      const steps = timeline(s);
      const snap = snapshot(s);
      await closeSession(s);
      const rep = await replay(sandbox, s.record);
      const box = el('div');
      o.append(box, el('div', { class: 'rep-actions' }, button('snapshot', () => download('peel-snapshot.json', JSON.stringify(snap)))));
      renderReplay(box, { steps, record: s.record, replayResult: rep });
    }),
    runner(out, tx('patch'), async (o) => {
      // E716: önce => sonra çiftlerinden genelleştirilmiş yeniden yazma kuralı; doğrulanır, istenirse çıktıya uygulanır
      const { synthesizeRule, validateRule, applyRule } = await import('../../verify/patch.js');
      const area = el('textarea', { rows: '4', class: 'mono', style: 'width:100%', 'aria-label': tx('patchHelp'), placeholder: 'x ^ 5 ^ 5 => x\ny ^ 9 ^ 9 => y' });
      const res = el('div', { 'aria-live': 'polite' });
      const learn = async () => {
        res.textContent = '';
        const pairs = area.value.split('\n').map((l) => l.split('=>')).filter((p) => p.length === 2 && p[0].trim() && p[1].trim())
          .slice(0, 50).map(([before, after]) => ({ before: before.trim(), after: after.trim() }));
        const rule = synthesizeRule(pairs);
        if (rule.error) { res.append(el('p', { class: 'rep-error' }, rule.error)); return; }
        const v = await validateRule(rule, { evaluate: async (list) => (await sandbox.batch(list)).results });
        res.append(table(['kalıp', 'yerine', 'doğrulama'], [[rule.pattern, rule.replacement, `${v.valid === true ? tx('passed') : v.valid === false ? tx('failed') : '–'} (${v.method}${v.reason ? `: ${v.reason}` : ''})`]], ['mono', 'mono', '']),
          v.counterexample ? muted(`karşı örnek: ${JSON.stringify(v.counterexample)}`) : null);
        if (v.valid !== true) return;
        res.append(button(tx('apply'), () => {
          const r = applyRule(output, rule);
          res.append(muted(`${r.count} yer değişti`));
          if (r.count) download('peeled.patched.js', r.code, 'text/javascript');
        }));
      };
      o.append(section(tx('patch'), muted(tx('patchHelp')), area, el('div', { class: 'rep-actions' }, button(tx('patch'), learn)), res));
    }),
    runner(out, tx('escape'), async (o) => {
      const { runEscapeSuite } = await import('../../verify/escape.js');
      const r = await runEscapeSuite(sandbox);
      o.append(section(`${tx('escape')}: ${r.passed}/${r.total}`, table(['', '', tx('ms')], r.results.map((x) => [x.title, x.pass ? tx('passed') : tx('failed'), x.ms]), ['', '', 'num']),
        r.skipped ? muted(`${r.skipped} ${tx('skipped')}`) : null));
    }),
    runner(out, tx('issue'), async (o) => {
      const { issueTemplate } = await import('../../verify/template.js');
      const include = el('input', { type: 'checkbox', id: 'peel-rt-inc' });
      const area = el('textarea', { rows: '14', class: 'mono', style: 'width:100%', 'aria-label': tx('issue') });
      const fill = () => { area.value = issueTemplate({ report, settings: getSettings(), input: text, output, includeCode: include.checked }); };
      include.addEventListener('change', fill);
      fill();
      o.append(section(tx('issue'), el('label', {}, include, ' ', tx('includeCode')), area, el('div', { class: 'rep-actions' },
        button(tx('copy'), () => navigator.clipboard?.writeText(area.value)),
        button(tx('download'), () => download('peel-issue.md', area.value, 'text/markdown')))));
    }),
    runner(out, tx('proof'), async (o) => {
      const [{ buildBundle, signBundle }, { semanticHash }] = await Promise.all([import('../../verify/proof.js'), import('../../verify/effects.js')]);
      const wrap = (c) => `try {\n${c}\n} catch (e) { __res.push({ __thrown: String(e) }); }`;
      const h = async (c) => { const r = await sandbox.run(wrap(c), { timeoutMs: 6000 }); return semanticHash(r.effects ?? [], (r.res ?? []).filter((x) => x?.__thrown).map((x) => x.__thrown)); };
      const [hi, ho] = [await h(text), await h(output)];
      const bundle = await buildBundle({ input: text, output, events: (report?.verification?.rationale ?? []).map((r) => ({ id: r.pass, round: r.round, state: r.accepted ? 'ok' : 'fail', reason: r.accepted ? null : r.why })), semantic: { input: hi, output: ho, equal: hi === ho }, verification: report?.verification ?? null });
      const signed = await signBundle(bundle);
      download('peel-proof.json', JSON.stringify(signed, null, 2));
      o.append(muted(`${tx('proof')}: SHA-256 ${bundle.claims.outputSha256} · semantik ${hi === ho ? '=' : '≠'}`));
    }),
    runner(out, tx('signedReport'), async (o) => {
      const { signReport } = await import('../../verify/proof.js');
      const signed = await signReport(JSON.parse(JSON.stringify(report)));
      download('peel-report.signed.json', JSON.stringify(signed, null, 2));
      o.append(muted(`${tx('signedReport')}: ES256`));
    }),
  ];
  root.append(section(tx('tools'), el('div', { class: 'rep-actions', style: 'flex-wrap:wrap' }, ...tools), out));
}
