import * as t from '@babel/types';

// Fonksiyon gövdesi için CFG + SSA (E681 kurulum, E682 φ yerleştirme, E683 SSA bozma, E684 fazla φ eleme).
// Desteklenen alt küme: blok, değişken bildirimi, ifade, if, while, do-while, for, for-in/of, switch, etiketli
// döngü/blok, break/continue, return, throw. try/with/eval içeren fonksiyonlar null döner (atlanır).
// İzlenen değişkenler: fonksiyonun kendi yerel bağlamaları (param/var/let/const), iç fonksiyonlarca yakalanmayan,
// koşullu alt ifadelerde ya da yapı bozmada tanımlanmayan. Diğer her şey bellek sayılır.

let blockSeq = 0;
const newBlock = (fx) => {
  const b = { id: blockSeq++, instrs: [], succ: [], pred: [], phis: new Map(), dead: false };
  fx.blocks.push(b);
  return b;
};
const edge = (from, to, cond = null, at = null) => {
  if (!from || !to) return;
  from.succ.push({ to, cond, at });
  to.pred.push(from);
};

// ── ön denetim: izlenebilir değişkenler ────────────────
function analyzeVars(fnPath) {
  const tracked = new Map(); // binding → { name, kind, binding }
  let ok = true;
  const own = (b) => {
    let s = b.scope;
    while (s && !s.path.isFunction() && !s.path.isProgram()) s = s.parent;
    return s?.path === fnPath;
  };
  const isStrict = fnPath.isInStrictMode?.() ?? false;
  let usesArguments = false;
  fnPath.traverse({
    WithStatement() { ok = false; },
    TryStatement() { ok = false; },
    CallExpression(p) { if (t.isIdentifier(p.node.callee, { name: 'eval' }) && !p.scope.getBinding('eval')) ok = false; },
    Identifier(p) {
      if (p.node.name === 'arguments' && p.isReferencedIdentifier() && p.getFunctionParent() === fnPath) usesArguments = true;
    },
    Function(p) { p.skip(); },
  });
  if (!ok) return null;
  const all = new Set();
  fnPath.traverse({
    Scope(p) {
      if (p.isFunction() && p !== fnPath) return;
      for (const b of Object.values(p.scope.bindings)) if (own(b)) all.add(b);
    },
  });
  for (const b of Object.values(fnPath.scope.bindings)) all.add(b);
  for (const b of all) {
    if (!['var', 'let', 'const', 'param'].includes(b.kind)) continue;
    if (!t.isIdentifier(b.identifier)) continue;
    if (b.kind === 'param' && (usesArguments && !isStrict)) continue; // sloppy arguments parametrelerle eşlenir
    if (b.kind === 'param' && !fnPath.node.params.some((p) => p === b.path.node || (t.isIdentifier(p) && p.name === b.identifier.name))) continue;
    if (b.kind !== 'param' && !(t.isVariableDeclarator(b.path.node) && t.isIdentifier(b.path.node.id))) continue;
    const refs = [...b.referencePaths, ...b.constantViolations];
    if (refs.some((r) => r.getFunctionParent() !== fnPath)) continue; // closure yakalaması
    let bad = false;
    for (const v of b.constantViolations) {
      if (v.isAssignmentExpression() && (!t.isIdentifier(v.node.left) || ['&&=', '||=', '??='].includes(v.node.operator))) bad = true;
      if (v.isForXStatement() && !t.isIdentifier(v.node.left) && !(t.isVariableDeclaration(v.node.left) && t.isIdentifier(v.node.left.declarations[0].id))) bad = true;
      if (!v.isAssignmentExpression() && !v.isUpdateExpression() && !v.isForXStatement() && !v.isVariableDeclarator()) bad = true;
      if (inConditionalExpr(v, fnPath)) bad = true;
    }
    if (inConditionalExpr(b.path, fnPath)) bad = true;
    if (bad) continue;
    tracked.set(b, { name: b.identifier.name, kind: b.kind, binding: b });
  }
  return { tracked, usesArguments };
}

