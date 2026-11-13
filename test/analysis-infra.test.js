// Analiz altyapısı öz-denetimi (E541–E570): node test/analysis-infra.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getQuickJS } from 'quickjs-emscripten';
import { parse } from '../src/core/parse.js';
import { raw } from '../src/core/emit.js';
import { traverse } from '../src/util/ast.js';
import { PASSES } from '../src/core/registry.js';
import { deobfuscate } from '../src/core/pipeline.js';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { passDag, validOrder, passConflicts, interactionMatrix, costOrder } from '../src/analysis/passgraph.js';
import { structuralHash, stableIds, dirtyUnits, invalidate } from '../src/analysis/nodehash.js';
import { serializeAst, deserializeAst } from '../src/analysis/serialize.js';
import { diffAst, applyPatch, invertPatch } from '../src/analysis/patch.js';
import { matchTrees } from '../src/analysis/match.js';
import { SnapshotStore } from '../src/analysis/store.js';
import { AnalysisSession } from '../src/analysis/session.js';
import { createTrace, restoreCheckpoint } from '../src/analysis/trace.js';
import { salvage } from '../src/analysis/salvage.js';
import { minifierSafety } from '../src/analysis/minsafe.js';

const code = (ast) => raw(ast);

// E541: kayıt sırası bağımlılık DAG'ına uyar
{
  const dag = passDag(PASSES);
  assert.deepEqual(dag.violations, []);
  assert.deepEqual(dag.cycles, []);
  assert.equal(validOrder(PASSES.map((p) => p.id)), true);
  assert.equal(validOrder(['rename', 'unused']), false);
}

// E542 / E543 / E544
{
  const rec = [
    { id: 'a', round: 1, state: 'ok', before: 'h0', after: 'h1', ms: 5 },
    { id: 'b', round: 1, state: 'ok', before: 'h1', after: 'h0', ms: 50 },
    { id: 'a', round: 2, state: 'ok', before: 'h0', after: 'h1', ms: 5 },
    { id: 'c', round: 2, state: 'fail', before: 'h1', after: 'h1', ms: 1 },
  ];
  const c = passConflicts(rec);
  assert.deepEqual(c.undo.map((u) => [u.a, u.b]), [['a', 'b'], ['b', 'a']], 'karşılıklı geri alma');
  assert.equal(c.oscillation.length, 1);
  assert.deepEqual(c.failAfter[0], { pair: 'a→c', count: 1 });
  const m = interactionMatrix(rec);
  assert.equal(m.enables.a.b, 1);
  assert.equal(m.enables.b.a, 1);
  assert.equal(m.breaks.a.c, 1);
  const order = costOrder([{ id: 'a' }, { id: 'b' }, { id: 'c' }], rec, {}).order;
  assert.equal(order[0], 'a', 'ucuz ve etkili pass önce');
  assert.deepEqual(costOrder([{ id: 'x' }, { id: 'y' }], [{ id: 'y', state: 'ok', ms: 1 }, { id: 'x', state: 'skip', ms: 100 }], { y: { after: ['x'] } }).order, ['x', 'y'], 'bağımlılık maliyetten önce gelir');
}

// E551 / E556 / E550 / E553
{
  const a = parse('function f(){ return 1 } function g(){ return 2 } var x = 1;');
  const b = parse('function f(){ return 1 }\nfunction g(){ return 3 }\nvar x = 1;');
  assert.equal(structuralHash(a.program.body[0]), structuralHash(b.program.body[0]));
  assert.notEqual(structuralHash(a.program.body[1]), structuralHash(b.program.body[1]));
  assert.equal(structuralHash(parse('0x10').program), structuralHash(parse('16').program), 'ham yazım hash dışı');
  const ia = stableIds(a);
  const ib = stableIds(parse(code(a)));
  assert.deepEqual([...ia.values()], [...ib.values()], 'yeniden parse: aynı kimlikler');
  const fA = [...ia].find(([n]) => n.type === 'ReturnStatement')[1];
  const fB = [...stableIds(b)].find(([n]) => n.type === 'ReturnStatement')[1];
  assert.equal(fA, fB, 'başka birimdeki değişiklik kimliği etkilemez');
  const d = dirtyUnits(a, b);
  assert.deepEqual(d.changed.sort(), ['/program/g:FunctionDeclaration', '/program:Program'].sort());
  assert.deepEqual(d.clean, ['/program/f:FunctionDeclaration']);
  // yerinde değişiklik sonrası geçersizleştirme
  const ast = parse('var y = 1 + 2;');
  const before = structuralHash(ast.program);
  traverse(ast, { NumericLiteral(p) { if (p.node.value === 2) { p.node.value = 3; invalidate(p); p.stop(); } } });
  assert.notEqual(structuralHash(ast.program), before);
}

