// Sembolik yürütme / çözücü öz-denetimi: node test/symbolic.test.js
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { parse } from '../src/core/parse.js';
import { Sat, checkDrup } from '../src/symbolic/sat.js';
import { C, V, mk, evaluate, show, types, substitute } from '../src/symbolic/ir.js';
import { solve, implies } from '../src/symbolic/solver.js';
import { ConstraintStore } from '../src/symbolic/store.js';
import { parseRegex, toNfa, nfaTest, synthesizeRegex } from '../src/symbolic/regex.js';
import { Exec, SummaryTable } from '../src/symbolic/exec.js';
import { concolic, minimizeWitness, proveCorrelation } from '../src/symbolic/concolic.js';
import { dynamicReport, mineSpecs } from '../src/symbolic/dynamic.js';
import { symbolicReport } from '../src/symbolic/report.js';

const host = createHost(await getQuickJS());
const sandbox = sandboxApi(async (msg) => host.handle(msg));

// ── SAT + DRUP (E594 kanıt üretimi) ────────────────────
{
  const s = new Sat();
  const x = Array.from({ length: 5 }, () => Array.from({ length: 4 }, () => s.newVar()));
  for (const row of x) s.add(row);
  for (let h = 0; h < 4; h++) for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) s.add([-x[a][h], -x[b][h]]);
  const r = s.solve();
  assert.equal(r.status, 'unsat');
  assert.ok(checkDrup(s.n, s.clauses, r.proof).ok, 'güvercin yuvası DRUP kanıtı denetlenmeli');
  // bozuk kanıt reddedilir
  assert.equal(checkDrup(s.n, s.clauses, [[x[0][0]], []]).ok, false);
}

// ── E581 IR, E599 tip modeli ──────────────────────────
{
  const a = V('a', 'int32');
  const sv = V('s', 'str', { cap: 6 });
  assert.equal(show(mk('+', mk('*', a, C(2)), C(1))), 'a * 2 + 1');
  assert.deepEqual([...types(mk('+', sv, a))], ['string']);
  assert.deepEqual([...types(mk('+', V('u', 'any'), C(1)))].sort(), ['number', 'string']);
  assert.equal(mk('typeof', sv).v, 'string');
  assert.equal(evaluate(mk('charCodeAt', sv, C(1)), new Map([['s', 'xy']])), 121);
  assert.equal(show(substitute(mk('-', a, C(1)), new Map([['a', C(5)]]))), '4');
}

// ── E589 bit-vektör/dizi/string çözücü, E590 string, E592 opaque, E601 aralık ──
{
  const x = V('x', 'int32');
  let r = solve([mk('===', mk('^', mk('*', x, C(3)), C(0x55)), C(0x1234))]);
  assert.equal(r.status, 'sat');
  assert.equal(((r.model.get('x') * 3) ^ 0x55), 0x1234);
  // x*(x+1) her zaman çift (x: 16 bit): kanıtlı UNSAT
  const y = V('y', 'int', { lo: 0, hi: 65535 });
  r = solve([mk('!==', mk('%', mk('*', y, mk('+', y, C(1))), C(2)), C(0))], { mode: 'prove' });
  assert.equal(r.status, 'unsat');
  assert.ok(r.proof.method === 'sat-drup' ? r.proof.checked : true);
  // aralık budaması
  r = solve([mk('<', V('k', 'int', { lo: 5, hi: 9 }), C(3))]);
  assert.equal(r.status, 'unsat');
  assert.equal(r.proof.method, 'interval');
  // string kısıtları + regex üyeliği
  const s = V('s', 'str', { cap: 10 });
  r = solve([mk('startsWith', s, C('ru')), mk('===', mk('len', s), C(5)), mk('retest', C('^[a-z]+\\d$'), C(''), s)]);
  assert.equal(r.status, 'sat');
  assert.match(r.model.get('s'), /^ru[a-z]{2}\d$/);
  r = solve([mk('===', mk('indexOf', s, C('bot')), C(2)), mk('endsWith', s, C('!'))]);
  assert.equal(r.status, 'sat');
  assert.equal(r.model.get('s').indexOf('bot'), 2);
  // dizi modeli: sembolik indeksle seçim (ite zinciri)
  const i = V('i', 'int32');
  const arr = [C(10), C(20), C(30)];
  let sel = C(undefined);
  for (let k = arr.length - 1; k >= 0; k--) sel = mk('ite', mk('===', i, C(k)), arr[k], sel);
  r = solve([mk('===', sel, C(30))]);
  assert.equal(r.model.get('i'), 2);
  // tip bölme: any değişken
  r = solve([mk('===', mk('typeof', V('u', 'any')), C('boolean')), mk('!', V('u', 'any'))]);
  assert.equal(r.model.get('u'), false);
  // E593 için çıkarım
  assert.ok(implies([mk('>', x, C(10))], mk('>', x, C(5)), { mode: 'prove' }).holds);
}

