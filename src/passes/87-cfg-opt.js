import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { ssaFor, walkEval } from '../opt/ssa.js';
import { sccp, absint, constEval, ALL, BOT } from '../opt/lattice.js';
import { isPureTyped, functionPaths, hasDynamicScope, nodeSize, hasSideEffectSyntax } from '../opt/util.js';
import { toIR, varForVersion, decide, proofText } from '../opt/irbridge.js';
import { mk } from '../symbolic/ir.js';

// Kontrol akışı düzeyi dönüşümler:
//   E675 switch normalizasyonu, E676 kuyruk çoğaltma, E677 atlama ipekleme, E678 if-dönüşümü,
//   E679 yüklemleme (boolean dallar → koşul ifadesi), E593 dallanma korelasyonu (baskın dal olgularıyla kanıt).

export async function run(ast, { onLog, bump }) {
  const st = { switch: 0, tail: 0, thread: 0, ifconv: 0, pred: 0, corr: 0, blocks: 0 };
  // yapısal (SSA gerektirmeyen) dönüşümler
  traverse(ast, {
    // deyim listesindeki yalın blok: bildirim içermiyorsa açılır, boşsa silinir (açma/özelleştirme artıkları)
    BlockStatement: {
      exit(p) {
        if (!Array.isArray(p.container) || p.parentPath.isLabeledStatement()) return;
        if (p.node.body.some((s) => t.isVariableDeclaration(s) && s.kind !== 'var' || t.isFunctionDeclaration(s) || t.isClassDeclaration(s))) return;
        if (p.node.body.length) p.replaceWithMultiple(p.node.body); else p.remove();
        st.blocks++;
      },
    },
    SwitchStatement: { exit(p) { st.switch += normalizeSwitch(p); } },
    ConditionalExpression: { exit(p) { if (predicateCond(p)) st.pred++; } },
    IfStatement: {
      exit(p) {
        if (!p.node) return;
        const r = convertIf(p);
        if (r) st[r]++;
      },
    },
  });
  if (!hasDynamicScope(ast, traverse)) {
    for (const fn of functionPaths(ast, traverse)) {
      if (!fn.node) continue;
      for (let i = 0; i < 6; i++) {
        const fx = ssaFor(fn);
        if (!fx) break;
        sccp(fx);
        absint(fx);
        if (!fx.sccp.converged) break;
        const r = tailDuplicate(fx, fn) || correlate(fx, fn, onLog);
        if (!r) break;
        st[r]++;
        fn.scope.crawl();
      }
    }
  }
  const total = Object.values(st).reduce((a, b) => a + b, 0);
  if (total) onLog(`cfg-opt: ${Object.entries(st).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}`, 'info');
  for (const [k, v] of Object.entries(st)) bump(`cfg.${k}`, v);
}

