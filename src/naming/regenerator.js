import * as t from '@babel/types';

// regenerator durum makinesini yapısal generator gövdesine çevirir (79).
//
//   klasik:  return R.wrap(function f$(ctx) { while (1) switch (ctx.prev = ctx.next) { case 0: …; ctx.next = 2; return X; case 2: y = ctx.sent; … } }, f, this, tryLocs)
//   kompakt (Babel 7.27+ _regenerator()):  …w(function (ctx) { while (1) switch (ctx.p = ctx.n) { … y = ctx.v; return ctx.a(2, r); … } })
//     a(2, v) = return, a(3, N) = break/continue, f(N) = finally bitişi, d(it, N) = yield*, catch bloğunda X = ctx.v hata nesnesi
//
// regenerator durumları kaynak sırasında numaralar: ileri atlama if/else, geri atlama döngüdür.
// Bloklar bu sıraya göre aralıklar halinde yapılandırılır; beklenmeyen her biçimde null döner (fonksiyona dokunulmaz).

class Bail extends Error {}
const bail = (why) => { throw new Bail(why); };
const MAX_STATEMENTS = 4000;

// Bağlam alan adları: lehçeye göre (decompile/machineSwitch çağrısı süresince geçerli)
const DIALECTS = {
  classic: { next: 'next', prev: 'prev', sent: 'sent' },
  compact: { next: 'n', prev: 'p', sent: 'v' },
};
let P = DIALECTS.classic;

const isCtx = (n, ctx) => t.isIdentifier(n, { name: ctx });
const ctxProp = (n, ctx) => {
  if (!t.isMemberExpression(n) || !isCtx(n.object, ctx)) return null;
  if (!n.computed && t.isIdentifier(n.property)) return n.property.name;
  if (n.computed && t.isStringLiteral(n.property)) return n.property.value;
  return undefined;
};
const ctxCall = (n, ctx, name) => t.isCallExpression(n) && ctxProp(n.callee, ctx) === name;
const caseKey = (n) => (t.isNumericLiteral(n) ? n.value : t.isStringLiteral(n) ? n.value : bail('case anahtarı'));
const keyOf = (n) => (t.isNumericLiteral(n) ? n.value : t.isStringLiteral(n) ? n.value : bail('hedef'));

// ctx.next = N
function nextAssign(st, ctx) {
  if (!t.isExpressionStatement(st)) return null;
  const e = st.expression;
  if (t.isAssignmentExpression(e, { operator: '=' }) && ctxProp(e.left, ctx) === P.next && t.isNumericLiteral(e.right)) return e.right.value;
  return null;
}
const isPrevMarker = (st, ctx) => t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression, { operator: '=' }) &&
  ctxProp(st.expression.left, ctx) === P.prev && t.isNumericLiteral(st.expression.right);

/** while (1) switch (ctx.prev = ctx.next) {…} gövdesini bulur */
export function machineSwitch(fn, ctx, dialect = 'classic') {
  P = DIALECTS[dialect];
  const body = fn.body.body;
  if (body.length !== 1 || !t.isWhileStatement(body[0])) return null;
  const loop = body[0];
  if (!(t.isNumericLiteral(loop.test, { value: 1 }) || t.isBooleanLiteral(loop.test, { value: true }))) return null;
  let sw = loop.body;
  if (t.isBlockStatement(sw)) { if (sw.body.length !== 1) return null; sw = sw.body[0]; }
  if (!t.isSwitchStatement(sw)) return null;
  const d = sw.discriminant;
  const ok = (t.isAssignmentExpression(d, { operator: '=' }) && ctxProp(d.left, ctx) === P.prev && ctxProp(d.right, ctx) === P.next) ||
    ctxProp(d, ctx) === P.next;
  return ok ? sw : null;
}

/**
 * @param {object} sw     switch düğümü
 * @param {string} ctx    bağlam parametresinin adı
 * @param {Array} tryLocs [[tryLoc, catchLoc, finallyLoc, afterLoc], …] (sayı ya da null)
 * @param {object} o      { awaitMode, dialect: 'classic'|'compact', delegateOk(expr): yield* hedefi kesin yinelenebilir mi }
 * @returns {{ body: object[], temps: string[] } | null}
 */
