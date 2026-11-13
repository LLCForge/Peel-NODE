import { STUBS } from './stubs.js';
import { SEMANTIC_STUBS } from './semantics-stubs.js';
import { hostIntl, hostTzOffset, hostTzName } from './host-intl.js';

const MAX_CONTEXTS = 4;
const TELEMETRY_MAX = 200;

// İfadeyi değerlendirip yalnızca primitive sonucu JSON olarak döndüren sarmalayıcı.
const VALUE_OF = (code) => `(function () {
  var v = (function () { return (${code}
  ); })();
  var t = typeof v;
  if (t === "number" && (v !== v || v === 1 / 0 || v === -1 / 0)) return JSON.stringify({ t: "special", v: String(v) });
  if (t === "number" && v === 0 && 1 / v < 0) return JSON.stringify({ t: "negzero" });
  if (v === null || t === "string" || t === "number" || t === "boolean" || t === "undefined")
    return JSON.stringify({ t: v === null ? "null" : t, v: v === undefined ? null : v });
  return JSON.stringify({ t: t });
})()`;

function decodeValue(r) {
  if (!r.ok || typeof r.value !== 'string') return { ok: false, error: r.error };
  const { t, v } = JSON.parse(r.value);
  if (t === 'special') return { ok: true, type: 'number', value: Number(v) };
  if (t === 'undefined') return { ok: true, type: t, value: undefined };
  if (t === 'null' || t === 'string' || t === 'number' || t === 'boolean') return { ok: true, type: t, value: v };
  return { ok: true, type: t, opaque: true };
}

// E750: eklenti = { name, prelude?: sandbox kodu (stub'lardan sonra), collect?: JSON döndüren sandbox ifadesi }.
// Serileştirilebilir olduğu için worker mesajıyla da gelir; createHost(Q, { plugins }) ile host'a kalıcı eklenir.
function validPlugins(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && typeof p.name === 'string' && /^[\w.-]{1,40}$/.test(p.name) &&
    (p.prelude == null || typeof p.prelude === 'string') && (p.collect == null || typeof p.collect === 'string')).slice(0, 16);
}

