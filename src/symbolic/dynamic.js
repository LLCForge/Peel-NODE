import * as t from '@babel/types';
import { parse } from '../core/parse.js';
import { traverse, generate, gen } from '../util/ast.js';

// Dinamik (sandbox) analizler:
//   E700 değişmez tespiti — Daikon tarzı: fonksiyon giriş/çıkış değerleri kaydedilir, şablon değişmezler sınanır
//   E699 spesifikasyon madenciliği — çağrı dizilerinden "A'dan sonra hep B" / "B'den önce hep A" kuralları
//   E696 iddia sentezi — değişmezler ve son koşullar iddiaya çevrilir, farklı yapılandırmayla yeniden çalıştırılıp
//         hiç bozulmayanlar doğrulanmış sayılır

const PRELUDE = `var __peelN = 0;
function __peelV(v) {
  var t = typeof v;
  if (v === null || t === "number" || t === "boolean" || t === "undefined") return t === "number" && !isFinite(v) ? { n: String(v) } : t === "undefined" ? { u: 1 } : { v: v };
  if (t === "string") return { v: v.length > 200 ? v.slice(0, 200) : v };
  return { o: t };
}
function __peelI(id, args) { if (__peelN++ < 20000) { var a = []; for (var i = 0; i < args.length; i++) a.push(__peelV(args[i])); __res.push({ k: "i", f: id, a: a }); } }
function __peelR(id, v) { if (__peelN++ < 20000) __res.push({ k: "r", f: id, r: __peelV(v) }); return v; }
function __peelC(name) { if (__peelN++ < 20000) __res.push({ k: "c", n: name }); }
`;

const dec = (x) => (!x ? undefined : x.u ? undefined : x.n !== undefined ? Number(x.n) : x.o ? { __object: x.o } : x.v);

/** Fonksiyon girişlerini/dönüşlerini ve çağrı dizisini kaydeden enstrümantasyon */
export function instrumentTrace(src) {
  const ast = parse(src);
  const fns = [];
  traverse(ast, {
    Function: {
      exit(p) {
        const n = p.node;
        if (n.async || n.generator || !t.isBlockStatement(n.body) || !n.params.every((x) => t.isIdentifier(x))) return;
        const name = n.id?.name ?? (p.parentPath.isVariableDeclarator() && t.isIdentifier(p.parent.id) ? p.parent.id.name : null);
        if (!name) return;
        const id = fns.length;
        fns.push({ id, name, params: n.params.map((x) => x.name), line: n.loc?.start.line ?? 0 });
        p.traverse({
          Function(q) { q.skip(); },
          ReturnStatement(q) { if (q.node.argument && !q.node._peel) { q.node.argument = t.callExpression(t.identifier('__peelR'), [t.numericLiteral(id), q.node.argument]); q.node._peel = true; } },
        });
        n.body.body.unshift(t.expressionStatement(t.callExpression(t.identifier('__peelI'), [t.numericLiteral(id), t.arrayExpression(n.params.map((x) => t.identifier(x.name)))])));
      },
    },
    CallExpression: {
      exit(p) {
        if (p.node._peel || t.isIdentifier(p.node.callee, { name: '__peelR' }) || t.isIdentifier(p.node.callee, { name: '__peelI' })) return;
        const callee = p.node.callee;
        if (!(t.isIdentifier(callee) || (t.isMemberExpression(callee) && !callee.computed))) return;
        const name = gen(callee).slice(0, 50);
        if (name.startsWith('__peel')) return;
        const rec = t.callExpression(t.identifier('__peelC'), [t.stringLiteral(name)]);
        rec._peel = true;
        p.node._peel = true;
        p.replaceWith(t.sequenceExpression([rec, p.node]));
        p.skip();
      },
    },
  });
  return { code: generate(ast, { comments: false }).code, fns };
}

function samplesOf(res, fns) {
  const per = new Map(fns.map((f) => [f.id, { enter: [], ret: [] }]));
  const calls = [];
  for (const e of res) {
    if (!e || typeof e.k !== 'string') continue;
    if (e.k === 'i') per.get(e.f)?.enter.push(e.a.map(dec));
    else if (e.k === 'r') per.get(e.f)?.ret.push(dec(e.r));
    else if (e.k === 'c') calls.push(e.n);
  }
  return { per, calls };
}

