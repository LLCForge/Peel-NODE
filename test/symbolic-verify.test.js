// Birleşik çözücü + doğrulama API'si öz-denetimi (eski test/solver.test.js ve test/runtime-symbolic.test.js birleşimi):
// node test/symbolic-verify.test.js
import assert from 'node:assert/strict';
import { Sat } from '../src/symbolic/sat.js';
import { V, C, mk, evaluate } from '../src/symbolic/ir.js';
import { solve, solveAsync } from '../src/symbolic/solver.js';
import { minimizeWitness } from '../src/symbolic/concolic.js';
import { z3Available, shutdownZ3 } from '../src/symbolic/z3/z3.js';
import { explore, synthesizeInputs, boundedCheck, divergingInput, proveEquivalent } from '../src/symbolic/verify.js';

// ── SAT temelleri ve artımlı varsayımlar (güvercin yuvası: test/symbolic.test.js) ──
{
  const s = new Sat();
  const [a, b, c] = [s.newVar(), s.newVar(), s.newVar()];
  s.add([a, b]); s.add([-a, c]); s.add([-b, c]);
  const r = s.solve();
  assert.equal(r.status, 'sat');
  assert.equal(r.model[c], 1);
  s.add([-c]);
  assert.equal(s.solve().status, 'unsat');
  const t = new Sat();
  const x1 = t.newVar();
  const x2 = t.newVar();
  t.add([x1, x2]);
  assert.equal(t.solve({ assumptions: [-x1, -x2] }).status, 'unsat');
  assert.equal(t.solve({ assumptions: [-x1] }).status, 'sat');
}

// ── MBA özdeşliği: yerleşik çözücü (DRUP denetimli) ve z3 ──
const x = V('x', 'int32');
const y = V('y', 'int32');
const mba = mk('!==', mk('+', mk('^', x, y), mk('*', C(2), mk('&', x, y))), mk('+', x, y));
{
  const t0 = Date.now();
  const rb = await solveAsync([mba], { backend: 'builtin', mode: 'prove', timeMs: 5000 });
  assert.equal(rb.status, 'unsat');
  assert.equal(rb.proof.checked, true);
  assert.ok(Date.now() - t0 < 5000, 'MBA çok yavaş');
  const eq = await proveEquivalent('function f(x, y) { return (x ^ y) + 2 * (x & y); }', '(a, b) => a + b', { backend: 'builtin' });
  assert.equal(eq.status, 'proved');
  assert.equal(eq.checked, true);
}
if (await z3Available()) {
  const z = await solveAsync([mba], { backend: 'z3' });
  assert.equal(z.status, 'unsat');
  assert.equal(z.proof.checked, false, 'z3 UNSAT denetlenmemiş sayılır');
  const ez = await proveEquivalent('function f(x, y) { return (x | y) - (x & y); }', '(a, b) => a ^ b', { backend: 'z3' });
  assert.equal(ez.status, 'proved');
  assert.equal(ez.backend, 'z3');
  assert.equal(ez.checked, false);
  // z3 SAT modelleri JS anlamıyla yeniden doğrulanır
  const zs = await solveAsync([mk('===', mk('%', x, C(5)), C(-3)), mk('<', mk('>>', y, C(2)), C(-1))], { backend: 'z3' });
  assert.equal(zs.status, 'sat');
  assert.equal(zs.model.get('x') % 5, -3);
} else {
  console.log('symbolic-verify: z3 yok, yalnızca yerleşik çözücü denendi');
}

// ── çürütme + tanık + küçültülmüş karşı örnek ──
{
  // x < ((x + 1) | 0) değil: yalnızca int32 taşmasında (x = 2^31 - 1)
  const wrap = mk('!', mk('<', x, mk('|', mk('+', x, C(1)), C(0))));
  const r = solve([wrap]);
  assert.equal(r.status, 'sat');
  assert.equal(evaluate(wrap, r.model), true);
  assert.equal(r.model.get('x'), 2147483647);
  const ref = await proveEquivalent('function f(x) { return x > 100 ? x - 1 : x; }', 'function g(x) { return x; }');
  assert.equal(ref.status, 'refuted');
  assert.ok(ref.witnessVerified);
  assert.deepEqual(ref.minimized, [101]);
  assert.deepEqual(minimizeWitness([mk('<', C(1000), x)], { x: 2000000 }), { x: 1001 });
  assert.equal(evaluate(mk('+', C(2), C(3)), new Map()), 5);
  assert.equal(evaluate(mk('imul', C(0x7fffffff), C(3)), new Map()), Math.imul(0x7fffffff, 3));
}

