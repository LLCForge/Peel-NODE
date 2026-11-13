import * as t from '@babel/types';
import { parse } from '../core/parse.js';
import { traverse, gen } from '../util/ast.js';

// Editör zekâsı: bağlama çözümleme, yeniden adlandırma, sembol listesi, AST sorgusu ve arama mercekleri.
// Hepsi saf fonksiyon: Babel AST'si alır, {start, end} konumları döner. Arayüz bunları editöre işler.

const MAX_RESULTS = 20_000;

export function parseSafe(code) {
  try {
    return { ast: parse(code), error: null };
  } catch (e) {
    return { ast: null, error: e.message };
  }
}

const span = (n) => ({ start: n.start, end: n.end });
export const lineOf = (code, offset) => {
  let line = 1;
  for (let i = code.indexOf('\n'); i !== -1 && i < offset; i = code.indexOf('\n', i + 1)) line++;
  return line;
};

/** Konumu içeren düğüm zinciri (kökten yaprağa): [{node, key, index}] */
export function nodePath(ast, offset) {
  const chain = [{ node: ast.program, key: 'program', index: null }];
  for (;;) {
    const cur = chain[chain.length - 1].node;
    let next = null;
    for (const key of t.VISITOR_KEYS[cur.type] ?? []) {
      const v = cur[key];
      const list = Array.isArray(v) ? v : [v];
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c && typeof c.type === 'string' && c.start <= offset && offset <= c.end && c.end > c.start) {
          next = { node: c, key, index: Array.isArray(v) ? i : null };
          break;
        }
      }
      if (next) break;
    }
    if (!next) return chain;
    chain.push(next);
  }
}

/** "body.0.expression.callee" gibi bir yolu çözer; bulunamazsa null */
export function resolveNodePath(ast, path) {
  let cur = ast.program;
  for (const part of String(path).split(/[.[\]]+/).filter(Boolean)) {
    if (part === 'program' && cur === ast.program) continue;
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[/^\d+$/.test(part) ? Number(part) : part];
  }
  return cur && typeof cur.type === 'string' ? cur : null;
}

export const pathString = (chain) => chain.slice(1).map((c) => (c.index == null ? c.key : `${c.key}.${c.index}`)).join('.');

// Konumdaki tanımlayıcının traverse yolunu bulur; dışında kalan alt ağaçlar atlanır
function identifierPathAt(ast, offset) {
  let found = null;
  traverse(ast, {
    noScope: false,
    enter(p) {
      const n = p.node;
      if (n.start != null && (offset < n.start || offset > n.end)) { p.skip(); return; }
      if (p.isIdentifier() || p.isPrivateName()) found = p;
    },
  });
  return found;
}

function isPropertyName(p) {
  const parent = p.parent;
  if ((t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) && parent.property === p.node && !parent.computed) return true;
  if ((t.isObjectProperty(parent) || t.isObjectMethod(parent) || t.isClassMethod(parent) || t.isClassProperty(parent)) && parent.key === p.node && !parent.computed && !parent.shorthand) return true;
  return false;
}

function bindingIds(binding) {
  const name = binding.identifier.name;
  const ids = [binding.identifier];
  for (const r of binding.referencePaths) if (r.node.type === 'Identifier') ids.push(r.node);
  for (const cv of binding.constantViolations) {
    const found = cv.isUpdateExpression() ? [cv.node.argument] : Object.values(cv.getBindingIdentifiers()).flat();
    for (const n of found) if (n?.type === 'Identifier' && n.name === name) ids.push(n);
  }
  const seen = new Set();
  return ids.filter((n) => n.start != null && !seen.has(n.start) && seen.add(n.start)).sort((a, b) => a.start - b.start);
}

/**
 * Konumdaki sembol: bağlı değişken, global ya da özellik adı.
 * { kind: 'binding'|'global'|'property', name, def: {start,end}|null, refs: [{start,end}], scopeKind }
 */
export function symbolAt(ast, offset) {
  const p = identifierPathAt(ast, offset);
  if (!p) return null;
  const name = p.node.type === 'PrivateName' ? p.node.id.name : p.node.name;
  if (p.isPrivateName() || isPropertyName(p)) {
    const refs = [];
    const defs = [];
    traverse(ast, {
      MemberExpression(q) { const pr = q.node.property; if (!q.node.computed && pr.name === name) refs.push(span(pr)); else if (q.node.computed && t.isStringLiteral(pr) && pr.value === name) refs.push(span(pr)); },
      OptionalMemberExpression(q) { const pr = q.node.property; if (!q.node.computed && pr.name === name) refs.push(span(pr)); },
      'ObjectProperty|ObjectMethod|ClassMethod|ClassProperty'(q) {
        const k = q.node.key;
        if (!q.node.computed && (k.name === name || k.value === name)) { refs.push(span(k)); defs.push(span(k)); }
      },
      AssignmentExpression(q) {
        const l = q.node.left;
        if (t.isMemberExpression(l) && !l.computed && l.property.name === name) defs.push(span(l.property));
      },
      PrivateName(q) { if (q.node.id.name === name) refs.push(span(q.node)); },
    });
    const uniq = new Map(refs.map((r) => [r.start, r]));
    return { kind: 'property', name, def: defs[0] ?? null, defs, refs: [...uniq.values()].sort((a, b) => a.start - b.start) };
  }
  const binding = p.scope.getBinding(name);
  if (binding) {
    return { kind: 'binding', name, def: span(binding.identifier), defs: [span(binding.identifier)], refs: bindingIds(binding).map(span), scopeKind: binding.kind };
  }
  const refs = [];
  traverse(ast, {
    Identifier(q) { if (q.node.name === name && !isPropertyName(q) && !q.scope.getBinding(name)) refs.push(span(q.node)); },
  });
  return { kind: 'global', name, def: null, defs: [], refs };
}

