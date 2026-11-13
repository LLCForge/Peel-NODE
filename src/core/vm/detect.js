import * as t from '@babel/types';
import { traverse, gen } from '../../util/ast.js';

// Bytecode VM tespiti: döngü içinde bir diziden/string'den program sayacıyla (pc) opcode okuyan
// ve okunan değere göre handler seçen yapı. Üç dağıtım biçimi tanınır (E644):
//   switch:   while (…) { var op = code[pc++]; switch (op) { case 0: … } }
//   if-chain: while (…) { var op = code[pc++]; if (op === 0) {…} else if (op === 1) {…} … }
//   table:    while (…) { H[code[pc++]](); }   H = [function () {…}, …]

const MIN_HANDLERS = 3;

export function children(n) {
  const out = [];
  for (const k of t.VISITOR_KEYS[n.type] ?? []) {
    const v = n[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c === 'object') out.push([c, k]); } else if (v && typeof v === 'object') out.push([v, k]);
  }
  return out;
}

// Ön sıralı yürüyüş; fn false döndürürse alt ağaca inilmez
export function walk(node, fn, parent = null, key = null) {
  if (!node || typeof node !== 'object') return;
  if (fn(node, parent, key) === false) return;
  for (const [c, k] of children(node)) walk(c, fn, node, k);
}

// Okuma konumundaki (özellik adı ya da obje anahtarı olmayan) tanımlayıcı mı?
export const isRefPos = (parent, key) => !((t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) && key === 'property' && !parent.computed) &&
  !(t.isObjectProperty(parent) && key === 'key' && !parent.computed) && !(t.isObjectMethod(parent) && key === 'key' && !parent.computed) &&
  !(t.isLabeledStatement(parent) || t.isBreakStatement(parent) || t.isContinueStatement(parent));

export function namesIn(node) {
  const s = new Set();
  walk(node, (n, p, k) => { if (t.isIdentifier(n) && isRefPos(p, k)) s.add(n.name); });
  return s;
}

function loopParts(loop) {
  if (t.isWhileStatement(loop)) return { kind: 'while', test: loop.test, update: null, init: null };
  if (t.isDoWhileStatement(loop)) return { kind: 'do', test: loop.test, update: null, init: null };
  if (t.isForStatement(loop)) return { kind: 'for', test: loop.test, update: loop.update, init: loop.init };
  return null;
}

const bodyList = (loop) => (t.isBlockStatement(loop.body) ? loop.body.body : [loop.body]);

// fetch ifadesi: X[I] ya da X.charCodeAt(I) — I, döngüde değişen bir tanımlayıcı (pc) içerir
function findFetch(expr, assignedInLoop) {
  let found = null;
  walk(expr, (n) => {
    if (found) return false;
    let X = null;
    let I = null;
    let isString = false;
    if (t.isMemberExpression(n) && n.computed && t.isIdentifier(n.object)) { X = n.object.name; I = n.property; }
    if (t.isCallExpression(n) && t.isMemberExpression(n.callee) && !n.callee.computed && t.isIdentifier(n.callee.object) &&
        ['charCodeAt', 'codePointAt', 'charAt'].includes(n.callee.property.name) && n.arguments.length === 1) {
      X = n.callee.object.name; I = n.arguments[0]; isString = true;
    }
    if (!X) return undefined;
    const pcs = [...namesIn(I)].filter((x) => assignedInLoop.has(x) && x !== X);
    if (pcs.length !== 1) return undefined;
    found = { code: X, pc: pcs[0], isString };
    return false;
  });
  return found;
}

function assignedNames(node) {
  const s = new Set();
  walk(node, (n) => {
    if (t.isAssignmentExpression(n) && t.isIdentifier(n.left)) s.add(n.left.name);
    if (t.isUpdateExpression(n) && t.isIdentifier(n.argument)) s.add(n.argument.name);
    if (t.isVariableDeclarator(n) && t.isIdentifier(n.id) && n.init) s.add(n.id.name);
  });
  return s;
}

const litValue = (n) => (t.isNumericLiteral(n) || t.isStringLiteral(n) ? n.value
  : t.isUnaryExpression(n, { operator: '-' }) && t.isNumericLiteral(n.argument) ? -n.argument.value : undefined);

// if (op === 0) … else if (op === 1) … — konu ifadesi (op) ve kollar.
// Olumsuz biçim de tanınır (çevrilmiş kodda sık): if (!(op === 0)) { if (!(op === 1)) … } else { kol 0 }
function eqTest(test) {
  let te = test;
  let neg = false;
  while (t.isUnaryExpression(te, { operator: '!' })) { te = te.argument; neg = !neg; }
  if (!t.isBinaryExpression(te) || !['===', '==', '!==', '!='].includes(te.operator)) return null;
  if (te.operator[0] === '!') neg = !neg;
  let s = te.left;
  let v = litValue(te.right);
  if (v === undefined) { s = te.right; v = litValue(te.left); }
  if (v === undefined) return null;
  return { subject: s, value: v, neg };
}

