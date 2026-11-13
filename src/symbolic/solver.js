// API: solve(constraints[], { mode: 'find'|'prove', strCap, timeMs, maxConflicts })
//        → { status:'sat', model: Map } | { status:'unsat', proof } | { status:'unknown', reason }
//      solveAsync(constraints[], { backend: 'builtin'|'z3'|'auto', ...solve seçenekleri }) → aynı sonuç + backend
//      implies(pc[], cond, opts) → { holds, proof|model }, intervalTruth(term) → true|false|null, stats (sayaçlar).
// Kanıt biçimleri: simplify | interval | exhaustive | sat-drup {checked} | type-split {cases} | z3 {checked: false}.
import { Sat, checkDrup } from './sat.js';
import { C, V, mk, types, onlyType, evaluate, vars, substitute, show, truthOf } from './ir.js';
import { parseRegex, toNfa } from './regex.js';

// Yol koşulu çözücüsü (E589/E590). Katmanlar ucuzdan pahalıya:
//   1) sadeleştirme  2) aralık akıl yürütmesi  3) küçük alanlarda tüketici sayım  4) bit-blast + CDCL SAT
// Yerleşik motor budur; z3 (src/symbolic/z3/) yalnızca solveAsync üzerinden isteğe bağlı hızlandırıcıdır.
// Neden z3 varsayılan değil: z3-solver WASM paketi ~30 MB ve tarayıcıda SharedArrayBuffer (COOP/COEP başlıkları) ister;
// statik barındırılan PEEL'de bu başlıklar yok. Gizleyicilerin kullandığı işlemler (32 bit tamsayı aritmetiği,
// bit işlemleri, karşılaştırma, sınırlı string) bit-blasting ile tam ve kesin modellenebiliyor.
//
// Sağlamlık:
//   - SAT modeli her zaman evaluate() ile gerçek JS anlamında yeniden doğrulanır; tutmazsa 'unknown'.
//   - Sayılar kesin tamsayı olarak kodlanır; ara değerler aralık analiziyle 2^53 içinde kalmıyorsa (double
//     yuvarlaması) 'unknown'. -0, karşılaştırma/bit işlemi/doğruluk bağlamında 0'dan ayırt edilemez; bölme
//     desteklenmediği için -0 gözlenemez.
//   - prove kipinde (opaque predicate kanıtı) alan kısıtlaması yapılmaz; sınırsız string ya da 'any' tip → unknown.
//   - UNSAT sonucu DRUP kanıtıyla bağımsız denetlenir.

export class Unsupported extends Error {}
const unsupported = (why) => { throw new Unsupported(why); };
const SAFE = 2 ** 53;

// ── aralıklar ─────────────────────────────────────────
function iv(x, memo) {
  if (memo.has(x)) return memo.get(x);
  const r = ivRaw(x, memo);
  memo.set(x, r);
  return r;
}
const I32 = [-(2 ** 31), 2 ** 31 - 1];
function ivRaw(x, memo) {
  if (x.k === 'c') {
    if (typeof x.v === 'number') return Number.isInteger(x.v) ? [x.v, x.v] : null;
    if (typeof x.v === 'boolean') return [+x.v, +x.v];
    if (x.v === null) return [0, 0];
    return null;
  }
  if (x.k === 'v') {
    if (x.ty === 'int32' || x.ty === 'int') return [x.lo, x.hi];
    if (x.ty === 'bool') return [0, 1];
    return null;
  }
  const A = (i) => iv(x.a[i], memo);
  const { op } = x;
  if (!onlyType(x, 'number') && !onlyType(x, 'boolean')) return null;
  switch (op) {
    case '+': case '-': case '*': {
      const a = A(0); const b = A(1);
      if (!a || !b) return null;
      if (op === '+') return [a[0] + b[0], a[1] + b[1]];
      if (op === '-') return [a[0] - b[1], a[1] - b[0]];
      const p = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
      return [Math.min(...p), Math.max(...p)];
    }
    case 'neg': { const a = A(0); return a && [-a[1], -a[0]]; }
    case 'pos': case 'tonum': return A(0);
    case '%': {
      const a = A(0); const b = A(1);
      if (!a || !b) return null;
      const m = Math.min(Math.max(Math.abs(a[0]), Math.abs(a[1])), Math.max(Math.abs(b[0]), Math.abs(b[1])) - 1);
      const lo = a[0] >= 0 ? 0 : -Math.max(0, m);
      const hi = a[1] <= 0 ? 0 : Math.max(0, m);
      return [lo, hi];
    }
    case '&': {
      const b = x.a[1];
      const a = x.a[0];
      for (const c of [a, b]) if (c.k === 'c' && Number.isInteger(c.v) && c.v >= 0 && c.v <= I32[1]) return [0, c.v];
      return I32;
    }
    case '|': case '^': case '~': case '<<': case 'imul': return I32;
    case '>>': {
      const b = x.a[1];
      const a = A(0);
      if (a && a[0] >= I32[0] && a[1] <= I32[1] && b.k === 'c' && Number.isInteger(b.v)) {
        const s = b.v & 31;
        return [Math.floor(a[0] / 2 ** s), Math.floor(a[1] / 2 ** s)];
      }
      return I32;
    }
    case '>>>': return [0, 2 ** 32 - 1];
    case 'len': return [0, capOf(x.a[0])];
    case 'charCodeAt': return [0, 65535];
    case 'indexOf': return [-1, capOf(x.a[0])];
    case 'ite': case '&&': case '||': {
      const a = op === 'ite' ? A(1) : A(0); const b = op === 'ite' ? A(2) : A(1);
      return a && b ? [Math.min(a[0], b[0]), Math.max(a[1], b[1])] : null;
    }
    default:
      if (onlyType(x, 'boolean')) return [0, 1];
      return null;
  }
}

