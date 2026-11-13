import * as t from '@babel/types';
import { gen } from '../../util/ast.js';
import { fnv1a } from '../../util/hash.js';
import { parse } from '../parse.js';
import { walk } from './detect.js';

// Handler adlandırma: sembolik etki (statik, E651) şablon kütüphanesiyle (E181/E657) eşlenir;
// sandbox izindeki yığın değişiminden (dinamik, madde 34) çıkan adla karşılaştırılır.

export const BINOPS = {
  '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '%': 'MOD', '**': 'POW', '&': 'BAND', '|': 'BOR', '^': 'BXOR',
  '<<': 'SHL', '>>': 'SHR', '>>>': 'USHR', '==': 'EQ', '!=': 'NE', '===': 'SEQ', '!==': 'SNE',
  '<': 'LT', '>': 'GT', '<=': 'LE', '>=': 'GE', in: 'IN', instanceof: 'INSTANCEOF',
};
export const UNOPS = { '!': 'NOT', '-': 'NEG', '+': 'TONUM', '~': 'BNOT', typeof: 'TYPEOF', void: 'VOID', delete: 'DELETE' };

const S = (i) => `$s${i}`;
const isOperand = (src) => /^\$op\d+$/.test(src);
const exprOf = (src) => {
  try { return parse(`(${src})`).program.body[0].expression; } catch { return null; }
};

// Şablon kütüphanesi: her şablon tek yollu ya da çift yollu (koşullu) bir etki tanımına uyar.
// Sıra önemlidir: ilk eşleşen kazanır.
export const TEMPLATES = [
  { name: 'HALT', match: (p) => p.length === 1 && p[0].end === 'exit' },
  { name: 'RET', match: (p) => p.length === 1 && p[0].end === 'ret' && p[0].stmts.at(-1) === `return ${S(0)};` },
  { name: 'RET_VOID', match: (p) => p.length === 1 && p[0].end === 'ret' && /^return\s*(void 0)?;$/.test(p[0].stmts.at(-1) ?? '') },
  { name: 'RET_EXPR', match: (p) => p.length === 1 && p[0].end === 'ret' && /^return /.test(p[0].stmts.at(-1) ?? '') },
  { name: 'THROW', match: (p) => p.length === 1 && p[0].end === 'ret' && /^throw /.test(p[0].stmts.at(-1) ?? '') },
  { name: 'JZ', match: (p) => p.length === 2 && p.some((x) => x.jump !== null && x.cond.join('&&') === `!${S(0)}`) && p.every((x) => x.pops === 1) },
  { name: 'JNZ', match: (p) => p.length === 2 && p.some((x) => x.jump !== null && x.cond.join('&&') === S(0)) && p.every((x) => x.pops === 1) },
  { name: 'JCMP', match: (p) => p.length === 2 && p.some((x) => x.jump !== null) && p.every((x) => x.pops === 2) },
  { name: 'JCOND', match: (p) => p.length === 2 && p.some((x) => x.jump !== null) },
  { name: 'JMP', match: (p) => p.length === 1 && p[0].jump !== null && !p[0].pushes.length && !p[0].pops && !p[0].stmts.length },
  { name: 'CALL_SUB', match: (p) => p.length === 1 && p[0].jump !== null && p[0].pushes.length === 1 },
  { name: 'JMP_DYN', match: (p) => p.length === 1 && p[0].jump !== null && p[0].pops === 1 },
  { name: 'NOP', match: (p) => p.length === 1 && !p[0].pops && !p[0].pushes.length && !p[0].stmts.length && p[0].end === 'fall' },
  { name: 'DUP', match: (p) => one(p, 0, [S(0)]) },
  { name: 'SWAP', match: (p) => one(p, 2, [S(0), S(1)]) },
  { name: 'POP', match: (p) => one(p, 1, []) && !p[0].stmts.length },
  { name: 'PUSH_IMM', match: (p) => one(p, 0, null) && p[0].pushes.length === 1 && (isOperand(p[0].pushes[0]) || isLiteral(p[0].pushes[0])) },
  { name: 'PUSH_CONST', match: (p, ctx) => one(p, 0, null) && p[0].pushes.length === 1 && ctx.consts && new RegExp(`^${esc(ctx.consts)}\\[[^\\]]+\\]$`).test(p[0].pushes[0]) },
  { name: 'LOAD', match: (p, ctx) => one(p, 0, null) && p[0].pushes.length === 1 && ctx.regs && new RegExp(`^${esc(ctx.regs)}\\[[^\\]]+\\]$`).test(p[0].pushes[0]) },
  { name: 'LOAD_NAME', match: (p) => one(p, 0, null) && p[0].pushes.length === 1 && isNameRead(p[0].pushes[0]) },
  { name: 'STORE', match: (p, ctx) => one(p, 1, []) && p[0].stmts.length === 1 && ctx.regs && new RegExp(`^${esc(ctx.regs)}\\[[^\\]]+\\]\\s*=\\s*\\${S(0)};$`).test(p[0].stmts[0]) },
  { name: 'STORE_NAME', match: (p) => one(p, 1, []) && p[0].stmts.length === 1 && new RegExp(`=\\s*\\${S(0)};$`).test(p[0].stmts[0]) },
  { name: 'SETPROP', match: (p) => one(p, 3, []) && p[0].stmts.length === 1 && p[0].stmts[0] === `${S(2)}[${S(1)}]=${S(0)};` },
  // nesne yerinde kalır, anahtar yerine metot gelir: [o, k] → [o, o[k]]
  { name: 'GETMETHOD', match: (p) => one(p, 1, [`${S(1)}[${S(0)}]`]) || one(p, 2, [S(1), `${S(1)}[${S(0)}]`]) },
  { name: 'GETPROP', match: (p) => one(p, 2, [`${S(1)}[${S(0)}]`]) },
  { name: 'GETPROP_K', match: (p) => one(p, 1, null) && p[0].pushes.length === 1 && new RegExp(`^\\${S(0)}(\\[|\\.)`).test(p[0].pushes[0]) && !/\(/.test(p[0].pushes[0]) },
  { name: 'NEW', match: (p) => p.length === 1 && p[0].pushes.length === 1 && /^new /.test(p[0].pushes[0]) },
  { name: 'CALL', match: (p) => p.length === 1 && p[0].pushes.length === 1 && /\)$/.test(p[0].pushes[0]) && /\(/.test(p[0].pushes[0]) },
  { name: 'CALL_VOID', match: (p) => p.length === 1 && !p[0].pushes.length && p[0].stmts.length === 1 && /\)\s*;$/.test(p[0].stmts[0]) },
];

