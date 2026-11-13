// API: new Exec(fileOrProgramAst, { maxStates, maxSteps, maxDepth, unroll, merge, prune, solverCalls, timeMs, summaries, guide })
//        .runProgram() / .runFunction(fnNode, argTerms) → { paths: State[] (pc, value, status, trace, out, effects, approx), stats }
//      new SummaryTable(ast).summarize(fnNode) → { valid, cases:[{pc, ret}], text }; .instantiate(fnNode, args) → terim|null
import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { fnv1a } from '../util/hash.js';
import { C, V, UNDEF, TRUE, FALSE, mk, fresh, truthOf, types, onlyType, evaluate, substitute, vars as termVars, same, show, size } from './ir.js';
import { intervalTruth } from './solver.js';
import { ConstraintStore } from './store.js';

// Sembolik yürütücü (E583–E585, E596–E610).
// Değerler: IR terimi | {k:'ref', id} yığın nesnesi | {k:'fn', node, chain} program fonksiyonu |
//           {k:'ext', name} modellenmeyen dış nesne | {k:'nat', name} modellenen yerleşik.
// Durum: değişkenler (çerçeve|bağlama anahtarı → değer), yığın, yol koşulu, iz, tamamlanma durumu.
// Çatallanan her şey liste döndürür: exec → State[], ev → [State, değer][].

const isTerm = (v) => v && (v.k === 'c' || v.k === 'v' || v.k === 'op');
const ref = (id) => ({ k: 'ref', id });
const ext = (name) => ({ k: 'ext', name });
const nat = (name) => ({ k: 'nat', name });

let heapSeq = 0;
let frameSeq = 0;

/** Katı kipte (strict) modellenemeyen yapı: yaklaşık sonuç yerine bu atılır (doğrulama API'si) */
export class Unsupported extends Error {}
// Çalışan katı yürütücü (yürütme eşzamanlı: tek etkin örnek yeterli)
let STRICT = null;

export class State {
  constructor() {
    this.vars = new Map();
    this.heap = new Map();
    this.pc = [];
    this.trace = [];
    this.status = 'normal';
    this.label = null;
    this.value = UNDEF;
    this._approx = false;
    this.out = [];
    this.effects = [];
    this.depth = 0;
  }
  get approx() { return this._approx; }
  // katı kipte yaklaşıklama (bilinmeyen değer, havoc, desteklenmeyen deyim) sonucu geçersiz kılar
  set approx(v) {
    if (v && STRICT) throw new Unsupported(STRICT.why ?? 'desteklenmeyen yapı');
    this._approx = v;
  }
  clone() {
    const s = new State();
    s.vars = new Map(this.vars);
    for (const [id, o] of this.heap) s.heap.set(id, o.kind === 'arr' ? { ...o, items: o.items.slice() } : { ...o, props: new Map(o.props) });
    s.pc = this.pc.slice();
    s.trace = this.trace.slice();
    s.status = this.status;
    s.label = this.label;
    s.value = this.value;
    s._approx = this._approx;
    s.depth = this.depth;
    s.concretized = this.concretized;
    s.out = this.out.slice();
    s.effects = this.effects.slice();
    return s;
  }
}

// ── bağlama çözümleme: Identifier düğümü → benzersiz anahtar ──────────
function bindingKeys(root) {
  const keyOf = new WeakMap();
  const ids = new Map();
  const fnBindings = new WeakMap(); // fonksiyon/program düğümü → içinde tanımlı anahtarlar
  const keyFor = (b) => { if (!ids.has(b)) ids.set(b, `b${ids.size}:${b.identifier.name}`); return ids.get(b); };
  const ownerOf = (scope) => {
    let s = scope;
    while (s && !s.path.isFunction() && !s.path.isProgram()) s = s.parent;
    return s.path.node;
  };
  traverse(root, {
    Scope(p) {
      for (const b of Object.values(p.scope.bindings)) {
        const owner = ownerOf(b.scope);
        if (!fnBindings.has(owner)) fnBindings.set(owner, []);
        const k = keyFor(b);
        const list = fnBindings.get(owner);
        if (!list.some((x) => x.key === k)) list.push({ key: k, kind: b.kind, node: b.path.node });
      }
    },
    Identifier(p) {
      const b = p.scope.getBinding(p.node.name);
      keyOf.set(p.node, b ? keyFor(b) : `g:${p.node.name}`);
    },
  });
  return { keyOf, fnBindings };
}

