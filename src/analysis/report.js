import * as t from '@babel/types';
import { parse } from '../core/parse.js';
import { traverse, gen } from '../util/ast.js';
import { PASSES } from '../core/registry.js';
import { semanticsReport } from './semantics.js';
import { shadowReport } from './shadow.js';
import { dataflowReport, show } from './index.js';
import { minifierSafety } from './minsafe.js';
import { evaluate, isPrimitiveResult, prototypesPatched, UNKNOWN } from './ops.js';
import { AnalysisSession } from './session.js';
import { structuralHash, stableIds } from './nodehash.js';
import { serializeAst, deserializeAst } from './serialize.js';
import { passDag } from './passgraph.js';
import { semanticRuntime, compareRegexEngines } from './runtime.js';

// analyze() raporunun "semantics" bölümü: E-U semantik modelleri ve E-V analiz altyapısı sonuçları.

const SAFE = (fn, fallback = null) => { try { return fn(); } catch (e) { return fallback ?? { error: String(e?.message ?? e) }; } };
const GLOBAL_VALUES = { undefined, NaN, Infinity };

/** E501/E536: sandbox olmadan, soyut işlem modeliyle katlanabilen en büyük ifadeler. */
export function staticFolds(ast, { max = 40 } = {}) {
  const models = !prototypesPatched(ast, traverse);
  const samples = [];
  let count = 0;
  const lookup = (scope) => (n) => (!scope.getBinding(n.name) && Object.hasOwn(GLOBAL_VALUES, n.name) ? GLOBAL_VALUES[n.name] : UNKNOWN);
  traverse(ast, {
    'BinaryExpression|UnaryExpression|TemplateLiteral|MemberExpression|LogicalExpression|ConditionalExpression'(p) {
      // yalnızca katlanabilen en dış ifade sayılır; literal'in kendisi (-1, void 0) sayılmaz
      if (t.isUnaryExpression(p.node) && (p.node.operator === '-' || p.node.operator === 'void') && t.isNumericLiteral(p.node.argument)) return;
      if (t.isTemplateLiteral(p.node) && !p.node.expressions.length) return;
      const v = evaluate(p.node, lookup(p.scope), { models });
      if (!isPrimitiveResult(v)) return;
      count++;
      if (samples.length < max) {
        const src = gen(p.node);
        samples.push({ line: p.node.loc?.start.line ?? null, expr: src.length > 80 ? `${src.slice(0, 77)}...` : src, value: show(v) });
      }
      p.skip();
    },
  });
  return { models, count, samples };
}

const SINKS = new Set(['eval', 'Function', 'setTimeout', 'setInterval', 'document.write', 'document.writeln', 'fetch', 'importScripts', 'atob']);
const SINK_PROPS = new Set(['innerHTML', 'outerHTML', 'src', 'href']);
const fullName = (n) => (t.isIdentifier(n) ? n.name : t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property) && fullName(n.object) ? `${fullName(n.object)}.${n.property.name}` : null);

/**
 * E552: talep odaklı analiz. Yalnızca tehlikeli çağrılara (eval, Function, document.write...) giden
 * tanımlayıcı argümanların bulunduğu birimler analiz edilir; ulaşan tanımlar ve sabit değerleri raporlanır.
 */
export function sinkQueries(ast, { max = 40 } = {}) {
  const session = new AnalysisSession();
  session.update(ast);
  const sinks = [];
  let units = 0;
  traverse(ast, { 'Program|Function|StaticBlock'() { units++; } });
  const query = (api, argPath, line) => {
    if (sinks.length >= max || !argPath.isIdentifier()) return;
    const defs = SAFE(() => session.reaching(argPath), null);
    const c = SAFE(() => session.constant(argPath), { ok: false });
    sinks.push({
      api, arg: argPath.node.name, line,
      tracked: Array.isArray(defs),
      defs: Array.isArray(defs) ? defs.map((d) => ({ kind: d.kind, line: d.node?.loc?.start.line ?? null })) : [],
      constant: c.ok ? show(c.value) : null,
    });
  };
  traverse(ast, {
    'CallExpression|NewExpression'(p) {
      const name = fullName(p.node.callee);
      const api = name && (SINKS.has(name) ? name : SINKS.has(name.split('.').slice(-2).join('.')) ? name.split('.').slice(-2).join('.') : null);
      if (!api || (name === 'eval' && p.scope.getBinding('eval'))) return;
      const arg = p.get('arguments.0');
      if (arg?.node) query(api, arg, p.node.loc?.start.line ?? null);
    },
    AssignmentExpression(p) {
      const l = p.node.left;
      if (t.isMemberExpression(l) && !l.computed && t.isIdentifier(l.property) && SINK_PROPS.has(l.property.name)) query(`.${l.property.name}=`, p.get('right'), p.node.loc?.start.line ?? null);
    },
  });
  return { sinks, units, analyzedUnits: session.stats.misses, cacheHits: session.stats.hits };
}

export async function analysisReport({ text, output, sandbox = null, config = null, trace = null }) {
  let outAst = null;
  let inAst = null;
  try { outAst = parse(output); } catch { /* çıktı parse edilemiyorsa statik bölümler boş */ }
  try { inAst = parse(text); } catch { /* girdi parse edilemiyor */ }
  const semantics = outAst ? SAFE(() => semanticsReport(outAst)) : null;
  const report = {
    semantics,
    shadow: outAst ? SAFE(() => shadowReport(outAst)) : null,
    dataflow: outAst ? SAFE(() => dataflowReport(outAst)) : null,
    folds: inAst ? SAFE(() => staticFolds(inAst)) : null,
    sinks: outAst ? SAFE(() => sinkQueries(outAst)) : null,
    minify: outAst ? SAFE(() => minifierSafety(outAst)) : null,
    infra: {
      dag: SAFE(() => { const d = passDag(PASSES); return { order: d.order, edges: d.edges.length, violations: d.violations, cycles: d.cycles, undeclared: d.undeclared }; }),
      ids: outAst ? SAFE(() => ({ count: stableIds(outAst).size, sample: [...stableIds(outAst).values()].slice(0, 6) })) : null,
      serialization: outAst ? SAFE(() => {
        const doc = JSON.stringify(serializeAst(outAst.program));
        const back = deserializeAst(doc);
        return { version: 1, bytes: doc.length, roundTrip: structuralHash(back) === structuralHash(outAst.program) };
      }) : null,
      trace: trace ? SAFE(() => trace.report()) : null,
    },
    runtime: null,
    regexEngines: null,
  };
  if (sandbox) {
    report.runtime = await semanticRuntime(sandbox, text, config).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
    // katlama düzenli ifadeyi çıktıdan silmiş olabilir: girdideki desenler de karşılaştırılır
    const patterns = [...(semantics?.regex?.patterns ?? [])];
    const strings = [];
    for (const ast of [outAst, inAst]) {
      if (!ast) continue;
      traverse(ast, {
        StringLiteral(p) { if (strings.length < 200) strings.push(p.node.value); },
        RegExpLiteral(p) { if (ast === inAst && patterns.length < 200) patterns.push({ source: p.node.pattern, flags: p.node.flags, line: p.node.loc?.start.line ?? null }); },
      });
    }
    report.regexEngines = await compareRegexEngines(sandbox, patterns, strings).catch((e) => ({ ok: false, error: String(e?.message ?? e), differences: [] }));
  }
  return report;
}
