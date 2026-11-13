// Derleyici optimizasyonları ve analizleri öz-denetimi: node test/opt.test.js
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as t from '@babel/types';
import { parse } from '../src/core/parse.js';
import { traverse, gen, generate } from '../src/util/ast.js';
import { buildSsa, ssaText, destruct, liveness } from '../src/opt/ssa.js';
import { sccp, absint, T } from '../src/opt/lattice.js';
import { buildConstraints, andersen, steensgaard, staticReport } from '../src/opt/analysis.js';
import { specialize } from '../src/opt/pe.js';
import { toIR, decide } from '../src/opt/irbridge.js';
import { V, C, mk } from '../src/symbolic/ir.js';

const fnPath = (code, name) => {
  const ast = parse(code);
  let found = null;
  traverse(ast, { FunctionDeclaration(p) { if (!name || p.node.id.name === name) { found ??= p; } } });
  return { ast, p: found };
};
const run = (code) => {
  const out = [];
  vm.runInNewContext(code, { console: { log: (...a) => out.push(a.join(' ')) } }, { timeout: 2000 });
  return out.join('\n');
};

// ── E681 SSA kurulumu, E682 φ yerleştirme, E684 fazla φ eleme ─────
{
  const { p } = fnPath(`function f(a, b) {
    var x = 0, y = 1, z = 5, w = 2;
    for (var i = 0; i < a; i++) { if (i % 2) { x = x + i; w = w; continue; } y = y * 2; }
    switch (b) { case 1: x = 5; case 2: y = 3; break; default: x = 9; }
    return x + y + z + w;
  }`);
  const fx = buildSsa(p);
  const phisOf = (name) => fx.blocks.flatMap((b) => [...b.phis.values()]).filter((ph) => fx.varOf.get(ph.var).name === name);
  assert.ok(phisOf('x').length >= 3 && phisOf('i').length >= 1, 'döngü başı ve birleşmelerde φ');
  assert.equal(phisOf('z').length, 0, 'yalnızca girişte tanımlanan değişkene φ yok');
  assert.equal(phisOf('w').length, 0, 'öz-kopya φ\'leri fazla: elendi');
  assert.ok(fx.redundantPhis >= 2);
  // her kullanımın tek bir tanımı var
  for (const ver of fx.useVer.values()) assert.ok(ver && typeof ver.id === 'number');
  assert.match(ssaText(fx, gen), /φ\(/);
  assert.ok(destruct(fx, { allowCopies: false }), 'özgün kodda girişim yok');
}

// ── E683 SSA bozma: girişimde kopya eklenir ────────────
{
  const code = 'function f(c) { var x = 1, y = 2; if (c) { x = y; } return x; } console.log(f(true), f(false));';
  const { ast, p } = fnPath(code);
  const fx = buildSsa(p);
  const join = fx.blocks.find((b) => [...b.phis.values()].some((ph) => fx.varOf.get(ph.var).name === 'x'));
  const phi = [...join.phis.values()].find((ph) => fx.varOf.get(ph.var).name === 'x');
  const yVer = fx.versions.find((v) => fx.varOf.get(v.var).name === 'y' && v.kind === 'def');
  // kopya yayılımı + ölü atama eleme sonrası durum: then dalındaki x = y kaldırılır, φ argümanı y sürümü olur
  const thenPred = [...phi.args.keys()].find((b) => t.isAssignmentExpression(phi.args.get(b).site));
  phi.args.set(thenPred, yVer);
  traverse(ast, { ExpressionStatement(q) { if (gen(q.node) === 'x=y;') q.remove(); } });
  const r = destruct(fx);
  assert.equal(r.copies, 1);
  assert.equal(run(generate(ast).code), '2 1');
  assert.ok(liveness(fx).liveIn.size > 0);
}

// ── E680 SCCP, E661, E695 ─────────────────────────────
{
  const { p } = fnPath('function f(a) { var k = 3; var m = k * 2; if (m !== 6) { return "dead"; } var j = m + a; return j; }');
  const fx = buildSsa(p);
  sccp(fx);
  const m = fx.versions.find((v) => fx.varOf.get(v.var).name === 'm' && v.kind === 'def');
  assert.equal(fx.sccp.val.get(m).c, 6);
  const deadEdges = fx.blocks.flatMap((b) => b.succ).filter((e) => e.cond && !fx.sccp.edges.has(e));
  assert.equal(deadEdges.length, 1, 'her zaman yanlış dal çalıştırılamaz');
}

// ── E690 aralık, E691 tip, E693 uzunluk, E694 null olabilirlik ─────
{
  const { p } = fnPath('function f(a, s) { a = a | 0; var x = a & 15; var t = "ab" + "cd"; var u = null; if (s != null) u = s; for (var i = 0; i < 10; i++) {} return [x, t, u, i]; }');
  const fx = buildSsa(p);
  sccp(fx);
  absint(fx);
  const ver = (n, kind = 'def') => fx.versions.filter((v) => fx.varOf.get(v.var).name === n && v.kind === kind).pop();
  const x = fx.abs.val.get(ver('x'));
  assert.equal(x.ty, T.number);
  assert.deepEqual([x.lo, x.hi, x.int], [0, 15, true]);
  const tt = fx.abs.val.get(ver('t'));
  assert.equal(tt.ty, T.string);
  assert.deepEqual([tt.slo, tt.shi], [4, 4]);
  assert.ok(fx.abs.val.get(ver('u', 'phi')).ty & T.null, 'null olabilir');
  // döngü değişkeninin dal olgusuyla daraltılması: gövde dışında i ≥ 10
  assert.ok(fx.abs.converged);
}

// ── E685 Andersen, E686 Steensgaard, E687 kaçış, E688 etki, E689 taint, E692 şekil ─────
{
  const code = `
    var g = { k: 1 };
    function mk(n) { var o = { id: n, tags: [] }; return o; }
    function store(v) { g.v = v; }
    var a = mk(1), b = a, c = mk(2);
    function useLocal() { var local = { p: 1 }; return local.p; }
    store(c);
    function pure2(x, y) { return x * y; }
    var q = location.hash;
    eval(q);
  `;
  const ast = parse(code);
  const cs = buildConstraints(ast);
  const A = andersen(cs);
  const S = steensgaard(cs);
  const id = (name) => [...cs.nodes].find(([k]) => k.endsWith(`:${name}`))?.[1];
  const shared = [...A.pts[id('a')]].filter((x) => A.pts[id('b')].has(x));
  assert.ok(shared.length === 1, 'a ve b aynı nesneyi gösterir');
  assert.equal(S.deref(id('a')), S.deref(id('b')));
  const rep = staticReport(ast);
  assert.ok(rep.aliases.some((x) => (x.a === 'a' && x.b === 'b') || (x.a === 'b' && x.b === 'a')));
  const esc = Object.fromEntries(rep.escape.map((e) => [e.site, e.escapes]));
  assert.equal(esc['nesne@2'], true, 'global nesne kaçar');
  assert.equal(esc['nesne@6'], false, 'yerel nesne kaçmaz');
  assert.ok(rep.effects.find((e) => e.name === 'pure2').pure);
  assert.ok(!rep.effects.find((e) => e.name === 'store').pure);
  assert.ok(rep.taint.some((f) => f.sink === 'eval' && f.sources.includes('location.hash')));
  assert.ok(rep.shapes.some((s) => s.shape.includes('id:') && s.shape.includes('tags: dizi')));
}

// ── E602 kısmi değerlendirme, E603 özelleştirme ──────
{
  const code = 'function m(s, x) { var o = []; for (var k = 0; k < 3; k++) { switch (s) { case 0: o.push("a" + x); s = 1; break; case 1: o.push("b"); s = 0; break; } } return o.join(); }';
  const { ast, p } = fnPath(code);
  const r = specialize(p, new Map([[0, 0]]), 'm0');
  assert.ok(r && r.stats.unrolled >= 1 && r.stats.branches >= 1);
  const spec = generate(r.fn).code;
  assert.ok(!/switch/.test(spec), 'durum makinesi açıldı');
  assert.equal(run(`${generate(ast).code}\n${spec}\nconsole.log(m(0, 7) === m0(7))`), 'true');
}

// ── E592/E593 köprü: IR çevirisi ve karar ─────────────
{
  const x = V('x', 'int', { lo: 0, hi: 255 });
  const cond = toIR(parse('(x * (x + 1)) % 2 === 1').program.body[0].expression, (n) => (n.name === 'x' ? x : null), { getBinding: () => null });
  const d = decide(cond);
  assert.equal(d.value, false);
  const y = V('y', 'int32');
  assert.equal(decide(mk('>', y, C(5)), [mk('>', y, C(10))]).value, true, 'baskın olgudan korelasyon');
  assert.equal(decide(mk('>', y, C(5))), null);
}

// ── geçişler: davranış korunur ────────────────────────
{
  const passes = await Promise.all(['62-opaque-smt', '55-ssa-opt', '57-loop-opt', '58-specialize', '87-cfg-opt'].map((f) => import(`../src/passes/${f}.js`)));
  const code = `
    function a1(n) { n = n | 0; var k = n & 7; if ((k * (k + 1)) % 2) return -1; var p = n * n + 1, q = n * n + 1; return p + q; }
    function a2(n) { var t = 0; for (var i = 0; i < 3; i++) t = t + i * 5; for (var j = 0; j < n; j++) t += 2; return t; }
    function a3(m, v) { if (m === "x") return v * 2; return v; }
    function a4(d) { switch (d) { case 1: return "one"; default: return "many"; } }
    for (var z = 0; z < 4; z++) console.log(a1(z), a2(z), a3("x", z), a3("y", z), a4(z));
  `;
  let cur = code;
  for (let round = 0; round < 3; round++) {
    for (const ps of passes) {
      const ast = parse(cur);
      await ps.run(ast, { onLog: () => {}, bump: () => {}, level: 4 });
      cur = generate(ast).code;
    }
  }
  assert.equal(run(cur), run(code));
  assert.ok(!/% 2\) return -1/.test(cur));
}

