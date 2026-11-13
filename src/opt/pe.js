import * as t from '@babel/types';
import { constEval } from './lattice.js';
import { literalFor, hasSideEffectSyntax, nodeSize } from './util.js';

// Çevrimiçi kısmi değerlendirici (E602). Fonksiyon gövdesi, bazı parametreleri sabit verilerek yeniden üretilir:
//   - statik (sabit) yereller okundukları yerde literal olur, saf alt ifadeler katlanır;
//   - statik koşullu dallar tek dala iner, statik denetimli döngüler açılır; koşul dinamikleşirse kalan döngü,
//     döngüde atanan yereller dinamik sayılarak genel biçimde bırakılır (önek açma);
//   - her atama çıktıya yazılır: çalışma anı durumu statik ortamla hep tutarlıdır (sonradan dinamikleşme güvenli).
// Desteklenen yereller: fonksiyonun kendi, iç fonksiyonlarca yakalanmayan, adı tekil bağlamaları.

const MAX_UNROLL = 64;
const MAX_GROWTH = 4;

function localsOf(fnPath) {
  const names = new Map();
  let ok = true;
  fnPath.traverse({
    Identifier(p) { if (p.node.name === 'arguments' && p.isReferencedIdentifier() && p.getFunctionParent() === fnPath) ok = false; },
    ThisExpression(p) { if (p.getFunctionParent() === fnPath) ok = false; },
    WithStatement() { ok = false; },
    CallExpression(p) { if (t.isIdentifier(p.node.callee, { name: 'eval' }) && !p.scope.getBinding('eval')) ok = false; },
    TryStatement() { ok = false; },
  });
  if (!ok) return null;
  const owned = [];
  fnPath.traverse({
    Scope(p) {
      if (p.isFunction() && p !== fnPath) return;
      for (const b of Object.values(p.scope.bindings)) owned.push(b);
    },
  });
  for (const b of Object.values(fnPath.scope.bindings)) owned.push(b);
  const seen = new Map();
  for (const b of new Set(owned)) {
    if (!['var', 'let', 'const', 'param'].includes(b.kind)) continue;
    let s = b.scope;
    while (s && !s.path.isFunction()) s = s.parent;
    if (s?.path !== fnPath) continue;
    const name = b.identifier.name;
    if (seen.has(name) && seen.get(name) !== b) { names.delete(name); seen.set(name, null); continue; }
    seen.set(name, b);
    const refs = [...b.referencePaths, ...b.constantViolations];
    if (refs.some((r) => r.getFunctionParent() !== fnPath)) continue;
    names.set(name, b.kind);
  }
  return names;
}

const STATIC = (v) => ({ s: true, v });
const DYN = { s: false };
const cloneEnv = (env) => new Map(env);
function joinEnv(a, b) {
  const out = new Map();
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? DYN;
    const y = b.get(k) ?? DYN;
    out.set(k, x.s && y.s && Object.is(x.v, y.v) ? x : DYN);
  }
  return out;
}

// alt ağaçta atanan yerel adlar
function assignedIn(node, locals) {
  const out = new Set();
  const w = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(w); return; }
    if (t.isFunction(x)) return;
    if ((t.isAssignmentExpression(x) || t.isUpdateExpression(x))) {
      const target = x.left ?? x.argument;
      if (t.isIdentifier(target) && locals.has(target.name)) out.add(target.name);
      else if (t.isPattern(target)) collectPattern(target, locals, out);
    }
    if (t.isVariableDeclarator(x)) collectPattern(x.id, locals, out);
    if (t.isForXStatement(x) && t.isIdentifier(x.left) && locals.has(x.left.name)) out.add(x.left.name);
    for (const k of t.VISITOR_KEYS[x.type] ?? []) w(x[k]);
  };
  w(node);
  return out;
}
function collectPattern(p, locals, out) {
  if (t.isIdentifier(p)) { if (locals.has(p.name)) out.add(p.name); return; }
  for (const k of t.VISITOR_KEYS[p.type] ?? []) {
    const v = p[k];
    if (Array.isArray(v)) v.forEach((c) => c && collectPattern(c, locals, out)); else if (v && typeof v === 'object') collectPattern(v, locals, out);
  }
}
// Çıkarılan koddaki var bildirimleri (iç fonksiyonlar hariç): yükseltme (hoisting) korunmalı
function varNames(node) {
  const out = new Set();
  const w = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(w); return; }
    if (t.isFunction(x)) return;
    if (t.isVariableDeclaration(x) && x.kind === 'var') for (const d of x.declarations) collectPattern(d.id, { has: () => true }, out);
    for (const k of t.VISITOR_KEYS[x.type] ?? []) w(x[k]);
  };
  w(node);
  return out;
}
const hoistDecl = (node) => {
  const names = [...varNames(node)];
  return names.length ? [t.variableDeclaration('var', names.map((n) => t.variableDeclarator(t.identifier(n))))] : [];
};

