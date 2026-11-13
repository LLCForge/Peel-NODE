import * as t from '@babel/types';
import { parse } from '../core/parse.js';
import { raw, pretty } from '../core/emit.js';
import { traverse } from '../util/ast.js';
import { fnv1a } from '../util/hash.js';
import { detectTechniques } from './techniques.js';

// Sürüm karşılaştırma (G141, G142, G145, G147, G148).
// Her fonksiyon, yerel isimlerden bağımsız bir token dizisine çevrilir: yerel bağlamalar ilk görülme
// sırasına göre v0, v1... olur, dış fonksiyonlara referanslar "fn", diğer dış bağlamalar "ext" olur,
// global adlar ve özellik adları korunur. Böylece yalnızca yeniden adlandırma içeren değişiklik
// aynı yapısal özeti verir; eşleştirme BinDiff'teki gibi önce birebir özet, sonra çağrı grafiği
// yayılımı, en son benzerlikle yapılır.

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'range']);
const MAX_GREEDY_CELLS = 4_000_000;
const MIN_SIMILARITY = 0.5;

const isFn = (n) => t.isFunction(n);
const within = (node, outer) => node.start >= outer.start && node.end <= outer.end;

// Fonksiyon için okunur ad: bildirim adı, değişken adı, nesne anahtarı ya da atama hedefi
function nameOf(path) {
  const n = path.node;
  if (n.id?.name) return n.id.name;
  const p = path.parent;
  if (t.isVariableDeclarator(p) && t.isIdentifier(p.id)) return p.id.name;
  if ((t.isObjectProperty(p) || t.isClassProperty(p)) && !p.computed && t.isIdentifier(p.key)) return p.key.name;
  if ((t.isObjectMethod(n) || t.isClassMethod(n)) && !n.computed && t.isIdentifier(n.key)) return n.key.name;
  if (t.isAssignmentExpression(p) && t.isMemberExpression(p.left) && !p.left.computed && t.isIdentifier(p.left.property)) return p.left.property.name;
  if (t.isAssignmentExpression(p) && t.isIdentifier(p.left)) return p.left.name;
  return null;
}

// Fonksiyonun dış dünyaya bağlandığı bağlama (bildirim ya da `var f = function`): ad taşıma ve çağrı grafiği için
function declBinding(path) {
  const n = path.node;
  if (t.isFunctionDeclaration(n) && n.id) return path.parentPath.scope.getBinding(n.id.name) ?? null;
  const p = path.parentPath;
  if (p?.isVariableDeclarator() && t.isIdentifier(p.node.id)) return p.scope.getBinding(p.node.id.name) ?? null;
  return null;
}

/**
 * Kodu fonksiyon listesine çevirir. Sonuç AST'yi de taşır (portNames yeniden adlandırma için kullanır).
 * @param {string} code
 */
export function extractFunctions(code) {
  const ast = parse(code);
  const paths = [];
  const bindingOf = new WeakMap();
  traverse(ast, {
    Function(p) { paths.push(p); },
    Identifier(p) {
      const b = p.scope.getBinding(p.node.name);
      if (b && (p.isReferencedIdentifier() || p.isBindingIdentifier() || b.identifier === p.node ||
        (t.isAssignmentExpression(p.parent) && p.parent.left === p.node) || (t.isUpdateExpression(p.parent)))) {
        bindingOf.set(p.node, b);
      }
    },
  });
  // bağlama -> bağlandığı fonksiyon indeksi (çağrı grafiği)
  const fnOfBinding = new Map();
  paths.forEach((p, i) => {
    const b = declBinding(p);
    if (b) fnOfBinding.set(b, i);
  });

  const program = { type: 'Program', node: ast.program };
  const units = [program, ...paths.map((p) => ({ type: 'Function', node: p.node, path: p }))];
  const fns = units.map((u, ui) => serializeUnit(u, ui === 0, bindingOf, fnOfBinding));
  fns.forEach((f, i) => {
    f.index = i;
    if (i === 0) {
      f.name = '<program>';
      f.line = 1;
      f.decl = null;
    } else {
      const p = paths[i - 1];
      f.name = nameOf(p) ?? `<anonim:${p.node.loc?.start.line ?? 0}>`;
      f.line = p.node.loc?.start.line ?? 0;
      f.decl = declBinding(p);
    }
    // çağrılan fonksiyon indeksleri program birimini (0) hesaba katarak +1 kaydırılır
    f.callees = f.calleeFns.map((x) => x + 1);
    delete f.calleeFns;
  });
  return { ast, fns };
}

