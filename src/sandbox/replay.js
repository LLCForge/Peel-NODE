import { fnv1a } from '../util/hash.js';

// C58/C59, E726–E728, E744, E745: sandbox oturumu, yığın anlık görüntüsü, deterministik yeniden oynatma, zaman yolculuğu.
// QuickJS yığını doğrudan serileştirilemez (kapanımlar); sandbox deterministik olduğu için (sabit zaman, tohum,
// sahte G/Ç) durum = program + yapılandırma + adım listesi. Geri yükleme bu kaydı yeniden oynatır ve yığın
// grafiğinin özetini (heapHash) karşılaştırarak birebir aynı duruma gelindiğini kanıtlar.

export const REPLAY_FORMAT = 'peel-replay';
export const SNAPSHOT_FORMAT = 'peel-snapshot';
export const SESSION_FORMAT = 'peel-session';
export const VERSION = 1;
const MAX_STEPS = 500;
const MAX_NODES = 2000;

// Sandbox içinde: programın eklediği global'lerden erişilen nesne grafiği (getter çağrılmaz) ve FNV-1a özeti
export const REPLAY_PLUGIN = {
  name: 'replay',
  prelude: `globalThis.__peelHash = function (s) {
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
};
globalThis.__peelHeap = function (maxNodes) {
  var base = {};
  __peelBaseGlobals.forEach(function (k) { base[k] = 1; });
  var roots = Object.getOwnPropertyNames(globalThis).filter(function (k) { return !base[k] && k.indexOf("__peel") !== 0; }).sort();
  var ids = new Map(), nodes = [], queue = [];
  function ref(v) {
    var t = typeof v;
    if (v === null) return ["null"];
    if (t === "undefined") return ["u"];
    if (t === "number") return ["n", Object.is(v, -0) ? "-0" : String(v)];
    if (t === "string") return ["s", v.length > 200 ? v.slice(0, 200) + "…" + v.length : v];
    if (t === "boolean") return ["b", v];
    if (t === "bigint") return ["i", String(v)];
    if (t === "symbol") return ["y", String(v.description)];
    if (!ids.has(v)) {
      if (nodes.length >= maxNodes) return ["trunc"];
      ids.set(v, nodes.length); nodes.push(null); queue.push(v);
    }
    return ["r", ids.get(v)];
  }
  var rootRefs = roots.map(function (k) { var d = Object.getOwnPropertyDescriptor(globalThis, k); return [k, d && "value" in d ? ref(d.value) : ["acc"]]; });
  while (queue.length) {
    var o = queue.shift(), node = { t: typeof o === "function" ? "fn" : Array.isArray(o) ? "arr" : "obj" };
    var pr = Object.getPrototypeOf(o);
    node.c = pr === null ? "null" : pr === Object.prototype ? "Object" : pr === Array.prototype ? "Array" : pr === Function.prototype ? "Function" : (pr.constructor && pr.constructor.name) || "?";
    if (typeof o === "function") { node.name = o.name; try { node.src = __peelHash(Function.prototype.toString.call(o)); } catch (e) { node.src = "?"; } }
    if (o instanceof Map || o instanceof Set) {
      node.entries = []; var n = 0;
      o.forEach(function (v, k) { if (n++ < 100) node.entries.push(o instanceof Map ? [ref(k), ref(v)] : [ref(v)]); });
      node.size = o.size;
    }
    var keys = Object.getOwnPropertyNames(o);
    node.n = keys.length;
    node.p = keys.slice(0, 200).map(function (k) { var d = Object.getOwnPropertyDescriptor(o, k); return [k, d && "value" in d ? ref(d.value) : ["acc"]]; });
    nodes[ids.get(o)] = node;
  }
  var out = { roots: rootRefs, nodes: nodes, truncated: nodes.length >= maxNodes };
  out.hash = __peelHash(JSON.stringify([rootRefs, nodes]));
  return out;
};
globalThis.__peelObserve = function (from) {
  var fx = __peelEffects.slice(from);
  return JSON.stringify({ n: __peelEffects.length, effects: fx.slice(0, 200), fxHash: __peelHash(JSON.stringify(fx.map(function (e) { return [e.kind, e.target, e.detail]; }))), heap: __peelHeap(${MAX_NODES}) });
};
globalThis.__peelEvent = function (type, target) {
  return { type: type, target: target, currentTarget: target, key: "a", code: "KeyA", keyCode: 65, which: 65,
    clientX: 10, clientY: 10, isTrusted: true, preventDefault: function () {}, stopPropagation: function () {} };
};`,
};

