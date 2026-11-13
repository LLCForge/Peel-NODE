import * as t from '@babel/types';
import { gen } from '../../util/ast.js';
import { literalOf } from '../../util/literal.js';
import { walk, namesIn, isRefPos, ifChainNodes } from './detect.js';
import {
  Env, Entry, C, E, HOLE, fail, Unsupported, ev, exec, leaf, mapLeaves, leavesOf, concreteEntry,
  evalStatementExpr, flush, emit,
} from './interp.js';

// Bytecode VM'i somut bytecode ile kısmen değerlendirerek (Futamura izdüşümü) düz koda çevirir.
//
//  1. Keşif: VM'in giriş durumundan başlayarak her döngü turu (bir komut) sembolik yığınla yürütülür;
//     durum = (pc ve diğer somut değişkenler, yığın derinliği ve yığındaki somut değerler).
//  2. Bloklar: tek öncülü olan ve öncülü dallanmayan durumlar öncülüyle aynı blokta kalır; yığın
//     değerleri blok içinde ifade olarak taşınır, blok sınırında _s0, _s1… yuva değişkenlerine yazılır.
//  3. Çıktı: blok başına bir case içeren pc makinesi (var _pc = 0; while (_pc !== -1) switch (_pc) …).
//     unflatten pass'i bunu bir sonraki turda if/while yapısına çevirir (E650).

const MAX_STATES = 6000;
const MAX_CHAIN = 4000;
const SEM_DEPTH = 8;
const SEM_PC = 100000;

// ── ad sınıflandırması ──────────────────────────────────

function inside(p, ancestor) {
  return p === ancestor || Boolean(p.findParent((x) => x === ancestor));
}

function classify(vm) {
  const loop = vm.loopPath;
  const fnNode = vm.fnPath.isProgram() ? null : vm.fnPath.node;
  const tableFns = new Set(vm.style === 'table' ? vm.handlers.map((h) => h.fn) : []);
  const inRegion = (p) => inside(p, loop) || [...tableFns].some((f) => p.findParent((x) => x.node === f));
  const fnOf = (p) => {
    let f = p.getFunctionParent();
    while (f && tableFns.has(f.node)) f = f.parentPath.getFunctionParent();
    return f?.node ?? null;
  };
  // ad → bağlama: döngüdeki adlar döngü kapsamında, tablo handler'larındaki adlar kendi fonksiyon kapsamında çözülür
  const lookups = new Map();
  const visit = (node, scope) => walk(node, (n, par, k) => {
    if (!t.isIdentifier(n) || !isRefPos(par, k)) return;
    const b = scope.getBinding(n.name) ?? null;
    // farklı handler fonksiyonlarının kendi yerelleri (her çağrıda yeni) aynı adı taşıyabilir
    const ownLocal = (x) => x && tableFns.has(x.scope.getFunctionParent()?.path.node);
    if (lookups.has(n.name) && lookups.get(n.name) !== b && !(ownLocal(b) && ownLocal(lookups.get(n.name)))) fail(`ad çakışması: ${n.name}`);
    lookups.set(n.name, b);
  });
  visit(loop.node, loop.scope);
  for (const h of vm.style === 'table' ? vm.handlers : []) visit(h.fn, h.fnPath.scope);
  const names = new Set(lookups.keys());

  const internal = new Set();
  const dataVars = new Set();
  const locals = new Set();
  const writeback = new Set();
  const external = new Set();
  let stackWriteback = false;
  let stackFresh = true;
  const roles = vm.roles;
  for (const name of names) {
    const b = lookups.get(name);
    if (!b) { external.add(name); continue; }
    const ownerFn = b.scope.getFunctionParent()?.path.node ?? null;
    const inHandlerFn = tableFns.has(ownerFn);
    const inVmFn = ownerFn === fnNode || (b.scope.path.isProgram() && !fnNode) || inHandlerFn;
    if (!inVmFn && !inside(b.path, loop)) { external.add(name); continue; }
    const refs = [...b.referencePaths, ...b.constantViolations];
    const captured = refs.some((p) => fnOf(p) !== fnNode) || (b.path.isVariableDeclarator() && fnOf(b.path) !== fnNode && !inside(b.path, loop));
    const declInLoop = inside(b.path, loop) || inHandlerFn;
    const assigned = b.constantViolations.some(inRegion) || (declInLoop && b.path.isVariableDeclarator() && b.path.node.init);
    const outside = refs.filter((p) => !inRegion(p));
    if (name === roles.stack) {
      if (captured) fail('yığın bir closure tarafından yakalanıyor');
      if (b.constantViolations.some(inRegion)) fail('yığın döngüde yeniden atanıyor');
      stackWriteback = outside.some((p) => !b.constantViolations.includes(p) || inside(p, loop));
      // yığın dışarıdan gelen bir diziyse (S = K[4]) her çıkışta (return dahil) son içerik geri yazılır
      const init = b.path.isVariableDeclarator() ? b.path.node.init : null;
      stackFresh = Boolean(init && t.isArrayExpression(init) && !init.elements.length && !b.constantViolations.length);
      if (!stackFresh) stackWriteback = true;
      continue;
    }
    if (!assigned) {
      if (!captured || b.constant) locals.add(name); else external.add(name);
      continue;
    }
    if (captured) {
      if ([roles.pc, roles.sp].includes(name)) fail(`${name} bir closure tarafından yakalanıyor`);
      external.add(name);
      continue;
    }
    // veri taşıyan değişken (x = x * 2): somut değeri yalnızca gözlenmiş bir girdiye dayanırdı → turlar arası
    // taşınırsa (durum değişkeni olursa) gerçek değişken olarak bırakılır (makeLifter'da)
    if (![roles.pc, roles.sp, roles.op].includes(name) && !concreteIntent(b, inRegion, roles)) dataVars.add(name);
    if (!outside.length || declInLoop) { internal.add(name); continue; }
    if ([roles.pc, roles.sp, roles.op].includes(name) || concreteIntent(b, inRegion, roles)) {
      internal.add(name);
      writeback.add(name);
    } else {
      external.add(name);
    }
  }
  // kaçmayan yerel diziler: yalnızca X[…] biçiminde kullanılan, literal ile oluşturulmuş, closure'a girmeyen
  const plainArrays = new Set();
  for (const name of locals) {
    const b = loop.scope.getBinding(name);
    if (!b?.path.isVariableDeclarator() || b.constantViolations.length || !t.isArrayExpression(b.path.node.init)) continue;
    if (b.referencePaths.every((r) => r.parentPath.isMemberExpression({ object: r.node }) && fnOf(r) === fnNode &&
        !(r.parentPath.parentPath.isCallExpression({ callee: r.parent })))) plainArrays.add(name);
  }
  return { internal, locals, writeback, external, stackWriteback, stackFresh, inRegion, plainArrays, dataVars };
}