// ── E700: şablon değişmezler ───────────────────────────
function slotInvariants(name, vals) {
  const out = [];
  const prim = vals.filter((v) => !(v && typeof v === 'object'));
  if (vals.length < 2) return out;
  const types = new Set(vals.map((v) => (v && typeof v === 'object' ? 'object' : v === null ? 'null' : typeof v)));
  if (types.size === 1) out.push({ expr: `typeof ${name} === ${JSON.stringify([...types][0] === 'null' ? 'object' : [...types][0])}`, kind: 'tip' });
  if (!vals.some((v) => v === null || v === undefined)) out.push({ expr: `${name} != null`, kind: 'null değil' });
  if (prim.length !== vals.length) return out;
  if (vals.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    if (lo === hi) out.push({ expr: `${name} === ${lo}`, kind: 'sabit' });
    else if (vals.length >= 3) out.push({ expr: `${name} >= ${lo} && ${name} <= ${hi}`, kind: 'aralık' });
    if (vals.every(Number.isInteger)) {
      out.push({ expr: `Number.isInteger(${name})`, kind: 'tamsayı' });
      for (const k of [2, 4, 8, 16]) if (vals.length >= 3 && vals.every((v) => v % k === 0) && lo !== hi) { out.push({ expr: `${name} % ${k} === 0`, kind: 'mod' }); break; }
    }
    if (lo >= 0 && lo !== hi) out.push({ expr: `${name} >= 0`, kind: 'negatif değil' });
  }
  if (vals.every((v) => typeof v === 'string')) {
    const lens = vals.map((v) => v.length);
    if (new Set(vals).size === 1) out.push({ expr: `${name} === ${JSON.stringify(vals[0])}`, kind: 'sabit' });
    else {
      if (vals.length >= 3) out.push({ expr: `${name}.length >= ${Math.min(...lens)} && ${name}.length <= ${Math.max(...lens)}`, kind: 'uzunluk' });
      let pre = vals[0];
      for (const v of vals) while (!v.startsWith(pre)) pre = pre.slice(0, -1);
      if (pre.length >= 2) out.push({ expr: `${name}.startsWith(${JSON.stringify(pre)})`, kind: 'önek' });
    }
  }
  return out;
}

function relational(names, rows) {
  const out = [];
  if (rows.length < 2) return out;
  const num = (i) => rows.every((r) => typeof r[i] === 'number' && Number.isFinite(r[i]));
  for (let i = 0; i < names.length; i++) {
    for (let j = 0; j < names.length; j++) {
      if (i === j || !num(i) || !num(j)) continue;
      if (rows.every((r) => r[i] === r[j]) && i < j) out.push({ expr: `${names[i]} === ${names[j]}`, kind: 'eşitlik' });
      else if (rows.every((r) => r[i] < r[j])) out.push({ expr: `${names[i]} < ${names[j]}`, kind: 'sıra' });
      else if (rows.every((r) => r[i] <= r[j]) && !rows.every((r) => r[i] === r[j])) out.push({ expr: `${names[i]} <= ${names[j]}`, kind: 'sıra' });
    }
  }
  return out;
}

