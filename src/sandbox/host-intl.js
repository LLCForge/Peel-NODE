// E529–E531: QuickJS'te Intl yok. Sandbox'taki Intl nesneleri biçimlendirmeyi host'un (tarayıcıda V8/ICU)
// Intl'ine senkron köprüyle yaptırır; böylece yerel ayar verisi, birim/bilimsel/compact gösterim ve IANA saat
// dilimleri tarayıcıyla birebir aynıdır. Köprüden yalnızca JSON (string/sayı/boolean) geçer.

const CTORS = new Set(['NumberFormat', 'DateTimeFormat', 'PluralRules', 'Collator', 'RelativeTimeFormat', 'ListFormat']);
const METHODS = new Set(['format', 'formatToParts', 'resolvedOptions', 'formatRange', 'formatRangeToParts', 'select', 'selectRange', 'compare']);
const cache = new Map();
const MAX_CACHE = 200;

function plain(v, depth = 0) {
  if (v === null || typeof v === 'boolean' || typeof v === 'number') return v;
  if (typeof v === 'string') return v.slice(0, 200);
  if (Array.isArray(v) && depth < 2) return v.slice(0, 50).map((x) => plain(x, depth + 1));
  if (v && typeof v === 'object' && depth < 2) {
    const o = {};
    for (const [k, x] of Object.entries(v).slice(0, 40)) o[String(k).slice(0, 40)] = plain(x, depth + 1);
    return o;
  }
  return undefined;
}

const arg = (a) => (a && typeof a === 'object' && typeof a.$bigint === 'string' ? BigInt(a.$bigint)
  : a && typeof a === 'object' && typeof a.$num === 'string' ? Number(a.$num) : a);
const out = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? { $bigint: String(x) } : x));

/** İstek: { ctor, locales, options, method, args } ya da { static: 'getCanonicalLocales'|'supportedLocalesOf'|'supportedValuesOf', ... } */
export function hostIntl(json) {
  try {
    const req = JSON.parse(json);
    if (req.static === 'getCanonicalLocales') return out({ ok: true, value: Intl.getCanonicalLocales(plain(req.locales)) });
    if (req.static === 'supportedValuesOf') return out({ ok: true, value: Intl.supportedValuesOf(String(req.key)) });
    if (!CTORS.has(req.ctor)) throw new TypeError('Intl: desteklenmeyen kurucu');
    if (req.static === 'supportedLocalesOf') return out({ ok: true, value: Intl[req.ctor].supportedLocalesOf(plain(req.locales), plain(req.options) ?? undefined) });
    if (!METHODS.has(req.method)) throw new TypeError('Intl: desteklenmeyen yöntem');
    const key = JSON.stringify([req.ctor, req.locales, req.options]);
    let obj = cache.get(key);
    if (!obj) {
      obj = new Intl[req.ctor](plain(req.locales) ?? undefined, plain(req.options) ?? undefined);
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(key, obj);
    }
    if (typeof obj[req.method] !== 'function') throw new TypeError(`Intl.${req.ctor}.prototype.${req.method} is not a function`);
    return out({ ok: true, value: obj[req.method](...(req.args ?? []).map(arg)) });
  } catch (e) {
    return out({ ok: false, name: e?.name ?? 'Error', message: String(e?.message ?? e) });
  }
}

const tzCache = new Map();

/** zone saat diliminde ms anındaki yerel saat − UTC (dakika). Geçersiz dilimde RangeError metni döner. */
export function hostTzOffset(zone, ms) {
  try {
    let f = tzCache.get(zone);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', era: 'short' });
      if (tzCache.size > 50) tzCache.clear();
      tzCache.set(zone, f);
    }
    const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
    const year = p.era === 'BC' || p.era === 'B' ? 1 - Number(p.year) : Number(p.year);
    const d = new Date(0);
    d.setUTCFullYear(year, Number(p.month) - 1, Number(p.day));
    d.setUTCHours(Number(p.hour), Number(p.minute), Number(p.second), 0);
    const floor = ms - (((ms % 1000) + 1000) % 1000);
    return String(Math.round((d.getTime() - floor) / 60000));
  } catch (e) {
    return `!${e?.message ?? e}`;
  }
}

/** Saat diliminin uzun adı (Date.prototype.toString parantez içi, V8 en-US). */
export function hostTzName(zone, ms) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'long' }).formatToParts(ms);
    return p.find((x) => x.type === 'timeZoneName')?.value ?? zone;
  } catch {
    return zone;
  }
}