// Döngüdeki tüm atamaları somut değer üreten (literal, sayaç, bytecode okuması) değişken
function concreteIntent(b, inRegion, roles) {
  // parametre ya da literal olmayan başlangıç: değer çağırandan/veriden gelir (s += "b" bir sayaç değildir)
  if (b.kind === 'param') return false;
  if (b.path.isVariableDeclarator() && b.path.node.init && !t.isLiteral(b.path.node.init) &&
      !(t.isUnaryExpression(b.path.node.init) && t.isLiteral(b.path.node.init.argument))) return false;
  const ok = new Set([roles.code, roles.pc, roles.consts, roles.op, roles.sp].filter(Boolean));
  return b.constantViolations.filter(inRegion).every((p) => {
    const n = p.node;
    if (t.isUpdateExpression(n)) return true;
    const rhs = t.isAssignmentExpression(n) ? n.right : t.isVariableDeclarator(n) ? n.init : null;
    if (!rhs) return false;
    let pure = true;
    walk(rhs, (x, par, k) => {
      if (t.isCallExpression(x) || t.isNewExpression(x)) pure = false;
      if (t.isIdentifier(x) && isRefPos(par, k) && !ok.has(x.name)) pure = false;
    });
    return pure;
  });
}

// ── durum değişkenleri: bir turdan diğerine taşınması gerekenler ──

