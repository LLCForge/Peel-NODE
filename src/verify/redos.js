import * as t from '@babel/types';
import { parse } from '../core/parse.js';
import { traverse } from '../util/ast.js';

// I182: statik ReDoS dedektörü — çalıştırmadan önce felaket geri izlemeye açık kalıpları bildirir.
// Kurallar (geri izlemeli motorlarda üstel/polinom patlama): iç içe niceleyici ((a+)+, (.*)*, (\w+\s?)*),
// niceleyicili grupta örtüşen seçenekler ((a|a)*, (a|ab)+, (\d|\w)+) ve ardışık örtüşen sınırsız niceleyiciler (.*.*x).

const UNBOUNDED = /^(\*|\+|\{\d+,\})/;

// Kalıbı gruplara ayırır: { body, quant, start } — kaçış ve karakter sınıfları dikkate alınır
function groups(src) {
  const out = [];
  const stack = [];
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '(') stack.push(i);
    else if (c === ')' && stack.length) {
      const s = stack.pop();
      const rest = src.slice(i + 1);
      const q = UNBOUNDED.exec(rest)?.[0] ?? null;
      let body = src.slice(s + 1, i).replace(/^\?(?::|=|!|<=|<!|<[A-Za-z_]\w*>)/, '');
      out.push({ body, quant: q, start: s });
    }
  }
  return out;
}

// gövdede (kaçışlar/sınıflar sayılarak) sınırsız niceleyici var mı
function hasInnerUnbounded(body) {
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '*' || c === '+') return true;
    if (c === '{' && /^\{\d+,\}/.test(body.slice(i))) return true;
  }
  return false;
}

function topAlternatives(body) {
  const alts = [];
  let depth = 0;
  let inClass = false;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') { cur += c + (body[i + 1] ?? ''); i++; continue; }
    if (inClass) { if (c === ']') inClass = false; cur += c; continue; }
    if (c === '[') inClass = true;
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === '|' && depth === 0) { alts.push(cur); cur = ''; continue; }
    cur += c;
  }
  alts.push(cur);
  return alts;
}

// seçeneğin ilk karakter kümesi (yaklaşık): '.' ve geniş sınıflar her şeyle örtüşür
function firstSet(a) {
  if (!a) return 'ε';
  if (a[0] === '.') return 'ANY';
  if (a.startsWith('\\w') || a.startsWith('\\S') || a.startsWith('\\W') || a.startsWith('[^')) return 'ANY';
  if (a.startsWith('\\d')) return 'DIGIT';
  if (a.startsWith('\\s')) return 'SPACE';
  if (a[0] === '\\') return a.slice(0, 2);
  if (a[0] === '[') return 'CLASS';
  return a[0];
}

const overlap = (x, y) => x === y || x === 'ANY' || y === 'ANY' || x === 'CLASS' || y === 'CLASS' ||
  (x === 'DIGIT' && /^\d$/.test(y)) || (y === 'DIGIT' && /^\d$/.test(x));

export function analyzePattern(pattern) {
  const reasons = [];
  for (const g of groups(pattern)) {
    if (!g.quant) continue;
    if (hasInnerUnbounded(g.body)) reasons.push(`iç içe niceleyici: (${g.body})${g.quant}`);
    const alts = topAlternatives(g.body);
    if (alts.length > 1) {
      const sets = alts.map(firstSet);
      for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
        if (overlap(sets[i], sets[j])) { reasons.push(`örtüşen seçenekler niceleyicili grupta: (${g.body})${g.quant}`); i = sets.length; break; }
      }
    }
  }
  // ardışık sınırsız ve örtüşen öğeler: .*.*, \w+\w+, \d+\d* …
  if (/(\.\*|\.\+|\\[wdsS][*+])\s*(\.\*|\.\+|\\[wdsS][*+])/.test(pattern.replace(/\[[^\]]*\]/g, 'C'))) reasons.push('ardışık örtüşen sınırsız niceleyiciler');
  return [...new Set(reasons)];
}

// Koddaki regex literal'leri ve RegExp("…") çağrıları
export function findRedos(code) {
  let ast;
  try { ast = parse(code); } catch { return []; }
  const out = [];
  const check = (pattern, flags, node, source) => {
    const reasons = analyzePattern(pattern);
    if (reasons.length && out.length < 100) out.push({ pattern: pattern.slice(0, 200), flags, line: node.loc?.start.line ?? 0, source, reasons });
  };
  traverse(ast, {
    RegExpLiteral(p) { check(p.node.pattern, p.node.flags, p.node, 'literal'); },
    'CallExpression|NewExpression'(p) {
      const c = p.node;
      if (!t.isIdentifier(c.callee, { name: 'RegExp' }) || !t.isStringLiteral(c.arguments[0])) return;
      check(c.arguments[0].value, t.isStringLiteral(c.arguments[1]) ? c.arguments[1].value : '', c, 'RegExp');
    },
  });
  return out;
}
