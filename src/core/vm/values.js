import * as t from '@babel/types';
import { gen } from '../../util/ast.js';
import { HOLE } from './interp.js';

// VM girişindeki değerler: bytecode, sabit havuzu, durum değişkenleri (pc…) ve yığın derinliği.
// Önce statik olarak (literal başlangıç, literal çağrı argümanı) bulunur; bulunamayanlar sandbox'ta
// döngüye giriş anında yakalanır (madde 38: şifreli/çalışma anında üretilen bytecode).

const MAX_CAPTURE = 200_000;

export function literalData(node) {
  if (t.isStringLiteral(node)) return { ok: true, v: node.value };
  if (!t.isArrayExpression(node)) return { ok: false };
  const out = [];
  for (const e of node.elements) {
    if (t.isNumericLiteral(e) || t.isStringLiteral(e) || t.isBooleanLiteral(e)) out.push(e.value);
    else if (t.isNullLiteral(e)) out.push(null);
    else if (t.isUnaryExpression(e, { operator: '-' }) && t.isNumericLiteral(e.argument)) out.push(-e.argument.value);
    else if (e === null) out.push(undefined);
    else out.push(HOLE);
  }
  return { ok: true, v: out };
}

const primLiteral = (n) => {
  if (t.isNumericLiteral(n) || t.isStringLiteral(n) || t.isBooleanLiteral(n)) return { ok: true, v: n.value };
  if (t.isNullLiteral(n)) return { ok: true, v: null };
  if (t.isUnaryExpression(n, { operator: '-' }) && t.isNumericLiteral(n.argument)) return { ok: true, v: -n.argument.value };
  if (t.isIdentifier(n, { name: 'undefined' })) return { ok: true, v: undefined };
  return { ok: false };
};

// Bildirim, döngüden önce ve her döngü girişinden önce bir kez çalışıyor mu?
function declDominates(b, vm) {
  if (!b.path.isVariableDeclarator()) return false;
  const declStmt = b.path.parentPath;
  const list = declStmt.parentPath;
  if (!Array.isArray(declStmt.container)) return false;
  let anc = vm.stmtPath;
  while (anc && anc.parentPath !== list) {
    if (anc.isLoop() && anc !== vm.loopPath) return false;
    if (anc.isFunction()) return false;
    anc = anc.parentPath;
  }
  if (!anc || anc.container !== declStmt.container || anc.key <= declStmt.key) return false;
  const inLoop = (p) => p === vm.loopPath || p.findParent((x) => x === vm.loopPath);
  return b.constantViolations.every(inLoop);
}

// Statik değerler; params: VM fonksiyonu parametresiyse çağrı yerindeki argümanlar
export function staticValues(vm, stateVars, args = null) {
  const scope = vm.loopPath.scope;
  const fn = vm.fnPath.isProgram() ? null : vm.fnPath.node;
  const arrays = new Map();
  const state = new Map();
  const valueOf = (name, kind) => {
    const b = scope.getBinding(name);
    if (!b) return { ok: false };
    if (b.kind === 'param' && fn && args) {
      const i = fn.params.findIndex((p) => t.isIdentifier(p, { name }));
      if (i < 0 || b.constantViolations.length) return { ok: false };
      const a = args[i];
      if (!a) return kind === 'prim' ? { ok: true, v: undefined } : { ok: false };
      return kind === 'prim' ? primLiteral(a) : literalData(a);
    }
    if (!b.path.isVariableDeclarator() || !b.path.node.init) return { ok: false };
    if (kind === 'array') return b.constantViolations.length ? { ok: false } : literalData(b.path.node.init);
    return declDominates(b, vm) ? primLiteral(b.path.node.init) : { ok: false };
  };
  const { code, consts, stack } = vm.roles;
  const c = valueOf(code, 'array');
  if (c.ok) arrays.set(code, c.v);
  if (consts) {
    const k = valueOf(consts, 'array');
    if (k.ok) arrays.set(consts, k.v);
  }
  for (const v of stateVars) {
    const r = valueOf(v, 'prim');
    if (r.ok) state.set(v, r.v);
  }
  let stackInit = null;
  if (stack) {
    const b = scope.getBinding(stack);
    if (b?.path.isVariableDeclarator() && t.isArrayExpression(b.path.node.init) && !b.path.node.init.elements.length && declDominates(b, vm)) stackInit = 0;
  } else stackInit = 0;
  return { arrays, state, stackInit };
}

// ── çalışma anı yakalama ────────────────────────────────