function firstUse(stmts, v) {
  for (const s of stmts) {
    // handler sonu: sonraki case'lere düşülmez
    if (t.isBreakStatement(s) || t.isContinueStatement(s)) return null;
    if (t.isReturnStatement(s) || t.isThrowStatement(s)) return s.argument && namesIn(s.argument).has(v) ? 'read' : null;
    if (t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression, { operator: '=' }) && t.isIdentifier(s.expression.left, { name: v })) {
      return namesIn(s.expression.right).has(v) ? 'read' : 'write';
    }
    if (t.isVariableDeclaration(s)) {
      let r = null;
      for (const d of s.declarations) {
        if (r) break;
        if (d.init && namesIn(d.init).has(v)) r = 'read';
        else if (d.init && t.isIdentifier(d.id, { name: v })) r = 'write';
      }
      if (r) return r;
      continue;
    }
    if (namesIn(s).has(v)) return 'read';
  }
  return null;
}

function handlerLists(vm) {
  if (vm.style === 'switch') return vm.dispatch.cases.map((c, i) => vm.dispatch.cases.slice(i).flatMap((x) => x.consequent));
  if (vm.style === 'if-chain') return vm.handlers.map((h) => (t.isBlockStatement(h.node) ? h.node.body : [h.node]));
  return vm.handlers.map((h) => h.fn.body.body);
}

function stateVarsOf(vm, internal) {
  const pre = vm.body.slice(0, vm.dispatchIndex);
  const post = vm.body.slice(vm.dispatchIndex + 1);
  // döngü koşulu, güncellemesi ve dağıtım ifadesinin her turda okuduğu adlar
  const ctl = new Set([...(vm.test ? namesIn(vm.test) : []), ...(vm.update ? namesIn(vm.update) : []),
    ...(vm.style === 'table' ? namesIn(vm.disc) : [])]);
  const lists = handlerLists(vm);
  const state = new Set();
  for (const v of internal) {
    if (ctl.has(v) || v === vm.roles.pc || v === vm.roles.sp) { state.add(v); continue; }
    const p = firstUse(pre, v);
    if (p === 'write') continue;
    if (p === 'read') { state.add(v); continue; }
    if (vm.style === 'if-chain' && namesIn(vm.dispatch.test).has(v)) { state.add(v); continue; }
    if (lists.some((l) => firstUse([...l, ...post], v) === 'read')) state.add(v);
  }
  return state;
}

// ── lifter bağlamı ──────────────────────────────────────

export function collectNames(ast) {
  const used = new Set();
  walk(ast.program ?? ast, (n) => { if (t.isIdentifier(n)) used.add(n.name); });
  return used;
}

export function makeLifter(vm, values, { used = new Set(), mode = 'lift' } = {}) {
  const cls = classify(vm);
  const roles = vm.roles;
  const arrays = new Map(values.arrays);
  for (const name of arrays.keys()) {
    cls.internal.delete(name);
    cls.locals.add(name);
  }
  let stateVars = stateVarsOf(vm, cls.internal);
  // yalnızca kontrol değişkenleri (pc, sp, bayraklar) somut durum olabilir; veri taşıyanlar gerçek değişken kalır
  const data = [...stateVars].filter((n) => cls.dataVars.has(n));
  if (data.length) {
    for (const n of data) { cls.internal.delete(n); cls.writeback.delete(n); cls.external.add(n); }
    stateVars = stateVarsOf(vm, cls.internal);
  }
  const gensyms = new Map();
  const L = {
    vm, mode, values, ...cls, stateVars, arrays,
    stackName: roles.stack, codeName: roles.code, pcName: roles.pc, regsName: roles.regs, label: vm.label,
    temps: new Set(), slots: new Map(), countCache: new Map(), curList: null,
    dispatchStmt: vm.style === 'switch' || vm.style === 'table' ? vm.dispatch : null,
    regsSeen: new Set(), iter: { pc: null, reads: [], op: undefined }, opCounter: 0,
    chainNodes: vm.style === 'if-chain' ? ifChainNodes(vm.dispatch) : null,
    semJumps: [],
    gensym(prefix) {
      const n = gensyms.get(prefix) ?? 0;
      for (let i = n; ; i++) {
        const name = `${prefix}${i}`;
        if (!used.has(name)) { used.add(name); gensyms.set(prefix, i + 1); return name; }
      }
    },
    slot(i) {
      if (!L.slots.has(i)) L.slots.set(i, L.gensym('_s'));
      return L.slots.get(i);
    },
    isBound(name) { return Boolean(vm.loopPath.scope.getBinding(name)); },
    codeRead(env, i) {
      if (L.mode === 'sem') return E(L.placeholderRead(env));
      L.iter.reads.push(i);
      const code = arrays.get(L.codeName);
      if (i >= code.length) return C(undefined);
      const v = code[i];
      if (v === HOLE) fail('bytecode elemanı ilkel değil');
      return C(v);
    },
    noteCodeRead(i) { L.iter.reads.push(i); },
    noteOp(d) { if (L.iter.op === undefined) L.iter.op = d; },
    placeholderRead() {
      const e = new Entry(t.identifier(`$op${L.opCounter++}`), false);
      return e;
    },
    semJump(env, v) { env.semJump = v; env.conc.delete(L.pcName); },
    dispatchTable(env, ctx) {
      const iv = ev(vm.disc, env);
      if (iv.k !== 'c' && !(iv.k === 'e' && iv.e.hasC)) fail('tablo indeksi sembolik');
      const key = iv.k === 'c' ? iv.v : iv.e.c;
      L.noteOp(key);
      const h = vm.handlers.find((x) => x.key === key || String(x.key) === String(key));
      if (!h) fail(`tabloda handler yok: ${key}`);
      const prev = L.curList;
      L.curList = h.fn.body.body;
      L.inTableFn = true;
      let tree;
      try { tree = exec(h.fn.body.body, env, { ...ctx, brk: 'fn' }); } finally { L.inTableFn = false; L.curList = prev; }
      return mapLeaves(tree, (lf) => (lf.end === 'fret' ? { ...lf, end: 'fall' } : lf));
    },
  };
  if (mode === 'lift' && !arrays.has(L.codeName)) fail('bytecode değeri bilinmiyor');
  return L;
}