const PURE_MATH = new Set(['abs', 'min', 'max', 'floor', 'ceil', 'round', 'trunc', 'sign', 'sqrt', 'pow', 'imul', 'clz32', 'log', 'exp', 'sin', 'cos', 'atan2', 'hypot', 'cbrt', 'fround']);
const STRING_METHODS = new Set(['charCodeAt', 'charAt', 'indexOf', 'startsWith', 'endsWith', 'includes', 'slice', 'substring', 'toUpperCase', 'toLowerCase', 'concat', 'at']);
const NATIVE_GLOBALS = new Set(['Math', 'String', 'Number', 'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'console', 'undefined', 'NaN', 'Infinity', 'JSON']);

export class Exec {
  /**
   * @param {object} root  Program düğümü (ya da File)
   * @param {object} o
   */
  constructor(root, o = {}) {
    this.root = t.isFile(root) ? root : t.file(root);
    this.o = {
      maxStates: 64, maxSteps: 20000, maxDepth: 6, unroll: 4, merge: true, prune: true,
      solverCalls: 150, timeMs: 2500, guide: null, summaries: null, traceLimit: 300, ...o,
    };
    const { keyOf, fnBindings } = bindingKeys(this.root);
    this.keyOf = keyOf;
    this.fnBindings = fnBindings;
    this.steps = 0;
    this.solverCalls = 0;
    this.pruned = 0;
    this.decided = 0;
    this.forks = 0;
    this.merges = 0;
    this.deadline = Date.now() + this.o.timeMs;
    this.exhausted = null;
    this.diverged = null;
    this.cursor = 0;
    this.branchLog = []; // concolic için: { id, cond, taken, pcLen }
    this.limited = null; // yol/derinlik sınırına takılma nedeni (E737)
    this.storeStats = { queries: 0, cacheHits: 0, solverCalls: 0 };
  }

  // ── bütçe (E609) ──────────────────────────────────────
  tick(s) {
    if (this.exhausted) return false;
    if (++this.steps > this.o.maxSteps) this.exhausted = 'adım bütçesi';
    else if ((this.steps & 255) === 0 && Date.now() > this.deadline) this.exhausted = 'süre bütçesi';
    if (this.exhausted) { s.status = 'abort'; return false; }
    return true;
  }
  traceAdd(s, node, kind, extra) {
    if (s.trace.length >= this.o.traceLimit) return;
    s.trace.push({ line: node?.loc?.start.line ?? 0, kind, ...extra });
  }

  // ── değişkenler ───────────────────────────────────────
  key(node) { return this.keyOf.get(node) ?? `g:${node.name}`; }
  slot(s, chain, key) {
    for (const f of chain) { const k = `${f}|${key}`; if (s.vars.has(k)) return k; }
    return null;
  }
  read(s, chain, node) {
    const key = this.key(node);
    const k = this.slot(s, chain, key);
    if (k) return s.vars.get(k);
    const name = node.name;
    if (name === 'undefined') return UNDEF;
    if (name === 'NaN') return C(NaN);
    if (name === 'Infinity') return C(Infinity);
    // doğrulama API'si: serbest adlar somut değer ya da sembolik int32 girdi olarak verilebilir
    const g = this.o.globals?.[name];
    if (g === 'symbolic') {
      this.globalInputs ??= [];
      if (!this.globalInputs.includes(`g_${name}`)) this.globalInputs.push(`g_${name}`);
      return V(`g_${name}`, 'int32');
    }
    if (g !== undefined) return C(g);
    if (NATIVE_GLOBALS.has(name)) return nat(name);
    return null; // modellenmeyen global
  }
  write(s, chain, node, v) {
    const key = this.key(node);
    const k = this.slot(s, chain, key) ?? `0|${key}`;
    s.vars.set(k, v);
  }
  declare(s, frame, key, v) { s.vars.set(`${frame}|${key}`, v); }

  // fonksiyon/program girişinde bildirimleri kaldır (hoisting)
  hoist(s, owner, frame, chain) {
    for (const b of this.fnBindings.get(owner) ?? []) {
      if (b.kind === 'param') continue;
      if (b.kind === 'hoisted' && t.isFunctionDeclaration(b.node)) this.declare(s, frame, b.key, { k: 'fn', node: b.node, chain });
      else if (b.kind === 'local' && b.node === owner && owner.id) this.declare(s, frame, b.key, { k: 'fn', node: owner, chain: chain.slice(1) });
      else if (!s.vars.has(`${frame}|${b.key}`)) this.declare(s, frame, b.key, UNDEF);
    }
  }

  // ── çatallanma, budama, birleştirme ───────────────────
  // E600: yol budama — kısıt deposu (E582) önbellekli ve bağımsızlık bölmeli tatmin sorgusu
  feasible(pc) {
    if (!this.o.prune) return true;
    if (this.solverCalls >= this.o.solverCalls) return true;
    this.solverCalls++;
    const store = new ConstraintStore({ timeMs: 300, eager: false });
    let ok = true;
    for (const c of pc) if (store.assert(c) === 'conflict') { ok = false; break; }
    if (ok) ok = store.feasible();
    for (const k of Object.keys(this.storeStats)) this.storeStats[k] += store.stats[k] ?? 0;
    return ok;
  }

  /** Koşula göre [durum, sonuç] çiftleri (E583 çatallanma, E600/E601 budama) */
  branch(s, cond, node, ctx) {
    const c = mk('truthy', cond);
    const id = node.start;
    if (this.o.guide) {
      const ev = this.consume(ctx, 'b', id);
      if (!ev) { s.status = 'diverge'; return [[s, false]]; }
      const taken = Boolean(ev.v);
      if (c.k !== 'c') {
        let concrete;
        try { concrete = Boolean(evaluate(c, this.o.guide.model)); } catch { concrete = taken; }
        if (concrete !== taken) { this.diverged = `dal ${id}: model ${concrete}, gerçek ${taken}`; s.status = 'diverge'; return [[s, taken]]; }
        // exact: bu noktaya kadar girdi dışı modellenmeyen değer somutlaştırılmadı (UNSAT yol öneki için geçerli kanıt)
        this.branchLog.push({ id, line: node.loc?.start.line ?? 0, cond: c, taken, pcLen: s.pc.length, exact: !s.concretized });
        s.pc.push(taken ? c : mk('!', c));
      }
      this.traceAdd(s, node, 'dal', { taken });
      return [[s, taken]];
    }
    // E601: sabit yayılımı / aralıkla / yol koşulunda zaten bulunan olguyla karar
    const neg = mk('!', c);
    const known = c.k === 'c' ? Boolean(c.v) : s.pc.some((x) => same(x, c)) ? true : s.pc.some((x) => same(x, neg)) ? false : intervalTruth(c);
    if (known !== null) {
      this.decided++;
      this.traceAdd(s, node, 'dal', { taken: known, decided: true });
      return [[s, known]];
    }
    const out = [];
    const pcT = [...s.pc, c];
    const pcF = [...s.pc, mk('!', c)];
    const okT = this.feasible(pcT);
    const okF = this.feasible(pcF);
    if (!okT || !okF) this.pruned++;
    // E737: yol/çatallanma derinliği sınırı — aşan yol 'limit' olarak kapanır (bırakmak sağlam olmazdı)
    if (okT && okF) {
      const reason = this.o.maxPaths && 2 + this.forks - this.merges > this.o.maxPaths ? `yol sınırı (${this.o.maxPaths})`
        : this.o.forkDepth && s.depth + 1 > this.o.forkDepth ? `derinlik sınırı (${this.o.forkDepth})` : null;
      if (reason) { this.limited ??= reason; s.status = 'limit'; return [[s, false]]; }
      s.depth++;
    }
    if (okT && okF) this.forks++;
    if (okT) { const st = okF ? s.clone() : s; st.pc = pcT; this.traceAdd(st, node, 'dal', { taken: true }); out.push([st, true]); }
    if (okF) { const sf = s; sf.pc = pcF; this.traceAdd(sf, node, 'dal', { taken: false }); out.push([sf, false]); }
    if (!out.length) { s.status = 'infeasible'; return []; }
    return out;
  }

  /** İki durumu tek duruma birleştirir (E584 yol birleştirme, E605 durum birleştirme); olmazsa null */
  mergeTwo(a, b) {
    if (a.status !== b.status || a.label !== b.label || a.status === 'abort' || a.status === 'diverge') return null;
    // katı kipte bitmiş yollar (dönüş/throw/sınır) ayrı kalır: yol koşulu ve tanık raporlanabilsin
    if (this.o.strict && a.status !== 'normal') return null;
    let k = 0;
    while (k < a.pc.length && k < b.pc.length && same(a.pc[k], b.pc[k])) k++;
    const ga = a.pc.slice(k).reduce((p, x) => mk('&&', p, x), TRUE);
    const pick = (x, y) => {
      if (x === y) return x;
      if (isTerm(x) && isTerm(y)) return same(x, y) ? x : mk('ite', ga, x, y);
      if (x && y && x.k === y.k && (x.k === 'ref' ? x.id === y.id : x.k === 'fn' ? x.node === y.node && x.chain.join() === y.chain.join() : x.name === y.name)) return x;
      return null;
    };
    const m = new State();
    for (const key of new Set([...a.vars.keys(), ...b.vars.keys()])) {
      const v = pick(a.vars.get(key) ?? UNDEF, b.vars.get(key) ?? UNDEF);
      if (!v) return null;
      m.vars.set(key, v);
    }
    for (const id of new Set([...a.heap.keys(), ...b.heap.keys()])) {
      const x = a.heap.get(id);
      const y = b.heap.get(id);
      if (!x || !y) { m.heap.set(id, x ?? y); continue; }
      if (x.kind !== y.kind) return null;
      if (x.kind === 'arr') {
        if (x.items.length !== y.items.length) return null;
        const items = x.items.map((e, i) => pick(e, y.items[i]));
        if (items.some((e) => !e)) return null;
        m.heap.set(id, { kind: 'arr', items });
      } else {
        if (x.props.size !== y.props.size || [...x.props.keys()].some((p) => !y.props.has(p))) return null;
        const props = new Map();
        for (const [p, e] of x.props) { const v = pick(e, y.props.get(p)); if (!v) return null; props.set(p, v); }
        m.heap.set(id, { kind: 'obj', props });
      }
    }
    const value = pick(a.value, b.value);
    if (!value) return null;
    if (a.out.length !== b.out.length || a.out.some((o, i) => o !== b.out[i])) {
      if (a.out.join('\n') !== b.out.join('\n')) return null;
    }
    const gb = b.pc.slice(k).reduce((p, x) => mk('&&', p, x), TRUE);
    const join = mk('||', ga, gb);
    m.pc = a.pc.slice(0, k);
    if (!(join.k === 'c' && join.v)) m.pc.push(join);
    m.trace = a.trace.slice(0, Math.min(a.trace.length, b.trace.length));
    m.trace.push({ line: 0, kind: 'birleşme' });
    m.status = a.status;
    m.label = a.label;
    m.value = value;
    m.approx = a.approx || b.approx;
    m.out = a.out;
    m.effects = a.effects.length >= b.effects.length ? a.effects : b.effects;
    this.merges++;
    return m;
  }
  mergeAll(list) {
    if (!this.o.merge || list.length < 2) return list;
    const out = [];
    for (const s of list) {
      let done = false;
      for (let i = 0; i < out.length && !done; i++) {
        const m = this.mergeTwo(out[i], s);
        if (m && size(m.pc[m.pc.length - 1] ?? TRUE) < 400) { out[i] = m; done = true; }
      }
      if (!done) out.push(s);
    }
    return out;
  }
  limitStates(list) {
    if (list.length <= this.o.maxStates) return list;
    this.exhausted ??= 'durum bütçesi';
    return list.slice(0, this.o.maxStates);
  }
  mergePairs(pairs) {
    // ifade düzeyinde birleştirme: değerler ite ile tek değere iner
    if (!this.o.merge || pairs.length < 2) return pairs;
    const states = pairs.map(([s, v]) => { const c = s.clone(); c.value = v; return c; });
    const merged = this.mergeAll(states);
    if (merged.length === pairs.length) return pairs;
    return merged.map((s) => { const v = s.value; s.value = UNDEF; return [s, v]; });
  }

  // ── concolic rehberi ──────────────────────────────────
  consume(ctx, kind, id) {
    const evs = this.o.guide.events;
    while (this.cursor < evs.length && evs[this.cursor].d > ctx.depth) this.cursor++;
    const ev = evs[this.cursor];
    if (!ev || ev.d !== ctx.depth || ev.k !== kind || ev.id !== id) {
      this.diverged ??= `beklenen ${kind}@${id}, bulunan ${ev ? `${ev.k}@${ev.id}/d${ev.d}` : 'son'}`;
      return null;
    }
    this.cursor++;
    return ev;
  }
  // used=false: kayıt yalnızca eşzamanlama için tüketilir, modellenen değer kullanılır (somutlaştırma sayılmaz)
  recorded(s, ctx, node, used = true) {
    const ev = this.consume(ctx, 'v', node.start);
    if (!ev) { s.status = 'diverge'; return UNDEF; }
    if (ev.sym) {
      const ty = typeof ev.v === 'number' ? (Number.isInteger(ev.v) && (ev.v | 0) === ev.v ? 'int32' : 'num') : typeof ev.v === 'string' ? 'str' : typeof ev.v === 'boolean' ? 'bool' : ev.v === null ? 'null' : 'undef';
      return V(ev.sym, this.o.guide.types?.[ev.sym] ?? ty, ty === 'str' ? { cap: Math.min(64, Math.max(12, String(ev.v).length + 4)) } : {});
    }
    // girdi olmayan kayıtlı değer: somutlaştırma (yol koşulu bundan sonra alt yaklaşıklık)
    if (used) s.concretized = true;
    if (ev.o) return ext(`dış#${node.start}`);
    return C(ev.v);
  }

  // ── çalıştırma girişleri ──────────────────────────────
  runProgram() { return this.strictly(() => this.runProgramRaw()); }
  runProgramRaw() {
    const s = new State();
    const prog = this.root.program;
    const ctx = { chain: [0], depth: 0, callId: 0, fn: prog, loops: 0 };
    this.hoist(s, prog, 0, ctx.chain);
    return this.finish(this.execList(s, prog.body, ctx));
  }

  /** Fonksiyonu sembolik parametrelerle yürütür (E606 özet çıkarımı da bunu kullanır) */
  runFunction(fnNode, args) { return this.strictly(() => this.runFunctionRaw(fnNode, args)); }
  runFunctionRaw(fnNode, args) {
    const s = new State();
    const prog = this.root.program;
    this.hoist(s, prog, 0, [0]);
    const fn = { k: 'fn', node: fnNode, chain: [0] };
    const pairs = this.call(s, fn, args, UNDEF, { chain: [0], depth: 0, callId: 0, fn: prog, loops: 0 }, fnNode);
    return this.finish(pairs.map(([st, v]) => { if (st.status === 'normal') { st.status = 'return'; st.value = v; } return st; }));
  }

  // katı kip: yaklaşıklama Unsupported atar (bkz. State.approx)
  strictly(run) {
    if (!this.o.strict) return run();
    const prev = STRICT;
    STRICT = this;
    try { return run(); } finally { STRICT = prev; }
  }

  finish(states) {
    return {
      paths: states.filter((s) => s.status !== 'infeasible'),
      stats: {
        steps: this.steps, forks: this.forks, merges: this.merges, pruned: this.pruned, decided: this.decided,
        solverCalls: this.solverCalls, exhausted: this.exhausted, diverged: this.diverged,
        limited: this.limited, store: this.storeStats, globals: this.globalInputs ?? [],
      },
    };
  }

  // ── deyimler ──────────────────────────────────────────
  execList(s, list, ctx) {
    let states = [s];
    for (const stmt of list) {
      const next = [];
      for (const st of states) {
        if (st.status !== 'normal') next.push(st);
        else next.push(...this.exec(st, stmt, ctx));
      }
      states = this.limitStates(this.mergeAll(next));
    }
    return states;
  }

  exec(s, n, ctx) {
    if (!this.tick(s)) return [s];
    switch (n.type) {
      case 'EmptyStatement': case 'FunctionDeclaration': case 'DebuggerStatement': return [s];
      case 'BlockStatement': return this.execList(s, n.body, ctx);
      case 'ExpressionStatement': return this.ev(s, n.expression, ctx).map(([st]) => st);
      case 'VariableDeclaration': {
        let states = [s];
        for (const d of n.declarations) {
          const next = [];
          for (const st of states) {
            if (st.status !== 'normal') { next.push(st); continue; }
            if (!d.init) {
              if (n.kind !== 'var' && t.isIdentifier(d.id)) this.write(st, ctx.chain, d.id, UNDEF);
              next.push(st);
              continue;
            }
            for (const [s2, v] of this.ev(st, d.init, ctx)) {
              if (s2.status === 'normal') this.bindPattern(s2, d.id, v, ctx);
              next.push(s2);
            }
          }
          states = next;
        }
        return states;
      }
      case 'ReturnStatement': {
        if (!n.argument) { s.status = 'return'; s.value = UNDEF; return [s]; }
        return this.ev(s, n.argument, ctx).map(([st, v]) => { if (st.status === 'normal') { st.status = 'return'; st.value = v; this.traceAdd(st, n, 'dönüş'); } return st; });
      }
      case 'ThrowStatement':
        return this.ev(s, n.argument, ctx).map(([st, v]) => { if (st.status === 'normal') { st.status = 'throw'; st.value = v; this.traceAdd(st, n, 'fırlatma'); } return st; });
      case 'IfStatement': {
        const out = [];
        for (const [st, c] of this.ev(s, n.test, ctx)) {
          if (st.status !== 'normal') { out.push(st); continue; }
          for (const [sb, taken] of this.branch(st, c, n.test, ctx)) {
            if (sb.status !== 'normal') { out.push(sb); continue; }
            if (taken) out.push(...this.exec(sb, n.consequent, ctx));
            else if (n.alternate) out.push(...this.exec(sb, n.alternate, ctx));
            else out.push(sb);
          }
        }
        return this.mergeAll(out);
      }
      case 'LabeledStatement': {
        const inner = { ...ctx, label: n.label.name };
        return this.exec(s, n.body, inner).map((st) => {
          if (st.status === 'break' && st.label === n.label.name) { st.status = 'normal'; st.label = null; }
          return st;
        });
      }
      case 'BreakStatement': s.status = 'break'; s.label = n.label?.name ?? null; return [s];
      case 'ContinueStatement': s.status = 'continue'; s.label = n.label?.name ?? null; return [s];
      case 'WhileStatement': return this.loop(s, ctx, { test: n.test, body: n.body, node: n });
      case 'DoWhileStatement': return this.loop(s, ctx, { test: n.test, body: n.body, node: n, doFirst: true });
      case 'ForStatement': {
        let states = [s];
        if (n.init) states = t.isExpression(n.init) ? this.ev(s, n.init, ctx).map(([st]) => st) : this.exec(s, n.init, ctx);
        const out = [];
        for (const st of states) {
          if (st.status !== 'normal') out.push(st);
          else out.push(...this.loop(st, ctx, { test: n.test, body: n.body, update: n.update, node: n }));
        }
        return out;
      }
      case 'ForOfStatement': case 'ForInStatement': return this.forEach(s, n, ctx);
      case 'SwitchStatement': return this.switchStmt(s, n, ctx);
      case 'TryStatement': return this.tryStmt(s, n, ctx);
      default:
        // desteklenmeyen deyim (class, with, import…): yan etkileri bilinmiyor
        s.approx = true;
        this.traceAdd(s, n, 'desteklenmiyor', { type: n.type });
        return [s];
    }
  }

  bindPattern(s, id, v, ctx) {
    if (t.isIdentifier(id)) { this.write(s, ctx.chain, id, v); return; }
    // yapı bozma: dizi/nesne desenleri yalnızca modellenen nesnelerde
    if (t.isArrayPattern(id) && v.k === 'ref' && s.heap.get(v.id)?.kind === 'arr') {
      const items = s.heap.get(v.id).items;
      id.elements.forEach((e, i) => { if (t.isIdentifier(e)) this.write(s, ctx.chain, e, items[i] ?? UNDEF); else if (e) s.approx = true; });
      return;
    }
    if (t.isObjectPattern(id) && v.k === 'ref' && s.heap.get(v.id)?.kind === 'obj') {
      const props = s.heap.get(v.id).props;
      for (const p of id.properties) {
        if (t.isObjectProperty(p) && !p.computed && t.isIdentifier(p.key) && t.isIdentifier(p.value)) this.write(s, ctx.chain, p.value, props.get(p.key.name) ?? UNDEF);
        else s.approx = true;
      }
      return;
    }
    s.approx = true;
  }

  assignedKeys(node) {
    const keys = new Set();
    const objs = new Set();
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (t.isAssignmentExpression(n) || t.isUpdateExpression(n)) {
        const target = n.left ?? n.argument;
        if (t.isIdentifier(target)) keys.add(this.key(target));
        else if (t.isMemberExpression(target)) {
          let o = target.object;
          while (t.isMemberExpression(o)) o = o.object;
          if (t.isIdentifier(o)) objs.add(this.key(o));
        }
      }
      if (t.isVariableDeclarator(n) && t.isIdentifier(n.id)) keys.add(this.key(n.id));
      if (t.isCallExpression(n)) {
        // çağrı nesneleri değiştirebilir (push, ya da program fonksiyonu): argüman/alıcı nesneler
        for (const a of n.arguments) if (t.isIdentifier(a)) objs.add(this.key(a));
        if (t.isMemberExpression(n.callee) && t.isIdentifier(n.callee.object)) objs.add(this.key(n.callee.object));
      }
      for (const k of t.VISITOR_KEYS[n.type] ?? []) walk(n[k]);
    };
    walk(node);
    return { keys, objs };
  }

  // Döngü (E604 kısmi açma): unroll adımına kadar sembolik yürütülür, kalan durumlar havoc'lanır.
  loop(s, ctx, { test, body, update, node, doFirst = false }) {
    let active = [s];
    const exits = [];
    const label = ctx.label;
    const inner = { ...ctx, label: null, loops: ctx.loops + 1 };
    for (let iter = 0; active.length; iter++) {
      if (this.exhausted) { for (const st of active) st.status = 'abort'; exits.push(...active); break; }
      if (iter >= this.o.unroll && !this.o.guide) {
        if (this.o.strict) {
          // BMC: koşulu yine sınanır; çıkan yollar devam eder, sürenler 'bound' (eksik) olarak kapanır
          for (const st of active) {
            if (!test || (doFirst && iter === 0)) { st.status = 'bound'; exits.push(st); continue; }
            for (const [s2, c] of this.ev(st, test, ctx)) {
              if (s2.status !== 'normal') { exits.push(s2); continue; }
              for (const [s3, go] of this.branch(s2, c, test, ctx)) {
                if (s3.status === 'normal' && go) s3.status = 'bound';
                exits.push(s3);
              }
            }
          }
          break;
        }
        exits.push(...active.flatMap((st) => this.havocLoop(st, ctx, { test, body, update, node })));
        break;
      }
      const next = [];
      for (const st of active) {
        let tested;
        if (doFirst && iter === 0) tested = [[st, true]];
        else if (!test) tested = [[st, true]];
        else {
          tested = [];
          for (const [s2, c] of this.ev(st, test, ctx)) {
            if (s2.status !== 'normal') { exits.push(s2); continue; }
            tested.push(...this.branch(s2, c, test, ctx));
          }
        }
        for (const [s3, go] of tested) {
          if (s3.status !== 'normal') { exits.push(s3); continue; }
          if (!go) { exits.push(s3); continue; }
          for (const r of this.exec(s3, body, inner)) {
            if (r.status === 'break' && (!r.label || r.label === label)) { r.status = 'normal'; r.label = null; exits.push(r); continue; }
            if (r.status === 'continue' && (!r.label || r.label === label)) { r.status = 'normal'; r.label = null; }
            if (r.status !== 'normal') { exits.push(r); continue; }
            if (update) next.push(...this.ev(r, update, ctx).map(([x]) => x));
            else next.push(r);
          }
        }
      }
      active = this.limitStates(this.mergeAll(next.filter((x) => { if (x.status !== 'normal') { exits.push(x); return false; } return true; })));
    }
    return this.mergeAll(exits);
  }

  havocLoop(s, ctx, { test, body, update, node }) {
    const { keys, objs } = this.assignedKeys([test, body, update]);
    for (const key of keys) {
      const k = this.slot(s, ctx.chain, key);
      if (k) s.vars.set(k, fresh(`döngü:${key.split(':').pop()}`));
    }
    for (const key of objs) {
      const k = this.slot(s, ctx.chain, key);
      const v = k && s.vars.get(k);
      if (v?.k === 'ref') {
        const o = s.heap.get(v.id);
        // uzunluk da değişebilir: dizi modeli bilinmez hale gelir
        s.heap.set(v.id, o.kind === 'arr' ? { kind: 'obj', props: new Map(), unknown: true } : { kind: 'obj', props: new Map([...o.props].map(([p]) => [p, fresh('döngü:özellik')])), unknown: true });
      }
    }
    s.approx = true;
    this.traceAdd(s, node, 'havoc', { vars: keys.size });
    if (!test) return [];
    const out = [];
    for (const [s2, c] of this.ev(s, test, ctx)) {
      if (s2.status !== 'normal') { out.push(s2); continue; }
      const nc = mk('!', mk('truthy', c));
      if (nc.k === 'c' && !nc.v) continue;
      if (nc.k !== 'c') s2.pc.push(nc);
      out.push(s2);
    }
    return out;
  }

  forEach(s, n, ctx) {
    const out = [];
    for (const [st, coll] of this.ev(s, n.right, ctx)) {
      if (st.status !== 'normal') { out.push(st); continue; }
      const o = coll.k === 'ref' ? st.heap.get(coll.id) : null;
      let items;
      if (o?.kind === 'arr' && t.isForOfStatement(n)) items = o.items;
      else if (o?.kind === 'arr') items = o.items.map((_, i) => C(String(i)));
      else if (o?.kind === 'obj' && !o.unknown && t.isForInStatement(n)) items = [...o.props.keys()].map((k) => C(k));
      else if (isTerm(coll) && coll.k === 'c' && typeof coll.v === 'string' && t.isForOfStatement(n)) items = [...coll.v].map((c) => C(c));
      else { st.approx = true; this.traceAdd(st, n, 'desteklenmiyor', { type: n.type }); out.push(st); continue; }
      let states = [st];
      for (const item of items) {
        const next = [];
        for (const x of states) {
          if (x.status !== 'normal') { next.push(x); continue; }
          if (t.isVariableDeclaration(n.left)) this.bindPattern(x, n.left.declarations[0].id, item, ctx);
          else if (t.isIdentifier(n.left)) this.write(x, ctx.chain, n.left, item);
          else { x.approx = true; }
          for (const r of this.exec(x, n.body, { ...ctx, label: null })) {
            if (r.status === 'continue' && (!r.label || r.label === ctx.label)) { r.status = 'normal'; r.label = null; }
            if (r.status === 'break' && (!r.label || r.label === ctx.label)) { r.status = 'done'; r.label = null; }
            next.push(r);
          }
        }
        states = this.mergeAll(next);
      }
      for (const x of states) if (x.status === 'done') x.status = 'normal';
      out.push(...states);
    }
    return out;
  }

  switchStmt(s, n, ctx) {
    const out = [];
    for (const [st, d] of this.ev(s, n.discriminant, ctx)) {
      if (st.status !== 'normal') { out.push(st); continue; }
      if (this.o.guide) { out.push(...this.switchGuided(st, n, d, ctx)); continue; }
      // her durum için eşleşen case indeksi; testler sırayla değerlendirilir
      let pending = [[st, -1]];
      const matched = [];
      for (let i = 0; i < n.cases.length; i++) {
        const cs = n.cases[i];
        if (!cs.test) continue;
        const next = [];
        for (const [x] of pending) {
          for (const [x2, tv] of this.ev(x, cs.test, ctx)) {
            if (x2.status !== 'normal') { out.push(x2); continue; }
            if (!isTerm(d) || !isTerm(tv)) { x2.approx = true; out.push(x2); continue; }
            for (const [x3, hit] of this.branch(x2, mk('===', d, tv), cs.test, ctx)) {
              if (hit) matched.push([x3, i]); else next.push([x3, -1]);
            }
          }
        }
        pending = next;
      }
      const def = n.cases.findIndex((c) => !c.test);
      for (const [x] of pending) { if (def >= 0) matched.push([x, def]); else out.push(x); }
      for (const [x, from] of matched) {
        let states = [x];
        for (let i = from; i < n.cases.length; i++) {
          states = states.flatMap((y) => (y.status === 'normal' ? this.execList(y, n.cases[i].consequent, ctx) : [y]));
        }
        for (const y of states) {
          if (y.status === 'break' && !y.label) { y.status = 'normal'; }
          out.push(y);
        }
      }
    }
    return this.mergeAll(out);
  }

  // concolic: ayırıcının somut değeri kayıttan ('s'), eşleşme somut karşılaştırmayla; sembolikse yol koşuluna girer
  switchGuided(s, n, d, ctx) {
    const ev = this.consume(ctx, 's', n.discriminant.start);
    if (!ev) { s.status = 'diverge'; return [s]; }
    let from = -1;
    for (let i = 0; i < n.cases.length && from < 0; i++) {
      const cs = n.cases[i];
      if (!cs.test) continue;
      const [[x, tv]] = this.ev(s, cs.test, ctx);
      if (x.status !== 'normal' || !isTerm(tv)) { s.status = 'diverge'; return [s]; }
      let tc;
      try { tc = evaluate(tv, this.o.guide.model); } catch { s.status = 'diverge'; return [s]; }
      const hit = ev.v === tc;
      const c = isTerm(d) ? mk('===', d, tv) : null;
      if (c && c.k !== 'c') {
        this.branchLog.push({ id: cs.test.start, line: cs.test.loc?.start.line ?? 0, cond: c, taken: hit, pcLen: s.pc.length });
        s.pc.push(hit ? c : mk('!', c));
      }
      if (hit) from = i;
    }
    if (from < 0) from = n.cases.findIndex((c) => !c.test);
    if (from < 0) return [s];
    let states = [s];
    for (let i = from; i < n.cases.length; i++) states = states.flatMap((y) => (y.status === 'normal' ? this.execList(y, n.cases[i].consequent, ctx) : [y]));
    for (const y of states) if (y.status === 'break' && !y.label) y.status = 'normal';
    return states;
  }

  tryStmt(s, n, ctx) {
    let states = this.exec(s, n.block, ctx);
    if (n.handler) {
      states = states.flatMap((st) => {
        if (st.status !== 'throw') return [st];
        st.status = 'normal';
        const v = st.value;
        st.value = UNDEF;
        if (n.handler.param) this.bindPattern(st, n.handler.param, v, ctx);
        this.traceAdd(st, n.handler, 'yakalama');
        return this.exec(st, n.handler.body, ctx);
      });
    }
    if (n.finalizer) {
      states = states.flatMap((st) => {
        const saved = { status: st.status, label: st.label, value: st.value };
        st.status = 'normal';
        return this.exec(st, n.finalizer, ctx).map((r) => {
          if (r.status === 'normal') Object.assign(r, saved);
          return r;
        });
      });
    }
    return this.mergeAll(states);
  }

  // ── ifadeler ──────────────────────────────────────────
  // ev: [durum, değer][]; yalnızca 'normal' durumların değeri anlamlıdır
  ev(s, n, ctx) {
    if (s.status !== 'normal') return [[s, UNDEF]];
    const r = this.evRaw(s, n, ctx);
    return r.length > 1 ? this.mergePairs(r) : r;
  }
  ev1(pairs, fn) {
    const out = [];
    for (const [s, v] of pairs) {
      if (s.status !== 'normal') out.push([s, UNDEF]);
      else out.push(...fn(s, v));
    }
    return out;
  }
  evList(s, nodes, ctx) {
    let acc = [[s, []]];
    for (const n of nodes) {
      const next = [];
      for (const [st, vals] of acc) {
        if (st.status !== 'normal') { next.push([st, vals]); continue; }
        if (t.isSpreadElement(n)) {
          for (const [s2, v] of this.ev(st, n.argument, ctx)) {
            const o = v.k === 'ref' ? s2.heap.get(v.id) : null;
            if (o?.kind === 'arr') next.push([s2, [...vals, ...o.items]]);
            else { s2.approx = true; next.push([s2, [...vals, fresh('yayılım')]]); }
          }
          continue;
        }
        for (const [s2, v] of this.ev(st, n, ctx)) next.push([s2, [...vals, v]]);
      }
      acc = next;
    }
    return acc;
  }

  unknown(s, node, ctx, why) {
    if (STRICT) STRICT.why = `desteklenmeyen: ${why} (satır ${node?.loc?.start.line ?? '?'})`;
    // concolic: enstrümante edilen düğümün somut değeri kayıttan gelir (somutlaştırma)
    if (this.isRecorded(node)) return this.recorded(s, ctx, node);
    s.approx = true;
    this.traceAdd(s, node, 'bilinmeyen', { why });
    return fresh(why);
  }
  // Somut değer kaydı tüketilmesi gereken düğüm mü? (concolic enstrümantasyonu ile aynı küme)
  isRecorded(node) { return Boolean(this.o.guide && node && this.o.guide.recorded.has(`${node.type}@${node.start}`)); }
  isSym(node) { return Boolean(this.o.guide && node && this.o.guide.syms.has(`${node.type}@${node.start}`)); }

  /** Enstrümante edilmeyen örtük dal (olası null alıcı, sınır içi indeks): concolic'te somut karar verilir */
  decide(s, cond, node, ctx) {
    if (!this.o.guide) return this.branch(s, cond, node, ctx);
    const c = mk('truthy', cond);
    if (c.k === 'c') return [[s, Boolean(c.v)]];
    let taken;
    try { taken = Boolean(evaluate(c, this.o.guide.model)); } catch { s.approx = true; return [[s, false]]; }
    s.pc.push(taken ? c : mk('!', c));
    return [[s, taken]];
  }

  prim(s, v, node, ctx) {
    // ToPrimitive: modellenen nesneler için yalnızca dizi→string sabit birleştirmesi
    if (isTerm(v)) return v;
    if (v.k === 'ref') {
      const o = s.heap.get(v.id);
      if (o?.kind === 'arr' && o.items.every((e) => isTerm(e) && e.k === 'c' && (e.v === null || e.v === undefined || typeof e.v !== 'object'))) {
        return C(o.items.map((e) => (e.v == null ? '' : String(e.v))).join(','));
      }
      if (o?.kind === 'obj' && !o.props.has('toString') && !o.props.has('valueOf') && !o.unknown) return C('[object Object]');
    }
    return this.unknown(s, node, ctx, 'dönüşüm');
  }

  evRaw(s, n, ctx) {
    // sembolik girdi kaynağı (ortam okuması ya da hedef fonksiyon argümanı): alt ifadeler çalıştırılmaz
    if (this.isSym(n)) return [[s, this.recorded(s, ctx, n)]];
    switch (n.type) {
      case 'NumericLiteral': case 'StringLiteral': case 'BooleanLiteral': return [[s, C(n.value)]];
      case 'NullLiteral': return [[s, C(null)]];
      case 'RegExpLiteral': return [[s, { k: 'regex', pattern: n.pattern, flags: n.flags }]];
      case 'TemplateLiteral': {
        return this.ev1(this.evList(s, n.expressions, ctx), (st, vals) => {
          let acc = C(n.quasis[0].value.cooked ?? '');
          vals.forEach((v, i) => {
            const p = this.prim(st, v, n, ctx);
            acc = mk('+', acc, onlyType(p, 'string') ? p : mk('tostr', p));
            acc = mk('+', acc, C(n.quasis[i + 1].value.cooked ?? ''));
          });
          return [[st, acc]];
        });
      }
      case 'Identifier': {
        const v = this.read(s, ctx.chain, n);
        if (v) return [[s, v]];
        if (this.isRecorded(n)) return [[s, this.recorded(s, ctx, n)]];
        return [[s, ext(n.name)]];
      }
      case 'ThisExpression': return [[s, ctx.thisVal ?? ext('this')]];
      case 'ParenthesizedExpression': return this.ev(s, n.expression, ctx);
      case 'SequenceExpression': {
        let pairs = [[s, UNDEF]];
        for (const e of n.expressions) pairs = this.ev1(pairs, (st) => this.ev(st, e, ctx));
        return pairs;
      }
      case 'ArrayExpression':
        return this.ev1(this.evList(s, n.elements.map((e) => e ?? t.identifier('undefined')), ctx), (st, vals) => {
          const id = ++heapSeq;
          st.heap.set(id, { kind: 'arr', items: vals, owner: ctx.callId });
          return [[st, ref(id)]];
        });
      case 'ObjectExpression': return this.objectLit(s, n, ctx);
      case 'FunctionExpression': case 'ArrowFunctionExpression':
        return [[s, { k: 'fn', node: n, chain: ctx.chain, thisVal: t.isArrowFunctionExpression(n) ? ctx.thisVal : undefined }]];
      case 'UnaryExpression': return this.unary(s, n, ctx);
      case 'BinaryExpression': {
        if (n.operator === 'in' || n.operator === 'instanceof') {
          return this.ev1(this.evList(s, [n.left, n.right], ctx), (st) => [[st, this.unknown(st, n, ctx, n.operator)]]);
        }
        return this.ev1(this.evList(s, [n.left, n.right], ctx), (st, [l, r]) => {
          // nesne karşılaştırması kimliktir
          if ((n.operator === '===' || n.operator === '!==') && (!isTerm(l) || !isTerm(r))) {
            const eq = !isTerm(l) && !isTerm(r) && l.k === r.k && (l.k === 'ref' ? l.id === r.id : l.node === r.node);
            if (l.k === 'ext' || r.k === 'ext') return [[st, this.unknown(st, n, ctx, 'kimlik')]];
            return [[st, C(n.operator === '===' ? eq : !eq)]];
          }
          return [[st, mk(n.operator, this.prim(st, l, n, ctx), this.prim(st, r, n, ctx))]];
        });
      }
      case 'LogicalExpression': {
        return this.ev1(this.ev(s, n.left, ctx), (st, l) => {
          // nesneler hep doğru ve null değil; ?? için dal "null değil" kararıdır
          const test = !isTerm(l) ? TRUE : n.operator === '??' ? mk('!', mk('==', l, C(null))) : l;
          const out = [];
          for (const [sb, taken] of this.branch(st, test, n.left, ctx)) {
            const evalRight = n.operator === '&&' ? taken : !taken;
            if (evalRight) out.push(...this.ev(sb, n.right, ctx));
            else out.push([sb, l]);
          }
          return out;
        });
      }
      case 'ConditionalExpression':
        return this.ev1(this.ev(s, n.test, ctx), (st, c) => {
          const out = [];
          for (const [sb, taken] of this.branch(st, isTerm(c) ? c : TRUE, n.test, ctx)) out.push(...this.ev(sb, taken ? n.consequent : n.alternate, ctx));
          return out;
        });
      case 'AssignmentExpression': return this.assign(s, n, ctx);
      case 'UpdateExpression': return this.update(s, n, ctx);
      case 'MemberExpression': case 'OptionalMemberExpression':
        return this.ev1(this.ev(s, n.object, ctx), (st, o) => {
          if (n.computed) return this.ev1(this.ev(st, n.property, ctx), (s2, key) => this.getProp(s2, o, key, n, ctx));
          return this.getProp(st, o, C(n.property.name), n, ctx);
        });
      case 'CallExpression': case 'OptionalCallExpression': case 'NewExpression': return this.callExpr(s, n, ctx);
      default:
        return [[s, this.unknown(s, n, ctx, n.type)]];
    }
  }

  objectLit(s, n, ctx) {
    let pairs = [[s, new Map()]];
    for (const p of n.properties) {
      const next = [];
      for (const [st, props] of pairs) {
        if (st.status !== 'normal') { next.push([st, props]); continue; }
        if (t.isObjectProperty(p) && !p.computed && (t.isIdentifier(p.key) || t.isStringLiteral(p.key) || t.isNumericLiteral(p.key))) {
          const key = t.isIdentifier(p.key) ? p.key.name : String(p.key.value);
          for (const [s2, v] of this.ev(st, p.value, ctx)) next.push([s2, new Map(props).set(key, v)]);
        } else if (t.isObjectMethod(p) && p.kind === 'method' && !p.computed && t.isIdentifier(p.key)) {
          next.push([st, new Map(props).set(p.key.name, { k: 'fn', node: p, chain: ctx.chain })]);
        } else {
          // getter/setter, hesaplanan anahtar, yayılım: nesne modeli bilinmez olur
          st.approx = true;
          next.push([st, null]);
        }
      }
      pairs = next.map(([st, props]) => [st, props]);
      if (pairs.some(([, p]) => p === null)) break;
    }
    return pairs.map(([st, props]) => {
      const id = ++heapSeq;
      st.heap.set(id, props ? { kind: 'obj', props, owner: ctx.callId } : { kind: 'obj', props: new Map(), unknown: true, owner: ctx.callId });
      return [st, ref(id)];
    });
  }

  unary(s, n, ctx) {
    if (n.operator === 'typeof' && t.isIdentifier(n.argument) && !this.read(s, ctx.chain, n.argument) && !this.isRecorded(n.argument)) {
      return [[s, this.unknown(s, n, ctx, 'typeof')]];
    }
    if (n.operator === 'delete') {
      return this.ev1(this.ev(s, n.argument.object ?? n.argument, ctx), (st, o) => {
        if (t.isMemberExpression(n.argument) && o.k === 'ref' && st.heap.get(o.id)?.kind === 'obj' && !n.argument.computed) {
          st.heap.get(o.id).props.delete(n.argument.property.name);
          return [[st, TRUE]];
        }
        return [[st, this.unknown(st, n, ctx, 'delete')]];
      });
    }
    return this.ev1(this.ev(s, n.argument, ctx), (st, v) => {
      if (n.operator === 'typeof') {
        if (v.k === 'fn' || v.k === 'nat') return [[st, C(v.k === 'nat' && ['Math', 'console', 'JSON'].includes(v.name) ? 'object' : 'function')]];
        if (v.k === 'ref') return [[st, C('object')]];
        if (v.k === 'ext' || v.k === 'regex') return [[st, this.unknown(st, n, ctx, 'typeof')]];
        return [[st, mk('typeof', v)]];
      }
      if (n.operator === 'void') return [[st, UNDEF]];
      if (n.operator === '!') return [[st, isTerm(v) ? mk('!', v) : FALSE]];
      const p = this.prim(st, v, n, ctx);
      const op = { '-': 'neg', '+': 'pos', '~': '~' }[n.operator];
      return [[st, op ? mk(op, p) : this.unknown(st, n, ctx, n.operator)]];
    });
  }

  // x++ / o.p--: hedef bir kez değerlendirilir; sonek eski değeri (ToNumber) döndürür
  update(s, n, ctx) {
    const op = n.operator === '++' ? '+' : '-';
    const step = (st, cur) => {
      const old = mk('pos', this.prim(st, cur, n, ctx));
      return [old, mk(op, old, C(1))];
    };
    const target = n.argument;
    if (t.isIdentifier(target)) {
      const cur = this.read(s, ctx.chain, target) ?? this.unknown(s, target, ctx, 'global');
      const [old, nv] = step(s, cur);
      this.writeTracked(s, ctx, target, nv);
      return [[s, n.prefix ? nv : old]];
    }
    if (t.isMemberExpression(target)) {
      return this.ev1(this.ev(s, target.object, ctx), (st, o) => {
        const keyPairs = target.computed ? this.ev(st, target.property, ctx) : [[st, C(target.property.name)]];
        return this.ev1(keyPairs, (s2, key) => this.ev1(this.getProp(s2, o, key, target, ctx), (s3, cur) => {
          if (s3.status !== 'normal') return [[s3, UNDEF]];
          const [old, nv] = step(s3, cur);
          this.setProp(s3, o, key, nv, n, ctx);
          return [[s3, n.prefix ? nv : old]];
        }));
      });
    }
    return [[s, this.unknown(s, n, ctx, 'güncelleme hedefi')]];
  }

  // Yazma + dış durum etkisi kaydı (özet geçerliliği için: çağrının kendi çerçevesi dışına yazma)
  writeTracked(s, ctx, node, v) {
    this.write(s, ctx.chain, node, v);
    if (ctx.depth > 0 && !this.slot(s, [ctx.chain[0]], this.key(node))) s.effects.push({ kind: 'outer', name: node.name });
  }

  assign(s, n, ctx) {
    const srcNode = n;
    const target = n.left;
    const rhs = (st, cur) => {
      if (n.operator === '=') return this.ev(st, n.right, ctx);
      const op = n.operator.slice(0, -1);
      if (op === '&&' || op === '||' || op === '??') {
        const test = op === '??' ? mk('!', mk('==', cur, C(null))) : cur;
        const out = [];
        for (const [sb, taken] of this.branch(st, isTerm(test) ? test : TRUE, n, ctx)) {
          if ((op === '&&') === taken) out.push(...this.ev(sb, n.right, ctx));
          else out.push([sb, null]);
        }
        return out;
      }
      return this.ev1(this.ev(st, n.right, ctx), (s2, r) => [[s2, mk(op, this.prim(s2, cur, n, ctx), this.prim(s2, r, n, ctx))]]);
    };
    if (t.isIdentifier(target)) {
      const cur = n.operator === '=' ? UNDEF : this.read(s, ctx.chain, target) ?? this.unknown(s, target, ctx, 'global');
      return rhs(s, cur).map(([s2, v]) => {
        if (s2.status === 'normal' && v !== null) this.writeTracked(s2, ctx, target, v);
        return [s2, v ?? cur];
      });
    }
    if (t.isMemberExpression(target)) {
      return this.ev1(this.ev(s, target.object, ctx), (st, o) => {
        const keyPairs = target.computed ? this.ev(st, target.property, ctx) : [[st, C(target.property.name)]];
        return this.ev1(keyPairs, (s2, key) => {
          const cur = n.operator === '=' ? [[s2, UNDEF]] : this.getProp(s2, o, key, target, ctx);
          return this.ev1(cur, (s3, c) => rhs(s3, c).map(([s4, v]) => {
            if (s4.status === 'normal' && v !== null) this.setProp(s4, o, key, v, n, ctx);
            return [s4, v ?? c];
          }));
        });
      });
    }
    s.approx = true;
    return [[s, this.unknown(s, srcNode, ctx, 'atama hedefi')]];
  }

  // ── özellik modeli (E596 dizi, E597 nesne, E598 string) ──
  getProp(s, o, key, node, ctx, nonNull = false) {
    const recorded = this.isRecorded(node);
    const take = (v) => {
      if (recorded) {
        const r = this.recorded(s, ctx, node, v == null);
        // modellenen değer öncelikli; modellenmeyen kısımlar kayıttan gelir
        return [[s, v ?? r]];
      }
      return [[s, v ?? this.unknown(s, node, ctx, 'özellik')]];
    };
    if (isTerm(o)) {
      if (o.k === 'c' && (o.v === undefined || o.v === null)) { s.status = 'throw'; s.value = C('TypeError'); this.traceAdd(s, node, 'fırlatma', { why: 'null özellik' }); return [[s, UNDEF]]; }
      const ty = types(o);
      if (!nonNull && (ty.has('undefined') || ty.has('null'))) {
        // olası null: atan yol ve devam eden yol olarak çatallan
        const out = [];
        for (const [sb, isNull] of this.decide(s, mk('==', o, C(null)), node, ctx)) {
          if (isNull) { sb.status = 'throw'; sb.value = C('TypeError'); out.push([sb, UNDEF]); }
          else out.push(...this.getProp(sb, o, key, node, ctx, true));
        }
        return out;
      }
      if (onlyType(o, 'string') && isTerm(key)) {
        if (key.k === 'c' && key.v === 'length') return take(mk('len', o));
        if (key.k === 'c' && STRING_METHODS.has(key.v)) return take({ k: 'smethod', recv: o, name: key.v });
        if (onlyType(key, 'number')) return take(mk('ite', mk('<', key, mk('len', o)), mk('charAt', o, key), UNDEF));
      }
      return take(null);
    }
    if (o.k === 'ref') {
      const obj = s.heap.get(o.id);
      const k = isTerm(key) ? key : null;
      if (obj.kind === 'arr' && k) {
        if (k.k === 'c' && k.v === 'length') return take(C(obj.items.length));
        if (k.k === 'c' && ['push', 'pop', 'indexOf', 'includes', 'join', 'slice', 'shift'].includes(k.v)) return take({ k: 'amethod', recv: o, name: k.v });
        const idx = k.k === 'c' && typeof k.v === 'string' && /^(0|[1-9]\d*)$/.test(k.v) ? C(Number(k.v)) : k;
        if (idx.k === 'c') {
          if (typeof idx.v === 'number' && Number.isInteger(idx.v) && idx.v >= 0) return take(obj.items[idx.v] ?? UNDEF);
          return take(null);
        }
        if (onlyType(idx, 'number') && obj.items.every(isTerm)) {
          // sembolik indeks: eleman seçimi ite zinciri (sınır dışı → undefined)
          let v = UNDEF;
          for (let i = obj.items.length - 1; i >= 0; i--) v = mk('ite', mk('===', idx, C(i)), obj.items[i], v);
          return take(v);
        }
        return take(null);
      }
      if (obj.kind === 'obj' && !obj.unknown && k) {
        if (k.k === 'c') {
          const name = String(k.v);
          if (obj.props.has(name)) return take(obj.props.get(name));
          // prototip zinciri: Object.prototype üyeleri modellenmiyor
          if (name in Object.prototype) return take(null);
          return take(UNDEF);
        }
        if (onlyType(k, 'string') && [...obj.props.values()].every(isTerm)) {
          let v = UNDEF;
          for (const [p, e] of [...obj.props].reverse()) v = mk('ite', mk('===', k, C(p)), e, v);
          // anahtar prototip üyesi olabilir: yalnızca anahtar kümesi bilinen string ise güvenli
          return take(v);
        }
      }
      return take(null);
    }
    if (o.k === 'nat' && isTerm(key) && key.k === 'c') {
      if (o.name === 'Math' && PURE_MATH.has(key.v)) return take(nat(`Math.${key.v}`));
      if (o.name === 'Math' && typeof Math[key.v] === 'number') return take(C(Math[key.v]));
      if (o.name === 'String' && key.v === 'fromCharCode') return take(nat('String.fromCharCode'));
      if (o.name === 'console' && ['log', 'info', 'warn', 'error'].includes(key.v)) return take(nat('console.log'));
    }
    if (isTerm(o) === false && o.k === 'fn' && isTerm(key) && key.k === 'c' && key.v === 'length') return take(C(o.node.params.length));
    return take(null);
  }

  setProp(s, o, key, v, node, ctx) {
    if (o.k === 'ref' && isTerm(key)) {
      const obj = s.heap.get(o.id);
      if (ctx.depth > 0 && obj.owner !== ctx.callId) s.effects.push({ kind: 'store', line: node.loc?.start.line ?? 0 });
      if (obj.kind === 'arr') {
        const idx = key.k === 'c' && typeof key.v === 'string' && /^(0|[1-9]\d*)$/.test(key.v) ? Number(key.v) : key.k === 'c' ? key.v : null;
        if (typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 && idx <= obj.items.length) { obj.items[idx] = v; return; }
        if (idx === null && onlyType(key, 'number') && obj.items.every(isTerm) && isTerm(v)) {
          // sembolik indeksli yazma: sınır içi yol modellenir. Concolic'te somut karar, aksi halde varsayım (yaklaşık)
          const inside = mk('&&', mk('>=', key, C(0)), mk('<', key, C(obj.items.length)));
          let ok = true;
          if (this.o.guide) {
            try { ok = Boolean(evaluate(inside, this.o.guide.model)); } catch { ok = false; }
          } else s.approx = true;
          if (ok) {
            if (inside.k !== 'c') s.pc.push(inside);
            obj.items = obj.items.map((e, i) => mk('ite', mk('===', key, C(i)), v, e));
            return;
          }
        }
      } else if (!obj.unknown && key.k === 'c' && !(String(key.v) in Object.prototype)) {
        obj.props.set(String(key.v), v);
        return;
      }
      s.heap.set(o.id, { kind: 'obj', props: new Map(), unknown: true, owner: obj.owner });
    }
    s.approx = true;
    s.effects.push({ kind: 'store', line: node.loc?.start.line ?? 0 });
  }

  // ── çağrılar (E606–E608 özetler) ──────────────────────
  callExpr(s, n, ctx) {
    const isNew = t.isNewExpression(n);
    const calleeNode = n.callee;
    const head = t.isMemberExpression(calleeNode)
      ? this.ev1(this.ev(s, calleeNode.object, ctx), (st, recv) => {
        const keyPairs = calleeNode.computed ? this.ev(st, calleeNode.property, ctx) : [[st, C(calleeNode.property.name)]];
        return this.ev1(keyPairs, (s2, key) => {
          // alıcı null/undefined olabilirse önce atan yol ayrılır (yöntem okuması TypeError)
          if (isTerm(recv) && recv.k !== 'c') {
            const ty = types(recv);
            if (ty.has('undefined') || ty.has('null')) {
              const out = [];
              for (const [sb, isNull] of this.decide(s2, mk('==', recv, C(null)), calleeNode, ctx)) {
                if (isNull) { sb.status = 'throw'; sb.value = C('TypeError'); this.traceAdd(sb, calleeNode, 'fırlatma', { why: 'null alıcı' }); out.push([sb, { fn: null, recv }]); }
                else out.push([sb, { fn: this.peekMember(sb, recv, key, calleeNode, ctx), recv }]);
              }
              return out;
            }
          }
          if (isTerm(recv) && recv.k === 'c' && recv.v == null) {
            s2.status = 'throw';
            s2.value = C('TypeError');
            return [[s2, { fn: null, recv }]];
          }
          // yöntem değeri: kayıt yalnızca çağrı sonucu için tutulur (enstrümantasyon üye erişimini çağrıda sarmalamaz)
          return [[s2, { fn: this.peekMember(s2, recv, key, calleeNode, ctx), recv }]];
        });
      })
      : this.ev(s, calleeNode, ctx).map(([st, fn]) => [st, { fn, recv: UNDEF }]);
    return this.ev1(head, (st, { fn, recv }) => this.ev1(this.evList(st, n.arguments, ctx), (s2, args) => {
      if (isNew) return [[s2, this.unknown(s2, n, ctx, 'new')]];
      return this.callValue(s2, fn, args, recv, n, ctx);
    }));
  }

  // Çağrı hedefi için üye değeri (kayıt tüketmeden)
  peekMember(s, recv, key, node, ctx) {
    const g = this.o.guide;
    this.o.guide = null;
    const before = s.approx;
    const tr = s.trace.length;
    let r;
    try {
      // null denetimi çağıranda yapıldı: burada çatallanma olmaz
      const pairs = this.getProp(s, recv, key, node, ctx, true);
      r = pairs.length === 1 && pairs[0][0] === s && s.status === 'normal' ? pairs[0][1] : null;
    } finally {
      this.o.guide = g;
    }
    s.approx = before;
    s.trace.length = Math.min(s.trace.length, tr);
    return r && r.k === 'v' && r.name.startsWith('özellik#') ? null : r;
  }

  callValue(s, fn, args, recv, n, ctx) {
    const recorded = this.isRecorded(n);
    const result = (st, v) => {
      if (recorded) {
        const r = this.recorded(st, ctx, n, v == null);
        return [[st, v ?? r]];
      }
      return [[st, v ?? this.unknown(st, n, ctx, 'çağrı')]];
    };
    if (!fn) return result(s, null);
    if (fn.k === 'fn') {
      if (recorded) {
        // concolic: program fonksiyonu yeniden oynatılır, ardından çağrının kendi kaydı tüketilir
        const pairs = this.call(s, fn, args, recv, ctx, n);
        return this.ev1(pairs, (st, v) => { this.recorded(st, ctx, n, false); return [[st, v]]; });
      }
      return this.call(s, fn, args, recv, ctx, n);
    }
    if (fn.k === 'smethod') return result(s, this.stringMethod(fn, args));
    if (fn.k === 'amethod') return result(s, this.arrayMethod(s, fn, args, ctx, n));
    if (fn.k === 'nat') {
      if (fn.name === 'console.log') {
        const text = args.map((a) => (isTerm(a) ? show(a) : `<${a.k}>`)).join(' ');
        s.out.push(text);
        s.effects.push({ kind: 'out', text });
        return result(s, UNDEF);
      }
      return result(s, this.nativeCall(fn.name, args));
    }
    // dış fonksiyon: dünya durumu değişmiş olabilir
    s.effects.push({ kind: 'call', line: n.loc?.start.line ?? 0 });
    return result(s, null);
  }

  stringMethod({ recv, name }, args) {
    if (!args.every(isTerm)) return null;
    const a = args;
    const isNonNegInt = (x) => x && x.k === 'c' && Number.isInteger(x.v) && x.v >= 0;
    switch (name) {
      case 'charCodeAt': case 'charAt': return mk(name, recv, a[0] ?? C(0));
      case 'at': return a[0] && onlyType(a[0], 'number') ? mk('ite', mk('<', a[0], C(0)), mk('charAt', recv, mk('+', mk('len', recv), a[0])), mk('ite', mk('<', a[0], mk('len', recv)), mk('charAt', recv, a[0]), UNDEF)) : null;
      case 'indexOf': case 'startsWith': case 'endsWith': case 'includes':
        return a.length === 1 && onlyType(a[0], 'string') ? mk(name, recv, a[0]) : null;
      case 'slice': return a.every((x) => x.k === 'c' && Number.isInteger(x.v)) ? mk('slice', recv, ...a) : null;
      case 'substring': return a.every(isNonNegInt) && (a.length < 2 || a[0].v <= a[1].v) ? mk('slice', recv, ...a) : null;
      case 'toUpperCase': return mk('upper', recv);
      case 'toLowerCase': return mk('lower', recv);
      case 'concat': return a.every((x) => onlyType(x, 'string')) ? a.reduce((p, x) => mk('+', p, x), recv) : null;
      default: return null;
    }
  }

  arrayMethod(s, { recv, name }, args, ctx, node) {
    const o = s.heap.get(recv.id);
    if (o.kind !== 'arr') return null;
    if (['push', 'pop', 'shift'].includes(name) && ctx.depth > 0 && o.owner !== ctx.callId) s.effects.push({ kind: 'store', line: node.loc?.start.line ?? 0 });
    switch (name) {
      case 'push': o.items.push(...args); return C(o.items.length);
      case 'pop': return o.items.length ? o.items.pop() : UNDEF;
      case 'shift': return o.items.length ? o.items.shift() : UNDEF;
      case 'indexOf': case 'includes': {
        if (!args.length || !isTerm(args[0]) || !o.items.every(isTerm)) return null;
        let v = name === 'includes' ? FALSE : C(-1);
        for (let i = o.items.length - 1; i >= 0; i--) v = mk('ite', mk('===', o.items[i], args[0]), name === 'includes' ? TRUE : C(i), v);
        return v;
      }
      case 'join': {
        if (!o.items.every((e) => isTerm(e) && (onlyType(e, 'string') || e.k === 'c'))) return null;
        const sep = args.length ? args[0] : C(',');
        if (!isTerm(sep) || sep.k !== 'c') return null;
        let acc = null;
        for (const e of o.items) {
          const str = e.k === 'c' ? C(e.v == null ? '' : String(e.v)) : e;
          acc = acc ? mk('+', mk('+', acc, C(String(sep.v))), str) : str;
        }
        return acc ?? C('');
      }
      case 'slice': {
        if (!args.every((x) => isTerm(x) && x.k === 'c' && Number.isInteger(x.v))) return null;
        const id = ++heapSeq;
        s.heap.set(id, { kind: 'arr', items: o.items.slice(...args.map((x) => x.v)), owner: ctx.callId });
        return ref(id);
      }
      default: return null;
    }
  }

  nativeCall(name, args) {
    if (!args.every(isTerm)) return null;
    const a = args;
    if (a.every((x) => x.k === 'c')) {
      try {
        const fn = name.startsWith('Math.') ? Math[name.slice(5)] : name === 'String.fromCharCode' ? String.fromCharCode : globalThis[name];
        if (typeof fn === 'function' && (name.startsWith('Math.') || ['String.fromCharCode', 'String', 'Number', 'Boolean', 'parseInt', 'parseFloat', 'isNaN'].includes(name))) return C(fn(...a.map((x) => x.v)));
      } catch { return null; }
    }
    const int = (x) => x.k === 'v' && (x.ty === 'int32' || x.ty === 'int');
    switch (name) {
      case 'String': return a.length ? mk('tostr', a[0]) : C('');
      case 'Number': return a.length ? mk('tonum', a[0]) : C(0);
      case 'Boolean': return a.length ? mk('truthy', a[0]) : FALSE;
      case 'Math.abs': return a[0] && onlyType(a[0], 'number') ? mk('ite', mk('<', a[0], C(0)), mk('neg', a[0]), mk('pos', a[0])) : null;
      case 'Math.min': case 'Math.max': {
        if (a.length !== 2 || !a.every((x) => int(x) || (x.k === 'c' && Number.isInteger(x.v)))) return null;
        return mk('ite', mk(name === 'Math.min' ? '<' : '>', a[0], a[1]), a[0], a[1]);
      }
      case 'Math.imul': return a.length === 2 && a.every((v) => onlyType(v, 'number')) ? mk('imul', a[0], a[1]) : null;
      case 'Math.floor': case 'Math.ceil': case 'Math.round': case 'Math.trunc': return a[0] && int(a[0]) ? a[0] : null;
      default: return null;
    }
  }

  /** Program fonksiyonu çağrısı: özet varsa yeniden kullanılır (E608), yoksa satır içi yürütülür */
  call(s, fn, args, recv, ctx, node) {
    const f = fn.node;
    if (this.o.summaries && !this.o.guide) {
      const inst = this.o.summaries.instantiate(f, args, this);
      if (inst) {
        this.traceAdd(s, node, 'özet', { fn: f.id?.name ?? '<anonim>' });
        return [[s, inst]];
      }
    }
    if (ctx.depth >= this.o.maxDepth) return [[s, this.unknown(s, node, ctx, 'derinlik')]];
    if (f.async || f.generator) return [[s, this.unknown(s, node, ctx, 'async')]];
    const frame = ++frameSeq;
    const chain = [frame, ...fn.chain];
    const inner = { chain, depth: ctx.depth + 1, callId: frame, fn: f, loops: 0, thisVal: t.isArrowFunctionExpression(f) ? fn.thisVal : recv ?? UNDEF };
    this.hoist(s, f, frame, chain);
    // arguments nesnesi
    if (this.usesArguments(f)) {
      const id = ++heapSeq;
      s.heap.set(id, { kind: 'arr', items: args.slice(), owner: frame });
      this.declare(s, frame, 'g:arguments', ref(id));
    }
    let states = [s];
    f.params.forEach((p, i) => {
      const next = [];
      for (const st of states) {
        if (st.status !== 'normal') { next.push(st); continue; }
        if (t.isIdentifier(p)) { this.declare(st, frame, this.key(p), args[i] ?? UNDEF); next.push(st); continue; }
        if (t.isAssignmentPattern(p) && t.isIdentifier(p.left)) {
          const a = args[i] ?? UNDEF;
          if (isTerm(a) && a.k === 'c' && a.v !== undefined) { this.declare(st, frame, this.key(p.left), a); next.push(st); continue; }
          if (isTerm(a) && a.k !== 'c' && types(a).has('undefined')) { st.approx = true; this.declare(st, frame, this.key(p.left), a); next.push(st); continue; }
          if (!isTerm(a)) { this.declare(st, frame, this.key(p.left), a); next.push(st); continue; }
          for (const [s2, d] of this.ev(st, p.right, inner)) { this.declare(s2, frame, this.key(p.left), d); next.push(s2); }
          continue;
        }
        if (t.isRestElement(p) && t.isIdentifier(p.argument)) {
          const id = ++heapSeq;
          st.heap.set(id, { kind: 'arr', items: args.slice(i), owner: frame });
          this.declare(st, frame, this.key(p.argument), ref(id));
          next.push(st);
          continue;
        }
        const v = args[i] ?? UNDEF;
        this.bindPattern(st, p, v, inner);
        next.push(st);
      }
      states = next;
    });
    this.traceAdd(s, node, 'çağrı', { fn: f.id?.name ?? '<anonim>' });
    const out = [];
    const bodyStates = t.isExpression(f.body)
      ? states.flatMap((st) => this.ev(st, f.body, inner).map(([x, v]) => { if (x.status === 'normal') { x.status = 'return'; x.value = v; } return x; }))
      : states.flatMap((st) => (st.status === 'normal' ? this.exec(st, f.body, inner) : [st]));
    for (const st of bodyStates) {
      if (st.status === 'return') { const v = st.value; st.status = 'normal'; st.value = UNDEF; out.push([st, v]); }
      else if (st.status === 'normal') out.push([st, UNDEF]);
      else out.push([st, UNDEF]);
    }
    // katı kipte en dış çağrının dönüş yolları ayrı kalır (yol koşulları raporlanır)
    return this.o.strict && ctx.depth === 0 ? out : this.mergePairs(out);
  }

  usesArguments(f) {
    if (t.isArrowFunctionExpression(f)) return false;
    let found = false;
    const walk = (n) => {
      if (found || !n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n !== f && t.isFunction(n) && !t.isArrowFunctionExpression(n)) return;
      if (t.isIdentifier(n, { name: 'arguments' })) { found = true; return; }
      for (const k of t.VISITOR_KEYS[n.type] ?? []) walk(n[k]);
    };
    walk(f.body);
    return found;
  }
}

// ── özet tablosu (E606 özet yorumlama, E607 özet tablosu, E608 yeniden kullanım) ─────
export class SummaryTable {
  constructor(root, o = {}) {
    this.root = root;
    this.table = new Map(); // fonksiyon kaynağının özeti → özet
    this.byNode = new WeakMap();
    this.o = { maxPaths: 16, ...o };
    this.hits = 0;
    this.misses = 0;
    this.building = new Set();
  }
  key(fnNode, src) { return fnv1a(src ?? `${fnNode.start}:${fnNode.end}`); }

  /** Fonksiyonun özeti: parametreler sembolik, her yol için (koşul, dönüş). Yan etkili/yaklaşık yollar özeti geçersiz kılar. */
  summarize(fnNode, src) {
    if (this.byNode.has(fnNode)) return this.byNode.get(fnNode);
    const key = this.key(fnNode, src);
    if (this.table.has(key) && this.table.get(key).node === fnNode) { this.byNode.set(fnNode, this.table.get(key)); return this.table.get(key); }
    if (this.building.has(fnNode)) return null; // özyineleme
    this.building.add(fnNode);
    const params = fnNode.params.map((p, i) => V(`${fnNode.id?.name ?? 'f'}.p${i}`, 'any'));
    const ex = new Exec(this.root, { maxSteps: 4000, maxStates: this.o.maxPaths, unroll: 3, timeMs: 600, summaries: this, prune: true, solverCalls: 40 });
    const r = ex.runFunction(fnNode, params);
    this.building.delete(fnNode);
    const cases = [];
    let valid = !r.stats.exhausted;
    for (const p of r.paths) {
      if (p.status === 'abort' || p.approx || p.effects.length || p.status !== 'return' || !isTerm(p.value)) { valid = false; continue; }
      cases.push({ pc: p.pc, ret: p.value });
    }
    const summary = {
      node: fnNode, name: fnNode.id?.name ?? '<anonim>', params, cases, valid: valid && cases.length > 0,
      paths: r.paths.length, stats: r.stats,
      text: cases.map((c) => `${c.pc.length ? c.pc.map((x) => show(x)).join(' && ') : 'true'} ⇒ ${show(c.ret)}`),
    };
    this.table.set(key, summary);
    this.byNode.set(fnNode, summary);
    return summary;
  }

  /** Çağrı yerinde özet: argümanlar yerine konur, yollar ite zinciri olur (E608) */
  instantiate(fnNode, args, ex) {
    if (!t.isFunctionDeclaration(fnNode) || fnNode.params.some((p) => !t.isIdentifier(p))) return null;
    if (!args.every(isTerm)) return null;
    const sm = this.summarize(fnNode);
    if (!sm || !sm.valid) { this.misses++; return null; }
    const sub = new Map(sm.params.map((p, i) => [p.name, args[i] ?? UNDEF]));
    let v = null;
    for (let i = sm.cases.length - 1; i >= 0; i--) {
      const c = sm.cases[i];
      const ret = substitute(c.ret, sub);
      const guard = c.pc.reduce((p, x) => mk('&&', p, substitute(x, sub)), TRUE);
      v = v === null ? ret : mk('ite', guard, ret, v);
    }
    this.hits++;
    return v;
  }
}

export { isTerm, termVars };
