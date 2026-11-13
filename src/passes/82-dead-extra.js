import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { isLiteralTree, literalValue } from '../util/pure.js';

// Ölü kod ve fazlalıklar. Her kural yalnızca gözlenebilir davranışı değiştirmediği kanıtlanan biçime uygulanır.
//  E210 kullanılmayan parametre    E211 kullanılmayan import       E212 kullanılmayan özel sınıf üyesi
//  E214 return/throw sonrası erişilemeyen kod    E215 yinelenen tanım    E219 fazla argüman

// Değerlendirilmesi gözlenebilir hiçbir şey yapmayan argüman
const inertArg = (p, a) => isLiteralTree(a) || t.isFunctionExpression(a) || t.isArrowFunctionExpression(a) ||
  (t.isIdentifier(a) && Boolean(p.scope.getBinding(a.name))) || (t.isUnaryExpression(a, { operator: 'void' }) && literalValue(a.argument).ok);

// Fonksiyon gövdesi (iç ok fonksiyonları dahil) arguments kullanıyor mu?
function usesArguments(fnNode) {
  let found = false;
  const walk = (n, top) => {
    if (!n || typeof n !== 'object' || found) return;
    if (!top && t.isFunction(n) && !t.isArrowFunctionExpression(n)) return;
    if (t.isIdentifier(n, { name: 'arguments' })) { found = true; return; }
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, false)); else walk(v, false);
    }
  };
  walk(fnNode.body, true);
  fnNode.params.forEach((x) => walk(x, true));
  return found;
}

// Fonksiyonun bilinen tüm kullanımları (yalnızca doğrudan çağrılar); başka kullanım varsa null
function directCalls(p) {
  if (p.isFunctionDeclaration() && p.node.id) {
    const b = p.parentPath.scope.getBinding(p.node.id.name);
    if (!b?.constant) return null;
    const calls = b.referencePaths.map((r) => r.parentPath);
    return calls.every((c, i) => c.isCallExpression({ callee: b.referencePaths[i].node })) ? calls : null;
  }
  if ((p.isFunctionExpression() || p.isArrowFunctionExpression()) && p.parentPath.isVariableDeclarator({ init: p.node }) &&
      t.isIdentifier(p.parent.id)) {
    const b = p.parentPath.scope.getBinding(p.parent.id.name);
    if (!b?.constant) return null;
    const calls = b.referencePaths.map((r) => r.parentPath);
    return calls.every((c, i) => c.isCallExpression({ callee: b.referencePaths[i].node })) ? calls : null;
  }
  if (p.parentPath.isCallExpression({ callee: p.node })) return [p.parentPath];
  return null;
}

// ── E210 ────────────────────────────────────────────────

const dynamicScope = (fn) => {
  let found = false;
  t.traverseFast(fn.body, (n) => {
    if (t.isWithStatement(n) || (t.isCallExpression(n) && t.isIdentifier(n.callee, { name: 'eval' }))) found = true;
  });
  return found;
};

function unusedParams(ast, level) {
  let n = 0;
  traverse(ast, {
    Function(p) {
      if (p.isFunctionDeclaration() && p.parentPath.isProgram() && level < 4) return;
      if (p.isFunctionDeclaration() && p.parentPath.isExportDeclaration()) return;
      const params = p.node.params;
      if (!params.length || !params.every((x) => t.isIdentifier(x))) return;
      if (!p.isArrowFunctionExpression() && usesArguments(p.node)) return;
      // doğrudan eval ve with parametreyi adıyla okuyabilir: "referenced" kanıtı geçersiz
      if (dynamicScope(p.node)) return;
      const calls = directCalls(p);
      if (!calls || p.isClassMethod() || p.isObjectMethod()) return;
      const dead = [];
      params.forEach((x, i) => {
        const b = p.scope.getOwnBinding(x.name);
        if (!b || b.kind !== 'param' || b.referenced || b.constantViolations.length) return;
        if (params.filter((y) => y.name === x.name).length > 1) return;
        const ok = calls.every((c) => {
          const args = c.node.arguments;
          if (args.slice(0, i + 1).some((a) => t.isSpreadElement(a))) return false;
          return i >= args.length || inertArg(c, args[i]);
        });
        if (ok) dead.push(i);
      });
      if (!dead.length) return;
      const drop = new Set(dead);
      for (const c of calls) c.node.arguments = c.node.arguments.filter((a, i) => !drop.has(i));
      p.node.params = params.filter((x, i) => !drop.has(i));
      n += dead.length;
    },
  });
  return n;
}

