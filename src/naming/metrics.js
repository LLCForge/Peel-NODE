import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { parse } from '../core/parse.js';

// 92 / E240: okunabilirlik ölçümleri ve 0–100 skoru; 93: fonksiyon başına karmaşıklık (ısı haritası verisi).

export const GENERATED = /^(_0x[0-9a-f]+|_?[a-z]\d*|[A-Za-z_$]{1,2}\d*|fn\d+|arg\d+|v\d+|c\d+|_?\$+[\w$]*)$/i;
const DECISIONS = new Set(['IfStatement', 'ConditionalExpression', 'ForStatement', 'ForInStatement', 'ForOfStatement',
  'WhileStatement', 'DoWhileStatement', 'CatchClause', 'SwitchCase']);

/** Fonksiyon başına döngüsel karmaşıklık (karar noktası + 1) ve iç içelik derinliği */
export function complexity(ast) {
  const fns = [];
  traverse(ast, {
    Function(p) {
      let c = 1;
      let maxNest = 0;
      p.traverse({
        Function(q) { q.skip(); },
        enter(q) {
          if (DECISIONS.has(q.node.type) && !(q.isSwitchCase() && !q.node.test)) c++;
          if (q.isLogicalExpression() && (q.node.operator === '&&' || q.node.operator === '||' || q.node.operator === '??')) c++;
          if (q.isBlockStatement()) {
            let d = 0;
            for (let x = q.parentPath; x && x.node !== p.node; x = x.parentPath) if (x.isBlockStatement()) d++;
            maxNest = Math.max(maxNest, d);
          }
        },
      });
      const name = p.node.id?.name ?? (t.isVariableDeclarator(p.parent) && t.isIdentifier(p.parent.id) ? p.parent.id.name
        : (t.isClassMethod(p.node) || t.isObjectMethod(p.node)) && t.isIdentifier(p.node.key) ? p.node.key.name : '(anonim)');
      fns.push({
        name,
        line: p.node.loc?.start.line ?? 0,
        endLine: p.node.loc?.end.line ?? 0,
        complexity: c,
        nesting: maxNest,
        statements: countStatements(p),
      });
    },
  });
  return fns;
}

function countStatements(p) {
  let n = 0;
  p.traverse({ Function(q) { q.skip(); }, Statement(q) { if (!q.isBlockStatement()) n++; } });
  return n;
}

/** Tek kod için ölçümler ve skor */
export function readability(code) {
  let ast;
  try { ast = parse(code); } catch { return null; }
  const lines = code.split('\n');
  const nonEmpty = lines.filter((l) => l.trim());
  const ids = new Map();
  let hexLiterals = 0;
  let maxNesting = 0;
  let comments = (ast.comments ?? []).length;
  let stringEscapes = 0;
  traverse(ast, {
    Identifier(p) {
      if (p.parentPath.isMemberExpression({ property: p.node }) && !p.parent.computed) return;
      if (p.parentPath.isObjectProperty({ key: p.node })) return;
      ids.set(p.node.name, (ids.get(p.node.name) ?? 0) + 1);
    },
    NumericLiteral(p) { if (/^0x/i.test(p.node.extra?.raw ?? '')) hexLiterals++; },
    StringLiteral(p) { if (/\\x[0-9a-f]{2}|\\u[0-9a-f]{4}/i.test(p.node.extra?.raw ?? '')) stringEscapes++; },
    BlockStatement(p) {
      let d = 0;
      for (let x = p.parentPath; x; x = x.parentPath) if (x.isBlockStatement()) d++;
      maxNesting = Math.max(maxNesting, d);
    },
  });
  const names = [...ids.keys()];
  const meaningful = names.filter((n) => !GENERATED.test(n) && n.length >= 3).length;
  const fns = complexity(ast);
  const avgComplexity = fns.length ? fns.reduce((a, f) => a + f.complexity, 0) / fns.length : 1;
  const maxComplexity = fns.reduce((a, f) => Math.max(a, f.complexity), 1);
  const avgLine = nonEmpty.length ? nonEmpty.reduce((a, l) => a + l.length, 0) / nonEmpty.length : 0;
  const longLines = nonEmpty.filter((l) => l.length > 120).length;
  const avgIdLen = names.length ? names.reduce((a, n) => a + n.length, 0) / names.length : 0;
  const m = {
    lines: lines.length,
    avgLineLength: round(avgLine),
    longLines,
    identifiers: names.length,
    meaningfulNames: names.length ? round(meaningful / names.length) : 1,
    avgIdentifierLength: round(avgIdLen),
    hexLiterals,
    stringEscapes,
    maxNesting,
    functions: fns.length,
    avgComplexity: round(avgComplexity),
    maxComplexity,
    commentDensity: nonEmpty.length ? round(comments / nonEmpty.length) : 0,
  };
  m.score = score(m);
  return m;
}

const round = (x) => Math.round(x * 100) / 100;
const clamp = (x) => Math.max(0, Math.min(1, x));

// Ağırlıklı skor: anlamlı isim oranı en önemli; satır uzunluğu, karmaşıklık, iç içelik ve gizleme izleri cezalandırılır
function score(m) {
  const names = m.meaningfulNames;
  const lineLen = 1 - clamp((m.avgLineLength - 60) / 140);
  const longLines = 1 - clamp(m.longLines / Math.max(1, m.lines) * 5);
  const cx = 1 - clamp((m.avgComplexity - 4) / 16);
  const nest = 1 - clamp((m.maxNesting - 4) / 8);
  const obf = 1 - clamp((m.hexLiterals + m.stringEscapes) / Math.max(10, m.identifiers));
  const s = names * 40 + lineLen * 15 + longLines * 10 + cx * 15 + nest * 10 + obf * 10;
  return Math.round(s);
}

/** Önce/sonra karşılaştırması */
export function compareReadability(before, after) {
  const a = readability(before);
  const b = readability(after);
  return { before: a, after: b, delta: a && b ? b.score - a.score : null };
}
