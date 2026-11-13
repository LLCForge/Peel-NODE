import * as t from '@babel/types';
import { traverse, generate } from '../util/ast.js';

// Yapısal gizleme geri alma (anlamı koruyan, yerel olarak kanıtlanabilen dönüşümler). Literal kaynaklı
// destructuring, with ve rest+length dönüşümleri 42-indirection ve 37-confuser pass'lerindedir; burada
// onların kapsamadığı biçimler var:
//   E50  var { log: l, warn: w } = console → var l = console.log, w = console.warn   (kaynak düz ad)
//   E51  void 0 → undefined (undefined gölgelenmemişse)
//   E54  return a ? b : c ? d : e → if/else zinciri; x = a ? b : c ? d : e; ve var x = … için de
//   Kuyruk birleştirme: if (c) { A; T } T  (T return/throw ile biter) → if (c) { A } T — durum makinesi
//   açılırken dallara kopyalanan ortak kuyruk (dağıtıcı bayrak testleri) tek kopyaya iner

const isExit = (s) => t.isReturnStatement(s) || t.isThrowStatement(s);
const code = (n) => generate(n, { compact: true, comments: false }).code;
const sameCode = (a, b) => a.length === b.length && a.every((x, i) => code(x) === code(b[i]));
// let/const/class/function bildirimleri blok kapsamı nedeniyle bloklar arasında taşınmaz
const lexical = (x) => t.isClassDeclaration(x) || t.isFunctionDeclaration(x) || (t.isVariableDeclaration(x) && x.kind !== 'var');
function mergeTails(list) {
  let n = 0;
  for (let i = 0; i < list.length - 1; i++) {
    const s = list[i];
    if (!t.isIfStatement(s) || s.alternate || !t.isBlockStatement(s.consequent)) continue;
    const tail = list.slice(i + 1);
    const cons = s.consequent.body;
    if (!isExit(tail[tail.length - 1]) || tail.some(lexical)) continue;
    if (cons.length >= tail.length && sameCode(cons.slice(cons.length - tail.length), tail)) {
      cons.splice(cons.length - tail.length, tail.length);
      n++;
      continue;
    }
    // ortak sonek kuyruğun yalnızca bir kısmıysa: if (c) { A; S } B; S  → if (c) { A } else { B } S
    // (dal S'nin çıkışıyla bittiği için B yalnızca !c iken çalışıyordu)
    let k = 0;
    while (k < tail.length - 1 && k < cons.length && sameCode([cons[cons.length - 1 - k]], [tail[tail.length - 1 - k]])) k++;
    if (!k) continue;
    const a = cons.slice(0, cons.length - k);
    if (a.some(lexical)) continue;
    s.consequent.body = a;
    s.alternate = t.blockStatement(tail.slice(0, tail.length - k));
    list.splice(i + 1, tail.length - k);
    n++;
  }
  return n;
}

function chain(cond, leaf) {
  const branch = (e) => (t.isConditionalExpression(e) ? chain(e, leaf) : t.blockStatement([leaf(e)]));
  return t.ifStatement(cond.test, branch(cond.consequent), branch(cond.alternate));
}
const nested = (c) => t.isConditionalExpression(c) && (t.isConditionalExpression(c.consequent) || t.isConditionalExpression(c.alternate));

// var { k: v } = o (o düz ad, desen yalnızca hesaplanmamış anahtar → ad) → [v, o.k] çiftleri
function splitIdentifierPattern(id, init) {
  if (!t.isObjectPattern(id) || !t.isIdentifier(init) || !id.properties.length) return null;
  const pairs = [];
  for (const prop of id.properties) {
    if (!t.isObjectProperty(prop) || prop.computed || !t.isIdentifier(prop.value)) return null;
    const key = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : null;
    if (key === null || prop.value.name === init.name) return null;
    const member = t.isValidIdentifier(key) ? t.memberExpression(t.identifier(init.name), t.identifier(key))
      : t.memberExpression(t.identifier(init.name), t.stringLiteral(key), true);
    pairs.push([prop.value, member]);
  }
  return pairs;
}

export async function run(ast, { onLog, bump }) {
  let n = 0;
  traverse(ast, {
    BlockStatement(p) { n += mergeTails(p.node.body); },
    Program(p) { n += mergeTails(p.node.body); },
    UnaryExpression(p) {
      if (p.node.operator === 'void' && t.isNumericLiteral(p.node.argument) && !p.scope.hasBinding('undefined', true)) {
        p.replaceWith(t.identifier('undefined'));
        n++;
      }
    },
    VariableDeclaration(p) {
      if (p.parentPath.isFor() && p.parentPath.node.init !== p.node) return; // for-in/of başı
      const out = [];
      let changed = false;
      for (const d of p.node.declarations) {
        const split = splitIdentifierPattern(d.id, d.init);
        if (split) { out.push(...split.map(([v, init]) => t.variableDeclarator(v, init))); changed = true; } else out.push(d);
      }
      if (!changed) return;
      p.node.declarations = out;
      n++;
    },
    ExpressionStatement(p) {
      const e = p.node.expression;
      if (!t.isAssignmentExpression(e, { operator: '=' }) || !nested(e.right)) return;
      if (!(t.isIdentifier(e.left) || (t.isMemberExpression(e.left) && t.isIdentifier(e.left.object) && !e.left.computed))) return;
      p.replaceWith(chain(e.right, (leaf) => t.expressionStatement(t.assignmentExpression('=', t.cloneNode(e.left), leaf))));
      n++;
    },
    ReturnStatement(p) {
      if (!nested(p.node.argument)) return;
      p.replaceWith(chain(p.node.argument, (leaf) => t.returnStatement(leaf)));
      n++;
    },
  });
  // var x = a ? b : c ? d : e; → var x; if … (const hariç; tek bildirim)
  traverse(ast, {
    VariableDeclaration(p) {
      const { node } = p;
      if (node.kind === 'const' || node.declarations.length !== 1 || (!p.parentPath.isBlockStatement() && !p.parentPath.isProgram())) return;
      const d = node.declarations[0];
      if (!t.isIdentifier(d.id) || !nested(d.init)) return;
      const init = d.init;
      d.init = null;
      p.insertAfter(chain(init, (leaf) => t.expressionStatement(t.assignmentExpression('=', t.identifier(d.id.name), leaf))));
      n++;
    },
  });
  if (n) onLog(`restructure: ${n} yapı sadeleştirildi`, 'info');
  bump('restructure', n);
}