/**
 * Yeniden adlandırma düzenlemeleri: [{from, to, insert}]. Kısayol özellik (`{a}`), import/export
 * belirteçleri biçimi korunarak açılır. Çakışma ya da geçersiz ad → { error }.
 */
export function renameEdits(ast, offset, newName) {
  if (!t.isValidIdentifier(newName)) return { error: 'invalid' };
  const p = identifierPathAt(ast, offset);
  if (!p || p.isPrivateName() || isPropertyName(p)) return { error: 'notBinding' };
  const binding = p.scope.getBinding(p.node.name);
  if (!binding) return { error: 'notBinding' };
  const oldName = binding.identifier.name;
  if (newName === oldName) return { edits: [] };
  const clash = (scope) => {
    const b = scope.getBinding(newName);
    return b && b !== binding;
  };
  if (binding.scope.hasOwnBinding(newName) || binding.referencePaths.some((r) => clash(r.scope)) || binding.constantViolations.some((c) => clash(c.scope))) {
    return { error: 'conflict' };
  }
  // bağlamın kapsamında aynı adla serbest (global) bir referans varsa yeni ad onu gölgeler
  let shadowsGlobal = false;
  binding.scope.path.traverse({
    Identifier(q) { if (q.node.name === newName && !isPropertyName(q) && !q.scope.getBinding(newName)) { shadowsGlobal = true; q.stop(); } },
  });
  if (shadowsGlobal) return { error: 'conflict' };

  const ids = new Set(bindingIds(binding));
  const edits = [];
  traverse(ast, {
    Identifier(q) {
      if (!ids.has(q.node)) return;
      const parent = q.parent;
      let insert = newName;
      if (t.isObjectProperty(parent) && parent.shorthand && parent.key.start === q.node.start) insert = `${oldName}: ${newName}`;
      else if (t.isAssignmentPattern(parent) && t.isObjectProperty(q.parentPath.parent) && q.parentPath.parent.shorthand) insert = `${oldName}: ${newName}`;
      else if (t.isImportSpecifier(parent) && parent.imported.start === parent.local.start) insert = `${oldName} as ${newName}`;
      else if (t.isExportSpecifier(parent) && parent.local.start === parent.exported.start) insert = `${newName} as ${oldName}`;
      edits.push({ from: q.node.start, to: q.node.end, insert });
    },
  });
  const byFrom = new Map(edits.map((e) => [e.from, e]));
  return { edits: [...byFrom.values()].sort((a, b) => a.from - b.from) };
}

function fnName(p) {
  const n = p.node;
  if (n.id?.name) return n.id.name;
  const parent = p.parent;
  if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) return parent.id.name;
  if (t.isAssignmentExpression(parent)) return gen(parent.left).slice(0, 60);
  if ((t.isObjectProperty(parent) || t.isClassProperty(parent)) && !parent.computed) return parent.key.name ?? String(parent.key.value);
  if ((t.isObjectMethod(n) || t.isClassMethod(n)) && !n.computed) return n.key.name ?? String(n.key.value);
  return null;
}

/** Fonksiyon düğümü için okunur ad (anonimse satır bilgisiyle) */
export function functionLabel(p, code) {
  return fnName(p) ?? `ƒ@${code ? lineOf(code, p.node.start) : p.node.start}`;
}

/** Sembol listesi: fonksiyon, sınıf, değişken ve metot tanımları */
export function symbols(ast) {
  const out = [];
  const depthOf = (p) => { let d = 0; for (let q = p.parentPath; q; q = q.parentPath) if (q.isFunction() || q.isClass()) d++; return d; };
  const push = (name, kind, node, p) => { if (out.length < MAX_RESULTS) out.push({ name, kind, start: node.start, end: node.end, depth: depthOf(p) }); };
  traverse(ast, {
    FunctionDeclaration(p) { if (p.node.id) push(p.node.id.name, 'function', p.node.id, p); },
    ClassDeclaration(p) { if (p.node.id) push(p.node.id.name, 'class', p.node.id, p); },
    VariableDeclarator(p) {
      if (!t.isIdentifier(p.node.id)) return;
      const init = p.node.init;
      const kind = t.isFunction(init) ? 'function' : t.isClass(init) ? 'class' : p.parent.kind;
      push(p.node.id.name, kind, p.node.id, p);
    },
    'ObjectMethod|ClassMethod'(p) { if (!p.node.computed) push(p.node.key.name ?? String(p.node.key.value), 'method', p.node.key, p); },
    ObjectProperty(p) { if (!p.node.computed && t.isFunction(p.node.value)) push(p.node.key.name ?? String(p.node.key.value), 'method', p.node.key, p); },
    AssignmentExpression(p) { if (t.isMemberExpression(p.node.left) && t.isFunction(p.node.right)) push(gen(p.node.left).slice(0, 80), 'method', p.node.left, p); },
  });
  return out.sort((a, b) => a.start - b.start);
}

