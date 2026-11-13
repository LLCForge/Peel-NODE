import * as t from '@babel/types';
import { walkEval } from './ssa.js';

// SSA üzerinde kafes analizleri:
//   sccp     — seyrek koşullu sabit yayılımı (E680; E661 koşullara sabit yayılımı, E695 erişilemezlik)
//   absint   — çarpım kafesi: tip kümesi (E691), aralık (E690), string uzunluğu (E693), null olabilirlik (E694)

export const TOP = { top: true };
export const BOT = { bot: true };
const isConst = (v) => v && 'c' in v;

// Yan etkisiz primitive işlemleri gerçek JS ile değerlendirir
const BIN = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b, '%': (a, b) => a % b, '**': (a, b) => a ** b,
  '&': (a, b) => a & b, '|': (a, b) => a | b, '^': (a, b) => a ^ b, '<<': (a, b) => a << b, '>>': (a, b) => a >> b, '>>>': (a, b) => a >>> b,
  '===': (a, b) => a === b, '!==': (a, b) => a !== b, '==': (a, b) => a == b, '!=': (a, b) => a != b, // eslint-disable-line eqeqeq
  '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b,
};
const prim = (v) => v === null || (typeof v !== 'object' && typeof v !== 'function' && typeof v !== 'symbol' && typeof v !== 'bigint');
const GLOBAL_CONST = { undefined: undefined, NaN: NaN, Infinity: Infinity };

/**
 * Bir ifadenin sabit değeri (kafes). useVal(id) izlenen kimliğin kafes değeri.
 * Program bağlamasız global adlar (undefined/NaN/Infinity) sabit, diğer her şey BOT.
 */
export function constEval(node, useVal, scopeHas) {
  const ev = (n) => {
    switch (n.type) {
      case 'NumericLiteral': case 'StringLiteral': case 'BooleanLiteral': return { c: n.value };
      case 'NullLiteral': return { c: null };
      case 'Identifier': {
        const v = useVal(n);
        if (v) return v;
        if (Object.hasOwn(GLOBAL_CONST, n.name) && !scopeHas(n.name)) return { c: GLOBAL_CONST[n.name] };
        return BOT;
      }
      case 'ParenthesizedExpression': return ev(n.expression);
      case 'TemplateLiteral': {
        let s = n.quasis[0].value.cooked;
        for (let i = 0; i < n.expressions.length; i++) {
          const v = ev(n.expressions[i]);
          if (!isConst(v)) return v;
          s += String(v.c) + n.quasis[i + 1].value.cooked;
        }
        return { c: s };
      }
      case 'UnaryExpression': {
        if (n.operator === 'delete') return BOT;
        if (n.operator === 'typeof' && t.isIdentifier(n.argument) && !useVal(n.argument) && !scopeHas(n.argument.name)) return BOT;
        const v = ev(n.argument);
        if (!isConst(v)) return v;
        switch (n.operator) {
          case '-': return { c: -v.c };
          case '+': return { c: +v.c };
          case '!': return { c: !v.c };
          case '~': return { c: ~v.c };
          case 'typeof': return { c: v.c === null ? 'object' : typeof v.c };
          case 'void': return { c: undefined };
          default: return BOT;
        }
      }
      case 'BinaryExpression': {
        if (!BIN[n.operator]) return BOT;
        const l = ev(n.left);
        const r = ev(n.right);
        if (l.top || r.top) return TOP;
        if (!isConst(l) || !isConst(r)) return BOT;
        return { c: BIN[n.operator](l.c, r.c) };
      }
      case 'LogicalExpression': {
        const l = ev(n.left);
        if (!isConst(l)) return l;
        const useRight = n.operator === '&&' ? Boolean(l.c) : n.operator === '||' ? !l.c : l.c == null;
        return useRight ? ev(n.right) : l;
      }
      case 'ConditionalExpression': {
        const c = ev(n.test);
        if (!isConst(c)) return c;
        return ev(c.c ? n.consequent : n.alternate);
      }
      case 'SequenceExpression': return ev(n.expressions[n.expressions.length - 1]);
      case 'MemberExpression': {
        if (n.computed || !t.isIdentifier(n.property, { name: 'length' })) return BOT;
        const o = ev(n.object);
        if (isConst(o) && typeof o.c === 'string') return { c: o.c.length };
        return o.top ? TOP : BOT;
      }
      case 'AssignmentExpression': return ev(n.right);
      default: return BOT;
    }
  };
  try {
    const r = ev(node);
    return isConst(r) && !prim(r.c) ? BOT : r;
  } catch {
    return BOT;
  }
}