// ── tur yürütme ─────────────────────────────────────────

function settle(env) {
  if (env.pending && !env.stack.includes(env.pending)) flush(env, env.pending);
}

function finishIteration(L, env) {
  if (L.vm.opVar && env.conc.has(L.vm.opVar)) L.noteOp(env.conc.get(L.vm.opVar));
  settle(env);
  for (const [name, v] of env.sym) {
    if (L.stateVars.has(name)) fail(`durum değişkeni sembolik: ${name}`);
    if (v.k === 'arr' && v.a.items.some((e) => e.eff && !e.used)) fail('kullanılmayan etkili değer');
  }
  env.sym.clear();
  for (const name of [...env.conc.keys()]) if (!L.stateVars.has(name)) env.conc.delete(name);
  for (const name of L.stateVars) if (!env.conc.has(name) && L.mode !== 'sem') fail(`durum değişkeni bilinmiyor: ${name}`);
  return leaf(env, 'next');
}

export function runIteration(L, env, first) {
  L.iter = { pc: env.conc.get(L.pcName), reads: [], op: undefined };
  const vm = L.vm;
  if (vm.test && !(vm.kind === 'do' && first)) {
    const tv = ev(vm.test, env);
    const known = tv.k === 'c' || (tv.k === 'e' && tv.e.hasC);
    if (!known) fail('döngü koşulu sembolik');
    if (!(tv.k === 'c' ? tv.v : tv.e.c)) return leaf(env, 'exit');
  }
  L.curList = vm.body;
  const tree = exec(vm.body, env, { brk: 'vm', cont: 'vm', depth: 0 });
  return mapLeaves(tree, (lf) => {
    if (lf.end === 'fall' || lf.end === 'cont') {
      if (vm.update) evalStatementExpr(lf.env, vm.update);
      return finishIteration(L, lf.env);
    }
    if (lf.end === 'exit' || lf.end === 'ret') {
      if (vm.opVar && lf.env.conc.has(vm.opVar)) L.noteOp(lf.env.conc.get(vm.opVar));
      return lf;
    }
    return fail(`beklenmeyen kontrol akışı: ${lf.end}`);
  });
}

// ── durumlar ────────────────────────────────────────────

const tag = (v) => (v === undefined ? 'u' : typeof v === 'number' ? (Object.is(v, -0) ? 'n-0' : `n${v}`) : typeof v === 'string' ? `s${v}` : `${typeof v}${String(v)}`);

function snapshot(L, env, first) {
  return {
    conc: [...L.stateVars].sort().map((n) => [n, env.conc.get(n)]),
    stack: env.stack.map((e) => (e.hasC ? { c: e.c } : null)),
    first,
  };
}

