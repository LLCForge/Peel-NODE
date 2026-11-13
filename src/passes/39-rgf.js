import * as t from '@babel/types';
import { parse as babelParse } from '@babel/parser';
import { traverse } from '../util/ast.js';

// js-confuser RGF (Runtime-Generated Function): fonksiyon gövdeleri string olarak bir diziye konur,
// çalışma anında bir eval yardımcısıyla fonksiyona çevrilir; özgün fonksiyon diziden çağrı yapan bir kabuğa döner:
//   var R = [E('function X(){var[R,A]=arguments;function r(name){…}return r["apply"](this,A)}X;')];
//   function E(code) { if (FLAG) { return eval(code); } }
//   function greet() { return R[0].apply(this, [R, arguments]); }
// 1) E("…") → function X() {…}: eval edilen kod "function X(){…} X;" biçimindeyse sonuç o fonksiyondur.
//    Gömülü fonksiyon E'nin yerel adlarına (code, arguments dışı) dokunmamalı; FLAG sandbox'ta doğrulanır.
// 2) greet() { return R[k].apply(this, [R, arguments]); } → greet(name) { …r'nin gövdesi… }
//    (this ve argümanlar aynen geçer; r kendine/new.target'a/R takma adına başvurmuyorsa).
// Not: kabuğun length özelliği 0'dı, açılınca r'nin parametre sayısı olur (js-confuser preserveFunctionLength
// ile aynı değer ayrıca yazılıyordu).

const MAX_CODE = 500_000;

function parseEmbedded(code) {
  try {
    const ast = babelParse(code, { sourceType: 'script', plugins: ['classProperties', 'classPrivateProperties', 'classPrivateMethods'] });
    const body = ast.program.body;
    if (ast.program.directives.length || body.length < 2) return null;
    const last = body[body.length - 1];
    const fn = body.find((s) => t.isFunctionDeclaration(s) && t.isExpressionStatement(last) && t.isIdentifier(last.expression, { name: s.id?.name }));
    // yardımcı bildirimler (fnLength vb.) ölü kopyalardır: yalnızca döndürülen fonksiyon alınır, başkasına başvurmamalı
    if (!fn || body.slice(0, -1).some((s) => !t.isFunctionDeclaration(s))) return null;
    return { fn, others: body.slice(0, -1).filter((s) => s !== fn).map((s) => s.id.name) };
  } catch {
    return null;
  }
}

// function E(code) { return eval(code); }  ya da  { if (FLAG) { return eval(code); } }  → { param, flag }
function evalHelper(node) {
  if (!t.isFunctionDeclaration(node) || node.params.length !== 1 || !t.isIdentifier(node.params[0])) return null;
  const param = node.params[0].name;
  const isEvalReturn = (s) => t.isReturnStatement(s) && t.isCallExpression(s.argument) &&
    t.isIdentifier(s.argument.callee, { name: 'eval' }) && s.argument.arguments.length === 1 &&
    t.isIdentifier(s.argument.arguments[0], { name: param });
  const body = node.body.body;
  if (body.length !== 1) return null;
  if (isEvalReturn(body[0])) return { param, flag: null };
  const s = body[0];
  if (!t.isIfStatement(s) || s.alternate || !t.isIdentifier(s.test)) return null;
  const c = t.isBlockStatement(s.consequent) ? s.consequent.body : [s.consequent];
  return c.length === 1 && isEvalReturn(c[0]) ? { param, flag: s.test.name } : null;
}

function freeNames(fnNode) {
  const names = new Set();
  const file = t.file(t.program([t.expressionStatement(t.cloneNode(fnNode, true))]));
  traverse(file, {
    Identifier(p) {
      if (p.isReferencedIdentifier() && !p.scope.getBinding(p.node.name)) names.add(p.node.name);
    },
  });
  return names;
}