// Tanım, ifade içinde koşullu çalışan bir alt ifadede mi? (a && (x = 1), c ? (x = 1) : 0, f?.(x = 1))
function inConditionalExpr(p, stop) {
  let cur = p;
  while (cur && cur !== stop && !cur.isStatement()) {
    const par = cur.parentPath;
    if (!par) break;
    if (par.isLogicalExpression() && cur.key === 'right') return true;
    if (par.isConditionalExpression() && cur.key !== 'test') return true;
    if (par.isOptionalCallExpression() || par.isOptionalMemberExpression()) return true;
    if (par.isAssignmentPattern() || par.isObjectPattern() || par.isArrayPattern()) return true;
    cur = par;
  }
  return false;
}

// ── CFG ───────────────────────────────────────────────
export function buildCfg(fnPath) {
  if (!fnPath.isFunction() || !t.isBlockStatement(fnPath.node.body) || fnPath.node.async || fnPath.node.generator) return null;
  const vars = analyzeVars(fnPath);
  if (!vars) return null;
  const fx = { fn: fnPath, blocks: [], vars, unsupported: null };
  fx.entry = newBlock(fx);
  fx.exit = newBlock(fx);
  const bodyStart = newBlock(fx);
  edge(fx.entry, bodyStart);
  const end = visitList(fx, fnPath.get('body.body'), bodyStart, { jumps: [] });
  edge(end, fx.exit, null, { kind: 'end', list: fnPath.get('body') });
  if (fx.unsupported) return null;
  return fx;
}

function visitList(fx, paths, cur, ctx) {
  for (const p of paths) {
    if (!cur) cur = newBlock(fx); // erişilemez kod: öncülsüz blok
    cur = visit(fx, p, cur, ctx);
  }
  return cur;
}

function afterAt(p) { return { kind: 'after', path: p }; }