function chainStep(cur) {
  const eq = eqTest(cur.test);
  if (!eq) return null;
  const arm = eq.neg ? cur.alternate : cur.consequent;
  const other = eq.neg ? cur.consequent : cur.alternate;
  let next = other;
  if (t.isBlockStatement(next) && next.body.length === 1 && t.isIfStatement(next.body[0])) next = next.body[0];
  return { eq, arm, other, next: t.isIfStatement(next) ? next : null };
}

export function ifChainNodes(stmt) {
  const nodes = new Set();
  for (let cur = stmt; cur; ) {
    const st = chainStep(cur);
    if (!st) break;
    nodes.add(cur);
    cur = st.next;
  }
  return nodes;
}

function ifChain(stmt) {
  const arms = [];
  let subject = null;
  let elseNode = null;
  let cur = stmt;
  while (cur) {
    const st = chainStep(cur);
    if (!st || !st.arm) return null;
    const src = gen(st.eq.subject);
    if (subject === null) subject = { node: st.eq.subject, src };
    else if (subject.src !== src) return null;
    arms.push({ key: st.eq.value, node: st.arm });
    if (st.next && chainStep(st.next)) cur = st.next;
    else { elseNode = st.other ?? null; cur = null; }
  }
  if (arms.length < MIN_HANDLERS) return null;
  return { subject: subject.node, arms, elseNode };
}

// Döngü gövdesinde dağıtım: switch / if-chain / tablo çağrısı
function findDispatch(stmts) {
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    if (t.isSwitchStatement(s) && s.cases.filter((c) => c.test).length >= MIN_HANDLERS) {
      return { style: 'switch', index: i, node: s, disc: s.discriminant };
    }
    if (t.isIfStatement(s)) {
      const ch = ifChain(s);
      if (ch) return { style: 'if-chain', index: i, node: s, disc: ch.subject, chain: ch };
    }
    const call = t.isExpressionStatement(s) ? s.expression : null;
    if (t.isCallExpression(call) && t.isMemberExpression(call.callee) && call.callee.computed && t.isIdentifier(call.callee.object)) {
      return { style: 'table', index: i, node: s, disc: call.callee.property, table: call.callee.object.name };
    }
  }
  return null;
}

// Tablo biçimi: H = [function () {…}, …] ya da { 0: function () {…} } — VM kapsamında
function resolveTable(loopPath, name) {
  const b = loopPath.scope.getBinding(name);
  if (!b?.path.isVariableDeclarator()) return null;
  const init = b.path.node.init;
  const out = [];
  const fnOk = (f) => t.isFunctionExpression(f) && !f.params.length && !f.async && !f.generator;
  if (t.isArrayExpression(init)) {
    init.elements.forEach((e, i) => { if (fnOk(e)) out.push({ key: i, fn: e, fnPath: b.path.get(`init.elements.${i}`) }); });
  } else if (t.isObjectExpression(init)) {
    init.properties.forEach((p, i) => {
      if (!t.isObjectProperty(p) || p.computed || !fnOk(p.value)) return;
      const key = t.isIdentifier(p.key) ? p.key.name : p.key.value;
      out.push({ key: /^\d+$/.test(String(key)) ? Number(key) : key, fn: p.value, fnPath: b.path.get(`init.properties.${i}.value`) });
    });
  }
  if (b.constantViolations.length || out.length < MIN_HANDLERS) return null;
  return out;
}

// Rol çıkarımı (E641): yığın, yığın işaretçisi, register dizisi, sabit havuzu
function inferRoles(handlerNodes, codeName, pcName) {
  const pushPop = new Map();
  const spStore = new Map();
  const indexedWrite = new Map();
  const indexedRead = new Map();
  const inc = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  const touchesCode = (n) => {
    let hit = false;
    walk(n, (x) => { if (t.isIdentifier(x, { name: codeName })) hit = true; });
    return hit;
  };
  // handler içinde bytecode'dan okunan işlenen değişkenleri: var n = code[pc++]
  const operandVars = new Set();
  for (const h of handlerNodes) {
    walk(h, (n) => {
      if (t.isVariableDeclarator(n) && t.isIdentifier(n.id) && n.init && touchesCode(n.init)) operandVars.add(n.id.name);
      if (t.isAssignmentExpression(n) && t.isIdentifier(n.left) && touchesCode(n.right)) operandVars.add(n.left.name);
    });
  }
  operandVars.delete(pcName);
  const isOperand = (p) => touchesCode(p) || (t.isIdentifier(p) && operandVars.has(p.name));
  for (const h of handlerNodes) {
    walk(h, (n, parent) => {
      if (t.isCallExpression(n) && t.isMemberExpression(n.callee) && !n.callee.computed && t.isIdentifier(n.callee.object) &&
          ['push', 'pop'].includes(n.callee.property.name)) inc(pushPop, n.callee.object.name);
      if (t.isMemberExpression(n) && n.computed && t.isIdentifier(n.object) && n.object.name !== codeName && t.isUpdateExpression(n.property) &&
          t.isIdentifier(n.property.argument) && n.property.argument.name !== pcName) {
        inc(spStore, `${n.object.name}|${n.property.argument.name}`);
      }
      if (t.isMemberExpression(n) && n.computed && t.isIdentifier(n.object) && n.object.name !== codeName) {
        const isWrite = t.isAssignmentExpression(parent) && parent.left === n;
        if (isOperand(n.property)) {
          inc(isWrite ? indexedWrite : indexedRead, n.object.name);
        }
      }
    });
  }
  const best = (m, min = 2, exclude = new Set()) => [...m].filter(([k]) => !exclude.has(k)).sort((a, b) => b[1] - a[1]).find(([, v]) => v >= min)?.[0] ?? null;
  let stack = best(pushPop);
  let sp = null;
  if (!stack) {
    const s = best(spStore);
    if (s) [stack, sp] = s.split('|');
  }
  const ex = new Set([stack, codeName].filter(Boolean));
  const regs = best(indexedWrite, 1, ex);
  if (regs) ex.add(regs);
  const consts = best(new Map([...indexedRead].filter(([k]) => !indexedWrite.has(k))), 1, ex);
  return { stack, sp, regs, consts };
}

