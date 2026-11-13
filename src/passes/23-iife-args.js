import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { literalValue, isLiteralTree } from '../util/pure.js';
import { literalOf } from '../util/literal.js';

// jfogs ve benzerleri: programdaki her literal ve özellik adı bir IIFE'nin parametresine taşınır,
// değerler çağrı argümanı olarak verilir:
//   (function ($fog$0, $fog$1) { if ("‮" !== $fog$1) return; console[$fog$0]("x"); })("log", "‮");
// "reverse"/"zero" kipinde gövde başındaki bir döngü `arguments` üzerinden parametreleri yerinde çözer
// (ters çevirme, sıfır genişlikli karakterlerden ikilik kod, parametre sırasını tersleme).
// Bu pass: önsözü (koruma + arguments döngüleri) sandbox'ta çalıştırıp parametrelerin son değerini alır;
// primitive olanları kullanım yerlerine yazar, nesne olanları (regex, String, parseInt) parametre olarak bırakır.
// Yalnızca jfogs korumasıyla başlayan IIFE'ler ele alınır; sıradan sabit argümanlı IIFE'lere dokunulmaz.

const MAX_PARAMS = 5000;
const SAFE_ARG_GLOBALS = new Set(['String', 'Number', 'Boolean', 'Array', 'Object', 'RegExp', 'Math', 'JSON',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'escape', 'unescape', 'decodeURIComponent', 'encodeURIComponent',
  'undefined', 'NaN', 'Infinity']);

// Argüman yan etkisiz ve yerinde değerlendirilebilir mi (literal, regex, şablon, bağsız güvenli global)?
function staticArg(p) {
  const n = p.node;
  if (isLiteralTree(n) || literalValue(n).ok || t.isRegExpLiteral(n)) return true;
  return t.isIdentifier(n) && SAFE_ARG_GLOBALS.has(n.name) && !p.scope.getBinding(n.name);
}

// if ("‮" !== X) { return; }  ya da  if (X !== "‮") return;
function isGuard(stmt, params) {
  if (!t.isIfStatement(stmt) || stmt.alternate) return false;
  const c = stmt.consequent;
  const ret = t.isBlockStatement(c) ? (c.body.length === 1 ? c.body[0] : null) : c;
  if (!t.isReturnStatement(ret) || ret.argument) return false;
  const { test } = stmt;
  if (!t.isBinaryExpression(test) || !['!==', '!='].includes(test.operator)) return false;
  const pair = [test.left, test.right];
  return pair.some((x) => t.isStringLiteral(x)) && pair.some((x) => t.isIdentifier(x) && params.has(x.name));
}

const mentions = (node, name) => {
  let hit = false;
  t.traverseFast(node, (n) => { if (t.isIdentifier(n, { name })) hit = true; });
  return hit;
};

// Gövde başındaki çözücü önsöz: koruma, `var a = arguments; var i;` ve arguments takma adını kullanan döngüler
function preludeLength(body, params) {
  if (!body.length || !isGuard(body[0], params)) return 0;
  const aliases = new Set(['arguments']);
  let i = 1;
  for (; i < body.length; i++) {
    const s = body[i];
    if (t.isVariableDeclaration(s) && s.kind === 'var' && s.declarations.every((d) => t.isIdentifier(d.id) &&
        (!d.init || t.isIdentifier(d.init, { name: 'arguments' })))) {
      for (const d of s.declarations) if (d.init) aliases.add(d.id.name);
      continue;
    }
    if (t.isForStatement(s) && [...aliases].some((a) => mentions(s, a))) continue;
    break;
  }
  return i;
}

function candidates(ast) {
  const out = [];
  traverse(ast, {
    CallExpression(p) {
      const fn = p.get('callee');
      if (!fn.isFunctionExpression() || fn.node.async || fn.node.generator) return;
      const { params } = fn.node;
      if (!params.length || params.length > MAX_PARAMS || !params.every((x) => t.isIdentifier(x))) return;
      if (new Set(params.map((x) => x.name)).size !== params.length) return;
      const args = p.get('arguments');
      if (args.length !== params.length || !args.every(staticArg)) return;
      out.push({ call: p, fn });
    },
  });
  return out;
}

// Sandbox'ta: önsözü çalıştır, her parametrenin son değerini döndür.
// Nesne değerler (regex, global fonksiyon) orijinal argüman dizisindeki yerleriyle tanımlanır.
function probeSource(fnNode, preludeStmts, call, strict) {
  const names = fnNode.params.map((x) => x.name);
  const args = call.node.arguments.map((a) => gen(a));
  const directives = fnNode.body.directives.map((d) => gen(d)).join('');
  return `(function () {${strict ? '"use strict";' : ''}
  var __o = [${args.join(', ')}];
  var __f = (function (${names.join(', ')}) {${directives}
    ${preludeStmts.map((s) => gen(s)).join('\n')}
    return [${names.join(', ')}];
  }).apply(undefined, __o);
  if (!__f) return null;
  return JSON.stringify(__f.map(function (v) {
    var k = typeof v;
    if (v === null || k === "string" || k === "boolean") return { v: v };
    if (k === "undefined") return { u: 1 };
    if (k === "number") return v !== v || v === 1 / 0 || v === -1 / 0 || (v === 0 && 1 / v < 0) ? { n: String(v === 0 ? "-0" : v) } : { v: v };
    var i = __o.indexOf(v);
    return i < 0 ? { x: 1 } : { i: i };
  }));
})()`;
}