const keyOf = (st) => JSON.stringify([st.conc.map(([n, v]) => `${n}=${tag(v)}`), st.stack.map((s) => (s ? tag(s.c) : '*')), st.first]);

function slotEntry(L, i) {
  return new Entry(t.identifier(L.slot(i)), false);
}

function envFromState(L, st) {
  const env = new Env(L);
  env.conc = new Map(st.conc);
  env.stack = st.stack.map((s, i) => (s ? concreteEntry(s.c) : slotEntry(L, i)));
  return env;
}

export function initialState(L) {
  const { state, stackInit = 0, first = true } = L.values;
  const conc = [...L.stateVars].sort().map((n) => {
    if (!state.has(n)) fail(`başlangıç değeri bilinmiyor: ${n}`);
    return [n, state.get(n)];
  });
  return { conc, stack: Array.from({ length: stackInit }, () => null), first: L.vm.kind === 'do' ? first : false };
}

export function explore(L, init) {
  const states = new Map();
  const order = [];
  const queue = [init];
  const preds = new Map([[keyOf(init), 1]]);
  while (queue.length) {
    const st = queue.shift();
    const key = keyOf(st);
    if (states.has(key)) continue;
    if (states.size >= MAX_STATES) fail('durum sayısı sınırı aşıldı');
    const env = envFromState(L, st);
    const tree = runIteration(L, env, st.first);
    const info = {
      key, st, index: order.length, pc: L.iter.pc, op: L.iter.op, reads: L.iter.reads.slice(), depth: st.stack.length,
      succ: [], ends: [], leaves: 0, fork: Boolean(tree.fork),
    };
    for (const lf of leavesOf(tree)) {
      info.leaves++;
      info.ends.push(lf.end);
      if (lf.end !== 'next') continue;
      const s2 = snapshot(L, lf.env, false);
      const k2 = keyOf(s2);
      info.succ.push(k2);
      preds.set(k2, (preds.get(k2) ?? 0) + 1);
      queue.push(s2);
    }
    states.set(key, info);
    order.push(info);
  }
  return { states, order, entry: keyOf(init), preds };
}

// ── kod üretimi ─────────────────────────────────────────

function canon(L, env) {
  const assigns = [];
  env.stack.forEach((e, i) => {
    if (e.hasC) return;
    const name = L.slot(i);
    if (t.isIdentifier(e.node, { name })) return;
    assigns.push([name, e]);
  });
  const names = new Set(assigns.map(([n]) => n));
  const hazard = assigns.some(([name, e]) => [...namesIn(e.node)].some((x) => names.has(x) && x !== name));
  const out = [];
  if (hazard) {
    const tmps = assigns.map(([, e]) => {
      const tmp = L.gensym('_t');
      L.temps.add(tmp);
      out.push(t.expressionStatement(t.assignmentExpression('=', t.identifier(tmp), e.node)));
      return tmp;
    });
    assigns.forEach(([name], i) => out.push(t.expressionStatement(t.assignmentExpression('=', t.identifier(name), t.identifier(tmps[i])))));
  } else {
    for (const [name, e] of assigns) out.push(t.expressionStatement(t.assignmentExpression('=', t.identifier(name), e.node)));
  }
  return out;
}

function exitWriteback(L, env, stackOnly = false) {
  settle(env);
  for (const name of stackOnly ? [] : L.writeback) {
    if (!env.conc.has(name)) continue;
    const lit = literalOf(t, env.conc.get(name));
    if (!lit) fail(`geri yazılamayan değer: ${name}`);
    emit(env, t.expressionStatement(t.assignmentExpression('=', t.identifier(name), lit)), []);
  }
  if (L.stackWriteback) {
    const S = t.identifier(L.stackName);
    const nodes = env.stack.map((e) => t.cloneNode(e.node, true));
    if ((L.values.stackInit ?? 0) > 0 || !L.stackFresh) env.out.push(t.expressionStatement(t.assignmentExpression('=', t.memberExpression(S, t.identifier('length')), t.numericLiteral(0))));
    if (nodes.length) env.out.push(t.expressionStatement(t.callExpression(t.memberExpression(t.cloneNode(S), t.identifier('push')), nodes)));
    env.pending = null;
  }
  return env.out;
}