function visit(fx, p, cur, ctx) {
  const n = p.node;
  const add = (kind, path) => cur.instrs.push({ kind, path, block: cur });
  switch (n.type) {
    case 'EmptyStatement': case 'DebuggerStatement': return cur;
    case 'BlockStatement': return visitList(fx, p.get('body'), cur, ctx);
    case 'ExpressionStatement': add('expr', p); return cur;
    case 'VariableDeclaration':
      for (const d of p.get('declarations')) add('decl', d);
      return cur;
    case 'FunctionDeclaration': case 'ClassDeclaration': add('opaque', p); return cur;
    case 'ReturnStatement': add('return', p); edge(cur, fx.exit, null, { kind: 'before', path: p }); return null;
    case 'ThrowStatement': add('throw', p); edge(cur, fx.exit, null, { kind: 'before', path: p }); return null;
    case 'IfStatement': {
      add('test', p.get('test'));
      const T = newBlock(fx);
      const F = newBlock(fx);
      edge(cur, T, { path: p.get('test'), value: true });
      edge(cur, F, { path: p.get('test'), value: false });
      const tEnd = visit(fx, p.get('consequent'), T, ctx);
      const fEnd = n.alternate ? visit(fx, p.get('alternate'), F, ctx) : F;
      if (!tEnd && !fEnd) return null;
      const J = newBlock(fx);
      edge(tEnd, J, null, { kind: 'branchEnd', ifPath: p, side: 'consequent' });
      edge(fEnd, J, null, { kind: 'branchEnd', ifPath: p, side: 'alternate' });
      return J;
    }
    case 'LabeledStatement': {
      const body = p.get('body');
      if (body.isLoop()) return visit(fx, body, cur, { ...ctx, label: n.label.name });
      const X = newBlock(fx);
      const inner = { ...ctx, jumps: [...ctx.jumps, { label: n.label.name, brk: X, isLoop: false }] };
      const e = visit(fx, body, cur, inner);
      edge(e, X, null, { kind: 'after', path: body });
      return X;
    }
    case 'WhileStatement': case 'DoWhileStatement': case 'ForStatement': case 'ForInStatement': case 'ForOfStatement':
      return visitLoop(fx, p, cur, ctx);
    case 'BreakStatement': case 'ContinueStatement': {
      const isBreak = n.type === 'BreakStatement';
      const target = [...ctx.jumps].reverse().find((j) => (n.label ? j.label === n.label.name : isBreak || j.isLoop) && (isBreak || j.isLoop));
      if (!target) { fx.unsupported = 'atlama hedefi'; return null; }
      edge(cur, isBreak ? target.brk : target.cont, null, { kind: 'before', path: p });
      cur.instrs.push({ kind: 'jump', path: p, block: cur });
      return null;
    }
    case 'SwitchStatement': {
      add('switch', p.get('discriminant'));
      const X = newBlock(fx);
      const cases = p.get('cases');
      const bodies = cases.map(() => newBlock(fx));
      let test = cur;
      let firstTest = true;
      const inner = { ...ctx, jumps: [...ctx.jumps, { label: ctx.label ?? null, brk: X, isLoop: false }] };
      cases.forEach((c, i) => {
        if (!c.node.test) return;
        if (!firstTest) { const nb = newBlock(fx); edge(test, nb, { path: cases[i - 1]?.get('test'), value: false, caseOf: p }); test = nb; }
        firstTest = false;
        test.instrs.push({ kind: 'case', path: c.get('test'), block: test, switchPath: p });
        edge(test, bodies[i], { path: c.get('test'), value: true, caseOf: p });
      });
      const def = cases.findIndex((c) => !c.node.test);
      const lastTestPath = [...cases].reverse().find((c) => c.node.test)?.get('test') ?? null;
      edge(test, def >= 0 ? bodies[def] : X, firstTest ? null : { path: lastTestPath, value: false, caseOf: p });
      let prevEnd = null;
      cases.forEach((c, i) => {
        if (prevEnd) edge(prevEnd, bodies[i], null, { kind: 'fallthrough', casePath: c });
        prevEnd = visitList(fx, c.get('consequent'), bodies[i], inner);
      });
      edge(prevEnd, X, null, { kind: 'after', path: p });
      return X;
    }
    default:
      fx.unsupported = n.type;
      return null;
  }
}

function visitLoop(fx, p, cur, ctx) {
  const n = p.node;
  const label = ctx.label ?? null;
  const ctxNoLabel = { ...ctx, label: undefined };
  const X = newBlock(fx);
  const H = newBlock(fx);
  const B = newBlock(fx);
  const loop = { path: p, header: H, exit: X, body: B };
  fx.loops ??= [];
  fx.loops.push(loop);
  if (n.type === 'ForStatement' && n.init) {
    if (t.isVariableDeclaration(n.init)) for (const d of p.get('init.declarations')) cur.instrs.push({ kind: 'decl', path: d, block: cur });
    else cur.instrs.push({ kind: 'expr', path: p.get('init'), block: cur });
  }
  if (n.type === 'ForInStatement' || n.type === 'ForOfStatement') cur.instrs.push({ kind: 'expr', path: p.get('right'), block: cur });
  let cont = H;
  if (n.type === 'ForStatement' && n.update) {
    cont = newBlock(fx);
    cont.instrs.push({ kind: 'expr', path: p.get('update'), block: cont });
    edge(cont, H, null, { kind: 'loopUpdate', loop: p });
  }
  if (n.type === 'DoWhileStatement') {
    cont = newBlock(fx);
    edge(cur, B, null, { kind: 'before', path: p });
    cont.instrs.push({ kind: 'test', path: p.get('test'), block: cont });
    edge(cont, B, { path: p.get('test'), value: true }, { kind: 'loopTest', loop: p });
    edge(cont, X, { path: p.get('test'), value: false }, { kind: 'loopTest', loop: p });
    loop.header = B;
    loop.latch = cont;
    fx.blocks.splice(fx.blocks.indexOf(H), 1);
  } else {
    edge(cur, H, null, { kind: 'before', path: p });
    if (n.type === 'ForInStatement' || n.type === 'ForOfStatement') {
      H.instrs.push({ kind: 'forx', path: p, block: H });
      edge(H, B, { forx: p, value: true });
      edge(H, X, { forx: p, value: false });
    } else if (n.test) {
      H.instrs.push({ kind: 'test', path: p.get('test'), block: H });
      edge(H, B, { path: p.get('test'), value: true });
      edge(H, X, { path: p.get('test'), value: false });
    } else edge(H, B);
  }
  const inner = { ...ctxNoLabel, jumps: [...ctx.jumps, { label, brk: X, cont, isLoop: true }] };
  const bodyEnd = visit(fx, p.get('body'), B, inner);
  edge(bodyEnd, cont, null, { kind: 'bodyEnd', loop: p });
  return X;
}

