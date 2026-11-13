import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { ssaFor } from './ssa.js';
import { sccp, absint, describeAbs, typeNames } from './lattice.js';

// Program genelinde statik analizler (rapor için):
//   E685 Andersen (kapsama tabanlı, alan duyarlı, anında çağrı grafiği) nokta-analizi
//   E686 Steensgaard (birleştirme tabanlı) nokta-analizi + takma ad sorguları
//   E687 kaçış analizi, E688 saflık/etki çıkarımı, E689 taint takibi, E692 nesne şekli çıkarımı
//   E690/E691/E693/E694 SSA kafes özetleri, E695 erişilemezlik kanıtları (SCCP)

const lineOf = (n) => n?.loc?.start.line ?? 0;

// ── kısıt üretimi ─────────────────────────────────────
// Düğümler: değişken (bağlama), tahsis yeri, tahsis alanı, fonksiyon dönüşü/this, dış dünya
export function buildConstraints(ast) {
  const nodes = new Map(); // anahtar → id
  const info = [];
  const id = (key, meta = {}) => {
    if (!nodes.has(key)) { nodes.set(key, info.length); info.push({ key, ...meta }); }
    return nodes.get(key);
  };
  const EXT = id('ext', { kind: 'ext' }); // dış dünya: bilinmeyen çağrılar, globaller
  const allocs = [];
  const base = []; // [değişken, tahsis]
  const copy = []; // [hedef, kaynak]
  const load = []; // [hedef, nesne, alan]
  const store = []; // [nesne, alan, kaynak]
  const calls = []; // { callee, args, ret, thisArg, line }
  const fnOf = new Map(); // tahsis id → fonksiyon düğümü
  const bindingKey = new Map();
  let tmp = 0;
  const varNode = (p, name) => {
    const b = p.scope.getBinding(name);
    if (!b) return id(`g:${name}`, { kind: 'global', name });
    // betik düzeyindeki bildirimler global nesnenin özelliğidir: kaçış açısından global
    if (!bindingKey.has(b)) bindingKey.set(b, id(`v${bindingKey.size}:${name}`, { kind: b.scope.path.isProgram() ? 'global' : 'var', name, line: lineOf(b.identifier) }));
    return bindingKey.get(b);
  };
  const alloc = (n, label) => {
    const a = id(`a${allocs.length}`, { kind: 'alloc', label, line: lineOf(n), node: n });
    allocs.push(a);
    return a;
  };
  const fresh = () => id(`t${tmp++}`, { kind: 'tmp' });
  const fnStack = [];
  const retNode = (fnNode) => id(`r:${fnNode.start}`, { kind: 'ret' });
  const thisNode = (fnNode) => id(`this:${fnNode.start}`, { kind: 'this' });
  const propName = (m) => (!m.computed ? m.property.name : t.isStringLiteral(m.property) ? m.property.value : t.isNumericLiteral(m.property) ? String(m.property.value) : '*');

  // ifadenin değer düğümü (işaretçi taşıyabilen); temel tipli ifadeler için null
  const ev = (p) => {
    const n = p.node;
    switch (n.type) {
      case 'Identifier': return n.name === 'undefined' ? null : varNode(p, n.name);
      case 'ObjectExpression': {
        const a = alloc(n, 'nesne');
        for (const prop of p.get('properties')) {
          if (prop.isObjectProperty()) {
            const v = ev(prop.get('value'));
            const key = prop.node.computed ? '*' : t.isIdentifier(prop.node.key) ? prop.node.key.name : String(prop.node.key.value);
            if (v !== null) store.push([a, key, v, true]);
            else info[a].prims = [...(info[a].prims ?? []), [key, primType(prop.node.value)]];
          } else if (prop.isObjectMethod()) {
            const f = fnAlloc(prop);
            store.push([a, t.isIdentifier(prop.node.key) ? prop.node.key.name : '*', f, true]);
          } else if (prop.isSpreadElement()) {
            const v = ev(prop.get('argument'));
            if (v !== null) { const t2 = fresh(); load.push([t2, v, '*']); store.push([a, '*', t2]); }
          }
        }
        return a;
      }
      case 'ArrayExpression': {
        const a = alloc(n, 'dizi');
        for (const e of p.get('elements')) {
          if (!e.node) continue;
          const v = ev(e.isSpreadElement() ? e.get('argument') : e);
          if (v !== null) store.push([a, '*', v, true]);
        }
        return a;
      }
      case 'FunctionExpression': case 'ArrowFunctionExpression': return fnAlloc(p);
      case 'ClassExpression': return alloc(n, 'sınıf');
      case 'NewExpression': {
        const c = callOf(p, true);
        return c;
      }
      case 'RegExpLiteral': return alloc(n, 'regex');
      case 'CallExpression': case 'OptionalCallExpression': return callOf(p, false);
      case 'MemberExpression': case 'OptionalMemberExpression': {
        const o = ev(p.get('object'));
        if (p.node.computed) ev(p.get('property'));
        const r = fresh();
        if (o !== null) load.push([r, o, propName(n)]);
        return r;
      }
      case 'AssignmentExpression': {
        const v = ev(p.get('right'));
        assignTo(p.get('left'), v);
        return v;
      }
      case 'ConditionalExpression': case 'LogicalExpression': {
        // ?: testi yalnızca iç kısıtları için değerlendirilir; değer dallardan gelir
        const parts = n.type === 'ConditionalExpression' ? [ev(p.get('test')), ev(p.get('consequent')), ev(p.get('alternate'))].slice(1) : [ev(p.get('left')), ev(p.get('right'))];
        const r = fresh();
        for (const x of parts) if (x !== null) copy.push([r, x]);
        return r;
      }
      case 'SequenceExpression': { let last = null; for (const e of p.get('expressions')) last = ev(e); return last; }
      case 'ThisExpression': { const f = fnStack[fnStack.length - 1]; return f && !t.isArrowFunctionExpression(f) ? thisNode(f) : EXT; }
      case 'AwaitExpression': ev(p.get('argument')); return EXT;
      case 'TemplateLiteral': for (const e of p.get('expressions')) ev(e); return null;
      case 'BinaryExpression': case 'UnaryExpression': case 'UpdateExpression':
        for (const k of t.VISITOR_KEYS[n.type]) { const c = p.get(k); if (c.node && !Array.isArray(c)) ev(c); }
        return null;
      default: return null;
    }
  };
  const fnAlloc = (p) => {
    const a = alloc(p.node, 'fonksiyon');
    fnOf.set(a, p.node);
    return a;
  };
  const assignTo = (lp, v) => {
    if (v === null) return;
    if (lp.isIdentifier()) copy.push([varNode(lp, lp.node.name), v]);
    else if (lp.isMemberExpression()) {
      const o = ev(lp.get('object'));
      if (lp.node.computed) ev(lp.get('property'));
      if (o !== null) store.push([o, propName(lp.node), v]);
    } else if (lp.isObjectPattern() || lp.isArrayPattern()) {
      for (const x of lp.isObjectPattern() ? lp.get('properties') : lp.get('elements')) {
        if (!x.node) continue;
        const target = x.isObjectProperty() ? x.get('value') : x.isRestElement() ? x.get('argument') : x;
        const r = fresh();
        load.push([r, v, x.isObjectProperty() && !x.node.computed && t.isIdentifier(x.node.key) ? x.node.key.name : '*']);
        assignTo(target.isAssignmentPattern() ? target.get('left') : target, r);
      }
    } else if (lp.isAssignmentPattern()) assignTo(lp.get('left'), v);
  };
  const callOf = (p, isNew) => {
    const n = p.node;
    let callee;
    let thisArg = null;
    const c = p.get('callee');
    if (c.isMemberExpression()) {
      thisArg = ev(c.get('object'));
      if (c.node.computed) ev(c.get('property'));
      callee = fresh();
      if (thisArg !== null) load.push([callee, thisArg, propName(c.node)]);
    } else callee = ev(c);
    const args = p.get('arguments').map((a) => (a.isSpreadElement() ? ev(a.get('argument')) : ev(a)));
    const ret = isNew ? alloc(n, `new ${gen(n.callee).slice(0, 30)}`) : fresh();
    calls.push({ callee, args, ret, thisArg: isNew ? ret : thisArg, line: lineOf(n), isNew, name: gen(n.callee).slice(0, 60) });
    return ret;
  };
  const primType = (n) => (t.isNumericLiteral(n) ? 'number' : t.isStringLiteral(n) || t.isTemplateLiteral(n) ? 'string' : t.isBooleanLiteral(n) ? 'boolean' : t.isNullLiteral(n) ? 'null' : 'ilkel');

  const paramsOf = new Map(); // fonksiyon düğümü → parametre değişken düğümleri
  traverse(ast, {
    Function: {
      enter(p) {
        fnStack.push(p.node);
        paramsOf.set(p.node, p.node.params.map((x) => (t.isIdentifier(x) ? varNode(p, x.name) : t.isAssignmentPattern(x) && t.isIdentifier(x.left) ? varNode(p, x.left.name) : null)));
        if (p.isFunctionDeclaration() && p.node.id) {
          const a = fnAlloc(p);
          copy.push([varNode(p.parentPath, p.node.id.name), a]);
        }
        if (p.isExpression() && p.node.id) copy.push([varNode(p, p.node.id.name), fnAllocCached(p)]);
      },
      exit() { fnStack.pop(); },
    },
    VariableDeclarator(p) {
      if (!p.node.init) return;
      const v = ev(p.get('init'));
      assignTo(p.get('id'), v);
      p.skip();
    },
    ExpressionStatement(p) { ev(p.get('expression')); p.skip(); },
    ReturnStatement(p) {
      if (!p.node.argument) return;
      const v = ev(p.get('argument'));
      const f = fnStack[fnStack.length - 1];
      if (v !== null && f) copy.push([retNode(f), v]);
      p.skip();
    },
    ThrowStatement(p) { const v = ev(p.get('argument')); if (v !== null) copy.push([EXT, v]); p.skip(); },
    'IfStatement|WhileStatement|DoWhileStatement|SwitchStatement'(p) { const test = p.get(p.isSwitchStatement() ? 'discriminant' : 'test'); if (test.node) ev(test); },
    ForStatement(p) { for (const k of ['test', 'update']) if (p.node[k]) ev(p.get(k)); },
    ForXStatement(p) {
      const r = ev(p.get('right'));
      const it = fresh();
      if (r !== null) load.push([it, r, '*']);
      const left = p.get('left');
      if (left.isVariableDeclaration()) assignTo(left.get('declarations.0.id'), it); else assignTo(left, it);
    },
    ArrowFunctionExpression(p) {
      if (t.isExpression(p.node.body)) { const v = ev(p.get('body')); if (v !== null) copy.push([retNode(p.node), v]); }
    },
  });
  function fnAllocCached(p) {
    for (const [a, node] of fnOf) if (node === p.node) return a;
    return fnAlloc(p);
  }
  return { nodes, info, EXT, allocs, base, copy, load, store, calls, fnOf, retNode, thisNode, paramsOf };
}

