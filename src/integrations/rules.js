import * as t from '@babel/types';
import { parseExpression } from '@babel/parser';
import { traverse } from '../util/ast.js';

// H167: dönüşüm kuralı dili. Her satır bir kural:
//   [@ad] DESEN ==> YERİNE [when KOŞUL, KOŞUL...]
// DESEN ve YERİNE JavaScript ifadeleridir. `$x` herhangi bir ifadeyle eşleşen meta değişkendir; aynı ad
// iki kez geçerse iki yerin aynı olması gerekir. `$$x` bir listenin (çağrı argümanları, dizi elemanları)
// SON elemanı olarak kalan tüm elemanlarla eşleşir. Koşullar: string($x) number($x) literal($x)
// identifier($x) pure($x). `#` ile başlayan satırlar yorumdur.
// Örnekler:
//   @sıfır-topla $a + 0 ==> $a when number($a)
//   @call-undefined $f.call(undefined, $$args) ==> $f($$args)
//   @çift-değil !!$x ==> Boolean($x)
// Kurallar pipeline'da bir eklenti pass'i olarak çalışır: sonucu parse ve (derin modda) davranış testi doğrular.

const MAX_RULES = 500;
const MAX_ROUNDS = 10;
const MAX_REPLACEMENTS = 100_000;
const SKIP = new Set(['type', 'loc', 'start', 'end', 'extra', 'range', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'errors', 'tokens']);
const GUARDS = ['string', 'number', 'literal', 'identifier', 'pure'];

const isMeta = (n) => t.isIdentifier(n) && /^\$[A-Za-z_]\w*$/.test(n.name) && !n.name.startsWith('$$');
const isRest = (n) => t.isIdentifier(n) && /^\$\$[A-Za-z_]\w*$/.test(n.name);

export function parseRules(text) {
  if (typeof text !== 'string') throw new TypeError('Kural metni string olmalı');
  const rules = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    if (rules.length >= MAX_RULES) throw new Error(`En fazla ${MAX_RULES} kural`);
    const where = `satır ${i + 1}`;
    let body = s;
    let name = `kural-${i + 1}`;
    const nm = body.match(/^@([\wÀ-ɏ-]+)\s+/);
    if (nm) { name = nm[1]; body = body.slice(nm[0].length); }
    const sep = body.indexOf('==>');
    if (sep < 0) throw new Error(`${where}: "==>" yok`);
    const left = body.slice(0, sep).trim();
    let right = body.slice(sep + 3).trim();
    const guards = [];
    const w = right.lastIndexOf(' when ');
    if (w >= 0) {
      for (const g of right.slice(w + 6).split(',')) {
        const m = g.trim().match(/^(\w+)\(\s*(\$[A-Za-z_]\w*)\s*\)$/);
        if (!m || !GUARDS.includes(m[1])) throw new Error(`${where}: geçersiz koşul: ${g.trim()}`);
        guards.push({ kind: m[1], name: m[2] });
      }
      right = right.slice(0, w).trim();
    }
    let pattern;
    let replacement;
    try {
      pattern = parseExpression(left);
      replacement = parseExpression(right);
    } catch (e) {
      throw new Error(`${where}: ${e.message}`);
    }
    if (isMeta(pattern)) throw new Error(`${where}: desen yalnızca bir meta değişken olamaz`);
    const metas = new Set();
    collect(pattern, metas);
    const used = new Set();
    collect(replacement, used);
    for (const u of used) if (!metas.has(u)) throw new Error(`${where}: ${u} desende yok`);
    for (const g of guards) if (!metas.has(g.name)) throw new Error(`${where}: ${g.name} desende yok`);
    rules.push({ name, pattern, replacement, guards, line: i + 1 });
  });
  return rules;
}

function collect(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((x) => collect(x, out)); return; }
  if (isMeta(node) || isRest(node)) out.add(node.name);
  for (const k of Object.keys(node)) if (!SKIP.has(k)) collect(node[k], out);
}

function equal(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (a.type !== b.type) return false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (SKIP.has(k)) continue;
    if (!equal(a[k] ?? null, b[k] ?? null)) return false;
  }
  return true;
}

