import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { literalValue, isLiteralTree } from '../util/pure.js';
import { literalOf } from '../util/literal.js';

// Anlamı birebir koruyan küçük sadeleştirmeler (gözetleme deliği). Her kural yalnızca eşdeğerliği
// yerel olarak kanıtlanabilen biçimlere uygulanır; şüpheli durumda dokunulmaz.

// Yan etkisiz ve iki kez okunsa da aynı sonucu veren ifade (getter çağırabilecek üye erişimi hariç)
const isPureAtom = (n) => t.isIdentifier(n) || t.isThisExpression(n) || literalValue(n).ok;

// Sonucu kesinlikle 32 bit tamsayı olan ifade
const INT_OPS = new Set(['|', '&', '^', '<<', '>>']);
function isInt32(n) {
  if (t.isNumericLiteral(n)) return Number.isInteger(n.value) && (n.value | 0) === n.value && !Object.is(n.value, -0);
  if (t.isBinaryExpression(n) && INT_OPS.has(n.operator)) return true;
  if (t.isUnaryExpression(n, { operator: '~' })) return true;
  if (t.isUnaryExpression(n, { operator: '-' }) && t.isNumericLiteral(n.argument)) return isInt32(t.numericLiteral(-n.argument.value));
  return false;
}

// Sonucu kesinlikle number olan ifade (string birleştirme olasılığı yok)
const NUM_OPS = new Set(['-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>']);
function isNumber(n) {
  if (t.isNumericLiteral(n)) return true;
  if (t.isBinaryExpression(n) && NUM_OPS.has(n.operator)) return true;
  if (t.isBinaryExpression(n, { operator: '+' })) return isNumber(n.left) && isNumber(n.right);
  if (t.isUnaryExpression(n) && ['-', '+', '~'].includes(n.operator)) return true;
  if (t.isUpdateExpression(n)) return true;
  return false;
}

// İfadenin değeri yalnızca doğruluk değeri olarak kullanılıyor mu?
function inBooleanContext(p) {
  const par = p.parentPath;
  if (!par) return false;
  if ((par.isIfStatement() || par.isWhileStatement() || par.isDoWhileStatement() || par.isConditionalExpression()) && p.key === 'test') return true;
  if (par.isForStatement() && p.key === 'test') return true;
  if (par.isUnaryExpression({ operator: '!' })) return true;
  if (par.isLogicalExpression() && p.key === 'left' && inBooleanContext(par)) return true;
  if (par.isLogicalExpression() && p.key === 'right' && inBooleanContext(par)) return true;
  return false;
}

const isGlobalRef = (p, name) => !p.scope.getBinding(name);

// A-14: şablon literali içine literal ifadeyi göm (ham metinde \, ` ve ${ kaçışlanır)
const rawOf = (cooked) => cooked.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/\r/g, '\\r');

// E126: yan etkisiz literal ağacının JS değeri (nesne/dizi taze oluşturulur)
function treeValue(node) {
  if (t.isArrayExpression(node)) return node.elements.map((e) => (e === null ? undefined : treeValue(e)));
  if (t.isObjectExpression(node)) {
    const o = {};
    for (const p of node.properties) {
      const k = t.isIdentifier(p.key) ? p.key.name : String(p.key.value);
      if (k === '__proto__') return undefined;
      o[k] = treeValue(p.value);
    }
    return o;
  }
  if (t.isTemplateLiteral(node)) return node.quasis[0].value.cooked;
  return literalValue(node).value;
}
const BUILTIN_CTORS = new Set(['Object', 'Array', 'Function', 'String', 'Number', 'Boolean', 'RegExp', 'Error', 'Date', 'Map', 'Set', 'Promise', 'Symbol']);