export function codegen(L, ex) {
  const { states, order, entry, preds } = ex;
  const predOf = new Map();
  for (const info of order) for (const k of info.succ) if (!predOf.has(k)) predOf.set(k, info);
  const isLeader = (k) => k === entry || preds.get(k) !== 1 || (predOf.get(k)?.leaves ?? 0) > 1;
  const leaders = order.filter((i) => isLeader(i.key));
  const ids = new Map(leaders.map((i, n) => [i.key, n]));
  const single = leaders.length === 1 && preds.get(entry) === 1;
  const pcVar = single ? null : L.gensym('_pc');
  const setPc = (v) => t.expressionStatement(t.assignmentExpression('=', t.identifier(pcVar), v < 0 ? t.unaryExpression('-', t.numericLiteral(1)) : t.numericLiteral(v)));
  let steps = 0;

  const conv = (tree) => {
    if (tree.fork) {
      return [...tree.out, t.ifStatement(tree.test, t.blockStatement(conv(tree.yes)), t.blockStatement(conv(tree.no)))];
    }
    const env = tree.env;
    if (tree.end === 'ret') {
      if (!L.stackWriteback || L.stackFresh || !L.stackName) return env.out;
      // dışarıdan görünen yığın: dönüş değeri hesaplandıktan sonra, dönmeden önce yığın geri yazılır
      const last = env.out.pop();
      const tmp = L.gensym('_t');
      L.temps.add(tmp);
      const arg = last.argument ?? t.identifier('undefined');
      env.out.push(t.expressionStatement(t.assignmentExpression('=', t.identifier(tmp), arg)));
      const wb = exitWriteback(L, env, true);
      return [...wb, t.isThrowStatement(last) ? t.throwStatement(t.identifier(tmp)) : t.returnStatement(t.identifier(tmp))];
    }
    if (tree.end === 'exit') {
      const out = exitWriteback(L, env);
      return single ? out : [...out, setPc(-1)];
    }
    const k = keyOf(snapshot(L, env, false));
    if (!states.has(k)) fail('keşfedilmemiş durum');
    if (isLeader(k)) return [...env.out, ...canon(L, env), setPc(ids.get(k))];
    if (++steps > MAX_CHAIN * 4) fail('blok zinciri çok uzun');
    const pre = env.out;
    env.out = [];
    return [...pre, ...conv(runIteration(L, env, false))];
  };

  const blocks = leaders.map((info) => {
    const env = envFromState(L, info.st);
    return { id: ids.get(info.key), pc: info.pc, stmts: conv(runIteration(L, env, info.st.first)) };
  });

  const usedNames = new Set();
  for (const b of blocks) for (const st of b.stmts) walk(st, (n) => { if (t.isIdentifier(n)) usedNames.add(n.name); });
  const init = L.values.stackInit ?? 0;
  for (let i = 0; i < init; i++) usedNames.add(L.slot(i));
  const decls = [...L.temps, ...L.slots.values()].filter((n) => usedNames.has(n));
  const out = [];
  if (decls.length) out.push(t.variableDeclaration('var', decls.map((n) => t.variableDeclarator(t.identifier(n)))));
  for (let i = 0; i < init; i++) {
    out.push(t.expressionStatement(t.assignmentExpression('=', t.identifier(L.slot(i)),
      t.memberExpression(t.identifier(L.stackName), t.numericLiteral(i), true))));
  }
  if (single) {
    out.push(...blocks[0].stmts);
  } else {
    out.push(t.variableDeclaration('var', [t.variableDeclarator(t.identifier(pcVar), t.numericLiteral(0))]));
    const cases = blocks.map((b) => t.switchCase(t.numericLiteral(b.id), [...b.stmts, t.breakStatement()]));
    out.push(t.whileStatement(
      t.binaryExpression('!==', t.identifier(pcVar), t.unaryExpression('-', t.numericLiteral(1))),
      t.blockStatement([t.switchStatement(t.identifier(pcVar), cases)])));
  }
  return { stmts: out, blocks: blocks.map((b) => ({ id: b.id, pc: b.pc })), single };
}

// ── disassembly, IR, segmentasyon ───────────────────────

