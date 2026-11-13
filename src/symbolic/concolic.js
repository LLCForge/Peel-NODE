// API: concolic(sandbox, code, { target?: {name, params}, maxRuns, timeMs, minimize }) → { ok, inputs, runs, coverage, correlations, regexes }
//      instrument(src) → { code, recorded, syms, branches }, minimizeWitness(constraints, inputs), proveCorrelation(a, b, rel)
import * as t from '@babel/types';
import { parse } from '../core/parse.js';
import { traverse, generate } from '../util/ast.js';
import { Exec } from './exec.js';
import { mk, show, evaluate, vars as termVars, TRUE } from './ir.js';
import { solve } from './solver.js';
import { synthesizeRegex } from './regex.js';

// Concolic yürütme (E586): program QuickJS sandbox'ında somut çalışır, dal kararları ve modellenmeyen değerler
// kaydedilir; aynı yol host'ta sembolik olarak yeniden oynatılır (Exec, guide kipi) ve yol koşulu çıkarılır.
// Kuşak araması: her dal koşulu olumsuzlanıp çözülür (E588 girdi sentezi), kapsanmamış dallar önceliklidir
// (E587 kapsam geri beslemesi). Yeni kapsam getiren girdiler küçültülür (E595), string girdiler için
// dal başına regex sentezlenir (E591), kararları birlikte değişen dallar çözücüyle eşdeğer kanıtlanır (E593).

// Sembolik girdi sayılan ortam okumaları (gerçek sitede kullanıcıya/ortama göre değişen değerler)
const ENV_READS = new Set([
  'navigator.userAgent', 'navigator.language', 'navigator.platform', 'navigator.vendor', 'navigator.webdriver',
  'navigator.cookieEnabled', 'navigator.hardwareConcurrency', 'navigator.deviceMemory', 'navigator.doNotTrack',
  'location.href', 'location.hostname', 'location.host', 'location.pathname', 'location.search', 'location.hash',
  'location.protocol', 'location.origin', 'location.port', 'document.cookie', 'document.referrer', 'document.domain',
  'document.title', 'document.readyState', 'screen.width', 'screen.height', 'screen.colorDepth',
  'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'devicePixelRatio',
]);
const ENV_CALLS = new Set(['Date.now', 'Math.random', 'localStorage.getItem', 'sessionStorage.getItem']);
const GLOBAL_PREFIX = /^(window|self|globalThis)\./;

function dotted(n) {
  if (t.isIdentifier(n)) return n.name;
  if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
    const o = dotted(n.object);
    return o && `${o}.${n.property.name}`;
  }
  return null;
}
const rootName = (n) => { while (t.isMemberExpression(n)) n = n.object; return t.isIdentifier(n) ? n.name : null; };