// String teriminin azami uzunluğu (bilinmiyorsa SAFE)
function capOf(x) {
  if (x.k === 'c') return typeof x.v === 'string' ? x.v.length : SAFE;
  if (x.k === 'v') return x.cap ?? SAFE;
  switch (x.op) {
    case '+': return capOf(x.a[0]) + capOf(x.a[1]);
    case 'slice': case 'upper': case 'lower': return capOf(x.a[0]);
    case 'charAt': return 1;
    case 'typeof': case 'tostr': return 9;
    case 'ite': return Math.max(capOf(x.a[1]), capOf(x.a[2]));
    case '&&': case '||': case '??': return Math.max(capOf(x.a[0]), capOf(x.a[1]));
    default: return SAFE;
  }
}

// Aralıklarla doğruluk değeri (E601'de de kullanılır): true/false/null
export function intervalTruth(x, memo = new Map()) {
  const c = truthOf(x);
  if (c !== null) return c;
  if (x.k !== 'op') return null;
  const { op, a } = x;
  if (op === '!') { const r = intervalTruth(a[0], memo); return r === null ? null : !r; }
  if (op === '&&' || op === '||') {
    const l = intervalTruth(a[0], memo);
    const r = intervalTruth(a[1], memo);
    if (op === '&&') return l === false || r === false ? false : l === true && r === true ? true : null;
    return l === true || r === true ? true : l === false && r === false ? false : null;
  }
  if (!['<', '<=', '>', '>=', '===', '!==', '==', '!='].includes(op)) return null;
  if (!onlyType(a[0], 'number') || !onlyType(a[1], 'number')) return null;
  const l = iv(a[0], memo);
  const r = iv(a[1], memo);
  if (!l || !r) return null; // NaN olabilir ya da tamsayı değil
  // aralıklı terimler hiçbir zaman NaN değil (ivRaw yalnızca tamsayı üreten işlemlere aralık verir; % hariç)
  if (hasMod(a[0]) || hasMod(a[1])) return null;
  switch (op) {
    case '<': return l[1] < r[0] ? true : l[0] >= r[1] ? false : null;
    case '<=': return l[1] <= r[0] ? true : l[0] > r[1] ? false : null;
    case '>': return l[0] > r[1] ? true : l[1] <= r[0] ? false : null;
    case '>=': return l[0] >= r[1] ? true : l[1] < r[0] ? false : null;
    case '===': case '==': return l[1] < r[0] || l[0] > r[1] ? false : l[0] === l[1] && r[0] === r[1] && l[0] === r[0] ? true : null;
    default: return l[1] < r[0] || l[0] > r[1] ? true : l[0] === l[1] && r[0] === r[1] && l[0] === r[0] ? false : null;
  }
}
const hasMod = (x) => x.k === 'op' && (x.op === '%' || x.op === 'charCodeAt' || x.a.some(hasMod));

const sameType = (p, q) => { const a = types(p); const b = types(q); return a.size === 1 && b.size === 1 && [...a][0] === [...b][0]; };

// ── bit-blasting kodlayıcı ─────────────────────────────
class Encoder {
  constructor({ W, mode, ivMemo }) {
    this.s = new Sat();
    this.T = this.s.newVar();
    this.s.add([this.T]);
    this.F = -this.T;
    this.W = W;
    this.mode = mode;
    this.memo = new Map();
    this.vars = new Map();
    this.ivMemo = ivMemo;
  }
  nv() { return this.s.newVar(); }
  // kapılar (sabit katlamalı)
  and(a, b) {
    const { T, F } = this;
    if (a === F || b === F || a === -b) return F;
    if (a === T) return b;
    if (b === T || a === b) return a;
    const g = this.nv();
    this.s.add([-g, a]); this.s.add([-g, b]); this.s.add([g, -a, -b]);
    return g;
  }
  or(a, b) { return -this.and(-a, -b); }
  xor(a, b) {
    const { T, F } = this;
    if (a === F) return b;
    if (b === F) return a;
    if (a === T) return -b;
    if (b === T) return -a;
    if (a === b) return F;
    if (a === -b) return T;
    const g = this.nv();
    this.s.add([-g, a, b]); this.s.add([-g, -a, -b]); this.s.add([g, -a, b]); this.s.add([g, a, -b]);
    return g;
  }
  mux(c, a, b) {
    const { T, F } = this;
    if (c === T || a === b) return a;
    if (c === F) return b;
    if (a === T && b === F) return c;
    if (a === F && b === T) return -c;
    return this.or(this.and(c, a), this.and(-c, b));
  }
  andN(xs) { return xs.reduce((p, x) => this.and(p, x), this.T); }
  orN(xs) { return xs.reduce((p, x) => this.or(p, x), this.F); }
  // bit vektörleri (LSB önce, ikiye tümleyen)
  bconst(n, w) {
    let v = BigInt.asUintN(w, BigInt(n));
    const out = [];
    for (let i = 0; i < w; i++) { out.push(v & 1n ? this.T : this.F); v >>= 1n; }
    return out;
  }
  sext(A, w) { const out = A.slice(0, w); while (out.length < w) out.push(A[A.length - 1]); return out; }
  zext(A, w) { const out = A.slice(0, w); while (out.length < w) out.push(this.F); return out; }
  addc(A, B, cin) {
    const out = [];
    let c = cin;
    for (let i = 0; i < A.length; i++) {
      const x = this.xor(A[i], B[i]);
      out.push(this.xor(x, c));
      c = this.or(this.and(A[i], B[i]), this.and(c, x));
    }
    return out;
  }
  add(A, B) { return this.addc(A, B, this.F); }
  sub(A, B) { return this.addc(A, B.map((b) => -b), this.T); }
  neg(A) { return this.sub(A.map(() => this.F), A); }
  mul(A, B) {
    let acc = A.map(() => this.F);
    for (let i = 0; i < B.length; i++) {
      if (B[i] === this.F) continue;
      const part = A.map((_, k) => (k < i ? this.F : this.and(A[k - i], B[i])));
      acc = this.add(acc, part);
    }
    return acc;
  }
  eq(A, B) { return this.andN(A.map((a, i) => -this.xor(a, B[i]))); }
  slt(A, B) { const w = A.length + 1; return this.sub(this.sext(A, w), this.sext(B, w))[w - 1]; }
  ult(A, B) { const w = A.length + 1; return this.sub(this.zext(A, w), this.zext(B, w))[w - 1]; }
  // sabite göre işaretsiz karşılaştırma
  ugeConst(A, k) { return -this.ult(A, this.bconst(k, A.length)); }
  uleConst(A, k) { return -this.ult(this.bconst(k, A.length), A); }
  inRanges(ch, ranges) { return this.orN(ranges.map(([lo, hi]) => this.and(this.ugeConst(ch, lo), this.uleConst(ch, hi)))); }
  shiftConst(A, k, kind) {
    const w = A.length;
    return A.map((_, i) => {
      if (kind === 'shl') return i - k >= 0 ? A[i - k] : this.F;
      const j = i + k;
      if (j < w) return A[j];
      return kind === 'sar' ? A[w - 1] : this.F;
    });
  }
  shiftVar(A, S, kind) {
    let cur = A;
    for (let b = 0; b < S.length; b++) {
      const sh = this.shiftConst(cur, 1 << b, kind);
      cur = cur.map((x, i) => this.mux(S[b], sh[i], x));
    }
    return cur;
  }
  bitsOf(n) { return { t: 'n', b: this.bconst(n, this.W), nan: this.F }; }