export const CAPTURE_PRELUDE = `
var __peelVmSite = [];
var __peelVmSeen = {};
var __peelVmTrace = {};
var __peelVmTraceN = 0;
function __peelVmData(v) {
  if (typeof v === "string") return { s: v };
  if (!Array.isArray(v) || v.length > ${MAX_CAPTURE}) return null;
  var out = [];
  for (var i = 0; i < v.length; i++) {
    var x = v[i];
    if (x === undefined) out.push({ u: 1 });
    else if (x === null || typeof x === "string" || typeof x === "boolean") out.push(x);
    else if (typeof x === "number") out.push(x === x && x !== 1 / 0 && x !== -1 / 0 ? x : { n: String(x) });
    else out.push({ h: 1 });
  }
  return { a: out };
}
function __peelVmPrim(x) {
  if (x === undefined) return { u: 1 };
  if (typeof x === "number" && (x !== x || x === 1 / 0 || x === -1 / 0)) return { n: String(x) };
  if (x === null || typeof x === "string" || typeof x === "boolean" || typeof x === "number") return x;
  return { h: 1 };
}
function __peelVmEnter(id, names, vals, arrs, depth) {
  var rec = { names: names, vals: vals.map(__peelVmPrim), arrs: arrs.map(__peelVmData), depth: depth };
  var s = JSON.stringify(rec);
  var keys = [id + "|*", id + "|" + (__peelVmSite.length ? __peelVmSite[__peelVmSite.length - 1] : "-")];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!(k in __peelVmSeen)) __peelVmSeen[k] = s; else if (__peelVmSeen[k] !== s) __peelVmSeen[k] = null;
  }
}
function __peelVmAt(site, fn) {
  __peelVmSite.push(site);
  try { return fn(); } finally { __peelVmSite.pop(); }
}
function __peelVmTop(v) {
  if (v === undefined) return "undefined";
  if (v === null || typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? v.slice(0, 40) + "…" : v);
  if (typeof v === "function") return "ƒ " + (v.name || "anonim");
  return Array.isArray(v) ? "[dizi]" : "{nesne}";
}
function __peelVmStep(id, pc, st, regs) {
  if (__peelVmTraceN++ >= 20000) return;
  var tr = __peelVmTrace[id] || (__peelVmTrace[id] = []);
  var top = [];
  if (st && typeof st.length === "number") for (var i = st.length - 1; i >= 0 && top.length < 4; i--) top.push(__peelVmTop(st[i]));
  var rg = [];
  if (regs && typeof regs.length === "number") for (var j = 0; j < regs.length && j < 16; j++) rg.push(__peelVmTop(regs[j]));
  tr.push([typeof pc === "number" ? pc : String(pc), st && typeof st.length === "number" ? st.length : -1, top, rg]);
}
`;

const decodeData = (d) => {
  if (!d) return null;
  if ('s' in d) return d.s;
  return d.a.map((x) => (x && typeof x === 'object' ? ('u' in x ? undefined : 'n' in x ? Number(x.n) : HOLE) : x));
};
const decodePrim = (x) => (x && typeof x === 'object' ? ('u' in x ? { ok: true, v: undefined } : 'n' in x ? { ok: true, v: Number(x.n) } : { ok: false }) : { ok: true, v: x });

export function decodeCapture(json) {
  if (typeof json !== 'string') return null;
  const rec = JSON.parse(json);
  const state = new Map();
  rec.names.forEach((n, i) => {
    const p = decodePrim(rec.vals[i]);
    if (p.ok) state.set(n, p.v);
  });
  return { state, arrays: rec.arrs.map(decodeData), depth: rec.depth };
}

// Programı VM girişlerini ve adımlarını kaydedecek biçimde araçla; aracı geri al, kodu döndür.
// vms[i].capture = { names, arrays } kayıt edilecek adlar.
export function instrument(ast, vms, { trace = true } = {}) {
  const undo = [];
  vms.forEach((vm, k) => {
    const sp = vm.stmtPath;
    if (!Array.isArray(sp.container)) return;
    const names = vm.capture.names;
    const arrs = vm.capture.arrays;
    const S = vm.roles.stack;
    const enter = t.expressionStatement(t.callExpression(t.identifier('__peelVmEnter'), [
      t.numericLiteral(k),
      t.arrayExpression(names.map((n) => t.stringLiteral(n))),
      t.arrayExpression(names.map((n) => t.conditionalExpression(
        t.binaryExpression('!==', t.unaryExpression('typeof', t.identifier(n)), t.stringLiteral('undefined')), t.identifier(n), t.identifier('undefined')))),
      t.arrayExpression(arrs.map((n) => t.identifier(n))),
      S ? t.memberExpression(t.identifier(S), t.identifier('length')) : t.numericLiteral(0),
    ]));
    const container = sp.container;
    container.splice(container.indexOf(sp.node), 0, enter);
    undo.push(() => container.splice(container.indexOf(enter), 1));
    if (trace) {
      const loop = vm.loopPath.node;
      const step = t.expressionStatement(t.callExpression(t.identifier('__peelVmStep'), [
        t.numericLiteral(k), t.identifier(vm.roles.pc),
        S ? t.identifier(S) : t.nullLiteral(),
        vm.roles.regs ? t.identifier(vm.roles.regs) : t.nullLiteral(),
      ]));
      if (t.isBlockStatement(loop.body)) {
        loop.body.body.unshift(step);
        undo.push(() => loop.body.body.splice(loop.body.body.indexOf(step), 1));
      } else {
        const orig = loop.body;
        loop.body = t.blockStatement([step, orig]);
        undo.push(() => { loop.body = orig; });
      }
    }
    // fonksiyon VM'i: doğrudan çağrı yerleri __peelVmAt(site, () => F(…)) ile işaretlenir
    for (const site of vm.capture.sites ?? []) {
      const call = site.path.node;
      const parent = site.path.parentPath;
      const wrapped = t.callExpression(t.identifier('__peelVmAt'), [t.stringLiteral(site.id), t.arrowFunctionExpression([], call)]);
      const key = site.path.key;
      const listKey = site.path.listKey;
      if (listKey) {
        parent.node[listKey][key] = wrapped;
        undo.push(() => { parent.node[listKey][key] = call; });
      } else {
        parent.node[key] = wrapped;
        undo.push(() => { parent.node[key] = call; });
      }
    }
  });
  const code = gen(ast);
  for (const u of undo.reverse()) u();
  return code;
}

export async function captureRun(sandbox, code) {
  const r = await sandbox.run(`${CAPTURE_PRELUDE}\ntry {\n${code}\n} catch (e) {}\n__res.push(JSON.stringify(__peelVmSeen));\n__res.push(JSON.stringify(__peelVmTrace));`, { timeoutMs: 8000 });
  const res = r.res ?? [];
  let seen = {};
  let trace = {};
  try { seen = JSON.parse(res[0] ?? '{}'); trace = JSON.parse(res[1] ?? '{}'); } catch { /* boş */ }
  return { seen, trace, out: r.out ?? [] };
}