function match(p, n, binds) {
  if (Array.isArray(p)) {
    if (!Array.isArray(n)) return false;
    const restAt = p.length && isRest(p.at(-1)) ? p.length - 1 : -1;
    if (restAt < 0 ? p.length !== n.length : n.length < restAt) return false;
    const fixed = restAt < 0 ? p.length : restAt;
    for (let i = 0; i < fixed; i++) if (!match(p[i], n[i], binds)) return false;
    if (restAt >= 0) {
      const rest = n.slice(restAt);
      const prev = binds.get(p.at(-1).name);
      if (prev) return equal(prev, rest);
      binds.set(p.at(-1).name, rest);
    }
    return true;
  }
  if (p === null || typeof p !== 'object') return p === (n ?? null);
  if (isMeta(p)) {
    if (!n || typeof n !== 'object' || !n.type) return false;
    const prev = binds.get(p.name);
    if (prev) return equal(prev, n);
    binds.set(p.name, n);
    return true;
  }
  if (!n || typeof n !== 'object' || p.type !== n.type) return false;
  for (const k of Object.keys(p)) {
    if (SKIP.has(k)) continue;
    if (!match(p[k] ?? null, n[k] ?? null, binds)) return false;
  }
  return true;
}

function pure(n) {
  if (t.isLiteral(n) && !t.isTemplateLiteral(n)) return true;
  if (t.isIdentifier(n)) return true;
  if (t.isUnaryExpression(n)) return n.operator !== 'delete' && pure(n.argument);
  if (t.isBinaryExpression(n) || t.isLogicalExpression(n)) return pure(n.left) && pure(n.right);
  if (t.isConditionalExpression(n)) return pure(n.test) && pure(n.consequent) && pure(n.alternate);
  if (t.isArrayExpression(n)) return n.elements.every((e) => e && pure(e));
  if (t.isTemplateLiteral(n)) return n.expressions.every(pure);
  return false;
}

const GUARD_FN = {
  string: (n) => t.isStringLiteral(n),
  number: (n) => t.isNumericLiteral(n) || (t.isUnaryExpression(n, { operator: '-' }) && t.isNumericLiteral(n.argument)),
  literal: (n) => t.isLiteral(n) && !t.isTemplateLiteral(n),
  identifier: (n) => t.isIdentifier(n),
  pure,
};

function build(node, binds) {
  if (Array.isArray(node)) {
    const out = [];
    for (const x of node) {
      if (isRest(x)) out.push(...binds.get(x.name).map((y) => t.cloneNode(y, true, true)));
      else out.push(build(x, binds));
    }
    return out;
  }
  if (!node || typeof node !== 'object') return node;
  if (isMeta(node)) return t.cloneNode(binds.get(node.name), true, true);
  const out = {};
  for (const k of Object.keys(node)) {
    if (k !== 'type' && k !== 'extra' && SKIP.has(k)) continue;
    out[k] = typeof node[k] === 'object' ? build(node[k], binds) : node[k];
  }
  return out;
}

/**
 * Kuralları AST'ye uygular. @returns {{count: number, byRule: Record<string, number>}}
 */
export function applyRules(ast, rules) {
  const byRule = {};
  let count = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let changed = 0;
    traverse(ast, {
      Expression: {
        exit(path) {
          if (count >= MAX_REPLACEMENTS) return;
          for (const r of rules) {
            const binds = new Map();
            if (!match(r.pattern, path.node, binds)) continue;
            if (!r.guards.every((g) => GUARD_FN[g.kind](binds.get(g.name)))) continue;
            const next = build(r.replacement, binds);
            if (equal(next, path.node)) continue;
            path.replaceWith(next);
            byRule[r.name] = (byRule[r.name] ?? 0) + 1;
            count++;
            changed++;
            path.skip();
            return;
          }
        },
      },
    });
    if (!changed) break;
  }
  return { count, byRule };
}

/** Kural metnini pipeline eklentisine çevirir. */
export function rulesPlugin(text, { id = 'user-rules', after = 'simplify' } = {}) {
  const rules = parseRules(text);
  return {
    id,
    kind: 'ast',
    level: 1,
    after,
    run(ast, { bump, onLog }) {
      const r = applyRules(ast, rules);
      if (r.count) {
        bump('rules', r.count);
        onLog(`kurallar: ${Object.entries(r.byRule).map(([k, v]) => `${k}×${v}`).join(', ')}`, 'info');
      }
    },
  };
}
