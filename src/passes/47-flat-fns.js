import * as t from '@babel/types';
import { traverse } from '../util/ast.js';

// js-confuser flatten: fonksiyon gövdesi program düzeyine taşınır, dış değişkenlere bir "düz nesne" ile erişilir:
//   function greet(...A) { var O = { get k() { return x; }, set k(v) { x = v; }, c(...a) { return f(...a); },
//                                    get t() { return typeof y; } }; return F(O, A); }
//   function F(O, [name]) { return O["k"] + O["c"](name) + O["t"]; }
// Geri dönüş: O["k"] → x, O["c"](…) → f(…), O["t"] → typeof y; greet'in parametreleri F'nin dizi kalıbındaki
// öğeler, gövdesi F'nin gövdesi olur; F silinir.
// Koşullar: F yalnızca bu kabuktan çağrılır; this/arguments/new.target/super kullanmaz; O yalnızca bilinen
// anahtarlarla okunur; gövdedeki serbest adlar kabuğun bulunduğu yerde aynı bağa gider.
// Not: kabuk rest parametreli olduğundan length 0'dı (preserveFunctionLength ayrıca yazıyordu); açılınca
// parametre sayısı olur.

function keyName(node, computed) {
  if (!computed && t.isIdentifier(node)) return node.name;
  if (t.isStringLiteral(node)) return node.value;
  return null;
}

// düz nesnenin özellikleri → Map(anahtar → { kind: 'get'|'typeof'|'call', name }) ve ayarlayıcılar
function readFlatObject(obj) {
  const map = new Map();
  const setters = new Map();
  for (const p of obj.properties) {
    if (!t.isObjectMethod(p) || p.async || p.generator) return null;
    const key = keyName(p.key, p.computed);
    if (key === null) return null;
    const body = p.body.body;
    if (body.length !== 1) return null;
    const s = body[0];
    if (p.kind === 'get' && !p.params.length && t.isReturnStatement(s)) {
      if (t.isIdentifier(s.argument)) { map.set(key, { kind: 'get', name: s.argument.name }); continue; }
      if (t.isUnaryExpression(s.argument, { operator: 'typeof' }) && t.isIdentifier(s.argument.argument)) {
        map.set(key, { kind: 'typeof', name: s.argument.argument.name });
        continue;
      }
      return null;
    }
    if (p.kind === 'set' && p.params.length === 1 && t.isIdentifier(p.params[0]) && t.isExpressionStatement(s) &&
        t.isAssignmentExpression(s.expression, { operator: '=' }) && t.isIdentifier(s.expression.left) &&
        t.isIdentifier(s.expression.right, { name: p.params[0].name })) {
      setters.set(key, s.expression.left.name);
      continue;
    }
    if (p.kind === 'method' && p.params.length === 1 && t.isRestElement(p.params[0]) && t.isIdentifier(p.params[0].argument) &&
        t.isReturnStatement(s) && t.isCallExpression(s.argument) && t.isIdentifier(s.argument.callee) &&
        s.argument.arguments.length === 1 && t.isSpreadElement(s.argument.arguments[0]) &&
        t.isIdentifier(s.argument.arguments[0].argument, { name: p.params[0].argument.name })) {
      map.set(key, { kind: 'call', name: s.argument.callee.name });
      continue;
    }
    return null;
  }
  // ayarlayıcı yalnızca aynı ada okuyan bir getter'ın eşi olabilir
  for (const [k, v] of setters) if (map.get(k)?.kind !== 'get' || map.get(k).name !== v) return null;
  return { map, setters };
}

function forbidden(fnPath) {
  let bad = false;
  fnPath.traverse({
    ThisExpression(p) { if (!p.findParent((x) => x.isFunction() && !x.isArrowFunctionExpression() && x !== fnPath)) { bad = true; p.stop(); } },
    Super(p) { bad = true; p.stop(); },
    MetaProperty(p) { bad = true; p.stop(); },
    Identifier(p) {
      if (p.node.name !== 'arguments' || !p.isReferencedIdentifier()) return;
      const owner = p.findParent((x) => x.isFunction() && !x.isArrowFunctionExpression());
      if (owner === fnPath) { bad = true; p.stop(); }
    },
  });
  return bad;
}