// ── dominatörler ve sınırlar ───────────────────────────
export function dominators(fx) {
  // erişilebilir bloklar ters sonra-sıralı
  const order = [];
  const seen = new Set();
  const dfs = (b) => { seen.add(b); for (const e of b.succ) if (!seen.has(e.to)) dfs(e.to); order.push(b); };
  dfs(fx.entry);
  const rpo = order.reverse();
  const index = new Map(rpo.map((b, i) => [b, i]));
  const idom = new Map([[fx.entry, fx.entry]]);
  const intersect = (a, b) => {
    while (a !== b) {
      while (index.get(a) > index.get(b)) a = idom.get(a);
      while (index.get(b) > index.get(a)) b = idom.get(b);
    }
    return a;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of rpo.slice(1)) {
      let nd = null;
      for (const p of b.pred) if (idom.has(p) && index.has(p)) nd = nd ? intersect(p, nd) : p;
      if (nd && idom.get(b) !== nd) { idom.set(b, nd); changed = true; }
    }
  }
  const children = new Map(rpo.map((b) => [b, []]));
  for (const b of rpo.slice(1)) if (idom.has(b)) children.get(idom.get(b)).push(b);
  const df = new Map(rpo.map((b) => [b, new Set()]));
  for (const b of rpo) {
    const preds = b.pred.filter((p) => index.has(p));
    if (preds.length < 2) continue;
    for (const p of preds) {
      let r = p;
      while (r !== idom.get(b)) { df.get(r).add(b); r = idom.get(r); }
    }
  }
  for (const b of fx.blocks) b.dead = !index.has(b);
  fx.rpo = rpo;
  fx.idom = idom;
  fx.domChildren = children;
  fx.df = df;
  fx.dominates = (a, b) => { let x = b; for (;;) { if (x === a) return true; const up = idom.get(x); if (!up || up === x) return x === a; x = up; } };
  return fx;
}

// ── ifade içi değerlendirme sırası (tanım/kullanım) ────
export function walkEval(node, keyOf, onUse, onDef) {
  const w = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(w); return; }
    if (t.isFunction(n) || t.isClass(n)) return;
    switch (n.type) {
      case 'Identifier': if (keyOf.has(n)) onUse(n); return;
      case 'AssignmentExpression':
        if (t.isIdentifier(n.left) && keyOf.has(n.left)) {
          if (n.operator !== '=') onUse(n.left, true);
          w(n.right);
          onDef(n.left, n);
          return;
        }
        if (t.isMemberExpression(n.left)) { w(n.left.object); if (n.left.computed) w(n.left.property); w(n.right); return; }
        w(n.left); w(n.right);
        return;
      case 'UpdateExpression':
        if (t.isIdentifier(n.argument) && keyOf.has(n.argument)) { onUse(n.argument, true); onDef(n.argument, n); return; }
        w(n.argument);
        return;
      case 'VariableDeclarator':
        w(n.init);
        if (t.isIdentifier(n.id) && keyOf.has(n.id)) onDef(n.id, n);
        return;
      case 'MemberExpression': case 'OptionalMemberExpression': w(n.object); if (n.computed) w(n.property); return;
      case 'ObjectProperty': if (n.computed) w(n.key); w(n.value); return;
      case 'ObjectMethod': return;
      default:
        for (const k of t.VISITOR_KEYS[n.type] ?? []) w(n[k]);
    }
  };
  w(node);
}

