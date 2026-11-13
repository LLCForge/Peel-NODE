// Sembolik IR (src/symbolic/ir.js) → Z3 bit-vektör çevirisi; Node arka ucu ve tarayıcı worker'ı ortak kullanır.
// Anlam solver.js'deki bit-blast kodlayıcısıyla aynıdır: sayılar W bitte kesin tamsayı + NaN bayrağı,
// bit işlemleri ToInt32 üzerinden, karşılaştırmalar NaN'da yanlış. Stringler desteklenmez (çağıran 'unknown' alır).

/** prep: { terms, vars: [{name, ty, lo, hi}], W } */
function translator(Z, W) {
  const memo = new Map();
  const ZERO = () => Z.BitVec.val(0n, W);
  const FALSE = () => Z.Bool.val(false);
  const bv = (v) => Z.BitVec.val(BigInt.asUintN(W, BigInt(v)), W);
  const unsupported = (why) => { throw new Error(`z3 çevirisi: ${why}`); };
  const num = (e) => {
    if (e.k === 'n') return e;
    if (e.k === 'b') return { k: 'n', b: Z.If(e.b, bv(1), ZERO()), nan: FALSE() };
    if (e.k === 'z') return { k: 'n', b: ZERO(), nan: FALSE() };
    if (e.k === 'u') return { k: 'n', b: ZERO(), nan: Z.Bool.val(true) };
    return unsupported('string → sayı');
  };
  const truth = (e) => (e.k === 'b' ? e.b : e.k === 'n' ? Z.And(Z.Not(e.nan), Z.Not(e.b.eq(ZERO()))) : FALSE());
  const int32 = (n) => Z.If(n.nan, ZERO(), n.b).extract(31, 0);
  const widen = (x32, signed) => (signed ? x32.signExt(W - 32) : x32.zeroExt(W - 32));
  const mux = (c, a, b) => {
    if (a.k !== b.k) unsupported('karışık tipli seçim');
    if (a.k === 'b') return { k: 'b', b: Z.If(c, a.b, b.b) };
    if (a.k === 'n') return { k: 'n', b: Z.If(c, a.b, b.b), nan: Z.If(c, a.nan, b.nan) };
    return a;
  };
  const enc = (x) => {
    if (memo.has(x)) return memo.get(x);
    const r = raw(x);
    memo.set(x, r);
    return r;
  };
  const raw = (x) => {
    if (x.k === 'c') {
      const v = x.v;
      if (typeof v === 'number') {
        if (Number.isNaN(v)) return { k: 'n', b: ZERO(), nan: Z.Bool.val(true) };
        if (!Number.isInteger(v)) unsupported('tamsayı olmayan sabit');
        return { k: 'n', b: bv(v), nan: FALSE() };
      }
      if (typeof v === 'boolean') return { k: 'b', b: Z.Bool.val(v) };
      if (v === undefined) return { k: 'u' };
      if (v === null) return { k: 'z' };
      return unsupported('string sabiti');
    }
    if (x.k === 'v') return x.ty === 'bool' ? { k: 'b', b: Z.Bool.const(x.name) } : { k: 'n', b: Z.BitVec.const(x.name, W), nan: FALSE() };
    const a = x.a;
    const E = (i) => enc(a[i]);
    const N = (i) => num(E(i));
    switch (x.op) {
      case '+': case '-': case '*': {
        const l = E(0); const r = E(1);
        if (l.k === 's' || r.k === 's') unsupported('string birleştirme');
        const A = num(l); const B = num(r);
        const b = x.op === '+' ? A.b.add(B.b) : x.op === '-' ? A.b.sub(B.b) : A.b.mul(B.b);
        return { k: 'n', b, nan: Z.Or(A.nan, B.nan) };
      }
      case 'neg': { const A = N(0); return { k: 'n', b: A.b.neg(), nan: A.nan }; }
      case 'pos': case 'tonum': return N(0);
      case '%': {
        const A = N(0); const B = N(1);
        return { k: 'n', b: A.b.srem(B.b), nan: Z.Or(A.nan, B.nan, B.b.eq(ZERO())) };
      }
      case '&': case '|': case '^': {
        const A = int32(N(0)); const B = int32(N(1));
        return { k: 'n', b: widen(x.op === '&' ? A.and(B) : x.op === '|' ? A.or(B) : A.xor(B), true), nan: FALSE() };
      }
      case '~': return { k: 'n', b: widen(int32(N(0)).not(), true), nan: FALSE() };
      case 'imul': {
        const A = int32(N(0)).signExt(32); const B = int32(N(1)).signExt(32);
        return { k: 'n', b: widen(A.mul(B).extract(31, 0), true), nan: FALSE() };
      }
      case '<<': case '>>': case '>>>': {
        const A = int32(N(0));
        const S = Z.Concat(Z.BitVec.val(0n, 27), int32(N(1)).extract(4, 0));
        const r = x.op === '<<' ? A.shl(S) : x.op === '>>' ? A.shr(S) : A.lshr(S);
        return { k: 'n', b: widen(r, x.op !== '>>>'), nan: FALSE() };
      }
      case '===': case '!==': case '==': case '!=': {
        const l = E(0); const r = E(1);
        const loose = x.op === '==' || x.op === '!=';
        const nullish = (e) => e.k === 'u' || e.k === 'z';
        let eq;
        if (l.k === r.k) {
          if (l.k === 'n') eq = Z.And(Z.Not(l.nan), Z.Not(r.nan), l.b.eq(r.b));
          else if (l.k === 'b') eq = l.b.eq(r.b);
          else eq = Z.Bool.val(true);
        } else if (loose && nullish(l) && nullish(r)) eq = Z.Bool.val(true);
        else if (loose && (nullish(l) || nullish(r))) eq = FALSE();
        else if (loose) { const A = num(l); const B = num(r); eq = Z.And(Z.Not(A.nan), Z.Not(B.nan), A.b.eq(B.b)); }
        else eq = FALSE();
        return { k: 'b', b: x.op === '===' || x.op === '==' ? eq : Z.Not(eq) };
      }
      case '<': case '<=': case '>': case '>=': {
        const A = N(0); const B = N(1);
        const ok = Z.And(Z.Not(A.nan), Z.Not(B.nan));
        const c = x.op === '<' ? A.b.slt(B.b) : x.op === '<=' ? A.b.sle(B.b) : x.op === '>' ? B.b.slt(A.b) : B.b.sle(A.b);
        return { k: 'b', b: Z.And(ok, c) };
      }
      case '!': return { k: 'b', b: Z.Not(truth(E(0))) };
      case 'truthy': return { k: 'b', b: truth(E(0)) };
      case 'ite': return mux(truth(E(0)), E(1), E(2));
      case '&&': return mux(truth(E(0)), E(1), E(0));
      case '||': return mux(truth(E(0)), E(0), E(1));
      default: return unsupported(`işlem ${x.op}`);
    }
  };
  return { enc, truth };
}

