// Bytecode VM araçlarının öz-denetimi: node test/vm.test.js
// Disassembler, opcode adlandırma (statik + iz), assembler gidiş-dönüşü, IR, VM imzası/sürüm karşılaştırması,
// handler kümeleme ve durum makinesi geçiş şablonları.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '../src/core/parse.js';
import { findVms } from '../src/core/vm/detect.js';
import { analyzeVm, stateVarsFor } from '../src/core/vm/analysis.js';
import { staticValues } from '../src/core/vm/values.js';
import { compareSignatures, dynamicNames, assemble } from '../src/core/vm/semantics.js';
import { vmReport, isaFromFinding, encoderFor } from '../src/core/vm/report.js';
import { branchTemplate } from '../src/core/vm/sm.js';
import { analyzeStringTables } from '../src/core/vm/strtable.js';
import { run as stringStatic } from '../src/passes/31-static-strings.js';
import { gen } from '../src/util/ast.js';
import { readableInterpreter } from '../src/core/vm/readable.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

function analyzeFirst(src) {
  const ast = parse(src);
  const [vm] = findVms(ast);
  assert.ok(vm, 'VM bulunamadı');
  const sv = stateVarsFor(vm);
  // fonksiyon VM'i: ilk çağrı yerindeki literal argümanlar
  let args = null;
  if (!vm.fnPath.isProgram()) {
    const b = vm.fnPath.parentPath.scope.getBinding(vm.fnPath.node.id.name);
    args = b.referencePaths.map((r) => r.parentPath).find((c) => c.isCallExpression())?.node.arguments ?? null;
  }
  const values = staticValues(vm, sv.stateVars, args);
  values.stackInit ??= 0;
  return { vm, a: analyzeVm(vm, values, { used: new Set() }) };
}