function returnInvariants(params, enters, rets) {
  const out = [];
  const n = Math.min(enters.length, rets.length);
  if (n < 2) return out;
  const rows = Array.from({ length: n }, (_, k) => [...enters[k], rets[k]]);
  const R = params.length;
  const isNum = (i) => rows.every((r) => typeof r[i] === 'number' && Number.isFinite(r[i]));
  if (!isNum(R)) return out;
  for (let i = 0; i < R; i++) {
    if (!isNum(i)) continue;
    if (rows.every((r) => r[R] === r[i])) { out.push({ expr: `sonuç === ${params[i]}`, kind: 'dönüş' }); continue; }
    // sonuç = a·p + b (iki örnekten uydur, hepsinde doğrula)
    const [r0, r1] = rows;
    if (r1[i] !== r0[i]) {
      const a = (r1[R] - r0[R]) / (r1[i] - r0[i]);
      const b = r0[R] - a * r0[i];
      if (Number.isInteger(a) && Number.isInteger(b) && rows.every((r) => r[R] === a * r[i] + b)) out.push({ expr: `sonuç === ${a === 1 ? '' : `${a} * `}${params[i]}${b ? ` ${b < 0 ? '-' : '+'} ${Math.abs(b)}` : ''}`, kind: 'doğrusal' });
    }
    for (let j = i + 1; j < R; j++) {
      if (!isNum(j)) continue;
      if (rows.every((r) => r[R] === r[i] + r[j])) out.push({ expr: `sonuç === ${params[i]} + ${params[j]}`, kind: 'dönüş' });
      if (rows.every((r) => r[R] === r[i] * r[j])) out.push({ expr: `sonuç === ${params[i]} * ${params[j]}`, kind: 'dönüş' });
    }
  }
  return out;
}

// ── E699: çağrı dizisi kuralları ───────────────────────
export function mineSpecs(calls) {
  const freq = new Map();
  for (const c of calls) freq.set(c, (freq.get(c) ?? 0) + 1);
  const alpha = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k]) => k);
  const pos = new Map(alpha.map((a) => [a, []]));
  calls.forEach((c, i) => pos.get(c)?.push(i));
  const rules = [];
  for (const A of alpha) {
    for (const B of alpha) {
      if (A === B) continue;
      const pa = pos.get(A);
      const pb = pos.get(B);
      // yanıt: her A'dan sonra bir B gelir
      if (pa.length >= 2 && pa.every((i) => pb.some((j) => j > i))) rules.push({ rule: `${A} → ${B}`, kind: 'yanıt', support: pa.length });
      // öncelik: her B'den önce bir A vardır
      if (pb.length >= 2 && pb.every((j) => pa.some((i) => i < j)) && pa[0] < pb[0]) rules.push({ rule: `${A} ⇐ ${B}`, kind: 'öncelik', support: pb.length });
    }
  }
  return rules.sort((a, b) => b.support - a.support).slice(0, 20);
}

/**
 * @returns {Promise<{invariants, specs, assertions}>}
 */
export async function dynamicReport(sandbox, code, { post = [] } = {}) {
  let inst;
  try { inst = instrumentTrace(code); } catch (e) { return { ok: false, reason: e.message }; }
  const r = await sandbox.run(`${PRELUDE}\n${inst.code}`, { timeoutMs: 4000 });
  const { per, calls } = samplesOf(r.res ?? [], inst.fns);
  const invariants = [];
  for (const f of inst.fns) {
    const s = per.get(f.id);
    if (!s || s.enter.length < 2) continue;
    const items = [];
    f.params.forEach((p, i) => items.push(...slotInvariants(p, s.enter.map((a) => a[i]))));
    items.push(...relational(f.params, s.enter));
    if (s.ret.length >= 2) {
      items.push(...slotInvariants('sonuç', s.ret).map((x) => ({ ...x, at: 'çıkış' })));
      items.push(...returnInvariants(f.params, s.enter, s.ret).map((x) => ({ ...x, at: 'çıkış' })));
    }
    if (items.length) invariants.push({ fn: f.name, line: f.line, samples: s.enter.length, items: items.slice(0, 12) });
  }
  const specs = mineSpecs(calls);
  const assertions = await synthesizeAssertions(sandbox, code, inst.fns, invariants, post);
  return { ok: true, invariants, specs, assertions, calls: calls.length };
}

