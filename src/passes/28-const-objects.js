import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { literalValue } from '../util/pure.js';

// obfuscator.io "transformObjectKeys"/kontrol akışı nesneleri:
//   var o = { _0x3b3a: 1179, KJs: function (a, b) { return a + b; }, Ytr: function (f, x) { return f(x); } };
//   fn(o._0x3b3a, …)  →  fn(1179, …)      o.KJs(x, y)  →  x + y      o.Ytr(g, 1)  →  g(1)
// Nesne hiç değiştirilmiyorsa (yazma, silme, başka yere verme yok) ve her okuma var olan bir anahtarsa uygulanır.

const keyName = (k, computed) => (!computed && t.isIdentifier(k) ? k.name : t.isStringLiteral(k) ? k.value : null);

// function (a, b) { return a OP b; } → OP;  function (f, ...xs) { return f(...xs); } → 'call'
export function proxyKind(fn) {
  if (!t.isFunctionExpression(fn) || fn.async || fn.generator || fn.body.body.length !== 1) return null;
  const ret = fn.body.body[0];
  if (!t.isReturnStatement(ret) || !ret.argument || !fn.params.every((p) => t.isIdentifier(p))) return null;
  const names = fn.params.map((p) => p.name);
  const arg = ret.argument;
  if ((t.isBinaryExpression(arg) || t.isLogicalExpression(arg)) && names.length === 2 &&
      t.isIdentifier(arg.left, { name: names[0] }) && t.isIdentifier(arg.right, { name: names[1] })) {
    return { type: t.isBinaryExpression(arg) ? 'binary' : 'logical', operator: arg.operator, arity: 2 };
  }
  if (t.isCallExpression(arg) && names.length >= 1 && t.isIdentifier(arg.callee, { name: names[0] }) &&
      arg.arguments.length === names.length - 1 && arg.arguments.every((a, i) => t.isIdentifier(a, { name: names[i + 1] }))) {
    return { type: 'call', arity: names.length };
  }
  return null;
}

export function expand(kind, args) {
  if (kind.type === 'binary') return t.binaryExpression(kind.operator, args[0], args[1]);
  if (kind.type === 'logical') return t.logicalExpression(kind.operator, args[0], args[1]);
  // f this'siz çağrılıyordu: o.m gibi bir üye ifadesini (0, o.m)(…) yaparak this bağlamasını koru
  const callee = t.isMemberExpression(args[0]) ? t.sequenceExpression([t.numericLiteral(0), args[0]]) : args[0];
  return t.callExpression(callee, args.slice(1));
}

const refersTo = (node, name) => {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    if (t.isIdentifier(n, { name })) return true;
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) stack.push(...v); else stack.push(v);
    }
  }
  return false;
};

// var o = {}; o.a = 1; o.b = function (x, y) { return x + y; }; var p = o;
//   → var p = { a: 1, b: function … };   (yalnızca hemen ardışık, yan etkisiz atamalar)
// Önce adaylar toplanır, sonra belge sonundan başa uygulanır (kapsayıcı indeksleri bozulmasın).
function foldBuilders(ast) {
  const jobs = [];
  traverse(ast, {
    VariableDeclaration(p) {
      if (p.node.declarations.length !== 1 || !Array.isArray(p.container)) return;
      const d = p.node.declarations[0];
      if (!t.isIdentifier(d.id) || !t.isObjectExpression(d.init)) return;
      const name = d.id.name;
      const b = p.scope.getBinding(name);
      if (!b || b.constantViolations.length) return;
      const keys = new Set(d.init.properties.map((x) => (t.isObjectProperty(x) ? keyName(x.key, x.computed) : null)));
      const props = [];
      let i = p.key + 1;
      for (; i < p.container.length; i++) {
        const st = p.container[i];
        const a = t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression, { operator: '=' }) ? st.expression : null;
        if (!a || !t.isMemberExpression(a.left) || !t.isIdentifier(a.left.object, { name })) break;
        const k = keyName(a.left.property, a.left.computed);
        if (k === null || keys.has(k)) break;
        if (!(literalValue(a.right).ok || t.isFunctionExpression(a.right)) || refersTo(a.right, name)) break;
        props.push(t.objectProperty(t.isValidIdentifier(k) ? t.identifier(k) : t.stringLiteral(k), a.right));
        keys.add(k);
      }
      const moved = i - p.key - 1;
      // hemen ardından takma ad (var q = o;) ve o başka hiçbir yerde kullanılmıyorsa q nesnenin kendisi olur
      const next = p.container[i];
      const alias = t.isVariableDeclaration(next) && next.declarations.length === 1 && t.isIdentifier(next.declarations[0].id) &&
        t.isIdentifier(next.declarations[0].init, { name }) && b.references === moved + 1;
      if (moved || alias) jobs.push({ container: p.container, key: p.key, d, props, moved, alias, next });
    },
  });
  jobs.sort((a, b) => (a.container === b.container ? b.key - a.key : 0));
  for (const j of jobs) {
    j.d.init.properties.push(...j.props);
    j.container.splice(j.key + 1, j.moved);
    if (j.alias) {
      j.next.declarations[0].init = j.d.init;
      j.container.splice(j.key, 1);
    }
  }
  return jobs.length;
}