// ── AST sorgusu: `CallExpression[callee.name=eval]`, `FunctionDeclaration > ReturnStatement`,
//    `StringLiteral[value~=/^https?:/i]`, `[arguments.length>=3]` ──

export function parseSelector(src) {
  const s = String(src).trim();
  let i = 0;
  const err = (m) => { throw new Error(`${m} @${i}`); };
  const ws = () => { while (/\s/.test(s[i] ?? '')) i++; };
  const ident = () => { const m = /^[A-Za-z_$*][\w$]*/.exec(s.slice(i)); if (!m) err('ad bekleniyor'); i += m[0].length; return m[0]; };
  const value = () => {
    ws();
    const c = s[i];
    if (c === '"' || c === "'") {
      let out = '';
      i++;
      while (i < s.length && s[i] !== c) { if (s[i] === '\\') i++; out += s[i++]; }
      if (s[i] !== c) err('kapanmamış string');
      i++;
      return out;
    }
    if (c === '/') {
      let j = i + 1;
      let body = '';
      while (j < s.length && s[j] !== '/') { if (s[j] === '\\') body += s[j++]; body += s[j++]; }
      if (s[j] !== '/') err('kapanmamış regex');
      j++;
      const flags = /^[gimsuy]*/.exec(s.slice(j))[0];
      i = j + flags.length;
      return new RegExp(body, flags.replace('g', ''));
    }
    const m = /^[^\]\s]+/.exec(s.slice(i));
    if (!m) err('değer bekleniyor');
    i += m[0].length;
    const v = m[0];
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null') return null;
    if (/^-?(0x[\da-f]+|\d+(\.\d+)?(e[+-]?\d+)?)$/i.test(v)) return Number(v);
    return v;
  };
  const compound = () => {
    const c = { type: null, attrs: [] };
    if (/[A-Za-z_$*]/.test(s[i] ?? '')) c.type = ident();
    while (s[i] === '[') {
      i++;
      ws();
      const path = [];
      do { path.push(ident()); } while (s[i] === '.' && ++i);
      ws();
      const m = /^(!=|~=|\^=|\$=|\*=|>=|<=|=|>|<)/.exec(s.slice(i));
      let op = null;
      let v;
      if (m) { op = m[1]; i += op.length; v = value(); ws(); }
      if (s[i] !== ']') err('] bekleniyor');
      i++;
      c.attrs.push({ path, op, value: v });
    }
    if (!c.type && !c.attrs.length) err('seçici bekleniyor');
    return c;
  };
  const steps = [{ comb: null, ...compound() }];
  for (;;) {
    const before = i;
    ws();
    if (i >= s.length) break;
    let comb = ' ';
    if (s[i] === '>') { comb = '>'; i++; ws(); } else if (i === before) err('beklenmeyen karakter');
    steps.push({ comb, ...compound() });
  }
  return steps;
}

function attrMatch(node, { path, op, value }) {
  let v = node;
  for (const k of path) { if (v == null) return false; v = v[k]; }
  if (!op) return v !== undefined && v !== null && v !== false;
  if (op === '~=') return value instanceof RegExp ? value.test(String(v ?? '')) : String(v ?? '').includes(String(value));
  if (op === '^=') return String(v ?? '').startsWith(String(value));
  if (op === '$=') return String(v ?? '').endsWith(String(value));
  if (op === '*=') return String(v ?? '').includes(String(value));
  if (op === '=' || op === '!=') {
    const eq = typeof value === 'number' ? Number(v) === value : value === null || typeof value === 'boolean' ? v === value : String(v) === String(value);
    return op === '=' ? eq : !eq;
  }
  const n = Number(v);
  if (Number.isNaN(n)) return false;
  return op === '>' ? n > value : op === '<' ? n < value : op === '>=' ? n >= value : n <= value;
}

const compoundMatch = (node, c) => (!c.type || c.type === '*' || node.type === c.type || t.is(c.type, node)) && c.attrs.every((a) => attrMatch(node, a));

function chainMatch(steps, k, ancestors, upto) {
  // steps[k] ile eşleşen bir ata bul (k'nın birleştiricisine göre), sonra öncekilere devam et
  const comb = steps[k + 1].comb;
  for (let a = upto - 1; a >= 0; a--) {
    if (compoundMatch(ancestors[a], steps[k]) && (k === 0 || chainMatch(steps, k - 1, ancestors, a))) return true;
    if (comb === '>') return false;
  }
  return false;
}

/** Seçiciyle eşleşen düğümler: [{start, end, type}] */
export function queryAst(ast, selector) {
  const steps = typeof selector === 'string' ? parseSelector(selector) : selector;
  const out = [];
  const last = steps[steps.length - 1];
  const ancestors = [];
  const walk = (node) => {
    if (out.length >= MAX_RESULTS) return;
    if (compoundMatch(node, last) && (steps.length === 1 || chainMatch(steps, steps.length - 2, ancestors, ancestors.length))) {
      out.push({ start: node.start, end: node.end, type: node.type });
    }
    ancestors.push(node);
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[key];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c); } else if (v && typeof v.type === 'string') walk(v);
    }
    ancestors.pop();
  };
  walk(ast.program);
  return out;
}

// ── arama ──