const STEP_KINDS = new Set(['program', 'timer', 'handler', 'event', 'eval']);

// Adımın sandbox'ta çalışan karşılığı
function stepCode(s) {
  switch (s.kind) {
    case 'timer': return `(function () { var f = __peelTimers[${s.index | 0}]; if (typeof f === "function") { try { f(); } catch (e) {} } })();`;
    case 'handler': return `(function () { var h = __peelHandlers[${s.index | 0}]; if (h) { try { h.fn.call(h.target, __peelEvent(h.type, h.target)); } catch (e) {} } })();`;
    case 'event': return `(function () { __peelHandlers.filter(function (h) { return h.type === ${JSON.stringify(String(s.type))}; }).forEach(function (h) { try { h.fn.call(h.target, __peelEvent(h.type, h.target)); } catch (e) {} }); })();`;
    case 'eval': return `try {\n${String(s.code)}\n} catch (e) { __res.push({ __thrown: String(e) }); }`;
    default: throw new Error(`bilinmeyen adım: ${s.kind}`);
  }
}

function parseObs(value) {
  try { return JSON.parse(value); } catch { return null; }
}

async function observe(sandbox, token, from) {
  const r = await sandbox.evalIn(token, `__peelObserve(${from})`, { timeoutMs: 4000 });
  const o = r.ok ? parseObs(r.value) : null;
  if (!o) throw new Error(`gözlem okunamadı: ${r.error ?? 'boş'}`);
  return o;
}

const expectOf = (o) => ({ effectCount: o.n, fxHash: o.fxHash, heapHash: o.heap.hash });

// Yeni oturum: program bağlamda çalışır; kayıt ilk adımı (program) ve gözlemini içerir
export async function startSession(sandbox, code, { config = {}, timeoutMs = 8000 } = {}) {
  const opened = await sandbox.open(`try {\n${code}\n} catch (e) { __res.push({ __thrown: String(e) }); }`,
    { timeoutMs, config, plugins: [REPLAY_PLUGIN], jobs: true });
  if (!opened.ok) throw new Error(`oturum açılamadı: ${opened.error}`);
  const obs = await observe(sandbox, opened.token, 0);
  const record = {
    format: REPLAY_FORMAT, version: VERSION, codeHash: fnv1a(code), code, config, timeoutMs,
    steps: [{ kind: 'program', expect: expectOf(obs) }],
  };
  return { sandbox, token: opened.token, record, effects: obs.n, heap: obs.heap, history: [{ step: 0, effects: obs.effects, heap: obs.heap }], closed: false };
}

// E744: tek adım uygula ve kaydet (timer/handler/event/eval)
export async function step(session, action) {
  if (session.closed) throw new Error('oturum kapalı');
  if (!STEP_KINDS.has(action?.kind) || action.kind === 'program') throw new Error(`geçersiz adım: ${action?.kind}`);
  if (session.record.steps.length >= MAX_STEPS) throw new Error('adım sınırı');
  const clean = sanitizeStep(action);
  const r = await session.sandbox.evalIn(session.token, stepCode(clean), { timeoutMs: 4000 });
  const obs = await observe(session.sandbox, session.token, session.effects);
  session.effects = obs.n;
  session.heap = obs.heap;
  session.record.steps.push({ ...clean, expect: expectOf(obs), error: r.ok ? null : r.error });
  session.history.push({ step: session.record.steps.length - 1, effects: obs.effects, heap: obs.heap });
  return { effects: obs.effects, heap: obs.heap };
}