function esc(s) { return s.replace(/[$]/g, '\\$'); }
function isLiteral(src) {
  const e = exprOf(src);
  return Boolean(e) && (t.isLiteral(e) || (t.isUnaryExpression(e) && t.isNumericLiteral(e.argument)) || t.isIdentifier(e, { name: 'undefined' }));
}
function isNameRead(src) {
  const e = exprOf(src);
  if (!e) return false;
  let stackRef = false;
  walk(e, (n) => { if (t.isIdentifier(n) && /^\$s\d+$/.test(n.name)) stackRef = true; });
  return !stackRef && (t.isIdentifier(e) || t.isMemberExpression(e));
}
function one(p, pops, pushes) {
  if (p.length !== 1 || p[0].jump !== null || p[0].end !== 'fall' || p[0].pops !== pops) return false;
  if (pushes === null) return true;
  return p[0].pushes.length === pushes.length && pushes.every((x, i) => p[0].pushes[i] === x);
}

// Sembolik etkiden ad: önce şablonlar, sonra genel ikili/tekli işleç kalıbı
export function nameFromSemantics(sem, ctx = {}) {
  if (!sem?.ok || !sem.paths.length) return null;
  const p = sem.paths;
  if (p.length === 1 && p[0].end === 'fall' && p[0].jump === null) {
    const { pops, pushes, stmts } = p[0];
    if (pops === 2 && pushes.length === 1 && !stmts.length) {
      const e = exprOf(pushes[0]);
      if (t.isBinaryExpression(e) && t.isIdentifier(e.left, { name: S(1) }) && t.isIdentifier(e.right, { name: S(0) })) return BINOPS[e.operator] ?? null;
    }
    if (pops === 1 && pushes.length === 1 && !stmts.length) {
      const e = exprOf(pushes[0]);
      if (t.isUnaryExpression(e) && t.isIdentifier(e.argument, { name: S(0) })) return UNOPS[e.operator] ?? null;
    }
  }
  for (const tpl of TEMPLATES) if (tpl.match(p, ctx)) return tpl.name;
  return null;
}