// ── E696: iddia sentezi ve doğrulama ───────────────────
async function synthesizeAssertions(sandbox, code, fns, invariants, post) {
  const cands = [];
  for (const inv of invariants) {
    for (const it of inv.items) {
      if (it.kind === 'sıra' && cands.length > 60) continue;
      cands.push({ fn: inv.fn, at: it.at === 'çıkış' ? 'exit' : 'enter', expr: it.expr.replace(/sonuç/g, '__peelRet'), text: it.expr, source: 'değişmez' });
    }
  }
  for (const p of post) cands.push({ fn: p.fn, at: 'exit', expr: p.expr, text: p.text, source: 'son koşul' });
  if (!cands.length) return [];
  // iddiaları fonksiyonlara göm: giriş iddiaları gövde başında, çıkış iddiaları her return'de
  let ast;
  try { ast = parse(code); } catch { return []; }
  const byFn = new Map();
  cands.forEach((c, i) => { c.id = i; if (!byFn.has(c.fn)) byFn.set(c.fn, []); byFn.get(c.fn).push(c); });
  const check = (c, valueExpr) => {
    let cond;
    try { cond = parse(`(${c.expr})`).program.body[0].expression; } catch { return null; }
    const wrapped = valueExpr ? t.callExpression(t.arrowFunctionExpression([t.identifier('__peelRet')], cond), [valueExpr]) : cond;
    return t.callExpression(t.identifier('__peelA'), [t.numericLiteral(c.id), t.arrowFunctionExpression([], wrapped)]);
  };
  traverse(ast, {
    Function(p) {
      const n = p.node;
      const name = n.id?.name ?? (p.parentPath.isVariableDeclarator() && t.isIdentifier(p.parent.id) ? p.parent.id.name : null);
      const list = name && byFn.get(name);
      if (!list || !t.isBlockStatement(n.body)) return;
      const enter = list.filter((c) => c.at === 'enter').map((c) => check(c, null)).filter(Boolean);
      // son koşullar giriş değerlerine (__peelArgN) başvurur: parametreler gövdede değişebilir
      if (list.some((c) => c.source === 'son koşul') && n.params.every((x) => t.isIdentifier(x))) {
        enter.unshift(t.variableDeclaration('var', n.params.map((x, i) => t.variableDeclarator(t.identifier(`__peelArg${i}`), t.identifier(x.name)))));
      }
      p.traverse({
        Function(q) { q.skip(); },
        ReturnStatement(q) {
          if (!q.node.argument || q.node._peel) return;
          const exits = list.filter((c) => c.at === 'exit');
          if (!exits.length) return;
          // dönüş değeri bir kez hesaplanır, her iddia aynı değeri sınar
          const tmp = t.identifier('__peelV0');
          const seq = [t.assignmentExpression('=', tmp, q.node.argument), ...exits.map((c) => check(c, tmp)).filter(Boolean), tmp];
          q.node.argument = t.callExpression(t.arrowFunctionExpression([], t.blockStatement([t.variableDeclaration('var', [t.variableDeclarator(tmp)]), t.returnStatement(t.sequenceExpression(seq))])), []);
          q.node._peel = true;
        },
      });
      n.body.body.unshift(...enter.map((e) => (t.isStatement(e) ? e : t.expressionStatement(e))));
    },
  });
  const prelude = `var __peelAS = {}, __peelAF = {};
function __peelA(id, f) { var ok; try { ok = f(); } catch (e) { ok = false; } __peelAS[id] = (__peelAS[id] || 0) + 1; if (!ok) __peelAF[id] = (__peelAF[id] || 0) + 1; }
`;
  const body = generate(ast, { comments: false }).code;
  const run = `${prelude}try {\n${body}\n} finally { __res.push({ peelAssert: { s: __peelAS, f: __peelAF } }); }`;
  // farklı ortam yapılandırmasıyla yeniden çalıştırma: aynı koşu verisinin tekrarı olmasın
  const r = await sandbox.run(run, { timeoutMs: 4000, config: { seed: 7919, now: 1500000000000 } });
  const sum = (r.res ?? []).find((x) => x && x.peelAssert)?.peelAssert;
  if (!sum) return [];
  return cands.map((c) => ({
    fn: c.fn, at: c.at === 'enter' ? 'giriş' : 'çıkış', assertion: `console.assert(${c.text.replace(/sonuç/g, 'ret')})`, source: c.source,
    checked: sum.s[c.id] ?? 0, failed: sum.f[c.id] ?? 0, valid: (sum.s[c.id] ?? 0) > 0 && !(sum.f[c.id] ?? 0),
  })).filter((a) => a.checked > 0).slice(0, 40);
}
