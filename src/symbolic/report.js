// API: symbolicReport({ text, output, sandbox, timeMs }) → { static, opaque, symbolic, concolic, dynamic, solver, ms }
//      (analyze.js bunu lazySymbolic ile tembel çağırır)
import * as t from '@babel/types';
import { parse } from '../core/parse.js';
import { traverse } from '../util/ast.js';
import { Exec, SummaryTable, isTerm } from './exec.js';
import { V, mk, show, types, TRUE } from './ir.js';
import { stats as solverStats } from './solver.js';
import { concolic } from './concolic.js';
import { dynamicReport } from './dynamic.js';
import { staticReport } from '../opt/analysis.js';
import { proveOpaque } from '../passes/62-opaque-smt.js';
import { proofText } from '../opt/irbridge.js';

// Sembolik / statik / dinamik analizlerin rapor nesnesi (analyze.js → report.symbolic)

const MAX_LEN = 300_000;
const lineOf = (n) => n?.loc?.start.line ?? 0;
const conj = (pc) => show(pc.reduce((p, x) => mk('&&', p, x), TRUE));

function topFunctions(ast, limit) {
  const out = [];
  traverse(ast, {
    FunctionDeclaration(p) {
      if (out.length < limit && p.node.params.length <= 4 && p.node.params.every((x) => t.isIdentifier(x)) && !p.node.async && !p.node.generator) out.push(p);
    },
  });
  return out;
}

// E606–E610, E697, E698: fonksiyon başına sembolik yürütme
function symbolicFunctions(ast, deadline) {
  const table = new SummaryTable(ast);
  const out = [];
  const post = [];
  let sampleTrace = null;
  for (const p of topFunctions(ast, 12)) {
    if (Date.now() > deadline) break;
    const fn = p.node;
    const params = fn.params.map((x, i) => V(`__peelArg${i}`, 'any'));
    const ex = new Exec(ast, { maxSteps: 4000, maxStates: 24, unroll: 3, timeMs: 400, summaries: table, solverCalls: 60 });
    const r = ex.runFunction(fn, params);
    // sembolik parametre adları (yürütme: __peelArgN, özet tablosu: ad.pN) → kaynak adları
    const esc = fn.id.name.replace(/[$]/g, '\\$');
    const pretty = (s) => fn.params.reduce((acc, x, i) => acc.replace(new RegExp(`__peelArg${i}\\b`, 'g'), x.name).replace(new RegExp(`\\b${esc}\\.p${i}\\b`, 'g'), x.name), s);
    const throws = r.paths.filter((x) => x.status === 'throw');
    const returns = r.paths.filter((x) => x.status === 'return');
    const exact = !r.stats.exhausted && r.paths.every((x) => !x.approx);
    const pre = throws.length ? `!(${throws.map((x) => (x.pc.length ? `(${conj(x.pc)})` : 'true')).join(' || ')})` : 'true';
    const retTypes = new Set();
    for (const x of returns) if (isTerm(x.value)) types(x.value).forEach((k) => retTypes.add(k)); else retTypes.add('object');
    const postCases = returns.filter((x) => isTerm(x.value)).map((x) => ({ pc: x.pc.length ? conj(x.pc) : 'true', ret: show(x.value) }));
    // E698: tam (yaklaşıksız) özetlerden doğrulanabilir son koşul iddiaları
    if (exact) for (const c of postCases.slice(0, 4)) post.push({ fn: fn.id.name, expr: `!(${c.pc}) || __peelRet === (${c.ret})`, text: pretty(`(${c.pc}) ⇒ sonuç === ${c.ret}`) });
    const sm = table.summarize(fn);
    if (!sampleTrace) {
      const traced = r.paths.find((x) => x.trace.some((e) => e.kind === 'dal'));
      if (traced) sampleTrace = { fn: fn.id.name, steps: traced.trace.slice(0, 40) };
    }
    out.push({
      name: fn.id.name, line: lineOf(fn), paths: r.paths.length, exact,
      precondition: pretty(pre), returnTypes: [...retTypes],
      postcondition: postCases.slice(0, 6).map((c) => pretty(`${c.pc} ⇒ ${c.ret}`)),
      summary: sm?.valid ? sm.text.slice(0, 6).map(pretty) : null,
      stats: r.stats,
    });
  }
  return { functions: out, post, sampleTrace, summaryTable: { entries: table.table.size, hits: table.hits, misses: table.misses } };
}

// Madde 30: her yüklemi hangi arka ucun kanıtladığı (z3 + yerleşik / yerleşik / yalnız z3 → katlanmaz) raporlanır
async function opaqueProofs(code, label) {
  let ast;
  try { ast = parse(code); } catch { return []; }
  const fns = [];
  traverse(ast, { Function(p) { if (t.isBlockStatement(p.node.body)) fns.push(p); } });
  const out = [];
  for (const p of fns) {
    if (out.length >= 30) break;
    for (const it of await proveOpaque(p)) {
      out.push({ where: label, line: it.line, cond: it.cond, value: it.value, method: it.proof.method, proof: it.proofText, backend: it.backend, folds: it.fold });
    }
  }
  return out;
}

/**
 * @param {{ text: string, output: string, sandbox: object|null, timeMs?: number }} o
 */
export async function symbolicReport({ text, output, sandbox, timeMs = 6000 }) {
  if (!output || output.length > MAX_LEN) return { skipped: 'kod çok büyük ya da yok' };
  const t0 = Date.now();
  const before = { ...solverStats };
  let ast;
  try { ast = parse(output); } catch (e) { return { skipped: `parse: ${e.message}` }; }
  const report = {};
  const safe = async (key, fn) => {
    try { report[key] = await fn(); } catch (e) { report[key] = { error: e.message }; }
  };
  await safe('static', () => staticReport(ast));
  await safe('opaque', async () => [...(await opaqueProofs(text ?? '', 'girdi')), ...(await opaqueProofs(output, 'çıktı'))].slice(0, 40));
  await safe('symbolic', () => symbolicFunctions(parse(output), t0 + timeMs / 3));
  if (sandbox) {
    await safe('concolic', async () => {
      const runs = [];
      const prog = await concolic(sandbox, output, { maxRuns: 10, timeMs: timeMs / 4 });
      if (prog.ok) runs.push(prog);
      for (const p of topFunctions(parse(output), 3)) {
        if (Date.now() - t0 > timeMs * 0.7 || !p.node.params.length) continue;
        const r = await concolic(sandbox, output, { target: { name: p.node.id.name, params: p.node.params.length }, maxRuns: 8, timeMs: timeMs / 8 });
        if (r.ok) runs.push(r);
      }
      return runs;
    });
    await safe('dynamic', () => dynamicReport(sandbox, output, { post: report.symbolic?.post ?? [] }));
  }
  report.solver = Object.fromEntries(Object.entries(solverStats).map(([k, v]) => [k, v - (before[k] ?? 0)]));
  report.ms = Date.now() - t0;
  return report;
}
