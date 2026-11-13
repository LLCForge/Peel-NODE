import * as t from '@babel/types';
import { T, ALL } from './lattice.js';

// Optimizasyon pass'lerinin ortak yardımcıları

const PRIM_NONBIG = T.undefined | T.null | T.boolean | T.number | T.string;
const RELATIONAL = new Set(['<', '<=', '>', '>=', '==', '!=']);
const ARITH = new Set(['+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>']);

/**
 * Tip bilgisine göre yan etkisiz ve istisnasız mı? (getter, valueOf/toString, BigInt karışımı TypeError,
 * tanımsız global ReferenceError yok). typeOf(identifierNode) → tip maskesi (bilinmiyorsa ALL).
 */
export function isPureTyped(node, typeOf, scope) {
  const tyOf = (n) => exprType(n, typeOf, scope);
  const ok = (n) => {
    switch (n.type) {
      case 'NumericLiteral': case 'StringLiteral': case 'BooleanLiteral': case 'NullLiteral': return true;
      case 'Identifier': {
        const b = scope.getBinding(n.name);
        if (!b) return n.name === 'undefined' || n.name === 'NaN' || n.name === 'Infinity';
        // let/const/class: TDZ'de okuma ReferenceError atar; yalnızca aynı fonksiyonda bildirimden sonra güvenli
        if (b.kind === 'let' || b.kind === 'const') {
          const sameFn = (b.scope.getFunctionParent() ?? b.scope.getProgramParent()) === (scope.getFunctionParent() ?? scope.getProgramParent());
          return sameFn && n.start != null && b.path.node.end != null && n.start > b.path.node.end;
        }
        return true;
      }
      case 'TemplateLiteral': return n.expressions.every((e) => ok(e) && !(tyOf(e) & ~PRIM_NONBIG));
      case 'UnaryExpression':
        if (n.operator === 'typeof') return t.isIdentifier(n.argument) || ok(n.argument);
        if (n.operator === '!' || n.operator === 'void') return ok(n.argument);
        if (n.operator === 'delete') return false;
        return ok(n.argument) && !(tyOf(n.argument) & ~PRIM_NONBIG);
      case 'BinaryExpression':
        if (!ok(n.left) || !ok(n.right)) return false;
        if (n.operator === '===' || n.operator === '!==') return true;
        if (RELATIONAL.has(n.operator) || ARITH.has(n.operator)) return !(tyOf(n.left) & ~PRIM_NONBIG) && !(tyOf(n.right) & ~PRIM_NONBIG);
        return false;
      case 'LogicalExpression': return ok(n.left) && ok(n.right);
      case 'ConditionalExpression': return ok(n.test) && ok(n.consequent) && ok(n.alternate);
      case 'SequenceExpression': return n.expressions.every(ok);
      case 'ParenthesizedExpression': return ok(n.expression);
      case 'MemberExpression':
        return !n.computed && t.isIdentifier(n.property, { name: 'length' }) && ok(n.object) && tyOf(n.object) === T.string;
      case 'FunctionExpression': case 'ArrowFunctionExpression': return true;
      default: return false;
    }
  };
  return ok(node);
}

/** İfadenin tip maskesi (kaba; identifier tipleri typeOf'tan) */
export function exprType(n, typeOf, scope) {
  switch (n.type) {
    case 'NumericLiteral': return T.number;
    case 'StringLiteral': case 'TemplateLiteral': return T.string;
    case 'BooleanLiteral': return T.boolean;
    case 'NullLiteral': return T.null;
    case 'Identifier': {
      const m = typeOf(n);
      if (m != null) return m;
      if (!scope.getBinding(n.name)) {
        if (n.name === 'undefined') return T.undefined;
        if (n.name === 'NaN' || n.name === 'Infinity') return T.number;
      }
      return ALL;
    }
    case 'UnaryExpression':
      if (n.operator === '!' || n.operator === 'delete') return T.boolean;
      if (n.operator === 'typeof') return T.string;
      if (n.operator === 'void') return T.undefined;
      return exprType(n.argument, typeOf, scope) & ~PRIM_NONBIG ? T.number | T.bigint : T.number;
    case 'BinaryExpression': {
      if (['===', '!==', '==', '!=', '<', '<=', '>', '>=', 'in', 'instanceof'].includes(n.operator)) return T.boolean;
      const l = exprType(n.left, typeOf, scope);
      const r = exprType(n.right, typeOf, scope);
      if (n.operator === '+') {
        if (l === T.string || r === T.string) return T.string;
        if (!(l & ~(PRIM_NONBIG & ~T.string)) && !(r & ~(PRIM_NONBIG & ~T.string))) return T.number;
        return T.number | T.string | T.bigint;
      }
      // bir taraf kesin number ise BigInt karışımı TypeError atar: tamamlanan sonuç number
      return (l | r) & ~PRIM_NONBIG && l !== T.number && r !== T.number ? T.number | T.bigint : T.number;
    }
    case 'LogicalExpression': return exprType(n.left, typeOf, scope) | exprType(n.right, typeOf, scope);
    case 'ConditionalExpression': return exprType(n.consequent, typeOf, scope) | exprType(n.alternate, typeOf, scope);
    case 'SequenceExpression': return exprType(n.expressions[n.expressions.length - 1], typeOf, scope);
    case 'MemberExpression':
      if (!n.computed && t.isIdentifier(n.property, { name: 'length' }) && exprType(n.object, typeOf, scope) === T.string) return T.number;
      return ALL;
    case 'ObjectExpression': case 'ArrayExpression': case 'NewExpression': case 'RegExpLiteral': return T.object;
    case 'FunctionExpression': case 'ArrowFunctionExpression': return T.function;
    default: return ALL;
  }
}