// Kafeste yalnızca aşağı inilir (TOP → sabit → BOT); değiştiyse true
function lowerTo(val, ver, nv) {
  const old = val.get(ver);
  if (old.bot || nv.top) return false;
  if (old.top) { val.set(ver, nv); return true; }
  if (isConst(nv) && Object.is(nv.c, old.c)) return false;
  val.set(ver, BOT);
  return true;
}

const meet = (a, b) => {
  if (a.top) return b;
  if (b.top) return a;
  if (a.bot || b.bot) return BOT;
  return Object.is(a.c, b.c) ? a : BOT;
};

// Tanım düğümünün (atama/bildirim/güncelleme) ürettiği değer
function defValue(site, id, oldVal, evalNode) {
  if (t.isVariableDeclarator(site)) return site.init ? evalNode(site.init) : { c: undefined };
  if (t.isAssignmentExpression(site)) {
    if (site.operator === '=') return evalNode(site.right);
    const op = site.operator.slice(0, -1);
    const r = evalNode(site.right);
    if (oldVal.top || r.top) return TOP;
    if (!isConst(oldVal) || !isConst(r) || !BIN[op]) return BOT;
    try { return { c: BIN[op](oldVal.c, r.c) }; } catch { return BOT; }
  }
  if (t.isUpdateExpression(site)) {
    if (oldVal.top) return TOP;
    if (!isConst(oldVal)) return BOT;
    return { c: site.operator === '++' ? +oldVal.c + 1 : +oldVal.c - 1 };
  }
  return BOT;
}

/** E680: SCCP. fx.sccp = { val: Map(sürüm → kafes), edges: Set(kenar), blocks: Set(blok) } */
export function sccp(fx) {
  const val = new Map(fx.versions.map((v) => [v, v.kind === 'undef' ? { c: undefined } : v.kind === 'def' || v.kind === 'phi' ? TOP : BOT]));
  const execBlocks = new Set([fx.entry]);
  const execEdges = new Set();
  const scope = fx.fn.scope;
  const useVal = (id) => { const ver = fx.useVer.get(id); return ver ? val.get(ver) : null; };
  const evalNode = (n) => constEval(n, useVal, (name) => Boolean(scope.getBinding(name)));
  let changed = true;
  let rounds = 0;
  while (changed && rounds++ < 200) {
    changed = false;
    for (const b of fx.rpo) {
      if (!execBlocks.has(b)) continue;
      for (const phi of b.phis.values()) {
        let m = TOP;
        for (const [pred, arg] of phi.args) {
          const e = pred.succ.find((x) => x.to === b);
          if (execEdges.has(e)) m = meet(m, val.get(arg));
        }
        if (lowerTo(val, phi.version, m)) changed = true;
      }
      let branchVal = null;
      let caseVal = null;
      for (const ins of b.instrs) {
        if (ins.kind === 'test') branchVal = evalNode(ins.path.node);
        if (ins.kind === 'switch') b.switchVal = evalNode(ins.path.node);
        if (ins.kind === 'case') {
          const sw = fx.blocks.find((x) => x.instrs.some((i) => i.kind === 'switch' && i.path.parentPath === ins.switchPath))?.switchVal ?? BOT;
          const cv = evalNode(ins.path.node);
          caseVal = sw.top || cv.top ? TOP : isConst(sw) && isConst(cv) ? { c: sw.c === cv.c } : BOT;
        }
        if (ins.kind === 'forx') continue;
        const defs = [];
        walkEval(ins.path.node, fx.keyOf, () => {}, (id, site) => defs.push([id, site]));
        for (const [id, site] of defs) {
          const ver = fx.defVer.get(id);
          if (!ver) continue;
          const oldInput = t.isAssignmentExpression(site) && site.operator !== '=' || t.isUpdateExpression(site) ? (useVal(id) ?? BOT) : TOP;
          if (lowerTo(val, ver, defValue(site, id, oldInput, evalNode))) changed = true;
        }
      }
      // çıkış kenarları
      const decide = branchVal ?? caseVal;
      for (const e of b.succ) {
        let live;
        if (!e.cond || e.cond.forx) live = true;
        else if (decide && isConst(decide)) live = Boolean(decide.c) === e.cond.value;
        else live = !decide?.top;
        if (live && !execEdges.has(e)) { execEdges.add(e); changed = true; if (!execBlocks.has(e.to)) execBlocks.add(e.to); }
      }
    }
  }
  fx.sccp = { val, edges: execEdges, blocks: execBlocks, converged: !changed };
  return fx.sccp;
}

