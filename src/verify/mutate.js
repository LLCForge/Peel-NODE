import * as t from '@babel/types';
import { parse } from '../core/parse.js';
import { traverse } from '../util/ast.js';
import { raw } from '../core/emit.js';
import { rng } from './grammar.js';

// E741: AST mutasyon motoru — anlamı değiştiren küçük mutasyonlar (operatör değişimi, literal oynatma, koşul
// olumsuzlama, deyim silme, dönüş değeri değişimi). Doğrulamanın gücünü ölçmek için: her mutant, etkileri
// karşılaştıran doğrulamada "öldürülmeli" (farkı yakalanmalı).

const SWAP = { '+': '-', '-': '+', '*': '/', '/': '*', '<': '<=', '<=': '<', '>': '>=', '>=': '>', '===': '!==', '!==': '===',
  '==': '!=', '!=': '==', '&': '|', '|': '&', '^': '&', '<<': '>>', '>>': '<<', '%': '*' };
const LOGIC = { '&&': '||', '||': '&&', '??': '||' };

export const OPERATORS = ['binary', 'logical', 'number', 'string', 'negate', 'delete', 'return', 'boolean'];

// mutasyon noktalarını sırayla listeler (her nokta: tür + yol indeksi)
function sites(ast) {
  const out = [];
  traverse(ast, {
    BinaryExpression(p) { if (SWAP[p.node.operator]) out.push({ op: 'binary', path: p }); },
    LogicalExpression(p) { out.push({ op: 'logical', path: p }); },
    NumericLiteral(p) { if (!p.parentPath.isMemberExpression({ property: p.node })) out.push({ op: 'number', path: p }); },
    StringLiteral(p) { if (!p.parentPath.isObjectProperty({ key: p.node }) && !p.parentPath.isImportDeclaration() && !p.parentPath.isDirective()) out.push({ op: 'string', path: p }); },
    BooleanLiteral(p) { out.push({ op: 'boolean', path: p }); },
    'IfStatement|ConditionalExpression|WhileStatement'(p) { if (p.node.test) out.push({ op: 'negate', path: p }); },
    ExpressionStatement(p) { if (p.parentPath.isBlockStatement() || p.parentPath.isProgram()) out.push({ op: 'delete', path: p }); },
    ReturnStatement(p) { if (p.node.argument) out.push({ op: 'return', path: p }); },
  });
  return out;
}

function apply(site) {
  const { op, path: p } = site;
  const n = p.node;
  switch (op) {
    case 'binary':
    case 'logical': {
      const old = n.operator;
      n.operator = (op === 'binary' ? SWAP : LOGIC)[old];
      return `${old} → ${n.operator}`;
    }
    case 'number': n.value += n.value === 0 ? 1 : n.value > 0 ? 1 : -1; n.extra = undefined; return `sayı → ${n.value}`;
    case 'string': n.value = n.value ? `${n.value}X` : 'X'; n.extra = undefined; return `string → ${JSON.stringify(n.value).slice(0, 40)}`;
    case 'boolean': n.value = !n.value; return `boolean → ${n.value}`;
    case 'negate': n.test = t.unaryExpression('!', n.test); return 'koşul olumsuzlandı';
    case 'delete': p.remove(); return 'deyim silindi';
    case 'return': n.argument = t.identifier('undefined'); return 'dönüş → undefined';
    default: throw new Error(`bilinmeyen mutasyon: ${op}`);
  }
}

// Tek mutant: seçilen noktaya mutasyon uygulanır; çıktı parse edilemezse null
export function mutate(code, siteIndex) {
  const ast = parse(code);
  const list = sites(ast);
  if (!list.length) return null;
  const site = list[siteIndex % list.length];
  const line = site.path.node.loc?.start.line ?? 0;
  const description = apply(site);
  const out = raw(ast);
  try { parse(out); } catch { return null; }
  return { code: out, op: site.op, line, description };
}

// Tohumlu rastgele, birbirinden farklı en fazla n mutant
export function mutants(code, n = 10, seed = 7, ops = OPERATORS) {
  let count;
  try { count = sites(parse(code)).length; } catch { return []; }
  const r = rng(seed);
  const seen = new Set([code]);
  const out = [];
  for (let tries = 0; out.length < n && tries < n * 6 && count; tries++) {
    const m = mutate(code, r.int(0, count - 1));
    if (!m || !ops.includes(m.op) || seen.has(m.code)) continue;
    seen.add(m.code);
    out.push(m);
  }
  return out;
}