// ── E685: Andersen ────────────────────────────────────
export function andersen(c, { maxIter = 200000 } = {}) {
  const N = c.info.length;
  const pts = Array.from({ length: N }, () => new Set());
  const succ = Array.from({ length: N }, () => new Set()); // kopya kenarları: kaynak → hedef
  const field = new Map(); // `${alloc}.${f}` → düğüm id
  const allocFields = new Map(); // tahsis → [[alan, düğüm]]
  const allocLoads = new Map(); // tahsis → [[hedef, alan]] (işlenmiş okumalar)
  const work = [];
  // dönüş/this düğümleri çözüm sırasında da oluşabilir: diziler büyütülür
  const ensure = () => { while (pts.length < c.info.length) { pts.push(new Set()); succ.push(new Set()); } };
  const addEdge = (from, to) => {
    ensure();
    if (succ[from].has(to)) return;
    succ[from].add(to);
    let grew = false;
    for (const a of pts[from]) if (!pts[to].has(a)) { pts[to].add(a); grew = true; }
    if (grew) work.push(to);
  };
  // f alanından okuma: bilinmeyen anahtarlı ('*') okuma/yazma her alanla eşleşir
  const matches = (f, g) => f === g || f === '*' || g === '*';
  const fieldNode = (a, f) => {
    const k = `${a}.${f}`;
    if (!field.has(k)) {
      ensure();
      const idx = c.info.length;
      c.info.push({ key: k, kind: 'field', alloc: a, field: f });
      ensure();
      field.set(k, idx);
      if (!allocFields.has(a)) allocFields.set(a, []);
      allocFields.get(a).push([f, idx]);
      // daha önce işlenmiş eşleşen okumalar yeni alana da bağlanır
      for (const [r, g] of allocLoads.get(a) ?? []) if (matches(f, g)) addEdge(idx, r);
    }
    return field.get(k);
  };
  const linkLoad = (a, r, f) => {
    if (!allocLoads.has(a)) allocLoads.set(a, []);
    allocLoads.get(a).push([r, f]);
    fieldNode(a, f);
    for (const [g, idx] of allocFields.get(a) ?? []) if (matches(f, g)) addEdge(idx, r);
  };
  for (const a of c.allocs) { pts[a].add(a); }
  // tahsis düğümleri kendini gösterir; değişkenlere kopya kenarıyla akar
  for (const [to, from] of c.copy) addEdge(from, to);
  const loadsBy = new Map();
  const storesBy = new Map();
  for (const l of c.load) { if (!loadsBy.has(l[1])) loadsBy.set(l[1], []); loadsBy.get(l[1]).push(l); }
  for (const s of c.store) {
    if (s[3] && c.info[s[0]]?.kind === 'alloc') addEdge(s[2], fieldNode(s[0], s[1]));
    if (!storesBy.has(s[0])) storesBy.set(s[0], []);
    storesBy.get(s[0]).push(s);
  }
  const callsBy = new Map();
  for (const cl of c.calls) { if (!callsBy.has(cl.callee)) callsBy.set(cl.callee, []); callsBy.get(cl.callee).push(cl); }
  const linked = new Set();
  const callGraph = new Map(); // satır → hedef fonksiyonlar
  for (let i = 0; i < N; i++) if (pts[i].size) work.push(i);
  let iter = 0;
  while (work.length && iter++ < maxIter) {
    const v = work.pop();
    for (const a of [...pts[v]]) {
      const seenLoads = new Set();
      for (const [r, , f] of loadsBy.get(v) ?? []) {
        if (seenLoads.has(`${r}:${f}`)) continue;
        seenLoads.add(`${r}:${f}`);
        if (!(allocLoads.get(a) ?? []).some(([x, g]) => x === r && g === f)) linkLoad(a, r, f);
      }
      for (const [, f, src] of storesBy.get(v) ?? []) addEdge(src, fieldNode(a, f));
      for (const cl of callsBy.get(v) ?? []) {
        const fn = c.fnOf.get(a);
        const k = `${cl.line}:${cl.callee}:${a}`;
        if (!fn || linked.has(k)) continue;
        linked.add(k);
        if (!callGraph.has(cl.line)) callGraph.set(cl.line, new Set());
        callGraph.get(cl.line).add(fn.id?.name ?? `<anonim:${lineOf(fn)}>`);
        (c.paramsOf.get(fn) ?? []).forEach((pn, i) => { if (pn != null && cl.args[i] != null) addEdge(cl.args[i], pn); });
        addEdge(c.retNode(fn), cl.ret);
        if (cl.thisArg != null) addEdge(cl.thisArg, c.thisNode(fn));
      }
    }
    for (const s of succ[v]) {
      let grew = false;
      for (const a of pts[v]) if (!pts[s].has(a)) { pts[s].add(a); grew = true; }
      if (grew) work.push(s);
    }
  }
  // bilinmeyen çağrı: argümanlar dışarı kaçar, sonuç dış dünya
  for (const cl of c.calls) {
    const targets = [...pts[cl.callee]].filter((a) => c.fnOf.has(a));
    if (!targets.length) for (const a of cl.args) if (a != null) addEdge(a, c.EXT);
  }
  return { pts, field, callGraph, converged: iter < maxIter };
}