// ── E219 ────────────────────────────────────────────────

function knownArity(scope, name) {
  const b = scope.getBinding(name);
  if (!b?.constant) return null;
  const fn = b.path.isFunctionDeclaration() ? b.path.node
    : b.path.isVariableDeclarator() && (t.isFunctionExpression(b.path.node.init) || t.isArrowFunctionExpression(b.path.node.init)) ? b.path.node.init : null;
  if (!fn || !fn.params.every((x) => t.isIdentifier(x) || t.isAssignmentPattern(x) || t.isObjectPattern(x) || t.isArrayPattern(x))) return null;
  if (!t.isArrowFunctionExpression(fn) && usesArguments(fn)) return null;
  return { arity: fn.params.length, binding: b };
}

function extraArgs(ast) {
  let n = 0;
  traverse(ast, {
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      if (!t.isIdentifier(callee)) return;
      const k = knownArity(p.scope, callee.name);
      if (!k || args.length <= k.arity) return;
      // fazla argümanlar yine de değerlendirilir: yalnızca yan etkisizler atılır (sondan başa, sıra korunur)
      let keep = args.length;
      while (keep > k.arity && !t.isSpreadElement(args[keep - 1]) && inertArg(p, args[keep - 1])) keep--;
      if (keep === args.length) return;
      if (args.slice(0, k.arity).some((a) => t.isSpreadElement(a))) return;
      n += args.length - keep;
      p.node.arguments = args.slice(0, keep);
    },
  });
  return n;
}

// ── E211 ────────────────────────────────────────────────

function unusedImports(ast) {
  let n = 0;
  traverse(ast, {
    ImportDeclaration(p) {
      if (p.node.importKind === 'type' || !p.node.specifiers.length) return;
      const before = p.node.specifiers.length;
      p.node.specifiers = p.node.specifiers.filter((s) => {
        const b = p.scope.getBinding(s.local.name);
        return !b || b.referenced;
      });
      // tüm adlar kullanılmıyorsa modül yine yüklenmeli (yan etkileri): import "kaynak";
      n += before - p.node.specifiers.length;
    },
  });
  return n;
}

// ── E212 ────────────────────────────────────────────────

function privateMembers(ast) {
  let n = 0;
  traverse(ast, {
    ClassBody(p) {
      const used = new Map();
      const decls = [];
      p.node.body.forEach((m) => {
        if ((t.isClassPrivateMethod(m) || t.isClassPrivateProperty(m)) && t.isPrivateName(m.key)) decls.push(m);
      });
      if (!decls.length) return;
      t.traverseFast(p.node, (x) => {
        if (t.isPrivateName(x)) used.set(x.id.name, (used.get(x.id.name) ?? 0) + 1);
      });
      const dead = decls.filter((m) => {
        if ((used.get(m.key.id.name) ?? 0) > 1) return false; // yalnızca kendi bildirimi
        if (t.isClassPrivateProperty(m) && m.value && !isLiteralTree(m.value) && !t.isFunction(m.value)) return false;
        if (t.isClassPrivateMethod(m) && m.kind !== 'method' && decls.some((o) => o !== m && o.key.id.name === m.key.id.name)) return false;
        return true;
      });
      if (!dead.length) return;
      p.node.body = p.node.body.filter((m) => !dead.includes(m));
      n += dead.length;
    },
  });
  return n;
}

// ── E214 ────────────────────────────────────────────────