// ── E582 kısıt deposu ─────────────────────────────────
{
  const st = new ConstraintStore();
  const x = V('x', 'int32');
  assert.equal(st.assert(mk('>', x, C(3))), 'added');
  assert.equal(st.assert(mk('>', x, C(3))), 'redundant');
  st.push();
  assert.equal(st.assert(mk('<=', x, C(3))), 'conflict');
  st.pop();
  assert.ok(st.implies(mk('>', x, C(2))));
  assert.equal(st.check([mk('===', V('z', 'int32'), C(7))]).status, 'sat');
}

// ── E591 regex sentezi ve NFA ─────────────────────────
{
  const nfa = toNfa(parseRegex('^(ab|c)+\\d{2}$'));
  for (const s of ['ab12', 'cab99', 'ab1', 'x12', 'ababc00']) assert.equal(nfaTest(nfa, s), /^(ab|c)+\d{2}$/.test(s), s);
  assert.equal(parseRegex('(?<=a)b'), null);
  const re = synthesizeRegex(['ru-RU', 'ru-UA', 'ru-BY'], ['en-US', 'tr-TR']);
  const rx = new RegExp(re.source);
  assert.ok(['ru-RU', 'ru-UA', 'ru-BY'].every((s) => rx.test(s)) && !rx.test('en-US') && !rx.test('tr-TR'));
}

// ── E583–E585, E596–E598, E600–E610: sembolik yürütücü ─────
{
  const ast = parse(`
    function sign(x) { if (x > 0) return 1; if (x < 0) return -1; return 0; }
    function f(k, s) {
      var arr = [3, 5, 7], t = 0, o = { a: k };
      for (var i = 0; i < arr.length; i++) t += arr[i] * k;
      if (s.startsWith("ru") && s.length === 5) { console.log("hidden"); return t; }
      if (sign(k) === -1) return "neg";
      if (k > 100 && k < 50) return "infeasible";
      return o.a + 1;
    }
    function loop(n) { var c = 0; while (c < n) c++; return c; }
  `);
  const [sign, f, loop] = ast.program.body;
  const args = [V('k', 'int32'), V('s', 'str', { cap: 8 })];
  const split = new Exec(ast, { merge: false }).runFunction(f, args);
  assert.ok(split.paths.length >= 5, 'çatallanma');
  assert.ok(split.stats.pruned >= 1 || split.stats.decided >= 1, 'budama');
  assert.ok(!split.paths.some((p) => p.status === 'return' && p.value.k === 'c' && p.value.v === 'infeasible'));
  const hidden = split.paths.find((p) => p.out.includes('"hidden"'));
  assert.ok(hidden, 'string modelli yol');
  const m = solve(hidden.pc);
  assert.equal(m.status, 'sat');
  assert.ok(m.model.get('s').startsWith('ru'));
  const merged = new Exec(ast, { merge: true }).runFunction(f, args);
  assert.ok(merged.paths.length < split.paths.length && merged.stats.merges > 0, 'birleştirme');
  // E604 kısmi açma + havoc, E609 bütçe, E610 iz
  const lr = new Exec(ast, { unroll: 2 }).runFunction(loop, [V('n', 'int32')]);
  assert.ok(lr.paths.some((p) => p.approx), 'havoc yaklaşık yol');
  const tiny = new Exec(ast, { maxSteps: 5 }).runFunction(f, args);
  assert.equal(tiny.stats.exhausted, 'adım bütçesi');
  assert.ok(split.paths[0].trace.some((e) => e.kind === 'dal'));
  // E606–E608 özetler
  const table = new SummaryTable(ast);
  const sm = table.summarize(sign);
  assert.ok(sm.valid && sm.cases.length >= 1);
  const withSum = new Exec(ast, { summaries: table }).runFunction(f, args);
  assert.ok(table.hits >= 1 && withSum.paths.some((p) => p.trace.some((e) => e.kind === 'özet')));
  assert.equal(table.summarize(sign), sm, 'özet tablosu önbelleği');
}