// ── E686: Steensgaard ─────────────────────────────────
export function steensgaard(c) {
  const parent = [];
  const pointee = []; // sınıf → işaret ettiği sınıf
  const find = (x) => { while (parent[x] !== undefined && parent[x] !== x) { parent[x] = parent[parent[x]] ?? parent[x]; x = parent[x]; } return x; };
  const make = (x) => { if (parent[x] === undefined) parent[x] = x; return find(x); };
  const join = (a, b) => {
    a = make(a); b = make(b);
    if (a === b) return a;
    parent[b] = a;
    const pa = pointee[a];
    const pb = pointee[b];
    if (pa !== undefined && pb !== undefined) pointee[a] = join(pa, pb);
    else pointee[a] = pa ?? pb;
    return find(a);
  };
  const deref = (x) => {
    x = make(x);
    if (pointee[x] === undefined) { const n = parent.length; parent[n] = n; pointee[x] = n; }
    return find(pointee[x]);
  };
  // tahsisler: değişken tahsisi gösterir (x = &a); alanlar tek hücreye toplanır (alan duyarsız)
  for (const [to, from] of c.copy) {
    if (c.info[from]?.kind === 'alloc') join(deref(to), from);
    else join(deref(to), deref(from));
  }
  for (const [r, o] of c.load) join(deref(r), deref(deref(o)));
  for (const [o, , v] of c.store) {
    if (c.info[o]?.kind === 'alloc') join(deref(o), c.info[v]?.kind === 'alloc' ? v : deref(v));
    else join(deref(deref(o)), c.info[v]?.kind === 'alloc' ? v : deref(v));
  }
  return { find: (x) => find(make(x)), deref };
}