// Yeniden oynatıcının (Exec) somut değer tükettiği ifadeler; ikisi aynı kümeyi kullanmalı
const OPAQUE_EXPR = new Set(['TaggedTemplateExpression', 'ClassExpression', 'YieldExpression', 'AwaitExpression', 'MetaProperty', 'Import', 'BigIntLiteral', 'DecimalLiteral', 'DoExpression', 'RecordExpression', 'TupleExpression', 'ImportExpression']);
const NATIVE = new Set(['Math', 'String', 'Number', 'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'console', 'undefined', 'NaN', 'Infinity', 'JSON']);

const PRELUDE = (inputs) => `var __peelIn = ${JSON.stringify(inputs)}, __peelD = 0;
function __peelEnc(k, id, v) {
  var t = typeof v;
  if (v === null || t === "number" || t === "string" || t === "boolean" || t === "undefined") {
    if (t === "number" && !isFinite(v)) return { k: k, id: id, d: __peelD, n: String(v) };
    if (t === "undefined") return { k: k, id: id, d: __peelD, u: 1 };
    return { k: k, id: id, d: __peelD, v: t === "string" && v.length > 4000 ? v.slice(0, 4000) : v };
  }
  return { k: k, id: id, d: __peelD, o: 1 };
}
function __peelPush(e) { if (__res.length < 30000) __res.push(e); }
function __peelBr(id, v) { __peelPush({ k: "b", id: id, d: __peelD, v: !!v }); return v; }
function __peelNn(id, v) { __peelPush({ k: "b", id: id, d: __peelD, v: v != null }); return v; }
function __peelCv(id, v) { __peelPush(__peelEnc("v", id, v)); return v; }
function __peelSw(id, v) { __peelPush(__peelEnc("s", id, v)); return v; }
function __peelSym(name, id, thunk) {
  var v = Object.prototype.hasOwnProperty.call(__peelIn, name) ? __peelIn[name] : thunk();
  var e = __peelEnc("v", id, v); e.sym = name; __peelPush(e); return v;
}
function __peelEnter() { __peelD++; }
function __peelLeave() { __peelD--; }
`;

/** Programı enstrümante eder; anahtarlar özgün düğüm konumlarıdır (yeniden oynatma aynı kaynağı parse eder) */
export function instrument(src) {
  const ast = parse(src);
  const recorded = new Set();
  const syms = new Map(); // anahtar → girdi adı
  const branches = new Map(); // dal id → satır
  const key = (n) => `${n.type}@${n.start}`;
  const lit = (n) => t.numericLiteral(n.start);
  const wrap = (fn, args, orig = null) => {
    const c = t.callExpression(t.identifier(fn), args);
    c._peel = true;
    // sarmalayıcı özgün konumu taşır: üst düğüm (if testi vb.) aynı kimliği kullanır
    if (orig) { c.start = orig.start; c.end = orig.end; c.loc = orig.loc; }
    if (fn === '__peelSym') c._peelSkip = true; // thunk özgün ifadeyi dokunulmadan çalıştırır
    return c;
  };

  // atanan serbest adlar: okumaları kaydedilmez (yeniden oynatıcı ilk yazmadan sonra kendi ortamından okur)
  const assignedFree = new Set();
  traverse(ast, {
    'AssignmentExpression|UpdateExpression'(p) {
      const target = p.node.left ?? p.node.argument;
      if (t.isIdentifier(target) && !p.scope.getBinding(target.name)) assignedFree.add(target.name);
    },
  });

  const skipInside = (p) => Boolean(p.findParent((x) => x.node._peelSkip || (x.isFunction() && (x.node.async || x.node.generator))));
  const isReadPosition = (p) => {
    const par = p.parentPath;
    if (par.isAssignmentExpression({ left: p.node }) || par.isUpdateExpression() || par.isUnaryExpression({ operator: 'delete' })) return false;
    if (par.isForXStatement({ left: p.node })) return false;
    if ((par.isCallExpression() || par.isOptionalCallExpression() || par.isNewExpression()) && par.node.callee === p.node) return false;
    return true;
  };

  traverse(ast, {
    enter(p) {
      if ((OPAQUE_EXPR.has(p.node.type) || p.isClassDeclaration()) && !p.node._peel) p.node._peelSkip = true;
      const n = p.node;
      if (n._peel || n.start == null || skipInside(p)) return;
      // sembolik girdi kaynakları (ön sırada: alt ifadeleri enstrümante edilmeden önce tüm okuma sarılır)
      if (p.isMemberExpression() && isReadPosition(p)) {
        const name = dotted(n)?.replace(GLOBAL_PREFIX, '');
        const root = rootName(n);
        if (name && ENV_READS.has(name) && root && !p.scope.getBinding(root)) {
          syms.set(key(n), name);
          p.replaceWith(wrap('__peelSym', [t.stringLiteral(name), lit(n), t.arrowFunctionExpression([], n)], n));
          p.skip();
          return;
        }
      }
      if (p.isCallExpression()) {
        const callee = dotted(n.callee)?.replace(GLOBAL_PREFIX, '');
        const root = rootName(n.callee);
        const argOk = n.arguments.every((a) => t.isStringLiteral(a) || t.isNumericLiteral(a));
        if (callee === '__peelArg' && n.arguments.length === 1 && t.isNumericLiteral(n.arguments[0])) {
          const name = `arg${n.arguments[0].value}`;
          syms.set(key(n), name);
          p.replaceWith(wrap('__peelSym', [t.stringLiteral(name), lit(n), t.arrowFunctionExpression([], t.numericLiteral(0))], n));
          p.skip();
          return;
        }
        if (callee && ENV_CALLS.has(callee) && root && !p.scope.getBinding(root) && argOk) {
          const name = n.arguments.length ? `${callee}(${n.arguments.map((a) => a.value).join(',')})` : `${callee}()`;
          syms.set(key(n), name);
          p.replaceWith(wrap('__peelSym', [t.stringLiteral(name), lit(n), t.arrowFunctionExpression([], n)], n));
          p.skip();
        }
      }
    },
    exit(p) {
      const n = p.node;
      // üretilen düğümler (konumsuz) ve sarmalayıcıların içi yeniden enstrümante edilmez
      if (n._peel || n.start == null || skipInside(p)) return;
      if (OPAQUE_EXPR.has(n.type) || p.isCallExpression() || p.isOptionalCallExpression() || p.isNewExpression() ||
          (p.isBinaryExpression() && (n.operator === 'in' || n.operator === 'instanceof')) ||
          (p.isUnaryExpression({ operator: 'typeof' }) && t.isIdentifier(n.argument) && !p.scope.getBinding(n.argument.name) && !NATIVE.has(n.argument.name)) ||
          ((p.isMemberExpression() || p.isOptionalMemberExpression()) && isReadPosition(p)) ||
          (p.isIdentifier() && p.isReferencedIdentifier() && !p.scope.getBinding(n.name) && !NATIVE.has(n.name) && !assignedFree.has(n.name) &&
            !p.parentPath.isUnaryExpression({ operator: 'typeof' }) && isReadPosition(p) && !n.name.startsWith('__peel'))) {
        if (p.parentPath.isCallExpression({ callee: n }) && (p.isMemberExpression() || p.isOptionalMemberExpression())) return;
        if (p.isCallExpression() && t.isSuper(n.callee)) return;
        recorded.add(key(n));
        p.replaceWith(wrap('__peelCv', [lit(n), n], n));
        p.skip();
        return;
      }
      if ((p.isIfStatement() || p.isConditionalExpression() || p.isWhileStatement() || p.isDoWhileStatement() || p.isForStatement()) && n.test) {
        branches.set(n.test.start, n.test.loc?.start.line ?? 0);
        n.test = wrap('__peelBr', [lit(n.test), n.test]);
      } else if (p.isLogicalExpression()) {
        branches.set(n.left.start, n.left.loc?.start.line ?? 0);
        n.left = wrap(n.operator === '??' ? '__peelNn' : '__peelBr', [lit(n.left), n.left]);
      } else if (p.isSwitchStatement()) {
        n.discriminant = wrap('__peelSw', [t.numericLiteral(n.discriminant.start), n.discriminant]);
      } else if (p.isFunction() && !n.async && !n.generator) {
        const body = t.isBlockStatement(n.body) ? n.body.body : [t.returnStatement(n.body)];
        const enter = t.expressionStatement(wrap('__peelEnter', []));
        const leave = t.blockStatement([t.expressionStatement(wrap('__peelLeave', []))]);
        // "use strict" yönergesi gövdenin başında kalmalı
        n.body = t.blockStatement([enter, t.tryStatement(t.blockStatement(body), null, leave)], t.isBlockStatement(n.body) ? n.body.directives : []);
      }
    },
  });
  const code = generate(ast, { comments: false }).code;
  return { code, recorded, syms, branches };
}

function decodeEvents(res) {
  return res.filter((e) => e && typeof e.k === 'string').map((e) => {
    const out = { k: e.k, id: e.id, d: e.d };
    if (e.sym) out.sym = e.sym;
    if (e.o) out.o = true;
    else if (e.u) out.v = undefined;
    else if (e.n !== undefined) out.v = Number(e.n);
    else out.v = e.v;
    return out;
  });
}

/**
 * @param {object} sandbox  sandboxApi
 * @param {string} code     çözülmüş program
 * @param {{target?: {name:string, params:number}, maxRuns?: number, timeMs?: number}} o
 */
export async function concolic(sandbox, code, { target = null, maxRuns = 12, timeMs = 6000, minimize = true } = {}) {
  const t0 = Date.now();
  const src = target ? `${code}\n;${target.name}(${Array.from({ length: target.params }, (_, i) => `__peelArg(${i})`).join(', ')});` : code;
  let inst;
  let ast;
  try {
    inst = instrument(src);
    ast = parse(src);
  } catch (e) {
    return { ok: false, reason: `enstrümantasyon: ${e.message}` };
  }
  if (!inst.syms.size) return { ok: false, reason: 'sembolik girdi yok' };

  const coverage = new Map(); // "id:yön" → ilk kapsayan koşu
  // "id:yön" → çözücü denemeleri: { sat, unsat (kesin önekli UNSAT), unknown, proof }
  const goals = new Map();
  const runs = [];
  const queue = [{ inputs: {}, bound: 0, target: null, constraints: [] }];
  const tried = new Set();
  const outcomes = new Map(); // dal id → [{run, taken}]

  const runOnce = async (inputs) => {
    const r = await sandbox.run(`${PRELUDE(inputs)}\n${inst.code}`, { timeoutMs: 3000 });
    const events = decodeEvents(r.res ?? []);
    const model = new Map();
    const types = {};
    for (const e of events) if (e.sym && !model.has(e.sym)) {
      model.set(e.sym, e.v);
      if (Object.hasOwn(inputs, e.sym)) types[e.sym] = typeof e.v === 'number' ? (Number.isInteger(e.v) && (e.v | 0) === e.v ? 'int32' : 'num') : typeof e.v === 'string' ? 'str' : undefined;
    }
    const ex = new Exec(ast, {
      guide: { events, recorded: inst.recorded, syms: inst.syms, model, types: Object.fromEntries(Object.entries(types).filter(([, v]) => v)) },
      merge: false, prune: false, maxSteps: 150000, maxDepth: 64, maxStates: 4, unroll: Infinity, timeMs: 3000,
    });
    const res = ex.runProgram();
    const path = res.paths[0];
    return { r, events, model, ex, pc: path?.pc ?? [], replay: res.stats };
  };

  while (queue.length && runs.length < maxRuns && Date.now() - t0 < timeMs) {
    // kapsam geri beslemesi: hedefi henüz kapsanmamış girdi önce
    queue.sort((a, b) => Number(coverage.has(a.target)) - Number(coverage.has(b.target)));
    const item = queue.shift();
    if (item.target && coverage.has(item.target)) continue;
    const sig = JSON.stringify(item.inputs);
    if (tried.has(sig)) continue;
    tried.add(sig);
    const one = await runOnce(item.inputs);
    const newCov = [];
    for (const e of one.events) {
      if (e.k !== 'b') continue;
      const k = `${e.id}:${e.v}`;
      if (!coverage.has(k)) { coverage.set(k, runs.length); newCov.push(k); }
      if (!outcomes.has(e.id)) outcomes.set(e.id, []);
      const list = outcomes.get(e.id);
      if (!list.some((x) => x.run === runs.length)) list.push({ run: runs.length, taken: e.v });
    }
    const run = {
      inputs: Object.fromEntries(one.model),
      requested: item.inputs,
      target: item.target,
      hitTarget: item.target ? coverage.get(item.target) === runs.length : null,
      newCoverage: newCov.length,
      out: (one.r.out ?? []).slice(0, 20),
      network: (one.r.net ?? []).slice(0, 10),
      error: one.r.ok ? null : one.r.error,
      pc: one.pc.map((x) => show(x)),
      diverged: one.replay.diverged,
      constraints: item.constraints,
      pcTerms: one.pc,
      events: one.events,
      conds: new Map(one.ex.branchLog.map((b) => [b.id, b.cond])),
    };
    runs.push(run);
    // kuşak araması: bu yolun her sembolik dalını olumsuzla (bound: aynı öneki tekrar açmamak için)
    const log = one.ex.branchLog;
    for (let i = item.bound; i < log.length; i++) {
      const b = log[i];
      const goal = `${b.id}:${!b.taken}`;
      if (coverage.has(goal)) continue;
      const cs = [...one.pc.slice(0, b.pcLen), b.taken ? mk('!', b.cond) : b.cond];
      const sol = solve(cs, { mode: 'find', timeMs: 400 });
      const g = goals.get(goal) ?? { sat: 0, unsat: 0, unknown: 0, proof: null };
      goals.set(goal, g);
      if (sol.status === 'unsat' && b.exact) { g.unsat++; g.proof ??= sol.proof; }
      else if (sol.status === 'sat') g.sat++;
      else g.unknown++;
      if (sol.status !== 'sat') continue;
      const inputs = { ...item.inputs };
      for (const [name, v] of sol.model) if (inst.syms.size && [...inst.syms.values()].includes(name)) inputs[name] = v;
      queue.push({ inputs, bound: i + 1, target: goal, constraints: cs });
    }
  }

  // E595: tanık küçültme — yeni kapsam getiren her girdi, aynı kısıtları sağlayan en küçük değerlere indirilir
  if (minimize) {
    for (const run of runs) {
      if (!run.newCoverage || !run.constraints.length || Date.now() - t0 > timeMs * 1.5) continue;
      const small = minimizeWitness(run.constraints, run.inputs);
      if (!small) continue;
      const check = await runOnce(small);
      const covered = run.target && check.events.some((e) => e.k === 'b' && `${e.id}:${e.v}` === run.target);
      if (covered) run.minimized = Object.fromEntries(check.model);
    }
  }

  // E593: dinamik dal korelasyonu — tüm koşularda aynı/ters karar veren dal çiftleri, çözücüyle kanıtlanır
  const correlations = branchCorrelations(runs, outcomes, inst.branches);

  // E591: string girdiler için dal başına regex sentezi
  const regexes = [];
  const strInputs = [...new Set(runs.flatMap((r) => Object.keys(r.inputs)))].filter((k) => runs.every((r) => typeof r.inputs[k] === 'string' || r.inputs[k] === undefined));
  for (const [cov, firstRun] of coverage) {
    if (regexes.length >= 8) break;
    const [id, dir] = cov.split(':');
    if (firstRun === 0) continue; // ilk (varsayılan) koşuda kapsanan dallar ilginç değil
    // yalnızca dal koşulunda geçen girdiler
    const cond = runs.map((r) => r.conds.get(Number(id))).find(Boolean);
    const inCond = cond ? new Set(termVars(cond).keys()) : new Set();
    for (const name of strInputs.filter((x) => inCond.has(x))) {
      const pos = [];
      const neg = [];
      for (const r of runs) {
        const v = r.minimized?.[name] ?? r.inputs[name];
        if (typeof v !== 'string') continue;
        const took = r.events.some((e) => e.k === 'b' && String(e.id) === id && String(e.v) === dir);
        (took ? pos : neg).push(v);
      }
      if (!pos.length || !neg.length) continue;
      const re = synthesizeRegex(pos, neg.filter((x) => !pos.includes(x)));
      if (re) regexes.push({ input: name, branch: Number(id), line: inst.branches.get(Number(id)) ?? 0, taken: dir === 'true', regex: re.source, exact: re.exact, examples: pos.slice(0, 3) });
    }
  }

  const totalBranches = inst.branches.size * 2;
  return {
    ok: true,
    target: target?.name ?? null,
    inputs: [...new Set(inst.syms.values())],
    runs: runs.map(({ events, pcTerms, constraints, conds, ...r }) => r),
    goals: Object.fromEntries(goals),
    covered: [...coverage.keys()],
    runEvents: runs.map((r) => r.events.filter((e) => e.k === 'b').map((e) => [e.id, e.v])),
    coverage: { covered: coverage.size, total: totalBranches, ratio: totalBranches ? coverage.size / totalBranches : 1 },
    correlations,
    regexes,
    ms: Date.now() - t0,
  };
}

// Kısıtları koruyarak sayıları sıfıra, stringleri kısa uzunluğa doğru ikili aramayla daraltır
export function minimizeWitness(constraints, inputs) {
  const extra = [];
  const vs = new Map();
  for (const c of constraints) termVars(c, vs);
  if (!vs.size) return null;
  for (const v of vs.values()) {
    const cur = inputs[v.name];
    if (typeof cur === 'number' && Number.isInteger(cur) && cur !== 0) {
      let lo = 0;
      let hi = Math.abs(cur);
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const bound = mk('&&', mk('>=', v, { k: 'c', v: -mid }), mk('<=', v, { k: 'c', v: mid }));
        if (solve([...constraints, ...extra, bound], { mode: 'find', timeMs: 200 }).status === 'sat') hi = mid; else lo = mid + 1;
      }
      extra.push(mk('&&', mk('>=', v, { k: 'c', v: -lo }), mk('<=', v, { k: 'c', v: lo })));
    } else if (typeof cur === 'string' && cur.length) {
      let lo = 0;
      let hi = cur.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (solve([...constraints, ...extra, mk('<=', mk('len', v), { k: 'c', v: mid })], { mode: 'find', timeMs: 200 }).status === 'sat') hi = mid; else lo = mid + 1;
      }
      extra.push(mk('<=', mk('len', v), { k: 'c', v: lo }));
    }
  }
  const r = solve([...constraints, ...extra], { mode: 'find', timeMs: 400 });
  if (r.status !== 'sat') return null;
  const out = { ...inputs };
  for (const [k, v] of r.model) if (k in inputs) out[k] = v;
  return out;
}