// ── E675: switch normalizasyonu ────────────────────────
const endsWithJump = (stmts) => {
  const last = stmts[stmts.length - 1];
  return t.isBreakStatement(last) && !last.label || t.isReturnStatement(last) || t.isThrowStatement(last) || t.isContinueStatement(last);
};
const hasLexical = (stmts) => stmts.some((s) => t.isVariableDeclaration(s) && s.kind !== 'var' || t.isFunctionDeclaration(s) || t.isClassDeclaration(s));
// switch'i hedefleyen (etiketsiz, iç döngü/switch dışındaki) break'ler
function innerBreaks(stmts) {
  let n = 0;
  const w = (x, depth) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach((c) => w(c, depth)); return; }
    if (t.isFunction(x)) return;
    if (t.isBreakStatement(x) && !x.label && depth === 0) n++;
    const nested = t.isLoop(x) || t.isSwitchStatement(x);
    for (const k of t.VISITOR_KEYS[x.type] ?? []) w(x[k], nested ? depth + 1 : depth);
  };
  w(stmts, 0);
  return n;
}
function normalizeSwitch(p) {
  const cases = p.node.cases;
  let n = 0;
  if (!cases.length) return 0;
  // son case'in sonundaki gereksiz break
  const last = cases[cases.length - 1];
  if (last.consequent.length && t.isBreakStatement(last.consequent[last.consequent.length - 1]) && !last.consequent[last.consequent.length - 1].label) {
    last.consequent.pop();
    n++;
  }
  // sondaki boş default
  if (!last.test && !last.consequent.length) { cases.pop(); n++; }
  // aynı gövdeli bitişik case'ler: case a: X; break; case b: X; break; → case a: case b: X; break;
  for (let i = 0; i + 1 < cases.length; i++) {
    const a = cases[i];
    const b = cases[i + 1];
    if (!a.test || !b.test || !a.consequent.length || !endsWithJump(a.consequent) || hasLexical(a.consequent)) continue;
    if (gen(t.blockStatement(a.consequent)) !== gen(t.blockStatement(b.consequent))) continue;
    if (hasSideEffectSyntax(b.test)) continue;
    a.consequent = [];
    n++;
  }
  // tek case (+ default) ve düşme yok → if/else
  if (!cases.length) {
    if (!hasSideEffectSyntax(p.node.discriminant) && Array.isArray(p.container)) { p.remove(); return n + 1; }
    return n;
  }
  const real = cases.filter((c) => c.test);
  const def = cases.find((c) => !c.test);
  if (real.length === 1 && Array.isArray(p.container) && !p.parentPath.isLabeledStatement()) {
    const c = real[0];
    const strip = (stmts) => (stmts.length && t.isBreakStatement(stmts[stmts.length - 1]) && !stmts[stmts.length - 1].label ? stmts.slice(0, -1) : stmts);
    const body = strip(c.consequent);
    // son olmayan her clause dolu olmalı ve atlamayla bitmeli (düşme yok)
    if (cases.slice(0, -1).some((x) => !x.consequent.length || !endsWithJump(x.consequent))) return n;
    if (hasLexical(c.consequent) || (def && hasLexical(def.consequent))) return n;
    if (innerBreaks(body) || (def && innerBreaks(strip(def.consequent)))) return n;
    // break dışı atlamayla biten gövde (return/continue/throw) korunur; break yalnızca sonda olmalı
    const test = t.binaryExpression('===', p.node.discriminant, c.test);
    p.replaceWith(t.ifStatement(test, t.blockStatement(body), def && strip(def.consequent).length ? t.blockStatement(strip(def.consequent)) : null));
    n++;
  }
  return n;
}

// ── E679 / E678: yüklemleme ve if-dönüşümü ─────────────
const isBoolExpr = (n) => t.isBooleanLiteral(n) || t.isUnaryExpression(n, { operator: '!' }) ||
  (t.isBinaryExpression(n) && ['===', '!==', '==', '!=', '<', '<=', '>', '>=', 'in', 'instanceof'].includes(n.operator)) ||
  (t.isLogicalExpression(n) && n.operator !== '??' && isBoolExpr(n.left) && isBoolExpr(n.right));
const toBool = (c, positive) => (positive ? (isBoolExpr(c) ? c : t.unaryExpression('!', t.unaryExpression('!', c))) : t.unaryExpression('!', c));

function predicateCond(p) {
  const { test, consequent, alternate } = p.node;
  if (!t.isBooleanLiteral(consequent) || !t.isBooleanLiteral(alternate) || consequent.value === alternate.value) return false;
  p.replaceWith(toBool(test, consequent.value));
  return true;
}

const single = (s) => (t.isBlockStatement(s) ? (s.body.length === 1 ? s.body[0] : null) : s);
const assignOf = (s) => (t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression, { operator: '=' }) && t.isIdentifier(s.expression.left) ? s.expression : null);

// iç içe koşul/virgül ifadesi üretilmez: restructure (E54) ve simplify onları if zincirine geri açar (salınım)
const flat = (...xs) => xs.every((x) => !t.isConditionalExpression(x) && !t.isSequenceExpression(x));

// if/else-if ya da guard zincirinin halkası: tek halkayı koşul ifadesine çevirmek zinciri karma biçime sokar
function inChain(p) {
  if (p.key === 'alternate' && p.parentPath.isIfStatement()) return true;
  if (p.parentPath.isBlockStatement() && p.parentPath.node.body.length === 1 && p.parentPath.key === 'alternate' && p.parentPath.parentPath.isIfStatement()) return true;
  if (!Array.isArray(p.container) || p.key === 0) return false;
  const prev = p.container[p.key - 1];
  return t.isIfStatement(prev) && !prev.alternate && t.isReturnStatement(single(prev.consequent));
}