/** @returns {Promise<{ status, ms, model?, reason? }>} model: { ad: number|boolean } */
export async function checkWith(Z, prep, timeoutMs) {
  const t0 = Date.now();
  try {
    const { enc, truth } = translator(Z, prep.W);
    const solver = new Z.Solver();
    solver.set('timeout', Math.max(1, Math.round(timeoutMs)));
    const consts = new Map();
    for (const v of prep.vars) {
      if (v.ty === 'bool') { consts.set(v.name, Z.Bool.const(v.name)); continue; }
      const c = Z.BitVec.const(v.name, prep.W);
      consts.set(v.name, c);
      const lo = v.lo ?? -(2 ** 31);
      const hi = v.hi ?? 2 ** 31 - 1;
      solver.add(Z.BitVec.val(BigInt.asUintN(prep.W, BigInt(lo)), prep.W).sle(c));
      solver.add(c.sle(Z.BitVec.val(BigInt.asUintN(prep.W, BigInt(hi)), prep.W)));
    }
    for (const t of prep.terms) solver.add(truth(enc(t)));
    const status = await solver.check();
    const out = { status, ms: Date.now() - t0 };
    if (status === 'unknown') out.reason = solver.reasonUnknown?.() || 'zaman aşımı';
    if (status === 'sat') {
      const m = solver.model();
      out.model = {};
      for (const v of prep.vars) {
        const val = m.eval(consts.get(v.name), true);
        out.model[v.name] = v.ty === 'bool' ? String(val) === 'true' : Number(BigInt.asIntN(prep.W, val.value()));
      }
    }
    return out;
  } catch (e) {
    return { status: 'unknown', ms: Date.now() - t0, reason: `z3 hatası: ${e?.message ?? e}` };
  }
}