// Okunur etki metni: "pop 2 → push(b + a)"
export function semanticsText(sem) {
  if (!sem) return '';
  if (!sem.ok) return `? (${sem.reason})`;
  const nm = (s) => s.replace(/\$s(\d+)/g, (_, i) => `s${i}`).replace(/\$op(\d+)/g, (_, i) => `#${i}`);
  return sem.paths.map((x) => {
    const parts = [];
    if (x.cond.length) parts.push(`[${nm(x.cond.join(' && '))}]`);
    if (x.pops) parts.push(`pop ${x.pops}`);
    if (x.stmts.length) parts.push(nm(x.stmts.join(' ')));
    if (x.pushes.length) parts.push(`push ${x.pushes.map(nm).join(', ')}`);
    if (x.jump !== null) parts.push(`goto ${nm(x.jump)}`);
    if (x.end === 'exit') parts.push('halt');
    return parts.join(' ; ') || 'nop';
  }).join('  |  ');
}

// ── dinamik adlandırma: sandbox izinden ─────────────────

const parseTop = (s) => {
  if (s === 'undefined') return undefined;
  if (s === 'true' || s === 'false') return s === 'true';
  if (s === 'null') return null;
  if (s === 'NaN') return NaN;
  if (/^-?(\d|Infinity)/.test(s)) return Number(s);
  if (s.startsWith('"')) { try { return JSON.parse(s); } catch { return Symbol('?'); } }
  return Symbol(s);
};
const prim = (v) => v === null || (typeof v !== 'object' && typeof v !== 'symbol');
const sameVal = (a, b) => (typeof a === 'symbol' || typeof b === 'symbol' ? false : Object.is(a, b));

const BIN_FNS = Object.entries({
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b, '%': (a, b) => a % b,
  '&': (a, b) => a & b, '|': (a, b) => a | b, '^': (a, b) => a ^ b, '<<': (a, b) => a << b, '>>': (a, b) => a >> b,
  '>>>': (a, b) => a >>> b, '===': (a, b) => a === b, '!==': (a, b) => a !== b, '<': (a, b) => a < b, '>': (a, b) => a > b,
  '<=': (a, b) => a <= b, '>=': (a, b) => a >= b,
});

// steps: [pc, depth, top[], regs[]] dizisi; dis: pc → komut (uzunluk ve opcode için)
export function dynamicNames(steps, dis) {
  const byPc = new Map(dis.list.map((x) => [x.pc, x]));
  const votes = new Map();
  const stats = new Map();
  const vote = (op, name) => {
    if (!votes.has(op)) votes.set(op, new Map());
    const m = votes.get(op);
    m.set(name, (m.get(name) ?? 0) + 1);
  };
  for (let i = 0; i + 1 < steps.length; i++) {
    const [pc, d0, top0, rg0] = steps[i];
    const [pc1, d1, top1, rg1] = steps[i + 1];
    const ins = byPc.get(pc);
    if (!ins) continue;
    const st = stats.get(ins.op) ?? { count: 0, deltas: new Set(), jumps: 0 };
    st.count++;
    const dd = d1 - d0;
    st.deltas.add(dd);
    const width = ins.reads.length ? Math.max(...ins.reads) - Math.min(...ins.reads) + 1 : 1;
    const jumped = typeof pc === 'number' && pc1 !== pc + width;
    if (jumped) st.jumps++;
    stats.set(ins.op, st);
    const b = top0.map(parseTop);
    const a = top1.map(parseTop);
    if (d0 < 0 || d1 < 0) { vote(ins.op, jumped ? 'JUMP' : 'STEP'); continue; }
    if (dd === -1 && jumped) { vote(ins.op, 'JCOND'); continue; }
    if (dd === 0 && jumped) { vote(ins.op, 'JMP'); continue; }
    if (dd === 1 && b.length && a.length > 1 && sameVal(a[0], b[0]) && sameVal(a[1], b[0])) { vote(ins.op, 'DUP'); continue; }
    if (dd === 1) { vote(ins.op, 'PUSH'); continue; }
    if (dd === -1 && b.length >= 2 && a.length >= 1 && prim(b[0]) && prim(b[1])) {
      const hit = BIN_FNS.find(([, f]) => sameVal(f(b[1], b[0]), a[0]));
      if (hit) { vote(ins.op, BINOPS[hit[0]]); continue; }
    }
    if (dd === -1) {
      const changed = rg0.some((x, k) => x !== rg1[k]) || rg1.length !== rg0.length;
      vote(ins.op, changed ? 'STORE' : 'POP');
      continue;
    }
    if (dd === 0 && b.length && a.length && prim(b[0])) {
      if (sameVal(a[0], !b[0])) { vote(ins.op, 'NOT'); continue; }
      if (typeof b[0] === 'number' && sameVal(a[0], -b[0])) { vote(ins.op, 'NEG'); continue; }
      if (sameVal(a[0], typeof b[0])) { vote(ins.op, 'TYPEOF'); continue; }
    }
    if (dd === 0 && b.length >= 2 && a.length >= 2 && sameVal(a[0], b[1]) && sameVal(a[1], b[0])) { vote(ins.op, 'SWAP'); continue; }
    vote(ins.op, dd < -1 ? `CALL/${-dd}` : dd === 0 ? 'MODIFY' : `PUSH${dd}`);
  }
  const out = new Map();
  for (const [op, m] of votes) {
    const [name] = [...m].sort((x, y) => y[1] - x[1])[0];
    const st = stats.get(op);
    out.set(op, { name, votes: Object.fromEntries(m), count: st.count, deltas: [...st.deltas], jumps: st.jumps });
  }
  return out;
}

