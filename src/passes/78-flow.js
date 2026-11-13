import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { literalValue } from '../util/pure.js';

// Akış normalizasyonu. Her kural yalnızca yerel olarak eşdeğerliği kanıtlanan biçime uygulanır.
//  E161 try/catch ile gizlenmiş akış       E163 küçük switch → if zinciri    E164 literal dönen switch → Map tablosu
//  E166 break/continue normalizasyonu      E170 guard cümlesi                E217 boş catch
//  (E203 zamanlama tabanlı anti-debug: 79-anti-timing)

const MAX_IF_CASES = 3;
const MIN_TABLE_CASES = 4;

const isLexical = (s) => t.isFunctionDeclaration(s) || t.isClassDeclaration(s) || (t.isVariableDeclaration(s) && s.kind !== 'var');
// Eşitlik karşılaştırmaları ters işleçle yazılır (< > NaN yüzünden tersine çevrilemez)
const FLIP = { '===': '!==', '!==': '===', '==': '!=', '!=': '==' };
const negate = (e) => (t.isUnaryExpression(e, { operator: '!' }) ? e.argument
  : t.isBinaryExpression(e) && FLIP[e.operator] ? t.binaryExpression(FLIP[e.operator], e.left, e.right) : t.unaryExpression('!', e));
const asList = (s) => (!s ? [] : t.isBlockStatement(s) ? s.body : [s]);

// Verilen deyim kesinlikle hata fırlatmaz ve akışı değiştirmez mi?
function cannotThrow(p, s) {
  if (t.isEmptyStatement(s)) return true;
  const literalish = (v) => !v || literalValue(v).ok || t.isFunctionExpression(v) || t.isArrowFunctionExpression(v);
  if (t.isVariableDeclaration(s, { kind: 'var' })) return s.declarations.every((d) => t.isIdentifier(d.id) && literalish(d.init));
  if (t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression, { operator: '=' }) && t.isIdentifier(s.expression.left)) {
    const b = p.scope.getBinding(s.expression.left.name);
    // var/parametre/fonksiyon adına literal atama: TDZ ya da const hatası olamaz
    return Boolean(b) && ['var', 'param', 'hoisted'].includes(b.kind) && literalish(s.expression.right);
  }
  return false;
}

// Gövdede ad yeniden bildiriliyor mu? (catch parametresini let yaparken çakışma)
function declares(node, name) {
  let found = false;
  t.traverseFast(node, (n) => {
    if ((t.isVariableDeclarator(n) || t.isFunctionDeclaration(n) || t.isClassDeclaration(n)) && n.id &&
        Object.keys(t.getBindingIdentifiers(n.id)).includes(name)) found = true;
  });
  return found;
}

// Kendi döngü/switch'i dışında etiketsiz break (switch'i hedefleyen) var mı?
function breaksOut(node) {
  let found = false;
  const walk = (n, nested) => {
    if (!n || typeof n !== 'object' || found || t.isFunction(n)) return;
    if (t.isBreakStatement(n) && !n.label && !nested) { found = true; return; }
    const inner = nested || t.isLoop(n) || t.isSwitchStatement(n);
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, inner)); else walk(v, inner);
    }
  };
  walk(node, false);
  return found;
}

const terminates = (s) => t.isReturnStatement(s) || t.isThrowStatement(s) || t.isContinueStatement(s) || (t.isBreakStatement(s) && s.label);

// ── E161 / E217: try ────────────────────────────────────

function tries(ast) {
  let n = 0;
  traverse(ast, {
    TryStatement: {
      exit(p) {
        if (!Array.isArray(p.container) || p.findParent((x) => x.isWithStatement())) return;
        const { block, handler, finalizer } = p.node;
        const body = block.body;
        // E217: catch (e) {} — e kullanılmıyorsa isteğe bağlı bağlama: catch {}
        if (handler?.param && t.isIdentifier(handler.param)) {
          const hb = p.get('handler').scope.getBinding(handler.param.name);
          if (hb && !hb.referenced && !hb.constantViolations.length && !handler.body.body.length) {
            handler.param = null;
            n++;
          }
        }
        // boş try: catch hiç çalışmaz
        if (!body.length) {
          const rest = finalizer ? finalizer.body : [];
          if (rest.some(isLexical)) p.replaceWith(t.blockStatement(rest)); else if (rest.length) p.replaceWithMultiple(rest); else p.remove();
          n++;
          return;
        }
        if (body.some(isLexical)) return;
        // try içi hiç fırlatamaz: catch ölü, finally sırayla çalışır
        if (body.every((s) => cannotThrow(p, s))) {
          const fin = finalizer ? finalizer.body : [];
          if (fin.some(isLexical)) return;
          p.replaceWithMultiple([...body, ...fin]);
          n++;
          return;
        }
        // E161: try { güvenli…; throw LIT; } catch (e) { H }  →  güvenli…; { let e = LIT; H }
        const last = body[body.length - 1];
        if (!handler || finalizer || !t.isThrowStatement(last) || !literalValue(last.argument).ok) return;
        if (!body.slice(0, -1).every((s) => cannotThrow(p, s))) return;
        const param = handler.param;
        if (param && !t.isIdentifier(param)) return;
        if (param && declares(handler.body, param.name)) return;
        const used = param && p.get('handler').scope.getBinding(param.name)?.referenced;
        const hBody = used
          ? [t.variableDeclaration('let', [t.variableDeclarator(t.identifier(param.name), last.argument)]), ...handler.body.body]
          : handler.body.body;
        p.replaceWithMultiple([...body.slice(0, -1), t.blockStatement(hBody)]);
        n++;
      },
    },
  });
  return n;
}