// ── çarpım kafesi ─────────────────────────────────────
export const T = { undefined: 1, null: 2, boolean: 4, number: 8, string: 16, object: 32, function: 64, bigint: 128, symbol: 256 };
export const ALL = 511;
const PRIM_NONBIG = T.undefined | T.null | T.boolean | T.number | T.string;
export const typeNames = (m) => Object.keys(T).filter((k) => m & T[k]);

const absTop = () => ({ ty: 0, lo: Infinity, hi: -Infinity, int: true, slo: Infinity, shi: -Infinity });
const absAll = () => ({ ty: ALL, lo: -Infinity, hi: Infinity, int: false, slo: 0, shi: Infinity });
const join = (a, b) => ({
  ty: a.ty | b.ty, lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi), int: a.int && b.int,
  slo: Math.min(a.slo, b.slo), shi: Math.max(a.shi, b.shi),
});
const eqAbs = (a, b) => a.ty === b.ty && a.lo === b.lo && a.hi === b.hi && a.int === b.int && a.slo === b.slo && a.shi === b.shi;
const num = (lo, hi, int, extra = 0) => ({ ty: T.number | extra, lo, hi, int, slo: Infinity, shi: -Infinity });
const I32 = [-(2 ** 31), 2 ** 31 - 1];

function litAbs(v) {
  if (v === undefined) return { ...absTop(), ty: T.undefined };
  if (v === null) return { ...absTop(), ty: T.null };
  if (typeof v === 'boolean') return { ...absTop(), ty: T.boolean };
  if (typeof v === 'number') return Number.isNaN(v) ? num(-Infinity, Infinity, false) : num(v, v, Number.isInteger(v));
  if (typeof v === 'string') return { ...absTop(), ty: T.string, slo: v.length, shi: v.length };
  return absAll();
}