function convertIf(p) {
  if (inChain(p)) return null;
  const { test, consequent, alternate } = p.node;
  const a = single(consequent);
  const b = alternate ? single(alternate) : null;
  // if (c) x = A; else x = B;  →  x = c ? A : B   (x düz değişken: başvuru çözümü gözlenemez)
  if (a && b && assignOf(a) && assignOf(b) && assignOf(a).left.name === assignOf(b).left.name && flat(assignOf(a).right, assignOf(b).right)) {
    const A = assignOf(a).right;
    const B = assignOf(b).right;
    const bools = t.isBooleanLiteral(A) && t.isBooleanLiteral(B) && A.value !== B.value;
    p.replaceWith(t.expressionStatement(t.assignmentExpression('=', t.identifier(assignOf(a).left.name), bools ? toBool(test, A.value) : t.conditionalExpression(test, A, B))));
    return bools ? 'pred' : 'ifconv';
  }
  // if (c) return A; else return B;  →  return c ? A : B
  if (a && b && t.isReturnStatement(a) && t.isReturnStatement(b) && a.argument && b.argument && flat(a.argument, b.argument)) {
    const bools = t.isBooleanLiteral(a.argument) && t.isBooleanLiteral(b.argument) && a.argument.value !== b.argument.value;
    p.replaceWith(t.returnStatement(bools ? toBool(test, a.argument.value) : t.conditionalExpression(test, a.argument, b.argument)));
    return bools ? 'pred' : 'ifconv';
  }
  // if (c) return A; return B;  →  return c ? A : B
  if (a && !alternate && t.isReturnStatement(a) && a.argument && Array.isArray(p.container)) {
    const next = p.getSibling(p.key + 1);
    if (next.node && next.isReturnStatement() && next.node.argument && flat(a.argument, next.node.argument)) {
      const B = next.node.argument;
      const bools = t.isBooleanLiteral(a.argument) && t.isBooleanLiteral(B) && a.argument.value !== B.value;
      next.remove();
      p.replaceWith(t.returnStatement(bools ? toBool(test, a.argument.value) : t.conditionalExpression(test, a.argument, B)));
      return bools ? 'pred' : 'ifconv';
    }
  }
  return null;
}

// ── E676 / E677: kuyruk çoğaltma ve atlama ipekleme ─────
// S1 (if) ardından gelen küçük S2 (if/return), S1'in normal biten her dalının sonuna kopyalanır. Her dal sonunda
// S2'nin okuduğu bir değişken sabitse kopyadaki koşul katlanır (ipekleme): dal doğrudan doğru hedefe gider.
function tailDuplicate(fx, fn) {
  const { val } = fx.sccp;
  for (const b of fx.blocks) {
    if (!fx.sccp.blocks.has(b) || b.pred.length < 2) continue;
    const edges = b.pred.map((p) => p.succ.find((e) => e.to === b));
    const at = edges[0]?.at;
    if (!edges.every((e) => e?.at?.kind === 'branchEnd' && e.at.ifPath === at.ifPath) || !fx.sccp.blocks.has(b)) continue;
    const S1 = at.ifPath;
    if (!Array.isArray(S1.container) || S1.parentPath.isLabeledStatement()) continue;
    const S2 = S1.getSibling(S1.key + 1);
    if (!S2.node || !(S2.isIfStatement() || S2.isReturnStatement()) || nodeSize(S2.node) > 80) continue;
    let bad = false;
    S2.traverse({ 'FunctionDeclaration|ClassDeclaration'() { bad = true; }, VariableDeclaration(q) { if (q.node.kind !== 'var') bad = true; } });
    if (bad) continue;
    const probe = S2.isIfStatement() ? S2.node.test : S2.node.argument;
    if (!probe) continue;
    // S2 başında (birleşme bloğunda) izlenen değişkenlerin sürümü: dal sonlarındaki sabit değerler
    const outs = b.pred.map((p) => p.out);
    const evalAt = (out) => constEval(probe, (id) => {
      const key = fx.keyOf.get(id);
      if (!key) return null;
      const ver = out.get(key);
      return ver ? val.get(ver) : BOT;
    }, (name) => Boolean(fn.scope.getBinding(name)));
    const results = outs.map(evalAt);
    const joined = constEval(probe, (id) => { const v = fx.useVer.get(id); return v ? val.get(v) : null; }, (name) => Boolean(fn.scope.getBinding(name)));
    if ('c' in joined) continue; // zaten sabit: SCCP halleder
    const decided = results.map((r) => 'c' in r);
    if (S2.isIfStatement() ? !decided.some(Boolean) : !decided.every(Boolean)) continue;
    // ekleme: her dalın sonuna (yoksa else oluşturulur)
    const copies = edges.map((e, i) => {
      if (!S2.isIfStatement()) return t.cloneNode(S2.node, true);
      if (!decided[i]) return t.cloneNode(S2.node, true);
      const taken = results[i].c ? S2.node.consequent : S2.node.alternate;
      return taken ? t.cloneNode(taken, true) : null;
    });
    const threaded = S2.isIfStatement();
    edges.forEach((e, i) => {
      if (!copies[i]) return;
      const side = e.at.ifPath.get(e.at.side);
      if (!side.node) { e.at.ifPath.node.alternate = t.blockStatement([copies[i]]); return; }
      if (side.isBlockStatement()) side.pushContainer('body', copies[i]);
      else side.replaceWith(t.blockStatement([side.node, copies[i]]));
    });
    S2.remove();
    return threaded ? 'thread' : 'tail';
  }
  return null;
}