// while (true) / for (;;): içinden kendisini ya da dışarıyı hedefleyen break yoksa ardından gelen deyime hiç ulaşılmaz
// (iç fonksiyonlara girilmez; iç döngü/switch'teki etiketsiz break yalnızca onu bitirir)
function isEndlessLoop(s) {
  const always = (x) => !x || t.isBooleanLiteral(x, { value: true }) || (t.isNumericLiteral(x) && x.value !== 0);
  if (!(t.isWhileStatement(s) && always(s.test)) && !(t.isForStatement(s) && always(s.test))) return false;
  let escapes = false;
  const walk = (n, inner) => {
    if (escapes || !n || typeof n !== 'object' || t.isFunction(n)) return;
    if (t.isBreakStatement(n) && (n.label || !inner)) { escapes = true; return; }
    const nested = inner || t.isLoop(n) || t.isSwitchStatement(n);
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, nested)); else walk(v, nested);
    }
  };
  walk(s.body, false);
  return !escapes;
}
const isExit = (s) => t.isReturnStatement(s) || t.isThrowStatement(s) || t.isBreakStatement(s) || t.isContinueStatement(s) || isEndlessLoop(s);

// Deyimin kendi var adları (iç fonksiyonlarınki hariç)
function ownVarNames(stmt) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object' || t.isFunction(n)) return;
    if (t.isVariableDeclaration(n, { kind: 'var' })) for (const d of n.declarations) out.push(...Object.keys(t.getBindingIdentifiers(d.id)));
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk); else walk(v);
    }
  };
  walk(stmt);
  return out;
}

function trimAfterExit(list) {
  const i = list.findIndex(isExit);
  if (i < 0 || i === list.length - 1) return 0;
  const tail = list.slice(i + 1);
  // let/const/class adı kapsamda kalır (TDZ): kaldırmak gölgelemeyi değiştirebilir
  if (tail.some((s) => t.isClassDeclaration(s) || (t.isVariableDeclaration(s) && s.kind !== 'var'))) return 0;
  // fonksiyon bildirimleri ve var adları yükseltilir (hoisting): korunur, var başlatıcısı ölü
  const inert = (s) => t.isFunctionDeclaration(s) || (t.isVariableDeclaration(s, { kind: 'var' }) && s.declarations.every((d) => t.isIdentifier(d.id) && !d.init));
  const removed = tail.filter((s) => !inert(s)).length;
  if (!removed) return 0;
  const kept = [];
  for (const s of tail) {
    if (inert(s)) { kept.push(s); continue; }
    const names = ownVarNames(s);
    if (names.length) kept.push(t.variableDeclaration('var', names.map((nm) => t.variableDeclarator(t.identifier(nm)))));
  }
  list.splice(i + 1, tail.length, ...kept);
  return removed;
}

function unreachable(ast) {
  let n = 0;
  traverse(ast, {
    BlockStatement(p) { n += trimAfterExit(p.node.body); },
    SwitchCase(p) { n += trimAfterExit(p.node.consequent); },
    Program(p) { n += trimAfterExit(p.node.body); },
  });
  return n;
}

// ── E215 ────────────────────────────────────────────────

function duplicates(ast) {
  let n = 0;
  const fnLists = (list) => {
    const seen = new Map();
    const drop = new Set();
    list.forEach((s, i) => {
      if (!t.isFunctionDeclaration(s) || !s.id || s.async || s.generator) return;
      if (seen.has(s.id.name)) drop.add(seen.get(s.id.name));
      seen.set(s.id.name, i);
    });
    if (!drop.size) return list;
    n += drop.size;
    return list.filter((s, i) => !drop.has(i));
  };
  traverse(ast, {
    // aynı kapsamda yinelenen fonksiyon bildirimi: sonuncusu geçerlidir (yalnızca program/fonksiyon gövdesi; blokta Annex B farklı)
    Program(p) { p.node.body = fnLists(p.node.body); },
    Function(p) { if (t.isBlockStatement(p.node.body)) p.node.body.body = fnLists(p.node.body.body); },
    // {a: 1, b: 2, a: 3} → {a: 3, b: 2}: ilk konum (sıralama) korunur, değerler yan etkisiz olmalı
    ObjectExpression(p) {
      const props = p.node.properties;
      const byKey = new Map();
      const pure = (v) => isLiteralTree(v) || t.isFunctionExpression(v) || t.isArrowFunctionExpression(v) || t.isIdentifier(v);
      props.forEach((x, i) => {
        if (!t.isObjectProperty(x) || x.computed || x.shorthand) return;
        const k = t.isIdentifier(x.key) ? x.key.name : t.isStringLiteral(x.key) ? x.key.value : t.isNumericLiteral(x.key) ? String(x.key.value) : null;
        if (k === null || k === '__proto__') return;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(i);
      });
      const drop = new Set();
      for (const idxs of byKey.values()) {
        if (idxs.length < 2) continue;
        // aynı adlı getter/setter araya girmemeli
        if (!idxs.every((i) => pure(props[i].value))) continue;
        const [first, ...rest] = idxs;
        props[first].value = props[idxs[idxs.length - 1]].value;
        rest.forEach((i) => drop.add(i));
      }
      if (!drop.size) return;
      if (props.some((x, i) => !drop.has(i) && (t.isObjectMethod(x) || t.isSpreadElement(x)))) return;
      p.node.properties = props.filter((x, i) => !drop.has(i));
      n += drop.size;
    },
  });
  return n;
}