export async function closeSession(session) {
  if (session.closed) return;
  session.closed = true;
  await session.sandbox.close(session.token);
}

function sanitizeStep(s) {
  const out = { kind: s.kind };
  if (s.kind === 'timer' || s.kind === 'handler') out.index = Math.max(0, Math.min(10000, Number(s.index) | 0));
  if (s.kind === 'event') out.type = String(s.type ?? '').slice(0, 64);
  if (s.kind === 'eval') out.code = String(s.code ?? '').slice(0, 100000);
  return out;
}

// Güven sınırı: dışarıdan gelen kayıt (dosya) yapısal olarak doğrulanır
export function validateRecord(rec) {
  if (!rec || typeof rec !== 'object') return 'kayıt nesne değil';
  if (rec.format !== REPLAY_FORMAT) return 'biçim tanınmadı';
  if (rec.version !== VERSION) return `desteklenmeyen sürüm: ${rec.version}`;
  if (typeof rec.code !== 'string' || rec.code.length > 4_000_000) return 'kod yok ya da çok büyük';
  if (fnv1a(rec.code) !== rec.codeHash) return 'kod özeti uyuşmuyor';
  if (!Array.isArray(rec.steps) || !rec.steps.length || rec.steps.length > MAX_STEPS) return 'adım listesi geçersiz';
  if (rec.steps[0].kind !== 'program') return 'ilk adım program olmalı';
  for (const s of rec.steps) {
    if (!STEP_KINDS.has(s?.kind)) return `geçersiz adım: ${s?.kind}`;
    if (!s.expect || typeof s.expect.heapHash !== 'string' || typeof s.expect.fxHash !== 'string') return 'adım beklentisi eksik';
  }
  if (rec.config !== null && typeof rec.config !== 'object') return 'yapılandırma geçersiz';
  return null;
}

// C59/E727: kaydı taze runtime'da yeniden oynatır, her adımda etki ve yığın özetini karşılaştırır
export async function replay(sandbox, record, { upTo = Infinity, keepOpen = false } = {}) {
  const err = validateRecord(record);
  if (err) throw new Error(`replay kaydı: ${err}`);
  const steps = record.steps.slice(0, Math.min(record.steps.length, upTo + 1));
  const session = await startSession(sandbox, record.code, { config: record.config ?? {}, timeoutMs: record.timeoutMs ?? 8000 });
  const results = [];
  let divergedAt = -1;
  const check = (i, actual) => {
    const exp = steps[i].expect;
    const ok = exp.heapHash === actual.heapHash && exp.fxHash === actual.fxHash && exp.effectCount === actual.effectCount;
    results.push({ step: i, kind: steps[i].kind, ok, expected: exp, actual });
    if (!ok && divergedAt < 0) divergedAt = i;
  };
  try {
    check(0, session.record.steps[0].expect);
    for (let i = 1; i < steps.length; i++) {
      await step(session, steps[i]);
      check(i, session.record.steps[i].expect);
    }
  } catch (e) {
    await closeSession(session);
    throw e;
  }
  if (!keepOpen) await closeSession(session);
  return { ok: divergedAt < 0, divergedAt, results, session: keepOpen ? session : null };
}

// C58/E726: anlık görüntü = o ana kadarki kayıt + yığın grafiği; geri yükleme kaydı oynatıp yığın özetini doğrular
export function snapshot(session) {
  return {
    format: SNAPSHOT_FORMAT, version: VERSION, takenAt: session.record.steps.length - 1,
    record: structuredClone(session.record), heap: session.heap, heapHash: session.heap.hash,
  };
}

export async function restore(sandbox, snap) {
  if (!snap || snap.format !== SNAPSHOT_FORMAT || snap.version !== VERSION) throw new Error('anlık görüntü biçimi tanınmadı');
  const r = await replay(sandbox, snap.record, { keepOpen: true });
  const verified = r.ok && r.session.heap.hash === snap.heapHash;
  return { session: r.session, verified, divergedAt: r.divergedAt };
}