  // ── değerler ────────────────────────────────────────
  // {t:'n', b, nan} | {t:'s', len, ch, cap} | {t:'b', l} | {t:'u'} | {t:'z'}  (u: undefined, z: null)
  enc(x) {
    if (this.memo.has(x)) return this.memo.get(x);
    const r = this.encRaw(x);
    this.memo.set(x, r);
    return r;
  }

  numVar(x) {
    const w = this.W;
    const b = Array.from({ length: w }, () => this.nv());
    const lo = x.lo ?? I32[0];
    const hi = x.hi ?? I32[1];
    this.s.add([-this.slt(b, this.bconst(lo, w))]);
    this.s.add([-this.slt(this.bconst(hi, w), b)]);
    return { t: 'n', b, nan: this.F };
  }

  strConst(v) {
    const cap = v.length;
    return { t: 's', cap, len: this.bconst(cap, this.lenBits(cap)), ch: [...v].map((_, i) => this.bconst(v.charCodeAt(i), 16)) };
  }
  lenBits(cap) { return Math.max(1, Math.ceil(Math.log2(cap + 1))) + 1; }

  encRaw(x) {
    if (x.k === 'c') {
      const v = x.v;
      if (typeof v === 'number') {
        if (Number.isNaN(v)) return { t: 'n', b: this.bconst(0, this.W), nan: this.T };
        if (!Number.isInteger(v) || Math.abs(v) >= SAFE) unsupported('tamsayı olmayan sabit');
        return this.bitsOf(v);
      }
      if (typeof v === 'string') { if (v.length > 64) unsupported('uzun string sabiti'); return this.strConst(v); }
      if (typeof v === 'boolean') return { t: 'b', l: v ? this.T : this.F };
      if (v === undefined) return { t: 'u' };
      if (v === null) return { t: 'z' };
      unsupported('nesne sabiti');
    }
    if (x.k === 'v') {
      if (this.vars.has(x.name)) return this.vars.get(x.name).val;
      let val;
      if (x.ty === 'int32' || x.ty === 'int') val = this.numVar(x);
      else if (x.ty === 'bool') val = { t: 'b', l: this.nv() };
      else if (x.ty === 'undef') val = { t: 'u' };
      else if (x.ty === 'null') val = { t: 'z' };
      else if (x.ty === 'str') {
        if (x.cap === undefined) unsupported('sınırsız string');
        const cap = x.cap;
        const len = Array.from({ length: this.lenBits(cap) }, () => this.nv());
        this.s.add([this.uleConst(len, cap)]);
        const ch = Array.from({ length: cap }, () => Array.from({ length: 16 }, () => this.nv()));
        // find kipinde okunabilir tanıklar için yazdırılabilir ASCII (model yine gerçek anlamla doğrulanır)
        if (this.mode === 'find') for (const c of ch) this.s.add([this.inRanges(c, [[32, 126]])]);
        val = { t: 's', cap, len, ch };
      } else unsupported(`tip: ${x.ty}`);
      this.vars.set(x.name, { term: x, val });
      return val;
    }
    return this.encOp(x);
  }

  num(x) {
    const e = this.enc(x);
    if (e.t === 'n') return e;
    if (e.t === 'b') return { t: 'n', b: this.zext([e.l], this.W), nan: this.F };
    if (e.t === 'z') return this.bitsOf(0);
    if (e.t === 'u') return { t: 'n', b: this.bconst(0, this.W), nan: this.T };
    return unsupported('string → sayı dönüşümü');
  }
  truth(x) {
    const e = this.enc(x);
    switch (e.t) {
      case 'b': return e.l;
      case 'n': return this.and(-e.nan, this.orN(e.b));
      case 's': return this.orN(e.len);
      default: return this.F;
    }
  }
  int32(n) { return this.sext(n.b.slice(0, 32).map((b) => this.and(-n.nan, b)), this.W); }

