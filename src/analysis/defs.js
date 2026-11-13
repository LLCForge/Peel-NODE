import * as t from '@babel/types';
import { buildCFG } from './cfg.js';
import { solve, setUnion, setEqual } from './dataflow.js';
import { evaluate, binary, toNumeric, toBoolean, isPrimitiveResult, UNKNOWN } from './ops.js';

// E575–E580: ulaşan tanımlar, def-use zincirleri, canlılık, ölü atama, kopya yayılımı, sabit yayılımı.
// İzlenen değişkenler: fonksiyona ait, iç fonksiyonlarca yakalanmayan, with/direct eval/arguments takma adı
// ile dolaylı erişilemeyen binding'ler. Diğerleri analiz dışı (her noktada bilinmez sayılır).

// catch parametresi, for-in/of başı ve sınıf adı atama değil bağlama: ölü atama raporuna girmez
const NOT_STORES = new Set(['catch', 'forx', 'class']);
const OWNER_PROPS = new Set(['ClassProperty', 'ClassPrivateProperty', 'ClassAccessorProperty']);

// Kodun çalıştığı fonksiyon benzeri birim: fonksiyon, statik blok, sınıf alanı başlatıcısı ya da program.
// Fonksiyonun adı, hesaplanmış anahtarı ve dekoratörleri dış birimde değerlendirilir.
export function ownerOf(path) {
  let prev = null;
  for (let p = path; p; prev = p, p = p.parentPath) {
    if (p.isProgram() || p.isStaticBlock()) return p;
    if (p.isFunction()) {
      if (prev && (prev.key === 'id' || prev.key === 'key' || prev.listKey === 'decorators')) continue;
      return p;
    }
    if (OWNER_PROPS.has(p.node.type) && prev && prev.key === 'value') return p;
  }
  return null;
}

function hasDirectEval(fnPath) {
  let found = false;
  fnPath.traverse({
    CallExpression(p) {
      if (t.isIdentifier(p.node.callee, { name: 'eval' }) && !p.scope.getBinding('eval')) { found = true; p.stop(); }
    },
  });
  return found;
}

function usesArguments(fnPath) {
  let found = false;
  fnPath.traverse({
    Function(p) { if (!p.isArrowFunctionExpression()) p.skip(); },
    Identifier(p) {
      if (p.node.name === 'arguments' && p.isReferencedIdentifier() && !p.scope.getBinding('arguments')) { found = true; p.stop(); }
    },
  });
  return found;
}

const inWith = (p, fn) => Boolean(p.findParent((x) => x === fn || x.isWithStatement())?.isWithStatement());

function candidateBindings(fnPath) {
  const out = [];
  const seen = new Set();
  const visit = (scope) => {
    for (const b of Object.values(scope.bindings)) if (!seen.has(b)) { seen.add(b); out.push(b); }
  };
  visit(fnPath.scope);
  fnPath.traverse({
    Scopable(p) {
      if (p.isFunction() || p.isStaticBlock() || p.isClass()) { p.skip(); return; }
      visit(p.scope);
    },
  });
  return out;
}

function trackable(b, fnPath, ctx) {
  if (ctx.directEval) return false;
  if (!['var', 'let', 'const', 'param', 'hoisted'].includes(b.kind)) return false;
  if (ownerOf(b.scope.path) !== fnPath) return false;
  if (b.path.findParent((x) => x.isExportDeclaration()) || b.referencePaths.some((r) => r.parentPath.isExportSpecifier())) return false; // canlı dışa aktarım
  if (b.kind === 'param' && ctx.argumentsUsed) return false;
  if (fnPath.isProgram() && fnPath.node.sourceType !== 'module' && (b.kind === 'var' || b.kind === 'hoisted')) return false; // global nesne özelliği
  if (b.kind === 'hoisted') {
    const body = fnPath.isProgram() ? fnPath.node : fnPath.node.body;
    if (b.path.parentPath.node !== body) return false;
  }
  for (const v of b.constantViolations) {
    if (v.isFunctionDeclaration() || v.isClassDeclaration()) return false;
    if (ownerOf(v) !== fnPath || inWith(v, fnPath)) return false;
  }
  for (const r of b.referencePaths) {
    if (ownerOf(r) !== fnPath || inWith(r, fnPath)) return false;
  }
  return true;
}