/** Primitive değer için literal düğüm (çok uzun string ya da gölgelenmiş NaN/Infinity için null) */
export function literalFor(v, scope) {
  if (v === undefined) return t.unaryExpression('void', t.numericLiteral(0));
  if (v === null) return t.nullLiteral();
  if (typeof v === 'boolean') return t.booleanLiteral(v);
  if (typeof v === 'string') return v.length <= 200 ? t.stringLiteral(v) : null;
  if (typeof v !== 'number') return null;
  if (Number.isNaN(v)) return scope.getBinding('NaN') ? null : t.identifier('NaN');
  if (!Number.isFinite(v)) {
    if (scope.getBinding('Infinity')) return null;
    return v > 0 ? t.identifier('Infinity') : t.unaryExpression('-', t.identifier('Infinity'));
  }
  if (Object.is(v, -0)) return t.unaryExpression('-', t.numericLiteral(0));
  return v < 0 ? t.unaryExpression('-', t.numericLiteral(-v)) : t.numericLiteral(v);
}

/** İçten dışa fonksiyon yolları (iç fonksiyon önce) */
export function functionPaths(ast, traverse) {
  const out = [];
  traverse(ast, {
    Function: { exit(p) { if (t.isBlockStatement(p.node.body)) out.push(p); } },
  });
  return out;
}

/** Kaynakta dinamik kapsam (eval/with) var mı? */
export function hasDynamicScope(ast, traverse) {
  let found = false;
  traverse(ast, {
    WithStatement(p) { found = true; p.stop(); },
    CallExpression(p) { if (t.isIdentifier(p.node.callee, { name: 'eval' }) && !p.scope.getBinding('eval')) { found = true; p.stop(); } },
  });
  return found;
}

/** Düğüm (alt ağaç) atama/güncelleme/çağrı içeriyor mu? */
export function hasSideEffectSyntax(n) {
  let found = false;
  const w = (x) => {
    if (found || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(w); return; }
    if (t.isFunction(x)) return;
    if (t.isAssignmentExpression(x) || t.isUpdateExpression(x) || t.isCallExpression(x) || t.isNewExpression(x) ||
        t.isUnaryExpression(x, { operator: 'delete' }) || t.isYieldExpression(x) || t.isAwaitExpression(x) || t.isTaggedTemplateExpression(x)) { found = true; return; }
    for (const k of t.VISITOR_KEYS[x.type] ?? []) w(x[k]);
  };
  w(n);
  return found;
}

/** İfadenin kanonik anahtarı: izlenen kimlikler sürüm/değer numarasıyla (GVN/CSE) */
export function exprKey(n, idKey) {
  const k = (x) => {
    switch (x.type) {
      case 'Identifier': { const s = idKey(x); return s ?? null; }
      case 'NumericLiteral': return `n${x.value}`;
      case 'StringLiteral': return `s${JSON.stringify(x.value)}`;
      case 'BooleanLiteral': return `b${x.value}`;
      case 'NullLiteral': return 'null';
      case 'UnaryExpression': { const a = k(x.argument); return a && `(${x.operator} ${a})`; }
      case 'BinaryExpression': case 'LogicalExpression': {
        const a = k(x.left); const b = k(x.right);
        return a && b && `(${a} ${x.operator} ${b})`;
      }
      case 'ConditionalExpression': { const a = k(x.test); const b = k(x.consequent); const c = k(x.alternate); return a && b && c && `(${a}?${b}:${c})`; }
      case 'MemberExpression': { const a = k(x.object); return !x.computed && a && `${a}.${x.property.name}`; }
      default: return null;
    }
  };
  return k(n);
}

export function nodeSize(n) {
  let c = 0;
  const w = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(w); return; }
    if (!x.type) return;
    c++;
    for (const key of t.VISITOR_KEYS[x.type] ?? []) w(x[key]);
  };
  w(n);
  return c;
}

/** Deyim listesindeki deyim yolu (insertBefore yapılabilir) */
export function stmtOf(p) {
  let cur = p;
  while (cur && !(cur.isStatement() && Array.isArray(cur.container))) {
    if (cur.isFunction()) return null;
    cur = cur.parentPath;
  }
  return cur;
}