function serializeUnit(unit, isProgram, bindingOf, fnOfBinding) {
  const root = unit.node;
  const tokens = [];
  const locals = new Map(); // binding -> sıra
  const order = []; // sıra -> binding
  const strings = new Set();
  const globals = new Set();
  const calleeFns = [];

  const localName = (b) => {
    if (!locals.has(b)) {
      locals.set(b, locals.size);
      order.push(b);
    }
    return `v${locals.get(b)}`;
  };

  const visit = (node, parentKey) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      tokens.push('[');
      for (const x of node) visit(x, parentKey);
      tokens.push(']');
      return;
    }
    if (!node.type) return;
    // program biriminde iç fonksiyonlar yer tutucu olur: her fonksiyon kendi birimidir
    if (isProgram && isFn(node)) {
      tokens.push(`FN:${node.type}`);
      return;
    }
    switch (node.type) {
      case 'Identifier': {
        const b = bindingOf.get(node);
        if (!b) {
          // bağlaması olmayan ad: global ya da özellik/anahtar adı
          tokens.push(`#${node.name}`);
          if (parentKey !== 'property' && parentKey !== 'key') globals.add(node.name);
          return;
        }
        const idNode = b.identifier;
        if (within(idNode, root) && !(isProgram && insideFunction(idNode, b))) tokens.push(localName(b));
        else if (fnOfBinding.has(b)) tokens.push('fn');
        else tokens.push('ext');
        return;
      }
      case 'StringLiteral':
        strings.add(node.value);
        tokens.push(`s:${node.value}`);
        return;
      case 'NumericLiteral':
        tokens.push(`n:${node.value}`);
        return;
      case 'BooleanLiteral':
        tokens.push(`b:${node.value}`);
        return;
      case 'RegExpLiteral':
        tokens.push(`r:/${node.pattern}/${node.flags}`);
        return;
      case 'TemplateElement':
        strings.add(node.value.cooked ?? node.value.raw);
        tokens.push(`t:${node.value.raw}`);
        return;
      case 'CallExpression':
      case 'NewExpression':
        if (t.isIdentifier(node.callee)) {
          const b = bindingOf.get(node.callee);
          if (b && fnOfBinding.has(b)) calleeFns.push(fnOfBinding.get(b));
        }
        break;
      default:
        break;
    }
    tokens.push(node.type);
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key) || key === 'type') continue;
      const v = node[key];
      if (v && typeof v === 'object') visit(v, key);
      else if (key === 'operator' || key === 'kind' || key === 'computed' || key === 'prefix' || key === 'async' || key === 'generator') tokens.push(`${key}=${v}`);
    }
  };

  // program biriminde bir bağlama, tanımı bir fonksiyonun içindeyse program-yerel değildir
  const insideFunction = (_idNode, b) => {
    let s = b.scope;
    while (s && !s.path.isProgram()) {
      if (s.path.isFunction()) return true;
      s = s.parent;
    }
    return false;
  };

  if (isProgram) visit(root.body, 'body');
  else {
    tokens.push(root.type, `async=${Boolean(root.async)}`, `generator=${Boolean(root.generator)}`);
    visit(root.params, 'params');
    visit(root.body, 'body');
  }
  return {
    tokens,
    hash: fnv1a(tokens.join('\u0001')),
    size: tokens.length,
    shingles: shingle(tokens),
    strings,
    globals,
    calleeFns,
    localOrder: order,
  };
}

