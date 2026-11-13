// API: proveEquivalent(srcA, srcB, opts) / divergingInput(srcA, srcB, opts) / boundedCheck(src, property, opts)
//      explore(src, opts) / synthesizeInputs(src, opts)
// opts: { bound=8 döngü açma sınırı, merge, prune, maxPaths, maxDepth (çatallanma derinliği), symbolic: [ad|sıra],
//         concrete: { ad: değer }, globals: { ad: değer|'symbolic' }, backend: 'builtin'|'z3'|'auto', timeoutMs, minimize }
//
// Doğrulama API'si (E701–E705, E733–E739): tek sembolik motor (exec.js, katı kip) ve tek çözücü yığını (solver.js;
// z3 isteğe bağlı hızlandırıcı) üzerinde. Girdiler int32. Modellenemeyen yapı (bilinmeyen çağrı, getter…)
// 'unsupported' olur; yaklaşıklama yapılmaz. Kullanıcı kodu çalıştırılmaz: tanıklar terim değerlendirmesiyle doğrulanır.
// UNSAT kanıtı yalnızca yerleşik çözücünün denetlenmiş DRUP kanıtıysa `checked: true`; z3'ün denetlenmemiş UNSAT'ı
// 'proved' sonucunu `checked: false` ile döndürür — kod değiştiren tüketiciler (E716 yama sentezi) checked ister.
import * as t from '@babel/types';
import { parse } from '../core/parse.js';
import { traverse } from '../util/ast.js';
import { Exec, Unsupported, isTerm } from './exec.js';
import { C, V, mk, show, evaluate, types, TRUE, FALSE } from './ir.js';
import { solveAsync } from './solver.js';
import { ConstraintStore } from './store.js';
import { minimizeWitness } from './concolic.js';

const now = () => Date.now();

function firstFunction(src) {
  const ast = parse(src);
  let fn = null;
  traverse(ast, { Function(p) { if (!fn) fn = p.node; p.stop(); } });
  if (!fn) throw new Unsupported('kaynakta fonksiyon yok');
  if (fn.async || fn.generator) throw new Unsupported('async/generator desteklenmiyor');
  if (!fn.params.every((p) => t.isIdentifier(p))) throw new Unsupported('yalnızca düz parametreler destekleniyor');
  return { ast, fn };
}

const conj = (list) => list.reduce((p, x) => mk('&&', p, x), TRUE);
const disj = (list) => list.reduce((p, x) => mk('||', p, x), FALSE);
const valueKind = (v) => {
  if (!isTerm(v)) return 'object';
  const ty = types(v);
  if (ty.size !== 1) return 'mixed';
  return { number: 'num', boolean: 'bool', undefined: 'undef', string: 'str', null: 'null' }[[...ty][0]] ?? 'object';
};

/**
 * Fonksiyonu çalıştırır: { params, inputs (sembolik girdi adları), argTerms, outcomes: [{ kind, pc (terim), value }],
 *   forks, merges, pruned, limited, store }. kind: return | throw | bound | limit
 */
function run(src, o = {}, extraArgs = null) {
  const { ast, fn } = firstFunction(src);
  return runFn(ast, fn, o, extraArgs);
}
function runFn(ast, fn, o, extraArgs) {
  const opts = { bound: 8, merge: true, prune: false, maxPaths: 256, maxDepth: 64, prefix: 'arg', ...o };
  const inputs = [];
  const args = fn.params.map((p, i) => {
    const symbolic = !opts.symbolic || opts.symbolic.includes(p.name) || opts.symbolic.includes(i);
    if (opts.bind?.has(p.name)) return opts.bind.get(p.name);
    if (!symbolic) return C(opts.concrete?.[p.name]);
    const name = `${opts.prefix}${i}`;
    inputs.push(name);
    return V(name, 'int32');
  });
  if (extraArgs) args.push(...extraArgs);
  const ex = new Exec(ast, {
    strict: true, unroll: opts.bound, merge: opts.merge, prune: opts.prune, maxPaths: opts.maxPaths, forkDepth: opts.maxDepth,
    maxStates: Math.max(64, opts.maxPaths), maxSteps: 200000, maxDepth: 32, timeMs: opts.timeoutMs ?? 20000, solverCalls: Infinity, globals: opts.globals,
  });
  const r = ex.runFunction(fn, args);
  for (const g of r.stats.globals) if (!inputs.includes(g)) inputs.push(g);
  const outcomes = r.paths.map((p) => ({
    kind: p.status === 'return' ? 'return' : p.status === 'throw' ? 'throw' : p.status === 'bound' ? 'bound' : 'limit',
    pc: conj(p.pc), value: p.status === 'return' ? p.value : null,
  }));
  if (r.stats.exhausted) ex.limited ??= r.stats.exhausted;
  return { params: fn.params.map((p) => p.name), inputs, args, outcomes, forks: r.stats.forks, merges: r.stats.merges, pruned: r.stats.pruned, limited: ex.limited, store: opts.prune ? r.stats.store : null };
}