function rangesOf(ast, kind) {
  const r = [];
  if (kind === 'comments') {
    for (const c of ast.comments ?? []) r.push([c.start, c.end]);
    return r;
  }
  const visitor = kind === 'strings'
    ? { 'StringLiteral|TemplateLiteral|DirectiveLiteral'(p) { r.push([p.node.start, p.node.end]); p.skip(); } }
    : { 'CallExpression|NewExpression|OptionalCallExpression'(p) { r.push([p.node.start, p.node.end]); p.skip(); } };
  traverse(ast, visitor);
  return r;
}

/**
 * Metin/regex arama; scope 'strings' | 'calls' | 'comments' ise yalnızca o düğümlerin içinde.
 * Sonuç: [{start, end, text}]; geçersiz regex → hata fırlatır.
 */
export function textSearch(code, query, { regex = false, caseSensitive = false, wholeWord = false, scope = 'all', ast = null } = {}) {
  if (!query) return [];
  let src = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) src = `(?<![\\w$])(?:${src})(?![\\w$])`;
  const re = new RegExp(src, `g${caseSensitive ? '' : 'i'}mu`);
  const ranges = scope !== 'all' && ast ? rangesOf(ast, scope).sort((x, y) => x[0] - y[0]) : null;
  const out = [];
  let k = 0;
  let m;
  while ((m = re.exec(code)) && out.length < MAX_RESULTS) {
    if (m[0] === '') { re.lastIndex++; continue; }
    const start = m.index;
    const end = start + m[0].length;
    if (ranges) {
      while (k < ranges.length && ranges[k][1] < end) k++;
      if (k >= ranges.length) break;
      if (start < ranges[k][0]) { re.lastIndex = Math.max(start + 1, ranges[k][0]); continue; }
    }
    out.push({ start, end, text: m[0] });
  }
  return out;
}

// ── mercekler ──

export function entropy(s) {
  if (!s) return 0;
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  const n = [...s].length;
  let h = 0;
  for (const c of freq.values()) { const p = c / n; h -= p * Math.log2(p); }
  return h;
}

/** String tablosu: değere göre gruplu, kullanım sayısı ve entropiyle */
export function stringTable(ast) {
  const map = new Map();
  const add = (value, node) => {
    let e = map.get(value);
    if (!e) { e = { value, count: 0, occurrences: [], entropy: entropy(value) }; map.set(value, e); }
    e.count++;
    if (e.occurrences.length < 500) e.occurrences.push(span(node));
  };
  traverse(ast, {
    StringLiteral(p) { add(p.node.value, p.node); },
    TemplateElement(p) { if (p.node.value.cooked) add(p.node.value.cooked, p.node); },
  });
  return [...map.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export function highEntropy(ast, { min = 4.2, minLen = 16 } = {}) {
  return stringTable(ast).filter((s) => s.value.length >= minLen && s.entropy >= min)
    .sort((a, b) => b.entropy - a.entropy)
    .flatMap((s) => s.occurrences.map((o) => ({ ...o, text: s.value.slice(0, 120), note: `H=${s.entropy.toFixed(2)}` })));
}

/** Çözülmemiş kalıntılar: _0x adları, hex argümanlı decoder çağrıları, eval/Function, fromCharCode */
export function remnants(ast) {
  const out = [];
  traverse(ast, {
    Identifier(p) { if (/^_0x[0-9a-f]+$/i.test(p.node.name)) out.push({ ...span(p.node), text: p.node.name, note: '_0x' }); },
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      if (t.isIdentifier(callee) && args.length && args.every((a) => t.isNumericLiteral(a) && /^0x/i.test(a.extra?.raw ?? ''))) {
        out.push({ ...span(p.node), text: gen(p.node).slice(0, 80), note: 'decoder' });
      } else if (t.isIdentifier(callee, { name: 'eval' }) || t.isIdentifier(callee, { name: 'Function' })) {
        out.push({ ...span(p.node), text: gen(p.node).slice(0, 80), note: callee.name });
      } else if (t.isMemberExpression(callee) && t.isIdentifier(callee.property, { name: 'fromCharCode' })) {
        out.push({ ...span(p.node), text: gen(p.node).slice(0, 80), note: 'fromCharCode' });
      }
    },
    NewExpression(p) { if (t.isIdentifier(p.node.callee, { name: 'Function' })) out.push({ ...span(p.node), text: gen(p.node).slice(0, 80), note: 'Function' }); },
  });
  return out.sort((a, b) => a.start - b.start).slice(0, MAX_RESULTS);
}

// Yapısal özet: tanımlayıcı adları yok sayılır, tür/operatör/literal değerleri korunur
function structural(ast, visit) {
  const walk = (node) => {
    let h = node.type;
    let size = 1;
    if (node.operator) h += node.operator;
    if (t.isLiteral(node) && 'value' in node) h += `:${String(node.value).slice(0, 40)}`;
    const parts = [];
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[key];
      const list = Array.isArray(v) ? v : [v];
      for (const c of list) {
        if (c && typeof c.type === 'string') {
          const r = walk(c);
          parts.push(r.h);
          size += r.size;
        } else if (Array.isArray(v)) parts.push('_');
      }
    }
    const res = { h: `${h}(${parts.join(',')})`, size };
    if (res.h.length > 2000) res.h = String(fnvHash(res.h)); // çok büyük alt ağaçta anahtar uzunluğunu sınırla
    visit(node, res);
    return res;
  };
  walk(ast.program);
}

function fnvHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `#${(h >>> 0).toString(16)}:${s.length}`;
}