const numberOf = (s) => (s === '-0' ? -0 : Number(s));

function valueNode(d) {
  if ('u' in d) return t.unaryExpression('void', t.numericLiteral(0));
  if ('n' in d) {
    const v = numberOf(d.n);
    return Object.is(v, -0) ? t.unaryExpression('-', t.numericLiteral(0)) : literalOf(t, v);
  }
  return literalOf(t, d.v);
}

export async function run(ast, { onLog, bump, sandbox }) {
  let total = 0;

  for (const { call, fn } of candidates(ast)) {
    if (!call.node || !fn.node) continue;
    const body = fn.node.body.body;
    const params = fn.node.params.map((x) => x.name);
    const paramSet = new Set(params);
    const pre = preludeLength(body, paramSet);

    // yalnızca jfogs koruması olan IIFE'ler: sıradan sabit argümanlı IIFE'lere dokunulmaz
    if (!pre || !sandbox) continue;
    // modül, "use strict" ya da sınıf içi: arguments parametrelere bağlı değildir, önsöz o kipte çalıştırılır
    const strict = fn.get('body').isInStrictMode();
    const r = await sandbox.batch([probeSource(fn.node, body.slice(0, pre), call, strict)], { timeoutMs: 3000 });
    const res = r.ok ? r.results[0] : null;
    if (!res?.ok || res.type !== 'string') continue;
    const finals = JSON.parse(res.value);
    if (!Array.isArray(finals) || finals.length !== params.length || finals.some((d) => 'x' in d)) continue;

    // Önsöz kaldırıldıktan sonra gövde arguments/eval/with kullanmamalı; parametreler önsöz dışında değiştirilmemeli
    const preludePaths = fn.get('body.body').slice(0, pre);
    const inPrelude = (p) => preludePaths.some((s) => p === s || p.findParent((x) => x === s));
    const restUsesArgs = (() => {
      let hit = false;
      fn.traverse({
        Identifier(p) {
          if (inPrelude(p)) return;
          if (p.node.name === 'arguments' && p.isReferencedIdentifier() && p.getFunctionParent() === fn) { hit = true; p.stop(); }
        },
        CallExpression(p) { if (!inPrelude(p) && t.isIdentifier(p.node.callee, { name: 'eval' })) { hit = true; p.stop(); } },
        WithStatement(p) { if (!inPrelude(p)) { hit = true; p.stop(); } },
      });
      return hit;
    })();
    if (restUsesArgs) continue;

    const bindings = params.map((name) => fn.scope.getBinding(name));
    if (bindings.some((b) => !b || b.constantViolations.some((v) => !inPrelude(v)))) continue;
    // NaN/Infinity gibi adla yazılan değerler kullanım yerinde gölgelenmemeli
    const shadowed = (node, refs) => t.isIdentifier(node) && refs.some((r) => r.scope.getBinding(node.name));

    const keepParams = [];
    const keepArgs = [];
    let inlined = 0;
    let ok = true;
    const plan = [];
    finals.forEach((d, i) => {
      const refs = bindings[i].referencePaths.filter((r) => !inPrelude(r));
      if ('i' in d) {
        if (refs.length) { keepParams.push(fn.node.params[i]); keepArgs.push(t.cloneNode(call.node.arguments[d.i])); }
        return;
      }
      const node = valueNode(d);
      if (!node || shadowed(node, refs) || (t.isUnaryExpression(node) && shadowed(node.argument, refs))) {
        // literal olarak yazılamayan primitive: önsöz silinince parametre çözülmemiş değeri taşırdı
        ok = false;
        keepParams.push(fn.node.params[i]);
        keepArgs.push(call.node.arguments[i]);
        return;
      }
      plan.push([refs, node]);
    });
    if (!ok) continue;

    for (const [refs, node] of plan) {
      for (const r of refs) { r.replaceWith(t.cloneNode(node)); inlined++; }
    }
    for (const s of preludePaths) s.remove();
    fn.node.params = keepParams;
    call.node.arguments = keepArgs;
    total += inlined;
    onLog(`iife-args: ${params.length} parametreli IIFE açıldı${pre ? ' (çözücü önsöz sandbox\'ta çalıştırıldı)' : ''}, ${inlined} kullanım yerine değer yazıldı`, 'info');
  }
  bump('iifeArgs', total);
}