function ownJump(node) {
  let found = false;
  const w = (x, depth) => {
    if (found || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach((c) => w(c, depth)); return; }
    if (t.isFunction(x)) return;
    if ((t.isBreakStatement(x) || t.isContinueStatement(x)) && (x.label || depth === 0)) { found = true; return; }
    if (t.isLabeledStatement(x)) { found = true; return; }
    const nested = t.isLoop(x) || t.isSwitchStatement(x);
    for (const k of t.VISITOR_KEYS[x.type] ?? []) w(x[k], nested ? depth + 1 : depth);
  };
  w(node, 0);
  return found;
}

export class PartialEvaluator {
  constructor(fnPath) {
    this.fn = fnPath;
    this.scope = fnPath.scope;
    this.locals = localsOf(fnPath);
    this.stats = { folded: 0, branches: 0, unrolled: 0, generic: 0 };
    this.budget = nodeSize(fnPath.node.body) * MAX_GROWTH + 200;
    this.emitted = 0;
  }

  lit(v) { return literalFor(v, this.scope); }

  // ifadeyi statik ortamla katla (yeni düğüm döner, orijinale dokunmaz)
  fold(node, env) {
    const self = this;
    const isStatic = (n) => t.isIdentifier(n) && this.locals.has(n.name) && env.get(n.name)?.s;
    const f = (n, isTarget = false) => {
      if (!n || typeof n !== 'object') return n;
      if (Array.isArray(n)) return n.map((c) => f(c));
      if (t.isIdentifier(n)) {
        if (!isTarget && isStatic(n)) { const l = self.lit(env.get(n.name).v); if (l) { self.stats.folded++; return l; } }
        return t.cloneNode(n);
      }
      if (t.isFunction(n) || t.isClass(n)) return t.cloneNode(n, true);
      if (t.isMemberExpression(n) && !n.computed) return t.memberExpression(f(n.object), t.cloneNode(n.property), false, n.optional);
      if (t.isObjectProperty(n)) return t.objectProperty(n.computed ? f(n.key) : t.cloneNode(n.key), f(n.value), n.computed, n.shorthand && !isStatic(n.value));
      if (t.isAssignmentExpression(n)) return t.assignmentExpression(n.operator, t.isIdentifier(n.left) ? t.cloneNode(n.left) : f(n.left), f(n.right));
      if (t.isUpdateExpression(n)) return t.updateExpression(n.operator, t.isIdentifier(n.argument) ? t.cloneNode(n.argument) : f(n.argument), n.prefix);
      if (t.isUnaryExpression(n, { operator: 'typeof' }) && t.isIdentifier(n.argument) && !this.locals.has(n.argument.name)) return t.cloneNode(n, true);
      const out = { ...n };
      for (const k of t.VISITOR_KEYS[n.type] ?? []) out[k] = f(n[k]);
      delete out.start; delete out.end; delete out.loc; delete out.extra;
      // yapısal katlama
      if (t.isLogicalExpression(out)) {
        const l = this.constOf(out.left);
        if (l) return (out.operator === '&&' ? Boolean(l.c) : out.operator === '||' ? !l.c : l.c == null) ? out.right : out.left;
      }
      if (t.isConditionalExpression(out)) {
        const c = this.constOf(out.test);
        if (c) return c.c ? out.consequent : out.alternate;
      }
      if ((t.isBinaryExpression(out) || t.isUnaryExpression(out) || t.isTemplateLiteral(out) || t.isMemberExpression(out)) && !hasSideEffectSyntax(out)) {
        const c = this.constOf(out);
        if (c) { const l = this.lit(c.c); if (l) return l; }
      }
      return out;
    };
    return f(node);
  }
  constOf(n) {
    if (t.isNumericLiteral(n) || t.isStringLiteral(n) || t.isBooleanLiteral(n) || t.isNullLiteral(n) || t.isUnaryExpression(n) || t.isIdentifier(n) || t.isBinaryExpression(n) || t.isTemplateLiteral(n) || t.isMemberExpression(n)) {
      if (t.isIdentifier(n) && this.locals.has(n.name)) return null;
      const r = constEval(n, () => null, (name) => Boolean(this.scope.getBinding(name)));
      return r && 'c' in r ? r : null;
    }
    return null;
  }

