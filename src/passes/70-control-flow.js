import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { isPureExpr } from '../util/pure.js';

// obfuscator.io control flow flattening:
//   var o = "2|0|1".split("|"), i = 0;
//   while (true) { switch (o[i++]) { case "0": ...; continue; ... } break; }
// Sıra statik olarak bilindiği için trace'e gerek yok; çıktı birebir eşdeğerdir.

const alwaysTrue = (n) =>
  t.isBooleanLiteral(n, { value: true }) || (t.isNumericLiteral(n) && n.value !== 0) || ['!![]', '!0'].includes(gen(n));

// Sıra anahtarları türüyle tutulur: switch === ile karşılaştırır, "2" ile 2 eşleşmez
const keyOf = (v) => `${typeof v}:${v}`;

function staticOrder(binding) {
  if (!binding?.constant || !binding.path.isVariableDeclarator()) return null;
  const init = binding.path.node.init;
  // E152: sayı (ya da string) dizisi: var o = [2, 0, 1]
  if (t.isArrayExpression(init) && init.elements.length &&
      init.elements.every((e) => t.isNumericLiteral(e) || t.isStringLiteral(e))) return init.elements.map((e) => keyOf(e.value));
  if (!t.isCallExpression(init) || init.arguments.length !== 1 || !t.isStringLiteral(init.arguments[0])) return null;
  const callee = init.callee;
  if (!t.isMemberExpression(callee) || !t.isStringLiteral(callee.object)) return null;
  if (!(t.isIdentifier(callee.property, { name: 'split' }) && !callee.computed)) return null;
  return callee.object.value.split(init.arguments[0].value).map(keyOf);
}

// Case gövdesinde, sondaki dışında dispatcher'ı hedefleyen break/continue var mı?
function hasStrayJump(stmts) {
  let found = false;
  const visit = (node, nested) => {
    if (!node || typeof node !== 'object' || found) return;
    if (t.isFunction(node)) return;
    if ((t.isBreakStatement(node) || t.isContinueStatement(node)) && (node.label || !nested)) { found = true; return; }
    const inner = nested || t.isLoop(node) || t.isSwitchStatement(node);
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach((c) => visit(c, inner));
      else visit(v, inner);
    }
  };
  stmts.forEach((s) => visit(s, false));
  return found;
}

const isLexical = (s) => t.isFunctionDeclaration(s) || t.isClassDeclaration(s) ||
  (t.isVariableDeclaration(s) && s.kind !== 'var');

// Dispatcher biçimi: while (true) { switch (o[i++]) { … } break; } — sıra değişkeni ve indeks bağlamaları
function dispatcherOf(p) {
  if (p.parentPath.isLabeledStatement() || !alwaysTrue(p.node.test)) return null;
  const body = p.node.body;
  if (!t.isBlockStatement(body) || body.body.length !== 2) return null;
  const [sw, brk] = body.body;
  if (!t.isSwitchStatement(sw) || !t.isBreakStatement(brk) || brk.label) return null;
  const d = sw.discriminant;
  if (!t.isMemberExpression(d) || !d.computed || !t.isIdentifier(d.object)) return null;
  if (!t.isUpdateExpression(d.property, { operator: '++', prefix: false }) || !t.isIdentifier(d.property.argument)) return null;
  return { orderB: p.scope.getBinding(d.object.name), idxB: p.scope.getBinding(d.property.argument.name) };
}

function flatten(p, observed = null) {
  if (p.parentPath.isLabeledStatement() || !alwaysTrue(p.node.test)) return false;
  const body = p.node.body;
  if (!t.isBlockStatement(body) || body.body.length !== 2) return false;
  const [sw, brk] = body.body;
  if (!t.isSwitchStatement(sw) || !t.isBreakStatement(brk) || brk.label) return false;

  const d = sw.discriminant;
  if (!t.isMemberExpression(d) || !d.computed || !t.isIdentifier(d.object)) return false;
  if (!t.isUpdateExpression(d.property, { operator: '++', prefix: false }) || !t.isIdentifier(d.property.argument)) return false;

  const orderB = p.scope.getBinding(d.object.name);
  const idxB = p.scope.getBinding(d.property.argument.name);
  const order = observed ?? staticOrder(orderB);
  if (!order || !orderB?.constant || orderB.referencePaths.length !== 1) return false;
  if (!idxB?.path.isVariableDeclarator() || !t.isNumericLiteral(idxB.path.node.init)) return false;
  if (idxB.constantViolations.length !== 1 || idxB.referencePaths.some((r) => r.parent !== d.property)) return false;

  const cases = new Map();
  for (const c of sw.cases) {
    if (!c.test) return false;
    const lit = t.isStringLiteral(c.test) || t.isNumericLiteral(c.test) ? keyOf(c.test.value) : null;
    if (lit === null) return false;
    const stmts = c.consequent.slice();
    const last = stmts[stmts.length - 1];
    let terminal = false;
    if (t.isContinueStatement(last) && !last.label) stmts.pop();
    else if (t.isReturnStatement(last) || t.isThrowStatement(last)) terminal = true;
    else return false;
    if (hasStrayJump(stmts) || stmts.some((s) => t.isFunctionDeclaration(s))) return false;
    cases.set(lit, { stmts, terminal });
  }

  const out = [];
  for (const key of order.slice(idxB.path.node.init.value)) {
    const c = cases.get(key);
    if (!c) break; // eşleşme yok → switch sonrası break → döngü biter
    out.push(...c.stmts.map((s) => t.cloneNode(s, true)));
    if (c.terminal) break;
  }

  if (out.some(isLexical)) p.replaceWith(t.blockStatement(out));
  else if (!Array.isArray(p.container)) p.replaceWith(t.blockStatement(out));
  else if (out.length) p.replaceWithMultiple(out);
  else p.remove();

  orderB.path.remove();
  idxB.path.remove();
  return true;
}

