import * as t from '@babel/types';
import { parse } from '../core/parse.js';
import { raw } from '../core/emit.js';
import { traverse } from '../util/ast.js';
import { ownerOf } from './defs.js';
import { wrapTopLevelAwait, regexFeatures } from './semantics.js';

// Sandbox'ta semantik gözlem çalıştırması (E512, E515–E519, E526, E529–E531, E534, E539, E540).
// Program yalnızca bu çalıştırma için enstrümante edilir; çıktı koduna dokunulmaz.

const where = (n, what) => `${what}@${n.loc?.start.line ?? '?'}`;

/**
 * await ve async fonksiyonları izleme çağrılarıyla sarar:
 *   await x            → __peelResume(await __peelAwait(x, "await@L"), "await@L")
 *   async function f   → f = __peelTrackFn(f, …) (bulunduğu gövdenin başında)
 *   async () => …      → __peelTrackFn(async () => …, …)
 *   async m(p) { B }   → m(...a) { return __peelTrack((async (p) => { B })(...a), …) }  (sınıf/nesne yöntemi:
 *                        ok fonksiyon this/super/arguments/new.target'ı yöntemden alır, sözü doğrudan izlenir)
 *   try { B } catch    → try { try { B } catch (e) { throw __peelV8Err(e); } } catch …  (E518: motorun fırlattığı
 *                        hatanın stack'i programın yakaladığı noktada V8 biçimine getirilir; değer aynı nesnedir)
 */
export function instrumentForSemantics(code) {
  let ast;
  try { ast = parse(code); } catch { return null; }
  let topLevelAwait = false;
  traverse(ast, {
    AwaitExpression(p) {
      if (p.node.__peel) return;
      if (ownerOf(p)?.isProgram()) topLevelAwait = true;
      const w = t.stringLiteral(where(p.node, 'await'));
      const inner = t.awaitExpression(t.callExpression(t.identifier('__peelAwait'), [p.node.argument, w]));
      inner.__peel = true;
      p.replaceWith(t.callExpression(t.identifier('__peelResume'), [inner, w]));
    },
    ForOfStatement(p) { if (p.node.await && ownerOf(p)?.isProgram()) topLevelAwait = true; },
    TryStatement(p) {
      if (!p.node.handler || p.node.__peel) return;
      p.node.__peel = true;
      const e = t.identifier('__peelE');
      const inner = t.tryStatement(p.node.block, t.catchClause(e, t.blockStatement([
        t.throwStatement(t.callExpression(t.identifier('__peelV8Err'), [t.identifier('__peelE')]))])));
      inner.__peel = true;
      p.node.block = t.blockStatement([inner]);
    },
    Method(p) {
      const n = p.node;
      if (!n.async || n.generator || n.__peel || n.kind !== 'method') return;
      n.__peel = true;
      const key = t.isIdentifier(n.key) ? n.key.name : t.isPrivateName(n.key) ? `#${n.key.id.name}` : 'yöntem';
      const label = t.stringLiteral(where(n, `async ${key}`));
      const args = t.identifier('__peelArgs');
      const arrow = t.arrowFunctionExpression(n.params, n.body, true);
      arrow.__peel = true;
      n.params = [t.restElement(args)];
      n.async = false;
      n.body = t.blockStatement([t.returnStatement(t.callExpression(t.identifier('__peelTrack'),
        [t.callExpression(arrow, [t.spreadElement(t.identifier('__peelArgs'))]), label]))]);
    },
    Function(p) {
      if (!p.node.async || p.node.__peel) return;
      if (p.isMethod()) return;
      p.node.__peel = true;
      const label = t.stringLiteral(where(p.node, `async ${p.node.id?.name ?? 'anonim'}`));
      if (p.isFunctionDeclaration() && p.node.id && (p.parentPath.isProgram() || p.parentPath.isBlockStatement())) {
        const stmt = t.expressionStatement(t.assignmentExpression('=', t.identifier(p.node.id.name),
          t.callExpression(t.identifier('__peelTrackFn'), [t.identifier(p.node.id.name), label])));
        p.parentPath.unshiftContainer('body', stmt);
      } else if (p.isFunctionExpression() || p.isArrowFunctionExpression()) {
        p.replaceWith(t.callExpression(t.identifier('__peelTrackFn'), [p.node, label]));
      }
    },
  });
  let out = raw(ast);
  if (topLevelAwait) {
    const wrapped = wrapTopLevelAwait(out, ast);
    if (wrapped === null) return null;
    out = wrapped;
  }
  return { code: out, topLevelAwait };
}

const PHASE = { micro: 'mikro', macro: 'makro', 'sync-end': 'senkron bitti' };

