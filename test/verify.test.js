// Doğrulama ve güven katmanı öz-denetimi: node test/verify.test.js
// C47, I176–I186, E706–E723, E738–E743
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { deobfuscate } from '../src/core/pipeline.js';
import { effectVector, semanticHash, cluster, selectRegression, diffEffects, traceEquivalent, effectDiff } from '../src/verify/effects.js';
import { bisimulate } from '../src/verify/bisim.js';
import { functionEquivalence, matchFunctions, topFunctions } from '../src/verify/equiv.js';
import { differentialFuzz, mutationScore, triage, crashSignature } from '../src/verify/fuzz.js';
import { mutants } from '../src/verify/mutate.js';
import { rng, expand, argVectors, toSource } from '../src/verify/grammar.js';
import { executionDeterminism, pipelineDeterminism, idempotence } from '../src/verify/determinism.js';
import { buildBundle, signBundle, checkBundle, signReport, verifyPayload, canonical, sha256 } from '../src/verify/proof.js';
import { failureReport, failureMarkdown } from '../src/verify/failure.js';
import { createBudget, tightenPlan } from '../src/verify/budget.js';
import { trustScore, passRisk, successMetric, observedRanges } from '../src/verify/trust.js';
import { rationaleLog } from '../src/verify/rationale.js';
import { issueTemplate } from '../src/verify/template.js';
import { runVerification, verificationSummary } from '../src/verify/run.js';
import { compareProfiles } from '../src/sandbox/compare.js';
import { shutdownZ3 } from '../src/symbolic/z3/z3.js';

const host = createHost(await getQuickJS());
const sb = sandboxApi(async (m) => host.handle(m));
const fx = (kind, target, detail = '') => ({ kind, target, detail });

// E711/E712/E713/E714/E743/E708
const A = [fx('console', 'log', 'a'), fx('net', 'fetch', 'GET /x'), fx('storage.read', 'k')];
const B = [fx('console', 'log', 'a'), fx('net', 'fetch', 'GET /y')];
assert.equal(effectVector(A).total, 2, 'okumalar gözlenebilir değil');
assert.equal(semanticHash(A.slice(0, 2)), semanticHash([...A.slice(0, 2), fx('storage.read', 'z')]));
assert.notEqual(semanticHash(A), semanticHash(B));
const d = diffEffects(A, B);
assert.deepEqual(d.summary, { same: 1, add: 0, del: 0, change: 1 });
assert.deepEqual(traceEquivalent(A, B).index, 1);
assert.ok(traceEquivalent(A, [...A]).equivalent);
const cl = cluster([{ id: 'x', effects: A }, { id: 'y', effects: [...A] }, { id: 'z', effects: [fx('dialog', 'alert', '!')] }]);
assert.equal(cl.length, 2);
assert.deepEqual(cl[0].members, ['x', 'y']);
const sel = selectRegression({
  samples: [{ id: 'f1', passes: ['proxy'], semHash: 'h1' }, { id: 'f2', passes: ['rename'], semHash: 'h1' }, { id: 'f3', passes: [], semHash: null }, { id: 'f4', passes: ['vm'], semHash: 'h2' }],
  previousPassHashes: { proxy: 'a', rename: 'b', vm: 'c' }, currentPassHashes: { proxy: 'a2', rename: 'b', vm: 'c' },
});
assert.deepEqual(sel.selected.map((s) => s.id).sort(), ['f1', 'f3', 'f4']);
assert.deepEqual(sel.changedPasses, ['proxy']);

// E715: aynı ortamda etki farkı
const ed = await effectDiff(sb, 'console.log(1); fetch("/a")', 'console.log(1); fetch("/b")');
assert.equal(ed.diff.summary.change, 1);
assert.equal(ed.trace.equivalent, false);

// E707: zayıf bisimülasyon — kaldırılan debug protection zamanlayıcısı ilişkiyi bozmaz, farklı işleyici bozar
const orig = 'setInterval(function () { debugger; }, 4000); document.addEventListener("click", function () { console.log("c"); }); console.log("start");';
const clean = 'document.addEventListener("click", function () { console.log("c"); }); console.log("start");';
const wrong = 'document.addEventListener("click", function () { console.log("d"); }); console.log("start");';
assert.equal((await bisimulate(sb, orig, clean)).bisimilar, true);
const br = await bisimulate(sb, orig, wrong);
assert.equal(br.bisimilar, false);
assert.equal(br.brokenAt, 'olay: click');

