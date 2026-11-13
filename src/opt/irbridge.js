import * as t from '@babel/types';
import { C, V, mk, show } from '../symbolic/ir.js';
import { solve } from '../symbolic/solver.js';
import { T } from './lattice.js';

// Babel ifadesi → sembolik IR. İzlenen kimlikler SSA sürümüne göre sembolik değişken olur; tipleri kafes
// analizinden gelir. Tip kesin değilse (karışık, nesne olabilir) çeviri başarısız olur: valueOf/getter
// çağrısı modellenmez. Çağrı ve üye erişimi (string .length dışında) desteklenmez.

/** varFor(identifier) → IR terimi ya da null */
export function toIR(node, varFor, scope) {
  const fail = () => { throw new Error('çevrilemez'); };
  const ev = (n) => {
    switch (n.type) {
      case 'NumericLiteral': case 'StringLiteral': case 'BooleanLiteral': return C(n.value);
      case 'NullLiteral': return C(null);
      case 'ParenthesizedExpression': return ev(n.expression);
      case 'Identifier': {
        const v = varFor(n);
        if (v) return v;
        if (!scope.getBinding(n.name)) {
          if (n.name === 'undefined') return C(undefined);
          if (n.name === 'NaN') return C(NaN);
          if (n.name === 'Infinity') return C(Infinity);
        }
        return fail();
      }
      case 'UnaryExpression': {
        const a = ev(n.argument);
        const op = { '-': 'neg', '+': 'pos', '!': '!', '~': '~', typeof: 'typeof', void: 'void' }[n.operator];
        return op ? mk(op, a) : fail();
      }
      case 'BinaryExpression':
        if (['in', 'instanceof', '**', '/'].includes(n.operator)) return fail();
        return mk(n.operator, ev(n.left), ev(n.right));
      case 'LogicalExpression': return mk(n.operator, ev(n.left), ev(n.right));
      case 'ConditionalExpression': return mk('ite', ev(n.test), ev(n.consequent), ev(n.alternate));
      case 'MemberExpression':
        if (!n.computed && t.isIdentifier(n.property, { name: 'length' })) {
          const o = ev(n.object);
          return o.k === 'c' && typeof o.v === 'string' ? C(o.v.length) : mk('len', o);
        }
        return fail();
      case 'TemplateLiteral': {
        let acc = C(n.quasis[0].value.cooked);
        n.expressions.forEach((e, i) => { acc = mk('+', mk('+', acc, mk('tostr', ev(e))), C(n.quasis[i + 1].value.cooked)); });
        return acc;
      }
      default: return fail();
    }
  };
  try { return ev(node); } catch { return null; }
}

/** SSA sürümünün soyut değerinden IR değişkeni (ispat için yalnızca kesin tipler) */
export function varForVersion(fx, ver) {
  const a = fx.abs.val.get(ver);
  if (!a || !fx.abs.converged || !fx.sccp?.converged) return null;
  const name = `${fx.varOf.get(ver.var).name}${ver.id}`;
  const c = fx.sccp?.val.get(ver);
  if (c && 'c' in c) return C(c.c);
  if (a.ty === T.number && a.int && Number.isFinite(a.lo) && Number.isFinite(a.hi)) return V(name, 'int', { lo: a.lo, hi: a.hi });
  if (a.ty === T.boolean) return V(name, 'bool');
  if (a.ty === T.undefined) return C(undefined);
  if (a.ty === T.null) return C(null);
  return null;
}

/**
 * Koşul her zaman doğru/yanlış mı? facts: önceden bilinen IR koşulları (baskın dallar).
 * Döner: { value: true|false, proof } ya da null
 */
export function decide(cond, facts = [], timeMs = 600) {
  const o = { mode: 'prove', timeMs, maxConflicts: 40000 };
  const notTrue = solve([...facts, mk('!', cond)], o);
  if (notTrue.status === 'unsat' && proofOk(notTrue.proof)) return { value: true, proof: notTrue.proof, text: show(cond) };
  const notFalse = solve([...facts, cond], o);
  if (notFalse.status === 'unsat' && proofOk(notFalse.proof)) return { value: false, proof: notFalse.proof, text: show(cond) };
  return null;
}

// DRUP kanıtı denetlenemediyse (bütçe) sonuç dönüşüm için kullanılmaz
function proofOk(p) {
  if (!p) return false;
  if (p.method === 'sat-drup') return p.checked === true;
  if (p.method === 'type-split') return p.cases.every(proofOk);
  return true;
}

/** Kanıtı okunur metne çevirir (E594) */
export function proofText(p) {
  if (!p) return '';
  switch (p.method) {
    case 'simplify': return `sadeleştirme: ${p.fact}`;
    case 'interval': return `aralık analizi: ${p.fact}`;
    case 'exhaustive': return `tüketici sayım: ${p.cases} durum (${(p.vars ?? []).join(', ')})`;
    case 'sat-drup': return `SAT (bit-blast, ${p.width} bit): ${p.vars} değişken, ${p.clauses} yan tümce, ${p.lemmas} DRUP lemması${p.checked ? ', bağımsız denetlendi' : ''}`;
    case 'type-split': return p.cases.map((c) => `[${Object.entries(c.types ?? {}).map(([k, v]) => `${k}:${v}`).join(' ')}] ${proofText(c)}`).join(' ; ');
    default: return p.method;
  }
}