function shingle(tokens, k = 3) {
  const s = new Set();
  if (tokens.length < k) {
    s.add(tokens.join(' '));
    return s;
  }
  for (let i = 0; i + k <= tokens.length; i++) s.add(fnv1a(tokens.slice(i, i + k).join('\u0001')));
  return s;
}

export function similarity(a, b) {
  if (a.hash === b.hash) return 1;
  const [small, large] = a.shingles.size <= b.shingles.size ? [a.shingles, b.shingles] : [b.shingles, a.shingles];
  if (!small.size && !large.size) return 1;
  let inter = 0;
  for (const x of small) if (large.has(x)) inter++;
  return inter / (small.size + large.size - inter);
}

/**
 * BinDiff tarzı eşleştirme: 1) benzersiz özet eşleri, 2) tekrar eden özetlerde sıra,
 * 3) eşleşmiş fonksiyonların çağırdıkları üzerinden yayılım, 4) kalanlar için açgözlü benzerlik.
 */
export function matchFunctions(oldFns, newFns, { threshold = MIN_SIMILARITY } = {}) {
  const pairs = new Map(); // oldIdx -> {new, similarity, via}
  const usedNew = new Set();
  const add = (o, n, sim, via) => {
    if (pairs.has(o) || usedNew.has(n)) return false;
    pairs.set(o, { new: n, similarity: sim, via });
    usedNew.add(n);
    return true;
  };

  // program birimi her zaman program birimiyle eşleşir
  add(0, 0, similarity(oldFns[0], newFns[0]), 'program');

  const group = (fns) => {
    const m = new Map();
    for (const f of fns.slice(1)) (m.get(f.hash) ?? m.set(f.hash, []).get(f.hash)).push(f.index);
    return m;
  };
  const go = group(oldFns);
  const gn = group(newFns);
  for (const [h, olds] of go) {
    const news = gn.get(h);
    if (!news) continue;
    const via = olds.length === 1 && news.length === 1 ? 'özet' : 'özet+sıra';
    for (let i = 0; i < Math.min(olds.length, news.length); i++) add(olds[i], news[i], 1, via);
  }

  // çağrı grafiği yayılımı: eşleşmiş çiftin aynı sıradaki çağırdıkları
  let grew = true;
  while (grew) {
    grew = false;
    for (const [o, { new: n }] of [...pairs]) {
      const oc = oldFns[o].callees;
      const nc = newFns[n].callees;
      for (let i = 0; i < Math.min(oc.length, nc.length); i++) {
        if (pairs.has(oc[i]) || usedNew.has(nc[i])) continue;
        const sim = similarity(oldFns[oc[i]], newFns[nc[i]]);
        if (sim >= threshold && add(oc[i], nc[i], sim, 'çağrı grafiği')) grew = true;
      }
    }
  }

  // kalanlar: benzerlik matrisi (büyük girdide yalnızca boyutu yakın olanlar)
  const ro = oldFns.filter((f) => !pairs.has(f.index));
  const rn = newFns.filter((f) => !usedNew.has(f.index));
  const cand = [];
  const full = ro.length * rn.length <= MAX_GREEDY_CELLS;
  for (const a of ro) {
    for (const b of rn) {
      if (!full && Math.abs(a.size - b.size) > Math.max(8, a.size * 0.2)) continue;
      const sim = similarity(a, b);
      if (sim >= threshold) cand.push([sim, a.index, b.index]);
    }
  }
  cand.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  for (const [sim, o, n] of cand) add(o, n, sim, 'benzerlik');

  const matched = [...pairs].map(([o, v]) => ({ old: o, new: v.new, similarity: v.similarity, via: v.via })).sort((a, b) => a.old - b.old);
  return {
    matched,
    removed: oldFns.filter((f) => !pairs.has(f.index)).map((f) => f.index),
    added: newFns.filter((f) => !usedNew.has(f.index)).map((f) => f.index),
  };
}

const setDiff = (a, b) => [...a].filter((x) => !b.has(x));