// Statik ve dinamik adların uyumu: dinamik ad statik adın kaba sınıfına düşüyor mu?
export function agrees(stat, dyn) {
  if (!stat || !dyn) return null;
  if (stat === dyn) return true;
  const fam = (n) => (/^J|CALL_SUB/.test(n) ? 'jump' : /^PUSH|LOAD|DUP|GETMETHOD/.test(n) ? 'push' : /^POP|STORE|SET/.test(n) ? 'pop' : n);
  return fam(stat) === fam(dyn) || (stat.startsWith('CALL') && dyn.startsWith('CALL'));
}

// ── kümeleme ve imzalar ─────────────────────────────────

// Handler gövdesinin biçim özeti: tanımlayıcılar ilk görülme sırasıyla yeniden adlandırılır
export function shapeOf(stmts, roles = {}) {
  // VM rolleri (bytecode, pc, yığın…) sabit adlarla, diğer yereller handler içinde ilk görülme sırasıyla adlandırılır:
  // opcode numaraları karıştırılsa da aynı handler aynı özeti verir
  const roleOf = new Map(Object.entries(roles).filter(([k, v]) => typeof v === 'string' && k !== 'isString').map(([k, v]) => [v, `$${k}`]));
  const names = new Map();
  const norm = (node) => {
    const copy = t.cloneNode(node, true);
    walk(copy, (n, parent, key) => {
      if (t.isIdentifier(n) && !((t.isMemberExpression(parent) && key === 'property' && !parent.computed) ||
          (t.isObjectProperty(parent) && key === 'key' && !parent.computed))) {
        if (roleOf.has(n.name)) n.name = roleOf.get(n.name);
        else {
          if (!names.has(n.name)) names.set(n.name, `v${names.size}`);
          n.name = names.get(n.name);
        }
      }
      n.leadingComments = null;
      n.trailingComments = null;
      n.innerComments = null;
    });
    return gen(copy);
  };
  // switch düşmesi: handler en üst düzeydeki ilk break/return'de biter
  const own = [];
  for (const s of stmts) {
    own.push(s);
    if (t.isBreakStatement(s) || t.isReturnStatement(s) || t.isThrowStatement(s) || t.isContinueStatement(s)) break;
  }
  return own.map(norm).join(';');
}