/** Tekrar eden kod: yapısal olarak aynı fonksiyon/blok grupları */
export function duplicates(ast, { minSize = 25 } = {}) {
  const groups = new Map();
  structural(ast, (node, { h, size }) => {
    if (size < minSize) return;
    if (!(t.isFunction(node) || t.isBlockStatement(node) || t.isStatement(node))) return;
    let g = groups.get(h);
    if (!g) { g = { size, members: [] }; groups.set(h, g); }
    g.members.push(span(node));
  });
  const list = [...groups.values()].filter((g) => g.members.length > 1).sort((a, b) => b.size - a.size);
  const covered = [];
  const out = [];
  for (const g of list) {
    const inside = g.members.every((m) => covered.some((c) => c.start <= m.start && m.end <= c.end));
    if (inside) continue;
    covered.push(...g.members);
    out.push(g);
  }
  return out;
}

function fnFeatures(fnNode) {
  const f = new Map();
  const walk = (node, parentType) => {
    const k = `${parentType}>${node.type}${node.operator ?? ''}`;
    f.set(k, (f.get(k) ?? 0) + 1);
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[key];
      for (const c of Array.isArray(v) ? v : [v]) if (c && typeof c.type === 'string') walk(c, node.type);
    }
  };
  walk(fnNode, '');
  return f;
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) { na += v * v; const w = b.get(k); if (w) dot += v * w; }
  for (const v of b.values()) nb += v * v;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Benzer fonksiyonlar: konumdaki fonksiyona (yoksa tüm çiftler arasında) yapı benzerliği */
