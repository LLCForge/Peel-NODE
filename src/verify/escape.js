// I182: sandbox kaçış testi paketi — sandbox'tan host'a (Node süreci, tarayıcı sayfası, ağ, dosya sistemi) erişim
// denemeleri ve kaynak tüketme saldırıları. Her durumun beklentisi sandbox içinde ya da sonuç üzerinde denetlenir.
// Hem `npm test` (Node) hem arayüzden (worker) çalışır.

export const ESCAPE_CASES = [
  { id: 'node-globals', title: 'Node global\'leri yok', code: 'console.log([typeof process, typeof require, typeof module, typeof Buffer, typeof global].join())', expect: (r) => r.out[0] === 'undefined,undefined,undefined,undefined,undefined' },
  { id: 'function-this', title: 'Function("return this") sandbox global\'i', code: 'var g = Function("return this")(); console.log(typeof g.process, typeof g.require, g === globalThis)', expect: (r) => r.out[0] === 'undefined undefined true' },
  { id: 'constructor-chain', title: 'constructor zinciriyle host\'a çıkış', code: 'var p = ({}).constructor.constructor("return typeof process")(); console.log(p, typeof [].filter.constructor("return this")().process)', expect: (r) => r.out[0] === 'undefined undefined' },
  { id: 'browser-page', title: 'Gerçek sayfa nesneleri yok (parent/top kendisi)', code: 'console.log(parent === globalThis, top === globalThis, typeof document.defaultView, typeof globalThis.opener)', expect: (r) => r.out[0] === 'true true undefined undefined' },
  { id: 'dynamic-import', title: 'Dinamik import / modül yükleme', code: 'var ok = "yok"; try { import("fs").then(function () { ok = "yüklendi"; }, function () { ok = "reddedildi"; }); } catch (e) { ok = "sözdizimi"; } Promise.resolve().then(function () { return Promise.resolve(); }).then(function () { console.log(ok); });', expect: (r) => r.out.length === 1 && r.out[0] !== 'yüklendi' },
  { id: 'quickjs-std', title: 'QuickJS std/os modülleri yok', code: 'console.log(typeof std, typeof os, typeof scriptArgs)', expect: (r) => r.out[0] === 'undefined undefined undefined' },
  { id: 'fetch-stub', title: 'Ağ çağrıları sahte (gerçek istek yok)', code: 'fetch("https://example.org/").then(function (r) { return r.text(); }).then(function (t) { console.log(JSON.stringify(t), __peelNet.length); });', expect: (r) => r.out[0] === '"" 1' },
  { id: 'xhr-ws-beacon', title: 'XHR/WebSocket/beacon kaydedilir', code: 'var x = new XMLHttpRequest(); x.open("GET", "https://e.test/"); x.send(); new WebSocket("wss://e.test"); navigator.sendBeacon("https://e.test/b", "d"); console.log(__peelNet.map(function (n) { return n.api; }).join())', expect: (r) => r.out[0] === 'xhr,websocket,beacon' },
  { id: 'worker-stub', title: 'Worker gerçek thread açmaz', code: 'var w = new Worker("https://e.test/w.js"); console.log(typeof w.postMessage, __peelNet[0].api)', expect: (r) => r.out[0] === 'function Worker' },
  { id: 'wasm-stub', title: 'WebAssembly gerçek kod çalıştırmaz', code: 'var b = new Uint8Array([0,97,115,109,1,0,0,0]); WebAssembly.instantiate(b, {}).then(function (r) { console.log(Object.keys(r.instance.exports).length, __peelWasm.length); });', expect: (r) => r.out[0] === '0 1' },
  { id: 'host-binding', title: 'atob host bağlaması kötü argümanla çökmez', code: 'var e = []; try { atob({ toString: function () { throw new Error("x"); } }); } catch (x) { e.push("toString"); } try { atob(Symbol("s")); } catch (x) { e.push("symbol"); } console.log(e.join())', expect: (r) => r.ok && r.out.length === 1 },
  { id: 'prototype-pollution', title: 'Prototip kirliliği host\'a sızmaz', code: 'Object.prototype.__peelPolluted = 1; Array.prototype.__peelPolluted = 1; console.log(({}).__peelPolluted)', expect: (r) => r.out[0] === '1' && ({}).__peelPolluted === undefined && [].__peelPolluted === undefined },
  { id: 'infinite-loop', title: 'Sonsuz döngü kesilir', code: 'while (true) {}', timeoutMs: 300, expect: (r) => !r.ok && /interrupted/i.test(r.error ?? '') },
  { id: 'memory-bomb', title: 'Bellek bombası sınırda durur', code: 'var a = []; while (true) a.push(new Array(1e5).fill(1));', memoryMB: 16, expect: (r) => !r.ok && /memory|interrupted/i.test(r.error ?? '') },
  { id: 'stack-bomb', title: 'Sonsuz özyineleme yığın taşmasıyla durur', code: 'function f() { return f() + 1; } f();', expect: (r) => !r.ok && /stack|interrupted|recursion/i.test(r.error ?? '') },
  { id: 'atomics-wait', title: 'Atomics.wait host thread\'ini bloklamaz', code: 'var ok = "yok"; try { if (typeof SharedArrayBuffer === "function" && typeof Atomics === "object") { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000); ok = "bekledi"; } } catch (e) { ok = "hata"; } console.log(ok)', timeoutMs: 1500, maxMs: 4000, expect: (r) => !(r.out[0] === 'bekledi' && r.ms > 4000) },
  { id: 'time-leak', title: 'Gerçek zaman/rastgelelik sızmaz', code: 'console.log(Date.now(), performance.now(), new Date().getTime() === Date.now())', expect: (r) => /^1700000000000 [0-9]{1,3} true$/.test(r.out[0] ?? '') },
  { id: 'eval-scope', title: 'eval host kapsamına erişemez', code: 'console.log(eval("typeof process"), (0, eval)("typeof require"))', expect: (r) => r.out[0] === 'undefined undefined' },
];