export function decompile(sw, ctx, tryLocs = [], { awaitMode = false, dialect = 'classic', delegateOk = () => false } = {}) {
  P = DIALECTS[dialect];
  try {
    return run(sw, ctx, tryLocs, awaitMode, dialect === 'compact', delegateOk);
  } catch (e) {
    if (e instanceof Bail) return null;
    throw e;
  }
}

function run(sw, ctx, tryLocs, awaitMode, compact, delegateOk) {
  // ── 1) bloklar ──
  const blocks = [];
  const keyIndex = new Map();
  const temps = new Set();
  const readTemps = new Set();
  let usesSent = false;
  // catch bloklarının başlangıç durumları: kompakt biçimde ilk "X = ctx.v" hata nesnesidir
  const catchKeys = new Set(tryLocs.map((l) => l[1]).filter((x) => x != null));
  let count = 0;

  const rewrite = (node) => {
    // ctx.sent → _sent, ctx.tK → _tK; başka her ctx kullanımı desteklenmez
    const clone = t.cloneNode(node, true);
    const visit = (n, parent, key) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach((x, i) => visit(x, n, i)); return; }
      if (!n.type) return;
      if (t.isMemberExpression(n) && isCtx(n.object, ctx)) {
        const p = ctxProp(n, ctx);
        if (p === P.sent) { usesSent = true; parent[key] = t.identifier('_sent'); return; }
        if (!compact && typeof p === 'string' && /^t\d+$/.test(p)) { temps.add(p); readTemps.add(p); parent[key] = t.identifier(`_${p}`); return; }
        bail(`desteklenmeyen bağlam erişimi: ${p}`);
      }
      if (isCtx(n, ctx)) bail('bağlam değer olarak kullanılıyor');
      if (t.isFunction(n) && n.params.some((x) => isCtx(x, ctx))) return; // gölgeleme
      for (const k of t.VISITOR_KEYS[n.type] ?? []) visit(n[k], n, k);
    };
    const holder = { node: clone };
    visit(clone, holder, 'node');
    count++;
    if (count > MAX_STATEMENTS) bail('çok büyük');
    return holder.node;
  };

  const cases = sw.cases;
  for (let ci = 0; ci < cases.length; ci++) {
    const c = cases[ci];
    if (!c.test) bail('default case');
    const key = caseKey(c.test);
    let cur = { keys: [key], stmts: [], term: null };
    // boş case'ler bir sonrakine düşer: aynı bloğu paylaşırlar
    if (!c.consequent.length && ci + 1 < cases.length) {
      keyIndex.set(key, blocks.length);
      continue;
    }
    keyIndex.set(key, blocks.length);
    blocks.push(cur);
    const st = c.consequent;
    let i = 0;
    const startBlock = () => { cur = { keys: [], stmts: [], term: null }; blocks.push(cur); };
    let catchPending = compact && catchKeys.has(key);
    for (; i < st.length; i++) {
      const s = st[i];
      if (isPrevMarker(s, ctx)) continue;
      // kompakt catch: X = ctx.v
      if (catchPending) {
        catchPending = false;
        const e = t.isExpressionStatement(s) ? s.expression : null;
        if (e && t.isAssignmentExpression(e, { operator: '=' }) && t.isIdentifier(e.left) && ctxProp(e.right, ctx) === P.sent) {
          cur.stmts.push({ catchInto: e.left.name, temp: false });
          continue;
        }
        if (!(e && ctxProp(e, ctx) === P.sent)) {
          // hata nesnesi okunmuyor: catch parametresiz
          cur.stmts.push({ catchInto: null, temp: false });
        } else {
          cur.stmts.push({ catchInto: null, temp: false });
          continue;
        }
      }
      const nx = nextAssign(s, ctx);
      if (nx !== null) {
        const after = st[i + 1];
        if (t.isBreakStatement(after) && !after.label) { cur.term = { kind: 'goto', to: nx }; break; }
        if (t.isReturnStatement(after) && after.argument) {
          cur.term = { kind: 'yield', expr: rewrite(after.argument), to: nx };
          break;
        }
        bail('ctx.next ataması sonrası beklenmeyen deyim');
      }
      if (t.isIfStatement(s) && isJump(s.consequent, ctx)) {
        const to = jumpTarget(s.consequent, ctx);
        if (s.alternate) {
          if (!isJump(s.alternate, ctx)) bail('if/else atlaması');
          cur.term = { kind: 'cond', test: rewrite(s.test), to, otherwise: jumpTarget(s.alternate, ctx) };
          break;
        }
        cur.term = { kind: 'cond', test: rewrite(s.test), to, otherwise: null };
        startBlock();
        continue;
      }
      if (t.isReturnStatement(s) && compact) {
        const a = s.argument;
        const code = ctxCall(a, ctx, 'a') && t.isNumericLiteral(a.arguments[0]) ? a.arguments[0].value : null;
        if (code === 2) {
          cur.term = a.arguments.length > 1 ? { kind: 'return', expr: rewrite(a.arguments[1]) } : { kind: 'stop' };
          break;
        }
        if (code === 3 && t.isNumericLiteral(a.arguments[1])) { cur.term = { kind: 'goto', to: a.arguments[1].value }; break; }
        if (ctxCall(a, ctx, 'f') && t.isNumericLiteral(a.arguments[0])) { cur.term = { kind: 'finish', loc: a.arguments[0].value }; break; }
        if (ctxCall(a, ctx, 'd') && a.arguments.length === 2 && t.isNumericLiteral(a.arguments[1])) {
          if (awaitMode) bail('async içinde yield*');
          // _regeneratorValues(x): x kesin yinelenebilir değilse yield* farklı davranır (dizi benzeri/next'li nesne kabul eder)
          const it = a.arguments[0];
          const inner = t.isCallExpression(it) && t.isIdentifier(it.callee) && /^_?regeneratorValues\d*$/.test(it.callee.name) && it.arguments.length === 1 ? it.arguments[0] : null;
          if (!inner || !delegateOk(inner)) bail('yield* hedefi kanıtlanamadı');
          cur.term = { kind: 'delegate', expr: rewrite(inner), into: null, to: a.arguments[1].value };
          break;
        }
        bail('beklenmeyen return');
      }
      if (t.isReturnStatement(s)) {
        const a = s.argument;
        if (ctxCall(a, ctx, 'stop') && !a.arguments.length) { cur.term = { kind: 'stop' }; break; }
        if (ctxCall(a, ctx, 'abrupt') && t.isStringLiteral(a.arguments[0])) {
          const kind = a.arguments[0].value;
          if (kind === 'return') { cur.term = { kind: 'return', expr: a.arguments[1] ? rewrite(a.arguments[1]) : null }; break; }
          if ((kind === 'break' || kind === 'continue') && t.isNumericLiteral(a.arguments[1])) { cur.term = { kind: 'goto', to: a.arguments[1].value }; break; }
          bail(`abrupt ${kind}`);
        }
        if (ctxCall(a, ctx, 'finish') && t.isNumericLiteral(a.arguments[0])) { cur.term = { kind: 'finish', loc: a.arguments[0].value }; break; }
        if (ctxCall(a, ctx, 'delegateYield') && t.isStringLiteral(a.arguments[1]) && /^t\d+$/.test(a.arguments[1].value) && t.isNumericLiteral(a.arguments[2])) {
          if (awaitMode) bail('async içinde yield*');
          if (!delegateOk(a.arguments[0])) bail('yield* hedefi kanıtlanamadı');
          temps.add(a.arguments[1].value);
          cur.term = { kind: 'delegate', expr: rewrite(a.arguments[0]), into: a.arguments[1].value, to: a.arguments[2].value };
          break;
        }
        bail('beklenmeyen return');
      }
      // ctx.tK = ctx["catch"](N) ya da _t = ctx["catch"](N) → catch parametresi
      if (!compact && t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression, { operator: '=' }) && ctxCall(s.expression.right, ctx, 'catch')) {
        const left = s.expression.left;
        keyOf(s.expression.right.arguments[0]);
        if (/^t\d+$/.test(ctxProp(left, ctx) ?? '')) {
          cur.stmts.push({ catchInto: ctxProp(left, ctx), temp: true });
          temps.add(ctxProp(left, ctx));
          continue;
        }
        if (t.isIdentifier(left)) { cur.stmts.push({ catchInto: left.name, temp: false }); continue; }
        bail('catch hedefi');
      }
      if (t.isBreakStatement(s) || t.isContinueStatement(s)) bail('çıplak break/continue');
      cur.stmts.push(rewrite(s));
    }
    if (!cur.term) cur.term = { kind: 'fall' };
  }
  if (!blocks.length) bail('boş makine');
  // düşme hedefi: bir sonraki blok; END: "end" anahtarı ya da dizinin sonu
  const END = blocks.length;
  const idx = (k) => {
    if (k === 'end') return END;
    if (!keyIndex.has(k)) bail(`bilinmeyen durum ${k}`);
    return keyIndex.get(k);
  };
  blocks.forEach((b, i) => {
    const tm = b.term;
    if (tm.kind === 'fall') { tm.kind = 'goto'; tm.toIdx = i + 1; }
    if (tm.to !== undefined) tm.toIdx = idx(tm.to);
    if (tm.kind === 'cond') tm.elseIdx = tm.otherwise === null ? i + 1 : idx(tm.otherwise);
  });
  // "end" bloğu ve sonrası yalnızca stop içermeli
  const endKey = keyIndex.get('end');
  if (endKey !== undefined) {
    const eb = blocks[endKey];
    if (eb.stmts.length || eb.term.kind !== 'stop') bail('end bloğu');
  }

  // ── 2) try bölgeleri ──
  const tries = tryLocs.map(([a, c, f, after]) => ({
    start: idx(a),
    catchAt: c == null ? null : idx(c),
    finallyAt: f == null ? null : idx(f),
    after: after == null ? null : idx(after),
    finallyLoc: f,
  }));

  // ── 3) döngü başları: kendisinden sonra gelen bloktan gelen kenar ──
  const succ = (b) => {
    const tm = b.term;
    if (tm.kind === 'goto' || tm.kind === 'yield' || tm.kind === 'delegate') return [tm.toIdx];
    if (tm.kind === 'cond') return [tm.toIdx, tm.elseIdx];
    return [];
  };
  const backFrom = new Map(); // head → en büyük kaynak
  blocks.forEach((b, i) => {
    for (const s of succ(b)) if (s <= i) backFrom.set(s, Math.max(backFrom.get(s) ?? -1, i));
  });

  // ── 4) yapılandırma ──
  let labelN = 0;
  const yieldNode = (expr, delegate = false) => (awaitMode ? t.awaitExpression(expr) : t.yieldExpression(expr, delegate));

  // frames: { kind: 'loop', head, exit, label } | { kind: 'region', exits:Set }
  function jumpTo(target, frames) {
    for (let f = frames.length - 1; f >= 0; f--) {
      const fr = frames[f];
      if (fr.kind === 'loop') {
        if (target === fr.head) return [t.continueStatement(t.identifier(fr.label))];
        if (target === fr.exit) return [t.breakStatement(t.identifier(fr.label))];
      } else if (fr.kind === 'region') {
        if (fr.exits.has(target)) {
          if (f !== frames.length - 1) bail('bölge çıkışı döngü içinden');
          return [];
        }
      }
    }
    if (target === END) return [t.returnStatement()];
    bail(`yapılandırılamayan atlama ${target}`);
  }
  const special = (target, frames) => target === END || frames.some((fr) =>
    (fr.kind === 'loop' && (fr.head === target || fr.exit === target)) || (fr.kind === 'region' && fr.exits.has(target)));

  function loopExit(head, last) {
    // döngü bölgesinden dışarı giden atlamaların tek hedefi
    const outs = new Set();
    for (let i = head; i <= last; i++) for (const s of succ(blocks[i])) if (s > last) outs.add(s);
    if (outs.size > 1) {
      // fazladan çıkışlar END ya da dış çerçeve hedefleri olabilir: en küçüğü döngü çıkışı say
      return Math.min(...outs);
    }
    return outs.size ? [...outs][0] : last + 1;
  }

  // [i, until) aralığını üretir; until ya da çerçeve hedeflerinde durur
  function emit(i, until, frames, skipLoopAt = -1, skipTryAt = -1) {
    const out = [];
    while (i !== until) {
      if (i === END) { out.push(t.returnStatement()); return out; }
      if (i > END) bail('aralık dışı');
      // döngü
      if (backFrom.has(i) && i !== skipLoopAt) {
        const last = backFrom.get(i);
        const exit = loopExit(i, last);
        const label = `loop${++labelN}`;
        const body = emit(i, null, [...frames, { kind: 'loop', head: i, exit, label }], i, skipTryAt);
        out.push(t.labeledStatement(t.identifier(label), t.whileStatement(t.booleanLiteral(true), t.blockStatement(body))));
        if (exit === until) return out;
        if (special(exit, frames)) { out.push(...jumpTo(exit, frames)); return out; }
        i = exit;
        continue;
      }
      // try
      const tr = tries.find((x) => x.start === i);
      if (tr && i !== skipTryAt) {
        const res = emitTry(tr, frames, skipLoopAt);
        out.push(res.node);
        if (res.after === null) return out;
        if (res.after === until) return out;
        if (special(res.after, frames)) { out.push(...jumpTo(res.after, frames)); return out; }
        i = res.after;
        skipLoopAt = -1;
        continue;
      }
      const b = blocks[i];
      let marker = null;
      for (const s of b.stmts) {
        if (s.catchInto !== undefined) { marker = s; continue; }
        out.push(s);
      }
      if (marker && !frames.some((f) => f.catchStart === i)) bail('catch bağlaması bölge dışında');
      const tm = b.term;
      switch (tm.kind) {
        case 'return': out.push(t.returnStatement(tm.expr)); return out;
        case 'stop': if (until !== END || frames.length) out.push(t.returnStatement()); return out;
        case 'finish': {
          const fin = frames.findLast((f) => f.kind === 'region' && f.finallyLoc === tm.loc);
          if (!fin || fin !== frames.at(-1)) bail('finish yeri');
          return out;
        }
        case 'yield': case 'delegate': {
          const y = tm.kind === 'delegate' ? yieldNode(tm.expr, true) : yieldNode(tm.expr);
          // yield* sonucu: klasikte tK geçicisine, kompaktta ctx.v'ye; okunmuyorsa yalnızca ifade
          const target = tm.kind === 'delegate' && tm.into ? (readTemps.has(tm.into) ? `_${tm.into}` : null) : (usesSent ? '_sent' : null);
          out.push(t.expressionStatement(target ? t.assignmentExpression('=', t.identifier(target), y) : y));
          if (tm.toIdx === until) return out;
          if (special(tm.toIdx, frames) || tm.toIdx <= i) { out.push(...jumpTo(tm.toIdx, frames)); return out; }
          i = tm.toIdx;
          skipLoopAt = -1;
          continue;
        }
        case 'goto': {
          if (tm.toIdx === until) return out;
          if (special(tm.toIdx, frames) || tm.toIdx <= i) { out.push(...jumpTo(tm.toIdx, frames)); return out; }
          // ileri atlama ile aradaki bloklar atlanıyor: başka yoldan ulaşılmıyorsa ölü kod
          i = tm.toIdx;
          skipLoopAt = -1;
          continue;
        }
        case 'cond': {
          const { test, toIdx: T, elseIdx: F } = tm;
          if (special(T, frames) || T <= i) {
            const jump = jumpTo(T, frames);
            if (!jump.length) {
              // en içteki bölgenin çıkışı: kalan kısım yalnızca koşul yanlışken çalışır
              const rest = F === until ? [] : emit(F, until, frames);
              if (rest.length) out.push(t.ifStatement(negate(test), t.blockStatement(rest)));
              return out;
            }
            out.push(t.ifStatement(test, t.blockStatement(jump)));
            if (F === until) return out;
            if (special(F, frames)) { out.push(...jumpTo(F, frames)); return out; }
            i = F;
            skipLoopAt = -1;
            continue;
          }
          if (special(F, frames) || F <= i) {
            const jump = jumpTo(F, frames);
            if (!jump.length) {
              const rest = T === until ? [] : emit(T, until, frames);
              if (rest.length) out.push(t.ifStatement(test, t.blockStatement(rest)));
              return out;
            }
            out.push(t.ifStatement(negate(test), t.blockStatement(jump)));
            if (T === until) return out;
            i = T;
            skipLoopAt = -1;
            continue;
          }
          // ileri if/else: atlanan (T) dal "else", düşen (F) dal "then"
          const lo = Math.min(T, F);
          const hi = Math.max(T, F);
          const beforeHi = blocks[hi - 1];
          let join = hi;
          if (beforeHi && beforeHi.term.kind === 'goto' && beforeHi.term.toIdx > hi && !special(beforeHi.term.toIdx, frames)) join = beforeHi.term.toIdx;
          const lowPart = emit(lo, hi, [...frames, { kind: 'region', exits: new Set([hi, join]) }]);
          const highPart = join === hi ? [] : emit(hi, join, [...frames, { kind: 'region', exits: new Set([join]) }]);
          // T dalı koşul doğruyken: T düşük aralıksa then=low
          const thenPart = T === lo ? lowPart : highPart;
          const elsePart = T === lo ? highPart : lowPart;
          if (thenPart.length) out.push(t.ifStatement(test, t.blockStatement(thenPart), elsePart.length ? t.blockStatement(elsePart) : null));
          else if (elsePart.length) out.push(t.ifStatement(negate(test), t.blockStatement(elsePart)));
          if (join === until) return out;
          if (special(join, frames)) { out.push(...jumpTo(join, frames)); return out; }
          i = join;
          skipLoopAt = -1;
          continue;
        }
        default: bail(`terim ${tm.kind}`);
      }
    }
    return out;
  }

  function emitTry(tr, frames, skipLoopAt) {
    const { start, catchAt, finallyAt } = tr;
    const tryEnd = catchAt ?? finallyAt;
    if (tryEnd == null || tryEnd <= start) bail('try sınırları');
    let after = tr.after;
    if (after == null) {
      // yalnızca catch: try gövdesinin sonundaki atlama "after"ı verir
      const outs = new Set();
      for (let i = start; i < tryEnd; i++) for (const s of succ(blocks[i])) if (s >= tryEnd) outs.add(s);
      outs.delete(END);
      after = outs.size ? Math.max(...outs) : null;
      if (after === null || outs.size > 1) bail('try çıkışı');
    }
    const exitsTry = new Set([tryEnd, after]);
    if (finallyAt != null) exitsTry.add(finallyAt);
    const block = emit(start, tryEnd, [...frames, { kind: 'region', exits: exitsTry }], skipLoopAt, start);
    let handler = null;
    if (catchAt != null) {
      const first = blocks[catchAt].stmts.find((s) => s.catchInto !== undefined);
      if (!first) bail('catch parametresi');
      const catchEnd = finallyAt ?? after;
      if (first.catchInto && !first.temp && mentionedOutside(first.catchInto, catchAt, catchEnd)) bail('catch değişkeni bölge dışında kullanılıyor');
      const body = emit(catchAt, catchEnd, [...frames, { kind: 'region', exits: new Set([catchEnd, after]), catchStart: catchAt }]);
      const param = first.catchInto ? t.identifier(first.temp ? `_${first.catchInto}` : first.catchInto) : null;
      handler = t.catchClause(param, t.blockStatement(body));
      if (first.temp) catchTemps.add(first.catchInto);
      else if (first.catchInto) catchLocals.add(first.catchInto);
    }
    let finalizer = null;
    if (finallyAt != null) {
      const body = emit(finallyAt, after, [...frames, { kind: 'region', exits: new Set([after]), finallyLoc: tr.finallyLoc }]);
      finalizer = t.blockStatement(body);
    }
    return { node: t.tryStatement(t.blockStatement(block), handler, finalizer), after };
  }

  const catchTemps = new Set();
  const catchLocals = new Set();
  // ad catch bölgesi [from, to) dışındaki bloklarda geçiyor mu?
  function mentionedOutside(name, from, to) {
    let found = false;
    blocks.forEach((b, i) => {
      if (found || (i >= from && i < to)) return;
      const nodes = [...b.stmts.filter((x) => x.type), b.term.expr, b.term.test].filter(Boolean);
      for (const n of nodes) t.traverseFast(n, (x) => { if (t.isIdentifier(x, { name })) found = true; });
    });
    return found;
  }
  const body = tidy(emit(0, END, []));
  // gövdenin son deyimi çıplak return ise gereksiz
  while (body.length && t.isReturnStatement(body.at(-1)) && !body.at(-1).argument) body.pop();
  // yalnızca yield* hedefi olup hiç okunmayan geçiciler bildirilmez
  const vars = [...temps].filter((x) => !catchTemps.has(x) && readTemps.has(x)).map((x) => `_${x}`);
  if (usesSent) vars.unshift('_sent');
  return { body, temps: vars, catchTemps: [...catchTemps].map((x) => `_${x}`), catchLocals: [...catchLocals] };
}