/** E690/E691/E693/E694: sürüm başına {ty, lo, hi, int, slo, shi}; dal olguları kullanım noktasında aralığı daraltır */
export function absint(fx) {
  const exec = fx.sccp ?? sccp(fx);
  const val = new Map(fx.versions.map((v) => [v, v.kind === 'undef' ? litAbs(undefined) : v.kind === 'def' || v.kind === 'phi' ? absTop() : absAll()]));
  const scope = fx.fn.scope;
  // baskın kenar olguları: blok → [{varKey, op, k(abs)}]
  const facts = new Map();
  const collect = (b, inherited) => {
    let own = inherited;
    if (b.pred.length === 1) {
      const e = b.pred[0].succ.find((x) => x.to === b);
      const f = e?.cond?.path ? factOf(e.cond.path.node, e.cond.value, fx) : null;
      if (f) own = [...inherited, ...f];
    }
    facts.set(b, own);
    for (const c of fx.domChildren.get(b) ?? []) collect(c, own);
  };
  collect(fx.entry, []);

  const useAbs = (id) => {
    const ver = fx.useVer.get(id);
    if (!ver) return null;
    let a = val.get(ver);
    const ins = fx.useInstr.get(id);
    for (const f of facts.get(ins?.block) ?? []) {
      if (f.var !== ver.var) continue;
      // olgunun kurulduğu sürüm hâlâ güncel mi? (dal ile kullanım arasında yeniden tanım yoksa)
      if (f.ver && f.ver !== ver) continue;
      a = refine(a, f, useAbsK);
    }
    return a;
  };
  const useAbsK = (n) => evalAbs(n, useAbs, scope);
  let rounds = 0;
  let changed = true;
  const visits = new Map();
  while (changed && rounds++ < 60) {
    changed = false;
    for (const b of fx.rpo) {
      if (!exec.blocks.has(b)) continue;
      for (const phi of b.phis.values()) {
        let m = absTop();
        for (const [pred, arg] of phi.args) {
          const e = pred.succ.find((x) => x.to === b);
          if (exec.edges.has(e)) m = join(m, val.get(arg));
        }
        const old = val.get(phi.version);
        let nv = join(old, m);
        const n = (visits.get(phi) ?? 0) + 1;
        visits.set(phi, n);
        // genişletme: döngü başındaki φ'de büyüyen sınır sonsuza
        if (n > 3) nv = { ...nv, lo: nv.lo < old.lo ? -Infinity : nv.lo, hi: nv.hi > old.hi ? Infinity : nv.hi, slo: nv.slo < old.slo ? 0 : nv.slo, shi: nv.shi > old.shi ? Infinity : nv.shi };
        if (!eqAbs(nv, old)) { val.set(phi.version, nv); changed = true; }
      }
      for (const ins of b.instrs) {
        if (ins.kind === 'forx') {
          const left = ins.path.node.left;
          const id = t.isVariableDeclaration(left) ? left.declarations[0].id : left;
          const ver = fx.defVer.get(id);
          if (ver) {
            const nv = ins.path.isForInStatement() ? { ...absTop(), ty: T.string, slo: 0, shi: Infinity } : absAll();
            if (!eqAbs(nv, val.get(ver))) { val.set(ver, nv); changed = true; }
          }
          continue;
        }
        walkEval(ins.path.node, fx.keyOf, () => {}, (id, site) => {
          const ver = fx.defVer.get(id);
          if (!ver) return;
          let nv;
          if (t.isVariableDeclarator(site)) nv = site.init ? useAbsK(site.init) : litAbs(undefined);
          else if (t.isAssignmentExpression(site)) nv = site.operator === '=' ? useAbsK(site.right) : binAbs(site.operator.slice(0, -1), useAbs(id) ?? absAll(), useAbsK(site.right));
          else if (t.isUpdateExpression(site)) nv = binAbs(site.operator === '++' ? '+' : '-', toNumAbs(useAbs(id) ?? absAll()), num(1, 1, true));
          else nv = absAll();
          const merged = join(val.get(ver), nv);
          if (!eqAbs(merged, val.get(ver))) { val.set(ver, merged); changed = true; }
        });
      }
    }
  }
  // yakınsamadıysa sonuçlar eksik olabilir: tüm sorgular en genel değeri döndürür
  if (changed) {
    const all = absAll();
    for (const k of val.keys()) val.set(k, all);
    fx.abs = { val, facts, useAbs: () => absAll(), evalAbs: () => absAll(), converged: false };
    return fx.abs;
  }
  fx.abs = { val, facts, useAbs, evalAbs: useAbsK, converged: true };
  return fx.abs;
}

// Dal testinden değişken olgusu: x < k, x === k, x != null, typeof x === "number"
function factOf(test, value, fx) {
  const out = [];
  const neg = { '<': '>=', '<=': '>', '>': '<=', '>=': '<', '===': '!==', '!==': '===', '==': '!=', '!=': '==' };
  const flip = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '===': '===', '!==': '!==', '==': '==', '!=': '!=' };
  const add = (test2, val2) => {
    if (t.isLogicalExpression(test2) && ((test2.operator === '&&' && val2) || (test2.operator === '||' && !val2))) {
      add(test2.left, val2);
      add(test2.right, val2);
      return;
    }
    if (t.isUnaryExpression(test2, { operator: '!' })) { add(test2.argument, !val2); return; }
    if (t.isIdentifier(test2) && fx.keyOf.has(test2)) {
      out.push({ var: fx.keyOf.get(test2), ver: fx.useVer.get(test2), op: val2 ? 'truthy' : 'falsy' });
      return;
    }
    if (!t.isBinaryExpression(test2) || !neg[test2.operator]) return;
    let op = val2 ? test2.operator : neg[test2.operator];
    let x = test2.left;
    let k = test2.right;
    if (!(t.isIdentifier(x) && fx.keyOf.has(x))) { [x, k] = [k, x]; op = flip[op]; }
    // olumsuz dalda NaN karşılaştırması da yanlış verir: olgu yalnızca NaN olamayan değerlerde geçerli (refine denetler)
    if (t.isIdentifier(x) && fx.keyOf.has(x)) out.push({ var: fx.keyOf.get(x), ver: fx.useVer.get(x), op, k, neg: !val2 });
    // typeof x === "number"
    if (t.isUnaryExpression(test2.left, { operator: 'typeof' }) && t.isIdentifier(test2.left.argument) && fx.keyOf.has(test2.left.argument) && t.isStringLiteral(test2.right) && (op === '===' || op === '!==')) {
      out.push({ var: fx.keyOf.get(test2.left.argument), ver: fx.useVer.get(test2.left.argument), op: op === '===' ? 'typeis' : 'typenot', type: test2.right.value });
    }
  };
  add(test, value);
  return out;
}