// ── E676 kuyruk çoğaltma (dönüş), E677 ipekleme ─────────
{
  const cfg = await import('../src/passes/87-cfg-opt.js');
  const ssa = await import('../src/passes/55-ssa-opt.js');
  const code = `function td(a) { a = a | 0; var k; if (a > 3) { k = 2; console.log("x"); } else { k = 5; console.log("y"); } return k * 10; }
    function tj(a) { a = a | 0; var f; if (a > 3) { f = 1; console.log("p"); } else { f = 0; console.log("q"); } if (f) console.log("F1"); else console.log("F0"); }
    for (var i = 0; i < 6; i++) { console.log(td(i)); tj(i); }`;
  let cur = code;
  for (const ps of [cfg, ssa, cfg, ssa]) {
    const ast = parse(cur);
    await ps.run(ast, { onLog: () => {}, bump: () => {}, level: 4 });
    cur = generate(ast).code;
  }
  assert.equal(run(cur), run(code));
  assert.ok(/return 2 \* 10/.test(cur) && /return 5 \* 10/.test(cur), 'dönüş kuyruğu dallara çoğaltılıp katlandı');
  assert.ok(!/if \(f\)/.test(cur), 'f üzerinden dal ipeklendi');
}

void t;
console.log('opt.test: ok');