// ── E163 / E164: switch ─────────────────────────────────

// case grupları: art arda boş case'ler sonraki gövdeyle birleşir
function caseGroups(sw) {
  const groups = [];
  let tests = [];
  for (const c of sw.cases) {
    tests.push(c.test);
    if (!c.consequent.length) continue;
    groups.push({ tests, body: c.consequent });
    tests = [];
  }
  if (tests.length) groups.push({ tests, body: [] });
  return groups;
}

const caseLiteral = (n) => n && (t.isStringLiteral(n) || t.isBooleanLiteral(n) || t.isNullLiteral(n) ||
  (t.isNumericLiteral(n) && !Number.isNaN(n.value)) || (t.isUnaryExpression(n, { operator: '-' }) && t.isNumericLiteral(n.argument)));
const litKey = (n) => { const v = literalValue(n).value; return `${typeof v}:${Object.is(v, -0) ? 0 : v}`; };

function switches(ast, level) {
  let n = 0;
  traverse(ast, {
    SwitchStatement: {
      exit(p) {
        const sw = p.node;
        if (!sw.cases.length || p.parentPath.isLabeledStatement()) return;
        // döngü gövdesindeki switch bir durum makinesi olabilir: unflatten/vm'nin tanıyacağı biçim korunur
        if (p.parentPath.isLoop() || (p.parentPath.isBlockStatement() && p.parentPath.parentPath.isLoop())) return;
        const tests = sw.cases.filter((c) => c.test).map((c) => c.test);
        if (!tests.every(caseLiteral) || new Set(tests.map(litKey)).size !== tests.length) return;
        if (sw.cases.some((c) => c.consequent.some(isLexical))) return;
        const groups = caseGroups(sw);
        if (groups.some((g) => g.tests.includes(null) && g.tests.length > 1)) return;

        // E164: her grup literal döndürüyorsa (null/undefined dışı) Map tablosu
        const fnBody = p.parentPath.isBlockStatement() && p.parentPath.parentPath.isFunction() ? p.parentPath : null;
        const returnsLit = (g) => g.body.length === 1 && t.isReturnStatement(g.body[0]) && g.body[0].argument &&
          literalValue(g.body[0].argument).ok && literalValue(g.body[0].argument).value != null && !t.isIdentifier(g.body[0].argument);
        const def = groups.find((g) => g.tests.includes(null));
        const isLast = fnBody && p.key === fnBody.node.body.length - 1;
        if (level >= 3 && tests.length >= MIN_TABLE_CASES && groups.every(returnsLit) && (def || isLast) && !p.scope.getBinding('Map') &&
            Array.isArray(p.container)) {
          const entries = [];
          for (const g of groups) for (const test of g.tests) if (test) entries.push(t.arrayExpression([test, g.body[0].argument]));
          let expr = t.callExpression(t.memberExpression(t.newExpression(t.identifier('Map'), [t.arrayExpression(entries)]), t.identifier('get')), [sw.discriminant]);
          if (def) expr = t.logicalExpression('??', expr, def.body[0].argument);
          p.replaceWith(t.returnStatement(expr));
          n++;
          return;
        }

        // E163: küçük switch → if zinciri (ayırıcı bağlı bir ad: testler arasında değişmez)
        if (tests.length > MAX_IF_CASES || !t.isIdentifier(sw.discriminant) || !p.scope.getBinding(sw.discriminant.name)) return;
        if (p.findParent((x) => x.isWithStatement())) return;
        const bodies = [];
        for (const [i, g] of groups.entries()) {
          let body = g.body.slice();
          const last = body[body.length - 1];
          if (t.isBreakStatement(last) && !last.label) body = body.slice(0, -1);
          else if (!(last && terminates(last)) && i !== groups.length - 1) return; // düşen gövde
          if (body.some(breaksOut)) return;
          bodies.push({ tests: g.tests, body });
        }
        let out = null;
        const dflt = bodies.find((b) => b.tests.includes(null));
        if (dflt) out = t.blockStatement(dflt.body);
        for (const b of bodies.filter((x) => !x.tests.includes(null)).reverse()) {
          const test = b.tests.map((x) => t.binaryExpression('===', t.identifier(sw.discriminant.name), x))
            .reduce((a, c) => t.logicalExpression('||', a, c));
          out = t.ifStatement(test, t.blockStatement(b.body), out);
        }
        if (!out) return;
        p.replaceWith(out);
        n++;
      },
    },
  });
  return n;
}