  // ifade deyimi: üst düzey atamalar statik ortamı günceller
  assignEffects(expr, env) {
    const apply = (e) => {
      if (t.isAssignmentExpression(e) && t.isIdentifier(e.left) && this.locals.has(e.left.name)) {
        const name = e.left.name;
        if (['&&=', '||=', '??='].includes(e.operator)) { env.set(name, DYN); return; }
        const rhs = this.constOf(e.right);
        if (e.operator === '=') { env.set(name, rhs ? STATIC(rhs.c) : DYN); return; }
        const cur = env.get(name);
        if (cur?.s && rhs) {
          const r = constEval(t.binaryExpression(e.operator.slice(0, -1), this.lit(cur.v) ?? t.identifier('undefined'), this.lit(rhs.c) ?? t.identifier('undefined')), () => null, () => false);
          env.set(name, r && 'c' in r ? STATIC(r.c) : DYN);
        } else env.set(name, DYN);
        return;
      }
      if (t.isUpdateExpression(e) && t.isIdentifier(e.argument) && this.locals.has(e.argument.name)) {
        const cur = env.get(e.argument.name);
        env.set(e.argument.name, cur?.s && typeof cur.v === 'number' ? STATIC(e.operator === '++' ? cur.v + 1 : cur.v - 1) : DYN);
        return;
      }
      if (t.isSequenceExpression(e)) { e.expressions.forEach(apply); return; }
      for (const n of assignedIn(e, this.locals)) env.set(n, DYN);
    };
    apply(expr);
  }