// ── SSA kurulumu ───────────────────────────────────────
export function buildSsa(fnPath) {
  const fx = buildCfg(fnPath);
  if (!fx) return null;
  dominators(fx);
  // Identifier düğümü → izlenen değişken adı (bağlama anahtarı)
  const keyOf = new Map();
  const varOf = new Map(); // anahtar → bilgi
  let k = 0;
  for (const [b, info] of fx.vars.tracked) {
    const key = `${info.name}#${k++}`;
    info.key = key;
    varOf.set(key, info);
    keyOf.set(b.identifier, key);
    for (const r of b.referencePaths) keyOf.set(r.node, key);
    for (const v of b.constantViolations) {
      const target = v.isAssignmentExpression() ? v.node.left : v.isUpdateExpression() ? v.node.argument : v.isForXStatement() ? (t.isVariableDeclaration(v.node.left) ? v.node.left.declarations[0].id : v.node.left) : v.isVariableDeclarator() ? v.node.id : null;
      if (target) keyOf.set(target, key);
    }
    if (t.isVariableDeclarator(b.path.node)) keyOf.set(b.path.node.id, key);
  }
  fx.keyOf = keyOf;
  fx.varOf = varOf;

  // her blokta tanımlanan değişkenler
  const defBlocks = new Map([...varOf.keys()].map((v) => [v, new Set([fx.entry])]));
  const instrDefs = (ins, cb) => {
    if (ins.kind === 'forx') {
      const left = ins.path.node.left;
      const id = t.isVariableDeclaration(left) ? left.declarations[0].id : left;
      if (keyOf.has(id)) cb(id);
      return;
    }
    if (ins.kind === 'decl' && !ins.path.node.init && ins.path.parent.kind === 'var') return; // var x; tanım değil
    walkEval(ins.path.node, keyOf, () => {}, (id) => cb(id));
  };
  for (const b of fx.blocks) {
    if (b.dead) continue;
    for (const ins of b.instrs) instrDefs(ins, (id) => defBlocks.get(keyOf.get(id)).add(b));
  }
  // E682: φ'ler yinelenen baskınlık sınırına
  for (const [v, blocks] of defBlocks) {
    const work = [...blocks];
    const has = new Set();
    while (work.length) {
      const b = work.pop();
      for (const d of fx.df.get(b) ?? []) {
        if (has.has(d)) continue;
        has.add(d);
        d.phis.set(v, { var: v, block: d, args: new Map(), version: null });
        if (!blocks.has(d)) { blocks.add(d); work.push(d); }
      }
    }
  }

  // E681: yeniden adlandırma
  const versions = [];
  const mkVersion = (v, kind, extra = {}) => {
    const ver = { id: versions.length, var: v, kind, uses: [], ...extra };
    versions.push(ver);
    return ver;
  };
  const stacks = new Map([...varOf.keys()].map((v) => [v, []]));
  const useVer = new Map(); // Identifier düğümü (kullanım) → sürüm
  const defVer = new Map(); // Identifier düğümü (tanım) → sürüm
  const useInstr = new Map(); // kullanım düğümü → komut (versionAt için)
  const implicitUses = new Set(); // x += 1 / x++ hedefi: okunur ama yerine ifade konamaz
  for (const [v, info] of varOf) {
    const kind = info.kind === 'param' ? 'param' : info.kind === 'var' ? 'undef' : 'tdz';
    stacks.get(v).push(mkVersion(v, kind, { block: fx.entry }));
  }
  const top = (v) => stacks.get(v)[stacks.get(v).length - 1];
  const current = () => new Map([...stacks].map(([v, s]) => [v, s[s.length - 1]]));
  const rename = (b) => {
    const pushed = [];
    for (const phi of b.phis.values()) {
      phi.version = mkVersion(phi.var, 'phi', { phi, block: b });
      stacks.get(phi.var).push(phi.version);
      pushed.push(phi.var);
    }
    for (const ins of b.instrs) {
      ins.before = current();
      if (ins.kind === 'forx') {
        const left = ins.path.node.left;
        const id = t.isVariableDeclaration(left) ? left.declarations[0].id : left;
        if (keyOf.has(id)) {
          const ver = mkVersion(keyOf.get(id), 'opaque', { node: id, instr: ins, block: b });
          defVer.set(id, ver);
          stacks.get(ver.var).push(ver);
          pushed.push(ver.var);
        }
        continue;
      }
      if (ins.kind === 'decl' && !ins.path.node.init && ins.path.parent.kind === 'var') continue;
      walkEval(ins.path.node, keyOf, (id, implicit) => {
        const ver = top(keyOf.get(id));
        useVer.set(id, ver);
        ver.uses.push({ node: id, instr: ins, implicit: Boolean(implicit) });
        useInstr.set(id, ins);
        if (implicit) implicitUses.add(id);
      }, (id, site) => {
        const ver = mkVersion(keyOf.get(id), 'def', { node: id, site, instr: ins, block: b });
        defVer.set(id, ver);
        stacks.get(ver.var).push(ver);
        pushed.push(ver.var);
      });
      ins.after = current();
    }
    b.out = current();
    for (const e of b.succ) for (const phi of e.to.phis.values()) {
      const ver = top(phi.var);
      phi.args.set(b, ver);
      ver.uses.push({ phi });
    }
    for (const c of fx.domChildren.get(b) ?? []) rename(c);
    for (const v of pushed) stacks.get(v).pop();
  };
  rename(fx.entry);
  fx.versions = versions;
  fx.useVer = useVer;
  fx.defVer = defVer;
  fx.useInstr = useInstr;
  fx.implicitUses = implicitUses;
  eliminateRedundantPhis(fx);
  return fx;
}