  strEq(A, B) {
    const w = Math.max(A.len.length, B.len.length);
    const parts = [this.eq(this.zext(A.len, w), this.zext(B.len, w))];
    for (let k = 0; k < Math.min(A.cap, B.cap); k++) {
      const inside = this.ult(this.bconst(k, A.len.length), A.len);
      parts.push(this.or(-inside, this.eq(A.ch[k], B.ch[k])));
    }
    return this.andN(parts);
  }
  // uzunluğun tek-sıcak gösterimi: lenIs[l] = (len === l)
  lenIs(S) { return Array.from({ length: S.cap + 1 }, (_, l) => this.eq(S.len, this.bconst(l, S.len.length))); }
  strLess(A, B) {
    // sözlük sırası: k. konumda ilk farklılık ya da A'nın önek olması
    let lt = this.F;
    for (let k = Math.max(A.cap, B.cap); k >= 0; k--) {
      const aHas = k < A.cap ? this.ult(this.bconst(k, A.len.length), A.len) : this.F;
      const bHas = k < B.cap ? this.ult(this.bconst(k, B.len.length), B.len) : this.F;
      if (k >= A.cap && k >= B.cap) continue;
      const a = k < A.cap ? A.ch[k] : this.bconst(0, 16);
      const b = k < B.cap ? B.ch[k] : this.bconst(0, 16);
      const both = this.and(aHas, bHas);
      const here = this.or(this.and(both, this.ult(a, b)), this.and(-aHas, bHas));
      lt = this.or(here, this.and(this.and(both, this.eq(a, b)), lt));
    }
    return lt;
  }
  strMux(c, A, B) {
    const cap = Math.max(A.cap, B.cap);
    const lw = Math.max(A.len.length, B.len.length);
    const zero = this.bconst(0, 16);
    return {
      t: 's', cap,
      len: this.zext(A.len, lw).map((a, i) => this.mux(c, a, this.zext(B.len, lw)[i])),
      ch: Array.from({ length: cap }, (_, k) => (A.ch[k] ?? zero).map((a, i) => this.mux(c, a, (B.ch[k] ?? zero)[i]))),
    };
  }
  // len'in her olası değeri için somut hesaplanan bir dönüşüm (slice, endsWith, toUpperCase…)
  byLength(S, fn) {
    const is = this.lenIs(S);
    let out = null;
    for (let l = S.cap; l >= 0; l--) {
      const v = fn(l);
      out = out === null ? v : this.muxVal(is[l], v, out);
    }
    return out;
  }
  muxVal(c, a, b) {
    if (a.t !== b.t) unsupported('karışık tipli seçim');
    if (a.t === 'b') return { t: 'b', l: this.mux(c, a.l, b.l) };
    if (a.t === 'n') return { t: 'n', b: a.b.map((x, i) => this.mux(c, x, b.b[i])), nan: this.mux(c, a.nan, b.nan) };
    if (a.t === 's') return this.strMux(c, a, b);
    return a;
  }

