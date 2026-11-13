import { POST_SCRIPT } from '../core/threat.js';
import { fnv1a } from '../util/hash.js';
import { instrument, captureEval, antiDebugScan, COVERAGE_PLUGIN } from './instrument.js';
import { findEmbeddedWasm } from './wasm.js';
import { findRedos } from '../verify/redos.js';
import { getSettings, toConfig } from './settings.js';

// Rapor için dinamik analiz: yakalama çalıştırması (etki, taint, WASM, worker, üretilen kod, parmak izi, kancalar),
// worker'ların ayrı sandbox'ta çalıştırılması ve çıktı kodunun enstrümante çalıştırması (coverage, çağrı grafiği,
// döngü/anti-debug tuzakları). Yalnızca analiz; deobfuscation doğrulamasını etkilemez.

const CAPTURE_PLUGIN = {
  name: 'capture',
  collect: `({ taint: __peelTaint, wasm: __peelWasm, dyn: __peelDyn, fp: __peelFpLog, hooks: __peelHookLog,
    workers: __peelWorkers.map(function (w) { return { id: w.id, kind: w.kind, url: w.url, code: w.code, inbox: w.inbox }; }) })`,
};

// Worker ortamı: pencere/DOM yok, postMessage dışarı kaydedilir, gelen mesajlar onmessage/dinleyicilere iletilir
export const WORKER_PLUGIN = {
  name: 'worker',
  prelude: `(function () {
  var g = globalThis;
  ["window", "document", "top", "parent", "frames", "localStorage", "sessionStorage", "alert", "confirm", "prompt", "history", "open"].forEach(function (k) { try { delete g[k]; } catch (e) {} });
  g.__peelWorkerOut = [];
  g.postMessage = function (m) {
    var c;
    try { c = JSON.stringify(m); } catch (e) { c = JSON.stringify(String(m)); }
    g.__peelWorkerOut.push(c === undefined ? "null" : c);
    __peelFx("worker.reply", "postMessage", c);
  };
  g.importScripts = function () { for (var i = 0; i < arguments.length; i++) __peelNetRecord("importScripts", arguments[i]); };
  g.close = function () { __peelFx("worker", "close"); };
  var listeners = [];
  g.addEventListener = function (t, f) { if (t === "message" && typeof f === "function") listeners.push(f); __peelFx("listener", t); };
  g.onmessage = null;
  g.WorkerGlobalScope = function () {};
  g.DedicatedWorkerGlobalScope = function () {};
  g.__peelWorkerDispatch = function (list) {
    list.forEach(function (m) {
      var ev = { data: JSON.parse(m), type: "message" };
      var fns = listeners.slice();
      if (typeof g.onmessage === "function") fns.push(g.onmessage);
      fns.forEach(function (f) { try { f(ev); } catch (e) { __res.push({ __thrown: String(e) }); } });
    });
    var out = g.__peelWorkerOut;
    g.__peelWorkerOut = [];
    return JSON.stringify(out);
  };
})();`,
};

const ROUNDS = 3;
const parseJson = (v, fallback) => { try { return typeof v === 'string' ? JSON.parse(v) : fallback; } catch { return fallback; } };

export function analysisConfig(extra = {}) {
  const s = getSettings();
  return { ...toConfig(s), watch: s.watch, ...extra };
}