// E142: kesinlikle sonlu ve negatif olmayan, yan etkisiz sayı (x * 0 → 0 için; -0/NaN üretemez)
function constNumberLeaf(p, n) {
  if (t.isNumericLiteral(n)) return true;
  if (!t.isIdentifier(n)) return false;
  const b = p.scope.getBinding(n.name);
  return Boolean(b?.constant && b.path.isVariableDeclarator() && t.isNumericLiteral(b.path.node.init));
}
function sideEffectFreeNumeric(p, n) {
  if (constNumberLeaf(p, n)) return true;
  if (t.isBinaryExpression(n) && NUM_OPS.has(n.operator)) return sideEffectFreeNumeric(p, n.left) && sideEffectFreeNumeric(p, n.right);
  if (t.isUnaryExpression(n) && ['-', '~'].includes(n.operator)) return sideEffectFreeNumeric(p, n.argument);
  return false;
}
function nonNegativeFinite(p, n) {
  if (t.isNumericLiteral(n)) return Number.isFinite(n.value);
  if (!sideEffectFreeNumeric(p, n)) return false;
  if (t.isBinaryExpression(n, { operator: '>>>' })) return true;
  if (t.isBinaryExpression(n, { operator: '&' })) {
    const nonneg = (x) => t.isNumericLiteral(x) && Number.isInteger(x.value) && x.value >= 0 && x.value <= 0x7fffffff;
    return nonneg(n.left) || nonneg(n.right);
  }
  return false;
}

// break/continue hedefi verilen döngü olan deyim var mı (iç döngü/switch içindekiler hariç)
function hasOwnJump(body) {
  let found = false;
  // switch yalnızca break'i yakalar: içindeki continue yine dıştaki döngüyü hedefler
  const walk = (n, breakDepth, contDepth) => {
    if (!n || typeof n !== 'object' || found) return;
    if (t.isFunction(n)) return;
    if (t.isBreakStatement(n) || t.isContinueStatement(n)) {
      if (n.label || (t.isBreakStatement(n) ? breakDepth : contDepth) === 0) found = true;
      return;
    }
    const loop = t.isLoop(n);
    const b = loop || t.isSwitchStatement(n) ? breakDepth + 1 : breakDepth;
    const c = loop ? contDepth + 1 : contDepth;
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x) => walk(x, b, c)); else walk(v, b, c);
    }
  };
  walk(body, 0, 0);
  return found;
}

const hasLexical = (stmts) => stmts.some((s) => t.isFunctionDeclaration(s) || t.isClassDeclaration(s) ||
  (t.isVariableDeclaration(s) && s.kind !== 'var'));

const asStatements = (n) => (t.isBlockStatement(n) ? n.body : [n]);
const blockOf = (stmts) => (stmts.length === 1 && !hasLexical(stmts) ? stmts[0] : t.blockStatement(stmts));