// ── E586–E588, E591, E593, E595: concolic ─────────────
{
  const prog = `
    var lang = navigator.language, host = location.hostname;
    if (lang.startsWith("ru")) { if (host === "bank.example") console.log("payload"); }
    if ((Date.now() & 255) === 77) console.log("bomb");
    if (lang === "xx") console.log("x1");
    if (lang === "xx") console.log("x2");
  `;
  const r = await concolic(sandbox, prog, { maxRuns: 12, timeMs: 8000 });
  assert.ok(r.ok);
  const outs = r.runs.flatMap((x) => x.out);
  assert.ok(outs.includes('payload') && outs.includes('bomb'), 'gizli dallar tetiklenmeli');
  const pay = r.runs.find((x) => x.out.includes('payload'));
  assert.equal(pay.minimized?.['location.hostname'] ?? pay.inputs['location.hostname'], 'bank.example');
  assert.ok(r.coverage.ratio > 0.8);
  assert.ok(r.regexes.length >= 1);
  assert.ok(r.correlations.some((c) => c.relation === 'aynı' && c.proven), 'aynı koşullu dallar kanıtlı korele');
  const fr = await concolic(sandbox, 'function chk(a, b) { if (a * 3 + b === 100) { if (b > 50) return "deep"; } return "no"; }', { target: { name: 'chk', params: 2 } });
  assert.ok(fr.runs.some((x) => x.minimized && x.minimized.arg0 * 3 + x.minimized.arg1 === 100));
  const x = V('x', 'int32');
  assert.deepEqual(minimizeWitness([mk('>', x, C(40))], { x: 123456 }), { x: 41 });
  assert.ok(proveCorrelation(mk('>', x, C(3)), mk('<=', x, C(3)), 'ters'));
}

// ── E696, E699, E700: dinamik ─────────────────────────
{
  const d = await dynamicReport(sandbox, 'function inc(a){ return a + 1; } function open(){} function send(){} for (var i = 0; i < 4; i++) { open(); console.log(inc(i * 2)); send(); }');
  assert.ok(d.ok);
  const inc = d.invariants.find((f) => f.fn === 'inc');
  assert.ok(inc.items.some((x) => x.expr === 'sonuç === a + 1'));
  assert.ok(inc.items.some((x) => x.expr === 'a % 2 === 0'));
  assert.ok(d.specs.some((s) => s.rule === 'open → send'));
  assert.ok(d.assertions.some((a) => a.valid && a.assertion.includes('ret === a + 1')));
  assert.deepEqual(mineSpecs(['a', 'b', 'a', 'b']).find((s) => s.rule === 'a → b')?.support, 2);
}

// ── rapor birleşimi (E597/E594 kanıt metni dahil) ─────
{
  const code = 'function f(a){ var x = a & 255; if ((x * (x + 1)) % 2 !== 0) return 1; return a + 2; } console.log(f(3));';
  const rep = await symbolicReport({ text: code, output: code, sandbox, timeMs: 5000 });
  assert.ok(rep.opaque.some((o) => o.value === false && o.proof));
  assert.ok(rep.symbolic.functions[0].postcondition.length >= 1);
  assert.ok(rep.static.effects.length >= 1);
  assert.ok(rep.solver.calls > 0);
}


// ── madde 27: VM çözücü bağdaştırıcısı (concolic çoklu yol keşfi) ──
{
  const { createVmSolver } = await import('../src/symbolic/vm-solver.js');
  const code = 'var l = navigator.language; var s = 0; if (l === "tr-TR") s = 7; if (l.length > 40 && l.length < 10) s = 9; console.log(s);';
  const branches = [{ key: '0:0', start: code.indexOf('l === "tr-TR"') }, { key: '0:1', start: code.indexOf('l.length > 40') }];
  const plans = await createVmSolver(sandbox).planBranches({ log: [['0:0', false], ['0:1', false]], branches, code });
  const p0 = plans.find((p) => p.key === '0:0');
  assert.equal(p0.status, 'feasible');
  assert.equal(p0.inputs['navigator.language'], 'tr-TR');
  assert.equal(plans.find((p) => p.key === '0:1').status, 'infeasible');
}
console.log('symbolic.test: ok');