// I179/E701/E705: fonksiyon eşdeğerliği — isim/sıra eşleştirme, SMT kanıtı, ayrışmada küçültülmüş karşı örnek
assert.equal(topFunctions('function a(x){return x} var b = (y) => y; let c = 1;').length, 2);
assert.deepEqual(matchFunctions([{ name: '_0x1', arity: 2 }], [{ name: 'add', arity: 2 }]).map((p) => p[2]), ['sıra']);
const fe = await functionEquivalence(sb,
  'function _0xa(x, y) { return ((x | 0) ^ (y | 0)) + 2 * ((x | 0) & (y | 0)) | 0; } function _0xb(s) { return s + "!"; }',
  'function add(x, y) { return (x | 0) + (y | 0) | 0; } function bang(s) { return s.length > 3 ? s + "!" : s + "?"; }');
const add = fe.pairs.find((p) => p.b === 'add');
assert.equal(add.status, 'proved', JSON.stringify(add.proof));
const bang = fe.pairs.find((p) => p.b === 'bang');
assert.equal(bang.status, 'differs');
assert.ok(JSON.stringify(bang.minimized).length <= JSON.stringify(bang.counterexample).length);

// E740 gramer, E741 mutasyon, E742 triyaj, I178 + E738 coverage geri beslemeli diferansiyel fuzz
const r1 = rng(9);
const r2 = rng(9);
assert.deepEqual([expand('<json>', r1), expand('<url>', r1)], [expand('<json>', r2), expand('<url>', r2)], 'tohum aynı → aynı dizi');
assert.equal(argVectors(2, 5, 3).length, 5);
assert.equal(toSource({ __proto__: null, a: [1, -0, NaN] }), '{ ["a"]: [1, -0, NaN] }');
const ms = mutants('function f(a) { if (a > 1) { return a + 1; } return 0; } console.log(f(2));', 6, 1);
assert.ok(ms.length >= 3 && ms.every((m) => m.code && m.description));
assert.equal(crashSignature('TypeError: _0x1a2b is not a function at 12'), crashSignature('TypeError: _0xff is not a function at 99'));
assert.equal(triage([{ side: 'girdi', message: 'x 1', env: { a: 1, b: 2 } }, { side: 'girdi', message: 'x 2', env: { a: 1 } }])[0].count, 2);
const envDep = 'if (navigator.webdriver) console.log("bot"); else console.log("human"); if (document.cookie.indexOf("k") >= 0) console.log("cookie");';
const fz = await differentialFuzz(sb, envDep, 'if (navigator.webdriver) console.log("bot"); else console.log("human");', { iterations: 16, seed: 4 });
assert.equal(fz.equivalent, false, 'çerez dalı kaldırıldı: fuzz yakalamalı');
assert.ok(fz.divergences[0].minimized.cookie !== '' && fz.divergences[0].minimized.profile === 'default', 'küçültülmüş ortam yalnızca çerezi tutar');
assert.ok(fz.coverage.growth.at(-1) >= 1);
const same = await differentialFuzz(sb, envDep, envDep, { iterations: 6 });
assert.ok(same.equivalent);
const score = await mutationScore(sb, 'var x = 2; if (x > 1) { console.log("big", x + 1); } else { console.log("small"); }', { count: 6 });
assert.ok(score.mutants >= 3 && score.killed >= 2, JSON.stringify(score));

// E709/I186/E710
const det = await executionDeterminism(sb, 'console.log(Math.random(), Date.now())');
assert.ok(det.deterministic && det.dependsOnTime && det.dependsOnRandom);
const pd = await pipelineDeterminism(deobfuscate, 'var a = "\\x68\\x69"; console.log(a);', { level: 2 });
assert.ok(pd.reproducible && /^[0-9a-f]{64}$/.test(pd.sha256));
const first = await deobfuscate('var a = "\\x68\\x69"; console.log(a);', { level: 2 });
const idem = await idempotence(deobfuscate, first.code, { level: 2 });
assert.equal(idem.idempotent, true, JSON.stringify(idem));

// E717: kanıt taşıyan, imzalı çıktı; değiştirilmiş paket reddedilir
const bundle = await buildBundle({ input: 'eval("1")', output: '1;', events: [{ id: 'unpack', state: 'ok', round: 0 }], semantic: { input: 'h', output: 'h', equal: true } });
const signed = await signBundle(bundle);
assert.deepEqual(await checkBundle(signed, { input: 'eval("1")', recheck: async () => 'h' }), { valid: true, problems: [] });
const forged = structuredClone(signed);
forged.payload.code = '2;';
const chk = await checkBundle(forged);
assert.ok(chk.problems.includes('imza geçersiz') && chk.problems.includes('çıktı özeti uyuşmuyor'));
assert.ok(await verifyPayload(await signReport({ a: 1 })));
assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 0 }] }), '{"a":[2,{"c":0,"d":1}],"b":1}');
assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