  encOp(x) {
    const { op, a } = x;
    const W = this.W;
    // karışık tipli ite argümanı (ör. dizi seçimi: ite(i===k, sayı, undefined)) işlemin içine dağıtılır
    if (op !== 'ite') {
      const k = a.findIndex((e) => e.k === 'op' && e.op === 'ite' && !sameType(e.a[1], e.a[2]));
      if (k >= 0) {
        const branch = (b) => mk(op, ...a.map((e, j) => (j === k ? b : e)));
        return this.enc(mk('ite', a[k].a[0], branch(a[k].a[1]), branch(a[k].a[2])));
      }
    }
    const N = (i) => this.num(a[i]);
    const S = (i) => { const e = this.enc(a[i]); if (e.t !== 's') unsupported('string bekleniyordu'); return e; };
    const constStr = (i) => (a[i].k === 'c' && typeof a[i].v === 'string' ? a[i].v : unsupported('sabit olmayan string argümanı'));
    const constInt = (i) => (a[i].k === 'c' && Number.isInteger(a[i].v) ? a[i].v : a[i].k === 'c' && a[i].v === undefined ? undefined : unsupported('sabit olmayan indeks'));
    switch (op) {
      case '+': {
        const l = this.enc(a[0]); const r = this.enc(a[1]);
        if (l.t === 's' || r.t === 's') {
          if (l.t !== 's' || r.t !== 's') unsupported('sayı → string dönüşümü');
          const cap = l.cap + r.cap;
          if (cap > 64) unsupported('string kapasitesi');
          const lw = this.lenBits(cap);
          const len = this.add(this.zext(l.len, lw), this.zext(r.len, lw));
          const isL = this.lenIs(l);
          const zero = this.bconst(0, 16);
          const ch = [];
          for (let k = 0; k < cap; k++) {
            let c = zero;
            for (let la = l.cap; la >= 0; la--) {
              const v = k < la ? l.ch[k] : (r.ch[k - la] ?? zero);
              c = la === l.cap ? v : v.map((bit, i) => this.mux(isL[la], bit, c[i]));
            }
            ch.push(c);
          }
          return { t: 's', cap, len, ch };
        }
        const A = N(0); const B = N(1);
        return { t: 'n', b: this.add(A.b, B.b), nan: this.or(A.nan, B.nan) };
      }
      case '-': { const A = N(0); const B = N(1); return { t: 'n', b: this.sub(A.b, B.b), nan: this.or(A.nan, B.nan) }; }
      case '*': { const A = N(0); const B = N(1); return { t: 'n', b: this.mul(A.b, B.b), nan: this.or(A.nan, B.nan) }; }
      case 'neg': { const A = N(0); return { t: 'n', b: this.neg(A.b), nan: A.nan }; }
      case 'pos': case 'tonum': return N(0);
      case '%': {
        const A = N(0); const B = N(1);
        const nan = this.orN([A.nan, B.nan, this.eq(B.b, this.bconst(0, W))]);
        const Q = Array.from({ length: W }, () => this.nv());
        const R = Array.from({ length: W }, () => this.nv());
        const w2 = 2 * W;
        const lhs = this.sext(A.b, w2);
        const rhs = this.add(this.mul(this.sext(Q, w2), this.sext(B.b, w2)), this.sext(R, w2));
        const abs = (X) => { const e = this.sext(X, W + 1); const ne = this.neg(e); return e.map((bit, i) => this.mux(e[W], ne[i], bit)); };
        const conds = [
          this.eq(lhs, rhs),
          this.ult(abs(R), abs(B.b)),
          this.or(this.eq(R, this.bconst(0, W)), -this.xor(R[W - 1], A.b[W - 1])),
        ];
        for (const c of conds) this.s.add([nan, c]);
        return { t: 'n', b: R, nan };
      }
      case '&': case '|': case '^': {
        const A = this.int32(N(0)); const B = this.int32(N(1));
        const f = op === '&' ? (p, q) => this.and(p, q) : op === '|' ? (p, q) => this.or(p, q) : (p, q) => this.xor(p, q);
        return { t: 'n', b: this.sext(A.slice(0, 32).map((p, i) => f(p, B[i])), W), nan: this.F };
      }
      case '~': return { t: 'n', b: this.sext(this.int32(N(0)).slice(0, 32).map((p) => -p), W), nan: this.F };
      case 'imul': {
        // Math.imul: tam çarpımın alt 32 biti (64 bitte kesin), işaretle genişletilir
        const A = this.sext(this.int32(N(0)).slice(0, 32), 64);
        const B = this.sext(this.int32(N(1)).slice(0, 32), 64);
        return { t: 'n', b: this.sext(this.mul(A, B).slice(0, 32), W), nan: this.F };
      }
      case '<<': case '>>': case '>>>': {
        const A = this.int32(N(0)).slice(0, 32);
        const Bn = N(1);
        const sh = Bn.b.slice(0, 5).map((b) => this.and(-Bn.nan, b));
        const kind = op === '<<' ? 'shl' : op === '>>' ? 'sar' : 'shr';
        const r = this.shiftVar(A, sh, kind);
        return { t: 'n', b: op === '>>>' ? this.zext(r, W) : this.sext(r, W), nan: this.F };
      }
      case '===': case '!==': case '==': case '!=': {
        const l = this.enc(a[0]); const r = this.enc(a[1]);
        let eq;
        const loose = op === '==' || op === '!=';
        const nullish = (e) => e.t === 'u' || e.t === 'z';
        if (l.t === r.t) {
          if (l.t === 'n') eq = this.andN([-l.nan, -r.nan, this.eq(l.b, r.b)]);
          else if (l.t === 's') eq = this.strEq(l, r);
          else if (l.t === 'b') eq = -this.xor(l.l, r.l);
          else eq = this.T;
        } else if (loose && nullish(l) && nullish(r)) eq = this.T;
        else if (loose && (nullish(l) || nullish(r))) eq = this.F;
        else if (loose && (l.t === 's' || r.t === 's')) unsupported('== ile string dönüşümü');
        else if (loose) { const A = this.num(a[0]); const B = this.num(a[1]); eq = this.andN([-A.nan, -B.nan, this.eq(A.b, B.b)]); }
        else eq = this.F;
        return { t: 'b', l: op === '===' || op === '==' ? eq : -eq };
      }
      case '<': case '<=': case '>': case '>=': {
        const l = this.enc(a[0]); const r = this.enc(a[1]);
        const [x, y, strict] = op === '<' ? [l, r, true] : op === '>' ? [r, l, true] : op === '<=' ? [r, l, false] : [l, r, false];
        if (l.t === 's' && r.t === 's') {
          // a <= b ≡ !(b < a)
          return { t: 'b', l: strict ? this.strLess(x, y) : -this.strLess(x, y) };
        }
        if (l.t === 's' || r.t === 's') unsupported('karışık karşılaştırma');
        const A = this.num(a[0]);
        const B = this.num(a[1]);
        const notNan = this.and(-A.nan, -B.nan);
        // a<b: slt(a,b); a>b: slt(b,a); a<=b: !slt(b,a); a>=b: !slt(a,b)  (NaN varsa hepsi false)
        const lt = op === '<' || op === '>=' ? this.slt(A.b, B.b) : this.slt(B.b, A.b);
        return { t: 'b', l: this.and(notNan, op === '<' || op === '>' ? lt : -lt) };
      }
      case '!': return { t: 'b', l: -this.truth(a[0]) };
      case 'truthy': return { t: 'b', l: this.truth(a[0]) };
      case 'ite': return this.muxVal(this.truth(a[0]), this.enc(a[1]), this.enc(a[2]));
      case '&&': return this.muxVal(this.truth(a[0]), this.enc(a[1]), this.enc(a[0]));
      case '||': return this.muxVal(this.truth(a[0]), this.enc(a[0]), this.enc(a[1]));
      case '??': {
        const l = this.enc(a[0]);
        return l.t === 'u' || l.t === 'z' ? this.enc(a[1]) : l;
      }
      case 'len': { const s = S(0); return { t: 'n', b: this.zext(s.len, W), nan: this.F }; }
      case 'charCodeAt': case 'charAt': {
        const s = S(0);
        const i = a[1] ? N(1) : this.bitsOf(0);
        const idx = i.b.map((b) => this.and(-i.nan, b)); // ToIntegerOrInfinity(NaN) = 0
        const hits = s.ch.map((_, k) => this.and(this.eq(idx, this.bconst(k, W)), this.ult(this.bconst(k, s.len.length), s.len)));
        const valid = this.orN(hits);
        const code = Array.from({ length: 16 }, (_, bit) => this.orN(hits.map((h, k) => this.and(h, s.ch[k][bit]))));
        if (op === 'charCodeAt') return { t: 'n', b: this.zext(code, W), nan: -valid };
        return { t: 's', cap: 1, len: [valid, this.F], ch: [code] };
      }
      case 'startsWith': case 'endsWith': case 'includes': case 'indexOf': {
        const s = S(0);
        const needle = constStr(1);
        if (a.length > 2) unsupported('konum argümanı');
        const m = needle.length;
        const matchAt = (p) => this.andN([...needle].map((c, k) => (p + k < s.cap ? this.eq(s.ch[p + k], this.bconst(c.charCodeAt(0), 16)) : this.F)));
        const fits = (p) => this.ugeConst(s.len, p + m);
        if (op === 'startsWith') return { t: 'b', l: this.and(fits(0), matchAt(0)) };
        if (op === 'endsWith') return this.byLength(s, (l) => ({ t: 'b', l: l >= m ? matchAt(l - m) : this.F }));
        const at = [];
        for (let p = 0; p + m <= s.cap; p++) at.push(this.and(fits(p), matchAt(p)));
        if (op === 'includes') return { t: 'b', l: this.orN(at) };
        let res = this.bconst(-1, W);
        for (let p = at.length - 1; p >= 0; p--) res = res.map((b, i) => this.mux(at[p], this.bconst(p, W)[i], b));
        return { t: 'n', b: res, nan: this.F };
      }
      case 'slice': {
        const s = S(0);
        const from = constInt(1) ?? 0;
        const to = a.length > 2 ? constInt(2) : undefined;
        return this.byLength(s, (l) => {
          const f = from < 0 ? Math.max(l + from, 0) : Math.min(from, l);
          const e = to === undefined ? l : to < 0 ? Math.max(l + to, 0) : Math.min(to, l);
          const n = Math.max(e - f, 0);
          return { t: 's', cap: n, len: this.bconst(n, this.lenBits(n)), ch: s.ch.slice(f, f + n) };
        });
      }
      case 'upper': case 'lower': {
        if (this.mode !== 'find') unsupported('büyük/küçük harf (yalnızca ASCII modelleniyor)');
        const s = S(0);
        const [lo, hi, d] = op === 'upper' ? [97, 122, -32] : [65, 90, 32];
        const ch = s.ch.map((c) => {
          const inR = this.and(this.ugeConst(c, lo), this.uleConst(c, hi));
          const shifted = this.add(c, this.bconst(d, 16));
          // ASCII dışı karakterlerin eşlemesi modellenmiyor: tanık modeli gerçek anlamla yine doğrulanır
          return c.map((b, i) => this.mux(inR, shifted[i], b));
        });
        return { ...s, ch };
      }
      case 'typeof': {
        const e = this.enc(a[0]);
        const name = { n: 'number', s: 'string', b: 'boolean', u: 'undefined', z: 'object' }[e.t];
        return this.strConst(name);
      }
      case 'tostr': {
        const e = this.enc(a[0]);
        if (e.t === 'b') return this.strMux(e.l, this.strConst('true'), this.strConst('false'));
        if (e.t === 's') return e;
        if (e.t === 'u') return this.strConst('undefined');
        if (e.t === 'z') return this.strConst('null');
        return unsupported('sayı → string');
      }
      case 'retest': return { t: 'b', l: this.regex(a[0].v, a[1].v, S(2)) };
      default: return unsupported(`işlem: ${op}`);
    }
  }