function branchCorrelations(runs, outcomes, lines) {
  const ids = [...outcomes.keys()].filter((id) => {
    const o = outcomes.get(id);
    return o.length >= 2 && o.some((x) => x.taken) && o.some((x) => !x.taken);
  });
  // her dal için yeniden oynatmadan gelen sembolik koşul (ilk görülen)
  const condOf = new Map();
  for (const r of runs) for (const [id, c] of r.conds) if (!condOf.has(id)) condOf.set(id, c);
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = outcomes.get(ids[i]);
      const b = outcomes.get(ids[j]);
      const both = a.filter((x) => b.some((y) => y.run === x.run));
      if (both.length < 2) continue;
      const sameDir = both.every((x) => b.find((y) => y.run === x.run).taken === x.taken);
      const opposite = both.every((x) => b.find((y) => y.run === x.run).taken !== x.taken);
      if (!sameDir && !opposite) continue;
      const relation = sameDir ? 'aynı' : 'ters';
      const ca = condOf.get(ids[i]);
      const cb = condOf.get(ids[j]);
      const proof = ca && cb ? proveCorrelation(ca, cb, relation) : null;
      out.push({
        a: ids[i], b: ids[j], lineA: lines.get(ids[i]) ?? 0, lineB: lines.get(ids[j]) ?? 0, relation, runs: both.length,
        proven: Boolean(proof), proof, condA: ca ? show(ca) : null, condB: cb ? show(cb) : null,
      });
    }
  }
  return out.slice(0, 20);
}