// function X() { var [R2, A] = arguments; …yardımcılar…; function r(…) {…} return r.apply(this, A); }  → r
function embeddedTarget(fx) {
  const body = fx.body.body;
  if (fx.params.length || body.length < 3) return null;
  const head = body[0];
  if (!t.isVariableDeclaration(head) || head.declarations.length !== 1) return null;
  const { id, init } = head.declarations[0];
  if (!t.isArrayPattern(id) || id.elements.length !== 2 || !id.elements.every((e) => t.isIdentifier(e)) ||
      !t.isIdentifier(init, { name: 'arguments' })) return null;
  const [alias, args] = id.elements.map((e) => e.name);
  const ret = body[body.length - 1];
  const call = ret?.argument;
  if (!t.isReturnStatement(ret) || !t.isCallExpression(call) || call.arguments.length !== 2 ||
      !t.isThisExpression(call.arguments[0]) || !t.isIdentifier(call.arguments[1], { name: args })) return null;
  const m = call.callee;
  const prop = m && (m.computed ? m.property.value : m.property?.name);
  if (!t.isMemberExpression(m) || !t.isIdentifier(m.object) || prop !== 'apply') return null;
  const decls = body.slice(1, -1);
  if (!decls.every((s) => t.isFunctionDeclaration(s))) return null;
  const target = decls.find((s) => s.id.name === m.object.name);
  if (!target || target.async || target.generator) return null;
  // r kendine, yardımcılara, R takma adına, args'a, new.target'a ya da arguments dışı bir şeye bağlı olmamalı
  const banned = new Set([alias, args, target.id.name, ...decls.map((d) => d.id.name)]);
  let bad = false;
  t.traverseFast(target.body, (n) => {
    if (t.isIdentifier(n) && banned.has(n.name)) bad = true;
    if (t.isMetaProperty(n)) bad = true;
  });
  return bad ? null : target;
}