function unionOf(fns, key) {
  const s = new Set();
  for (const f of fns) for (const x of f[key]) s.add(x);
  return s;
}

/**
 * Semantik diff ve sürümler arası fonksiyon raporu.
 * @param {string} oldCode   eski sürümün (tercihen çözülmüş) kodu
 * @param {string} newCode   yeni sürümün (tercihen çözülmüş) kodu
 * @param {{oldInput?: string, newInput?: string, threshold?: number}} [o]  ham girdiler verilirse yeni teknik uyarısı üretilir
 */
export function semanticDiff(oldCode, newCode, o = {}) {
  const A = extractFunctions(oldCode).fns;
  const B = extractFunctions(newCode).fns;
  const m = matchFunctions(A, B, o);
  const describe = (f) => ({ index: f.index, name: f.name, line: f.line, size: f.size, hash: f.hash });
  const functions = [];
  for (const x of m.matched) {
    const a = A[x.old];
    const b = B[x.new];
    const status = a.hash === b.hash ? 'same' : 'changed';
    const row = { status, old: describe(a), new: describe(b), similarity: Number(x.similarity.toFixed(3)), via: x.via };
    if (status === 'changed') {
      row.changes = {
        stringsAdded: setDiff(b.strings, a.strings).slice(0, 50),
        stringsRemoved: setDiff(a.strings, b.strings).slice(0, 50),
        globalsAdded: setDiff(b.globals, a.globals).slice(0, 50),
        globalsRemoved: setDiff(a.globals, b.globals).slice(0, 50),
        sizeDelta: b.size - a.size,
      };
    }
    functions.push(row);
  }
  for (const i of m.removed) functions.push({ status: 'removed', old: describe(A[i]), new: null, similarity: 0, via: null });
  for (const i of m.added) functions.push({ status: 'added', old: null, new: describe(B[i]), similarity: 0, via: null });

  const count = (s) => functions.filter((f) => f.status === s).length;
  const sa = unionOf(A, 'strings');
  const sb = unionOf(B, 'strings');
  const ga = unionOf(A, 'globals');
  const gb = unionOf(B, 'globals');
  const summary = {
    same: count('same'),
    changed: count('changed'),
    added: count('added'),
    removed: count('removed'),
    stringsAdded: setDiff(sb, sa).slice(0, 200),
    stringsRemoved: setDiff(sa, sb).slice(0, 200),
    globalsAdded: setDiff(gb, ga).slice(0, 100),
    globalsRemoved: setDiff(ga, gb).slice(0, 100),
  };
  summary.equivalent = summary.changed === 0 && summary.added === 0 && summary.removed === 0;

  let techniques = null;
  if (typeof o.oldInput === 'string' && typeof o.newInput === 'string') {
    const before = new Set(detectTechniques(o.oldInput).map((x) => x.id));
    const after = detectTechniques(o.newInput);
    techniques = {
      before: [...before],
      after: after.map((x) => x.id),
      new: after.filter((x) => !before.has(x.id)).map((x) => ({ id: x.id, name: x.name })),
      gone: [...before].filter((id) => !after.some((x) => x.id === id)),
    };
  }
  return { summary, functions, techniques };
}