// Döngü yolu için VM tanımı; bytecode VM değilse null
export function describeLoop(p) {
  const parts = loopParts(p.node);
  if (!parts) return null;
  const stmts = bodyList(p.node);
  const d = findDispatch(stmts);
  if (!d) return null;
  const assigned = assignedNames(p.node);
  // opcode ifadesi: doğrudan fetch ya da önceki deyimde atanmış op değişkeni
  let opVar = null;
  let fetchExpr = d.disc;
  if (t.isIdentifier(d.disc)) {
    opVar = d.disc.name;
    for (const s of stmts.slice(0, d.index)) {
      walk(s, (n) => {
        if (t.isVariableDeclarator(n) && t.isIdentifier(n.id, { name: opVar }) && n.init) fetchExpr = n.init;
        if (t.isAssignmentExpression(n, { operator: '=' }) && t.isIdentifier(n.left, { name: opVar })) fetchExpr = n.right;
      });
    }
  }
  const fetch = findFetch(fetchExpr, assigned);
  if (!fetch) return null;

  let handlers;
  if (d.style === 'switch') {
    handlers = d.node.cases.map((c, i) => ({ key: c.test ? litValue(c.test) : 'default', index: i, node: c }));
    if (handlers.some((h) => h.key === undefined)) return null;
  } else if (d.style === 'if-chain') {
    handlers = d.chain.arms.map((a, i) => ({ key: a.key, index: i, node: a.node }));
    if (d.chain.elseNode) handlers.push({ key: 'default', index: handlers.length, node: d.chain.elseNode });
  } else {
    const tab = resolveTable(p, d.table);
    if (!tab) return null;
    handlers = tab.map((h, i) => ({ key: h.key, index: i, node: h.fn.body, fn: h.fn, fnPath: h.fnPath }));
  }
  const roles = inferRoles(handlers.map((h) => h.node), fetch.code, fetch.pc);
  const fnPath = p.getFunctionParent() ?? p.findParent((x) => x.isProgram());
  let label = null;
  let stmtPath = p;
  while (stmtPath.parentPath.isLabeledStatement()) { label = label ?? stmtPath.parentPath.node.label.name; stmtPath = stmtPath.parentPath; }
  return {
    loopPath: p, stmtPath, fnPath, label, ...parts,
    body: stmts, style: d.style, dispatchIndex: d.index, dispatch: d.node, disc: d.disc, table: d.table ?? null,
    opVar, fetchExpr, handlers,
    roles: { code: fetch.code, pc: fetch.pc, isString: fetch.isString, op: opVar, ...roles },
  };
}

// Programdaki tüm bytecode VM'leri; iç içe olanlar (bir handler'ın içindeki VM) parent ile işaretlenir (E654)
export function findVms(ast) {
  const vms = [];
  traverse(ast, {
    Loop(p) {
      const vm = describeLoop(p);
      if (vm) vms.push(vm);
    },
  });
  for (const vm of vms) {
    const outer = vms.find((o) => o !== vm && vm.loopPath.findParent((x) => x === o.loopPath));
    vm.parent = outer ? vms.indexOf(outer) : null;
  }
  vms.forEach((vm, i) => { vm.id = i; });
  return vms;
}

// Dağıtım stili (E644) ve kısa özet
export function vmSummary(vm) {
  return {
    id: vm.id,
    style: vm.style,
    loop: vm.kind,
    handlers: vm.handlers.length,
    roles: { ...vm.roles },
    fn: vm.fnPath.isProgram() ? '(program)' : vm.fnPath.node.id?.name ?? '(anonim)',
    parent: vm.parent,
    line: vm.loopPath.node.loc?.start.line ?? null,
  };
}