// E728: zaman yolculuğu — k. adımdan sonraki durum ve iki durum arasındaki yığın farkı
export async function travel(sandbox, record, k) {
  const r = await replay(sandbox, record, { upTo: k, keepOpen: true });
  const s = r.session;
  const at = { step: k, heap: s.heap, effects: s.history.flatMap((h) => h.effects), verified: r.ok };
  await closeSession(s);
  return at;
}

// Oturum geçmişinden adım adım durum: her adımın etkileri ve önceki adıma göre yığın farkı
export function timeline(session) {
  return session.history.map((h, i) => ({
    step: h.step,
    kind: session.record.steps[h.step].kind,
    effects: h.effects,
    heapHash: h.heap.hash,
    diff: i ? diffHeaps(session.history[i - 1].heap, h.heap) : diffHeaps(null, h.heap),
  }));
}

// İki yığın grafiğini global kök yollarıyla karşılaştırır (düğüm kimlikleri değişebilir; yol bazlı düzleştirme)
export function diffHeaps(a, b) {
  const flat = (heap) => {
    const out = new Map();
    if (!heap) return out;
    const seen = new Set();
    const walk = (path, ref, depth) => {
      if (ref[0] !== 'r') { out.set(path, JSON.stringify(ref)); return; }
      const node = heap.nodes[ref[1]];
      if (!node) return;
      out.set(path, `${node.t}:${node.c}${node.src ? `:${node.src}` : ''}`);
      if (seen.has(ref[1]) || depth > 6) return;
      seen.add(ref[1]);
      for (const [k, v] of node.p) walk(`${path}.${k}`, v, depth + 1);
      (node.entries ?? []).forEach((e, i) => walk(`${path}[${i}]`, e[e.length - 1], depth + 1));
    };
    for (const [k, ref] of heap.roots) walk(k, ref, 0);
    return out;
  };
  const fa = flat(a);
  const fb = flat(b);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, v] of fb) {
    if (!fa.has(k)) added.push({ path: k, value: v });
    else if (fa.get(k) !== v) changed.push({ path: k, from: fa.get(k), to: v });
  }
  for (const [k, v] of fa) if (!fb.has(k)) removed.push({ path: k, value: v });
  return { added: added.slice(0, 300), removed: removed.slice(0, 300), changed: changed.slice(0, 300) };
}

// E745: motor durumu serileştirme — kayıt + yığın + bellek; JSON'dan geri yüklenince yığın özeti doğrulanır
export async function serializeSession(session) {
  const mem = (await session.sandbox.evalIn(session.token, '0', {})).mem ?? null;
  return JSON.stringify({ format: SESSION_FORMAT, version: VERSION, record: session.record, heap: session.heap, memory: mem });
}

export async function deserializeSession(sandbox, json) {
  let o;
  try { o = JSON.parse(json); } catch (e) { throw new Error(`oturum JSON'u okunamadı: ${e.message}`); }
  if (o?.format !== SESSION_FORMAT || o.version !== VERSION) throw new Error('oturum biçimi tanınmadı');
  return restore(sandbox, { format: SNAPSHOT_FORMAT, version: VERSION, record: o.record, heap: o.heap, heapHash: o.heap?.hash });
}

// Analiz betiğinin yaptığını adım adım kayda geçirir: tüm zamanlayıcılar ve işleyiciler sırayla
export async function recordDefault(sandbox, code, opts = {}) {
  const s = await startSession(sandbox, code, opts);
  try {
    const counts = await sandbox.batchIn(s.token, ['__peelTimers.length', '__peelHandlers.length']);
    const timers = Math.min(50, counts.results?.[0]?.value ?? 0);
    const handlers = Math.min(100, counts.results?.[1]?.value ?? 0);
    for (let i = 0; i < timers; i++) await step(s, { kind: 'timer', index: i });
    for (let i = 0; i < handlers; i++) await step(s, { kind: 'handler', index: i });
    return s;
  } catch (e) {
    await closeSession(s);
    throw e;
  }
}