// İnsan okunur değişiklik özeti (CLI, VS Code, rapor için)
export function formatDiff(diff, lang = 'tr') {
  const tr = lang === 'tr';
  const s = diff.summary;
  const lines = [];
  lines.push(s.equivalent
    ? (tr ? 'Yapısal fark yok: yalnızca isimler/biçim değişmiş.' : 'No structural difference: only names/formatting changed.')
    : (tr ? `Fonksiyonlar: ${s.same} aynı, ${s.changed} değişmiş, ${s.added} eklenmiş, ${s.removed} silinmiş`
      : `Functions: ${s.same} same, ${s.changed} changed, ${s.added} added, ${s.removed} removed`));
  for (const f of diff.functions) {
    if (f.status === 'same') continue;
    const o = f.old ? `${f.old.name}:${f.old.line}` : '-';
    const n = f.new ? `${f.new.name}:${f.new.line}` : '-';
    const tag = { changed: '~', added: '+', removed: '-' }[f.status];
    let line = `  ${tag} ${o} -> ${n}`;
    if (f.status === 'changed') {
      line += ` (${Math.round(f.similarity * 100)}%, ${f.via})`;
      const c = f.changes;
      if (c.stringsAdded.length) line += `\n      + "${c.stringsAdded.slice(0, 5).join('", "')}"`;
      if (c.stringsRemoved.length) line += `\n      - "${c.stringsRemoved.slice(0, 5).join('", "')}"`;
      if (c.globalsAdded.length) line += `\n      + API: ${c.globalsAdded.slice(0, 8).join(', ')}`;
    }
    lines.push(line);
  }
  if (s.stringsAdded.length) lines.push(`${tr ? 'Yeni string' : 'New strings'}: ${s.stringsAdded.slice(0, 10).map((x) => JSON.stringify(x)).join(', ')}`);
  if (s.globalsAdded.length) lines.push(`${tr ? 'Yeni global/API' : 'New globals/APIs'}: ${s.globalsAdded.join(', ')}`);
  if (diff.techniques?.new.length) {
    lines.push(`${tr ? 'UYARI: yeni gizleme tekniği' : 'WARNING: new obfuscation technique'}: ${diff.techniques.new.map((x) => x.name).join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Eski sürümdeki adları yeni sürüme taşır (G147). Birebir aynı yapıdaki fonksiyonların yerel adları
 * sırayla, eşleşen (değişmiş olsa da) fonksiyonların kendi adları ise doğrudan taşınır.
 * Çakışma riski olan ad atlanır.
 * @returns {Promise<{code: string, renamed: Array<{from: string, to: string}>, skipped: number}>}
 */
export async function portNames(oldCode, newCode, o = {}) {
  const A = extractFunctions(oldCode).fns;
  const nb = extractFunctions(newCode);
  const B = nb.fns;
  const m = matchFunctions(A, B, o);
  const plan = new Map(); // binding -> hedef ad
  for (const x of m.matched) {
    const a = A[x.old];
    const b = B[x.new];
    if (a.decl && b.decl && a.decl.identifier.name !== b.decl.identifier.name) plan.set(b.decl, a.decl.identifier.name);
    if (a.hash !== b.hash) continue;
    for (let i = 0; i < Math.min(a.localOrder.length, b.localOrder.length); i++) {
      const from = b.localOrder[i];
      const to = a.localOrder[i].identifier.name;
      if (from.identifier.name !== to && !plan.has(from)) plan.set(from, to);
    }
  }

  // çakışma denetimi: hedef ad, bağlamanın kapsamında ya da iç kapsamlarda başka bir şeye işaret etmemeli
  const renamed = [];
  let skipped = 0;
  const valid = /^[A-Za-z_$][\w$]*$/;
  const steps = [];
  let seq = 0;
  for (const [b, to] of plan) {
    if (!valid.test(to)) { skipped++; continue; }
    const tmp = `__peel_tmp_${seq++}`;
    steps.push({ b, from: b.identifier.name, tmp, to });
    b.scope.rename(b.identifier.name, tmp);
  }
  for (const s of steps) {
    const scope = s.b.scope;
    const clash = scope.hasBinding(s.to) || scope.hasGlobal(s.to) || referencedInside(s.b, s.to);
    const target = clash ? s.from : s.to;
    if (clash) skipped++;
    else renamed.push({ from: s.from, to: s.to });
    scope.rename(s.tmp, target);
  }
  return { code: await pretty(raw(nb.ast)), renamed, skipped };
}

// Bağlamanın referanslarından birinin bulunduğu kapsamda hedef ad başka bir bağlamaya çözülüyorsa çakışma vardır
function referencedInside(binding, name) {
  for (const ref of [...binding.referencePaths, ...binding.constantViolations]) {
    const other = ref.scope.getBinding(name);
    if (other && other !== binding) return true;
  }
  return false;
}