// ── E593: dallanma korelasyonu ─────────────────────────
// Bir dal koşulu, onu baskılayan dalların (aynı SSA sürümlü) koşullarından çıkıyorsa sabitlenir.
function correlate(fx, fn, onLog) {
  const typeOf = (id) => (fx.useVer.has(id) ? (fx.abs.useAbs(id)?.ty || ALL) : null);
  const termOf = (ver, depth) => {
    if (ver.kind === 'def' && depth < 4) {
      const site = ver.site;
      const rhs = t.isVariableDeclarator(site) ? site.init : t.isAssignmentExpression(site, { operator: '=' }) ? site.right : null;
      if (rhs && isPureTyped(rhs, typeOf, fn.scope)) {
        const ir = toIR(rhs, (id) => (fx.useVer.has(id) ? termOf(fx.useVer.get(id), depth + 1) : null), fn.scope);
        if (ir) return ir;
      }
    }
    return varForVersion(fx, ver);
  };
  const varFor = (id) => (fx.useVer.has(id) ? termOf(fx.useVer.get(id), 0) : null);
  for (const b of fx.rpo) {
    const ins = b.instrs.find((i) => i.kind === 'test');
    if (!ins || !fx.sccp.blocks.has(b) || !ins.path.parentPath.isIfStatement()) continue;
    if (!isPureTyped(ins.path.node, typeOf, fn.scope)) continue;
    const cond = toIR(ins.path.node, varFor, fn.scope);
    if (!cond || cond.k === 'c') continue;
    const facts = [];
    for (let x = b; x && x !== fx.entry; x = fx.idom.get(x)) {
      if (x.pred.length !== 1) continue;
      const e = x.pred[0].succ.find((s) => s.to === x);
      // switch case kenarları (ayırıcı === test) ve for-in/of kenarları koşul doğruluğu değildir
      if (!e?.cond?.path?.node || e.cond.caseOf || !isPureTyped(e.cond.path.node, typeOf, fn.scope)) continue;
      const f = toIR(e.cond.path.node, varFor, fn.scope);
      if (f) facts.push(e.cond.value ? mk('truthy', f) : mk('!', f));
    }
    if (!facts.length) continue;
    const r = decide(cond, facts);
    if (!r) continue;
    // koşul tek başına sabit değilse (o durumda opaque-smt halleder) korelasyondur
    onLog(`cfg-opt: satır ${ins.path.node.loc?.start.line ?? 0}: koşul baskın dallardan ${r.value} (${proofText(r.proof)})`, 'info');
    ins.path.replaceWith(t.booleanLiteral(r.value));
    return 'corr';
  }
  return null;
}
void walkEval;