function refine(a, f, evalK) {
  if (f.op === 'truthy') return { ...a, ty: a.ty & ~(T.undefined | T.null) || a.ty };
  if (f.op === 'falsy') return a;
  if (f.op === 'typeis') { const m = T[f.type === 'function' ? 'function' : f.type] ?? 0; return m ? { ...a, ty: a.ty & m || a.ty } : a; }
  if (f.op === 'typenot') { const m = T[f.type] ?? 0; return { ...a, ty: a.ty & ~m || a.ty }; }
  const k = evalK(f.k);
  if ((f.op === '!=' || f.op === '!==') && k.ty === T.null || (f.op === '!=' && k.ty === T.undefined)) return { ...a, ty: a.ty & ~(T.undefined | T.null) || a.ty };
  if (!(a.ty === T.number) || !(k.ty === T.number)) return a;
  if (f.neg && !(a.int && k.int && a.lo <= a.hi && k.lo <= k.hi)) return a;
  // yalnızca tamamen sayı olan değerlerde (NaN dışlanamaz ama NaN karşılaştırması yanlış verir: true dalda olgu geçerli)
  const r = { ...a };
  switch (f.op) {
    case '<': r.hi = Math.min(r.hi, a.int && k.int ? k.hi - 1 : k.hi); break;
    case '<=': r.hi = Math.min(r.hi, k.hi); break;
    case '>': r.lo = Math.max(r.lo, a.int && k.int ? k.lo + 1 : k.lo); break;
    case '>=': r.lo = Math.max(r.lo, k.lo); break;
    case '===': case '==': r.lo = Math.max(r.lo, k.lo); r.hi = Math.min(r.hi, k.hi); break;
    default: return a;
  }
  return r.lo > r.hi ? a : r;
}

const toNumAbs = (a) => (a.ty & ~PRIM_NONBIG ? num(-Infinity, Infinity, false, T.bigint) : a.ty === T.number ? a : num(-Infinity, Infinity, false));

function binAbs(op, l, r) {
  const prims = !(l.ty & ~PRIM_NONBIG) && !(r.ty & ~PRIM_NONBIG);
  // bir taraf kesin number ise BigInt karışımı TypeError atar: tamamlanan sonuç number'dır
  const big = prims || (op !== '+' && (l.ty === T.number || r.ty === T.number)) ? 0 : T.bigint;
  if (op === '+') {
    if (l.ty === T.string || r.ty === T.string) {
      return { ...absTop(), ty: T.string, slo: (l.ty === T.string ? l.slo : 0) + (r.ty === T.string ? r.slo : 0), shi: l.ty === T.string && r.ty === T.string ? l.shi + r.shi : Infinity };
    }
    if (l.ty === T.number && r.ty === T.number) return num(l.lo + r.lo, l.hi + r.hi, l.int && r.int);
    if (!(l.ty & (T.string | T.object | T.function)) && !(r.ty & (T.string | T.object | T.function))) return num(-Infinity, Infinity, false, big);
    return { ...absAll(), ty: T.number | T.string | big };
  }
  const L = l.ty === T.number ? l : null;
  const R = r.ty === T.number ? r : null;
  switch (op) {
    case '-': return L && R ? num(l.lo - r.hi, l.hi - r.lo, l.int && r.int) : num(-Infinity, Infinity, false, big);
    case '*': {
      if (!L || !R) return num(-Infinity, Infinity, false, big);
      const p = [l.lo * r.lo, l.lo * r.hi, l.hi * r.lo, l.hi * r.hi].map((x) => (Number.isNaN(x) ? 0 : x));
      return num(Math.min(...p), Math.max(...p), l.int && r.int);
    }
    case '%': {
      if (!L || !R) return num(-Infinity, Infinity, false, big);
      const m = Math.max(Math.abs(r.lo), Math.abs(r.hi));
      // bölen 0 olabilirse sonuç NaN olabilir: tamsayı değil
      return num(l.lo >= 0 ? 0 : -m, l.hi <= 0 ? 0 : m, l.int && r.int && (r.lo > 0 || r.hi < 0));
    }
    case '&': return num(r.ty === T.number && r.lo >= 0 && r.hi <= I32[1] ? 0 : I32[0], r.ty === T.number && r.lo >= 0 && r.hi <= I32[1] ? r.hi : I32[1], true, big);
    case '|': case '^': case '<<': case '>>': return num(I32[0], I32[1], true, big);
    case '>>>': return num(0, 2 ** 32 - 1, true, big);
    case '/': case '**': return num(-Infinity, Infinity, false, big);
    default: return { ...absTop(), ty: T.boolean };
  }
}