export async function run(ast, { onLog, bump, level = 2 }) {
  let n = 0;
  // yapı değişti: bağlamalar bayat, satır içi yazma bir sonraki turda taze ağaçla yapılır
  const folded = foldBuilders(ast);
  if (folded) {
    onLog(`const-objects: ${folded} nesne kurulumu literal'e katlandı`, 'info');
    bump('constObject', folded);
    return;
  }
  traverse(ast, {
    VariableDeclarator(p) {
      const { id, init } = p.node;
      if (!t.isIdentifier(id) || !t.isObjectExpression(init) || !init.properties.length) return;
      const props = new Map();
      for (const prop of init.properties) {
        if (!t.isObjectProperty(prop) || prop.shorthand) return;
        const k = keyName(prop.key, prop.computed);
        if (k === null || props.has(k)) return;
        if (literalValue(prop.value).ok) props.set(k, { literal: prop.value });
        else {
          const kind = proxyKind(prop.value);
          if (!kind) return;
          props.set(k, { kind });
        }
      }
      const b = p.scope.getBinding(id.name);
      if (!b || b.constantViolations.length || !b.referencePaths.length) return;
      // her kullanım o.k okuması (ya da proxy için o.k(...) çağrısı) olmalı.
      // Seviye 3+: obfuscator.io depo nesnesi (en az 3 proxy fonksiyon) ölü enjekte dallarda değer olarak geçebilir
      // (f(o), return o). Nesneye hiçbir yerde yazılmıyorsa üye okumaları yine yazılır, bildirim kalır;
      // kaçan değerin nesneyi değiştirmediği varsayımı derin davranış doğrulamasıyla denetlenir.
      const storage = level >= 3 && [...props.values()].filter((x) => x.kind).length >= 3;
      const uses = [];
      let escapes = 0;
      for (const r of b.referencePaths) {
        const m = r.parentPath;
        if (!m.isMemberExpression({ object: r.node })) {
          if (!storage) return;
          escapes++;
          continue;
        }
        const k = keyName(m.node.property, m.node.computed);
        let entry = k === null ? null : props.get(k);
        // nesnede ve Object.prototype'ta olmayan ad (ölü daldaki o.length) undefined okur
        if (!entry && k !== null && !(k in Object.prototype) && !props.has('__proto__')) entry = { literal: t.unaryExpression('void', t.numericLiteral(0)) };
        if (!entry) return;
        const par = m.parentPath;
        if (par.isAssignmentExpression({ left: m.node }) || par.isUpdateExpression() || par.isUnaryExpression({ operator: 'delete' }) ||
            par.isForXStatement({ left: m.node })) return;
        if (entry.kind) {
          if (!par.isCallExpression({ callee: m.node })) return;
          const args = par.node.arguments;
          if (args.length !== entry.kind.arity || args.some((a) => t.isSpreadElement(a))) return;
          uses.push({ path: par, entry });
        } else {
          if (par.isCallExpression({ callee: m.node })) return;
          uses.push({ path: m, entry });
        }
      }
      // bildirim kullanımlardan önce olmalı (hoisting'te var değeri undefined'dır)
      if (b.kind !== 'var' && b.kind !== 'let' && b.kind !== 'const') return;
      // aynı bildirimdeki sonraki tanımlayıcılar (var o = {…}, v = o.f(x)) nesne kurulduktan sonra çalışır
      if (uses.some((u) => u.path.getFunctionParent() === p.getFunctionParent() && u.path.node.start < p.node.end)) return;
      // iç içe kullanımlar (o.add(o.a, 1)) önce içten dışa değiştirilir
      for (const u of uses.sort((a, c) => c.path.node.start - a.path.node.start || a.path.node.end - c.path.node.end)) {
        if (!u.path.node) continue;
        if (u.entry.literal) u.path.replaceWith(t.cloneNode(u.entry.literal, true));
        else u.path.replaceWith(expand(u.entry.kind, u.path.node.arguments));
        n++;
      }
      if (escapes && !uses.length) return;
      if (!escapes) p.remove();
      onLog(`const-objects: ${id.name} (${props.size} anahtar) ${uses.length} kullanım yerine yazıldı${escapes ? `, ${escapes} değer kullanımı için bildirim kaldı` : ''}`, 'info');
    },
  });
  bump('constObject', n);
}
