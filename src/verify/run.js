import { createBudget, tightenPlan, levelIndex } from './budget.js';
import { effectDiff } from './effects.js';
import { bisimulate } from './bisim.js';
import { executionDeterminism } from './determinism.js';
import { functionEquivalence } from './equiv.js';
import { differentialFuzz, mutationScore } from './fuzz.js';
import { failureReport } from './failure.js';
import { trustScore, passRisk, successMetric, observedRanges } from './trust.js';
import { rationaleLog } from './rationale.js';
import { analysisConfig, dynamicReport } from '../sandbox/dynamic.js';
import { getSettings } from '../sandbox/settings.js';

// E719/E720/E723: doğrulama orkestrasyonu. İstenen seviyeden başlanır; risk sinyali (geri alma, gözleme dayalı
// dönüşüm, düşük coverage, etki ayrışması) oldukça seviye kademeli yükseltilir; tüm denetimler bütçe içinde kalır,
// bütçe biterse kalan denetimler "atlandı (bütçe)" olarak raporlanır.

export async function runVerification({ sandbox, text, output, events = [], level = 'effects', coverage = null, budget = null, config = null, verified = true }) {
  const b = budget ?? createBudget({ ms: 15000, runs: 120, solverMs: 6000 });
  const cfg = config ?? analysisConfig();
  const checks = {};
  const skipped = [];
  const errors = [];
  const signals = {
    rollbacks: events.filter((e) => e.state === 'fail').length,
    unverified: !verified,
    observation: events.filter((e) => e.state === 'ok' && e.observation).length,
    coverage: coverage?.ok ? coverage.ratio : null,
    divergence: false,
  };
  let plan = tightenPlan(level, signals);
  const done = new Set();
  const run = async (name, fn) => {
    if (done.has(name)) return;
    done.add(name);
    if (b.exhausted()) { skipped.push({ check: name, reason: 'bütçe' }); return; }
    try { checks[name] = await fn(); } catch (e) { errors.push({ check: name, error: e.message }); }
  };
  if (sandbox && levelIndex(level) >= levelIndex('behaviour')) {
    for (let i = 0; i < plan.steps.length; i++) {
      for (const c of plan.steps[i].checks) {
        if (c === 'trace' || c === 'effects') {
          await run('effects', async () => {
            b.charge({ runs: 2 });
            const d = await effectDiff(sandbox, text, output, { config: cfg });
            checks.trace = d.trace;
            return { equal: d.diff.equal, summary: d.diff.summary, ops: d.diff.ops.slice(0, 50), a: d.a, b: d.b };
          });
          // E723: ayrışma görülürse plan yeniden kurulur (bir üst seviyeye çıkılır)
          if (checks.effects && !checks.effects.equal && !signals.divergence) {
            signals.divergence = true;
            plan = tightenPlan(level, signals);
          }
        }
        if (c === 'bisimulation') await run('bisimulation', () => bisimulate(sandbox, text, output, { config: cfg, budget: b }));
        if (c === 'determinism') await run('determinism', () => executionDeterminism(sandbox, output, { config: cfg, budget: b }));
        if (c === 'functions' || c === 'smt') {
          await run('functions', () => functionEquivalence(sandbox, text, output, { budget: b, smt: levelIndex(plan.target) >= levelIndex('proof') }));
        }
        if (c === 'fuzz') await run('fuzz', () => differentialFuzz(sandbox, text, output, { iterations: 12, budget: b }));
        if (c === 'mutation') await run('mutation', () => mutationScore(sandbox, output, { count: 6, budget: b }));
      }
    }
  }
  const result = { level, plan, checks, skipped, errors, budget: b.report() };
  result.failure = failureReport(result, events);
  return result;
}

// Analiz raporuna giren doğrulama özeti: güven, pass riski, başarı metriği, gerekçeler, gözlem konumları
export function verificationSummary({ input, text, output, events, metrics, coverage, verification, verifyLevel }) {
  return {
    level: verifyLevel,
    trust: trustScore({ verifyLevel, events, metrics, coverage, verification }),
    passRisk: passRisk(events, { verified: verifyLevel !== 'parse' }),
    success: successMetric(metrics),
    rationale: rationaleLog(events),
    observed: observedRanges(output, events, text ?? input),
    verification,
  };
}

// Analiz raporuna eklenen çalışma anı ve doğrulama bölümleri (analyze.js çağırır)
export async function runtimeExtras({ report, input, text, output, events = [], sandbox = null, config = null }) {
  const src = text ?? input;
  const level = getSettings().verifyLevel;
  const dynamic = await dynamicReport({ sandbox, text: src, output, config });
  const verifyLevel = events.some((e) => e.verifiedBy === 'effects') ? 'effects' : events.some((e) => e.verifiedBy === 'behaviour') ? 'behaviour' : 'parse';
  let verification = null;
  if (sandbox && levelIndex(level) >= levelIndex('behaviour')) {
    verification = await runVerification({ sandbox, text: src, output, events, level, coverage: dynamic.coverage, verified: verifyLevel !== 'parse', config })
      .catch((e) => ({ level, checks: {}, skipped: [], errors: [{ check: 'orkestrasyon', error: e.message }], failure: { ok: true, failures: [], suspects: [], reproduce: [] } }));
  }
  return {
    dynamic,
    verification: verificationSummary({ input, text: src, output, events, metrics: report.metrics, coverage: dynamic.coverage, verification, verifyLevel }),
  };
}