const isIncomplete = (res) => disj(res.outcomes.filter((x) => x.kind === 'bound' || x.kind === 'limit').map((x) => x.pc));
// aynı değer: === ya da ikisi de NaN
const sameValue = (a, b) => mk('||', mk('===', a, b), mk('&&', mk('!==', a, a), mk('!==', b, b)));

// İki sonuç kümesinin (tamamlanmış yollarda) farklı sınıf ya da değer verdiği durumlar
function differs(ra, rb) {
  const done = (r) => r.outcomes.filter((x) => x.kind === 'return' || x.kind === 'throw');
  const parts = [];
  for (const a of done(ra)) {
    for (const b of done(rb)) {
      if (a.kind !== b.kind) parts.push(mk('&&', a.pc, b.pc));
      else if (a.kind === 'return') {
        if (!isTerm(a.value) || !isTerm(b.value)) throw new Unsupported('dönüş değeri nesne');
        parts.push(conj([a.pc, b.pc, mk('!', sameValue(a.value, b.value))]));
      }
    }
  }
  return disj(parts);
}

function describe(res, model) {
  const o = res.outcomes.find((x) => { try { return evaluate(x.pc, model) === true; } catch { return false; } });
  if (!o) return { kind: 'limit', value: undefined };
  if (o.kind !== 'return') return { kind: o.kind, value: undefined };
  const value = evaluate(o.value, model);
  return { kind: value === undefined ? 'undef' : typeof value === 'number' ? 'num' : typeof value === 'boolean' ? 'bool' : typeof value, value };
}
const takenPath = (res, model) => {
  const o = res.outcomes.find((x) => { try { return evaluate(x.pc, model) === true; } catch { return false; } });
  return o ? show(o.pc) : null;
};
const toArgs = (model, inputs) => inputs.map((n) => (model.has(n) ? model.get(n) : 0));
function minimized(goal, inputs, model) {
  const small = minimizeWitness([goal], Object.fromEntries(inputs.map((n) => [n, model.get(n) ?? 0])));
  return small ? new Map(Object.entries(small)) : null;
}

async function compare(srcA, srcB, opts = {}) {
  const t0 = now();
  let ra;
  let rb;
  let goal;
  try {
    ra = run(srcA, opts);
    rb = run(srcB, opts);
    goal = mk('&&', mk('!', mk('||', isIncomplete(ra), isIncomplete(rb))), differs(ra, rb));
  } catch (e) {
    if (e instanceof Unsupported) return { status: 'unsupported', reason: e.message, ms: now() - t0 };
    throw e;
  }
  const inputs = [...new Set([...ra.inputs, ...rb.inputs])];
  const so = { backend: opts.backend ?? 'auto', timeMs: opts.timeoutMs ?? 5000, mode: 'prove' };
  const r = await solveAsync([goal], so);
  const base = { backend: r.backend, inputs, limited: ra.limited ?? rb.limited ?? null };
  if (r.status === 'sat') {
    const small = opts.minimize === false ? null : minimized(goal, inputs, r.model);
    const model = small ?? r.model;
    return {
      ...base, status: 'refuted', ms: now() - t0, counterexample: toArgs(r.model, inputs),
      minimized: small ? toArgs(small, inputs) : null,
      witnessVerified: evaluate(goal, model) === true,
      a: describe(ra, model), b: describe(rb, model), pathA: takenPath(ra, model), pathB: takenPath(rb, model),
    };
  }
  if (r.status === 'unknown') return { ...base, status: 'unknown', ms: now() - t0, reason: r.reason };
  const inc = await solveAsync([mk('||', isIncomplete(ra), isIncomplete(rb))], so);
  if (inc.status === 'unsat') return { ...base, status: 'proved', checked: proofChecked(r.proof) && proofChecked(inc.proof), proof: r.proof, ms: now() - t0 };
  return { ...base, status: 'unknown', ms: now() - t0, reason: inc.status === 'sat' ? `döngü açma sınırı (${opts.bound ?? 8}) ya da yol sınırı aşılabiliyor` : inc.reason };
}

/** Kanıt bağımsız denetlendi mi? (z3 UNSAT'ı ve bütçe aşımıyla denetlenemeyen DRUP: hayır) */
export function proofChecked(p) {
  if (!p) return false;
  if (p.method === 'sat-drup') return p.checked === true;
  if (p.method === 'type-split') return p.cases.every(proofChecked);
  return p.method === 'simplify' || p.method === 'interval' || p.method === 'exhaustive';
}

/**
 * E701/E704/E705: iki fonksiyon tüm int32 girdilerde aynı sınıf (dönüş / throw) ve değeri mi veriyor?
 * @returns {Promise<{ status: 'proved'|'refuted'|'unknown'|'unsupported', checked?: boolean, backend?: string, ms: number,
 *   counterexample?: number[], minimized?: number[]|null, witnessVerified?: boolean, reason?: string }>}
 */
