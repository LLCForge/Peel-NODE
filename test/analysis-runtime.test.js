// Sandbox semantik modelleri öz-denetimi (E512, E515–E519, E526, E529–E531, E534, E539, E540):
// node test/analysis-runtime.test.js
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { semanticRuntime, compareRegexEngines, instrumentForSemantics } from '../src/analysis/runtime.js';

const host = createHost(await getQuickJS());
const sandbox = sandboxApi(async (msg) => host.handle(msg));
const val = async (expr, config = null) => {
  const r = await sandbox.run(`__res.push(${expr});`, { config });
  assert.ok(r.ok, r.error);
  return r.res[0];
};

// E529: saat dilimi host'tan bağımsız, yapılandırılabilir
assert.equal(await val('new Date(0).getHours()'), 0);
assert.equal(await val('new Date(0).getTimezoneOffset()'), 0);
assert.equal(await val('new Date(0).toString()'), 'Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)');
assert.equal(await val('new Date(0).getHours()', { tz: -180 }), 3);
assert.equal(await val('new Date(0).toString()', { tz: -180 }), 'Thu Jan 01 1970 03:00:00 GMT+0300 (GMT+03:00)');
assert.equal(await val('new Date(2020, 0, 1).getTime()', { tz: -180 }), Date.UTC(2020, 0, 1) - 3 * 3600000);
assert.equal(await val('Date.parse("2020-01-01T00:00:00")', { tz: 60 }), Date.UTC(2020, 0, 1) + 3600000);
assert.equal(await val('Date.parse("2020-01-01")', { tz: 60 }), Date.UTC(2020, 0, 1));
assert.equal(await val('(function(){ var d = new Date(0); d.setHours(5); return d.getUTCHours(); })()', { tz: -120 }), 3);
assert.equal(await val('typeof Date()'), 'string');
assert.equal(await val('new Date(0) instanceof Date && new Date(0).constructor === Date'), true);

// E530: toLocaleString
assert.equal(await val('(1234567.891).toLocaleString()'), '1,234,567.891');
assert.equal(await val('(1234567.891).toLocaleString("tr-TR")'), '1.234.567,891');
assert.equal(await val('(1234.5).toLocaleString("de-DE", { minimumFractionDigits: 2 })'), '1.234,50');
assert.equal(await val('[1234, null, 5].toLocaleString()'), '1,234,,5');
assert.equal(await val('new Date(Date.UTC(2023, 0, 2, 15, 4, 5)).toLocaleString("en-US")'), '1/2/2023, 3:04:05 PM');
assert.equal(await val('new Date(Date.UTC(2023, 0, 2, 15, 4, 5)).toLocaleDateString("tr-TR")'), '02.01.2023');