export async function run(ast, { onLog, bump }) {
  let n = 0;
  traverse(ast, {
    'FunctionDeclaration|FunctionExpression'(shell) {
      const { node } = shell;
      if (node.params.length !== 1 || !t.isRestElement(node.params[0]) || !t.isIdentifier(node.params[0].argument)) return;
      const restName = node.params[0].argument.name;
      const body = node.body.body;
      if (body.length !== 2 || !t.isVariableDeclaration(body[0]) || body[0].declarations.length !== 1) return;
      const decl = body[0].declarations[0];
      if (!t.isIdentifier(decl.id) || !t.isObjectExpression(decl.init) || !t.isReturnStatement(body[1])) return;
      const call = body[1].argument;
      if (!t.isCallExpression(call) || !t.isIdentifier(call.callee) || call.arguments.length !== 2 ||
          !t.isIdentifier(call.arguments[0], { name: decl.id.name }) || !t.isIdentifier(call.arguments[1], { name: restName })) return;
      const flat = readFlatObject(decl.init);
      if (!flat) return;

      const fb = shell.scope.getBinding(call.callee.name);
      if (!fb?.constant || !fb.path.isFunctionDeclaration() || fb.referencePaths.length !== 1) return;
      const F = fb.path;
      if (F.node.generator || F.node.async !== node.async || F.node.params.length !== 2) return;
      const [objParam, pattern] = F.node.params;
      if (!t.isIdentifier(objParam) || !t.isArrayPattern(pattern) || pattern.elements.some((e) => e === null)) return;
      if (F.findParent((x) => x === shell) || shell.findParent((x) => x === F)) return;
      if (forbidden(F)) return;

      // O yalnızca bilinen anahtarlarla, uygun biçimde kullanılmalı
      const ob = F.scope.getBinding(objParam.name);
      if (!ob || ob.constantViolations.length) return;
      const edits = [];
      for (const r of ob.referencePaths) {
        const m = r.parentPath;
        if (!m.isMemberExpression({ object: r.node })) return;
        const key = keyName(m.node.property, m.node.computed);
        const entry = key !== null ? flat.map.get(key) : null;
        if (!entry) return;
        const parent = m.parentPath;
        const written = (parent.isAssignmentExpression({ left: m.node }) || parent.isUpdateExpression());
        if (written && !flat.setters.has(key)) return;
        if (entry.kind === 'call' && !parent.isCallExpression({ callee: m.node })) return;
        if (entry.kind !== 'get' && written) return;
        // kullanım yerinde ad F içindeki bir bağa gitmemeli (açılınca kabuğun kapsamındaki bağa gidecek)
        const local = m.scope.getBinding(entry.name);
        if (local && (local.scope === F.scope || local.path.findParent((x) => x === F))) return;
        edits.push({ m, entry });
      }
      // F'nin serbest adları kabuğun yerinde aynı bağa gitmeli (program düzeyi ya da global)
      let leak = false;
      F.traverse({
        Identifier(p) {
          if (!p.isReferencedIdentifier()) return;
          const b = p.scope.getBinding(p.node.name);
          if (b === ob || (b && (b.scope === F.scope || b.path.findParent((x) => x === F)))) return;
          if (shell.scope.getBinding(p.node.name) !== b) { leak = true; p.stop(); }
        },
      });
      // kabuğun yerel adları (rest, düz nesne) F'nin gövdesini gölgelememeli
      const pnames = pattern.elements.flatMap((e) => Object.keys(t.getBindingIdentifiers(e)));
      if (leak || pnames.includes(objParam.name)) return;

      for (const { m, entry } of edits) {
        const id = t.identifier(entry.name);
        m.replaceWith(entry.kind === 'typeof' ? t.unaryExpression('typeof', id) : id);
      }
      node.params = pattern.elements;
      node.body = F.node.body;
      F.remove();
      n++;
    },
  });
  if (n) onLog(`flat-fns: ${n} düzleştirilmiş fonksiyon kabuğuna geri taşındı`, 'info');
  bump('flatFns', n);
}