export function disassemble(L, ex, names = new Map()) {
  const code = L.arrays.get(L.codeName);
  const byPc = new Map();
  for (const info of ex.order) {
    if (info.pc === undefined || byPc.has(info.pc)) continue;
    const reads = [...new Set(info.reads)].sort((a, b) => a - b);
    const operands = reads.filter((i) => i !== info.reads[0]).map((i) => code[i]);
    byPc.set(info.pc, {
      pc: info.pc, op: info.op, mnemonic: names.get(info.op) ?? `OP_${String(info.op)}`,
      operands, reads, depth: info.depth, exits: [...new Set(info.ends)],
    });
  }
  const list = [...byPc.values()].sort((a, b) => (typeof a.pc === 'number' && typeof b.pc === 'number' ? a.pc - b.pc : 0));
  // erişilen bytecode indeksleri dışındaki aralıklar: veri ya da ulaşılmayan kod (E647)
  const covered = new Set(list.flatMap((x) => x.reads));
  const gaps = [];
  let start = null;
  for (let i = 0; i <= code.length; i++) {
    const hole = i < code.length && !covered.has(i);
    if (hole && start === null) start = i;
    if (!hole && start !== null) { gaps.push([start, i - 1]); start = null; }
  }
  return { list, gaps, length: code.length };
}

export function formatDisasm(dis, constsOf = () => null) {
  return dis.list.map((x) => {
    const comment = constsOf(x);
    const ops = x.operands.map((o) => JSON.stringify(o)).join(', ');
    return `${String(x.pc).padStart(5, '0')}  ${x.mnemonic.padEnd(14)} ${ops.padEnd(14)}${comment ? ` ; ${comment}` : ''}  [d=${x.depth}]`;
  }).join('\n');
}

// Temel bloklar (E647): giriş, dallanma hedefleri ve birden çok öncüllü pc'ler
export function basicBlocks(ex) {
  const order = ex.order.filter((i) => typeof i.pc === 'number');
  const pcOf = new Map(ex.order.map((i) => [i.key, i.pc]));
  const predCount = new Map();
  const leaders = new Set([pcOf.get(ex.entry)]);
  for (const info of order) {
    const succPcs = [...new Set(info.succ.map((k) => pcOf.get(k)))];
    for (const p of succPcs) predCount.set(p, (predCount.get(p) ?? 0) + 1);
    if (info.leaves > 1 || info.ends.some((e) => e !== 'next')) succPcs.forEach((p) => leaders.add(p));
  }
  for (const [p, n] of predCount) if (n > 1) leaders.add(p);
  const sorted = [...new Set(order.map((i) => i.pc))].sort((a, b) => a - b);
  const blocks = [];
  let cur = null;
  for (const pc of sorted) {
    if (!cur || leaders.has(pc)) { cur = { start: pc, pcs: [] }; blocks.push(cur); }
    cur.pcs.push(pc);
  }
  return blocks;
}

// Komut başına yuva biçimli ara gösterim (E649): her komut kendi başına, yığın yuvalarıyla
export function lowerIR(L, ex, names = new Map()) {
  const out = [];
  const seen = new Set();
  for (const info of ex.order) {
    if (seen.has(info.pc)) continue;
    seen.add(info.pc);
    const env = envFromState(L, info.st);
    let tree;
    try { tree = runIteration(L, env, info.st.first); } catch (e) { if (e instanceof Unsupported) continue; throw e; }
    const conv = (tr) => {
      if (tr.fork) return [`if (${gen(tr.test)}) {`, ...conv(tr.yes).map((s) => `  ${s}`), '} else {', ...conv(tr.no).map((s) => `  ${s}`), '}'];
      const lines = tr.env.out.map((s) => gen(s));
      if (tr.end === 'next') {
        const st = snapshot(L, tr.env, false);
        lines.push(...canon(L, tr.env).map((s) => gen(s)));
        const pc = st.conc.find(([n]) => n === L.pcName)?.[1];
        lines.push(`goto ${pc}`);
      } else if (tr.end === 'exit') lines.push('halt');
      return lines;
    };
    out.push({ pc: info.pc, op: info.op, mnemonic: names.get(info.op) ?? `OP_${String(info.op)}`, lines: conv(tree) });
  }
  return out.sort((a, b) => a.pc - b.pc);
}

// ── handler semantiği (E651) ────────────────────────────
// Handler, yığında 8 yer tutucu ($s0 = tepe) ve bytecode işlenenleri için yer tutucularla ($op0…) yürütülür.

