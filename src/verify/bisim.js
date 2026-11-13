import { startSession, step, closeSession } from '../sandbox/replay.js';
import { traceEquivalent, observable } from './effects.js';

// E707: zayıf bisimülasyon — iki program aynı ortamda adım adım (kilit adım) yürütülür. Etiketli adımlar olay
// türleridir (click, keydown…); zamanlayıcılar içsel (τ) geçiştir: her etiketli adımdan önce iki tarafta da
// tüm zamanlayıcılar çalıştırılır (debug protection gibi kaldırılan zamanlayıcılar ilişkiyi bozmaz).
// Her adım sonunda gözlenebilir etkiler aynı değilse ilişki o adımda kırılır.

async function counts(sandbox, token) {
  const r = await sandbox.batchIn(token, ['__peelTimers.length', 'JSON.stringify(__peelHandlers.map(function (h) { return h.type; }))']);
  return { timers: r.results?.[0]?.value ?? 0, types: JSON.parse(r.results?.[1]?.value ?? '[]') };
}

async function tau(session, from) {
  const c = await counts(session.sandbox, session.token);
  for (let i = from; i < Math.min(c.timers, 50); i++) await step(session, { kind: 'timer', index: i });
  return c.timers;
}

export async function bisimulate(sandbox, codeA, codeB, { config = {}, maxSteps = 30, budget = null } = {}) {
  const A = await startSession(sandbox, codeA, { config });
  let B;
  try {
    B = await startSession(sandbox, codeB, { config });
  } catch (e) {
    await closeSession(A);
    throw e;
  }
  const steps = [];
  let broken = null;
  const compare = (label, ia, ib) => {
    const fa = A.history.slice(ia).flatMap((h) => observable(h.effects));
    const fb = B.history.slice(ib).flatMap((h) => observable(h.effects));
    const t = traceEquivalent(fa, fb);
    steps.push({ label, same: t.equivalent, effects: fa.length, diff: t.equivalent ? null : { index: t.index, a: t.a, b: t.b } });
    if (!t.equivalent && !broken) broken = label;
  };
  try {
    compare('program', 0, 0);
    let ta = 0;
    let tb = 0;
    let ha = A.history.length;
    let hb = B.history.length;
    ta = await tau(A, ta);
    tb = await tau(B, tb);
    budget?.charge?.({ runs: 2 });
    compare('τ (zamanlayıcılar)', ha, hb);
    const [ca, cb] = [await counts(sandbox, A.token), await counts(sandbox, B.token)];
    const typesA = [...new Set(ca.types)].sort();
    const typesB = [...new Set(cb.types)].sort();
    if (typesA.join() !== typesB.join()) {
      broken ??= 'olay kümesi';
      steps.push({ label: 'olay kümesi', same: false, diff: { a: typesA, b: typesB } });
    } else {
      for (const type of typesA.slice(0, maxSteps)) {
        if (broken || budget?.exhausted?.()) break;
        ha = A.history.length;
        hb = B.history.length;
        await step(A, { kind: 'event', type });
        await step(B, { kind: 'event', type });
        ta = await tau(A, ta);
        tb = await tau(B, tb);
        budget?.charge?.({ runs: 2 });
        compare(`olay: ${type}`, ha, hb);
      }
    }
  } finally {
    await closeSession(A);
    await closeSession(B);
  }
  return { bisimilar: !broken, brokenAt: broken, steps };
}