// ── rapor ─────────────────────────────────────────────
const TAINT_SOURCES = /^(location(\.\w+)?|document\.(cookie|referrer|URL|documentURI|baseURI|domain)|navigator\.\w+|window\.name|localStorage\.getItem|sessionStorage\.getItem|prompt|.*\.responseText|.*\.response|.*\.value|event\.data|e\.data|.*\.json|.*\.text)$/;
const TAINT_SINKS = /^(eval|Function|setTimeout|setInterval|document\.write|document\.writeln|.*\.innerHTML|.*\.outerHTML|.*\.insertAdjacentHTML|location|location\.href|location\.assign|location\.replace|window\.location|fetch|navigator\.sendBeacon|.*\.send|.*\.open|.*\.src|.*\.postMessage|WebSocket|.*\.setAttribute)$/;

export function staticReport(ast, { budgetMs = 2500 } = {}) {
  const t0 = Date.now();
  const out = {};
  const c = buildConstraints(ast);
  const A = andersen(c);
  const S = steensgaard(c);
  const label = (a) => `${c.info[a].label}@${c.info[a].line}`;
  const vars = c.info.map((x, i) => [x, i]).filter(([x]) => x.kind === 'var' || x.kind === 'global');
  // E685/E686
  out.pointsTo = vars.filter(([, i]) => A.pts[i].size && A.pts[i].size <= 12).slice(0, 60).map(([x, i]) => ({
    name: x.name, line: x.line ?? 0, andersen: [...A.pts[i]].map(label), steensgaardClass: S.find(i),
  }));
  const aliasPairs = [];
  for (let i = 0; i < vars.length && aliasPairs.length < 40; i++) {
    for (let j = i + 1; j < vars.length && aliasPairs.length < 40; j++) {
      const [x, a] = vars[i];
      const [y, b] = vars[j];
      const common = [...A.pts[a]].filter((p) => A.pts[b].has(p));
      if (common.length) aliasPairs.push({ a: x.name, b: y.name, objects: common.map(label), steensgaard: S.deref(a) === S.deref(b) });
    }
  }
  out.aliases = aliasPairs;
  out.callGraph = [...A.callGraph].slice(0, 80).map(([line, fns]) => ({ line, targets: [...fns] }));
  // E687: kaçış — globallere, dış dünyaya ya da bilinmeyen çağrılara ulaşan tahsisler (alanları üzerinden kapanış)
  const escaped = new Set(A.pts[c.EXT]);
  for (const [x, i] of vars) if (x.kind === 'global') for (const a of A.pts[i]) escaped.add(a);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [k, idx] of A.field) {
      const a = Number(k.split('.')[0]);
      if (!escaped.has(a)) continue;
      for (const b of A.pts[idx]) if (!escaped.has(b)) { escaped.add(b); grew = true; }
    }
  }
  out.escape = c.allocs.filter((a) => c.info[a].label !== 'fonksiyon').slice(0, 80).map((a) => ({ site: label(a), escapes: escaped.has(a) }));
  // E692: nesne şekilleri
  out.shapes = c.allocs.filter((a) => c.info[a].label === 'nesne').slice(0, 40).map((a) => {
    const props = new Map();
    for (const [k, idx] of A.field) {
      const [al, f] = [Number(k.slice(0, k.indexOf('.'))), k.slice(k.indexOf('.') + 1)];
      if (al !== a) continue;
      const kinds = [...A.pts[idx]].map((b) => c.info[b].label);
      props.set(f, kinds.length ? [...new Set(kinds)].join('|') : 'ilkel');
    }
    for (const [k, ty] of c.info[a].prims ?? []) props.set(k, ty);
    const initial = new Set((c.info[a].node?.properties ?? []).map((p) => (t.isIdentifier(p.key) ? p.key.name : p.key?.value)).filter(Boolean).map(String));
    return { site: label(a), shape: `{ ${[...props].map(([k, v]) => `${k}${initial.has(k) ? '' : '?'}: ${v}`).join(', ')} }` };
  });
  // E688: etki çıkarımı (çağrı grafiği üzerinde sabit nokta)
  out.effects = effects(ast);
  // E689: taint
  out.taint = taintFlows(ast);
  // E690/E691/E693/E694 ve E695
  const fx = ssaFacts(ast, t0 + budgetMs);
  out.variables = fx.variables;
  out.unreachable = fx.unreachable;
  out.ssa = fx.ssa;
  out.ms = Date.now() - t0;
  return out;
}

