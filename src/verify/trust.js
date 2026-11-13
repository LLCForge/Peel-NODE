import { parse } from '../core/parse.js';
import { traverse } from '../util/ast.js';
import { decodeLiteral } from './rationale.js';

// I176 güven skoru, I181 pass başına risk rozeti, I184 başarı metriği, I177 gözlemle üretilen değerlerin konumları.

// Pass risk tabanı: gözleme dayalı (sandbox) ve yapıyı yeniden kuran (unflatten/vm/control-flow) pass'ler daha riskli
const BASE_RISK = {
  'runtime-functions': 2, 'runtime-decoders': 2, vm: 2, unflatten: 2, 'control-flow': 2, 'state-var': 2, predecoders: 1,
  'string-array': 1, 'const-fold': 1, proxy: 1, wrappers: 1, 'dead-code': 1, opaque: 1, unused: 1,
};

export function passRisk(events = [], { verified = false } = {}) {
  const by = new Map();
  for (const e of events) {
    if (e.state === 'run') continue;
    const r = by.get(e.id) ?? { id: e.id, ok: 0, fail: 0, observation: false, verifiedBy: new Set() };
    if (e.state === 'ok') { r.ok++; if (e.verifiedBy) r.verifiedBy.add(e.verifiedBy); }
    if (e.state === 'fail') r.fail++;
    if (e.observation) r.observation = true;
    by.set(e.id, r);
  }
  return [...by.values()].filter((r) => r.ok || r.fail).map((r) => {
    let score = BASE_RISK[r.id] ?? 0;
    const reasons = [];
    if (score >= 2) reasons.push('yapıyı yeniden kuran dönüşüm');
    if (r.observation) { score++; reasons.push('sandbox gözlemine dayalı'); }
    if (r.fail) { score++; reasons.push(`${r.fail} kez geri alındı`); }
    const levels = [...r.verifiedBy];
    if (r.ok && (!verified || levels.every((l) => l === 'parse'))) { score++; reasons.push('davranışla doğrulanmadı'); }
    if (levels.includes('effects')) { score = Math.max(0, score - 1); reasons.push('etkilerle doğrulandı'); }
    return { id: r.id, applied: r.ok, rolledBack: r.fail, risk: score >= 3 ? 'high' : score >= 2 ? 'medium' : 'low', reasons };
  });
}

// I184: başarı metriği — kalan obfuscation izlerinin girdiye göre azalması (0–100)
export function successMetric(m) {
  const parts = [];
  const ratio = (before, after) => (before > 0 ? Math.max(0, 1 - after / before) : after > 0 ? 0 : 1);
  parts.push({ key: 'hexCalls', label: 'hex argümanlı decoder çağrısı', before: m.hexCallsBefore, after: m.hexCallsAfter, weight: 0.4, score: ratio(m.hexCallsBefore, m.hexCallsAfter) });
  parts.push({ key: 'ids', label: '_0x tanımlayıcısı', before: m.obfuscatedIdsBefore, after: m.obfuscatedIdsAfter, weight: 0.3, score: ratio(m.obfuscatedIdsBefore, m.obfuscatedIdsAfter) });
  parts.push({ key: 'vm', label: 'işaretli durum makinesi', before: null, after: m.vmMarks, weight: 0.1, score: m.vmMarks ? 0.5 : 1 });
  parts.push({ key: 'size', label: 'boyut', before: m.inBytes, after: m.outBytes, weight: 0.2, score: m.inBytes ? Math.min(1, Math.max(0, 1.5 - m.outBytes / m.inBytes)) : 1 });
  const score = Math.round(100 * parts.reduce((a, p) => a + p.weight * p.score, 0));
  return { score, parts };
}

// I176: güven skoru — doğrulama düzeyi, geri almalar, coverage, kalan obfuscation, ek doğrulama sonuçları
export function trustScore({ verifyLevel = 'parse', events = [], metrics = null, coverage = null, verification = null }) {
  const reasons = [];
  let s = { parse: 35, behaviour: 60, effects: 70, functions: 80, proof: 85 }[verifyLevel] ?? 30;
  reasons.push(`pass doğrulama düzeyi: ${verifyLevel}`);
  const fails = events.filter((e) => e.state === 'fail').length;
  if (fails) { s -= Math.min(15, fails * 3); reasons.push(`${fails} geri alma`); }
  const observed = events.filter((e) => e.state === 'ok' && e.observation).length;
  if (observed) { s -= Math.min(10, observed * 2); reasons.push(`${observed} gözleme dayalı dönüşüm`); }
  if (coverage?.ok) {
    const c = coverage.ratio;
    s += c >= 0.8 ? 10 : c >= 0.5 ? 5 : -5;
    reasons.push(`coverage %${Math.round(c * 100)}`);
  }
  if (metrics) {
    const m = successMetric(metrics).score;
    s += m >= 80 ? 5 : m < 40 ? -10 : 0;
    reasons.push(`başarı metriği ${m}`);
  }
  const c = verification?.checks ?? {};
  for (const [name, ok] of [['iz denkliği', c.trace?.equivalent], ['bisimülasyon', c.bisimulation?.bisimilar], ['fuzz', c.fuzz?.equivalent],
    ['fonksiyon denkliği', c.functions ? c.functions.differs === 0 : undefined], ['determinizm', c.determinism?.deterministic]]) {
    if (ok === true) { s += 3; reasons.push(`${name} geçti`); }
    if (ok === false) { s -= 20; reasons.push(`${name} başarısız`); }
  }
  if (c.functions?.proved) { s += Math.min(10, c.functions.proved * 2); reasons.push(`${c.functions.proved} fonksiyon SMT ile kanıtlandı`); }
  const score = Math.max(0, Math.min(100, Math.round(s)));
  return { score, level: score >= 80 ? 'high' : score >= 55 ? 'medium' : 'low', reasons };
}

// I177: çıktıda gözlemle üretilen literal'lerin konumları (çıktıda girdidekinden fazla geçen gözlem değerleri)
export function observedRanges(output, events = [], input = '') {
  const values = new Set(events.flatMap((e) => (e.state === 'ok' ? e.observed ?? [] : [])));
  if (!values.size) return [];
  const count = (code) => {
    const m = new Map();
    try {
      traverse(parse(code), {
        StringLiteral(p) { const k = `s:${p.node.value}`; m.set(k, (m.get(k) ?? 0) + 1); },
        NumericLiteral(p) { const k = `n:${p.node.value}`; m.set(k, (m.get(k) ?? 0) + 1); },
      });
    } catch { /* parse edilemeyen girdi: hepsi yeni sayılır */ }
    return m;
  };
  const inCount = count(input);
  const outCount = count(output);
  let ast;
  try { ast = parse(output); } catch { return []; }
  const out = [];
  const visit = (p, key) => {
    if (!values.has(key) || (outCount.get(key) ?? 0) <= (inCount.get(key) ?? 0) || !p.node.loc) return;
    const { start, end } = p.node.loc;
    const pass = events.find((e) => e.state === 'ok' && e.observed?.includes(key))?.id ?? null;
    out.push({ start: p.node.start, end: p.node.end, line: start.line, column: start.column, endLine: end.line, endColumn: end.column, value: decodeLiteral(key).value, pass });
  };
  traverse(ast, {
    StringLiteral(p) { visit(p, `s:${p.node.value}`); },
    NumericLiteral(p) { visit(p, `n:${p.node.value}`); },
  });
  return out.slice(0, 2000);
}