// L: while (true) { if (c) break L; …; continue L; }  →  while (!c) { … }   (etikete başka atlama yoksa)
function tidy(list) {
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    for (const k of ['body', 'consequent', 'alternate', 'block', 'finalizer']) {
      const v = s[k];
      if (t.isBlockStatement(v)) v.body = tidy(v.body);
    }
    if (t.isTryStatement(s) && s.handler) s.handler.body.body = tidy(s.handler.body.body);
    if (!t.isLabeledStatement(s) || !t.isWhileStatement(s.body)) continue;
    const label = s.label.name;
    const loop = s.body;
    const body = loop.body.body;
    const last = body.at(-1);
    if (t.isContinueStatement(last) && last.label?.name === label) body.pop();
    const first = body[0];
    if (t.isBooleanLiteral(loop.test, { value: true }) && t.isIfStatement(first) && !first.alternate &&
      t.isBlockStatement(first.consequent) && first.consequent.body.length === 1 &&
      t.isBreakStatement(first.consequent.body[0]) && first.consequent.body[0].label?.name === label) {
      body.shift();
      loop.test = negate(first.test);
    }
    let used = false;
    t.traverseFast(loop, (n) => {
      if ((t.isBreakStatement(n) || t.isContinueStatement(n)) && n.label?.name === label) used = true;
    });
    if (!used) list[i] = loop;
    else {
      // iç döngü yoksa etiketsiz break/continue aynı döngüyü hedefler
      let nested = false;
      t.traverseFast(loop.body, (n) => { if (t.isLoop(n) || t.isSwitchStatement(n) || t.isFunction(n)) nested = true; });
      if (!nested) {
        t.traverseFast(loop.body, (n) => {
          if ((t.isBreakStatement(n) || t.isContinueStatement(n)) && n.label?.name === label) n.label = null;
        });
        list[i] = loop;
      }
    }
  }
  return list;
}

function isJump(st, ctx) {
  const body = t.isBlockStatement(st) ? st.body : [st];
  if (body.length === 2 && nextAssign(body[0], ctx) !== null && t.isBreakStatement(body[1]) && !body[1].label) return true;
  if (body.length === 1 && t.isReturnStatement(body[0]) && ctxCall(body[0].argument, ctx, 'a') &&
    t.isNumericLiteral(body[0].argument.arguments[0], { value: 3 }) && t.isNumericLiteral(body[0].argument.arguments[1])) return true;
  if (body.length === 1 && t.isReturnStatement(body[0]) && ctxCall(body[0].argument, ctx, 'abrupt') &&
    t.isStringLiteral(body[0].argument.arguments[0]) && /^(break|continue)$/.test(body[0].argument.arguments[0].value)) return true;
  return false;
}
function jumpTarget(st, ctx) {
  const body = t.isBlockStatement(st) ? st.body : [st];
  const n = nextAssign(body[0], ctx);
  return n !== null ? n : body[0].argument.arguments[1].value;
}

export function negate(test) {
  if (t.isUnaryExpression(test, { operator: '!' })) return test.argument;
  return t.unaryExpression('!', test);
}
