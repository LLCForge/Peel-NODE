import * as t from '@babel/types';
import { parse } from '../core/parse.js';
import { traverse, gen } from '../util/ast.js';
import { raw } from '../core/emit.js';

// C61/C62/C63: analiz çalıştırması için kod enstrümantasyonu — deyim sayaçları (coverage), fonksiyon giriş/çıkışı
// (çalışma anı çağrı grafiği), döngü sayaçları (sonsuz döngü), debugger tuzakları. Yalnızca rapor çalıştırmasında
// kullanılır; deobfuscation doğrulaması enstrümante edilmemiş kodla yapılır.

const ctr = (name, id) => t.expressionStatement(t.callExpression(t.identifier(name), [t.numericLiteral(id)]));
const mark = (n) => { n._peel = true; return n; };
const SKIP_COUNT = new Set(['FunctionDeclaration', 'EmptyStatement', 'ImportDeclaration', 'ExportNamedDeclaration', 'ExportDefaultDeclaration', 'ExportAllDeclaration']);

function ensureBlock(path, key) {
  const child = path.get(key);
  if (!child.node || child.isBlockStatement()) return;
  child.replaceWith(t.blockStatement([child.node]));
}

function fnName(p) {
  const n = p.node;
  if (n.id) return n.id.name;
  if (n.key) return t.isIdentifier(n.key) ? n.key.name : gen(n.key).slice(0, 40);
  if (t.isVariableDeclarator(p.parent) && t.isIdentifier(p.parent.id)) return p.parent.id.name;
  if (t.isObjectProperty(p.parent)) return t.isIdentifier(p.parent.key) ? p.parent.key.name : gen(p.parent.key).slice(0, 40);
  if (t.isAssignmentExpression(p.parent)) return gen(p.parent.left).slice(0, 40);
  return '(anonim)';
}

export function instrument(code) {
  const ast = parse(code);
  const map = { stmts: [], fns: [], loops: [], debuggers: [] };
  const counted = (body) => {
    const out = [];
    for (const s of body) {
      if (!s._peel && s.loc && !SKIP_COUNT.has(s.type)) {
        out.push(mark(ctr('__peelS', map.stmts.length)));
        map.stmts.push({ line: s.loc.start.line, endLine: s.loc.end.line, type: s.type });
      }
      out.push(s);
    }
    return out;
  };
  traverse(ast, {
    IfStatement(p) {
      ensureBlock(p, 'consequent');
      if (p.node.alternate && !t.isIfStatement(p.node.alternate)) ensureBlock(p, 'alternate');
    },
    WithStatement(p) { ensureBlock(p, 'body'); },
    DebuggerStatement(p) {
      if (!p.node.loc) return;
      map.debuggers.push({ line: p.node.loc.start.line });
      p.replaceWith(mark(ctr('__peelD', map.debuggers.length - 1)));
    },
    BlockStatement: { exit(p) { p.node.body = counted(p.node.body); } },
    SwitchCase: { exit(p) { p.node.consequent = counted(p.node.consequent); } },
    StaticBlock: { exit(p) { p.node.body = counted(p.node.body); } },
    Program: { exit(p) { p.node.body = counted(p.node.body); } },
    Loop: {
      enter(p) { ensureBlock(p, 'body'); },
      exit(p) {
        if (!p.node.loc || p.node._peel) return;
        p.node._peel = true;
        map.loops.push({ line: p.node.loc.start.line, kind: p.node.type });
        p.node.body.body.unshift(mark(ctr('__peelL', map.loops.length - 1)));
      },
    },
    Function: {
      exit(p) {
        const n = p.node;
        if (n._peel || !n.loc) return;
        n._peel = true;
        const id = map.fns.length;
        map.fns.push({ name: fnName(p), line: n.loc.start.line, async: Boolean(n.async || n.generator) });
        if (!t.isBlockStatement(n.body)) n.body = t.blockStatement([t.returnStatement(n.body)]);
        // async/generator askıya alınır: yığın tutarlı kalmaz, yalnızca kenar kaydedilir
        if (n.async || n.generator) {
          n.body.body.unshift(mark(ctr('__peelEa', id)));
          return;
        }
        const inner = t.blockStatement(n.body.body);
        n.body.body = [mark(ctr('__peelE', id)), mark(t.tryStatement(inner, null, t.blockStatement([mark(t.expressionStatement(t.callExpression(t.identifier('__peelX'), [])))])))];
      },
    },
  });
  return { code: `${prelude(map)}\n${raw(ast)}`, map };
}

// Sayaçlar global'de: 'run' programı fonksiyon içinde çalıştırır, collect ifadesi global'den okur
function prelude(map) {
  return `globalThis.__peelCov = { s: new Array(${map.stmts.length}).fill(0), f: new Array(${map.fns.length}).fill(0),
  l: new Array(${map.loops.length}).fill(0), d: new Array(${map.debuggers.length}).fill(0), edges: {}, stack: [], last: -1, maxDepth: 0 };
globalThis.__peelS = function (i) { __peelCov.s[i]++; };
globalThis.__peelL = function (i) { __peelCov.l[i]++; __peelCov.last = i; };
globalThis.__peelD = function (i) { __peelCov.d[i]++; __peelFx("debugger", "debugger", i); };
globalThis.__peelEa = function (i) {
  var c = __peelCov, from = c.stack.length ? c.stack[c.stack.length - 1] : -1, k = from + ">" + i;
  c.f[i]++; c.edges[k] = (c.edges[k] || 0) + 1;
};
globalThis.__peelE = function (i) {
  __peelEa(i);
  __peelCov.stack.push(i);
  if (__peelCov.stack.length > __peelCov.maxDepth) __peelCov.maxDepth = __peelCov.stack.length;
};
globalThis.__peelX = function () { __peelCov.stack.pop(); };`;
}