export function similarFunctions(ast, code, offset = null, { min = 0.85, max = 200 } = {}) {
  const fns = [];
  traverse(ast, { Function(p) { if (fns.length < 1500 && p.node.end - p.node.start > 30) fns.push({ node: p.node, name: functionLabel(p, code) }); } });
  const feats = fns.map((f) => fnFeatures(f.node));
  let target = -1;
  if (offset != null) {
    for (let i = 0; i < fns.length; i++) {
      const n = fns[i].node;
      if (n.start <= offset && offset <= n.end && (target < 0 || n.start >= fns[target].node.start)) target = i;
    }
  }
  const out = [];
  if (target >= 0) {
    for (let i = 0; i < fns.length; i++) {
      if (i === target) continue;
      const s = cosine(feats[target], feats[i]);
      if (s >= min) out.push({ ...span(fns[i].node), text: fns[i].name, note: `${Math.round(s * 100)}% ~ ${fns[target].name}`, score: s });
    }
  } else {
    const lim = Math.min(fns.length, 400);
    for (let i = 0; i < lim; i++) {
      for (let j = i + 1; j < lim; j++) {
        const s = cosine(feats[i], feats[j]);
        if (s >= min) out.push({ ...span(fns[j].node), text: fns[j].name, note: `${Math.round(s * 100)}% ~ ${fns[i].name}`, score: s, pair: span(fns[i].node) });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}

// Standart ve yaygın ortam global'leri: tanımsız referans merceği bunları atlar
export const KNOWN_GLOBALS = new Set(`globalThis window self document navigator location history screen console
Object Function Array Number parseFloat parseInt Infinity NaN undefined Boolean String Symbol Date Promise RegExp Error
AggregateError EvalError RangeError ReferenceError SyntaxError TypeError URIError JSON Math Intl ArrayBuffer SharedArrayBuffer
Atomics Uint8Array Int8Array Uint16Array Int16Array Uint32Array Int32Array Float32Array Float64Array Uint8ClampedArray
BigUint64Array BigInt64Array DataView Map BigInt Set WeakMap WeakSet WeakRef FinalizationRegistry Proxy Reflect
decodeURI decodeURIComponent encodeURI encodeURIComponent escape unescape eval isFinite isNaN arguments require module exports
process Buffer setTimeout clearTimeout setInterval clearInterval setImmediate clearImmediate queueMicrotask structuredClone
requestAnimationFrame cancelAnimationFrame requestIdleCallback cancelIdleCallback fetch XMLHttpRequest WebSocket EventSource
Worker SharedWorker importScripts postMessage addEventListener removeEventListener dispatchEvent Event CustomEvent EventTarget
Blob File FileReader FormData Headers Request Response URL URLSearchParams TextEncoder TextDecoder atob btoa crypto Crypto
performance localStorage sessionStorage indexedDB caches alert confirm prompt open close top parent frames opener name
HTMLElement Element Node NodeList Image Audio MutationObserver IntersectionObserver ResizeObserver AbortController AbortSignal
CSS getComputedStyle matchMedia innerWidth innerHeight outerWidth outerHeight devicePixelRatio scrollX scrollY scrollTo
customElements ShadowRoot DOMParser XMLSerializer Notification ServiceWorker BroadcastChannel MessageChannel MessagePort
RTCPeerConnection AudioContext OfflineAudioContext WebAssembly Intl __dirname __filename define exports global chrome
`.split(/\s+/).filter(Boolean));

/** Tanımsız referanslar: bağlanmamış ve bilinen global olmayan adlar */
export function undefinedRefs(ast) {
  const out = [];
  traverse(ast, {
    Identifier(p) {
      if (out.length >= MAX_RESULTS) return;
      const n = p.node.name;
      if (KNOWN_GLOBALS.has(n) || isPropertyName(p) || !p.isReferencedIdentifier() || p.scope.getBinding(n)) return;
      if (t.isLabeledStatement(p.parent) || t.isBreakStatement(p.parent) || t.isContinueStatement(p.parent)) return;
      const guarded = t.isUnaryExpression(p.parent, { operator: 'typeof' });
      out.push({ ...span(p.node), text: n, note: guarded ? 'typeof' : '' });
    },
  });
  return out;
}

/** Kullanılmayan tanımlar (parametreler hariç) */
export function unusedBindings(ast) {
  const out = [];
  const seen = new Set();
  traverse(ast, {
    Scopable(p) {
      for (const b of Object.values(p.scope.bindings)) {
        if (seen.has(b) || b.referenced || b.kind === 'param') continue;
        seen.add(b);
        if (b.path.parentPath?.isExportNamedDeclaration?.() || b.path.parentPath?.parentPath?.isExportNamedDeclaration?.()) continue;
        out.push({ ...span(b.identifier), text: b.identifier.name, note: b.kind + (b.scope.path.isProgram() ? ' · global' : '') });
      }
    },
  });
  return out.sort((a, b) => a.start - b.start).slice(0, MAX_RESULTS);
}

export function longLines(code, max = 160) {
  const out = [];
  let start = 0;
  let line = 1;
  while (start <= code.length && out.length < MAX_RESULTS) {
    let end = code.indexOf('\n', start);
    if (end === -1) end = code.length;
    if (end - start > max) out.push({ start, end, text: code.slice(start, start + 100), note: `${end - start}`, line });
    start = end + 1;
    line++;
  }
  return out;
}

const NESTING = new Set(['IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement',
  'SwitchStatement', 'TryStatement', 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'WithStatement']);

/** Derin iç içelik: derinliği max'ı aşan en dış düğümler */
export function deepNesting(ast, max = 5) {
  const out = [];
  const walk = (node, depth, reported) => {
    let d = depth;
    let rep = reported;
    if (NESTING.has(node.type)) {
      d++;
      if (d > max && !rep && out.length < MAX_RESULTS) {
        out.push({ ...span(node), text: node.type, note: `${d}` });
        rep = true;
      }
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[key];
      for (const c of Array.isArray(v) ? v : [v]) if (c && typeof c.type === 'string') walk(c, d, rep);
    }
  };
  walk(ast.program, 0, false);
  return out;
}

const PLAIN_NUMBERS = new Set([0, 1, 2, -1, 10, 100, 1000, 0.5]);

/** Sihirli sayılar: adlandırılmış sabit olmayan, sıradan olmayan sayısal literaller */
export function magicNumbers(ast) {
  const out = [];
  traverse(ast, {
    NumericLiteral(p) {
      if (out.length >= MAX_RESULTS) return;
      const neg = t.isUnaryExpression(p.parent, { operator: '-' });
      const v = neg ? -p.node.value : p.node.value;
      if (PLAIN_NUMBERS.has(v)) return;
      const host = neg ? p.parentPath : p;
      if (t.isVariableDeclarator(host.parent) && host.parent.init === host.node && host.parentPath.parent.kind === 'const') return;
      if (t.isMemberExpression(host.parent) && host.parent.computed && host.parent.property === host.node && v >= 0 && v < 16) return;
      out.push({ ...span(host.node), text: host.node.extra?.raw ?? String(v), note: '' });
    },
  });
  return out;
}

const dotted = (node) => {
  if (t.isIdentifier(node)) return node.name;
  if (t.isThisExpression(node)) return 'this';
  if ((t.isMemberExpression(node) || t.isOptionalMemberExpression(node))) {
    const prop = node.computed ? (t.isStringLiteral(node.property) ? node.property.value : null) : node.property.name;
    const obj = dotted(node.object);
    return prop == null ? null : obj ? `${obj}.${prop}` : prop;
  }
  return null;
};

/** API çağrıları/erişimleri: "fetch", "document.cookie", "localStorage.setItem" (sonek eşleşmesi) */
export function apiUsage(ast, name) {
  const want = String(name).trim();
  if (!want) return [];
  const out = [];
  const hit = (full) => full && (full === want || full.endsWith(`.${want}`));
  traverse(ast, {
    'CallExpression|NewExpression|OptionalCallExpression'(p) {
      if (hit(dotted(p.node.callee))) out.push({ ...span(p.node), text: gen(p.node).slice(0, 100), note: p.node.type === 'NewExpression' ? 'new' : 'call' });
    },
    MemberExpression(p) {
      if (t.isCallExpression(p.parent) && p.parent.callee === p.node) return;
      if (t.isMemberExpression(p.parent) && p.parent.object === p.node) return;
      if (hit(dotted(p.node))) out.push({ ...span(p.node), text: gen(p.node).slice(0, 100), note: t.isAssignmentExpression(p.parent) && p.parent.left === p.node ? 'write' : 'read' });
    },
  });
  return out.slice(0, MAX_RESULTS);
}

/** Bir string değerin kullanıldığı yerler; değer /regex/ biçimindeyse regex eşleşmesi */
export function stringUsage(ast, query) {
  const m = /^\/(.+)\/([a-z]*)$/i.exec(String(query));
  const test = m ? ((re) => (s) => re.test(s))(new RegExp(m[1], m[2].replace('g', ''))) : (s) => s === query;
  const out = [];
  traverse(ast, {
    StringLiteral(p) { if (out.length < MAX_RESULTS && test(p.node.value)) out.push({ ...span(p.node), text: p.node.value.slice(0, 120), note: p.parent.type }); },
    TemplateElement(p) { if (out.length < MAX_RESULTS && test(p.node.value.cooked ?? '')) out.push({ ...span(p.node), text: (p.node.value.cooked ?? '').slice(0, 120), note: 'template' }); },
  });
  return out;
}

/** Fonksiyon başına döngüsel karmaşıklık */
export function complexity(ast, code) {
  const out = [];
  traverse(ast, {
    Function(p) {
      let c = 1;
      p.traverse({
        Function(q) { q.skip(); },
        'IfStatement|ConditionalExpression|ForStatement|ForInStatement|ForOfStatement|WhileStatement|DoWhileStatement|CatchClause'() { c++; },
        SwitchCase(q) { if (q.node.test) c++; },
        LogicalExpression() { c++; },
      });
      out.push({ ...span(p.node), name: functionLabel(p, code), complexity: c, size: p.node.end - p.node.start });
    },
  });
  return out.sort((a, b) => b.complexity - a.complexity).slice(0, 5000);
}

/** Gölgeleme: dış kapsamdaki aynı adlı bağlamayı örten bağlamalar */
export function shadows(ast) {
  const out = [];
  const seen = new Set();
  traverse(ast, {
    Scopable(p) {
      for (const [name, b] of Object.entries(p.scope.bindings)) {
        if (seen.has(b)) continue;
        seen.add(b);
        const outer = b.scope.parent?.getBinding(name);
        if (outer && out.length < MAX_RESULTS) out.push({ ...span(b.identifier), text: name, note: `${b.kind} ⟶ ${outer.kind}`, outer: span(outer.identifier) });
      }
    },
  });
  return out.sort((a, b) => a.start - b.start);
}

/** Kapsam renklendirmesi: her bağlı tanımlayıcı için kapsam sırası (renk indeksi) */
export function scopeColors(ast, limit = 60_000) {
  const ids = new Map();
  const out = [];
  traverse(ast, {
    Identifier(p) {
      if (out.length >= limit || isPropertyName(p)) return;
      const b = p.scope.getBinding(p.node.name);
      if (!b) return;
      let k = ids.get(b.scope);
      if (k === undefined) { k = ids.size; ids.set(b.scope, k); }
      out.push({ start: p.node.start, end: p.node.end, scope: k, global: b.scope.path.isProgram() });
    },
  });
  return out.sort((a, b) => a.start - b.start);
}

const isTerminator = (n) => t.isReturnStatement(n) || t.isThrowStatement(n) || t.isBreakStatement(n) || t.isContinueStatement(n);
const constTruth = (n) => {
  if (t.isBooleanLiteral(n)) return n.value;
  if (t.isNumericLiteral(n)) return n.value !== 0;
  if (t.isUnaryExpression(n, { operator: '!' }) && t.isArrayExpression(n.argument)) return false;
  if (t.isUnaryExpression(n, { operator: '!' }) && t.isUnaryExpression(n.argument, { operator: '!' }) && t.isArrayExpression(n.argument.argument)) return true;
  return null;
};

/** Ölü kod katmanı: sonlandırıcıdan sonraki deyimler, sabit koşulun ulaşılmaz kolu, kullanılmayan fonksiyonlar */
export function deadCode(ast) {
  const out = [];
  traverse(ast, {
    'BlockStatement|Program|SwitchCase'(p) {
      const body = p.node.body ?? p.node.consequent;
      const i = body.findIndex(isTerminator);
      if (i >= 0 && i < body.length - 1) {
        const rest = body.slice(i + 1).filter((s) => !t.isFunctionDeclaration(s));
        if (rest.length) out.push({ start: rest[0].start, end: rest[rest.length - 1].end, note: 'unreachable' });
      }
    },
    IfStatement(p) {
      const v = constTruth(p.node.test);
      if (v === false) out.push({ ...span(p.node.consequent), note: 'constant-false' });
      if (v === true && p.node.alternate) out.push({ ...span(p.node.alternate), note: 'constant-true' });
    },
    ConditionalExpression(p) {
      const v = constTruth(p.node.test);
      if (v !== null) out.push({ ...span(v ? p.node.alternate : p.node.consequent), note: v ? 'constant-true' : 'constant-false' });
    },
    WhileStatement(p) { if (constTruth(p.node.test) === false) out.push({ ...span(p.node.body), note: 'constant-false' }); },
    FunctionDeclaration(p) {
      const b = p.node.id && p.parentPath.scope.getBinding(p.node.id.name);
      if (b && !b.referenced && !b.scope.path.isProgram()) out.push({ ...span(p.node), note: 'unused' });
    },
  });
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Güven haritası: satır başına 0..1 puan. Çözülmemiş kalıntı içeren satırlar düşük güvenlidir.
 * Kesin doğrulama değildir; kalıntıların yoğunluğuna dayalı sezgisel bir göstergedir.
 */
export function trustMap(code, ast) {
  const lines = code.split('\n');
  const starts = new Array(lines.length);
  let pos = 0;
  for (let i = 0; i < lines.length; i++) { starts[i] = pos; pos += lines[i].length + 1; }
  const score = new Float32Array(lines.length).fill(1);
  const lineAt = (off) => { let lo = 0; let hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; } return lo; };
  const penal = (off, v) => { const l = lineAt(off); score[l] = Math.max(0, score[l] - v); };
  if (ast) {
    for (const r of remnants(ast)) penal(r.start, r.note === 'decoder' ? 0.45 : r.note === '_0x' ? 0.3 : 0.5);
    traverse(ast, {
      StringLiteral(p) {
        const v = p.node.value;
        if (v.length >= 24 && entropy(v) >= 4.5) penal(p.node.start, 0.2);
        if (/\\x[0-9a-f]{2}|\\u[0-9a-f]{4}/i.test(p.node.extra?.raw ?? '')) penal(p.node.start, 0.1);
      },
    });
  }
  for (let i = 0; i < lines.length; i++) if (lines[i].length > 400) score[i] = Math.max(0, score[i] - 0.15);
  return score;
}

/** Proxy eşleme tablosu: yalnızca işlem/çağrı ileten fonksiyonlar ve string taşıyan nesne alanları */
export function proxyMap(ast) {
  const out = [];
  const shapeOf = (fn) => {
    const body = t.isBlockStatement(fn.body) ? (fn.body.body.length === 1 && t.isReturnStatement(fn.body.body[0]) ? fn.body.body[0].argument : null) : fn.body;
    if (!body) return null;
    const params = fn.params.map((x) => (t.isIdentifier(x) ? x.name : null));
    const idx = (n) => (t.isIdentifier(n) ? params.indexOf(n.name) : -1);
    const ph = (n) => `$${idx(n)}`;
    if ((t.isBinaryExpression(body) || t.isLogicalExpression(body)) && idx(body.left) >= 0 && idx(body.right) >= 0) return { kind: 'binary', shape: `${ph(body.left)} ${body.operator} ${ph(body.right)}` };
    if (t.isCallExpression(body) && idx(body.callee) >= 0 && body.arguments.every((a) => idx(a) >= 0)) return { kind: 'call', shape: `${ph(body.callee)}(${body.arguments.map(ph).join(', ')})` };
    if (t.isCallExpression(body) && t.isIdentifier(body.callee) && body.arguments.every((a) => idx(a) >= 0)) return { kind: 'call', shape: `${body.callee.name}(${body.arguments.map(ph).join(', ')})` };
    if (t.isUnaryExpression(body) && idx(body.argument) >= 0) return { kind: 'unary', shape: `${body.operator}${ph(body.argument)}` };
    if (t.isMemberExpression(body) && idx(body.object) >= 0 && (idx(body.property) >= 0 || !body.computed)) return { kind: 'member', shape: `${ph(body.object)}[${body.computed ? ph(body.property) : JSON.stringify(body.property.name)}]` };
    return null;
  };
  const uses = (scope, name) => scope?.getBinding(name)?.references ?? 0;
  traverse(ast, {
    Function(p) {
      if (out.length >= MAX_RESULTS) return;
      const s = shapeOf(p.node);
      if (!s) return;
      const parent = p.parent;
      let owner = null;
      let refs = 0;
      if (t.isObjectProperty(parent)) {
        const objPath = p.parentPath.parentPath;
        const holder = t.isVariableDeclarator(objPath.parent) && t.isIdentifier(objPath.parent.id) ? objPath.parent.id.name : '{}';
        owner = `${holder}.${parent.key.name ?? parent.key.value}`;
        refs = uses(objPath.scope, holder);
      } else {
        owner = fnName(p);
        if (owner && t.isIdentifier(p.node.id ?? parent.id)) refs = uses(p.parentPath.scope, owner);
      }
      if (owner) out.push({ ...span(p.node), owner, kind: s.kind, shape: s.shape, refs });
    },
    ObjectProperty(p) {
      if (out.length >= MAX_RESULTS || p.node.computed || !t.isStringLiteral(p.node.value)) return;
      const obj = p.parentPath;
      if (!t.isVariableDeclarator(obj.parent) || !t.isIdentifier(obj.parent.id)) return;
      // obfuscator.io nesne proxy'si: kısa rastgele anahtar → string
      const key = p.node.key.name ?? p.node.key.value;
      if (!/^[a-zA-Z]{5}$/.test(String(key))) return;
      out.push({ ...span(p.node), owner: `${obj.parent.id.name}.${key}`, kind: 'string', shape: JSON.stringify(p.node.value.value).slice(0, 80), refs: uses(obj.scope, obj.parent.id.name) });
    },
  });
  return out;
}

/** AST düğüm sayısı (grafikler için) */
export function countNodes(ast) {
  let n = 0;
  const walk = (node) => {
    n++;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[key];
      for (const c of Array.isArray(v) ? v : [v]) if (c && typeof c.type === 'string') walk(c);
    }
  };
  walk(ast.program);
  return n;
}

/** Ağaç görünümü için bir düğümün çocukları: [{key, index, node}] ve kısa özet */
export function childrenOf(node) {
  const out = [];
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c, i) => { if (c && typeof c.type === 'string') out.push({ key, index: i, node: c }); });
    else if (v && typeof v.type === 'string') out.push({ key, index: null, node: v });
  }
  return out;
}

export function nodeSummary(node) {
  if (t.isIdentifier(node)) return node.name;
  if (t.isStringLiteral(node)) return JSON.stringify(node.value.length > 40 ? `${node.value.slice(0, 40)}…` : node.value);
  if (t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return String(node.value);
  if (node.operator) return node.operator;
  if (t.isVariableDeclaration(node)) return node.kind;
  if ((t.isFunction(node) || t.isClass(node)) && node.id) return node.id.name;
  return '';
}
