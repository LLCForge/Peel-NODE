// I182 bekçi birimi, E724 tarayıcı izolasyon yapılandırması, E716 arayüz metinleri: node test/watchdog.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWatchdog, deadlineOf } from '../src/sandbox/watchdog.js';

// sahte motor: "hang" isteğine hiç yanıt vermez, diğerlerine hemen yanıt verir
let spawned = 0;
let terminated = 0;
const dog = createWatchdog({
  deadline: (m) => (m.type === 'hang' ? 50 : 1000),
  spawn() {
    spawned++;
    let cb = () => {};
    return {
      post: (m) => { if (m.type !== 'hang') setTimeout(() => cb({ id: m.id, ok: true, echo: m.type }), 1); },
      onMessage: (f) => { cb = f; },
      onError: () => {},
      terminate: () => { terminated++; },
    };
  },
});
const [a, h, b] = await Promise.all([dog.send({ type: 'a' }), dog.send({ type: 'hang' }), dog.send({ type: 'b' })]);
assert.deepEqual([a.echo, b.echo], ['a', 'b'], 'kilitlenen istekten sonraki iş yeni motorda sürer');
assert.equal(h.ok, false);
assert.ok(h.watchdog && h.timedOut && /bekçi/.test(h.error));
assert.equal(spawned, 2);
assert.equal(terminated, 1);
assert.deepEqual(dog.stats, { restarts: 1, timeouts: 1 });
const pending = dog.send({ type: 'hang' });
dog.kill('Durduruldu');
assert.equal((await pending).error, 'Durduruldu');
assert.ok(deadlineOf({ type: 'run', timeoutMs: 8000, post: 'x' }) > 8000 + 3000);
assert.ok(deadlineOf({ type: 'batch', list: new Array(10) }) >= 5000);

// E724: cross-origin isolation başlıkları (geliştirme, önizleme, statik barındırma) ve tembel Z3 worker'ı
const vite = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
for (const s of ["'Cross-Origin-Opener-Policy': 'same-origin'", "'Cross-Origin-Embedder-Policy': 'require-corp'", 'server: { headers: ISOLATION }', 'preview: { headers: ISOLATION }']) assert.ok(vite.includes(s), s);
const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
assert.match(headers, /\/\*\r?\n\s+Cross-Origin-Opener-Policy: same-origin\r?\n\s+Cross-Origin-Embedder-Policy: require-corp/);
const z3 = readFileSync(new URL('../src/symbolic/z3/z3.js', import.meta.url), 'utf8');
assert.ok(z3.includes('crossOriginIsolated') && z3.includes("new URL('./z3.worker.js', import.meta.url)"));

// E716 ve I182 arayüz metinleri her iki dilde
const i18n = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
for (const k of ['rt.patch', 'rt.patchHelp', 'rt.apply', 'rt.redos']) assert.equal(i18n.split(`'${k}':`).length - 1, 2, `${k} TR ve EN`);
console.log('watchdog: ok');