function placeholders(n) {
  return Array.from({ length: n }, (_, i) => new Entry(t.identifier(`$s${n - 1 - i}`), false));
}

// Ağacın yapraklarını etki tanımına çevirir; depth: başlangıçtaki yer tutucu sayısı
function describeTree(L, tree, depth, nextPc) {
  const describe = (lf) => {
    settle(lf.env);
    const st = lf.env.stack;
    let keep = 0;
    while (keep < st.length && t.isIdentifier(st[keep].node, { name: `$s${depth - 1 - keep}` })) keep++;
    const pops = depth - keep;
    const pushes = st.slice(keep).map((e) => gen(e.node));
    let jump = null;
    if (lf.env.semJump) jump = lf.env.semJump.k === 'c' ? String(lf.env.semJump.v) : gen(lf.env.semJump.e?.node ?? t.identifier('?'));
    const pc = lf.env.conc.get(L.pcName);
    if (jump === null && typeof pc === 'number' && lf.end !== 'exit' && lf.end !== 'ret') {
      const seq = nextPc(pc);
      if (seq !== null && pc !== seq) jump = String(pc);
    }
    const end = ['fret', 'brk', 'next', 'fall', 'cont'].includes(lf.end) ? 'fall' : lf.end;
    return { end, pops, pushes, stmts: lf.env.out.map((x) => gen(x)), jump };
  };
  const paths = [];
  const walkTree = (tr, cond) => {
    if (tr.fork) {
      walkTree(tr.yes, [...cond, gen(tr.test)]);
      walkTree(tr.no, [...cond, `!(${gen(tr.test)})`]);
    } else {
      paths.push({ cond, ...describe(tr) });
    }
  };
  walkTree(tree, []);
  return { ok: true, prefix: tree.fork ? tree.out.map((x) => gen(x)) : [], paths };
}

// Genel anlam: işlenenler yer tutucu ($op0…), yığın 8 yer tutucu
export function handlerSemantics(vm, values, handler) {
  try {
    const L = makeLifter(vm, { ...values, arrays: new Map(values.arrays ?? []) }, { used: new Set(), mode: 'sem' });
    L.stateVars = new Set();
    const env = new Env(L);
    env.stack = placeholders(SEM_DEPTH);
    env.conc.set(L.pcName, SEM_PC);
    if (vm.roles.sp) env.conc.set(vm.roles.sp, SEM_DEPTH);
    if (vm.opVar) env.conc.set(vm.opVar, handler.key);
    if (!L.arrays.has(L.codeName)) L.arrays.set(L.codeName, []);
    const list = handlerLists(vm)[handler.index];
    L.curList = list;
    let tree;
    try {
      if (vm.style === 'table') L.inTableFn = true;
      tree = exec(list, env, { brk: vm.style === 'switch' ? 'switch' : vm.style === 'table' ? 'fn' : 'vm', cont: 'vm', depth: 0 });
    } finally { L.inTableFn = false; }
    const r = describeTree(L, tree, SEM_DEPTH, () => SEM_PC + L.opCounter);
    // pc ilerlemesi işlenen sayısından farklıysa (ör. pc += 2 atlaması) zaten jump olarak işaretlendi
    return { ...r, operands: L.opCounter, generic: true };
  } catch (e) {
    if (e instanceof Unsupported) return { ok: false, reason: e.message };
    throw e;
  }
}

// Somut örnek üzerinden anlam: keşifte görülen bir komut, gerçek işlenenleriyle (genel anlam çıkarılamazsa)
export function instanceSemantics(L, info) {
  try {
    const env = new Env(L);
    env.conc = new Map(info.st.conc);
    const depth = Math.max(SEM_DEPTH, info.st.stack.length);
    env.stack = placeholders(depth);
    const tree = runIteration(L, env, info.st.first);
    const code = L.arrays.get(L.codeName);
    const next = info.reads.length ? Math.max(...info.reads) + 1 : null;
    const r = describeTree(L, tree, depth, () => (next !== null && next <= code.length ? next : null));
    return { ...r, operands: Math.max(0, new Set(info.reads).size - 1), generic: false };
  } catch (e) {
    if (e instanceof Unsupported) return { ok: false, reason: e.message };
    throw e;
  }
}

export { keyOf, snapshot, envFromState };
