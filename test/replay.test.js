// Oturum, anlık görüntü, deterministik replay ve zaman yolculuğu: node test/replay.test.js
// C58/C59, E726/E727/E728/E744/E745
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import {
  startSession, step, closeSession, snapshot, restore, replay, travel, timeline, validateRecord,
  serializeSession, deserializeSession, recordDefault, diffHeaps,
} from '../src/sandbox/replay.js';

const host = createHost(await getQuickJS());
const sb = sandboxApi(async (m) => host.handle(m));

const code = `var state = { clicks: 0, log: [], seen: new Map() };
var hidden = (function () { var n = 0; return function () { return ++n; }; })();
document.addEventListener("click", function () { state.clicks++; state.seen.set("c" + state.clicks, Math.random()); });
setInterval(function () { state.log.push(hidden()); console.log("tick", state.log.length); }, 1000);`;

const s = await startSession(sb, code);
await step(s, { kind: 'event', type: 'click' });
await step(s, { kind: 'timer', index: 0 });
const snap = snapshot(s); // 2 adım sonrası
await step(s, { kind: 'timer', index: 0 });
await step(s, { kind: 'eval', code: 'state.extra = hidden() * 10;' });
const finalHash = s.heap.hash;
const tl = timeline(s);
assert.equal(tl.length, 5);
assert.ok(tl[1].diff.changed.some((c) => c.path === 'state.clicks'), 'tıklama sayacı değişti');
assert.ok(tl[4].diff.added.some((a) => a.path === 'state.extra'));
assert.equal(validateRecord(s.record), null);
await closeSession(s);

// deterministik replay: aynı kayıt aynı yığına ve etkilere götürür (Math.random tohumlu, kapanım durumu dahil)
const rep = await replay(sb, s.record);
assert.ok(rep.ok, `ayrıştı: ${rep.divergedAt}`);
assert.equal(rep.results.at(-1).actual.heapHash, finalHash);
// kapanım içindeki sayaç da yeniden oluşur: extra = 3. çağrı * 10
assert.equal(s.history.at(-1).heap.roots.length > 0, true);

// anlık görüntüden geri yükleme: yığın özeti doğrulanır, oturum oradan devam eder
const restored = await restore(sb, snap);
assert.ok(restored.verified);
await step(restored.session, { kind: 'timer', index: 0 });
await step(restored.session, { kind: 'eval', code: 'state.extra = hidden() * 10;' });
assert.equal(restored.session.heap.hash, finalHash, 'geri yüklenen durumdan aynı geleceğe');
await closeSession(restored.session);

// sapma tespiti: kayıttaki beklenti bozulursa ilgili adım bildirilir
const tampered = structuredClone(s.record);
tampered.steps[2].expect.heapHash = 'deadbeef';
const bad = await replay(sb, tampered);
assert.equal(bad.ok, false);
assert.equal(bad.divergedAt, 2);
assert.match(validateRecord({ ...s.record, code: 'x' }), /özet/);
assert.match(validateRecord({ format: 'peel-replay', version: 9 }), /sürüm/);

// zaman yolculuğu: 1. adım sonrasına git
const at1 = await travel(sb, s.record, 1);
assert.ok(at1.verified);
const clicks = at1.heap.nodes[at1.heap.roots.find(([k]) => k === 'state')[1][1]].p.find(([k]) => k === 'clicks')[1];
assert.deepEqual(clicks, ['n', '1']);

// motor durumu serileştirme
const live = await recordDefault(sb, code);
assert.equal(live.record.steps.length, 3, 'program + 1 zamanlayıcı + 1 işleyici');
const json = await serializeSession(live);
await closeSession(live);
const back = await deserializeSession(sb, json);
assert.ok(back.verified);
await closeSession(back.session);
await assert.rejects(deserializeSession(sb, '{"format":"x"}'), /tanınmadı/);
assert.deepEqual(diffHeaps(null, null), { added: [], removed: [], changed: [] });
console.log('replay: ok');
