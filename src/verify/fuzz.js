import { PROFILES } from '../core/threat.js';
import { POST_SCRIPT } from '../core/threat.js';
import { fnv1a } from '../util/hash.js';
import { instrument, COVERAGE_PLUGIN } from '../sandbox/instrument.js';
import { rng, environment, GRAMMAR, expand } from './grammar.js';
import { semanticHash, diffEffects } from './effects.js';
import { mutants } from './mutate.js';

// I178: diferansiyel fuzz — girdi ve çıktı programı aynı rastgele ortamlarda (zaman, tohum, profil, çerez, depolama,
// sahte yanıt) çalıştırılır, gözlenen davranış ayrışırsa ortam kanıt olarak raporlanır.
// E738: coverage geri beslemeli döngü, E742: çökme triyajı, E741 ile doğrulama gücü (mutant öldürme oranı).

const wrap = (c) => `try {\n${c}\n} catch (e) { __res.push({ __thrown: String(e && e.name || "") + ": " + String(e && e.message || e) }); }`;

export function envConfig(env) {
  const c = { now: env.now, seed: env.seed, cookie: env.cookie, storage: env.storage, responses: env.responses };
  if (env.profile && env.profile !== 'default') c.profile = PROFILES[env.profile];
  return c;
}

const thrownOf = (r) => (r.res ?? []).filter((x) => x && x.__thrown).map((x) => x.__thrown);

async function observe(sandbox, code, env, budget) {
  budget?.charge?.({ runs: 1 });
  const r = await sandbox.run(wrap(code), { timeoutMs: 3000, config: envConfig(env), post: POST_SCRIPT });
  const thrown = thrownOf(r);
  if (!r.ok && r.error) thrown.push(`motor: ${r.error}`);
  return { effects: r.effects ?? [], thrown, hash: semanticHash(r.effects ?? [], thrown), timedOut: Boolean(r.timedOut) };
}

// E742: çökme imzası — sayılar, string içerikleri ve obfuscated isimler normalize edilir
export function crashSignature(message) {
  return String(message)
    .replace(/(["'`]).*?\1/g, 'S')
    .replace(/\b_0x[0-9a-f]+\b/gi, 'ID')
    .replace(/0x[0-9a-f]+|\b\d+(\.\d+)?\b/gi, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// E742: çökmeleri imzaya göre gruplar; her grubun en küçük (en az alan içeren) ortamı yeniden üretici olur
export function triage(crashes) {
  const groups = new Map();
  for (const c of crashes) {
    const sig = `${c.side}|${crashSignature(c.message)}`;
    const g = groups.get(sig) ?? { signature: crashSignature(c.message), side: c.side, count: 0, example: c.message, reproducer: c.env };
    g.count++;
    if (envSize(c.env) < envSize(g.reproducer)) g.reproducer = c.env;
    groups.set(sig, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

const envSize = (e) => JSON.stringify(e ?? {}).length;

// Ayrışan ortamı küçültür: alanları varsayılana çekmeyi dener, ayrışma sürüyorsa değişikliği tutar
export async function minimizeEnv(sandbox, a, b, env, budget) {
  const base = { now: 1700000000000, seed: 12345, profile: 'default', cookie: '', storage: {}, responses: [] };
  let cur = { ...env };
  for (const k of Object.keys(base)) {
    if (budget?.exhausted?.()) break;
    if (JSON.stringify(cur[k]) === JSON.stringify(base[k])) continue;
    const trial = { ...cur, [k]: base[k] };
    const [ra, rb] = [await observe(sandbox, a, trial, budget), await observe(sandbox, b, trial, budget)];
    if (ra.hash !== rb.hash) cur = trial;
  }
  return cur;
}

// I178 + E738: coverage geri beslemeli diferansiyel fuzz. Kapsamı artıran ortamlar korpusa girer ve mutasyonla çoğaltılır.
export async function differentialFuzz(sandbox, codeA, codeB, { iterations = 24, seed = 1, budget = null, feedback = true } = {}) {
  const r = rng(seed);
  let inst = null;
  if (feedback) {
    try { inst = instrument(codeB); } catch { inst = null; }
  }
  const covered = new Set();
  const corpus = [];
  const growth = [];
  const divergences = [];
  const crashes = [];
  let runs = 0;
  const coverage = async (env) => {
    if (!inst) return 0;
    budget?.charge?.({ runs: 1 });
    const res = await sandbox.run(wrap(inst.code), { timeoutMs: 3000, config: envConfig(env), post: POST_SCRIPT, plugins: [COVERAGE_PLUGIN] });
    const s = res.extra?.coverage?.s ?? [];
    let fresh = 0;
    s.forEach((n, i) => { if (n > 0 && !covered.has(i)) { covered.add(i); fresh++; } });
    return fresh;
  };
  for (let i = 0; i < iterations; i++) {
    if (budget?.exhausted?.()) break;
    // korpus varsa çoğunlukla bir korpus girdisini tek alan değiştirerek mutasyona uğrat (AFL tarzı)
    let env;
    if (corpus.length && r.chance(0.7)) {
      env = { ...r.pick(corpus) };
      const fresh = environment(r);
      const k = r.pick(Object.keys(fresh));
      env[k] = fresh[k];
    } else env = environment(r);
    const [ra, rb] = [await observe(sandbox, codeA, env, budget), await observe(sandbox, codeB, env, budget)];
    runs += 2;
    for (const [side, x] of [['girdi', ra], ['çıktı', rb]]) for (const m of x.thrown) crashes.push({ side, message: m, env });
    if (ra.hash !== rb.hash) divergences.push({ iteration: i, env, diff: diffEffects(ra.effects, rb.effects), thrownA: ra.thrown, thrownB: rb.thrown });
    const fresh = await coverage(env);
    if (fresh > 0 || (!inst && !corpus.length)) corpus.push(env);
    growth.push(inst ? covered.size : corpus.length);
  }
  const first = divergences[0] ? { ...divergences[0], minimized: await minimizeEnv(sandbox, codeA, codeB, divergences[0].env, budget) } : null;
  return {
    iterations: growth.length,
    runs,
    equivalent: divergences.length === 0,
    divergences: divergences.slice(0, 20).map((d, i) => (i === 0 && first ? first : d)),
    crashes: triage(crashes),
    coverage: inst ? { statements: inst.map.stmts.length, covered: covered.size, growth } : null,
    corpus: corpus.length,
  };
}

// E741 ile doğrulama gücü: çıktının mutantları; davranışı değişen her mutant semantik hash ile yakalanmalı
export async function mutationScore(sandbox, code, { count = 8, seed = 3, env = null, budget = null } = {}) {
  const e = env ?? environment(rng(seed));
  const base = await observe(sandbox, code, e, budget);
  const list = mutants(code, count, seed);
  const results = [];
  for (const m of list) {
    if (budget?.exhausted?.()) break;
    const o = await observe(sandbox, m.code, e, budget);
    results.push({ op: m.op, line: m.line, description: m.description, killed: o.hash !== base.hash });
  }
  const killed = results.filter((x) => x.killed).length;
  return { mutants: results.length, killed, score: results.length ? killed / results.length : null, results, survivors: results.filter((x) => !x.killed) };
}

export const grammarRules = () => Object.keys(GRAMMAR);
export const sample = (rule, seed = 1) => expand(`<${rule}>`, rng(seed));
export const envHash = (env) => fnv1a(JSON.stringify(env));