// Bekçi gerektiren durumlar: QuickJS regex motoru geri izleme sırasında kesme işleyicisini çağırmaz. Bekçili
// sandbox (tarayıcı istemcisi, Node createNodeSandbox) motoru sonlandırıp yeniden başlatır ve zaman aşımı döndürür;
// ardından motor yeniden kullanılabilir olmalı. Bekçisiz süreç içi host'ta bu durum çalıştırılmaz (thread kilitlenir).
export const WATCHDOG_CASES = [
  { id: 'redos', title: 'Felaket regex bekçiyle kesilir, motor yeniden başlar', code: '/^(a+)+$/.test("a".repeat(40) + "b")', timeoutMs: 500,
    deadline: 3000, expect: (r, after) => !r.ok && r.watchdog === true && after.ok && after.out[0] === 'tekrar' },
];

export async function runEscapeSuite(sandbox) {
  const results = [];
  for (const c of ESCAPE_CASES) {
    const t0 = Date.now();
    let r;
    try {
      r = await sandbox.run(c.code, { timeoutMs: c.timeoutMs ?? 2000, memoryMB: c.memoryMB ?? 32 });
    } catch (e) {
      r = { ok: false, error: `istek hatası: ${e.message}`, out: [] };
    }
    r.ms = Date.now() - t0;
    let pass;
    try { pass = Boolean(c.expect({ ...r, out: r.out ?? [] })); } catch { pass = false; }
    results.push({ id: c.id, title: c.title, pass, ms: r.ms, error: r.error ?? null, out: (r.out ?? []).slice(0, 3) });
  }
  for (const c of WATCHDOG_CASES) {
    if (!sandbox.watchdog) { results.push({ id: c.id, title: c.title, pass: null, skipped: 'bekçisiz host (süreç içi)', ms: 0, error: null, out: [] }); continue; }
    const t0 = Date.now();
    const r = await sandbox.run(c.code, { timeoutMs: c.timeoutMs });
    const ms = Date.now() - t0;
    const after = await sandbox.run('console.log("tekrar")', { timeoutMs: 1000 });
    let pass;
    try { pass = Boolean(c.expect(r, { ...after, out: after.out ?? [] })); } catch { pass = false; }
    results.push({ id: c.id, title: c.title, pass, ms, error: r.error ?? null, out: [] });
  }
  const ran = results.filter((x) => x.pass !== null);
  return { passed: ran.filter((x) => x.pass).length, total: ran.length, skipped: results.length - ran.length, results };
}
