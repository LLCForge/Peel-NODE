import { compareSignatures, isaOf, assemble } from './semantics.js';

// Rapor verisi (E199 VM raporu, E660 decompilation raporu): pass'lerin bulguları tekilleştirilir,
// bytecode VM'ler arasında imza karşılaştırması yapılır (madde 37, E656).

const MAX_TRACE = 3000;

export function vmReport(findings, extra = {}) {
  if (!findings && !extra.strings?.length) return null;
  findings = findings ?? {};
  const byKey = new Map();
  for (const f of findings.vm ?? []) {
    const k = `${f.raw}|${f.signature?.table}|${f.origin?.source ?? ''}`;
    byKey.set(k, f);
  }
  const bytecode = [...byKey.values()].map((f, i) => ({
    ...f,
    index: i,
    trace: (f.trace ?? []).slice(0, MAX_TRACE),
    roundTrip: roundTrip(f),
  }));
  const smKey = new Map();
  for (const m of findings.sm ?? []) smKey.set(`${m.fn}|${m.line}|${m.discriminant}`, m);
  const machines = [...smKey.values()];
  const compare = [];
  for (let i = 0; i < bytecode.length; i++) {
    for (let j = i + 1; j < bytecode.length; j++) {
      if (!bytecode[i].signature || !bytecode[j].signature) continue;
      compare.push({ a: i, b: j, ...compareSignatures(bytecode[i].signature, bytecode[j].signature) });
    }
  }
  const timing = findings.timing ?? [];
  const strings = [...(findings.strings ?? []), ...(extra.strings ?? [])];
  const proxy = findings.proxy ?? [];
  if (!bytecode.length && !machines.length && !timing.length && !strings.length && !proxy.some((p) => p.byTrial)) return null;
  return {
    bytecode,
    machines,
    compare,
    timing,
    strings,
    proxy,
    summary: {
      vms: bytecode.length,
      lifted: bytecode.filter((b) => b.lifted).length,
      verified: bytecode.filter((b) => b.verified).length,
      nested: bytecode.filter((b) => (b.origin?.depth ?? 1) > 1).length,
      machines: machines.length,
      timing: timing.length,
    },
  };
}

// Assembler ↔ disassembler tutarlılığı (E194/E658): listeden yeniden derlenen bytecode orijinalle aynı mı
export function roundTrip(f) {
  if (!f.assembly || !f.isa || f.bytecode === undefined) return null;
  const names = new Map(f.isa.map((x) => [x.op, x.mnemonic]));
  const isa = isaOf({ list: (f.disasm ?? []).map((x) => ({ op: x.op, operands: x.operands })) }, names);
  const enc = new Map((f.opcodeMap ?? []).map((x) => [String(x.op), x.raw]));
  const r = assemble(f.assembly, isa, (op) => enc.get(String(op)) ?? op);
  if (r.errors.length) return { ok: false, errors: r.errors.slice(0, 5) };
  const same = typeof f.bytecode === 'string' ? r.code === f.bytecode : JSON.stringify(r.code) === JSON.stringify(f.bytecode);
  return { ok: same };
}

export function encoderFor(f) {
  const enc = new Map((f.opcodeMap ?? []).map((x) => [String(x.op), x.raw]));
  return (op) => enc.get(String(op)) ?? op;
}

export function isaFromFinding(f) {
  const names = new Map(f.isa.map((x) => [x.op, x.mnemonic]));
  return isaOf({ list: (f.disasm ?? []).map((x) => ({ op: x.op, operands: x.operands })) }, names);
}