const MAX_TRACKED = 250;
const MAX_INSTRS = 4000;
/** Boyut sınırlı SSA kurulumu (çok büyük fonksiyonlarda null) */
export function ssaFor(fnPath) {
  let stmts = 0;
  fnPath.traverse({ Statement() { stmts++; }, Function(p) { p.skip(); } });
  if (stmts > MAX_INSTRS) return null;
  const fx = buildSsa(fnPath);
  return fx && fx.varOf.size <= MAX_TRACKED ? fx : null;
}

/** useNode noktasında varKey değişkeninin güncel sürümü (aynı komutta önceden yapılan tanımlar dahil) */
export function versionAt(fx, useNode, varKey) {
  const ins = fx.useInstr.get(useNode);
  if (!ins || !ins.before) return null;
  let ver = ins.before.get(varKey);
  let done = false;
  walkEval(ins.path.node, fx.keyOf, (id) => { if (id === useNode) done = true; }, (id) => {
    if (!done && fx.keyOf.get(id) === varKey) ver = fx.defVer.get(id);
  });
  return ver;
}

/** Komutun başındaki/sonundaki sürüm (komut içi tanımlar sonrası) */
export function versionAfterInstr(ins, varKey) { return ins.after?.get(varKey) ?? ins.before?.get(varKey) ?? null; }

