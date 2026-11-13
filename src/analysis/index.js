import { traverse } from '../util/ast.js';
import { analyzeFunction } from './defs.js';
import { prototypesPatched } from './ops.js';

const SAMPLES = 40;
const line = (p) => p?.node?.loc?.start.line ?? null;

// Rapor için JSON'a uygun değer gösterimi
export function show(v) {
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'string') return JSON.stringify(v.length > 60 ? `${v.slice(0, 57)}...` : v);
  if (Object.is(v, -0)) return '-0';
  return String(v);
}

export function functionUnits(ast) {
  const units = [];
  traverse(ast, {
    Program(p) { units.push(p); },
    Function(p) { units.push(p); },
    StaticBlock(p) { units.push(p); },
  });
  return units;
}

/**
 * E575–E580 özet raporu. Bütçe aşılırsa kalan fonksiyonlar atlanır (partial: true).
 */
export function dataflowReport(ast, { budgetMs = 1500, maxStatements = 6000 } = {}) {
  const start = Date.now();
  const models = !prototypesPatched(ast, traverse);
  const out = {
    functions: 0, skipped: 0, partial: false, tracked: 0, defs: 0, chains: 0, iterations: 0, models,
    dead: [], deadCount: 0, maybeUndefined: [], tdz: [], copies: [], copyCount: 0, constants: [], constantCount: 0,
  };
  for (const unit of functionUnits(ast)) {
    if (Date.now() - start > budgetMs) { out.partial = true; out.skipped++; continue; }
    let size = 0;
    unit.traverse({ Statement() { size++; } });
    if (size > maxStatements) { out.skipped++; continue; }
    let r;
    try { r = analyzeFunction(unit, { models }); } catch { out.skipped++; continue; }
    out.functions++;
    out.tracked += r.bindings.length;
    out.defs += r.defs.length;
    out.iterations += r.iterations;
    for (const list of r.defUses.values()) out.chains += list.length;
    out.deadCount += r.deadAssignments.length;
    for (const d of r.deadAssignments) {
      if (out.dead.length < SAMPLES) out.dead.push({ name: d.binding.identifier.name, line: line(d.def.path), kind: d.def.kind });
    }
    for (const u of r.uses) {
      const kinds = u.defs.map((d) => d.kind);
      const name = r.bindings[u.e.b].identifier.name;
      if (kinds.includes('tdz') && out.tdz.length < SAMPLES) out.tdz.push({ name, line: line(u.e.path), definite: kinds.every((k) => k === 'tdz') });
      if (kinds.includes('undef') && out.maybeUndefined.length < SAMPLES) out.maybeUndefined.push({ name, line: line(u.e.path), definite: kinds.every((k) => k === 'undef') });
    }
    out.copyCount += r.copies.length;
    for (const c of r.copies) if (out.copies.length < SAMPLES) out.copies.push({ from: c.from.identifier.name, to: c.to.identifier.name, line: line(c.use) });
    out.constantCount += r.constants.length;
    for (const c of r.constants) if (out.constants.length < SAMPLES) out.constants.push({ name: c.binding.identifier.name, line: line(c.use), value: show(c.value) });
  }
  out.ms = Date.now() - start;
  return out;
}