// E154: sıra ifadesi statik değilse (decoder çağrısı, hesaplanmış string) ama programın sabit tablolarından
// deterministik olarak üretiliyorsa (isPureExpr programFns) değerlendirme bağlamında çalıştırılıp gözlenir.
// Deterministik ifade her çalıştırmada aynı sırayı verir: gözlenen sıra ile düzleştirme birebir eşdeğerdir.
async function observeOrders(ast, { sandbox, ctx }) {
  if (!ctx) return new Map();
  const jobs = [];
  traverse(ast, {
    WhileStatement(p) {
      const d = dispatcherOf(p);
      if (!d?.orderB?.constant || !d.orderB.path.isVariableDeclarator() || staticOrder(d.orderB)) return;
      const init = d.orderB.path.get('init');
      if (!init.node || !isPureExpr(init, { programFns: true })) return;
      jobs.push({ node: p.node, src: `JSON.stringify(${gen(init.node)})` });
    },
  });
  const out = new Map();
  if (!jobs.length) return out;
  const r = await sandbox.batchIn(ctx, jobs.map((j) => j.src));
  if (!r.ok) return out;
  jobs.forEach((j, i) => {
    const v = r.results[i];
    if (!v?.ok || v.type !== 'string') return;
    let arr;
    try { arr = JSON.parse(v.value); } catch { return; }
    if (Array.isArray(arr) && arr.length && arr.every((x) => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)))) {
      out.set(j.node, arr.map(keyOf));
    }
  });
  return out;
}

export async function run(ast, { onLog, bump, sandbox, ctx }) {
  const observed = await observeOrders(ast, { sandbox, ctx });
  let n = 0;
  let traced = 0;
  traverse(ast, {
    WhileStatement: {
      exit(p) {
        const order = observed.get(p.node) ?? null;
        if (flatten(p, order)) { n++; if (order) traced++; }
      },
    },
  });
  if (n) onLog(`control-flow: ${n} dispatcher düzleştirildi${traced ? ` (${traced} sıra çalışma anında gözlendi)` : ''}`, 'info');
  bump('controlFlow', n);
  bump('controlFlowTraced', traced);
}

// Sırası statik bilinen obfuscator.io dağıtıcısı mı? vm-lift bu döngüleri bu pass'e bırakır: burada birebir ve
// bildirimleri koruyarak açılırlar.
export function isStaticDispatcher(p) {
  if (!p.isWhileStatement()) return false;
  const d = dispatcherOf(p);
  if (!d) return false;
  if (staticOrder(d.orderB)) return true;
  // sıra string'i henüz depo nesnesinin arkasında olabilir: o.k.split("|"), o = { k: "2|0|1" }
  const init = d.orderB?.constant && d.orderB.path.isVariableDeclarator() ? d.orderB.path.node.init : null;
  const c = t.isCallExpression(init) && init.arguments.length === 1 && t.isStringLiteral(init.arguments[0]) ? init.callee : null;
  if (!t.isMemberExpression(c) || !t.isMemberExpression(c.object) || !t.isIdentifier(c.object.object)) return false;
  const prop = c.computed ? c.property.value : c.property.name;
  const key = c.object.computed ? c.object.property.value : c.object.property.name;
  const ob = d.orderB.path.scope.getBinding(c.object.object.name);
  if (prop !== 'split' || !ob?.constant || !ob.path.isVariableDeclarator() || !t.isObjectExpression(ob.path.node.init)) return false;
  return ob.path.node.init.properties.some((x) => t.isObjectProperty(x) && !x.computed && t.isStringLiteral(x.value) &&
    (t.isIdentifier(x.key, { name: key }) || t.isStringLiteral(x.key, { value: key })));
}