export async function run(ast, { onLog, bump, sandbox, ctx, level }) {
  let program = null;
  traverse(ast, { Program(p) { program = p; p.stop(); } });

  // 1) eval yardımcıları
  const helpers = new Map();
  for (const s of program.get('body')) {
    const h = evalHelper(s.node);
    if (h) helpers.set(s.node.id.name, { ...h, path: s });
  }
  let inlined = 0;
  for (const [name, h] of helpers) {
    const b = program.scope.getBinding(name);
    if (!b?.constant || program.scope.getBinding('eval')) continue;
    if (h.flag) {
      if (!sandbox || !ctx) continue;
      const fb = program.scope.getBinding(h.flag);
      if (!fb || fb.constantViolations.length) continue;
      const r = await sandbox.batchIn(ctx, [`!!${h.flag}`]);
      if (!r.ok || r.results[0]?.value !== true) continue;
    }
    const locals = new Set([h.param, ...Object.keys(h.path.scope.bindings)]);
    for (const ref of b.referencePaths) {
      const call = ref.parentPath;
      if (!call.isCallExpression({ callee: ref.node }) || call.node.arguments.length !== 1) continue;
      const arg = call.node.arguments[0];
      if (!t.isStringLiteral(arg) || arg.value.length > MAX_CODE) continue;
      const parsed = parseEmbedded(arg.value);
      if (!parsed) continue;
      const fx = t.functionExpression(parsed.fn.id, parsed.fn.params, parsed.fn.body, parsed.fn.generator, parsed.fn.async);
      const free = freeNames(fx);
      if ([...free].some((n) => locals.has(n) || parsed.others.includes(n))) continue;
      call.replaceWith(fx);
      inlined++;
    }
  }

  // 2) kabuk fonksiyonları: function F() { return R[k].apply(this, [R, arguments]); }
  program.scope.crawl();
  let collapsed = 0;
  traverse(ast, {
    'FunctionDeclaration|FunctionExpression'(p) {
      const { node } = p;
      if (node.params.length || node.async || node.generator || node.body.body.length !== 1) return;
      const ret = node.body.body[0];
      const call = ret.argument;
      if (!t.isReturnStatement(ret) || !t.isCallExpression(call) || call.arguments.length !== 2) return;
      const [thisArg, list] = call.arguments;
      if (!t.isThisExpression(thisArg) || !t.isArrayExpression(list) || list.elements.length !== 2 ||
          !t.isIdentifier(list.elements[1], { name: 'arguments' })) return;
      const m = call.callee;
      if (!t.isMemberExpression(m) || !t.isMemberExpression(m.object) || !m.object.computed) return;
      const prop = m.computed ? m.property.value : m.property.name;
      const table = m.object.object;
      const idx = m.object.property;
      if (prop !== 'apply' || !t.isIdentifier(table) || !t.isNumericLiteral(idx) || !t.isIdentifier(list.elements[0], { name: table.name })) return;
      const tb = p.scope.getBinding(table.name);
      if (!tb?.constant || !tb.path.isVariableDeclarator() || !t.isArrayExpression(tb.path.node.init)) return;
      const fx = tb.path.node.init.elements[idx.value];
      if (!t.isFunctionExpression(fx)) return;
      const target = embeddedTarget(fx);
      if (!target) return;
      // gömülü kod program kapsamında çözülüyordu: kabuğun bulunduğu yerde aynı adlar yerel bir bağa gitmemeli
      const tfx = t.functionExpression(null, target.params, target.body);
      if ([...freeNames(tfx)].some((n) => { const b = p.scope.getBinding(n); return b && !b.scope.path.isProgram(); })) return;
      node.params = target.params.map((x) => t.cloneNode(x, true));
      node.body = t.cloneNode(target.body, true);
      collapsed++;
    },
  });

  // Kalan eval yardımcısı unused/rename pass'lerini durdurur (eval varken kapsam analizi güvenilmez).
  // Tablo artık okunmuyorsa tablo, yardımcı ve bayrağı silinir; program düzeyi olduğu için yalnızca seviye 4'te.
  let removed = 0;
  if (level >= 4 && collapsed) {
    for (let again = true; again;) {
      again = false;
      program.scope.crawl();
      for (const s of program.get('body')) {
        const decls = s.isVariableDeclaration() ? s.node.declarations : null;
        const isTable = decls?.length === 1 && t.isIdentifier(decls[0].id) && t.isArrayExpression(decls[0].init) &&
          decls[0].init.elements.length && decls[0].init.elements.every((e) => t.isFunctionExpression(e));
        const isHelper = s.isFunctionDeclaration() && helpers.has(s.node.id.name);
        const isFlag = decls?.length === 1 && t.isIdentifier(decls[0].id) &&
          [...helpers.values()].some((h) => h.flag === decls[0].id.name) && t.isCallExpression(decls[0].init) &&
          !decls[0].init.arguments.length && t.isIdentifier(decls[0].init.callee);
        if (!isTable && !isHelper && !isFlag) continue;
        const name = isHelper ? s.node.id.name : decls[0].id.name;
        const b = program.scope.getBinding(name);
        if (!b || b.referencePaths.some((r) => !r.findParent((x) => x === s))) continue;
        if (isFlag) {
          // bayrağı üreten fonksiyon yalnızca varsayılan parametresini döndürür: çağrı yan etkisiz
          const fb = program.scope.getBinding(decls[0].init.callee.name);
          const f = fb?.path.node;
          if (!t.isFunctionDeclaration(f) || f.body.body.length !== 1 || !t.isReturnStatement(f.body.body[0]) ||
              !f.params.every((x) => t.isAssignmentPattern(x) && t.isBooleanLiteral(x.right))) continue;
        }
        s.remove();
        removed++;
        again = true;
      }
    }
  }

  if (inlined || collapsed) onLog(`rgf: ${inlined} eval'li fonksiyon açıldı, ${collapsed} kabuk fonksiyon özgün gövdesine döndü`, 'info');
  bump('rgf', inlined + collapsed + removed);
}
