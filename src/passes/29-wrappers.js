import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { literalValue } from '../util/pure.js';

// obfuscator.io stringArrayWrappersType: 'function':
//   function fn12(a, b, c, d, e) { return fn2(e - 57, b); }   fn12(268, "SJan", 222, 277, 248)  →  fn2(248 - 57, "SJan")
// Gövdesi tek `return F(…)` olan ve argümanları yalnızca parametre, literal ve aritmetikten oluşan sarmalayıcı,
// tüm argümanları literal olan çağrı yerlerinde açılır. Böylece decoder çağrıları tek fonksiyonda toplanır.

const PURE_OPS = new Set(['+', '-', '*', '/', '%', '|', '&', '^', '<<', '>>', '>>>']);

function isPureArgExpr(n, params) {
  if (t.isIdentifier(n)) return params.has(n.name);
  if (literalValue(n).ok) return true;
  if (t.isUnaryExpression(n) && (n.operator === '-' || n.operator === '+' || n.operator === '~')) return isPureArgExpr(n.argument, params);
  if (t.isBinaryExpression(n) && PURE_OPS.has(n.operator)) return isPureArgExpr(n.left, params) && isPureArgExpr(n.right, params);
  return false;
}

function wrapperShape(fn) {
  if (fn.async || fn.generator || !fn.params.every((p) => t.isIdentifier(p)) || fn.body.body.length !== 1) return null;
  const ret = fn.body.body[0];
  if (!t.isReturnStatement(ret) || !t.isCallExpression(ret.argument) || !t.isIdentifier(ret.argument.callee)) return null;
  const params = new Set(fn.params.map((p) => p.name));
  if (params.size !== fn.params.length || params.has(ret.argument.callee.name)) return null;
  if (!ret.argument.arguments.every((a) => isPureArgExpr(a, params))) return null;
  return ret.argument;
}

function substitute(node, map) {
  if (t.isIdentifier(node) && map.has(node.name)) return t.cloneNode(map.get(node.name), true);
  const copy = t.cloneNode(node, false);
  for (const k of t.VISITOR_KEYS[node.type] ?? []) {
    const v = node[k];
    if (Array.isArray(v)) copy[k] = v.map((c) => (c ? substitute(c, map) : c));
    else if (v && typeof v === 'object') copy[k] = substitute(v, map);
  }
  return copy;
}

// Parametrelerin dönüş çağrısındaki kullanım sırası (soldan sağa değerlendirme sırası)
function paramOrder(call, params) {
  const order = [];
  t.traverseFast(t.arrayExpression(call.arguments), (x) => { if (t.isIdentifier(x) && params.includes(x.name)) order.push(x.name); });
  return order;
}

// E109: literal olmayan argümanlarla açma. Her parametre dönüş ifadesinde tam bir kez ve parametre sırasıyla
// kullanılıyorsa argümanlar orijinaldeki sırayla değerlendirilir; kullanılmayan/fazla argümanlar literal olmalı.
function inlineableArgs(args, params, order) {
  if (args.some((a) => t.isSpreadElement(a))) return false;
  if (!args.slice(params.length).every((a) => literalValue(a).ok)) return false;
  // literal argümanlı parametreler serbest; diğerleri tam bir kez ve kendi aralarında parametre sırasıyla kullanılmalı
  const dynamic = params.filter((name, i) => args[i] && !literalValue(args[i]).ok);
  const seen = order.filter((name) => dynamic.includes(name));
  return seen.length === dynamic.length && seen.every((name, i) => name === dynamic[i]);
}

// E99: zincir — açılan argümanlardaki literal aritmetiği katla ki bir sonraki sarmalayıcı aynı pass'te açılabilsin
const NUM_OPS = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '|': (a, b) => a | b, '&': (a, b) => a & b,
  '^': (a, b) => a ^ b, '<<': (a, b) => a << b, '>>': (a, b) => a >> b, '>>>': (a, b) => a >>> b,
};
const FOLD_OPS = new Set(Object.keys(NUM_OPS));
function foldNumeric(node) {
  if (t.isBinaryExpression(node) && FOLD_OPS.has(node.operator)) {
    node.left = foldNumeric(node.left);
    node.right = foldNumeric(node.right);
    const l = literalValue(node.left);
    const r = literalValue(node.right);
    if (l.ok && r.ok && typeof l.value === 'number' && typeof r.value === 'number') {
      const v = NUM_OPS[node.operator](l.value, r.value);
      if (Number.isFinite(v) && !Object.is(v, -0)) return v < 0 ? t.unaryExpression('-', t.numericLiteral(-v)) : t.numericLiteral(v);
    }
  }
  return node;
}

export async function run(ast, { onLog, bump }) {
  let n = 0;
  // zincirler (w2 → w1 → decoder) tek pass'te açılsın: değişiklik durana kadar tekrar
  for (let pass = 0; pass < 8; pass++) {
    const before = n;
    n += unwrapOnce(ast, onLog);
    if (n === before) break;
  }
  bump('wrapper', n);
}

function unwrapOnce(ast, onLog) {
  let n = 0;
  traverse(ast, {
    FunctionDeclaration(p) {
      const call = wrapperShape(p.node);
      if (!call || !p.node.id) return;
      const b = p.parentPath.scope.getBinding(p.node.id.name);
      if (!b || b.constantViolations.length) return;
      const target = p.scope.getBinding(call.callee.name);
      if (!target) return;
      const params = p.node.params.map((x) => x.name);
      const order = paramOrder(call, params);
      let done = 0;
      for (const r of b.referencePaths) {
        const site = r.parentPath;
        if (!site.isCallExpression({ callee: r.node })) continue;
        const args = site.node.arguments;
        if (!inlineableArgs(args, params, order)) continue;
        // literal olmayan argümanda hedef ad argümanlardan önce okunur: sabit bağlama olmalı
        if (!target.constant && !args.every((a) => literalValue(a).ok)) continue;
        // çağrı yerinde hedef ad aynı fonksiyona bağlı olmalı (gölgeleme yok)
        if (site.scope.getBinding(call.callee.name) !== target) continue;
        const map = new Map(params.map((name, i) => [name, args[i] ?? t.unaryExpression('void', t.numericLiteral(0))]));
        const out = substitute(call, map);
        out.arguments = out.arguments.map(foldNumeric);
        site.replaceWith(out);
        done++;
      }
      if (!done) return;
      n += done;
      onLog(`wrappers: ${p.node.id.name} → ${call.callee.name} (${done} çağrı açıldı)`, 'info');
    },
  });
  return n;
}