// E684: x = φ(x, y, y) gibi tek bir değere inen φ'ler ve yalnızca kendini besleyen φ döngüleri silinir
export function eliminateRedundantPhis(fx) {
  const alias = new Map();
  const resolve = (v) => { while (alias.has(v)) v = alias.get(v); return v; };
  // x = x öz-kopyası yeni değer üretmez: φ karşılaştırmasında kaynağına çözülür (yalnızca aynı değişken:
  // kullanımlar her zaman kendi adlarının sürümüne bağlı kalmalı)
  const valueOf = (v) => {
    for (let i = 0; i < 64; i++) {
      v = resolve(v);
      const site = v.kind === 'def' ? v.site : null;
      const rhs = site && (t.isAssignmentExpression(site, { operator: '=' }) ? site.right : t.isVariableDeclarator(site) ? site.init : null);
      const src = rhs && t.isIdentifier(rhs) ? fx.useVer.get(rhs) : null;
      if (!src || src.var !== v.var) return v;
      v = src;
    }
    return v;
  };
  let changed = true;
  let removed = 0;
  while (changed) {
    changed = false;
    for (const b of fx.blocks) {
      for (const [v, phi] of b.phis) {
        const self = resolve(phi.version);
        const ops = new Set([...phi.args.values()].map(valueOf).filter((x) => x !== self));
        if (ops.size === 1) {
          const [only] = ops;
          alias.set(phi.version, only);
          b.phis.delete(v);
          removed++;
          changed = true;
        }
      }
    }
  }
  // kullanımları ve anlık görüntüleri güncelle
  if (removed) {
    for (const [node, ver] of fx.useVer) fx.useVer.set(node, resolve(ver));
    for (const b of fx.blocks) {
      for (const phi of b.phis.values()) for (const [p, ver] of phi.args) phi.args.set(p, resolve(ver));
      for (const ins of b.instrs) for (const m of [ins.before, ins.after]) if (m) for (const [v, ver] of m) m.set(v, resolve(ver));
      if (b.out) for (const [v, ver] of b.out) b.out.set(v, resolve(ver));
    }
    for (const ver of fx.versions) ver.uses = [];
    for (const [node, ver] of fx.useVer) ver.uses.push({ node, instr: fx.useInstr.get(node), implicit: fx.implicitUses.has(node) });
    for (const b of fx.blocks) for (const phi of b.phis.values()) for (const ver of phi.args.values()) ver.uses.push({ phi });
    for (const ver of fx.versions) if (alias.has(ver)) ver.replacedBy = resolve(ver);
  }
  fx.redundantPhis = (fx.redundantPhis ?? 0) + removed;
  return removed;
}

// ── canlılık (SSA bozmada girişim denetimi) ────────────
export function liveness(fx) {
  const liveIn = new Map(fx.blocks.map((b) => [b, new Set()]));
  const liveOut = new Map(fx.blocks.map((b) => [b, new Set()]));
  const useDef = new Map();
  for (const b of fx.blocks) {
    const uses = new Set();
    const defs = new Set();
    for (const ins of b.instrs) {
      if (!ins.path.node) continue;
      walkEval(ins.path.node, fx.keyOf, (id) => { const v = fx.useVer.get(id); if (v && !defs.has(v)) uses.add(v); }, (id) => { const v = fx.defVer.get(id); if (v) defs.add(v); });
    }
    for (const phi of b.phis.values()) defs.add(phi.version);
    useDef.set(b, { uses, defs });
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of [...fx.rpo].reverse()) {
      const out = new Set();
      for (const e of b.succ) {
        for (const v of liveIn.get(e.to)) out.add(v);
        for (const phi of e.to.phis.values()) { const a = phi.args.get(b); if (a) out.add(a); }
        for (const phi of e.to.phis.values()) out.delete(phi.version);
      }
      const { uses, defs } = useDef.get(b);
      const inn = new Set(uses);
      for (const v of out) if (!defs.has(v)) inn.add(v);
      if (inn.size !== liveIn.get(b).size || out.size !== liveOut.get(b).size) changed = true;
      liveIn.set(b, inn);
      liveOut.set(b, out);
    }
  }
  return { liveIn, liveOut };
}

/**
 * E683: SSA'dan çıkış. Aynı özgün değişkene ait sürümler (φ-ağları) tek ada birleştirilir. Birleştirme ancak
 * ağdaki sürümler girişmiyorsa (aynı anda canlı değilse) geçerlidir; girişim varsa ilgili φ argümanı için
 * öncül kenar sonuna kopya eklenmesi gerekir. Bu kopya yalnızca AST'de ifade edilebilir kenarlarda (deyim listesi
 * sonu, else dalı, döngü gövdesi sonu, break/continue öncesi) eklenir; aksi halde null döner ve dönüşüm geri alınır.
 */