// 1) yığın VM'i: disassembly, adlar, IR, çevrilmiş kod
const stack = analyzeFirst(fixture('vm-bytecode-stack.js'));
const a = stack.a;
assert.equal(a.ok, true, a.reason);
assert.equal(a.style, 'switch');
assert.equal(a.disasm.length, 28);
const names = Object.fromEntries(a.handlers.map((h) => [h.key, h.staticName]));
assert.equal(names[0], 'PUSH_CONST');
assert.equal(names[1], 'LOAD');
assert.equal(names[2], 'STORE');
assert.equal(names[3], 'ADD');
assert.equal(names[4], 'MUL');
assert.equal(names[5], 'LT');
assert.equal(names[6], 'JMP');
assert.equal(names[7], 'JZ');
assert.equal(names[9], 'GETMETHOD');
assert.equal(names[10], 'CALL');
assert.equal(names[11], 'POP');
assert.equal(names[12], 'RET');
assert.match(a.listing, /JZ\s+34/);
assert.equal(a.maxDepth, 4);
assert.ok(a.loops.some((l) => l.head === 8 && l.latch === 32), 'geri kenar 32 → 8');
assert.equal(a.registers.count, 2);
assert.deepEqual(a.alphabet, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
assert.ok(a.ir.find((x) => x.pc === 22).lines.some((l) => /\+/.test(l)), 'IR: ADD satırı');
assert.ok(a.blocks.length >= 4);
assert.ok(a.hostCalls.some((c) => c.name === 'console.log' && c.kind === 'native'), JSON.stringify(a.hostCalls));
assert.match(a.liftedCode, /R\[0\] = R\[0\] \+ R\[1\] \* 2|R\[0\]=R\[0\]\+R\[1\]\*2/);

// 2) assembler gidiş-dönüşü: liste yeniden derlenince aynı bytecode
const rep = vmReport({ vm: [{ ...a, lifter: undefined, lifted: undefined, raw: 'x' }] });
assert.equal(rep.bytecode[0].roundTrip.ok, true);
const isa = isaFromFinding(rep.bytecode[0]);
const small = assemble('PUSH_CONST 6\nPOP\nRET', isa);
assert.deepEqual(small.code, [0, 6, 11, 12]);
assert.deepEqual(assemble('NOPE 1', isa).errors.length, 1);

// 3) XOR'lu string bytecode: ham opcode eşlemesiyle gidiş-dönüş
const str = analyzeFirst(fixture('vm-bytecode-string.js').replace('var bc = "";', 'var bc = "^\\u0000[\\u0006[\\u0007X[\\bY_\\u0001\\\\";').replace(/for \(var i[^\n]*\n/, ''));
assert.equal(str.a.ok, true, str.a.reason);
assert.equal(str.a.codeKind, 'string');
const srep = vmReport({ vm: [{ ...str.a, lifter: undefined, lifted: undefined, raw: 'y' }] });
assert.equal(srep.bytecode[0].roundTrip.ok, true, JSON.stringify(srep.bytecode[0].roundTrip));
assert.equal(encoderFor(srep.bytecode[0])(1), 91);

// 4) imza: opcode numaraları karıştırılmış aynı VM → aynı motor, farklı eşleme (madde 37, E656)
const perm = { 0: 5, 5: 0, 3: 4, 4: 3 };
let shuffled = fixture('vm-bytecode-stack.js');
for (const [from, to] of Object.entries(perm)) shuffled = shuffled.replace(`case ${from}:`, `case @${to}:`);
shuffled = shuffled.replace(/case @/g, 'case ');
const [vm2] = findVms(parse(shuffled));
const sw = compareSignatures(a.signature, analyzeVm(vm2, { arrays: new Map(), state: new Map(), stackInit: 0 }).signature);
assert.equal(sw.verdict, 'aynı motor, opcode eşlemesi farklı');
assert.ok(sw.mapping.some((m) => m.from === 0 && m.to === 5));
const self = compareSignatures(a.signature, a.signature);
assert.equal(self.verdict, 'aynı');

// 5) handler kümeleri: tek handler'lık kümeler, takma ad yok
assert.ok(a.clusters.every((c) => !c.alias));

// 6) dinamik adlandırma (madde 34): sentetik iz
const dis = { list: [{ pc: 0, op: 1, reads: [0, 1] }, { pc: 2, op: 1, reads: [2, 3] }, { pc: 4, op: 3, reads: [4] }, { pc: 5, op: 2, reads: [5, 6] }] };
const steps = [[0, 0, [], []], [2, 1, ['3'], []], [4, 2, ['4', '3'], []], [5, 1, ['7'], []], [7, 0, [], ['7']]];
const dyn = dynamicNames(steps, dis);
assert.equal(dyn.get(1).name, 'PUSH');
assert.equal(dyn.get(3).name, 'ADD');
assert.equal(dyn.get(2).name, 'STORE');

// 7) tablo dağıtımlı register VM
const table = analyzeFirst(fixture('vm-bytecode-table.js').replace('return exec;', 'exec([0, 0, 0, 0, 1, 1, 0, 2, 2, 2, 0, 0, 1, 6, 2, 5, 2, 9, 3, 0, 4], [1, 3, 4]); return exec;'));
assert.equal(table.a.style, 'table');
assert.ok(table.a.handlers.find((h) => h.key === 5).staticName.startsWith('J'));

// 8) geçiş şablonları (E191)
const tpl = (src, names) => branchTemplate(parse(`while (1) { switch (0) { case 0: ${src} } }`).program.body[0].body.body[0].cases[0].consequent, new Set(names));
assert.equal(tpl('P = 3; break;', ['P']), 'sabit geçiş');
assert.equal(tpl('P += 2; break;', ['P']), 'artımlı geçiş');
assert.equal(tpl('if (x) { P = 1; } else { P = 2; } break;', ['P']), 'koşullu sabit geçiş');
assert.equal(tpl('return 5;', ['P']), 'çıkış (return)');
assert.equal(tpl('P = T[i];', ['P']), 'tablo geçişi');

// 8b) hibrit VM + host (E653): VM programın kendi fonksiyonunu ve native API'yi çağırıyor; çağrı this'i korunur
const hybrid = analyzeFirst(fixture('vm-bytecode-hybrid.js'));
assert.equal(hybrid.a.ok, true, hybrid.a.reason);
assert.ok(hybrid.a.hostCalls.some((c) => c.name === 'helper' && c.kind === 'host'), JSON.stringify(hybrid.a.hostCalls));
assert.ok(hybrid.a.hostCalls.some((c) => c.name === 'console.log' && c.kind === 'native'));
assert.ok(hybrid.a.liftedCode.includes('(0,G["helper"])("kanca")'), hybrid.a.liftedCode);

// 8c) okunur yorumlayıcı (E652): roller yeniden adlandırılır, handler'lar açıklanır
const readable = readableInterpreter(fixture('vm-bytecode-stack.js'), a.handlers);
assert.match(readable, /bytecode\[pc\+\+\]/);
assert.match(readable, /stack\.push/);
assert.match(readable, /ADD: pop 2 ; push s1\+s0/);

// 9) string tablosu (E632–E636): statik rotasyon, kısmi kurtarma, tekilleştirme, ters kodlayıcı
const rc4src = fixture('string-array-rc4.js');
const [tab] = analyzeStringTables(parse(rc4src));
assert.equal(tab.rotation.rotation, 6);
assert.equal(tab.rotation.method, 'checksum');
assert.match(tab.shape, /rc4, ofset 0x12b/);
assert.equal(tab.recovered, 21);
assert.equal(tab.total, 29);
assert.equal(tab.missing.length, 8);
assert.equal(tab.duplicates, 1);
assert.equal(tab.inverseVerified, '21 / 21');
assert.ok(tab.entries.some((e) => e.value === 'deltaepsilon'.slice(0, 5)));
// sandbox olmadan statik pass çağrıları değerleriyle değiştirir ve yardımcıları kaldırır
const rcAst = parse(rc4src);
await stringStatic(rcAst, { onLog: () => {}, bump: () => {}, sandbox: null });
const rcOut = gen(rcAst);
assert.match(rcOut, /"hello "/);
assert.doesNotMatch(rcOut, /_0x35dd|_0x3a37/);

console.log('vm.test: tamam');