// E531: Intl.NumberFormat (host V8 Intl ile karşılaştır)
const intlCases = [
  ['en-US', {}, 1234567.891], ['en-US', { style: 'percent' }, 0.256], ['en-US', { style: 'currency', currency: 'USD' }, -1234.5],
  ['en-US', { style: 'currency', currency: 'JPY' }, 1234.5], ['en-US', { maximumSignificantDigits: 3 }, 123456],
  ['en-US', { minimumIntegerDigits: 3 }, 7], ['en-US', { useGrouping: false }, 1234567], ['en-US', { notation: 'compact' }, 1234],
  ['en-US', { notation: 'compact' }, 999999], ['en-US', { notation: 'compact' }, 12345678], ['en-US', { notation: 'compact' }, 999.4],
  ['en-US', { signDisplay: 'always' }, 5], ['en-US', { signDisplay: 'exceptZero' }, 0], ['tr-TR', { style: 'percent' }, 0.5],
  ['tr-TR', { style: 'currency', currency: 'TRY' }, 1234.5], ['de-DE', { style: 'currency', currency: 'EUR' }, 1234.5],
  ['de-DE', { style: 'percent' }, 0.5], ['ja-JP', { style: 'currency', currency: 'JPY' }, 1234], ['en-US', {}, NaN], ['en-US', {}, -Infinity],
  ['en-US', { maximumFractionDigits: 0 }, 2.5], ['en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }, 1.005],
];
for (const [loc, opts, n] of intlCases) {
  const expected = new Intl.NumberFormat(loc, opts).format(n);
  const got = await val(`new Intl.NumberFormat(${JSON.stringify(loc)}, ${JSON.stringify(opts)}).format(${Number.isNaN(n) ? 'NaN' : n === -Infinity ? '-Infinity' : n})`);
  assert.equal(got, expected, `${loc} ${JSON.stringify(opts)} ${n}`);
}
assert.equal(await val('new Intl.NumberFormat("en-US").formatToParts(-1234.5).map(function (p) { return p.type; }).join()'),
  new Intl.NumberFormat('en-US').formatToParts(-1234.5).map((p) => p.type).join());
assert.equal(await val('new Intl.NumberFormat("xx-YY").resolvedOptions().locale'), 'en-US');
assert.equal(await val('(function(){ try { new Intl.NumberFormat("en", { style: "currency" }); } catch (e) { return e.name; } })()'), 'TypeError');
assert.equal(await val('(function(){ try { new Intl.NumberFormat("en", { maximumFractionDigits: 1, minimumFractionDigits: 3 }); } catch (e) { return e.name; } })()'), 'RangeError');

// E534: performance.now monoton ve deterministik
assert.equal(await val('(function(){ var a = performance.now(), b = performance.now(); return b > a; })()'), true);
assert.equal(await val('(function(){ var s = performance.now(), n = 0; while (performance.now() - s < 50) n++; return n; })()'), 49);

// E539: Atomics
assert.equal(await val('(function(){ var a = new Int32Array(new SharedArrayBuffer(8)); Atomics.add(a, 0, 5); Atomics.sub(a, 0, 2); Atomics.compareExchange(a, 1, 0, 9); return [Atomics.load(a, 0), a[1], Atomics.exchange(a, 0, 1), Atomics.isLockFree(4)].join(); })()'), '3,9,3,true');
assert.equal(await val('(function(){ try { Atomics.add(new Float64Array(1), 0, 1); } catch (e) { return e.name; } })()'), 'TypeError');
assert.equal(await val('(function(){ try { Atomics.load(new Int8Array(1), 5); } catch (e) { return e.name; } })()'), 'RangeError');
assert.equal(await val('Atomics.store(new Uint8Array(1), 0, 300)'), 300);
assert.equal(await val('(function(){ var a = new Int32Array(new SharedArrayBuffer(4)); return Atomics.waitAsync(a, 0, 1).value; })()'), 'not-equal');

// E540: WeakRef / FinalizationRegistry
assert.equal(await val('(function(){ var o = {}; return new WeakRef(o).deref() === o; })()'), true);
assert.equal(await val('(function(){ try { new WeakRef(1); } catch (e) { return e.name; } })()'), 'TypeError');
assert.equal(await val('(function(){ var r = new FinalizationRegistry(function(){}), t = {}; r.register({}, 1, t); return [r.unregister(t), r.unregister(t)].join(); })()'), 'true,false');

// E519: Error.captureStackTrace
assert.equal(await val('(function(){ function Make() { var o = { name: "E", message: "m" }; Error.captureStackTrace(o, Make); return o.stack.split("\\n")[0]; } return Make(); })()'), 'E: m');
assert.equal(await val('Error.stackTraceLimit'), 10);

// E516: olay döngüsü sırası — senkron → mikro (then, queueMicrotask, await) → makro (setTimeout)
{
  const r = await semanticRuntime(sandbox, `
setTimeout(function timer() {}, 0);
Promise.resolve().then(function first() {});
queueMicrotask(function second() {});
(async function run() { await null; })();
`);
  assert.ok(r.ok, r.error);
  const seq = r.order.map((o) => (o.fn ? `${o.phase}:${o.fn}` : o.phase));
  assert.deepEqual(seq, ['senkron bitti', 'mikro:first', 'mikro:second', 'mikro:await@5', 'makro:timer']);
}

// E517: işlenmeyen ret, sonradan işlenen ret ve E515 thenable
{
  const r = await semanticRuntime(sandbox, `
Promise.reject(new Error("boom"));
var late = Promise.reject(1);
setTimeout(function () { late.catch(function () {}); }, 0);
Promise.reject(2).catch(function () {});
async function f() { throw new Error("af"); }
f();
(async function () { try { await f(); } catch (e) {} })();
var th = { then: function (r) { r(1); } };
(async function () { await th; })();
`);
  const reasons = r.unhandled.map((u) => u.reason).sort();
  assert.deepEqual(reasons, ['1', 'af', 'boom']);
  assert.equal(r.lateHandled, 1);
  assert.ok(r.thenables.some((x) => x.via === 'await'));
}

// E512: üst seviye await sandbox'ta async sarmalayıcıyla çalışır
{
  const inst = instrumentForSemantics('var v = await Promise.resolve(3); console.log(v);');
  assert.equal(inst.topLevelAwait, true);
  const r = await semanticRuntime(sandbox, 'var v = await Promise.resolve(3); console.log(v);');
  assert.ok(r.ok && r.topLevelAwait);
}

// E518: analiz çalıştırmasında stack V8 biçiminde (başlık satırı) ve okuması kaydedilir
{
  const r = await semanticRuntime(sandbox, 'var s = new Error("x").stack; if (s.split("\\n")[0] !== "Error: x") throw new Error("biçim");');
  assert.ok(r.stacks.some((s) => s.api === 'Error.stack'));
  assert.equal(r.errors.length, 0);
}

// E526: motor farkı — v bayrağı QuickJS'te derlenmez, host'ta derlenir
{
  const r = await compareRegexEngines(sandbox, [{ source: '[\\p{L}--[a-z]]', flags: 'v', line: 1 }, { source: 'a(?<=a)b', flags: '', line: 2 }, { source: 'x+', flags: 'g', line: 3 }], ['xx', 'ab']);
  assert.equal(r.compared, 3);
  assert.ok(r.differences.some((d) => d.kind === 'derleme' && d.pattern.endsWith('/v')));
  assert.ok(!r.differences.some((d) => d.pattern === '/x+/g'));
}

// E530: tüm tarih biçimlendirme seçenekleri ve IANA dilimleri — host V8 Intl ile birebir
{
  const T = Date.UTC(2023, 6, 9, 21, 4, 5, 123);
  const locales = ['en-US', 'tr-TR', 'de-DE', 'fr-FR', 'ru-RU', 'ja-JP', 'ar-EG', 'zh-CN'];
  const optionSets = [
    undefined, { dateStyle: 'full', timeStyle: 'long' }, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' },
    { era: 'short', year: '2-digit', month: 'narrow', day: '2-digit' }, { era: 'long', year: 'numeric' },
    { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'shortOffset' },
    { timeZone: 'America/New_York', timeZoneName: 'long', hour: 'numeric' }, { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' },
    { month: 'short', weekday: 'narrow', fractionalSecondDigits: 3, second: 'numeric' }, { dayPeriod: 'long', hour: 'numeric' },
    { hourCycle: 'h11', hour: 'numeric', minute: 'numeric' }, { timeZoneName: 'longGeneric', timeZone: 'Europe/Paris' },
    { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Pacific/Auckland' },
  ];
  for (const loc of locales) {
    for (const o of optionSets) {
      for (const method of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
        if (o && ((method === 'toLocaleDateString' && o.timeStyle) || (method === 'toLocaleTimeString' && o.dateStyle))) continue;
        const hostOpts = { timeZone: 'UTC', ...(o ?? {}) };
        const expected = new Date(T)[method](loc, hostOpts);
        const got = await val(`new Date(${T}).${method}(${JSON.stringify(loc)}${o ? `, ${JSON.stringify(o)}` : ''})`);
        assert.equal(got, expected, `${method} ${loc} ${JSON.stringify(o)}`);
      }
    }
  }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'full' }).formatToParts(T).map((p) => p.type).join();
  assert.equal(await val(`new Intl.DateTimeFormat("en-US", { dateStyle: "full" }).formatToParts(${T}).map(function (p) { return p.type; }).join()`), parts);
  assert.equal(await val(`new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo" }).resolvedOptions().timeZone`), 'Asia/Tokyo');
  assert.equal(await val('(function(){ try { new Date(0).toLocaleDateString("en", { timeStyle: "short" }); } catch (e) { return e.name; } })()'), 'TypeError');
  assert.equal(await val('(function(){ try { new Intl.DateTimeFormat("en", { timeZone: "Mars/Base" }); } catch (e) { return e.name; } })()'), 'RangeError');
  // IANA saat dilimiyle Date yerel saati (yaz saati dahil)
  const ny = { tz: 'America/New_York' };
  assert.equal(await val(`new Date(${Date.UTC(2023, 6, 1, 12)}).getTimezoneOffset()`, ny), 240);
  assert.equal(await val(`new Date(${Date.UTC(2023, 0, 1, 12)}).getTimezoneOffset()`, ny), 300);
  assert.equal(await val(`new Date(${Date.UTC(2023, 0, 1, 12)}).getHours()`, ny), 7);
  assert.equal(await val('new Date(2023, 6, 1, 8).getTime()', ny), Date.UTC(2023, 6, 1, 12));
  assert.equal(await val(`new Date(${Date.UTC(2023, 0, 1, 12)}).toString()`, ny), 'Sun Jan 01 2023 07:00:00 GMT-0500 (Eastern Standard Time)');
  assert.equal(await val(`new Date(${T}).toLocaleString("en-US")`, ny), new Date(T).toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

// E531: unit, scientific, engineering, compact — tüm desteklenen yerel ayarlarda host V8 ile birebir
{
  const locales = ['en-US', 'tr-TR', 'de-DE', 'fr-FR', 'ru-RU', 'ja-JP', 'ar-EG', 'hi-IN'];
  const cases = [
    [{ style: 'unit', unit: 'kilometer-per-hour' }, 1234.5], [{ style: 'unit', unit: 'liter', unitDisplay: 'long' }, 2],
    [{ style: 'unit', unit: 'byte', notation: 'compact', unitDisplay: 'narrow' }, 1536000], [{ notation: 'scientific' }, 123456.789],
    [{ notation: 'engineering' }, 0.000123], [{ notation: 'compact' }, 1234], [{ notation: 'compact', compactDisplay: 'long' }, 98765432],
    [{ notation: 'compact' }, -0.5], [{ style: 'currency', currency: 'EUR', currencyDisplay: 'name' }, 3.5],
    [{ style: 'currency', currency: 'USD', currencySign: 'accounting' }, -12], [{ roundingMode: 'floor', maximumFractionDigits: 1 }, 2.79],
    [{ minimumSignificantDigits: 3, maximumSignificantDigits: 5 }, 1.5], [{ signDisplay: 'negative' }, -0],
  ];
  for (const loc of locales) {
    for (const [o, n] of cases) {
      const expected = new Intl.NumberFormat(loc, o).format(n);
      const got = await val(`new Intl.NumberFormat(${JSON.stringify(loc)}, ${JSON.stringify(o)}).format(${Object.is(n, -0) ? '-0' : n})`);
      assert.equal(got, expected, `${loc} ${JSON.stringify(o)} ${n}`);
    }
  }
  assert.equal(await val('new Intl.NumberFormat("en", { notation: "compact" }).format(12345678901234567890n)'), new Intl.NumberFormat('en', { notation: 'compact' }).format(12345678901234567890n));
  assert.equal(await val('new Intl.PluralRules("ru").select(3)'), 'few');
  assert.equal(await val('new Intl.RelativeTimeFormat("tr", { numeric: "auto" }).format(-1, "day")'), new Intl.RelativeTimeFormat('tr', { numeric: 'auto' }).format(-1, 'day'));
  assert.equal(await val('"ä".localeCompare("z", "de")'), 'ä'.localeCompare('z', 'de'));
}

// E517: async sınıf/nesne yöntemlerinin sözü doğrudan izlenir
{
  const r = await semanticRuntime(sandbox, `
class S { async m(x) { throw new Error("cm" + x); } static async s() { throw new Error("cs"); } async #p() { throw new Error("cp"); } run() { this.#p(); } }
var o = { async om() { throw new Error("om"); }, async ok() { return super.toString ? 1 : 0; } };
new S().m(1); S.s(); new S().run(); o.om(); o.ok();
(async function () { try { await new S().m(2); } catch (e) {} })();`);
  assert.deepEqual(r.unhandled.map((u) => u.reason).sort(), ['cm1', 'cp', 'cs', 'om']);
  assert.ok(r.unhandled.every((u) => /^async /.test(u.where)));
}

// E518: motorun fırlattığı hata programın yakaladığı yerde V8 biçiminde
{
  const r = await semanticRuntime(sandbox, `
var a; try { null.x; } catch (e) { a = e.stack.split("\\n")[0]; }
if (a.indexOf("TypeError: ") !== 0) throw new Error("catch: " + a);
var b; try { try { undefinedFn(); } finally { } } catch ({ stack }) { b = stack; }
if (b.indexOf("ReferenceError: ") !== 0) throw new Error("desen: " + b);
Promise.resolve().then(function () { return [].x.y; }).catch(function (e) { if (e.stack.indexOf("TypeError: ") !== 0) throw new Error("ret"); });
(async function () { try { await Promise.reject(new RangeError("q")); } catch (e) { if (e.stack.indexOf("RangeError: q") !== 0) throw new Error("await"); } })();`);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.unhandled.length, 0, JSON.stringify(r.unhandled));
  assert.ok(r.stacks.filter((s) => /stack$/.test(s.api)).length >= 4);
}

// E538: ArrayBuffer ayırma (transfer, transferToFixedLength, structuredClone, postMessage)
{
  assert.equal(await val(`(function () {
  var b = new ArrayBuffer(8), u = new Uint8Array(b), dv = new DataView(b), sub = u.subarray(2);
  u[0] = 7;
  var n = b.transfer(), out = [];
  out.push(b.byteLength, b.detached, n.byteLength, n.detached, new Uint8Array(n)[0], u.length, u.byteLength, u.byteOffset, u[0], sub.length, 0 in u, Object.keys(u).length);
  u[1] = 5; out.push(u[1]);
  [function () { u.fill(1); }, function () { dv.getUint8(0); }, function () { return dv.byteLength; }, function () { b.slice(0); }, function () { b.transfer(); },
   function () { new Uint8Array(b); }, function () { new DataView(b); }, function () { for (var x of u) {} }].forEach(function (f) {
    try { f(); out.push("ok"); } catch (e) { out.push(e.name); }
  });
  return out.join();
})()`), [0, true, 8, false, 7, 0, 0, 0, undefined, 0, false, 0, undefined, ...Array(8).fill('TypeError')].map((x) => (x === undefined ? '' : String(x))).join());
  assert.equal(await val(`(function () {
  var b = new ArrayBuffer(4); new Uint8Array(b)[0] = 9;
  var c = structuredClone({ buf: b, list: [b], m: new Map([[1, new Date(5)]]) }, { transfer: [b] });
  var r = [b.byteLength, c.buf.byteLength, c.list[0] === c.buf, new Uint8Array(c.buf)[0], c.m.get(1).getTime()];
  try { structuredClone(function () {}); } catch (e) { r.push(e.name); }
  try { structuredClone(b); } catch (e) { r.push(e.name); }
  var u = new Uint16Array([1, 2, 3]), k = u.buffer.transferToFixedLength(2);
  r.push(u.length, new Uint16Array(k).length, ArrayBuffer.isView(u), Object.prototype.toString.call(u), u instanceof Uint16Array, u.constructor === Uint16Array);
  var got = null; addEventListener("message", function (e) { got = e.data; });
  var pb = new ArrayBuffer(2); postMessage({ x: pb }, "*", [pb]);
  r.push(pb.byteLength, got && got.x.byteLength);
  return r.join();
})()`), '0,4,true,9,5,DataCloneError,DataCloneError,0,1,true,[object Uint16Array],true,true,0,2');
  // ayrılmamış görünümde normal davranış ve tür denetimleri bozulmaz
  assert.equal(await val('(function(){ var a = new Uint8Array([3, 1, 2]); a.sort(); var m = a.map(function (x) { return x * 2; }); return [a.join(), m.join(), m instanceof Uint8Array, Array.from(a).length, String.fromCharCode.apply(null, new Uint8Array([72, 105]))].join("|"); })()'), '1,2,3|2,4,6|true|3|Hi');
}

console.log('analysis-runtime: ok');