// Fonksiyon başına doğrudan etkiler + çağrılanlardan aktarılan etkiler
function effects(ast) {
  const fns = [];
  const byName = new Map();
  traverse(ast, {
    Function(p) {
      const name = p.node.id?.name ?? (p.parentPath.isVariableDeclarator() ? p.parent.id.name : null);
      const e = { name: name ?? `<anonim:${lineOf(p.node)}>`, line: lineOf(p.node), writesGlobal: new Set(), writesHeap: false, callsUnknown: new Set(), nondet: new Set(), throws: false, dom: false, calls: new Set() };
      p.traverse({
        Function(q) { q.skip(); },
        AssignmentExpression(q) {
          const left = q.node.left;
          if (t.isIdentifier(left)) { const b = q.scope.getBinding(left.name); if (!b || b.scope.getFunctionParent()?.path !== p) { if (!b || !b.path.findParent((x) => x === p)) e.writesGlobal.add(left.name); } }
          else if (t.isMemberExpression(left)) {
            let root = left;
            while (t.isMemberExpression(root)) root = root.object;
            const b = t.isIdentifier(root) && q.scope.getBinding(root.name);
            const local = b && b.path.findParent((x) => x === p) && t.isVariableDeclarator(b.path.node) && (t.isObjectExpression(b.path.node.init) || t.isArrayExpression(b.path.node.init));
            if (!local) e.writesHeap = true;
            if (t.isIdentifier(root, { name: 'document' }) || t.isIdentifier(root, { name: 'window' })) e.dom = true;
          }
        },
        UpdateExpression(q) { if (t.isIdentifier(q.node.argument) && !q.scope.getBinding(q.node.argument.name)?.path.findParent((x) => x === p)) e.writesGlobal.add(q.node.argument.name); else if (t.isMemberExpression(q.node.argument)) e.writesHeap = true; },
        ThrowStatement() { e.throws = true; },
        CallExpression(q) {
          const callee = gen(q.node.callee);
          if (/^(Math\.random|Date\.now|performance\.now|crypto\.getRandomValues)$/.test(callee)) { e.nondet.add(callee); return; }
          if (t.isIdentifier(q.node.callee) && q.scope.getBinding(q.node.callee.name)) { e.calls.add(q.node.callee.name); return; }
          if (/^(String|Number|Boolean|parseInt|parseFloat|isNaN|Math\.\w+|JSON\.stringify|JSON\.parse)$/.test(callee)) return;
          if (t.isMemberExpression(q.node.callee) && /^(charCodeAt|charAt|indexOf|slice|substring|substr|toUpperCase|toLowerCase|split|join|map|filter|reduce|concat|includes|startsWith|endsWith|trim|replace|toString|push|pop|shift|keys|values|length|test|exec|match|fromCharCode)$/.test(q.node.callee.property?.name ?? '')) {
            if (['push', 'pop', 'shift'].includes(q.node.callee.property.name)) e.writesHeap = true;
            return;
          }
          e.callsUnknown.add(callee.slice(0, 40));
          if (/^(document|window|console|fetch|navigator|localStorage|XMLHttpRequest)/.test(callee)) e.dom = true;
        },
        NewExpression(q) { if (/^(Date)$/.test(gen(q.node.callee)) && !q.node.arguments.length) e.nondet.add('new Date()'); },
      });
      fns.push(e);
      if (e.name) byName.set(e.name, e);
    },
  });
  // aktarma
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 50) {
    changed = false;
    for (const e of fns) for (const c of e.calls) {
      const d = byName.get(c);
      if (!d || d === e) continue;
      const before = `${e.writesGlobal.size}${e.writesHeap}${e.callsUnknown.size}${e.nondet.size}${e.throws}${e.dom}`;
      d.writesGlobal.forEach((x) => e.writesGlobal.add(x));
      e.writesHeap ||= d.writesHeap;
      d.callsUnknown.forEach((x) => e.callsUnknown.add(x));
      d.nondet.forEach((x) => e.nondet.add(x));
      e.throws ||= d.throws;
      e.dom ||= d.dom;
      if (before !== `${e.writesGlobal.size}${e.writesHeap}${e.callsUnknown.size}${e.nondet.size}${e.throws}${e.dom}`) changed = true;
    }
  }
  return fns.slice(0, 80).map((e) => ({
    name: e.name, line: e.line,
    pure: !e.writesGlobal.size && !e.writesHeap && !e.callsUnknown.size && !e.nondet.size,
    deterministic: !e.nondet.size && !e.callsUnknown.size,
    writesGlobal: [...e.writesGlobal].slice(0, 8), writesHeap: e.writesHeap, callsUnknown: [...e.callsUnknown].slice(0, 6),
    nondet: [...e.nondet], throws: e.throws, dom: e.dom,
  }));
}