  regex(src, flags, s) {
    const parsed = parseRegex(src, flags);
    const nfa = parsed && toNfa(parsed, 400);
    if (!nfa) unsupported('regex alt kümesi dışında');
    const { states, start, accept } = nfa;
    const isL = this.lenIs(s);
    // reach[i][q]: i karakter tüketildikten sonra q durumunda olunabilir mi
    let cur = states.map(() => this.F);
    for (const q of states[start].closure) cur[q] = this.T;
    const accepted = [];
    // i. adımdaki durumlar zaten len ≥ i koşuluna bağlı; sona çapalıysa len === i de gerekir
    const accAt = (i, set) => (nfa.anchoredEnd ? this.and(isL[i], set[accept]) : set[accept]);
    accepted.push(nfa.anchoredEnd ? this.and(isL[0], cur[accept]) : cur[accept]);
    const edgeCache = new Map();
    for (let i = 0; i < s.cap; i++) {
      const next = states.map(() => this.F);
      const active = this.ugeConst(s.len, i + 1);
      states.forEach((st, q) => {
        if (cur[q] === this.F) return;
        for (const e of st.edges) {
          const key = `${i}:${JSON.stringify(e.r)}`;
          if (!edgeCache.has(key)) edgeCache.set(key, this.inRanges(s.ch[i], e.r));
          const step = this.andN([cur[q], active, edgeCache.get(key)]);
          for (const x of states[e.to].closure) next[x] = this.or(next[x], step);
        }
      });
      if (!nfa.anchoredStart) for (const x of states[start].closure) next[x] = this.or(next[x], active);
      cur = next;
      accepted.push(accAt(i + 1, cur));
    }
    return this.orN(accepted);
  }

  decode(model) {
    const out = new Map();
    const bit = (l) => (l === this.T ? 1 : l === this.F ? 0 : (l > 0 ? model[l] : -model[-l]) === 1 ? 1 : 0);
    const int = (bits, signed) => {
      let v = 0n;
      for (let i = bits.length - 1; i >= 0; i--) v = (v << 1n) | BigInt(bit(bits[i]));
      return Number(signed ? BigInt.asIntN(bits.length, v) : v);
    };
    for (const [name, { val }] of this.vars) {
      if (val.t === 'n') out.set(name, int(val.b, true));
      else if (val.t === 'b') out.set(name, Boolean(bit(val.l)));
      else if (val.t === 'u') out.set(name, undefined);
      else if (val.t === 'z') out.set(name, null);
      else {
        const len = int(val.len, false);
        out.set(name, String.fromCharCode(...val.ch.slice(0, len).map((c) => int(c, false))));
      }
    }
    return out;
  }
}

// ── tip bölme (E599) ───────────────────────────────────
const FIND_TYPES = ['int32', 'str', 'bool', 'undef', 'null'];
function typeSplits(vs, mode, strCap) {
  const list = [...vs.values()];
  let combos = [new Map()];
  for (const v of list) {
    let opts;
    if (v.ty === 'any') {
      if (mode === 'prove') return null;
      opts = FIND_TYPES;
    } else if (v.ty === 'num') {
      if (mode === 'prove') return null;
      opts = ['int32'];
    } else opts = [v.ty];
    const next = [];
    for (const c of combos) for (const o of opts) {
      const m = new Map(c);
      const extra = o === 'str' ? { cap: v.cap ?? (mode === 'find' ? strCap : undefined) } : o === v.ty ? { lo: v.lo, hi: v.hi } : {};
      m.set(v.name, o === v.ty && v.ty !== 'str' ? v : V(v.name, o, extra));
      next.push(m);
    }
    combos = next;
    if (combos.length > 125) return null;
  }
  return combos;
}