export function destruct(fx, { allowCopies = true } = {}) {
  const { liveOut } = liveness(fx);
  const conflicts = [];
  for (const b of fx.blocks) {
    if (b.dead) continue;
    for (const phi of b.phis.values()) {
      for (const [pred, arg] of phi.args) {
        if (arg.var !== phi.var) { conflicts.push({ pred, arg, phi }); continue; }
        // aynı değişkenin başka bir sürümü öncül çıkışında canlıysa girişim var
        const other = [...liveOut.get(pred)].find((v) => v.var === phi.var && v !== arg);
        if (other) conflicts.push({ pred, arg, phi });
      }
    }
  }
  if (!conflicts.length) return { copies: 0 };
  if (!allowCopies) return null;
  let copies = 0;
  for (const { pred, arg, phi } of conflicts) {
    const e = pred.succ.find((x) => x.to === phi.block);
    const name = fx.varOf.get(phi.var).name;
    const src = arg.var === phi.var ? null : fx.varOf.get(arg.var).name;
    if (!src) return null; // aynı ad, farklı sürüm: geçici değişken ve iki kopya gerekir
    const stmt = t.expressionStatement(t.assignmentExpression('=', t.identifier(name), t.identifier(src)));
    if (!insertOnEdge(e, stmt)) return null;
    copies++;
  }
  return { copies };
}

export function insertOnEdge(e, stmt) {
  const at = e?.at;
  if (!at) return false;
  if (at.kind === 'before' && Array.isArray(at.path.container)) { at.path.insertBefore(stmt); return true; }
  if (at.kind === 'branchEnd') {
    const side = at.ifPath.get(at.side);
    if (!side.node) { at.ifPath.node.alternate = t.blockStatement([stmt]); return true; }
    if (side.isBlockStatement()) { side.pushContainer('body', stmt); return true; }
    side.replaceWith(t.blockStatement([side.node, stmt]));
    return true;
  }
  if (at.kind === 'bodyEnd') {
    const body = at.loop.get('body');
    if (body.isBlockStatement()) body.pushContainer('body', stmt); else body.replaceWith(t.blockStatement([body.node, stmt]));
    return true;
  }
  if (at.kind === 'end') { at.list.pushContainer('body', stmt); return true; }
  return false;
}

/** SSA biçimini okunur metin olarak yazar (rapor/hata ayıklama) */
export function ssaText(fx, gen) {
  const name = (ver) => `${fx.varOf.get(ver.var).name}${ver.id}`;
  const lines = [];
  for (const b of fx.rpo) {
    lines.push(`B${b.id}:${b.pred.length ? ` ← ${b.pred.map((p) => `B${p.id}`).join(',')}` : ''}`);
    for (const phi of b.phis.values()) lines.push(`  ${name(phi.version)} = φ(${[...phi.args].map(([p, v]) => `B${p.id}:${name(v)}`).join(', ')})`);
    for (const ins of b.instrs) {
      // kimlikleri sürüm adlarıyla değiştirerek kopyala
      const copy = (n) => {
        if (Array.isArray(n)) return n.map(copy);
        if (!n || typeof n !== 'object' || !n.type) return n;
        if (t.isIdentifier(n)) {
          const ver = fx.useVer.get(n) ?? fx.defVer.get(n);
          return t.identifier(ver ? name(ver) : n.name);
        }
        const out = { type: n.type };
        for (const k of Object.keys(n)) {
          if (['start', 'end', 'loc', 'leadingComments', 'trailingComments', 'innerComments', 'extra'].includes(k)) continue;
          out[k] = copy(n[k]);
        }
        return out;
      };
      lines.push(`  ${ins.kind}: ${gen(copy(ins.path.node))}`);
    }
    lines.push(`  → ${b.succ.map((e) => `B${e.to.id}${e.cond ? `(${e.cond.value})` : ''}`).join(', ') || 'çıkış'}`);
  }
  return lines.join('\n');
}