  // Deyim listesi: { out: deyimler, env, done: 'normal'|'exit'|'mixed' }
  list(stmts, env) {
    const out = [];
    let mayExit = false;
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      const r = this.stmt(s, env);
      out.push(...r.out);
      env = r.env;
      // erişilemez kalan deyimlerdeki var bildirimleri ve fonksiyon bildirimleri yükseltme için korunur
      if (r.done === 'exit') return { out: [...out, ...hoistDecl(stmts.slice(i + 1)), ...stmts.slice(i + 1).filter((x) => t.isFunctionDeclaration(x)).map((x) => t.cloneNode(x, true))], env, done: 'exit' };
      if (r.done === 'mixed') mayExit = true;
      if (this.emitted > this.budget) throw new Error('bütçe');
    }
    return { out, env, done: mayExit ? 'mixed' : 'normal' };
  }

  stmt(s, env) {
    this.emitted += 1;
    const keep = (node, e = env) => ({ out: [node], env: e, done: 'normal' });
    switch (s.type) {
      case 'EmptyStatement': return { out: [], env, done: 'normal' };
      case 'BlockStatement': {
        const r = this.list(s.body, env);
        const lexical = r.out.some((x) => t.isVariableDeclaration(x) && x.kind !== 'var' || t.isClassDeclaration(x) || t.isFunctionDeclaration(x));
        return { ...r, out: lexical ? [t.blockStatement(r.out)] : r.out };
      }
      case 'ExpressionStatement': {
        const e = this.fold(s.expression, env);
        this.assignEffects(e, env);
        // yan etkisiz ve atamasız ifade deyimi düşer
        if (!hasSideEffectSyntax(e) && (t.isLiteral(e) || t.isIdentifier(e) && this.locals.has(e.name))) return { out: [], env, done: 'normal' };
        return keep(t.expressionStatement(e));
      }
      case 'VariableDeclaration': {
        const decls = s.declarations.map((d) => {
          const init = d.init ? this.fold(d.init, env) : null;
          if (t.isIdentifier(d.id) && this.locals.has(d.id.name)) {
            if (init) { const c = this.constOf(init); env.set(d.id.name, c ? STATIC(c.c) : DYN); }
            else if (s.kind !== 'var') env.set(d.id.name, STATIC(undefined));
          } else for (const n of assignedIn(d, this.locals)) env.set(n, DYN);
          return t.variableDeclarator(t.cloneNode(d.id, true), init);
        });
        return keep(t.variableDeclaration(s.kind, decls));
      }
      case 'ReturnStatement': return { out: [t.returnStatement(s.argument ? this.fold(s.argument, env) : null)], env, done: 'exit' };
      case 'ThrowStatement': return { out: [t.throwStatement(this.fold(s.argument, env))], env, done: 'exit' };
      case 'IfStatement': {
        const test = this.fold(s.test, env);
        this.assignEffects(test, env);
        const c = hasSideEffectSyntax(test) ? null : this.constOf(test);
        if (c) {
          this.stats.branches++;
          const branch = c.c ? s.consequent : s.alternate;
          const pruned = hoistDecl(c.c ? s.alternate : s.consequent);
          if (!branch) return { out: pruned, env, done: 'normal' };
          const r = this.stmt(t.isBlockStatement(branch) ? branch : t.blockStatement([branch]), env);
          return { ...r, out: [...pruned, ...r.out] };
        }
        const a = this.stmt(t.isBlockStatement(s.consequent) ? s.consequent : t.blockStatement([s.consequent]), cloneEnv(env));
        const b = s.alternate ? this.stmt(t.isBlockStatement(s.alternate) ? s.alternate : t.blockStatement([s.alternate]), cloneEnv(env)) : { out: [], env: cloneEnv(env), done: 'normal' };
        const envOut = a.done === 'exit' ? b.env : b.done === 'exit' ? a.env : joinEnv(a.env, b.env);
        const done = a.done === 'exit' && b.done === 'exit' ? 'exit' : a.done !== 'normal' || b.done !== 'normal' ? 'mixed' : 'normal';
        return { out: [t.ifStatement(test, t.blockStatement(a.out), b.out.length ? t.blockStatement(b.out) : null)], env: envOut, done };
      }
      case 'ForStatement': case 'WhileStatement': case 'DoWhileStatement': return this.loop(s, env);
      case 'SwitchStatement': {
        const disc = this.fold(s.discriminant, env);
        const dc = !hasSideEffectSyntax(disc) && this.constOf(disc);
        const tests = s.cases.map((c) => (c.test ? this.constOf(this.fold(c.test, env)) : 'default'));
        if (dc && tests.every(Boolean) && !s.cases.some((c) => ownJump(t.blockStatement(c.consequent.filter((x, i, arr) => !(i === arr.length - 1 && t.isBreakStatement(x) && !x.label)))))) {
          let from = tests.findIndex((x) => x !== 'default' && x.c === dc.c);
          if (from < 0) from = tests.indexOf('default');
          this.stats.branches++;
          const pruned = hoistDecl(s.cases.map((x) => x.consequent));
          if (from < 0) return { out: pruned, env, done: 'normal' };
          const body = [...pruned];
          for (let i = from; i < s.cases.length; i++) {
            const cons = s.cases[i].consequent;
            const brk = cons.findIndex((x) => t.isBreakStatement(x) && !x.label);
            if (brk >= 0) { body.push(...cons.slice(0, brk)); break; }
            body.push(...cons);
          }
          return this.stmt(t.blockStatement(body), env);
        }
        return this.generic(s, env);
      }
      default: return this.generic(s, env);
    }
  }

  // Genel kalıntı: alt ağaçta atanan yereller dinamik; diğer statikler okunduğu yerde katlanır
  generic(s, env) {
    this.stats.generic++;
    const assigned = assignedIn(s, this.locals);
    const inner = cloneEnv(env);
    for (const n of assigned) inner.set(n, DYN);
    const out = this.foldStatement(s, inner);
    return { out: [out], env: inner, done: t.isReturnStatement(s) ? 'exit' : 'mixed' };
  }
  foldStatement(s, env) {
    // deyim içindeki ifadeleri katla (bildirim kimlikleri ve hedefler korunur)
    const f = (n) => {
      if (!n || typeof n !== 'object') return n;
      if (Array.isArray(n)) return n.map(f);
      if (t.isExpression(n)) return this.fold(n, env);
      if (t.isFunction(n) || t.isClass(n)) return t.cloneNode(n, true);
      const out = { ...n };
      for (const k of t.VISITOR_KEYS[n.type] ?? []) {
        if ((t.isVariableDeclarator(n) && k === 'id') || (t.isForXStatement(n) && k === 'left') || (t.isCatchClause(n) && k === 'param') || k === 'label') out[k] = t.cloneNode(n[k], true);
        else out[k] = f(n[k]);
      }
      delete out.start; delete out.end; delete out.loc;
      return out;
    };
    return f(s);
  }

  // E604: statik denetimli tur önekleri açılır, koşul dinamikleşince kalan döngü genel biçimde kalır
  loop(s, env) {
    if (ownJump(s.body)) return this.generic(s, env);
    const env0 = cloneEnv(env);
    const out = [];
    if (t.isForStatement(s) && s.init) {
      if (t.isVariableDeclaration(s.init) && s.init.kind !== 'var') return this.generic(s, env);
      const r = this.stmt(t.isVariableDeclaration(s.init) ? s.init : t.expressionStatement(s.init), env);
      out.push(...r.out);
      env = r.env;
    }
    const body = t.isBlockStatement(s.body) ? s.body : t.blockStatement([s.body]);
    const testNode = s.test ?? t.booleanLiteral(true);
    const update = t.isForStatement(s) ? s.update : null;
    let first = true;
    let iters = 0; // açılan tur sayısı (out başlatıcıyı da içerebilir)
    for (let iter = 0; iter < MAX_UNROLL; iter++) {
      if (!(t.isDoWhileStatement(s) && first)) {
        const test = this.fold(testNode, env);
        const c = hasSideEffectSyntax(test) ? null : this.constOf(test);
        // hiç dönmeyen döngünün gövdesindeki var bildirimleri korunur
        if (c && !c.c) { if (iter) this.stats.unrolled++; else out.push(...hoistDecl(s.body)); return { out, env, done: 'normal' }; }
        if (!c) break;
      }
      first = false;
      const r = this.list(body.body, cloneEnv(env));
      if (r.done !== 'normal') {
        // gövdede dinamik çıkış olabilir: bu tur çıktıya yazılır ama sonrası statik izlenemez
        if (r.done === 'exit') { out.push(t.blockStatement(r.out)); this.stats.unrolled++; return { out, env: r.env, done: 'exit' }; }
        return this.residualLoop(s, env0, [], true);
      }
      out.push(t.blockStatement(r.out));
      iters++;
      env = r.env;
      if (update) {
        const u = this.fold(update, env);
        this.assignEffects(u, env);
        out.push(t.expressionStatement(u));
      }
    }
    return this.residualLoop(s, env, out, false, iters);
  }
  residualLoop(s, env, prefix, restart, iters = 0) {
    const assigned = assignedIn(s, this.locals);
    const inner = cloneEnv(env);
    for (const n of assigned) inner.set(n, DYN);
    const body = this.foldStatement(t.isBlockStatement(s.body) ? s.body : t.blockStatement([s.body]), inner);
    const test = s.test ? this.fold(s.test, inner) : null;
    let loopNode;
    if (t.isForStatement(s)) loopNode = t.forStatement(restart && s.init ? this.foldStatement(s.init, env) : null, test, s.update ? this.fold(s.update, inner) : null, body);
    else if (t.isWhileStatement(s)) loopNode = t.whileStatement(test, body);
    // do-while'ın en az bir turu açıldıysa kalan kısım önce koşulu sınar
    else loopNode = iters ? t.whileStatement(test, body) : t.doWhileStatement(body, test);
    if (iters) this.stats.unrolled++;
    this.stats.generic++;
    return { out: [...prefix, loopNode], env: inner, done: 'mixed' };
  }
}