export async function proveEquivalent(srcA, srcB, opts = {}) {
  const r = await compare(srcA, srcB, opts);
  delete r.pathA;
  delete r.pathB;
  return r;
}

/** E703: iki fonksiyonun ayrıştığı girdi ve her birinin izlediği yol koşulu */
export async function divergingInput(srcA, srcB, opts = {}) {
  const r = await compare(srcA, srcB, opts);
  if (r.status !== 'refuted') return { found: false, status: r.status, reason: r.reason ?? null, ms: r.ms };
  return { found: true, input: r.minimized ?? r.counterexample, a: r.a, b: r.b, pathA: r.pathA, pathB: r.pathB, backend: r.backend, ms: r.ms };
}

/**
 * E702: sınırlı model kontrolü. `property` parametre adları ve `result` üzerinde JS ifadesi; en fazla `bound`
 * döngü yinelemeli tüm yürütmelerde dönüş değeri için denetlenir.
 */
export async function boundedCheck(src, property, { bound = 8, ...opts } = {}) {
  const t0 = now();
  const o = { ...opts, bound };
  try {
    const res = run(src, o);
    const propSrc = `function __peelProp(${[...res.params, 'result'].join(', ')}) { return (${property}); }`;
    const holds = (value) => {
      const p = run(propSrc, { ...o, symbolic: [], bind: new Map(res.params.map((n, i) => [n, res.args[i]]).concat([['result', value]])) });
      return disj(p.outcomes.map((x) => (x.kind === 'return' ? mk('&&', x.pc, mk('truthy', x.value)) : x.kind === 'throw' ? FALSE : x.pc)));
    };
    const violations = disj(res.outcomes.filter((x) => x.kind === 'return').map((x) => mk('&&', x.pc, mk('!', holds(x.value)))));
    const reached = isIncomplete(res);
    const so = { backend: opts.backend ?? 'auto', timeMs: opts.timeoutMs ?? 5000, mode: 'prove' };
    const r = await solveAsync([violations], so);
    if (r.status === 'sat') {
      const small = minimized(violations, res.inputs, r.model);
      const model = small ?? r.model;
      return { status: 'violated', bound, ms: now() - t0, counterexample: toArgs(r.model, res.inputs),
        minimized: small ? toArgs(small, res.inputs) : null, result: describe(res, model), backend: r.backend };
    }
    if (r.status === 'unknown') return { status: 'unknown', bound, reason: r.reason, ms: now() - t0 };
    const inc = await solveAsync([reached], so);
    return { status: 'holds', bound, complete: inc.status === 'unsat', checked: proofChecked(r.proof), ms: now() - t0, backend: r.backend,
      reason: inc.status === 'unsat' ? null : `yalnızca ${bound} yinelemeye kadar denetlendi` };
  } catch (e) {
    if (e instanceof Unsupported) return { status: 'unsupported', bound, reason: e.message, ms: now() - t0 };
    throw e;
  }
}

/** E733–E737: yol keşfi. Birleştirme kapalıysa (merge:false) her tam yol ayrı listelenir. */
export function explore(src, opts = {}) {
  try {
    const r = run(src, opts);
    return {
      status: 'ok', params: r.params, inputs: r.inputs, forks: r.forks, merges: r.merges, pruned: r.pruned,
      limited: r.limited, store: r.store,
      paths: r.outcomes.map((o) => ({ kind: o.kind === 'return' ? `return:${valueKind(o.value)}` : o.kind, pc: show(o.pc), value: o.value && isTerm(o.value) ? show(o.value) : null })),
    };
  } catch (e) {
    if (e instanceof Unsupported) return { status: 'unsupported', reason: e.message };
    throw e;
  }
}

/** E739: her olanaklı yol için çözücüyle üretilmiş argüman vektörü */
export function synthesizeInputs(src, { maxPaths = 64, bound = 8, ...opts } = {}) {
  let r;
  try {
    r = run(src, { ...opts, maxPaths, bound, merge: false, prune: true });
  } catch (e) {
    if (e instanceof Unsupported) return { status: 'unsupported', reason: e.message, inputs: [], paths: [], limited: null };
    throw e;
  }
  const seen = new Set();
  const inputs = [];
  const paths = r.outcomes.map((o) => {
    const store = new ConstraintStore({ timeMs: 2000, maxConflicts: 50000, eager: false });
    store.assert(o.pc);
    const c = store.check();
    if (c.status !== 'sat') return { kind: o.kind, pc: show(o.pc), input: null };
    const input = toArgs(c.model, r.inputs);
    const key = input.join(',');
    if (!seen.has(key)) { seen.add(key); inputs.push(input); }
    return { kind: o.kind, pc: show(o.pc), input };
  });
  return { status: 'ok', inputs, paths, limited: r.limited, params: r.params };
}