// E640: aynı anlamlı (aynı sembolik etki) ya da aynı biçimli handler'lar bir küme
export function clusterHandlers(handlers) {
  const groups = new Map();
  for (const h of handlers) {
    const key = h.semText && !h.semText.startsWith('?') ? `sem:${h.semText}` : `shape:${h.shape}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h.key);
  }
  return [...groups].map(([key, keys]) => ({ key: key.slice(0, 120), keys, alias: keys.length > 1 })).sort((a, b) => b.keys.length - a.keys.length);
}

// VM imzası (madde 37 / E656): opcode eşlemesinden bağımsız motor özeti + birebir tablo özeti
export function signature(handlers) {
  const shapes = handlers.map((h) => ({ key: h.key, hash: fnv1a(h.shape) }));
  return {
    engine: fnv1a(shapes.map((s) => s.hash).sort().join(',')),
    table: fnv1a(shapes.map((s) => `${s.key}=${s.hash}`).join(',')),
    handlers: shapes,
  };
}

// İki VM imzasını karşılaştır: aynı motor mu, opcode'lar karıştırılmış mı, hangi handler'lar değişmiş
export function compareSignatures(a, b) {
  const ha = new Map(a.handlers.map((h) => [h.hash, h.key]));
  const hb = new Map(b.handlers.map((h) => [h.hash, h.key]));
  const common = [...ha.keys()].filter((h) => hb.has(h));
  const union = new Set([...ha.keys(), ...hb.keys()]);
  const similarity = union.size ? common.length / union.size : 1;
  const mapping = common.map((h) => ({ from: ha.get(h), to: hb.get(h) }));
  const shuffled = mapping.some((m) => String(m.from) !== String(m.to));
  const onlyA = [...ha].filter(([h]) => !hb.has(h)).map(([, k]) => k);
  const onlyB = [...hb].filter(([h]) => !ha.has(h)).map(([, k]) => k);
  let verdict;
  if (a.table === b.table) verdict = 'aynı';
  else if (a.engine === b.engine) verdict = shuffled ? 'aynı motor, opcode eşlemesi farklı' : 'aynı motor';
  else if (similarity >= 0.6) verdict = 'aynı aile, farklı sürüm';
  else verdict = 'farklı VM';
  return { verdict, similarity: Math.round(similarity * 100) / 100, mapping, removed: onlyA, added: onlyB, shuffled };
}

// ── assembler / disassembler metni (E194, E658) ─────────

// Benzersiz mnemonic: aynı adı taşıyan birden çok opcode varsa ad_opcode
export function isaOf(dis, names) {
  const byName = new Map();
  for (const [op, name] of names) {
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(op);
  }
  const mn = new Map();
  for (const [name, ops] of byName) ops.forEach((op) => mn.set(op, ops.length > 1 ? `${name}_${op}` : name));
  const operands = new Map();
  for (const x of dis.list) if (!operands.has(x.op)) operands.set(x.op, x.operands.length);
  return { mnemonic: mn, operands, opcode: new Map([...mn].map(([op, m]) => [m, op])) };
}

const valueAt = (code, i) => (typeof code === 'string' ? code.charCodeAt(i) : code[i]);

// Assembly metni: komutlar ve kapsanmayan aralıklar için .data satırları; tekrar derlenince aynı bytecode
export function toAssembly(dis, code, isa) {
  const lines = [`.code ${typeof code === 'string' ? 'string' : 'array'} ${code.length}`];
  const items = [
    ...dis.list.map((x) => ({ at: Math.min(...x.reads), x })),
    ...dis.gaps.map(([a, b]) => ({ at: a, gap: [a, b] })),
  ].sort((p, q) => p.at - q.at);
  for (const it of items) {
    if (it.gap) {
      const vals = [];
      for (let i = it.gap[0]; i <= it.gap[1]; i++) vals.push(JSON.stringify(valueAt(code, i) ?? null));
      lines.push(`${String(it.gap[0]).padStart(5, '0')}: .data ${vals.join(', ')}`);
      continue;
    }
    const x = it.x;
    const ops = [...x.reads].sort((p, q) => p - q).slice(1).map((i) => JSON.stringify(valueAt(code, i)));
    lines.push(`${String(it.at).padStart(5, '0')}: ${isa.mnemonic.get(x.op) ?? `OP_${x.op}`}${ops.length ? ` ${ops.join(', ')}` : ''}`);
  }
  return lines.join('\n');
}

// Assembly → bytecode. Mnemonic'ler isa'dan, sayısal "OP_n" doğrudan opcode n; ".data" ham değerler.
export function assemble(text, isa, opcodeEncode = (op) => op) {
  let kind = 'array';
  const out = [];
  const errors = [];
  text.split(/\r?\n/).forEach((raw, lineNo) => {
    const line = raw.replace(/;.*$/, '').replace(/^\s*\d+:\s*/, '').trim();
    if (!line) return;
    const m = line.match(/^(\.?[\w$]+)\s*(.*)$/);
    if (!m) { errors.push(`${lineNo + 1}: çözümlenemedi`); return; }
    const [, word, rest] = m;
    if (word === '.code') { kind = String(rest).split(/\s+/)[0] === 'string' ? 'string' : 'array'; return; }
    let args = [];
    if (rest) {
      try { args = JSON.parse(`[${rest}]`); } catch { errors.push(`${lineNo + 1}: işlenen okunamadı`); return; }
    }
    if (word === '.data') { out.push(...args); return; }
    let op = isa.opcode.get(word);
    if (op === undefined && /^OP_/.test(word)) op = Number(word.slice(3));
    if (op === undefined) { errors.push(`${lineNo + 1}: bilinmeyen komut ${word}`); return; }
    out.push(opcodeEncode(op), ...args);
  });
  const code = kind === 'string' ? String.fromCharCode(...out.map((x) => (typeof x === 'number' ? x : 0))) : out;
  return { code, errors };
}

// ── host / native çağrı listesi (madde 39, E653) ────────

const NATIVE_ROOTS = new Set(['window', 'globalThis', 'self', 'document', 'navigator', 'location', 'console', 'Math', 'JSON',
  'Date', 'String', 'Number', 'Object', 'Array', 'fetch', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'setTimeout',
  'setInterval', 'atob', 'btoa', 'eval', 'Function', 'crypto', 'performance', 'parseInt', 'parseFloat', 'escape', 'unescape',
  'encodeURIComponent', 'decodeURIComponent', 'WebSocket', 'Promise', 'Reflect', 'Symbol', 'RegExp', 'Error', 'alert']);

// Lifted deyimlerden çağrılan fonksiyonlar: geçici değişken zincirleri çözülür (_t1 = _t0.log → console.log)
export function hostCalls(stmts, { globals = new Set(), programFns = new Set(), constArrays = new Map() } = {}) {
  const temps = new Map();
  const calls = new Map();
  const nameOf = (n, depth = 0) => {
    if (!n || depth > 12) return null;
    if (t.isIdentifier(n)) {
      if (temps.has(n.name)) return nameOf(temps.get(n.name), depth + 1);
      return n.name;
    }
    if (t.isMemberExpression(n)) {
      const base = nameOf(n.object, depth + 1);
      let prop = null;
      if (!n.computed) prop = n.property.name;
      else if (t.isStringLiteral(n.property) || t.isNumericLiteral(n.property)) prop = String(n.property.value);
      else if (t.isMemberExpression(n.property) && t.isIdentifier(n.property.object) && constArrays.has(n.property.object.name) && t.isNumericLiteral(n.property.property)) {
        prop = String(constArrays.get(n.property.object.name)[n.property.property.value]);
      }
      return base && prop ? `${base}.${prop}` : base ? `${base}[?]` : null;
    }
    if (t.isCallExpression(n)) return `${nameOf(n.callee, depth + 1) ?? '?'}()`;
    return null;
  };
  for (const s of stmts) {
    walk(s, (n) => {
      if (t.isAssignmentExpression(n, { operator: '=' }) && t.isIdentifier(n.left) && /^_t\d+$/.test(n.left.name)) temps.set(n.left.name, n.right);
      if (t.isCallExpression(n) || t.isNewExpression(n)) {
        let callee = t.isSequenceExpression(n.callee) ? n.callee.expressions.at(-1) : n.callee;
        if (t.isMemberExpression(callee) && !callee.computed && ['apply', 'call'].includes(callee.property.name)) callee = callee.object;
        let name = nameOf(callee);
        if (!name) return;
        // G["console"] gibi parametre ile geçirilen global nesne: kök adı atılır
        const parts = name.split('.');
        if (globals.has(parts[0]) && parts.length > 1) name = parts.slice(1).join('.');
        const root = name.split('.')[0].replace(/\[.*$/, '');
        const kind = NATIVE_ROOTS.has(root) ? 'native' : programFns.has(root) ? 'host' : 'dinamik';
        const k = `${kind}|${name}`;
        calls.set(k, { name, kind, count: (calls.get(k)?.count ?? 0) + 1 });
      }
    });
  }
  return [...calls.values()].sort((a, b) => b.count - a.count);
}