// ── tüketici sayım ─────────────────────────────────────
const MAX_ENUM = 4096;
function domainOf(v) {
  if (v.ty === 'bool') return [false, true];
  if (v.ty === 'undef') return [undefined];
  if (v.ty === 'null') return [null];
  if ((v.ty === 'int32' || v.ty === 'int') && v.hi - v.lo < MAX_ENUM) return Array.from({ length: v.hi - v.lo + 1 }, (_, i) => v.lo + i);
  return null;
}
function enumerate(cs, vs) {
  const list = [...vs.values()];
  const doms = list.map(domainOf);
  if (doms.some((d) => !d)) return null;
  const total = doms.reduce((p, d) => p * d.length, 1);
  if (total > MAX_ENUM) return null;
  const idx = list.map(() => 0);
  for (let n = 0; n < total; n++) {
    const model = new Map(list.map((v, i) => [v.name, doms[i][idx[i]]]));
    let ok = true;
    for (const c of cs) {
      try { if (!evaluate(c, model)) { ok = false; break; } } catch { ok = false; break; }
    }
    if (ok) return { status: 'sat', model };
    for (let i = 0; i < idx.length; i++) { if (++idx[i] < doms[i].length) break; idx[i] = 0; }
  }
  return { status: 'unsat', proof: { method: 'exhaustive', cases: total, vars: list.map((v) => `${v.name}∈[${doms[list.indexOf(v)].length}]`) } };
}

// Bit genişliği: tüm sayısal ara terimler kesin tamsayı aralığında olmalı (z3 çevirisi de aynı genişliği kullanır)
export function numericWidth(live) {
  const memo = new Map();
  let maxAbs = 2 ** 33;
  let exact = true;
  const walk = (x) => {
    if (x.k === 'op') x.a.forEach(walk);
    if (!onlyType(x, 'number')) return;
    const r = iv(x, memo);
    if (!r) { if (!(x.k === 'c' && Number.isNaN(x.v)) && !(x.k === 'op' && (x.op === '%' || x.op === 'charCodeAt'))) exact = false; return; }
    maxAbs = Math.max(maxAbs, Math.abs(r[0]), Math.abs(r[1]));
  };
  live.forEach(walk);
  if (!exact) return { reason: 'tamsayı olmayan ya da aralıksız sayı' };
  if (maxAbs >= SAFE) return { reason: 'ara değer 2^53 sınırını aşabilir (double yuvarlaması)' };
  return { W: Math.ceil(Math.log2(maxAbs + 1)) + 2, memo };
}

/**
 * Arka uç seçmeli çözüm: 'builtin' (CDCL + bit-blast, DRUP denetimli), 'z3' (isteğe bağlı z3-solver; Node ya da
 * cross-origin isolated tarayıcıda worker), 'auto' (önce yerleşik, bilinmiyorsa ve z3 varsa z3).
 * z3'ün SAT modeli JS anlamıyla yeniden doğrulanır; UNSAT'ı denetlenmemiş kanıt ({ method: 'z3', checked: false })
 * taşır: kod değiştiren tüketiciler (opaque-smt, korelasyon, E716) yalnızca denetlenmiş kanıta güvenir.
 * @returns {Promise<{status, backend, model?, proof?, reason?}>}
 */
export async function solveAsync(constraints, { backend = 'auto', ...o } = {}) {
  if (backend !== 'z3') {
    const r = { ...solve(constraints, o), backend: 'builtin' };
    if (r.status !== 'unknown' || backend === 'builtin') return r;
    const { z3Available } = await import('./z3/z3.js');
    if (!(await z3Available())) return r;
  }
  const { z3Solve } = await import('./z3/z3.js');
  const prep = z3Prepare(constraints);
  if (prep.reason) return { status: 'unknown', backend: 'z3', reason: prep.reason };
  const z = await z3Solve(prep, o.timeMs ?? 5000);
  if (z.status === 'sat') {
    const model = new Map(Object.entries(z.model ?? {}));
    for (const v of prep.vars) if (!model.has(v.name)) model.set(v.name, sample(v));
    try { if (prep.live.every((c) => evaluate(c, model))) return { status: 'sat', backend: 'z3', model }; } catch { /* aşağıda */ }
    return { status: 'unknown', backend: 'z3', reason: 'z3 modeli JS anlamıyla doğrulanamadı' };
  }
  if (z.status === 'unsat') return { status: 'unsat', backend: 'z3', proof: { method: 'z3', checked: false } };
  return { status: 'unknown', backend: 'z3', reason: z.reason ?? 'z3: bilinmiyor' };
}