// E719/E720/E723: bütçe ve kademeli sıkılaştırma
let clock = 0;
const bud = createBudget({ ms: 100, runs: 3, now: () => clock });
bud.charge({ runs: 2 });
assert.equal(bud.exhausted(), false);
clock = 150;
assert.equal(bud.exhausted(), true);
assert.equal(tightenPlan('effects', {}).target, 'effects');
assert.equal(tightenPlan('effects', { rollbacks: 1 }).target, 'functions');
assert.equal(tightenPlan('behaviour', { rollbacks: 1, observation: 2, coverage: 0.2 }).target, 'proof');

// I176/I181/I184/I177/E718
const events = [
  { id: 'string-array', state: 'ok', round: 1, verifiedBy: 'effects', observation: true, observed: ['s:hello'], delta: -40, before: 'a', after: 'b' },
  { id: 'unflatten', state: 'fail', round: 1, reason: 'davranış' },
  { id: 'rename', state: 'ok', round: 1, verifiedBy: 'effects', delta: 0 },
];
const risks = passRisk(events, { verified: true });
assert.equal(risks.find((r) => r.id === 'unflatten').risk, 'high');
assert.equal(risks.find((r) => r.id === 'rename').risk, 'low');
const metrics = { inBytes: 1000, outBytes: 400, hexCallsBefore: 10, hexCallsAfter: 0, obfuscatedIdsBefore: 20, obfuscatedIdsAfter: 2, vmMarks: 0 };
assert.ok(successMetric(metrics).score >= 90);
const ts = trustScore({ verifyLevel: 'effects', events, metrics, coverage: { ok: true, ratio: 0.9 } });
assert.ok(ts.score > 50 && ts.reasons.length >= 4);
assert.ok(trustScore({ verifyLevel: 'effects', events, metrics, verification: { checks: { trace: { equivalent: false } } } }).score < ts.score);
const ranges = observedRanges('var a = "hello";\nconsole.log("hello", "x");', events, 'var _0x = ["hello"]; console.log(_0x[0], "x");');
assert.deepEqual(ranges.map((r) => r.line), [1, 2]);
assert.equal(ranges[0].pass, 'string-array');
const log = rationaleLog(events);
assert.match(log[0].why, /sandbox gözlemi \(1 değer\)/);
assert.match(log[1].why, /geri alındı: davranış/);

// E706: pipeline her pass'i console + etkilerle doğrular, gerekçe alanları olaylarda
const pr = await deobfuscate('var k = ["\\x68\\x69"]; fetch("/c?x=" + k[0]); console.log(k[0]);', { level: 3, sandbox: sb, deep: true, verifyLevel: 'effects' });
assert.equal(pr.verifyLevel, 'effects');
const okEv = pr.events.find((e) => e.state === 'ok');
assert.ok(okEv.verifiedBy === 'effects' && typeof okEv.before === 'string');

// orkestrasyon + başarısız kanıt raporu (E721)
const vr = await runVerification({ sandbox: sb, text: orig, output: wrong, events, level: 'effects' });
assert.equal(vr.checks.effects.equal, true, 'işleyici çalışmadan etki aynı');
assert.equal(vr.checks.bisimulation.bisimilar, false);
assert.ok(vr.plan.reasons.length >= 1);
assert.equal(vr.failure.ok, false);
assert.match(failureMarkdown(vr.failure), /bisimülasyon/);
assert.ok(failureReport({ checks: {} }).ok);
const summary = verificationSummary({ input: orig, text: orig, output: clean, events: [], metrics, coverage: null, verification: vr, verifyLevel: 'effects' });
assert.ok(summary.trust.reasons.some((r) => /bisimülasyon başarısız/.test(r)));

// I185: issue şablonu — gizli değerler maskelenir
const md = issueTemplate({ report: { metrics, rollbacks: [{ id: 'vm', round: 2, reason: 'davranış' }], verification: vr }, input: 'var k = "sk_live_abcdefghijklmnop1234";', output: '1', includeCode: true });
assert.ok(md.includes('labels: wrong-result') && md.includes('`vm`') && !md.includes('sk_live') && md.includes('bisimülasyon'));

// C47: profil karşılaştırması
const cmp = await compareProfiles(sb, 'if (navigator.webdriver) fetch("/bot"); else console.log("insan");');
assert.equal(cmp.same, false);
assert.deepEqual(cmp.onlyA.console, ['insan']);
assert.ok(cmp.onlyB.network[0].includes('/bot'));

await shutdownZ3();
console.log('verify: ok');