// ── E166: break / continue ──────────────────────────────

function jumps(ast) {
  let n = 0;
  traverse(ast, {
    // döngü gövdesinin sonundaki continue etkisiz
    'WhileStatement|DoWhileStatement|ForStatement|ForInStatement|ForOfStatement'(p) {
      const body = p.node.body;
      if (!t.isBlockStatement(body)) return;
      const last = body.body[body.body.length - 1];
      const own = p.parentPath.isLabeledStatement() ? p.parentPath.node.label.name : null;
      if (t.isContinueStatement(last) && (!last.label || last.label.name === own)) { body.body.pop(); n++; }
    },
    // switch'in son case'indeki sondaki break etkisiz
    SwitchStatement(p) {
      const lastCase = p.node.cases[p.node.cases.length - 1];
      const last = lastCase?.consequent[lastCase.consequent.length - 1];
      if (t.isBreakStatement(last) && !last.label) { lastCase.consequent.pop(); n++; }
    },
    // etiket en içteki hedefi gösteriyorsa etiketsiz yazılır
    'BreakStatement|ContinueStatement'(p) {
      const label = p.node.label?.name;
      if (!label) return;
      const target = p.findParent((x) => x.isLabeledStatement() && x.node.label.name === label);
      if (!target) return;
      const isCont = p.isContinueStatement();
      const inner = p.findParent((x) => x.isFunction() || x.isLoop() || (!isCont && x.isSwitchStatement()));
      if (!inner || inner.isFunction() || inner.parentPath !== target) return;
      p.node.label = null;
      n++;
    },
    LabeledStatement: {
      exit(p) {
        const label = p.node.label.name;
        let used = false;
        p.traverse({
          Function(q) { q.skip(); },
          'BreakStatement|ContinueStatement'(q) { if (q.node.label?.name === label) used = true; },
        });
        if (used) return;
        p.replaceWith(p.node.body);
        n++;
      },
    },
  });
  return n;
}

// ── E170: guard cümlesi ─────────────────────────────────

function guards(ast) {
  let n = 0;
  const flip = (list, exit) => {
    const last = list[list.length - 1];
    if (!t.isIfStatement(last) || last.alternate) return false;
    const inner = asList(last.consequent);
    if (inner.length < 2 || inner.some(isLexical)) return false;
    list.splice(list.length - 1, 1, t.ifStatement(negate(last.test), exit()), ...inner);
    return true;
  };
  traverse(ast, {
    Function(p) {
      if (!t.isBlockStatement(p.node.body)) return;
      if (flip(p.node.body.body, () => t.returnStatement(null))) n++;
    },
    'WhileStatement|DoWhileStatement|ForStatement|ForInStatement|ForOfStatement'(p) {
      if (!t.isBlockStatement(p.node.body)) return;
      if (flip(p.node.body.body, () => t.continueStatement(null))) n++;
    },
  });
  return n;
}

export async function run(ast, { onLog, bump, level }) {
  const steps = [
    ['flowTry', 'E161/E217 try/catch sadeleştirildi', () => tries(ast)],
    ['flowSwitch', 'E163/E164 switch if zincirine/tabloya çevrildi', () => (level >= 3 ? switches(ast, level) : 0)],
    ['flowJump', 'E166 break/continue normalleştirildi', () => jumps(ast)],
    ['flowGuard', 'E170 guard cümlesi üretildi', () => (level >= 3 ? guards(ast) : 0)],
  ];
  let changed = false;
  for (const [stat, label, step] of steps) {
    // yapı değiştiyse sonraki adım bayat bağlamalarla çalışmasın
    if (changed) { traverse(ast, { Program(p) { p.scope.crawl(); p.stop(); } }); changed = false; }
    const k = step();
    if (!k) continue;
    changed = true;
    bump(stat, k);
    onLog(`flow: ${label} (${k})`, 'info');
  }
}