// Tek bir QuickJS modülü üzerinde mesaj işleyici. Worker da Node testi de bunu kullanır.
export function createHost(QuickJS, options = {}) {
  const contexts = new Map();
  const hostPlugins = validPlugins(options.plugins);
  let tokenSeq = 0;
  // E749: motor telemetrisi — istek türü başına sayaç, süre, bellek tepe değeri, kesme ve sızan runtime sayısı
  const telemetry = { started: Date.now(), messages: {}, interrupts: 0, leaked: 0, peakMemory: 0, recent: [] };

  function make(memoryMB, config = null, plugins = []) {
    const rt = QuickJS.newRuntime();
    rt.setMemoryLimit(memoryMB * 1024 * 1024);
    // QuickJS sınırı host (V8) yığınından küçük olmalı: 1 MB'ta düz özyineleme misafirde "stack overflow" yerine host
    // yığınını taşırıyordu (try/catch'li debug koruması döngüsü). Host taşması WASM yığın işaretçisini geri almaz,
    // sonuç çağrı derinliğine göre değişir (kararsız); 256 KB'ta taşma misafirde yakalanabilir InternalError olur.
    rt.setMaxStackSize(256 * 1024);
    let deadline = Date.now() + 5000;
    rt.setInterruptHandler(() => Date.now() > deadline);
    const vm = rt.newContext();

    // Kesilen (interrupt), belleği taşan ya da yığını patlayan çalıştırmalar QuickJS'te nesne artığı bırakabilir;
    // böyle bir runtime'ı serbest bırakmak assert ile tüm WASM modülünü düşürür.
    // shortcut: kirlenen runtime serbest bırakılmaz (en fazla memoryMB sızar); sızıntı büyürse worker'ı yeniden başlat.
    let tainted = false;
    let broken = null;
    let interrupted = false;
    const evalRaw = (src, ms) => {
      // host hatası yarıda kesilmiş bir QuickJS durumu bırakır: sonraki sonuçlar güvenilmez, bağlam kullanılmaz
      if (broken) return { ok: false, error: broken };
      deadline = Date.now() + ms;
      let r;
      try {
        r = vm.evalCode(src);
      } catch (e) {
        // QuickJS regex motoru (ör. self-defending'in (((.+)+)+)+$ kalıbı) host yığınını taşırabilir
        tainted = true;
        broken = `host: ${e?.message ?? e}`;
        return { ok: false, error: broken };
      }
      if (r.error) {
        const e = vm.dump(r.error);
        r.error.dispose();
        const message = e?.message ?? String(e);
        if (/interrupted|out of memory|stack overflow/i.test(message)) tainted = true;
        if (/interrupted/i.test(message)) { interrupted = true; telemetry.interrupts++; }
        return { ok: false, error: message };
      }
      // nesneler (özellikle Promise) dump edilmez: dump Promise tutamacını kendisi serbest bırakır ve
      // ardından gelen dispose "Lifetime not alive" ile host'u düşürür. Çağıranlar yalnızca ilkel değer okur.
      const kind = vm.typeof(r.value);
      const value = kind === 'object' || kind === 'function' ? undefined : vm.dump(r.value);
      r.value.dispose();
      return { ok: true, value };
    };
    const memory = () => {
      if (tainted) return null;
      try {
        const h = rt.computeMemoryUsage();
        const m = rt.context.dump(h);
        h.dispose();
        const used = m.memory_used_size ?? 0;
        telemetry.peakMemory = Math.max(telemetry.peakMemory, used);
        return { used, limit: memoryMB * 1024 * 1024, objects: m.obj_count ?? 0 };
      } catch {
        return null;
      }
    };
    const dispose = () => {
      if (tainted) { telemetry.leaked++; return; }
      vm.dispose();
      rt.dispose();
    };

    // atob/btoa QuickJS'te yok: host'unkini bağla
    for (const name of ['atob', 'btoa']) {
      const fn = vm.newFunction(name, (x) => vm.newString(globalThis[name](String(vm.dump(x)))));
      vm.setProp(vm.global, name, fn);
      fn.dispose();
    }
    // Intl ve IANA saat dilimi verisi QuickJS'te yok: host Intl'ine senkron köprü (yalnızca string alır/verir)
    const bridges = { __peelHostIntl: hostIntl, __peelHostTz: (z, ms) => hostTzOffset(z, Number(ms)), __peelHostTzName: (z, ms) => hostTzName(z, Number(ms)) };
    for (const [name, f] of Object.entries(bridges)) {
      const fn = vm.newFunction(name, (...args) => vm.newString(f(...args.map((x) => String(vm.dump(x))))));
      vm.setProp(vm.global, name, fn);
      fn.dispose();
    }
    // sandbox yapılandırması (zaman, tarayıcı profili, çerez/depolama, sahte yanıtlar): stub'lar okur
    const c = evalRaw(`globalThis.__peelConfig = ${JSON.stringify(config ?? {})};`, 500);
    if (!c.ok) { dispose(); throw new Error(`config: ${c.error}`); }
    const s = evalRaw(STUBS, 2000);
    if (!s.ok) { dispose(); throw new Error(`stubs: ${s.error}`); }
    const sm = evalRaw(SEMANTIC_STUBS, 2000);
    if (!sm.ok) { dispose(); throw new Error(`semantic stubs: ${sm.error}`); }
    const all = [...hostPlugins, ...plugins];
    for (const p of all) {
      if (!p.prelude) continue;
      const r = evalRaw(p.prelude, 2000);
      if (!r.ok) { dispose(); throw new Error(`eklenti ${p.name}: ${r.error}`); }
    }

    const readArray = (name, fallback = []) => {
      const r = evalRaw(`JSON.stringify(${name})`, 1000);
      return r.ok && typeof r.value === 'string' ? JSON.parse(r.value) : fallback;
    };
    const collect = () => {
      const out = {};
      for (const p of all) {
        if (!p.collect) continue;
        const r = evalRaw(`JSON.stringify(${p.collect})`, 2000);
        try { out[p.name] = r.ok && typeof r.value === 'string' ? JSON.parse(r.value) : { error: r.error ?? 'boş' }; } catch (e) { out[p.name] = { error: e.message }; }
      }
      return out;
    };
    // Promise geri çağrıları (fetch().then, async fonksiyonların devamı) ancak iş kuyruğu boşaltılınca çalışır
    const runJobs = (ms) => {
      deadline = Date.now() + ms;
      try {
        rt.executePendingJobs(5000).dispose();
      } catch {
        tainted = true;
      }
    };
    return { evalRaw, readArray, runJobs, dispose, memory, collect, interrupted: () => interrupted };
  }

  function withBox(memoryMB, config, plugins, fn) {
    const box = make(memoryMB, config, plugins);
    try { return fn(box); } finally { box.dispose(); }
  }

  function handle(msg) {
    const t0 = Date.now();
    let result;
    try {
      result = dispatch(msg);
    } catch (e) {
      result = { ok: false, error: e?.message ?? String(e) };
    }
    const ms = Date.now() - t0;
    const m = (telemetry.messages[msg.type] ??= { count: 0, ms: 0, failed: 0 });
    m.count++;
    m.ms += ms;
    if (!result.ok) m.failed++;
    telemetry.recent.push({ type: msg.type, ms, ok: result.ok, mem: result.mem?.used ?? null });
    if (telemetry.recent.length > TELEMETRY_MAX) telemetry.recent.shift();
    return msg.type === 'telemetry' ? result : { ...result, ms };
  }

  function dispatch(msg) {
    const { type, code, list, token, timeoutMs = 4000, memoryMB = 64, config = null, post = null } = msg;
    const plugins = validPlugins(msg.plugins);

    switch (type) {
      case 'run':
        return withBox(memoryMB, config, plugins, (box) => {
          const r = box.evalRaw(`(function () {\n${code}\n})()`, timeoutMs);
          const timedOut = box.interrupted();
          box.runJobs(Math.min(timeoutMs, 2000));
          // olay döngüsü modeli (E516/E517): her makro görevden önce mikro kuyruk boşaltılır, reddedilen sözler denetlenir
          if (config?.eventLoop) {
            for (let i = 0; i < 200; i++) {
              box.evalRaw('__peelProbe()', 500);
              box.runJobs(500);
              box.evalRaw('__peelCheck()', 500);
              const tick = box.evalRaw('__peelTick()', Math.min(timeoutMs, 2000));
              if (!tick.ok || tick.value !== true) break;
              box.runJobs(1000);
            }
          }
          // analiz: program bittikten sonra zamanlayıcılar/olay işleyicileri tetiklenir (davranış karşılaştırmasında yok)
          if (post) {
            box.evalRaw(post, 2000);
            box.runJobs(1000);
          }
          return {
            ok: r.ok, error: r.error, timedOut, out: box.readArray('__out'), res: box.readArray('__res'),
            net: box.readArray('__peelNet'), reads: box.readArray('__peelReads', {}),
            crypto: post ? box.readArray('__peelCrypto') : [],
            // dışarıdan gözlenebilir etkiler (E706/E711): davranış karşılaştırması ve rapor için
            effects: box.readArray('__peelEffects'),
            extra: box.collect(), mem: box.memory(),
            sem: config?.eventLoop ? box.readArray('__peelSem') : [],
          };
        });

      case 'batch':
        return withBox(memoryMB, config, plugins, (box) => ({
          ok: true,
          results: list.map((expr) => decodeValue(box.evalRaw(VALUE_OF(expr), 500))),
        }));

      case 'open': {
        while (contexts.size >= MAX_CONTEXTS) {
          const [oldest] = contexts.keys();
          contexts.get(oldest).dispose();
          contexts.delete(oldest);
        }
        const box = make(msg.memoryMB ?? 96, config, plugins);
        // Global kapsamda çalıştır: üst seviye fonksiyon/değişkenler sonraki ifadelerden erişilebilir kalsın
        const r = box.evalRaw(code, timeoutMs);
        if (msg.jobs) box.runJobs(Math.min(timeoutMs, 2000));
        const id = `ctx${++tokenSeq}`;
        contexts.set(id, box);
        return { ok: true, token: id, runError: r.ok ? null : r.error, timedOut: box.interrupted() };
      }

      case 'cbatch': {
        const box = contexts.get(token);
        if (!box) return { ok: false, error: 'bağlam yok' };
        return { ok: true, results: list.map((expr) => decodeValue(box.evalRaw(VALUE_OF(expr), 1500))) };
      }

      // Bağlamda deyim çalıştırır, iş kuyruğunu boşaltır; değer JSON'a çevrilebiliyorsa döner (oturum/replay adımı)
      case 'ceval': {
        const box = contexts.get(token);
        if (!box) return { ok: false, error: 'bağlam yok' };
        const r = box.evalRaw(code, timeoutMs);
        box.runJobs(Math.min(timeoutMs, 1000));
        return { ok: r.ok, error: r.error, value: r.value === undefined ? null : r.value, mem: box.memory(), extra: box.collect() };
      }

      case 'close':
        contexts.get(token)?.dispose();
        contexts.delete(token);
        return { ok: true };

      case 'telemetry':
        return { ok: true, telemetry: { ...structuredCloneSafe(telemetry), contexts: contexts.size, uptimeMs: Date.now() - telemetry.started } };

      default:
        return { ok: false, error: `bilinmeyen istek: ${type}` };
    }
  }

  return { handle };
}

const structuredCloneSafe = (o) => JSON.parse(JSON.stringify(o));

// Worker istemcisi ve Node testinin paylaştığı API yüzeyi
export function sandboxApi(send) {
  return {
    run: (code, opts = {}) => send({ type: 'run', code, ...opts }),
    batch: (list, opts = {}) => send({ type: 'batch', list, ...opts }),
    open: (code, opts = {}) => send({ type: 'open', code, ...opts }),
    batchIn: (token, list) => send({ type: 'cbatch', token, list }),
    evalIn: (token, code, opts = {}) => send({ type: 'ceval', token, code, ...opts }),
    close: (token) => send({ type: 'close', token }),
    telemetry: () => send({ type: 'telemetry' }),
  };
}