// Bir CFG düğümünün olayları değerlendirme sırasıyla: { type: 'use'|'def', b, path, cond, def }
function makeWalker(state) {
  const { index, emitUse, emitDef, noteNode } = state;
  const resolve = (p) => {
    const b = p.scope.getBinding(p.node.name);
    return b ? index.get(b) : undefined;
  };

  function use(p, cond) {
    noteNode(p);
    const i = resolve(p);
    if (i !== undefined) emitUse(i, p, cond);
  }

  function def(p, cond, info) {
    noteNode(p, true);
    const i = resolve(p);
    if (i !== undefined) emitDef(i, p, cond, info);
  }

  function memberTarget(p, cond) {
    walk(p.get('object'), cond);
    if (p.node.computed) walk(p.get('property'), cond);
  }

  function pattern(p, cond, kind) {
    const n = p.node;
    if (!n) return;
    if (t.isIdentifier(n)) return def(p, cond, { kind });
    if (t.isMemberExpression(n)) return memberTarget(p, cond);
    if (t.isAssignmentPattern(n)) {
      walk(p.get('right'), true);
      return pattern(p.get('left'), cond, kind);
    }
    if (t.isArrayPattern(n)) {
      for (const e of p.get('elements')) if (e.node) pattern(e, cond, kind);
      return;
    }
    if (t.isObjectPattern(n)) {
      for (const prop of p.get('properties')) {
        if (prop.isRestElement()) { pattern(prop.get('argument'), cond, kind); continue; }
        if (prop.node.computed) walk(prop.get('key'), cond);
        pattern(prop.get('value'), cond, kind);
      }
      return;
    }
    if (t.isRestElement(n)) return pattern(p.get('argument'), cond, kind);
    walk(p, cond);
  }

  function children(p, cond) {
    for (const key of t.VISITOR_KEYS[p.node.type] ?? []) {
      const c = p.get(key);
      if (Array.isArray(c)) { for (const x of c) if (x.node) walk(x, cond); } else if (c.node) walk(c, cond);
    }
  }

  function classParts(p, cond) {
    if (p.node.superClass) walk(p.get('superClass'), cond);
    for (const m of p.get('body.body')) if (m.node.computed && m.node.key) walk(m.get('key'), cond);
  }

  function walk(p, cond) {
    const n = p.node;
    switch (n.type) {
      case 'Identifier':
        if (p.isReferencedIdentifier()) use(p, cond);
        return;
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
      case 'ObjectMethod': case 'ClassMethod': case 'ClassPrivateMethod': case 'StaticBlock':
        if ((n.type === 'ObjectMethod' || n.type === 'ClassMethod') && n.computed) walk(p.get('key'), cond);
        return;
      case 'ClassExpression':
        classParts(p, cond);
        return;
      case 'ClassDeclaration':
        classParts(p, cond);
        if (n.id) def(p.get('id'), cond, { kind: 'class' });
        return;
      case 'VariableDeclaration':
        for (const d of p.get('declarations')) {
          if (d.node.init) walk(d.get('init'), cond);
          const id = d.get('id');
          if (id.isIdentifier()) {
            if (d.node.init) def(id, cond, { kind: 'init', rhs: d.node.init });
            else if (n.kind !== 'var') def(id, cond, { kind: 'init', rhs: null });
            else noteNode(id, true);
          } else if (d.node.init) pattern(id, cond, 'pattern');
        }
        return;
      case 'AssignmentExpression': {
        const left = p.get('left');
        const right = p.get('right');
        if (n.operator === '=') {
          if (left.isIdentifier()) { walk(right, cond); def(left, cond, { kind: 'assign', rhs: n.right }); return; }
          if (left.isMemberExpression()) { memberTarget(left, cond); walk(right, cond); return; }
          walk(right, cond);
          pattern(left, cond, 'pattern');
          return;
        }
        const logical = n.operator === '||=' || n.operator === '&&=' || n.operator === '??=';
        if (left.isIdentifier()) {
          use(left, cond);
          walk(right, cond || logical);
          def(left, cond || logical, { kind: 'compound', op: n.operator, rhs: n.right });
          return;
        }
        memberTarget(left, cond);
        walk(right, cond || logical);
        return;
      }
      case 'UpdateExpression': {
        const a = p.get('argument');
        if (a.isIdentifier()) { use(a, cond); def(a, cond, { kind: 'update', op: n.operator }); return; }
        walk(a, cond);
        return;
      }
      case 'LogicalExpression':
        walk(p.get('left'), cond);
        walk(p.get('right'), true);
        return;
      case 'ConditionalExpression':
        walk(p.get('test'), cond);
        walk(p.get('consequent'), true);
        walk(p.get('alternate'), true);
        return;
      case 'OptionalMemberExpression': case 'OptionalCallExpression':
        children(p, true);
        return;
      case 'MemberExpression':
        walk(p.get('object'), cond);
        if (n.computed) walk(p.get('property'), cond);
        return;
      case 'ObjectProperty':
        if (n.computed) walk(p.get('key'), cond);
        walk(p.get('value'), cond);
        return;
      case 'ClassProperty': case 'ClassPrivateProperty': case 'ClassAccessorProperty':
        if (n.computed) walk(p.get('key'), cond);
        return;
      case 'LabeledStatement': case 'BreakStatement': case 'ContinueStatement':
        return;
      default:
        children(p, cond);
    }
  }

  return { walk, pattern };
}