/** Yeniden oynatma günlüğündeki sembolik koşullarla korelasyonu kanıtlar: A ⇔ B (ya da A ⇔ ¬B) */
export function proveCorrelation(condA, condB, relation) {
  const b = relation === 'aynı' ? condB : mk('!', condB);
  const xor = mk('||', mk('&&', condA, mk('!', b)), mk('&&', mk('!', condA), b));
  const r = solve([xor], { mode: 'find', timeMs: 500 });
  return r.status === 'unsat' ? r.proof : null;
}

export { TRUE, evaluate };
/**
 * Ortam okumalarını (navigator.language, Date.now() …) verilen girdi değerleriyle değiştirir: çözücünün bulduğu
 * girdiyle başka bir araçlanmış programı (ör. VM izleyicisi) aynı ortamda çalıştırmak için.
 * inputs: { "navigator.language": "tr-TR", "Date.now()": 77, ... }
 */
export function applyInputs(src, inputs) {
  const ast = parse(src);
  const lit = (v) => (v === undefined ? t.unaryExpression('void', t.numericLiteral(0)) : t.valueToNode(v));
  traverse(ast, {
    MemberExpression(p) {
      const par = p.parentPath;
      if (par.isAssignmentExpression({ left: p.node }) || par.isUpdateExpression() || (par.isCallExpression() && par.node.callee === p.node)) return;
      const name = dotted(p.node)?.replace(GLOBAL_PREFIX, '');
      const root = rootName(p.node);
      if (name && Object.hasOwn(inputs, name) && root && !p.scope.getBinding(root)) { p.replaceWith(lit(inputs[name])); p.skip(); }
    },
    CallExpression(p) {
      const callee = dotted(p.node.callee)?.replace(GLOBAL_PREFIX, '');
      if (!callee || !ENV_CALLS.has(callee) || !p.node.arguments.every((a) => t.isStringLiteral(a) || t.isNumericLiteral(a))) return;
      const name = p.node.arguments.length ? `${callee}(${p.node.arguments.map((a) => a.value).join(',')})` : `${callee}()`;
      const root = rootName(p.node.callee);
      if (Object.hasOwn(inputs, name) && root && !p.scope.getBinding(root)) { p.replaceWith(lit(inputs[name])); p.skip(); }
    },
  });
  return generate(ast, { comments: false }).code;
}