export function evalAbs(n, useAbs, scope) {
  const ev = (x) => evalAbs(x, useAbs, scope);
  switch (n.type) {
    case 'NumericLiteral': case 'StringLiteral': case 'BooleanLiteral': return litAbs(n.value);
    case 'NullLiteral': return litAbs(null);
    case 'TemplateLiteral': {
      const parts = n.expressions.map(ev);
      const fixed = n.quasis.reduce((s, q) => s + (q.value.cooked?.length ?? 0), 0);
      const allStr = parts.every((p) => p.ty === T.string);
      return { ...absTop(), ty: T.string, slo: fixed + (allStr ? parts.reduce((s, p) => s + p.slo, 0) : 0), shi: allStr ? fixed + parts.reduce((s, p) => s + p.shi, 0) : Infinity };
    }
    case 'Identifier': {
      const a = useAbs(n);
      if (a) return a;
      if (n.name === 'undefined' && !scope.getBinding('undefined')) return litAbs(undefined);
      if ((n.name === 'NaN' || n.name === 'Infinity') && !scope.getBinding(n.name)) return num(-Infinity, Infinity, false);
      return absAll();
    }
    case 'UnaryExpression': {
      const a = ev(n.argument);
      switch (n.operator) {
        case '!': case 'delete': return { ...absTop(), ty: T.boolean };
        case 'typeof': return { ...absTop(), ty: T.string, slo: 6, shi: 9 };
        case 'void': return litAbs(undefined);
        case '-': return a.ty === T.number ? num(-a.hi, -a.lo, a.int) : toNumAbs(a).ty === T.number ? num(-Infinity, Infinity, false) : num(-Infinity, Infinity, false, T.bigint);
        case '+': return a.ty === T.number ? a : num(-Infinity, Infinity, false);
        case '~': return num(I32[0], I32[1], true, a.ty & ~PRIM_NONBIG ? T.bigint : 0);
        default: return absAll();
      }
    }
    case 'BinaryExpression':
      if (n.operator === 'in' || n.operator === 'instanceof' || ['===', '!==', '==', '!=', '<', '<=', '>', '>='].includes(n.operator)) return { ...absTop(), ty: T.boolean };
      return binAbs(n.operator, ev(n.left), ev(n.right));
    case 'LogicalExpression': return join(ev(n.left), ev(n.right));
    case 'ConditionalExpression': return join(ev(n.consequent), ev(n.alternate));
    case 'SequenceExpression': return ev(n.expressions[n.expressions.length - 1]);
    case 'AssignmentExpression': return n.operator === '=' ? ev(n.right) : absAll();
    case 'UpdateExpression': return num(-Infinity, Infinity, false, T.bigint);
    case 'ObjectExpression': case 'ArrayExpression': case 'NewExpression': case 'RegExpLiteral': case 'ClassExpression': return { ...absTop(), ty: n.type === 'ClassExpression' ? T.function : T.object };
    case 'FunctionExpression': case 'ArrowFunctionExpression': return { ...absTop(), ty: T.function };
    case 'MemberExpression': {
      if (!n.computed && t.isIdentifier(n.property, { name: 'length' })) {
        const o = ev(n.object);
        if (o.ty === T.string) return num(o.slo, o.shi, true);
      }
      return absAll();
    }
    default: return absAll();
  }
}

/** Rapor için okunur özet */
export function describeAbs(a) {
  const out = { types: typeNames(a.ty) };
  if (a.ty === T.number || (a.ty & T.number && a.lo <= a.hi)) out.range = a.lo <= a.hi ? [a.lo, a.hi] : null;
  if (a.ty & T.number) out.integer = a.int && a.lo <= a.hi;
  if (a.ty & T.string) out.length = a.slo <= a.shi ? [a.slo, a.shi] : null;
  out.nullable = a.ty & (T.null | T.undefined) ? (a.ty & ~(T.null | T.undefined) ? 'olabilir' : 'her zaman') : 'asla';
  return out;
}