/**
 * Tek fonksiyon benzeri birimin veri akışı analizi.
 * @param {import('@babel/traverse').NodePath} fnPath Function | StaticBlock | Program
 */
export function analyzeFunction(fnPath, { models = true } = {}) {
  const ctx = { directEval: hasDirectEval(fnPath), argumentsUsed: !fnPath.isArrowFunctionExpression() && !fnPath.isProgram() && usesArguments(fnPath) };
  let bindings = candidateBindings(fnPath).filter((b) => trackable(b, fnPath, ctx));
  const cfg = buildCFG(fnPath);

  const collect = (list) => {
    const index = new Map(list.map((b, i) => [b, i]));
    const events = cfg.nodes.map(() => []);
    const seenPaths = new Set();
    const nodeInfo = new Map(); // tanımlayıcı düğümü → { b } ya da { global }
    let cur = null;
    const defs = [];
    const state = {
      index,
      noteNode(p) {
        seenPaths.add(p.node);
        const b = p.scope.getBinding(p.node.name);
        nodeInfo.set(p.node, b ? { b: index.get(b) } : { global: true });
      },
      emitUse(b, path, cond) { events[cur.id].push({ type: 'use', b, path, cond }); },
      emitDef(b, path, cond, info) {
        const d = { id: defs.length, b, path, node: cur, cond, ...info };
        defs.push(d);
        events[cur.id].push({ type: 'def', b, path, cond, def: d });
      },
    };
    const w = makeWalker(state);
    for (const n of cfg.nodes) {
      if (!n.path) continue;
      cur = n;
      if (n.kind === 'head') {
        if (n.path.isVariableDeclaration()) for (const d of n.path.get('declarations')) w.pattern(d.get('id'), false, 'forx');
        else w.pattern(n.path, false, 'forx');
      } else if (n.kind === 'catch') {
        w.pattern(n.path, false, 'catch');
      } else {
        w.walk(n.path, false);
      }
    }
    return { index, events, seenPaths, nodeInfo, defs };
  };

  let c = collect(bindings);
  // her referans ve atama yürüyüşte görülmeli (ör. parametre varsayılanındaki atama görülmez → izlenmez)
  const targets = (v) => {
    if (v.isAssignmentExpression()) return Object.values(t.getBindingIdentifiers(v.node.left));
    if (v.isUpdateExpression()) return [v.node.argument];
    if (v.isVariableDeclarator()) return v.node.init ? Object.values(t.getBindingIdentifiers(v.node.id)) : [];
    if (v.isForXStatement()) return Object.values(t.getBindingIdentifiers(v.node.left));
    return null;
  };
  const complete = (b) => b.referencePaths.every((r) => c.seenPaths.has(r.node)) &&
    b.constantViolations.every((v) => {
      const ids = targets(v);
      return ids !== null && ids.filter((id) => id.name === b.identifier.name).every((id) => c.seenPaths.has(id));
    });
  const kept = bindings.filter(complete);
  if (kept.length !== bindings.length) { bindings = kept; c = collect(bindings); }
  const { events, defs, nodeInfo } = c;

  // giriş tanımları: parametre, hoisted fonksiyon, var (undefined), let/const/class (TDZ)
  const entryDefs = bindings.map((b, i) => {
    const kind = b.kind === 'param' ? 'param' : b.kind === 'hoisted' ? 'fn' : b.kind === 'var' ? 'undef' : 'tdz';
    const d = { id: defs.length, b: i, path: b.identifier ? b.path : null, node: cfg.entry, cond: false, kind, entry: true };
    defs.push(d);
    return d;
  });
  const defsOf = bindings.map(() => []);
  for (const d of defs) defsOf[d.b].push(d.id);

  const nodeDefs = cfg.nodes.map((n) => events[n.id].filter((e) => e.type === 'def'));

  // ---- E576 ulaşan tanımlar
  const rdApply = (s, e) => {
    if (e.type !== 'def') return s;
    if (!e.cond) for (const id of defsOf[e.b]) s.delete(id);
    s.add(e.def.id);
    return s;
  };
  const rd = solve(cfg, {
    direction: 'forward',
    bottom: () => new Set(),
    boundary: () => new Set(entryDefs.map((d) => d.id)),
    join: setUnion,
    equal: setEqual,
    transfer(n, inn) {
      const s = new Set(inn);
      for (const e of events[n.id]) rdApply(s, e);
      const exc = setUnion(inn, new Set(nodeDefs[n.id].map((e) => e.def.id)));
      return { out: s, exc };
    },
  });

  // ---- E575 def-use zincirleri
  const useDefs = new Map(); // use path.node → [def]
  const defUses = new Map(); // def.id → [use path]
  for (const d of defs) defUses.set(d.id, []);
  const uses = [];
  for (const n of cfg.nodes) {
    const s = new Set(rd.input[n.id]);
    for (const e of events[n.id]) {
      if (e.type === 'use') {
        const list = [...s].filter((id) => defs[id].b === e.b).map((id) => defs[id]);
        useDefs.set(e.path.node, list);
        uses.push({ e, defs: list, node: n });
        for (const d of list) defUses.get(d.id).push(e.path);
      }
      rdApply(s, e);
    }
  }

  // ---- E577 canlılık
  const live = solve(cfg, {
    direction: 'backward',
    bottom: () => new Set(),
    // betik programında üst seviye let/const sonraki betiklerce okunabilir: çıkışta canlı
    boundary: () => new Set(fnPath.isProgram() && fnPath.node.sourceType !== 'module' ? bindings.map((_, i) => i) : []),
    join: setUnion,
    equal: setEqual,
    transfer(n, out, exc) {
      const s = new Set(out);
      const ev = events[n.id];
      for (let i = ev.length - 1; i >= 0; i--) {
        const e = ev[i];
        if (e.type === 'def') { if (!e.cond) s.delete(e.b); } else s.add(e.b);
      }
      for (const x of exc) s.add(x);
      return s;
    },
  });

  // ---- E578 ölü atamalar: tanımdan sonra hiçbir yolda okunmayan değer
  const deadAssignments = [];
  for (const n of cfg.nodes) {
    const ev = events[n.id];
    if (!ev.length) continue;
    let excLive = new Set();
    for (const h of n.exc) excLive = setUnion(excLive, live.input[h.id]);
    const s = new Set(live.output[n.id]);
    for (let i = ev.length - 1; i >= 0; i--) {
      const e = ev[i];
      if (e.type === 'def') {
        if (!s.has(e.b) && !excLive.has(e.b) && !NOT_STORES.has(e.def.kind)) deadAssignments.push({ def: e.def, binding: bindings[e.b] });
        if (!e.cond) s.delete(e.b);
      } else s.add(e.b);
    }
  }

  // ---- E579 kopya yayılımı: mevcut kopyalar (must, kesişim)
  const copyOf = (d) => {
    if (d.cond || (d.kind !== 'init' && d.kind !== 'assign') || !d.rhs || !t.isIdentifier(d.rhs)) return null;
    const info = nodeInfo.get(d.rhs);
    if (!info || info.b === undefined || info.b === d.b) return null;
    return info.b;
  };
  const pairKey = (b, a) => `${b}<${a}`;
  const acApply = (s, e) => {
    if (e.type !== 'def') return s;
    for (const k of [...s]) {
      const [b, a] = k.split('<').map(Number);
      if (b === e.b || a === e.b) s.delete(k);
    }
    const a = copyOf(e.def);
    if (a !== null) s.add(pairKey(e.b, a));
    return s;
  };
  const ac = solve(cfg, {
    direction: 'forward',
    bottom: () => null,
    boundary: () => new Set(),
    join: (x, y) => x === null ? y : y === null ? x : new Set([...x].filter((k) => y.has(k))),
    equal: (x, y) => x === y || (x !== null && y !== null && setEqual(x, y)),
    transfer(n, inn) {
      if (inn === null) return { out: null, exc: null };
      const s = new Set(inn);
      for (const e of events[n.id]) acApply(s, e);
      const killed = new Set(nodeDefs[n.id].map((e) => e.b));
      const exc = new Set([...inn].filter((k) => { const [b, a] = k.split('<').map(Number); return !killed.has(b) && !killed.has(a); }));
      return { out: s, exc };
    },
  });
  const copies = [];
  for (const n of cfg.nodes) {
    if (ac.input[n.id] === null) continue;
    const s = new Set(ac.input[n.id]);
    for (const e of events[n.id]) {
      if (e.type === 'use') {
        for (const k of s) {
          const [b, a] = k.split('<').map(Number);
          if (b !== e.b) continue;
          const target = bindings[a];
          // hedef ad kullanım noktasında aynı binding'e çözülmeli (gölgeleme yok)
          if (e.path.scope.getBinding(target.identifier.name) !== target) continue;
          if (e.path.parentPath.isExportSpecifier()) continue;
          copies.push({ use: e.path, from: bindings[b], to: target });
          break;
        }
      }
      acApply(s, e);
    }
  }

  // ---- E580 sabit yayılımı
  const TOP = UNKNOWN;
  const TDZ = Symbol('tdz');
  const joinVal = (x, y) => {
    if (x === undefined) return y;
    if (y === undefined) return x;
    if (x === TDZ) return y; // TDZ'deki okuma fırlatır: okuma gerçekleşiyorsa değer diğer daldandır
    if (y === TDZ) return x;
    if (x === TOP || y === TOP) return TOP;
    return Object.is(x.c, y.c) ? x : TOP;
  };
  const sameVal = (x, y) => x === y || (x && y && typeof x === 'object' && typeof y === 'object' && Object.is(x.c, y.c));
  const lookupIn = (s) => (node) => {
    const info = nodeInfo.get(node);
    if (info && info.b !== undefined) {
      const v = s.get(info.b);
      return v && typeof v === 'object' ? v.c : UNKNOWN;
    }
    if (info && info.global) {
      if (node.name === 'undefined') return undefined;
      if (node.name === 'NaN') return NaN;
      if (node.name === 'Infinity') return Infinity;
    }
    return UNKNOWN;
  };
  const wrap = (v) => isPrimitiveResult(v) ? { c: v } : TOP;
  const cpApply = (s, e) => {
    if (e.type !== 'def') return s;
    const d = e.def;
    const cur = s.get(e.b);
    const curV = cur && typeof cur === 'object' ? cur.c : UNKNOWN;
    let v = TOP;
    const ev = (n) => evaluate(n, lookupIn(s), { models });
    if (d.kind === 'init' || d.kind === 'assign') v = d.rhs === null ? { c: undefined } : wrap(ev(d.rhs));
    else if (d.kind === 'compound') {
      if (curV !== UNKNOWN) {
        if (d.op === '||=') v = toBoolean(curV) ? cur : wrap(ev(d.rhs));
        else if (d.op === '&&=') v = toBoolean(curV) ? wrap(ev(d.rhs)) : cur;
        else if (d.op === '??=') v = curV === null || curV === undefined ? wrap(ev(d.rhs)) : cur;
        else v = wrap(binary(d.op.slice(0, -1), curV, ev(d.rhs)));
      }
    } else if (d.kind === 'update' && curV !== UNKNOWN) {
      const num = toNumeric(curV);
      if (isPrimitiveResult(num)) v = wrap(d.op === '++' ? num + (typeof num === 'bigint' ? 1n : 1) : num - (typeof num === 'bigint' ? 1n : 1));
    }
    s.set(e.b, e.cond ? joinVal(cur, v) : v);
    return s;
  };
  const cp = solve(cfg, {
    direction: 'forward',
    bottom: () => null,
    boundary: () => new Map(entryDefs.map((d) => [d.b, d.kind === 'undef' ? { c: undefined } : d.kind === 'tdz' ? TDZ : TOP])),
    join(x, y) {
      if (x === null) return y;
      if (y === null) return x;
      const r = new Map(x);
      for (const [k, v] of y) r.set(k, joinVal(r.get(k), v));
      return r;
    },
    equal(x, y) {
      if (x === y) return true;
      if (x === null || y === null || x.size !== y.size) return false;
      for (const [k, v] of x) if (!sameVal(v, y.get(k))) return false;
      return true;
    },
    transfer(n, inn) {
      if (inn === null) return { out: null, exc: null };
      const s = new Map(inn);
      const exc = new Map(inn);
      for (const e of events[n.id]) {
        cpApply(s, e);
        if (e.type === 'def') exc.set(e.b, joinVal(exc.get(e.b), s.get(e.b)));
      }
      return { out: s, exc };
    },
  });
  const constants = [];
  for (const n of cfg.nodes) {
    if (cp.input[n.id] === null) continue;
    const s = new Map(cp.input[n.id]);
    for (const e of events[n.id]) {
      if (e.type === 'use') {
        const v = s.get(e.b);
        if (v && typeof v === 'object') constants.push({ use: e.path, binding: bindings[e.b], value: v.c });
      }
      cpApply(s, e);
    }
  }

  return {
    fn: fnPath, cfg, bindings, defs, events, useDefs, defUses, uses,
    reaching: (useNode) => useDefs.get(useNode) ?? null,
    liveIn: (cfgNode) => new Set([...live.input[cfgNode.id]].map((i) => bindings[i])),
    deadAssignments, copies, constants,
    iterations: rd.iterations + live.iterations + ac.iterations + cp.iterations,
  };
}

// Kopya yayılımını uygular: kopya kullanımlarını kaynak değişkenle değiştirir. Döndürür: değiştirilen kullanım sayısı.
export function applyCopyPropagation(results) {
  let n = 0;
  for (const r of results) {
    for (const c of r.copies) {
      const p = c.use;
      if (!p.node || p.node.name !== c.from.identifier.name) continue;
      if (p.parentPath.isObjectProperty({ shorthand: true }) && p.key === 'value') p.parentPath.node.shorthand = false;
      p.replaceWith(t.identifier(c.to.identifier.name));
      n++;
    }
  }
  return n;
}