// C66: yakalanan worker kodu ayrı bir sandbox bağlamında; ana programla en fazla ROUNDS tur mesajlaşma
async function runWorkers(sandbox, mainToken, workers, config) {
  const out = [];
  for (const w of workers.slice(0, 4)) {
    let code = w.code;
    // dış URL: yalnızca sahte yanıtlarda karşılığı varsa (ağ yok)
    if (code == null) code = (config.responses ?? []).find((r) => w.url.includes(r.match))?.body ?? null;
    if (code == null) { out.push({ id: w.id, url: w.url, kind: w.kind, skipped: 'kod yok (dış URL, sahte yanıt tanımlı değil)' }); continue; }
    const opened = await sandbox.open(`try {\n${code}\n} catch (e) { __res.push({ __thrown: String(e) }); }`,
      { timeoutMs: 4000, config: { ...config, capture: false }, plugins: [WORKER_PLUGIN], jobs: true });
    if (!opened.ok) { out.push({ id: w.id, url: w.url, kind: w.kind, error: opened.error }); continue; }
    const rec = { id: w.id, url: w.url, kind: w.kind, length: code.length, hash: fnv1a(code), error: opened.runError, rounds: [], code: code.slice(0, 4000) };
    try {
      let inbox = w.inbox;
      for (let round = 0; round < ROUNDS && inbox.length; round++) {
        const r = await sandbox.evalIn(opened.token, `__peelWorkerDispatch(${JSON.stringify(inbox)})`, { timeoutMs: 3000 });
        const replies = parseJson(r.value, []);
        rec.rounds.push({ received: inbox.length, replied: replies.length, replies: replies.slice(0, 20) });
        if (!replies.length || !mainToken) break;
        // yanıtları ana programa ilet; ana programın bu turda gönderdiği yeni mesajlar sonraki tura girer
        const before = await sandbox.evalIn(mainToken, `__peelWorkers[${w.id}].inbox.length`, {});
        await sandbox.evalIn(mainToken, `__peelDeliverWorker(${w.id}, ${JSON.stringify(replies)})`, { timeoutMs: 3000 });
        const next = await sandbox.evalIn(mainToken, `JSON.stringify(__peelWorkers[${w.id}].inbox.slice(${Number(before.value) || 0}))`, {});
        inbox = parseJson(next.value, []);
      }
      const fx = await sandbox.evalIn(opened.token, 'JSON.stringify({ out: __out, net: __peelNet, effects: __peelEffects.slice(0, 300), thrown: __res.filter(function (x) { return x && x.__thrown; }).map(function (x) { return x.__thrown; }) })', {});
      Object.assign(rec, parseJson(fx.value, {}));
    } finally {
      await sandbox.close(opened.token);
    }
    out.push(rec);
  }
  return out;
}

// Yakalama çalıştırması: program bağlamda çalışır, analiz betiği (zamanlayıcı/olay) tetiklenir, worker'lar ayrı sandbox'ta
export async function captureRun(sandbox, text, config = analysisConfig()) {
  const cfg = { ...config, capture: true };
  const opened = await sandbox.open(`try {\n${captureEval(text)}\n} catch (e) { __res.push({ __thrown: String(e) }); }`,
    { timeoutMs: 8000, config: cfg, plugins: [CAPTURE_PLUGIN], jobs: true });
  if (!opened.ok) return { ok: false, error: opened.error };
  try {
    await sandbox.evalIn(opened.token, POST_SCRIPT, { timeoutMs: 2000 });
    const first = await sandbox.evalIn(opened.token, '0', {});
    const cap = first.extra?.capture ?? {};
    const workers = await runWorkers(sandbox, opened.token, cap.workers ?? [], cfg);
    const fin = await sandbox.evalIn(opened.token, 'JSON.stringify({ out: __out, net: __peelNet, effects: __peelEffects })', {});
    const state = parseJson(fin.value, {});
    return {
      ok: true, runError: opened.runError, timedOut: opened.timedOut, mem: fin.mem,
      effects: state.effects ?? [], console: state.out ?? [], network: state.net ?? [],
      taint: fin.extra?.capture?.taint ?? cap.taint ?? [],
      wasm: fin.extra?.capture?.wasm ?? cap.wasm ?? [],
      dynamicCode: (fin.extra?.capture?.dyn ?? cap.dyn ?? []).map((d) => ({ ...d, hash: fnv1a(d.code) })),
      fingerprint: fin.extra?.capture?.fp ?? cap.fp ?? [],
      hooks: fin.extra?.capture?.hooks ?? cap.hooks ?? [],
      workers,
    };
  } finally {
    await sandbox.close(opened.token);
  }
}