export async function run(ast, { onLog, bump, level }) {
  let n = 0;
  const hit = () => { n++; };

  traverse(ast, {
    // A-16 / E135: /abc/.source → "abc"; /re/.test("lit") → true/false (g/y bayraklı değil)
    MemberExpression: {
      exit(p) {
        const { object, property, computed } = p.node;
        if (t.isRegExpLiteral(object) && !computed && t.isIdentifier(property)) {
          if (property.name === 'source' && !p.parentPath.isCallExpression({ callee: p.node })) {
            p.replaceWith(t.stringLiteral(new RegExp(object.pattern, object.flags).source)); hit();
          } else if (property.name === 'flags' && !p.parentPath.isCallExpression({ callee: p.node })) {
            p.replaceWith(t.stringLiteral(new RegExp(object.pattern, object.flags).flags)); hit();
          }
        }
      },
    },
    CallExpression: {
      exit(p) {
        const { callee, arguments: args } = p.node;
        if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.property)) return;
        const m = callee.property.name;
        const obj = callee.object;
        if (t.isRegExpLiteral(obj) && m === 'test' && args.length === 1 && t.isStringLiteral(args[0]) && !/[gy]/.test(obj.flags)) {
          try {
            p.replaceWith(t.booleanLiteral(new RegExp(obj.pattern, obj.flags).test(args[0].value))); hit();
          } catch { /* geçersiz desen: dokunma */ }
          return;
        }
        if (args.some((a) => t.isSpreadElement(a))) return;
        const thisArg = args[0];
        // null değil: strict modda f.call(null) this=null verir, f() ise undefined
        const nullish = (a) => !a || (t.isIdentifier(a, { name: 'undefined' }) && isGlobalRef(p, 'undefined')) ||
          t.isUnaryExpression(a, { operator: 'void' }) && literalValue(a.argument).ok;
        // E108: f.call(null, a, b) → f(a, b); f.apply(undefined, [a, b]) → f(a, b)  (f düz ad: this zaten undefined)
        if (t.isIdentifier(obj) && (m === 'call' || m === 'apply') && nullish(thisArg)) {
          if (m === 'call') { p.replaceWith(t.callExpression(obj, args.slice(1))); hit(); return; }
          const list = args[1];
          if (args.length === 1 || (args.length === 2 && t.isArrayExpression(list) && list.elements.every((e) => e && !t.isSpreadElement(e)))) {
            p.replaceWith(t.callExpression(obj, args.length === 1 ? [] : list.elements)); hit(); return;
          }
        }
        // E114: o.m.call(o, a) → o.m(a)  (o düz ad)
        if (m === 'call' && t.isMemberExpression(obj) && t.isIdentifier(obj.object) && t.isIdentifier(thisArg, { name: obj.object.name })) {
          p.replaceWith(t.callExpression(obj, args.slice(1))); hit(); return;
        }
      },
    },
    UnaryExpression: {
      exit(p) {
        const { operator, argument } = p.node;
        // E144 / E136: boolean bağlamda !!x → x
        if (operator === '!' && t.isUnaryExpression(argument, { operator: '!' }) && inBooleanContext(p)) {
          p.replaceWith(argument.argument); hit(); return;
        }
        // E137: ~~x → x (x zaten int32)
        if (operator === '~' && t.isUnaryExpression(argument, { operator: '~' }) && isInt32(argument.argument)) {
          p.replaceWith(argument.argument); hit(); return;
        }
        // E143: !(!a || !b) → a && b, !(!a && !b) → a || b  (boolean bağlamda)
        if (operator === '!' && t.isLogicalExpression(argument) && argument.operator !== '??' && inBooleanContext(p) &&
            t.isUnaryExpression(argument.left, { operator: '!' }) && t.isUnaryExpression(argument.right, { operator: '!' })) {
          p.replaceWith(t.logicalExpression(argument.operator === '||' ? '&&' : '||', argument.left.argument, argument.right.argument)); hit(); return;
        }
        // E150: delete <literal> → true
        if (operator === 'delete' && literalValue(argument).ok) { p.replaceWith(t.booleanLiteral(true)); hit(); return; }
        // E136: boolean bağlam dışında !!x → Boolean(x)  (Boolean global'i gölgelenmemişse)
        if (operator === '!' && t.isUnaryExpression(argument, { operator: '!' }) && !inBooleanContext(p) &&
            isGlobalRef(p, 'Boolean') && !p.parentPath.isUnaryExpression({ operator: '!' })) {
          p.replaceWith(t.callExpression(t.identifier('Boolean'), [argument.argument])); hit(); return;
        }
        // E138: +"12" / +"" / +true / +null / +[] → sayı
        if (operator === '+') {
          const lit = literalValue(argument);
          let v;
          if (lit.ok && typeof lit.value !== 'number') v = +lit.value;
          else if (t.isArrayExpression(argument) && !argument.elements.length) v = 0;
          else if (t.isTemplateLiteral(argument) && !argument.expressions.length) v = +argument.quasis[0].value.cooked;
          if (v !== undefined) {
            const node = literalOf(t, v);
            if (node) { p.replaceWith(node); hit(); }
          }
        }
      },
    },
    BinaryExpression: {
      exit(p) {
        const { operator, left, right } = p.node;
        const num = (x, v) => t.isNumericLiteral(x, { value: v });
        // E139: x|0 → x (x int32); E141: x*1, x/1 → x (x number); E140: 0+x / x+0 → x (x number, -0 hariç: 0 + -0 = 0)
        if (operator === '|' && num(right, 0) && isInt32(left)) { p.replaceWith(left); hit(); return; }
        if ((operator === '*' || operator === '/') && num(right, 1) && isNumber(left)) { p.replaceWith(left); hit(); return; }
        if (operator === '*' && num(left, 1) && isNumber(right)) { p.replaceWith(right); hit(); return; }
        if (operator === '**' && num(right, 1) && isNumber(left)) { p.replaceWith(left); hit(); return; }
        // E140: 0 + x / x + 0 → x (x int32: -0 olamaz); x - 0 → x (x number: -0 - 0 = -0)
        if (operator === '+' && num(left, 0) && isInt32(right)) { p.replaceWith(right); hit(); return; }
        if (operator === '+' && num(right, 0) && isInt32(left)) { p.replaceWith(left); hit(); return; }
        if (operator === '-' && num(right, 0) && isNumber(left)) { p.replaceWith(left); hit(); return; }
        // E142: x * 0 → 0 (x yan etkisiz, sonlu ve negatif değil: -0 ve NaN oluşamaz)
        if (operator === '*' && ((num(right, 0) && nonNegativeFinite(p, left)) || (num(left, 0) && nonNegativeFinite(p, right)))) {
          p.replaceWith(t.numericLiteral(0)); hit(); return;
        }
        // E126: <primitive literal> instanceof YerleşikKurucu → false; [..] instanceof Array → true; "k" in {literal}
        if (operator === 'instanceof' && t.isIdentifier(right) && BUILTIN_CTORS.has(right.name) && isGlobalRef(p, right.name) &&
            ((literalValue(left).ok && !t.isIdentifier(left)) || (t.isTemplateLiteral(left) && !left.expressions.length))) {
          p.replaceWith(t.booleanLiteral(false)); hit(); return;
        }
        if (operator === 'instanceof' && t.isIdentifier(right) && isGlobalRef(p, right.name) && isLiteralTree(left) &&
            ((t.isArrayExpression(left) && ['Array', 'Object'].includes(right.name)) || (t.isObjectExpression(left) && right.name === 'Object'))) {
          p.replaceWith(t.booleanLiteral(true)); hit(); return;
        }
        if (operator === 'in' && (t.isObjectExpression(right) || t.isArrayExpression(right)) && isLiteralTree(right) &&
            literalValue(left).ok && !t.isIdentifier(left)) {
          const value = treeValue(right);
          if (value === undefined) return;
          const key = String(literalValue(left).value);
          // kendi anahtarı: kesin true; prototipte de yoksa false (prototipteki adlar ortama göre değişebilir: dokunma)
          if (Object.hasOwn(value, key)) { p.replaceWith(t.booleanLiteral(true)); hit(); return; }
          if (!(key in value)) { p.replaceWith(t.booleanLiteral(false)); hit(); }
        }
      },
    },
    // A-14: şablon literalindeki literal ifadeler metne gömülür; ifadesi kalmayan şablon string olur
    TemplateLiteral: {
      exit(p) {
        if (p.parentPath.isTaggedTemplateExpression()) return;
        const { quasis, expressions } = p.node;
        const named = (e) => t.isIdentifier(e) && ['undefined', 'NaN', 'Infinity'].includes(e.name) && isGlobalRef(p, e.name);
        const inlinable = (e) => (literalValue(e).ok && !t.isIdentifier(e)) || named(e) || (t.isTemplateLiteral(e) && !e.expressions.length);
        if (expressions.length && !expressions.some(inlinable)) return;
        if (quasis.some((q) => typeof q.value.cooked !== 'string')) return;
        const outQ = [quasis[0].value.cooked];
        const outE = [];
        expressions.forEach((e, i) => {
          if (inlinable(e)) {
            const v = t.isTemplateLiteral(e) ? e.quasis[0].value.cooked : named(e) ? String(globalThis[e.name]) : String(literalValue(e).value);
            outQ[outQ.length - 1] += v + quasis[i + 1].value.cooked;
          } else {
            outE.push(e);
            outQ.push(quasis[i + 1].value.cooked);
          }
        });
        if (!outE.length) { p.replaceWith(t.stringLiteral(outQ[0])); hit(); return; }
        p.replaceWith(t.templateLiteral(outQ.map((q, i) => t.templateElement({ raw: rawOf(q), cooked: q }, i === outQ.length - 1)), outE));
        hit();
      },
    },
    // E162: return a(), b(), x; → a(); b(); return x;   return c ? (A, x) : y; → if (c) { return (A, x); } return y;
    ReturnStatement: {
      exit(p) {
        const arg = p.node.argument;
        if (!arg || !Array.isArray(p.container)) return;
        if (t.isSequenceExpression(arg)) {
          const exprs = arg.expressions;
          p.replaceWithMultiple([...exprs.slice(0, -1).map((x) => t.expressionStatement(x)), t.returnStatement(exprs[exprs.length - 1])]);
          hit(); return;
        }
        if (t.isConditionalExpression(arg) && [arg.consequent, arg.alternate].some((x) => t.isSequenceExpression(x) || t.isConditionalExpression(x))) {
          p.replaceWithMultiple([t.ifStatement(arg.test, t.blockStatement([t.returnStatement(arg.consequent)])), t.returnStatement(arg.alternate)]);
          hit();
        }
      },
    },
    ConditionalExpression: {
      exit(p) {
        const { test, consequent, alternate } = p.node;
        // E147: x ? y : y → y (x saf) ya da (x, y)
        if (gen(consequent) === gen(alternate)) {
          p.replaceWith(isPureAtom(test) ? consequent : t.sequenceExpression([test, consequent])); hit(); return;
        }
        // E146: x ? x : y → x || y (x düz ad: tek okuma ile aynı)
        if (t.isIdentifier(test) && t.isIdentifier(consequent, { name: test.name })) {
          p.replaceWith(t.logicalExpression('||', test, alternate)); hit(); return;
        }
        if (t.isIdentifier(test) && t.isIdentifier(alternate, { name: test.name })) {
          p.replaceWith(t.logicalExpression('&&', test, consequent)); hit();
        }
      },
    },
    AssignmentExpression: {
      exit(p) {
        // E149: x = x (yerel, const olmayan değişken) → x
        const { left, right, operator } = p.node;
        if (operator !== '=' || !t.isIdentifier(left) || !t.isIdentifier(right, { name: left.name })) return;
        const b = p.scope.getBinding(left.name);
        if (!b || b.kind === 'const' || b.kind === 'module') return;
        if (p.parentPath.isExpressionStatement()) p.parentPath.remove(); else p.replaceWith(left);
        hit();
      },
    },
    ExpressionStatement: {
      exit(p) {
        const e = p.node.expression;
        if (!Array.isArray(p.container)) return;
        // A-20: a && b(); → if (a) b();   a || b(); → if (!a) b();   a ? b() : c(); → if/else
        if (t.isLogicalExpression(e) && e.operator !== '??') {
          const test = e.operator === '&&' ? e.left : t.unaryExpression('!', e.left);
          p.replaceWith(t.ifStatement(test, t.expressionStatement(e.right))); hit(); return;
        }
        if (t.isConditionalExpression(e)) {
          p.replaceWith(t.ifStatement(e.test, t.expressionStatement(e.consequent), t.expressionStatement(e.alternate))); hit(); return;
        }
        // a(), b(); → a(); b();
        if (t.isSequenceExpression(e)) {
          p.replaceWithMultiple(e.expressions.map((x) => t.expressionStatement(x))); hit();
        }
      },
    },
    IfStatement: {
      exit(p) {
        const { test, consequent, alternate } = p.node;
        const empty = (s) => !s || t.isEmptyStatement(s) || (t.isBlockStatement(s) && !s.body.length);
        // E148: boş dallar
        if (alternate && empty(alternate)) { p.node.alternate = null; hit(); return; }
        if (empty(consequent) && alternate) {
          p.replaceWith(t.ifStatement(t.unaryExpression('!', test), alternate)); hit(); return;
        }
        if (empty(consequent) && !alternate && Array.isArray(p.container)) {
          if (isPureAtom(test)) p.remove(); else p.replaceWith(t.expressionStatement(test));
          hit(); return;
        }
        // E168: if (a) { if (b) X } → if (a && b) X  (iki tarafta da else yok)
        const inner = t.isBlockStatement(consequent) && consequent.body.length === 1 ? consequent.body[0] : consequent;
        if (!alternate && t.isIfStatement(inner) && !inner.alternate) {
          p.replaceWith(t.ifStatement(t.logicalExpression('&&', test, inner.test), inner.consequent)); hit(); return;
        }
        // E169: if (c) { …; return x; } else { Y } → if (c) { …; return x; } Y
        if (alternate && Array.isArray(p.container) && !p.parentPath.isLabeledStatement()) {
          const body = asStatements(consequent);
          const last = body[body.length - 1];
          const exits = t.isReturnStatement(last) || t.isThrowStatement(last);
          const rest = asStatements(alternate);
          if (exits && !hasLexical(rest)) {
            p.node.alternate = null;
            p.insertAfter(rest);
            hit();
          }
        }
      },
    },
    // E171: do { X } while (false) → X (kendi break/continue'su yoksa)
    DoWhileStatement: {
      exit(p) {
        if (!t.isBooleanLiteral(p.node.test, { value: false }) || !Array.isArray(p.container) || p.parentPath.isLabeledStatement()) return;
        if (hasOwnJump(p.node.body)) return;
        const body = asStatements(p.node.body);
        if (hasLexical(body)) p.replaceWith(t.blockStatement(body)); else p.replaceWithMultiple(body);
        hit();
      },
    },
    // E172: while (true) { X; break; } → X (başka kendi break/continue'su yoksa)
    WhileStatement: {
      exit(p) {
        if (!t.isBooleanLiteral(p.node.test, { value: true }) || !Array.isArray(p.container) || p.parentPath.isLabeledStatement()) return;
        const body = asStatements(p.node.body);
        const last = body[body.length - 1];
        if (!t.isBreakStatement(last) || last.label || hasOwnJump(t.blockStatement(body.slice(0, -1)))) return;
        const rest = body.slice(0, -1);
        if (hasLexical(rest)) p.replaceWith(t.blockStatement(rest)); else p.replaceWithMultiple(rest);
        hit();
      },
    },
    Function: {
      exit(p) {
        // E106: arguments[0] → ilk parametre (parametreler düz ad, hiçbiri ve arguments yazılmıyor)
        if (p.isArrowFunctionExpression()) return;
        const params = p.node.params;
        if (!params.length || !params.every((x) => t.isIdentifier(x))) return;
        if (params.some((x) => { const b = p.scope.getBinding(x.name); return !b || b.constantViolations.length; })) return;
        const uses = [];
        let ok = true;
        p.traverse({
          Function(q) { if (!q.isArrowFunctionExpression()) q.skip(); },
          Identifier(q) {
            if (q.node.name !== 'arguments' || !q.isReferencedIdentifier() || q.scope.getBinding('arguments')) return;
            const m = q.parentPath;
            if (!m.isMemberExpression({ object: q.node }) || !m.node.computed || !t.isNumericLiteral(m.node.property) ||
                m.node.property.value >= params.length || !Number.isInteger(m.node.property.value) ||
                m.parentPath.isAssignmentExpression({ left: m.node }) || m.parentPath.isUpdateExpression() ||
                m.parentPath.isUnaryExpression({ operator: 'delete' }) || m.parentPath.isCallExpression({ callee: m.node })) { ok = false; q.stop(); return; }
            uses.push(m);
          },
        });
        if (!ok || !uses.length) return;
        for (const m of uses) m.replaceWith(t.identifier(params[m.node.property.value].name));
        n += uses.length;
      },
    },
  });

  // E111 / E113: kimlik fonksiyonu ve sabit döndüren fonksiyon çağrıları
  traverse(ast, {
    FunctionDeclaration(p) {
      const body = p.node.body.body;
      // program kapsamındaki fonksiyon başka script'lerden çağrılabilir: yalnızca maksimum seviyede
      if (p.parentPath.isProgram() && level < 4) return;
      if (!p.node.id || p.node.async || p.node.generator || body.length !== 1 || !t.isReturnStatement(body[0]) || !body[0].argument) return;
      const ret = body[0].argument;
      const params = p.node.params;
      const identity = params.length >= 1 && t.isIdentifier(params[0]) && t.isIdentifier(ret, { name: params[0].name });
      const constant = literalValue(ret).ok && !t.isIdentifier(ret);
      if (!identity && !constant) return;
      const b = p.parentPath.scope.getBinding(p.node.id.name);
      if (!b || b.constantViolations.length || !b.referencePaths.length) return;
      // tüm kullanımlar düz çağrı olmalı; düşen argümanlar saf olmalı
      const calls = b.referencePaths.map((r) => r.parentPath);
      if (!calls.every((c, i) => c.isCallExpression({ callee: b.referencePaths[i].node }) && c.node.arguments.every((a) => !t.isSpreadElement(a)))) return;
      if (!calls.every((c) => c.node.arguments.every((a, i) => (identity && i === 0) || isPureAtom(a)))) return;
      for (const c of calls) {
        c.replaceWith(identity ? (c.node.arguments[0] ?? t.unaryExpression('void', t.numericLiteral(0))) : t.cloneNode(ret, true));
        n++;
      }
      p.remove();
    },
  });

  if (n) onLog(`simplify: ${n} sadeleştirme`, 'info');
  bump('simplify', n);
}