// z3'e gidecek tipli kısıtlar: 'any'/'num'/sınırsız string değişkenleri desteklenmez; karışık tipli ite dağıtılır
function z3Prepare(constraints) {
  const live = constraints.map((c) => distributeIte(mk('truthy', c))).filter((c) => !(c.k === 'c' && c.v));
  if (live.some((c) => c.k === 'c')) return { live: [], vars: [], W: 34, terms: [C(false)] };
  const vs = new Map();
  for (const c of live) vars(c, vs);
  for (const v of vs.values()) if (!['int32', 'int', 'bool'].includes(v.ty)) return { reason: `z3: desteklenmeyen değişken tipi ${v.ty}` };
  const wd = numericWidth(live);
  if (wd.reason) return { reason: wd.reason };
  return { live, terms: live, vars: [...vs.values()].map((v) => ({ name: v.name, ty: v.ty, lo: v.lo, hi: v.hi })), W: wd.W };
}
export function distributeIte(x) {
  if (x.k !== 'op') return x;
  const a = x.a.map(distributeIte);
  if (x.op !== 'ite') {
    const k = a.findIndex((e) => e.k === 'op' && e.op === 'ite' && !sameType(e.a[1], e.a[2]));
    if (k >= 0) return distributeIte(mk('ite', a[k].a[0], mk(x.op, ...a.map((e, j) => (j === k ? a[k].a[1] : e))), mk(x.op, ...a.map((e, j) => (j === k ? a[k].a[2] : e)))));
  }
  return mk(x.op, ...a);
}
// ── ana giriş ──────────────────────────────────────────
export const stats = { calls: 0, sat: 0, unsat: 0, unknown: 0, satCalls: 0, ms: 0 };

/**
 * @param {object[]} constraints  hepsinin doğru (truthy) olması istenen IR terimleri
 * @param {{mode?:'find'|'prove', strCap?:number, maxConflicts?:number, timeMs?:number}} o
 * @returns {{status:'sat',model:Map}|{status:'unsat',proof:object}|{status:'unknown',reason:string}}
 */
export function solve(constraints, { mode = 'find', strCap = 12, maxConflicts = 30000, timeMs = 1500 } = {}) {
  const t0 = Date.now();
  stats.calls++;
  const done = (r) => { stats[r.status]++; stats.ms += Date.now() - t0; return r; };
  let cs = constraints.map((c) => mk('truthy', c));
  for (const c of cs) {
    if (c.k === 'c' && !c.v) return done({ status: 'unsat', proof: { method: 'simplify', fact: show(constraints[cs.indexOf(c)]) } });
  }
  cs = cs.filter((c) => !(c.k === 'c' && c.v));
  if (!cs.length) return done({ status: 'sat', model: new Map() });
  const all = new Map();
  for (const c of cs) vars(c, all);
  const splits = typeSplits(all, mode, strCap);
  if (!splits) return done({ status: 'unknown', reason: 'tipi bilinmeyen değişken' });
  const proofs = [];
  let unknown = null;
  for (const sub of splits) {
    const inst = cs.map((c) => mk('truthy', substitute(c, sub)));
    const vs = new Map();
    for (const c of inst) vars(c, vs);
    const r = solveTyped(inst, vs, { mode, maxConflicts, deadline: t0 + timeMs });
    if (r.status === 'sat') return done(r);
    if (r.status === 'unknown') unknown = r;
    else proofs.push({ types: Object.fromEntries([...vs.values()].map((v) => [v.name, v.ty])), ...r.proof });
  }
  if (unknown) return done(unknown);
  return done({ status: 'unsat', proof: proofs.length === 1 ? proofs[0] : { method: 'type-split', cases: proofs } });
}

function solveTyped(cs, vs, { mode, maxConflicts, deadline }) {
  for (const c of cs) {
    if (c.k === 'c') { if (!c.v) return { status: 'unsat', proof: { method: 'simplify', fact: 'false' } }; continue; }
    const r = intervalTruth(c);
    if (r === false) return { status: 'unsat', proof: { method: 'interval', fact: show(c) } };
  }
  const live = cs.filter((c) => !(c.k === 'c' && c.v));
  if (!live.length) return { status: 'sat', model: new Map([...vs.values()].map((v) => [v.name, sample(v)])) };
  const en = enumerate(live, vs);
  if (en) return en;
  const wd = numericWidth(live);
  if (wd.reason) return { status: 'unknown', reason: wd.reason };
  const { W, memo } = wd;
  let enc;
  try {
    enc = new Encoder({ W, mode, ivMemo: memo });
    for (const c of live) enc.s.add([enc.truth(c)]);
  } catch (e) {
    if (e instanceof Unsupported) return { status: 'unknown', reason: e.message };
    throw e;
  }
  stats.satCalls++;
  const r = enc.s.solve({ maxConflicts, deadline });
  if (r.status === 'sat') {
    const model = enc.decode(r.model);
    for (const v of vs.values()) if (!model.has(v.name)) model.set(v.name, sample(v));
    try {
      if (live.every((c) => evaluate(c, model))) return { status: 'sat', model };
    } catch { /* aşağıda */ }
    return { status: 'unknown', reason: 'SAT modeli JS anlamıyla doğrulanamadı' };
  }
  if (r.status === 'unsat') {
    const check = enc.s.clauses.length < 200000 ? checkDrup(enc.s.n, enc.s.clauses, r.proof) : { ok: false, reason: 'çok büyük' };
    // RUP başarısızlığı çözücü hatası demektir: sonuca güvenme (bütçe aşımı ise sonuç denetimsiz işaretlenir)
    if (!check.ok && check.reason !== 'bütçe' && check.reason !== 'çok büyük') return { status: 'unknown', reason: `kanıt denetimi: ${check.reason}` };
    return { status: 'unsat', proof: { method: 'sat-drup', vars: enc.s.n, clauses: enc.s.clauses.length, lemmas: r.proof.length, width: W, checked: check.ok, checkNote: check.reason ?? null } };
  }
  return { status: 'unknown', reason: 'SAT bütçesi doldu' };
}

function sample(v) {
  if (v.ty === 'bool') return false;
  if (v.ty === 'str') return '';
  if (v.ty === 'undef') return undefined;
  if (v.ty === 'null') return null;
  return Math.max(v.lo ?? 0, Math.min(0, v.hi ?? 0));
}

/** pc ∧ ¬c tatmin edilemiyorsa c pc altında hep doğrudur (E593 dallanma korelasyonu, E592 opaque) */
export function implies(pc, c, o) {
  const r = solve([...pc, mk('!', c)], o);
  return r.status === 'unsat' ? { holds: true, proof: r.proof } : { holds: false, model: r.model ?? null, reason: r.reason };
}

export { C };