// Değer akışı: kaynaklardan (ortam/kullanıcı girdisi) havuzlara (kod çalıştırma, DOM, ağ)
function taintFlows(ast) {
  const tainted = new Map(); // bağlama/anahtar → kaynak kümesi
  const keyOf = (p, name) => { const b = p.scope.getBinding(name); return b ? b : `g:${name}`; };
  const fields = new Map(); // "nesneAnahtarı.alan" → kaynaklar (nesneyle değil, değişkenle yaklaşık)
  const flows = [];
  const srcOf = (p) => {
    const n = p.node;
    const out = new Set();
    const add = (s) => s && s.forEach((x) => out.add(x));
    if (p.isIdentifier()) add(tainted.get(keyOf(p, n.name)));
    else if (p.isMemberExpression() || p.isCallExpression() || p.isOptionalMemberExpression()) {
      const full = gen(p.isCallExpression() ? n.callee : n);
      const name = full.replace(/^(window|self|globalThis)\./, '');
      if (TAINT_SOURCES.test(name) || TAINT_SOURCES.test(full)) out.add(full);
      if (p.isMemberExpression()) {
        let root = n;
        while (t.isMemberExpression(root)) root = root.object;
        if (t.isIdentifier(root)) add(fields.get(`${root.name}.${n.computed ? '*' : n.property.name}`));
      }
    }
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      if (t.isFunction(n)) break;
      const c = p.get(k);
      if (Array.isArray(c)) c.forEach((x) => x.node && add(srcOf(x)));
      else if (c.node && !(p.isMemberExpression() && k === 'property' && !n.computed)) add(srcOf(c));
    }
    return out;
  };
  const sinkName = (n) => gen(n).replace(/^(window|self|globalThis)\./, '');
  // iki tur: değişken zincirleri sıradan bağımsız yayılsın
  for (let round = 0; round < 3; round++) {
    traverse(ast, {
      VariableDeclarator(p) {
        if (!p.node.init || !t.isIdentifier(p.node.id)) return;
        const s = srcOf(p.get('init'));
        if (s.size) tainted.set(keyOf(p, p.node.id.name), new Set([...(tainted.get(keyOf(p, p.node.id.name)) ?? []), ...s]));
      },
      AssignmentExpression(p) {
        const s = srcOf(p.get('right'));
        const left = p.node.left;
        if (round === 2) {
          const name = sinkName(left);
          if (s.size && TAINT_SINKS.test(name)) flows.push({ sink: name, line: lineOf(p.node), sources: [...s] });
        }
        if (!s.size) return;
        if (t.isIdentifier(left)) tainted.set(keyOf(p, left.name), new Set([...(tainted.get(keyOf(p, left.name)) ?? []), ...s]));
        else if (t.isMemberExpression(left)) {
          let root = left;
          while (t.isMemberExpression(root)) root = root.object;
          if (t.isIdentifier(root)) fields.set(`${root.name}.${left.computed ? '*' : left.property.name}`, s);
        }
      },
      CallExpression(p) {
        // program fonksiyonuna geçen kirli argüman parametreyi kirletir (bağlamlar arası)
        if (t.isIdentifier(p.node.callee)) {
          const fb = p.scope.getBinding(p.node.callee.name);
          const fn = fb && (t.isFunctionDeclaration(fb.path.node) ? fb.path : fb.path.isVariableDeclarator() && t.isFunction(fb.path.node.init) ? fb.path.get('init') : null);
          if (fn) fn.node.params.forEach((prm, i) => {
            const a = p.get('arguments')[i];
            if (!a || !t.isIdentifier(prm)) return;
            const s = srcOf(a);
            if (!s.size) return;
            const k = fn.scope.getBinding(prm.name);
            if (k) tainted.set(k, new Set([...(tainted.get(k) ?? []), ...s]));
          });
        }
        if (round !== 2) return;
        const name = sinkName(p.node.callee);
        if (!TAINT_SINKS.test(name)) return;
        const s = new Set();
        for (const a of p.get('arguments')) srcOf(a).forEach((x) => s.add(x));
        if (s.size) flows.push({ sink: name, line: lineOf(p.node), sources: [...s] });
      },
      NewExpression(p) {
        if (round !== 2) return;
        const name = sinkName(p.node.callee);
        if (!/^(Function|WebSocket|Worker|EventSource)$/.test(name)) return;
        const s = new Set();
        for (const a of p.get('arguments')) srcOf(a).forEach((x) => s.add(x));
        if (s.size) flows.push({ sink: `new ${name}`, line: lineOf(p.node), sources: [...s] });
      },
    });
  }
  return flows.slice(0, 50);
}