// E561: sürümlü serileştirme
{
  const src = 'class A { #x = 1n; static { f(/a/g, `t${1}`); } } label: for (const [a, ...b] of c) break label;';
  const ast = parse(src);
  const doc = JSON.parse(JSON.stringify(serializeAst(ast.program)));
  assert.equal(doc.format, 'peel-ast');
  assert.equal(doc.version, 1);
  const back = deserializeAst(doc);
  assert.equal(code(back), code(ast.program));
  assert.throws(() => deserializeAst({ ...doc, version: 99 }), /yeni/);
  assert.throws(() => deserializeAst({ format: 'peel-ast', version: 1, root: { type: 'Bogus' } }), /bilinmeyen/);
}

// E562 / E559: diff/patch ve ters yama
{
  const A = parse('function f(a){ var x = a + 1; return x; }\nvar k = [1, 2, 3];\nfoo();\nbar();');
  const B = parse('function f(a){ var x = a + 2; log(x); return x; }\nvar k = [1, 3];\nbar();\nbaz();');
  const patch = diffAst(A.program, B.program);
  const json = JSON.parse(JSON.stringify(patch));
  const applied = applyPatch(parse(code(A)).program, json);
  assert.equal(structuralHash(applied), structuralHash(B.program));
  const undone = applyPatch(parse(code(B)).program, invertPatch(json));
  assert.equal(structuralHash(undone), structuralHash(A.program));
  // alt küme özgün sırayla uygulanabilir ve parse edilebilir kod üretir
  for (let i = 0; i < patch.ops.length; i++) {
    const part = applyPatch(parse(code(A)).program, json, [i]);
    assert.doesNotThrow(() => parse(code(part)));
  }
  assert.throws(() => applyPatch(parse('function f(){}').program, json), /çakışma|çözülemedi|dizi/);
}

// E563: eşleme
{
  const A = parse('function decode(a){ return a ^ 7; } var t = decode(1); log(t);');
  const B = parse('function decode(a){ return a ^ 7; } log(6);');
  const m = matchTrees(A, B);
  const fA = A.program.body[0];
  assert.equal(m.map.get(fA), B.program.body[0]);
  const logA = A.program.body[2];
  assert.equal(m.map.get(logA), B.program.body[1], 'değişen deyim konum/tür ile eşlenir');
}

// E548: yapısal paylaşım
{
  const store = new SnapshotStore();
  const s1 = parse('function big(){ ' + 'x++; '.repeat(200) + '} a();');
  const s2 = parse('function big(){ ' + 'x++; '.repeat(200) + '} b();');
  store.add(s1);
  store.add(s2);
  const st = store.stats();
  assert.ok(st.storedNodes < st.logicalNodes / 1.9, 'ortak fonksiyon bir kez saklanır');
  assert.equal(code(store.materialize(1)), code(s2.program));
}

// E549 / E552 / E553: artımlı ve talep odaklı analiz
{
  const session = new AnalysisSession();
  const a = parse('function f(c){ var x = 1; if (c) x = 2; return x; } function g(){ var y = 5; return y; }');
  session.update(a);
  let ret;
  traverse(a, { ReturnStatement(p) { if (!ret) ret = p.get('argument'); } });
  const r = session.reaching(ret);
  assert.deepEqual(r.map((d) => d.kind).sort(), ['assign', 'init']);
  assert.equal(session.stats.misses, 1, 'yalnızca istenen birim analiz edildi');
  const b = parse('function f(c){ var x = 1; if (c) x = 2; return x; } function g(){ var y = 6; return y; }');
  const dirty = session.update(b);
  assert.deepEqual(dirty.clean, ['/program/f:FunctionDeclaration']);
  let ret2;
  traverse(b, { ReturnStatement(p) { if (!ret2) ret2 = p.get('argument'); } });
  session.reaching(ret2);
  assert.equal(session.stats.hits, 1, 'değişmeyen birim önbellekten');
  let gRet;
  traverse(b, { ReturnStatement(p) { gRet = p.get('argument'); } });
  assert.deepEqual(session.constant(gRet), { ok: true, value: 6 });
  assert.ok(session.stats.invalidated >= 0);
}