// [1, "i", null, undefined];  — sonucu kullanılmayan literal dizi/nesne deyimi (js-confuser sabit tablosu kalıntısı).
// Program sonundaki deyim tamamlanma değeri olabilir (eval): dokunulmaz.
function literalStatements(ast) {
  let n = 0;
  traverse(ast, {
    ExpressionStatement(p) {
      if (!Array.isArray(p.container) || (p.parentPath.isProgram() && p.key === p.container.length - 1)) return;
      const e = p.node.expression;
      // Object.create(null);  — sonucu kullanılmayan önbellek nesnesi (dispatcher önbelleğinin kalıntısı)
      if (t.isCallExpression(e) && t.isMemberExpression(e.callee, { computed: false }) && t.isIdentifier(e.callee.object, { name: 'Object' }) &&
          !p.scope.getBinding('Object') && t.isIdentifier(e.callee.property, { name: 'create' }) && e.arguments.length === 1 &&
          t.isNullLiteral(e.arguments[0])) {
        p.remove();
        n++;
        return;
      }
      if (!t.isArrayExpression(e) && !t.isObjectExpression(e)) return;
      const inert = (x) => x === null || t.isStringLiteral(x) || t.isNumericLiteral(x) || t.isBooleanLiteral(x) || t.isNullLiteral(x) ||
        (t.isIdentifier(x, { name: 'undefined' }) && !p.scope.getBinding('undefined')) ||
        (t.isUnaryExpression(x, { operator: '-' }) && t.isNumericLiteral(x.argument)) ||
        (t.isArrayExpression(x) && x.elements.every(inert)) ||
        (t.isObjectExpression(x) && x.properties.every((q) => t.isObjectProperty(q) && !q.computed && inert(q.value)));
      if (!inert(e)) return;
      p.remove();
      n++;
    },
  });
  return n;
}

export async function run(ast, { onLog, bump, level }) {
  const steps = [
    ['dead.literalStmt', 'etkisiz literal deyim', () => literalStatements(ast)],
    ['dead.unreachable', 'E214 erişilemeyen deyim', () => unreachable(ast)],
    ['dead.duplicate', 'E215 yinelenen tanım', () => duplicates(ast)],
    ['dead.extraArgs', 'E219 fazla argüman', () => extraArgs(ast)],
    ['dead.unusedParam', 'E210 kullanılmayan parametre', () => (level >= 3 ? unusedParams(ast, level) : 0)],
    ['dead.unusedImport', 'E211 kullanılmayan import adı', () => (level >= 3 ? unusedImports(ast) : 0)],
    ['dead.privateMember', 'E212 kullanılmayan özel sınıf üyesi', () => privateMembers(ast)],
  ];
  let changed = false;
  for (const [stat, label, step] of steps) {
    if (changed) { traverse(ast, { Program(p) { p.scope.crawl(); p.stop(); } }); changed = false; }
    const k = step();
    if (!k) continue;
    changed = true;
    bump(stat, k);
    onLog(`dead-extra: ${label} kaldırıldı (${k})`, 'info');
  }
}