/**
 * Fonksiyonu statik parametrelerle özelleştirir. staticArgs: Map(parametre indeksi → değer).
 * Döner: { fn: yeni FunctionDeclaration düğümü (statik parametreler çıkarılmış), stats } ya da null.
 */
export function specialize(fnPath, staticArgs, name) {
  const node = fnPath.node;
  if (node.async || node.generator || !t.isBlockStatement(node.body) || !node.params.every((p) => t.isIdentifier(p))) return null;
  const pe = new PartialEvaluator(fnPath);
  if (!pe.locals) return null;
  const env = new Map();
  for (const [n, kind] of pe.locals) {
    if (kind === 'var') env.set(n, STATIC(undefined));
    else env.set(n, DYN);
  }
  const prologue = [];
  node.params.forEach((p, i) => {
    if (!pe.locals.has(p.name)) { if (staticArgs.has(i)) env.set(p.name, DYN); return; }
    if (staticArgs.has(i)) {
      env.set(p.name, STATIC(staticArgs.get(i)));
      const l = literalFor(staticArgs.get(i), fnPath.scope);
      if (!l) throw new Error('literal');
      prologue.push(t.variableDeclaration('var', [t.variableDeclarator(t.identifier(p.name), l)]));
    } else env.set(p.name, DYN);
  });
  // statik parametre yerel değilse (iç fonksiyon yakalıyor) özelleştirme anlamsız
  for (const i of staticArgs.keys()) if (!pe.locals.has(node.params[i]?.name)) return null;
  let r;
  try {
    r = pe.list(node.body.body, env);
  } catch {
    return null;
  }
  const params = node.params.filter((_, i) => !staticArgs.has(i)).map((p) => t.identifier(p.name));
  const fn = t.functionDeclaration(t.identifier(name), params, t.blockStatement([...prologue, ...r.out], node.body.directives.map((d) => t.cloneNode(d))));
  return { fn, stats: pe.stats };
}