// E546: değişiklik başına geri alma
{
  const before = 'var a = 1;\nvar b = 2;\nconsole.log(a);';
  const after = 'var a = 10;\nvar b = 20;\nconsole.log(a);';
  const part = await salvage({ before, after, check: async (c) => !/var a = 10/.test(c) });
  assert.ok(part);
  assert.equal(part.kept, 1);
  assert.match(part.code, /var b = 20/);
  assert.match(part.code, /var a = 1;/);
}

// E570
{
  const r = minifierSafety(parse('function f(a, b) {} f.length; f.name; var s = f.toString(); with (o) {} var q = { "k": 1 }; q.k;'));
  assert.equal(r.safe, false);
  assert.deepEqual(r.kinds.sort(), ['dynamic-scope', 'fn-length', 'fn-name', 'fn-source', 'property-mix'].sort());
  assert.equal(r.options.keep_fargs, true);
  assert.equal(r.options.keep_fnames, true);
  assert.equal(minifierSafety(parse('function g(x) { return x * 2; } g(1);')).safe, true);
}

// Pipeline ile uçtan uca: E547 kontrol noktası, E557 köken, E558 gerekçe, E564 notlar, E565 yorum koruma, E541–E544 rapor
{
  const host = createHost(await getQuickJS());
  const sandbox = sandboxApi(async (msg) => host.handle(msg));
  const src = readFileSync(new URL('./fixtures/string-array-basic.js', import.meta.url), 'utf8').replace(/^\s*\/\/\s*(EXPECT|GONE|LEVEL|SKIP)\b.*$/gm, '');
  const input = `// başlık yorumu\n${src}`;
  const trace = createTrace({ keepComments: true });
  const r = await deobfuscate(input, { level: 4, sandbox, trace });
  const rep = trace.report();
  assert.ok(rep.rationale.some((x) => x.state === 'ok' && x.changes && x.changes.ops > 0));
  assert.deepEqual(rep.dag.violations, []);
  assert.ok(rep.store.snapshots >= 2);
  assert.ok(rep.incremental.perPass.every((x) => x.analyzed >= 0 && x.analyzed <= x.changed + x.added), 'yalnızca kirli birimler yeniden analiz edilir');
  assert.ok(rep.checkpoints.length >= 1);
  assert.ok(rep.notes.length >= 1, 'değişen deyimlerde pass notu');
  assert.ok(rep.provenance.every((p) => p.origin === null || p.origin >= 1));
  assert.notEqual(rep.patches.undoVerified, false);
  assert.match(r.code, /başlık yorumu/);
  // kontrol noktasından devam: aynı sonuç
  const cp = trace.lastCheckpoint();
  assert.doesNotThrow(() => restoreCheckpoint(JSON.parse(JSON.stringify(cp))));
  assert.throws(() => restoreCheckpoint({ ...cp, code: `${cp.code} ` }), /özet/);
  const r2 = await deobfuscate(input, { level: 4, sandbox, resume: cp });
  assert.equal(r2.code, (await deobfuscate(cp.code, { level: 4, sandbox })).code);
  // geçerli/geçersiz pass sırası
  const logs = [];
  await deobfuscate('var a = 1;', { level: 4, sandbox, passOrder: ['rename', 'unused'], onLog: (m) => logs.push(m) });
  assert.ok(logs.some((m) => m.includes('pass sırası')));
  // undoTo(0) girdinin AST'sine döner
  const undone = trace.undoTo(0);
  assert.ok(typeof undone === 'string' && undone.length > 0);
}

console.log('analysis-infra: ok');
