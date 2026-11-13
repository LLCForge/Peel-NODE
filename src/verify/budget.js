// E719: doğrulama bütçesi — süre, sandbox çalıştırması ve çözücü süresi; aşılınca kalan denetimler "bütçe" ile atlanır.
// E720: doğrulama seviyeleri; E723: kademeli sıkılaştırma (risk sinyali oldukça bir üst seviyeye çıkılır).

export const LEVELS = ['none', 'parse', 'behaviour', 'effects', 'functions', 'proof'];
export const levelIndex = (l) => Math.max(0, LEVELS.indexOf(l));

export function createBudget({ ms = 20000, runs = 200, solverMs = 8000, now = () => Date.now() } = {}) {
  const start = now();
  const used = { runs: 0, solverMs: 0 };
  return {
    limits: { ms, runs, solverMs },
    used,
    charge({ runs: r = 0, solverMs: s = 0 } = {}) { used.runs += r; used.solverMs += s; },
    elapsed: () => now() - start,
    remainingMs: () => Math.max(0, ms - (now() - start)),
    solverLeft: () => Math.max(0, solverMs - used.solverMs),
    exhausted: () => now() - start >= ms || used.runs >= runs,
    report: () => ({ ...used, elapsedMs: now() - start, limits: { ms, runs, solverMs } }),
  };
}

// Seviyeye göre denetimler; her seviye bir öncekileri de içerir
const CHECKS = {
  parse: ['parse'],
  behaviour: ['trace'],
  effects: ['effects', 'bisimulation', 'determinism'],
  functions: ['functions', 'fuzz'],
  proof: ['smt', 'mutation'],
};

// E723: başlangıç seviyesinden başla; risk sinyalleri varsa hedef seviyeye kadar sıkılaştır
export function tightenPlan(start, signals = {}, max = 'proof') {
  const reasons = [];
  if (signals.rollbacks > 0) reasons.push(`${signals.rollbacks} geri alınan değişiklik`);
  if (signals.unverified) reasons.push('pass doğrulaması yalnızca parse');
  if (signals.observation > 0) reasons.push(`${signals.observation} gözleme dayalı dönüşüm`);
  if (signals.coverage != null && signals.coverage < 0.5) reasons.push(`düşük coverage (%${Math.round(signals.coverage * 100)})`);
  if (signals.divergence) reasons.push('etki ayrışması');
  // her risk sinyali seviyeyi bir artırır (en az 'behaviour' tabanından), en çok max
  const base = Math.max(levelIndex(start), levelIndex('behaviour'));
  const target = Math.min(levelIndex(max), reasons.length ? base + reasons.length : levelIndex(start));
  const levels = LEVELS.slice(2, target + 1);
  return {
    start,
    target: LEVELS[target],
    reasons,
    steps: levels.map((l) => ({ level: l, checks: CHECKS[l] ?? [] })),
  };
}