export function summarizeSem(sem) {
  const order = sem.filter((e) => Object.hasOwn(PHASE, e.k)).slice(0, 120)
    .map((e) => ({ phase: PHASE[e.k], api: e.api ?? '', fn: e.fn ?? '' }));
  const count = (k) => sem.filter((e) => e.k === k).length;
  return {
    order,
    microtasks: count('micro'),
    macrotasks: count('macro'),
    unhandled: sem.filter((e) => e.k === 'unhandled').slice(0, 40).map((e) => ({ where: e.where, reason: e.reason })),
    lateHandled: count('rejectionhandled'),
    thenables: sem.filter((e) => e.k === 'thenable').slice(0, 40).map((e) => ({ via: e.via, where: e.where ?? '' })),
    stacks: sem.filter((e) => e.k === 'stack').slice(0, 40).map((e) => ({ api: e.api, frames: e.frames ?? null })),
    intl: count('intl'),
    atomics: count('atomics'),
    weak: count('weak'),
    errors: sem.filter((e) => e.k === 'error').slice(0, 20).map((e) => ({ where: e.where, message: e.message })),
  };
}

/** Programı olay döngüsü modeliyle çalıştırır ve semantik kayıtları özetler. */
export async function semanticRuntime(sandbox, text, config = null) {
  if (!sandbox) return { ok: false, reason: 'sandbox yok' };
  const inst = instrumentForSemantics(text);
  if (!inst) return { ok: false, reason: 'program enstrümante edilemedi (parse/modül)' };
  const code = `try {\n${inst.code}\n} catch (e) { __peelSemMark("sync-throw"); }\n__peelSemMark("sync-end");`;
  const r = await sandbox.run(code, { timeoutMs: 6000, config: { ...(config ?? {}), eventLoop: true } });
  return { ok: r.ok, error: r.error, topLevelAwait: inst.topLevelAwait, ...summarizeSem(r.sem ?? []) };
}

// ---------------------------------------------------------------- E526 motor karşılaştırması
const PROBE_EXPR = (src, flags, probes) => `(function () {
  try {
    var r = new RegExp(${JSON.stringify(src)}, ${JSON.stringify(flags)});
    return JSON.stringify([true, ${JSON.stringify(probes)}.map(function (s) { r.lastIndex = 0; var m = r.exec(s); return m ? [m.index, m[0]] : null; })]);
  } catch (e) { return JSON.stringify([false, String(e && e.message)]); }
})()`;

function hostProbe(src, flags, probes) {
  try {
    const r = new RegExp(src, flags);
    return [true, probes.map((s) => { r.lastIndex = 0; const m = r.exec(s); return m ? [m.index, m[0]] : null; })];
  } catch (e) {
    return [false, String(e?.message)];
  }
}

/**
 * Desenleri host motorunda (tarayıcıda V8/SpiderMonkey) ve QuickJS sandbox'ında derleyip programdaki
 * string'ler üzerinde çalıştırır; derleme ya da eşleşme farkı motor farkıdır.
 * Geri izleme patlaması riskli desenler ana iş parçacığını kilitlememek için host'ta çalıştırılmaz.
 */
export async function compareRegexEngines(sandbox, patterns, strings, { maxPatterns = 60, maxProbes = 12 } = {}) {
  if (!sandbox) return { ok: false, differences: [], compared: 0 };
  const probes = [...new Set(strings.filter((s) => s.length <= 200))].slice(0, maxProbes);
  const list = [];
  const seen = new Set();
  for (const p of patterns) {
    const key = `/${p.source}/${p.flags}`;
    if (seen.has(key) || p.source.endsWith('...')) continue;
    seen.add(key);
    if (regexFeatures(p.source, p.flags).some((f) => f.includes('niceleyici'))) continue;
    list.push(p);
    if (list.length >= maxPatterns) break;
  }
  if (!list.length) return { ok: true, differences: [], compared: 0 };
  const r = await sandbox.batch(list.map((p) => PROBE_EXPR(p.source, p.flags, probes)), { timeoutMs: 4000 });
  const differences = [];
  list.forEach((p, i) => {
    const q = r.results?.[i];
    const qjs = q?.ok && typeof q.value === 'string' ? JSON.parse(q.value) : [false, q?.error ?? 'zaman aşımı'];
    const host = hostProbe(p.source, p.flags, probes);
    if (qjs[0] !== host[0]) {
      differences.push({ pattern: `/${p.source}/${p.flags}`, line: p.line, kind: 'derleme', host: host[0] ? 'derlenir' : host[1], sandbox: qjs[0] ? 'derlenir' : qjs[1] });
    } else if (host[0]) {
      const bad = probes.findIndex((_, k) => JSON.stringify(host[1][k]) !== JSON.stringify(qjs[1][k]));
      if (bad >= 0) differences.push({ pattern: `/${p.source}/${p.flags}`, line: p.line, kind: 'eşleşme', input: probes[bad], host: JSON.stringify(host[1][bad]), sandbox: JSON.stringify(qjs[1][bad]) });
    }
  });
  return { ok: true, compared: list.length, probes: probes.length, differences };
}