// sayaç dizilerini okuyan collect ifadesi (eklenti)
export const COVERAGE_PLUGIN = { name: 'coverage', collect: '({ s: __peelCov.s, f: __peelCov.f, l: __peelCov.l, d: __peelCov.d, edges: __peelCov.edges, stack: __peelCov.stack, last: __peelCov.last, maxDepth: __peelCov.maxDepth })' };

// C55: doğrudan eval çağrılarının argümanı yakalanır; çağrı süresince gerçek eval yerine konur (yerel kapsam korunur)
export function captureEval(code) {
  let ast;
  try { ast = parse(code); } catch { return code; }
  let n = 0;
  traverse(ast, {
    CallExpression(p) {
      const c = p.node;
      if (c._peel || !t.isIdentifier(c.callee, { name: 'eval' }) || !c.arguments.length || p.scope.hasBinding('eval', true)) return;
      if (t.isSpreadElement(c.arguments[0])) return;
      const call = mark(t.callExpression(t.identifier('eval'), [t.callExpression(t.identifier('__peelCode'), [t.stringLiteral('eval'), c.arguments[0]]), ...c.arguments.slice(1)]));
      p.replaceWith(t.sequenceExpression([t.callExpression(t.identifier('__peelEvalOn'), []), t.callExpression(t.identifier('__peelEvalOff'), [call])]));
      n++;
    },
  });
  return n ? raw(ast) : code;
}

const TIME_READ = /\b(Date\.now|performance\.now|new Date|getTime)\b/;

// C63: statik anti-debug / sonsuz döngü tuzağı taraması (satır ve kısa kod parçasıyla)
export function antiDebugScan(code) {
  let ast;
  try { ast = parse(code); } catch { return []; }
  const traps = [];
  const add = (kind, node) => {
    if (traps.length < 100) traps.push({ kind, line: node.loc?.start.line ?? 0, snippet: gen(node).slice(0, 120) });
  };
  // döngü gövdesinde (iç fonksiyonlar hariç) çıkış deyimi var mı
  const exits = (node) => {
    if (!node || typeof node.type !== 'string') return false;
    if (t.isBreakStatement(node) || t.isReturnStatement(node) || t.isThrowStatement(node)) return true;
    if (t.isFunction(node)) return false;
    for (const k of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[k];
      if (Array.isArray(v) ? v.some(exits) : exits(v)) return true;
    }
    return false;
  };
  traverse(ast, {
    DebuggerStatement(p) {
      const timer = p.findParent((x) => x.isCallExpression() && /^(setInterval|setTimeout)$/.test(gen(x.node.callee).replace(/^(window|globalThis|self)\./, '')));
      add(timer ? 'timer-debugger' : 'debugger', timer ? timer.node : p.node);
    },
    StringLiteral(p) {
      const v = p.node.value;
      if (/\bdebugger\b/.test(v) && v.length < 200) add('dynamic-debugger', p.parent);
      if (v.includes('(((.+)+)+)+$')) add('self-defending', p.parent);
    },
    RegExpLiteral(p) { if (p.node.pattern.includes('(((.+)+)+)+$')) add('self-defending', p.parent); },
    BinaryExpression(p) {
      const s = gen(p.node);
      if (p.node.operator === '-' && /outer(Width|Height)/.test(s) && /inner(Width|Height)/.test(s)) add('devtools-size', p.node);
      if (['>', '>=', '<', '<='].includes(p.node.operator) && t.isNumericLiteral(p.node.right) && p.node.right.value >= 50 && TIME_READ.test(s) && s.includes('-')) add('timing-check', p.node);
    },
    CallExpression(p) {
      const callee = gen(p.node.callee);
      if (/^console\.(clear|table)$/.test(callee)) add('console-trap', p.node);
      if (/(^|\.)(defineProperty|__defineGetter__)$/.test(callee) && p.node.arguments[1] && t.isStringLiteral(p.node.arguments[1], { value: 'id' })) add('console-getter', p.node);
      if (/(^|\.)reload$|(^|\.)close$/.test(callee) && /location|window|self/.test(callee)) add('reaction', p.node);
    },
    'WhileStatement|ForStatement|DoWhileStatement'(p) {
      const test = p.node.test;
      const constTrue = !test || (t.isBooleanLiteral(test, { value: true })) || (t.isNumericLiteral(test) && test.value !== 0) ||
        (t.isUnaryExpression(test, { operator: '!' }) && t.isUnaryExpression(test.argument, { operator: '!' }) && t.isArrayExpression(test.argument.argument));
      if (constTrue && !exits(p.node.body)) add('infinite-loop', p.node);
    },
  });
  return traps;
}