// ── bütçe → unknown (çarpanlara ayırma) ──
{
  const p = V('p', 'int', { lo: 2, hi: 2 ** 26 });
  const q = V('q', 'int', { lo: 2, hi: 2 ** 26 });
  const hard = mk('===', mk('*', p, q), C(1000003 * 999983));
  const tc = solve([hard], { maxConflicts: 10 });
  assert.equal(tc.status, 'unknown');
  assert.match(tc.reason, /bütçe/);
  const big = solve([mk('===', mk('*', x, y), C(5))]);
  assert.equal(big.status, 'unknown', '2^53 üstü ara değer: double yuvarlaması nedeniyle bilinmiyor');
}

// ── E733–E737: yol keşfi ──
const TWO_IFS = 'function f(a, b) { let r = 0; if (a > 0) r = 1; else r = 2; if (b > 0) r += 10; return r; }';
{
  const merged = explore(TWO_IFS);
  assert.equal(merged.status, 'ok');
  assert.equal(merged.forks, 2);
  assert.equal(merged.merges, 2);
  assert.equal(merged.paths.length, 1);
  assert.equal(merged.paths[0].pc, 'true');
  const forked = explore(TWO_IFS, { merge: false });
  assert.equal(forked.paths.length, 4);
  assert.equal(forked.merges, 0);
  // yalnızca b sembolik, a somut → tek çatallanma
  const inj = explore(TWO_IFS, { symbolic: ['b'], concrete: { a: 5 }, merge: false });
  assert.equal(inj.forks, 1);
  assert.deepEqual(inj.inputs, ['arg1']);
  const glob = explore('function f(x) { return x + LIMIT; }', { globals: { LIMIT: 'symbolic' } });
  assert.deepEqual(glob.inputs, ['arg0', 'g_LIMIT']);
  // sınırlayıcı
  const many = 'function f(a, b, c, d) { let r = 0; if (a) r++; if (b) r++; if (c) r++; if (d) r++; return r; }';
  const lim = explore(many, { merge: false, maxPaths: 5 });
  assert.match(lim.limited, /yol sınırı/);
  assert.ok(lim.paths.some((p) => p.kind === 'limit'));
  assert.match(explore(many, { merge: false, maxDepth: 2 }).limited, /derinlik/);
  assert.equal(explore(many).limited, null);
  // budama ve kısıt deposu
  const pr = explore('function f(x) { if (x > 5) { if (x < 3) return 1; return 2; } return 3; }', { merge: false, prune: true });
  assert.equal(pr.pruned, 1);
  assert.equal(pr.paths.length, 2);
  assert.ok(pr.store.queries >= 2);
}

// ── E702: sınırlı model kontrolü ──
{
  const sum = 'function s(n) { let t = 0; for (let i = 0; i < n; i++) t += i; return t; }';
  const ok = await boundedCheck(sum, 'result >= 0', { bound: 4 });
  assert.equal(ok.status, 'holds');
  assert.equal(ok.complete, false);
  const bad = await boundedCheck(sum, 'result < 5', { bound: 4 });
  assert.equal(bad.status, 'violated');
  assert.ok(bad.minimized[0] >= 4 && bad.result.value >= 5);
  const full = await boundedCheck('function g(n) { let k = 0; while (k < 3) k++; return k + n * 0; }', 'result === 3', { bound: 5 });
  assert.equal(full.status, 'holds');
  assert.equal(full.complete, true);
}

// ── E739: sentezlenen girdiler her dalı kapsar ──
{
  const src = 'function f(a, b) { if (a > 5) { if (b === a * 2) return 1; return 2; } return 3; }';
  const syn = synthesizeInputs(src);
  const fn = (a, b) => { if (a > 5) { if (b === a * 2) return 1; return 2; } return 3; };
  assert.deepEqual(new Set(syn.inputs.map(([a, b]) => fn(a, b))), new Set([1, 2, 3]));
}

// ── E703: ayrışan girdi ve yol koşulları; throw/dönüş sınıfı; desteklenmeyen yapı; döngü sınırı ──
{
  const div = await divergingInput('function f(x) { if (x > 10) return x - 1; return x; }', 'function g(x) { return x; }');
  assert.equal(div.found, true);
  assert.deepEqual(div.input, [11]);
  assert.match(div.pathA, /arg0 > 10/);
  assert.equal((await divergingInput('(x) => x * 2', '(x) => x + x')).found, false);
  const th = await proveEquivalent('function f(x) { if (x === 0) throw 1; return 1; }', 'function g(x) { return 1; }');
  assert.equal(th.status, 'refuted');
  assert.deepEqual(th.minimized, [0]);
  assert.equal((await proveEquivalent('function f(x) { return foo(x); }', '(x) => x')).status, 'unsupported');
  assert.equal((await proveEquivalent('function f(x) { while (x > 0) x--; return x; }', '(x) => x > 0 ? 0 : x', { bound: 3 })).status, 'unknown');
  // Math.imul ve bit kaydırma eşdeğerliği
  assert.equal((await proveEquivalent('(x) => Math.imul(x, 8)', '(x) => x << 3')).status, 'proved');
}

await shutdownZ3();
console.log('symbolic-verify: ok');
