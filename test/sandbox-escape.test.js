// I182: sandbox kaçış testi paketi: node test/sandbox-escape.test.js
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { runEscapeSuite } from '../src/verify/escape.js';
import { createNodeSandbox } from '../src/sandbox/node-host.js';
import { findRedos } from '../src/verify/redos.js';

// host ağına çıkış olursa yakalanır: Node'un gerçek fetch'i sandbox çalışırken çağrılmamalı
let hostFetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...a) => { hostFetches++; return realFetch(...a); };

const host = createHost(await getQuickJS());
const sb = sandboxApi(async (m) => host.handle(m));
const r = await runEscapeSuite(sb);
for (const x of r.results) if (x.pass !== null) assert.ok(x.pass, `${x.id}: ${x.title} — ${x.error ?? JSON.stringify(x.out)}`);
assert.equal(r.skipped, 1, 'süreç içi host bekçi durumunu atlar');
assert.equal(hostFetches, 0, 'sandbox host ağına istek attı');
assert.equal(({}).__peelPolluted, undefined);

// bekçili Node sandbox'ı (worker_thread): felaket regex motoru kilitler, bekçi sonlandırıp yeniden başlatır
const guarded = createNodeSandbox();
const g = await runEscapeSuite(guarded);
for (const x of g.results) assert.ok(x.pass, `bekçili ${x.id}: ${x.title} — ${x.error ?? JSON.stringify(x.out)}`);
assert.equal(g.skipped, 0);
assert.ok(guarded.watchdogStats.restarts >= 1 && guarded.watchdogStats.timeouts >= 1);
guarded.close();

// statik ReDoS dedektörü
const found = findRedos('var a = /^(a+)+$/; var b = new RegExp("(x|xy)*z"); var c = /^[a-z]+$/; var d = /(((.+)+)+)+$/;');
assert.deepEqual(found.map((f) => f.line), [1, 1, 1]);
assert.ok(found.every((f) => f.reasons.length));
assert.equal(findRedos('var ok = /^\\d{3}-\\d{4}$/;').length, 0);
globalThis.fetch = realFetch;
console.log(`sandbox-escape: ok (${r.passed}/${r.total}, bekçili ${g.passed}/${g.total})`);