function ssaFacts(ast, deadline) {
  const variables = [];
  const unreachable = [];
  const ssa = { functions: 0, versions: 0, phis: 0, redundantPhis: 0 };
  traverse(ast, {
    Function(p) {
      if (Date.now() > deadline || !t.isBlockStatement(p.node.body)) return;
      const fx = ssaFor(p);
      if (!fx) return;
      sccp(fx);
      absint(fx);
      ssa.functions++;
      ssa.versions += fx.versions.length;
      ssa.phis += fx.blocks.reduce((s, b) => s + b.phis.size, 0);
      ssa.redundantPhis += fx.redundantPhis ?? 0;
      const fname = p.node.id?.name ?? `<anonim:${lineOf(p.node)}>`;
      // değişken başına tüm sürümlerin birleşimi
      const per = new Map();
      for (const ver of fx.versions) {
        // yükseltmeden gelen başlangıç undefined'ı ve TDZ raporda gösterilmez
        if (ver.kind === 'tdz' || ver.kind === 'undef') continue;
        const a = fx.abs.val.get(ver);
        if (!a || !a.ty) continue;
        const name = fx.varOf.get(ver.var).name;
        const prev = per.get(name);
        per.set(name, prev ? { ty: prev.ty | a.ty, lo: Math.min(prev.lo, a.lo), hi: Math.max(prev.hi, a.hi), int: prev.int && a.int, slo: Math.min(prev.slo, a.slo), shi: Math.max(prev.shi, a.shi) } : { ...a });
      }
      for (const [name, a] of per) if (variables.length < 120) variables.push({ fn: fname, name, ...describeAbs(a) });
      // E695: SCCP ile çalıştırılamayan kenarların hedef blokları (koşul sabit)
      if (fx.sccp.converged) {
        for (const b of fx.blocks) {
          if (b.dead || !fx.sccp.blocks.has(b)) continue;
          for (const e of b.succ) {
            if (!e.cond?.path?.node || fx.sccp.edges.has(e)) continue;
            const v = fx.sccp.val;
            const used = [];
            e.cond.path.traverse({ Identifier(q) { const ver = fx.useVer.get(q.node); const c = ver && v.get(ver); if (c && 'c' in c) used.push(`${q.node.name}=${JSON.stringify(c.c)}`); } });
            unreachable.push({ fn: fname, line: lineOf(e.cond.path.node), cond: gen(e.cond.path.node).slice(0, 80), side: e.cond.value ? 'doğru' : 'yanlış', proof: `SCCP: koşul her zaman ${e.cond.value ? 'yanlış' : 'doğru'}${used.length ? ` (${used.join(', ')})` : ''}` });
          }
        }
      }
    },
  });
  void typeNames;
  return { variables, unreachable, ssa };
}