// Enstrümante çalıştırma: satır coverage'ı, çalışma anı çağrı grafiği, döngü sayaçları, debugger isabetleri
export async function coverageRun(sandbox, code, config = analysisConfig()) {
  let inst;
  try { inst = instrument(code); } catch (e) { return { ok: false, error: e.message }; }
  const r = await sandbox.run(`try {\n${inst.code}\n} catch (e) { __res.push({ __thrown: String(e) }); }`,
    { timeoutMs: 8000, post: POST_SCRIPT, config, plugins: [COVERAGE_PLUGIN] });
  const c = r.extra?.coverage;
  if (!c || c.error) return { ok: false, error: r.error ?? c?.error ?? 'coverage okunamadı' };
  return { ok: true, ...summarizeCoverage(inst.map, c, r), timedOut: Boolean(r.timedOut), error: r.error ?? null, mem: r.mem };
}

export function summarizeCoverage(map, c, r = {}) {
  const lines = new Map();
  map.stmts.forEach((s, i) => {
    for (let l = s.line; l <= Math.min(s.endLine, s.line + 200); l++) lines.set(l, Math.max(lines.get(l) ?? 0, l === s.line ? c.s[i] : Math.min(c.s[i], lines.get(l) ?? Infinity)));
  });
  const covered = c.s.filter((n) => n > 0).length;
  const functions = map.fns.map((f, i) => ({ id: i, name: f.name, line: f.line, calls: c.f[i] ?? 0 }));
  const edges = Object.entries(c.edges).map(([k, count]) => {
    const [from, to] = k.split('>').map(Number);
    return { from, to, count };
  }).sort((a, b) => b.count - a.count);
  const loops = map.loops.map((l, i) => ({ id: i, line: l.line, kind: l.kind, iterations: c.l[i] ?? 0 }));
  // program zaman aşımına uğradıysa son giren döngü ve yığındaki fonksiyonlar sonsuz döngü adayıdır
  const timedOut = Boolean(r.timedOut);
  const hot = loops.reduce((a, b) => (b.iterations > (a?.iterations ?? 0) ? b : a), null);
  const infinite = timedOut ? {
    loop: c.last >= 0 ? loops[c.last] : hot,
    stack: c.stack.map((i) => functions[i]).filter(Boolean),
  } : null;
  return {
    statements: map.stmts.length,
    covered,
    ratio: map.stmts.length ? covered / map.stmts.length : 0,
    lines: [...lines].sort((a, b) => a[0] - b[0]),
    functions,
    callGraph: { nodes: functions.filter((f) => f.calls > 0), edges: edges.slice(0, 500) },
    loops: loops.filter((l) => l.iterations > 0).sort((a, b) => b.iterations - a.iterations).slice(0, 50),
    debuggerHits: map.debuggers.map((d, i) => ({ line: d.line, hits: c.d[i] ?? 0 })).filter((d) => d.hits > 0),
    maxDepth: c.maxDepth,
    infinite,
  };
}

export async function dynamicReport({ sandbox, text, output, config = null }) {
  const cfg = config ?? analysisConfig();
  // I182: felaket regex kalıpları çalıştırmadan önce bildirilir (motor bekçisi kilitlenmeyi ayrıca keser)
  const redos = [...findRedos(text).map((x) => ({ ...x, source: 'girdi' })), ...findRedos(output).map((x) => ({ ...x, source: 'çıktı' }))];
  const [capture, coverage] = sandbox
    ? [await captureRun(sandbox, text, cfg).catch((e) => ({ ok: false, error: e.message })),
      await coverageRun(sandbox, output, cfg).catch((e) => ({ ok: false, error: e.message }))]
    : [{ ok: false, error: 'sandbox yok' }, { ok: false, error: 'sandbox yok' }];
  const traps = [...redos.map((r) => ({ kind: 'redos', line: r.line, snippet: `/${r.pattern}/${r.flags} — ${r.reasons[0]}`, source: r.source })), ...antiDebugScan(text).map((x) => ({ ...x, source: 'girdi' })), ...antiDebugScan(output).map((x) => ({ ...x, source: 'çıktı' }))];
  const telemetry = sandbox?.telemetry ? (await sandbox.telemetry()).telemetry ?? null : null;
  const report = { capture, coverage, traps, redos, staticWasm: findEmbeddedWasm(text), telemetry };
  // isteğe bağlı araçlar (profil karşılaştırma, gerçek DOM, fuzz…) için kaynak; JSON dışa aktarımına girmez
  Object.defineProperty(report, 'code', { value: { text, output }, enumerable: false });
  return report;
}
