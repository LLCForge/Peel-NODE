// Sandbox semantik modelleri (E516–E519, E529–E531, E534, E538–E540). STUBS'tan sonra yüklenir.
// QuickJS'te olmayan ya da host'a bağlı (saat dilimi) davranışlar tarayıcı (V8) semantiğine göre, deterministik kurulur.
// __peelConfig: { tz: dakika (getTimezoneOffset değeri, varsayılan 0) ya da IANA adı, perfStep: ms (varsayılan 1),
//                 locale: varsayılan yerel ayar, eventLoop: true → kuyruk tabanlı olay döngüsü + kayıt (__peelSem) }
export const SEMANTIC_STUBS = `
(function () {
  var cfg = globalThis.__peelConfig || {};
  var semOn = cfg.eventLoop === true;
  var sem = globalThis.__peelSem = [];
  function log(o) { if (semOn && sem.length < 500) sem.push(o); }
  function fname(f) { try { return (f && f.name) || "anonim"; } catch (e) { return "?"; } }

  // ---------------------------------------------------------------- E534 performance.now: monoton, deterministik
  var perfT = 0, perfStep = typeof cfg.perfStep === "number" && cfg.perfStep > 0 ? cfg.perfStep : 1;
  if (globalThis.performance) globalThis.performance.now = function now() { perfT += perfStep; return perfT; };

  // ---------------------------------------------------------------- E529 saat dilimi
  // tz: dakika (getTimezoneOffset değeri, sabit) ya da IANA adı (ör. "Europe/Istanbul"; yaz saati dahil, host Intl verisiyle)
  var TZ_NAME = typeof cfg.tz === "string" && cfg.tz ? cfg.tz : null;
  var TZ_FIXED = typeof cfg.tz === "number" && isFinite(cfg.tz) ? Math.trunc(cfg.tz) : 0;
  if (TZ_NAME !== null && (typeof __peelHostTz !== "function" || String(__peelHostTz(TZ_NAME, "0"))[0] === "!")) TZ_NAME = null;
  function offAt(t) {
    if (TZ_NAME === null || t !== t) return TZ_FIXED;
    return -Number(__peelHostTz(TZ_NAME, String(t)));
  }
  var StubDate = globalThis.Date, NativeDate = Object.getPrototypeOf(StubDate);
  var N = NativeDate.prototype;
  var getTime = function (d) { return N.getTime.call(d); };
  var wall = function (t) { return new NativeDate(t - offAt(t) * 60000); };
  // duvar saati (UTC gibi okunan ms) → gerçek an: dilim kayması iki adımda yakınsar
  function fromWall(w) {
    if (w !== w) return NaN;
    var t = w + offAt(w) * 60000;
    return w + offAt(t) * 60000;
  }
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var pad = function (n, w) { var s = String(Math.abs(n)); while (s.length < (w || 2)) s = "0" + s; return (n < 0 ? "-" : "") + s; };
  function zoneText(t) {
    var off = -offAt(t), sign = off < 0 ? "-" : "+", a = Math.abs(off);
    var name = TZ_NAME !== null ? String(__peelHostTzName(TZ_NAME, String(t)))
      : TZ_FIXED === 0 ? "Coordinated Universal Time" : "GMT" + sign + pad(Math.floor(a / 60)) + ":" + pad(a % 60);
    return "GMT" + sign + pad(Math.floor(a / 60)) + pad(a % 60) + " (" + name + ")";
  }
  // Intl için varsayılan saat dilimi
  function defaultZone() {
    if (TZ_NAME !== null) return TZ_NAME;
    if (TZ_FIXED === 0) return "UTC";
    var off = -TZ_FIXED, a = Math.abs(off);
    return (off < 0 ? "-" : "+") + pad(Math.floor(a / 60)) + ":" + pad(a % 60);
  }
  function yearText(y) { return y < 0 ? "-" + pad(-y, 6) : pad(y, 4); }
  var LOCAL = { FullYear: "getUTCFullYear", Month: "getUTCMonth", Date: "getUTCDate", Day: "getUTCDay", Hours: "getUTCHours",
    Minutes: "getUTCMinutes", Seconds: "getUTCSeconds", Milliseconds: "getUTCMilliseconds" };
  var P = StubDate.prototype;
  Object.keys(LOCAL).forEach(function (k) {
    var utc = N[LOCAL[k]];
    Object.defineProperty(P, "get" + k, { configurable: true, writable: true, value: function () {
      var t = getTime(this); return t !== t ? NaN : utc.call(wall(t));
    } });
  });
  Object.defineProperty(P, "getYear", { configurable: true, writable: true, value: function () { var y = this.getFullYear(); return y !== y ? NaN : y - 1900; } });
  Object.defineProperty(P, "getTimezoneOffset", { configurable: true, writable: true, value: function () { var t = getTime(this); return t !== t ? NaN : offAt(t); } });
  ["FullYear", "Month", "Date", "Hours", "Minutes", "Seconds", "Milliseconds"].forEach(function (k) {
    var setUTC = N["setUTC" + k];
    Object.defineProperty(P, "set" + k, { configurable: true, writable: true, value: function () {
      var t = getTime(this);
      if (t !== t && k !== "FullYear") { N.setTime.call(this, NaN); return NaN; }
      var w = t !== t ? new NativeDate(0) : wall(t);
      var r = setUTC.apply(w, arguments);
      return N.setTime.call(this, fromWall(r));
    } });
  });
  Object.defineProperty(P, "setYear", { configurable: true, writable: true, value: function (y) {
    y = Number(y); if (y === y && y >= 0 && y <= 99) y += 1900; return this.setFullYear(y);
  } });
  function dateText(d) { var w = wall(getTime(d)); return DAYS[N.getUTCDay.call(w)] + " " + MONTHS[N.getUTCMonth.call(w)] + " " + pad(N.getUTCDate.call(w)) + " " + yearText(N.getUTCFullYear.call(w)); }
  function timeText(d) { var t = getTime(d), w = wall(t); return pad(N.getUTCHours.call(w)) + ":" + pad(N.getUTCMinutes.call(w)) + ":" + pad(N.getUTCSeconds.call(w)) + " " + zoneText(t); }
  var invalid = function (d) { var t = getTime(d); return t !== t; };
  Object.defineProperty(P, "toString", { configurable: true, writable: true, value: function toString() { return invalid(this) ? "Invalid Date" : dateText(this) + " " + timeText(this); } });
  Object.defineProperty(P, "toDateString", { configurable: true, writable: true, value: function toDateString() { return invalid(this) ? "Invalid Date" : dateText(this); } });
  Object.defineProperty(P, "toTimeString", { configurable: true, writable: true, value: function toTimeString() { return invalid(this) ? "Invalid Date" : timeText(this); } });

  var EXPLICIT_ZONE = /(Z|[+-]\\d{2}:?\\d{2}|\\b(GMT|UTC|UT)\\b[^)]*)\\s*(\\(.*\\))?\\s*$/i;
  var DATE_ONLY = /^\\s*[+-]?\\d{4,6}(-\\d\\d(-\\d\\d)?)?\\s*$/;
  function parseDate(s) {
    s = String(s);
    var host = NativeDate.parse(s);
    if (host !== host || EXPLICIT_ZONE.test(s) || DATE_ONLY.test(s)) return host;
    // host yerel saatiyle yorumlandı: duvar saatine çevir, modeldeki dilime yerleştir
    var hostOff = N.getTimezoneOffset.call(new NativeDate(host));
    return fromWall(host - hostOff * 60000);
  }
  function D() {
    var a = Array.prototype.slice.call(arguments);
    if (!new.target) return new D().toString();
    if (a.length >= 2) {
      var n = a.map(Number);
      var y = n[0]; if (y === y && Math.trunc(y) >= 0 && Math.trunc(y) <= 99) y = 1900 + Math.trunc(y);
      var u = NativeDate.UTC(y, n[1], n.length > 2 ? n[2] : 1, n.length > 3 ? n[3] : 0, n.length > 4 ? n[4] : 0, n.length > 5 ? n[5] : 0, n.length > 6 ? n[6] : 0);
      a = [fromWall(u)];
    } else if (a.length === 1 && typeof a[0] === "string") a = [parseDate(a[0])];
    return Reflect.construct(StubDate, a, new.target);
  }
  Object.setPrototypeOf(D, StubDate);
  D.prototype = P;
  Object.defineProperty(P, "constructor", { configurable: true, writable: true, value: D });
  Object.defineProperty(D, "parse", { configurable: true, writable: true, value: function parse(s) { return parseDate(s); } });
  Object.defineProperty(D, "length", { value: 7 });
  Object.defineProperty(D, "name", { value: "Date" });
  globalThis.Date = D;

  // ---------------------------------------------------------------- E530/E531 Intl (host Intl'ine senkron köprü)
  function defaultLocale() {
    // navigator izlenen bir Proxy: okumak rapordaki "okunan özellikler"i kirletir, profil yapılandırmasından alınır
    return cfg.locale || (cfg.profile && cfg.profile.navigator && cfg.profile.navigator.language) || "en-US";
  }
  function hostCall(req) {
    var r = JSON.parse(__peelHostIntl(JSON.stringify(req, function (k, v) {
      // JSON NaN/±Infinity/-0/BigInt taşıyamaz
      if (typeof v === "bigint") return { $bigint: String(v) };
      if (typeof v === "number" && (v !== v || v === Infinity || v === -Infinity || (v === 0 && 1 / v < 0))) return { $num: v === 0 ? "-0" : String(v) };
      return v;
    })));
    if (!r.ok) {
      var C = r.name === "RangeError" ? RangeError : r.name === "TypeError" ? TypeError : r.name === "SyntaxError" ? SyntaxError : Error;
      throw new C(r.message);
    }
    log({ k: "intl", api: (req.ctor || "Intl") + "." + (req.method || req.static) });
    return r.value;
  }
  // CanonicalizeLocaleList: geçerlilik denetimi host'ta; undefined → sandbox varsayılanı
  function locList(locales, fallback) {
    if (locales === undefined) return fallback ? [defaultLocale()] : [];
    var o = typeof locales === "string" ? [locales] : Object(locales), n = o.length >>> 0, out = [];
    for (var i = 0; i < n; i++) if (i in o) { var v = o[i]; if (typeof v !== "string" && (v === null || typeof v !== "object")) throw new TypeError("Language ID should be string or object."); out.push(String(v)); }
    // desteklenmeyen yerel ayarda host'un değil sandbox'un varsayılanına düşülsün
    if (fallback && out.indexOf(defaultLocale()) < 0) out.push(defaultLocale());
    return out;
  }
  var OPTS = {
    NumberFormat: ["localeMatcher", "numberingSystem", "style", "currency", "currencyDisplay", "currencySign", "unit", "unitDisplay", "minimumIntegerDigits",
      "minimumFractionDigits", "maximumFractionDigits", "minimumSignificantDigits", "maximumSignificantDigits", "roundingIncrement", "roundingMode",
      "roundingPriority", "trailingZeroDisplay", "notation", "compactDisplay", "useGrouping", "signDisplay"],
    DateTimeFormat: ["localeMatcher", "calendar", "numberingSystem", "hour12", "hourCycle", "timeZone", "weekday", "era", "year", "month", "day",
      "dayPeriod", "hour", "minute", "second", "fractionalSecondDigits", "timeZoneName", "formatMatcher", "dateStyle", "timeStyle"],
    PluralRules: ["localeMatcher", "type", "minimumIntegerDigits", "minimumFractionDigits", "maximumFractionDigits", "minimumSignificantDigits",
      "maximumSignificantDigits", "roundingIncrement", "roundingMode", "roundingPriority", "trailingZeroDisplay"],
    Collator: ["usage", "localeMatcher", "collation", "numeric", "caseFirst", "sensitivity", "ignorePunctuation"],
    RelativeTimeFormat: ["localeMatcher", "numberingSystem", "style", "numeric"],
    ListFormat: ["localeMatcher", "type", "style"],
  };
  function readOpts(name, options) {
    var out = {};
    if (options === undefined) return out;
    if (options === null) throw new TypeError("Cannot convert undefined or null to object");
    var o = Object(options);
    OPTS[name].forEach(function (k) {
      var v = o[k];
      if (v === undefined) return;
      out[k] = typeof v === "boolean" || typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : String(v);
    });
    return out;
  }
  function timeValue(d) {
    if (d === undefined) return D.now();
    if (d !== null && typeof d === "object") { try { return getTime(d); } catch (e) { /* Date değil */ } }
    return Number(d);
  }
  var CONV = {
    NumberFormat: function (m, a) { return a.map(function (x) { return typeof x === "bigint" || typeof x === "string" ? x : Number(x); }); },
    DateTimeFormat: function (m, a) { return a.map(timeValue); },
    PluralRules: function (m, a) { return a.map(Number); },
    Collator: function (m, a) { return a.slice(0, 2).map(String); },
    RelativeTimeFormat: function (m, a) { return [Number(a[0]), String(a[1])]; },
    ListFormat: function (m, a) { var list = []; for (var x of a[0] === undefined ? [] : a[0]) { if (typeof x !== "string") throw new TypeError("Iterable yielded " + String(x) + " which is not a string"); list.push(x); } return [list]; },
  };
  var METHODS = {
    NumberFormat: ["formatToParts", "formatRange", "formatRangeToParts", "resolvedOptions"],
    DateTimeFormat: ["formatToParts", "formatRange", "formatRangeToParts", "resolvedOptions"],
    PluralRules: ["select", "selectRange", "resolvedOptions"],
    Collator: ["resolvedOptions"],
    RelativeTimeFormat: ["format", "formatToParts", "resolvedOptions"],
    ListFormat: ["format", "formatToParts", "resolvedOptions"],
  };
  var BOUND = { NumberFormat: "format", DateTimeFormat: "format", Collator: "compare" };
  var CALLABLE = { NumberFormat: true, DateTimeFormat: true, Collator: true };
  function intlCtor(name) {
    var C = function () {
      var locales = arguments[0], options = arguments[1];
      if (!new.target) {
        if (!CALLABLE[name]) throw new TypeError("Constructor Intl." + name + " requires 'new'");
        return new C(locales, options);
      }
      var o = readOpts(name, options);
      if (name === "DateTimeFormat" && o.timeZone === undefined) o.timeZone = defaultZone();
      var loc = locList(locales, true);
      hostCall({ ctor: name, locales: loc, options: o, method: "resolvedOptions", args: [] });
      Object.defineProperty(this, "__intl", { value: { loc: loc, opt: o } });
    };
    Object.defineProperty(C, "name", { value: name });
    var state = function (self, m) {
      var s = self !== null && typeof self === "object" ? self.__intl : undefined;
      if (!s) throw new TypeError("Method Intl." + name + ".prototype." + m + " called on incompatible receiver");
      return s;
    };
    var call = function (self, m, args) {
      var s = state(self, m);
      return hostCall({ ctor: name, locales: s.loc, options: s.opt, method: m, args: CONV[name](m, args) });
    };
    METHODS[name].forEach(function (m) {
      Object.defineProperty(C.prototype, m, { configurable: true, writable: true, value: function () { return call(this, m, Array.prototype.slice.call(arguments)); } });
    });
    if (BOUND[name]) {
      Object.defineProperty(C.prototype, BOUND[name], { configurable: true, get: function () {
        var self = this; state(self, BOUND[name]);
        return function () { return call(self, BOUND[name], Array.prototype.slice.call(arguments)); };
      } });
    }
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: "Intl." + name, configurable: true });
    C.supportedLocalesOf = function supportedLocalesOf(l, o) { return hostCall({ static: "supportedLocalesOf", ctor: name, locales: locList(l, false), options: o === undefined ? undefined : { localeMatcher: Object(o).localeMatcher === undefined ? undefined : String(Object(o).localeMatcher) } }); };
    return C;
  }
  if (!globalThis.Intl && typeof __peelHostIntl === "function") {
    var Intl = {};
    Object.defineProperty(Intl, Symbol.toStringTag, { value: "Intl", configurable: true });
    Object.keys(OPTS).forEach(function (n) { Intl[n] = intlCtor(n); });
    Intl.getCanonicalLocales = function getCanonicalLocales(l) { return hostCall({ static: "getCanonicalLocales", locales: locList(l, false) }); };
    Intl.supportedValuesOf = function supportedValuesOf(key) { return hostCall({ static: "supportedValuesOf", key: String(key) }); };
    globalThis.Intl = Intl;
  }
  var NumberFormat = globalThis.Intl.NumberFormat, DateTimeFormat = globalThis.Intl.DateTimeFormat;

  // ---------------------------------------------------------------- E530 toLocaleString (Intl üzerinden, V8 ile aynı varsayılanlar)
  Number.prototype.toLocaleString = function toLocaleString(l, o) {
    var v = Number.prototype.valueOf.call(this);
    return new NumberFormat(l, o).format(v);
  };
  if (typeof BigInt === "function") BigInt.prototype.toLocaleString = function toLocaleString(l, o) { return new NumberFormat(l, o).format(BigInt.prototype.valueOf.call(this)); };
  Array.prototype.toLocaleString = function toLocaleString(l, o) {
    var a = Object(this), n = a.length >>> 0, out = [];
    for (var i = 0; i < n; i++) { var e = a[i]; out.push(e === undefined || e === null ? "" : String(e.toLocaleString(l, o))); }
    return out.join(",");
  };
  String.prototype.localeCompare = function localeCompare(that, l, o) {
    if (this === null || this === undefined) throw new TypeError("String.prototype.localeCompare called on null or undefined");
    return new globalThis.Intl.Collator(l, o).compare(String(this), String(that));
  };
  // ToDateTimeOptions (ECMA-402): istenen alan yoksa varsayılan alanlar eklenir
  function toDTO(options, required, defaults) {
    var o = readOpts("DateTimeFormat", options), need = true;
    if ((required === "date" || required === "any") && ["weekday", "year", "month", "day"].some(function (k) { return o[k] !== undefined; })) need = false;
    if ((required === "time" || required === "any") && ["dayPeriod", "hour", "minute", "second", "fractionalSecondDigits"].some(function (k) { return o[k] !== undefined; })) need = false;
    if (o.dateStyle !== undefined || o.timeStyle !== undefined) need = false;
    if (required === "date" && o.timeStyle !== undefined) throw new TypeError("Invalid option : timeStyle");
    if (required === "time" && o.dateStyle !== undefined) throw new TypeError("Invalid option : dateStyle");
    if (need && (defaults === "date" || defaults === "all")) { o.year = "numeric"; o.month = "numeric"; o.day = "numeric"; }
    if (need && (defaults === "time" || defaults === "all")) { o.hour = "numeric"; o.minute = "numeric"; o.second = "numeric"; }
    return o;
  }
  function dateLocale(d, l, o, required, defaults) {
    var t = getTime(d);
    if (t !== t) return "Invalid Date";
    return new DateTimeFormat(l, toDTO(o, required, defaults)).format(t);
  }
  Object.defineProperty(P, "toLocaleString", { configurable: true, writable: true, value: function toLocaleString(l, o) { return dateLocale(this, l, o, "any", "all"); } });
  Object.defineProperty(P, "toLocaleDateString", { configurable: true, writable: true, value: function toLocaleDateString(l, o) { return dateLocale(this, l, o, "date", "date"); } });
  Object.defineProperty(P, "toLocaleTimeString", { configurable: true, writable: true, value: function toLocaleTimeString(l, o) { return dateLocale(this, l, o, "time", "time"); } });

  // ---------------------------------------------------------------- E519 Error.captureStackTrace / stackTraceLimit (V8)
  var RealError = Error;
  if (!("stackTraceLimit" in RealError)) RealError.stackTraceLimit = 10;
  function frames(skipName) {
    var raw = String(new RealError().stack || "").split("\\n").filter(function (l) { return /^\\s*at /.test(l); });
    raw = raw.filter(function (l) { return !/at (captureStackTrace|__peel\\w*|frames|v8Stack) |\\(native\\)/.test(l); });
    if (skipName) {
      var i = raw.findIndex(function (l) { return l.indexOf("at " + skipName + " ") >= 0; });
      if (i >= 0) raw = raw.slice(i + 1);
    }
    var lim = RealError.stackTraceLimit;
    if (typeof lim !== "number") return null;
    return raw.slice(0, Math.max(0, lim));
  }
  function header(e) {
    var n = e.name === undefined ? "Error" : String(e.name), m = e.message === undefined ? "" : String(e.message);
    return n && m ? n + ": " + m : n || m;
  }
  Object.defineProperty(RealError, "captureStackTrace", { configurable: true, writable: true, value: function captureStackTrace(obj, ctor) {
    if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) throw new TypeError("Invalid argument");
    var f = frames(typeof ctor === "function" ? ctor.name : null);
    if (f === null) return undefined;
    var text = header(obj) + (f.length ? "\\n" + f.join("\\n") : "");
    log({ k: "stack", api: "captureStackTrace", frames: f.length });
    Object.defineProperty(obj, "stack", { configurable: true, writable: true, enumerable: false, value: text });
    return undefined;
  } });
  // E518: analiz çalıştırmasında hataların stack'i V8 biçimine (başlık satırı + stackTraceLimit) getirilir ve okumaları kaydedilir.
  // Kurucuyla yaratılanlar kurulurken; motorun fırlattıkları programa ulaştıkları yerde (catch, ret işleyicisi) __peelV8Err ile.
  // QuickJS'in stack özelliği yazılabilir ve yapılandırılabilir bir veri özelliğidir: yerinde yeniden tanımlanır.
  var v8Done = new WeakSet();
  function v8Format(e) {
    if (!semOn || e === null || typeof e !== "object" || v8Done.has(e)) return e;
    var d = Object.getOwnPropertyDescriptor(e, "stack");
    if (!d || typeof d.value !== "string" || !d.configurable) return e;
    v8Done.add(e);
    var lim = RealError.stackTraceLimit;
    var f = d.value.split("\\n").filter(function (l) { return /^\\s*at /.test(l) && !/__peel|\\(native\\)/.test(l); });
    var text = typeof lim === "number" ? header(e) + (f.length && lim > 0 ? "\\n" + f.slice(0, lim).join("\\n") : "") : undefined;
    Object.defineProperty(e, "stack", { configurable: true, enumerable: false, get: function () { log({ k: "stack", api: String(e.name) + ".stack" }); return text; }, set: function (v) { text = v; } });
    return e;
  }
  globalThis.__peelV8Err = v8Format;
  if (semOn) {
    ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError"].forEach(function (name) {
      var C = globalThis[name];
      globalThis[name] = new Proxy(C, {
        construct: function __peelErrConstruct(tg, args, nt) { return v8Format(Reflect.construct(tg, args, nt)); },
        apply: function __peelErrApply(tg, self, args) { return v8Format(Reflect.construct(tg, args)); },
      });
    });
  }

  // ---------------------------------------------------------------- E538 ArrayBuffer ayırma (transfer, structuredClone, postMessage)
  // QuickJS'te ayırma ve yeniden boyutlandırılabilir tampon yok. Ayrılmış tamponlar bir kümede tutulur; ArrayBuffer/DataView/
  // TypedArray yöntem ve getter'ları bunu denetler, TypedArray örnekleri indeks erişimi için Proxy ile sarılır (V8: uzunluk 0,
  // indeks okuma undefined, yazma yok sayılır, yöntemler TypeError).
  var NAB = ArrayBuffer, ABP = NAB.prototype, NU8 = Uint8Array;
  var DET = new WeakSet();
  var SAB = typeof SharedArrayBuffer === "function" ? SharedArrayBuffer : null;
  var abLen = Object.getOwnPropertyDescriptor(ABP, "byteLength").get, abSlice = ABP.slice;
  var TA = Object.getPrototypeOf(Int8Array), TAP = TA.prototype;
  var taBuf = Object.getOwnPropertyDescriptor(TAP, "buffer").get;
  var rawOf = new WeakMap(), proxyOf = new WeakMap();
  var inNative = 0;
  var isNumKey = function (k) { return typeof k === "string" && (k === "-0" || String(Number(k)) === k); };
  var unwrap = function (x) { return x !== null && typeof x === "object" && rawOf.has(x) ? rawOf.get(x) : x; };
  var isTA = function (x) { try { taBuf.call(x); return true; } catch (e) { return false; } };
  var detachedErr = function (what) { return new TypeError("Cannot perform " + what + " on a detached ArrayBuffer"); };
  function wrapView(v) {
    if (proxyOf.has(v)) return proxyOf.get(v);
    var buf = taBuf.call(v);
    if (SAB && buf instanceof SAB) return v; // paylaşılan bellek aktarılamaz: sarmaya gerek yok
    var p = new Proxy(v, {
      get: function (t, k) { return DET.has(buf) && isNumKey(k) ? undefined : Reflect.get(t, k, t); },
      set: function (t, k, val) { if (DET.has(buf) && isNumKey(k)) return true; return Reflect.set(t, k, val, t); },
      has: function (t, k) { return DET.has(buf) && isNumKey(k) ? false : Reflect.has(t, k); },
      ownKeys: function (t) { var ks = Reflect.ownKeys(t); return DET.has(buf) ? ks.filter(function (k) { return !isNumKey(k); }) : ks; },
      getOwnPropertyDescriptor: function (t, k) { return DET.has(buf) && isNumKey(k) ? undefined : Reflect.getOwnPropertyDescriptor(t, k); },
      defineProperty: function (t, k, d) { return DET.has(buf) && isNumKey(k) ? false : Reflect.defineProperty(t, k, d); },
    });
    rawOf.set(p, v);
    proxyOf.set(v, p);
    return p;
  }
  var wrapResult = function (r) { return r !== null && typeof r === "object" && !rawOf.has(r) && isTA(r) ? wrapView(r) : r; };
  function guardIter(it, buf, name) {
    var w = Object.create(Object.getPrototypeOf(it));
    Object.defineProperty(w, "next", { configurable: true, writable: true, value: function next() { if (DET.has(buf)) throw detachedErr("%TypedArray%.prototype." + name); return it.next(); } });
    return w;
  }
  Reflect.ownKeys(TAP).forEach(function (k) {
    if (k === "constructor") return;
    var d = Object.getOwnPropertyDescriptor(TAP, k), label = "%TypedArray%.prototype." + String(k);
    if (typeof d.value === "function") {
      var nat = d.value, iter = k === "values" || k === "keys" || k === "entries" || k === Symbol.iterator;
      var f = function () {
        var self = unwrap(this);
        var buf = isTA(self) ? taBuf.call(self) : null;
        if (buf && DET.has(buf)) throw detachedErr(label);
        var args = Array.prototype.map.call(arguments, unwrap);
        inNative++;
        var r;
        try { r = nat.apply(self, args); } finally { inNative--; }
        return iter && buf ? guardIter(r, buf, String(k)) : wrapResult(r);
      };
      Object.defineProperty(f, "name", { value: nat.name });
      Object.defineProperty(f, "length", { value: nat.length });
      Object.defineProperty(TAP, k, { configurable: true, writable: true, enumerable: false, value: f });
    } else if (d.get) {
      var g = d.get, zero = k === "length" || k === "byteLength" || k === "byteOffset";
      Object.defineProperty(TAP, k, { configurable: true, enumerable: false, get: function () {
        var self = unwrap(this);
        if (zero && isTA(self) && DET.has(taBuf.call(self))) return 0;
        return g.call(self);
      } });
    }
  });
  ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
    "BigInt64Array", "BigUint64Array"].forEach(function (name) {
    var C = globalThis[name];
    if (typeof C !== "function") return;
    var W = new Proxy(C, {
      construct: function (tg, args, nt) {
        args = Array.prototype.map.call(args, unwrap);
        if (args[0] instanceof NAB && DET.has(args[0])) throw detachedErr("Construct");
        if (isTA(args[0]) && DET.has(taBuf.call(args[0]))) throw detachedErr("Construct");
        var v = Reflect.construct(tg, args, nt === W ? tg : nt);
        return inNative ? v : wrapView(v);
      },
    });
    Object.defineProperty(C.prototype, "constructor", { configurable: true, writable: true, enumerable: false, value: W });
    globalThis[name] = W;
  });
  var isView = NAB.isView;
  NAB.isView = function isView2(x) { return isView(unwrap(x)); };
  Object.defineProperty(NAB.isView, "name", { value: "isView" });
  Object.defineProperty(ABP, "byteLength", { configurable: true, get: function () { return DET.has(this) ? 0 : abLen.call(this); } });
  Object.defineProperty(ABP, "detached", { configurable: true, get: function () { abLen.call(this); return DET.has(this); } });
  Object.defineProperty(ABP, "resizable", { configurable: true, get: function () { abLen.call(this); return false; } });
  Object.defineProperty(ABP, "maxByteLength", { configurable: true, get: function () { return DET.has(this) ? 0 : abLen.call(this); } });
  Object.defineProperty(ABP, "slice", { configurable: true, writable: true, value: function slice(a, b) {
    if (DET.has(this)) throw detachedErr("ArrayBuffer.prototype.slice");
    return abSlice.call(this, a, b);
  } });
  Object.defineProperty(ABP, "resize", { configurable: true, writable: true, value: function resize() {
    throw new TypeError("Method ArrayBuffer.prototype.resize called on incompatible receiver #<ArrayBuffer>");
  } });
  function toIndex(v) {
    if (v === undefined) return 0;
    var n = Math.trunc(Number(v)) || 0;
    if (n < 0 || n > 9007199254740991) throw new RangeError("Invalid array buffer length");
    return n;
  }
  function moveBuffer(buf, len) {
    var nb = new NAB(len);
    new NU8(nb).set(new NU8(buf, 0, Math.min(len, abLen.call(buf))));
    DET.add(buf);
    return nb;
  }
  ["transfer", "transferToFixedLength"].forEach(function (name) {
    Object.defineProperty(ABP, name, { configurable: true, writable: true, value: function (newLength) {
      abLen.call(this);
      if (SAB && this instanceof SAB) throw new TypeError("Method ArrayBuffer.prototype." + name + " called on incompatible receiver");
      var len = newLength === undefined ? abLen.call(this) : toIndex(newLength);
      if (DET.has(this)) throw detachedErr("ArrayBuffer.prototype." + name);
      log({ k: "detach", api: name });
      return moveBuffer(this, len);
    } });
  });
  var NDV = DataView, DVP = NDV.prototype;
  var dvBuf = Object.getOwnPropertyDescriptor(DVP, "buffer").get;
  Object.getOwnPropertyNames(DVP).forEach(function (k) {
    if (k === "constructor" || k === "buffer") return;
    var d = Object.getOwnPropertyDescriptor(DVP, k);
    if (typeof d.value === "function") {
      var nat = d.value;
      var f = function () { if (DET.has(dvBuf.call(this))) throw detachedErr("DataView.prototype." + k); return nat.apply(this, arguments); };
      Object.defineProperty(f, "name", { value: nat.name });
      Object.defineProperty(f, "length", { value: nat.length });
      Object.defineProperty(DVP, k, { configurable: true, writable: true, enumerable: false, value: f });
    } else if (d.get) {
      var g = d.get;
      Object.defineProperty(DVP, k, { configurable: true, enumerable: false, get: function () { if (DET.has(dvBuf.call(this))) throw detachedErr("DataView.prototype." + k); return g.call(this); } });
    }
  });
  var DVW = new Proxy(NDV, { construct: function (tg, args, nt) {
    if (args[0] instanceof NAB && DET.has(args[0])) throw detachedErr("DataView");
    return Reflect.construct(tg, args, nt === DVW ? tg : nt);
  } });
  Object.defineProperty(DVP, "constructor", { configurable: true, writable: true, enumerable: false, value: DVW });
  globalThis.DataView = DVW;

  // yapılandırılmış klonlama (HTML): döngüler, Map/Set/Date/RegExp/hatalar/tamponlar; aktarılan tamponlar ayrılır
  if (typeof globalThis.DOMException !== "function") {
    globalThis.DOMException = class DOMException extends Error {
      constructor(message, name) { super(message === undefined ? "" : String(message)); Object.defineProperty(this, "name", { value: name === undefined ? "Error" : String(name), configurable: true, writable: true }); }
      get code() { return { DataCloneError: 25, InvalidStateError: 11, NotSupportedError: 9 }[this.name] || 0; }
    };
  }
  var cloneErr = function (m) { return new globalThis.DOMException(m, "DataCloneError"); };
  var ERRORS = ["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError"];
  function structuredCloneImpl(value, transfer) {
    var list = [];
    if (transfer !== undefined && transfer !== null) for (var x of transfer) list.push(x);
    var memo = new Map();
    list.forEach(function (b, i) {
      if (!(b instanceof NAB) || (SAB && b instanceof SAB)) throw cloneErr("Value at index " + i + " does not have a transferable type.");
      if (list.indexOf(b) !== i) throw cloneErr("ArrayBuffer at index " + i + " is a duplicate of an earlier ArrayBuffer.");
      if (DET.has(b)) throw cloneErr("An ArrayBuffer is detached and could not be cloned.");
    });
    function walk(v) {
      if (typeof v === "symbol") throw cloneErr(String(v) + " could not be cloned.");
      if (typeof v === "function") throw cloneErr((v.toString ? Function.prototype.toString.call(v) : "function") + " could not be cloned.");
      if (v === null || typeof v !== "object") return v;
      if (memo.has(v)) return memo.get(v);
      var raw = unwrap(v), tag = Object.prototype.toString.call(raw).slice(8, -1), out;
      if (raw instanceof NAB) {
        if (SAB && raw instanceof SAB) { memo.set(v, raw); return raw; }
        if (DET.has(raw)) throw cloneErr("An ArrayBuffer is detached and could not be cloned.");
        out = list.indexOf(raw) >= 0 ? new NAB(abLen.call(raw)) : abSlice.call(raw, 0);
        if (list.indexOf(raw) >= 0) new NU8(out).set(new NU8(raw));
        memo.set(v, out); return out;
      }
      if (isTA(raw)) {
        var b = walk(taBuf.call(raw));
        out = new globalThis[tag](b, Object.getOwnPropertyDescriptor(TAP, "byteOffset").get.call(raw), Object.getOwnPropertyDescriptor(TAP, "length").get.call(raw));
        memo.set(v, out); return out;
      }
      if (raw instanceof NDV) { out = new globalThis.DataView(walk(dvBuf.call(raw)), raw.byteOffset, raw.byteLength); memo.set(v, out); return out; }
      // tür iç yuvaya göre (Symbol.toStringTag'e değil) belirlenir
      var brand = function (fn) { try { fn.call(v); return true; } catch (e) { return false; } };
      if (Array.isArray(v)) tag = "Array";
      else if (brand(N.getTime)) tag = "Date";
      else if (brand(Map.prototype.has)) tag = "Map";
      else if (brand(Set.prototype.has)) tag = "Set";
      else if (brand(Object.getOwnPropertyDescriptor(RegExp.prototype, "source").get) && v !== RegExp.prototype) tag = "RegExp";
      else if (brand(Boolean.prototype.valueOf)) tag = "Boolean";
      else if (brand(Number.prototype.valueOf)) tag = "Number";
      else if (brand(String.prototype.valueOf)) tag = "String";
      else if (typeof BigInt === "function" && brand(BigInt.prototype.valueOf)) tag = "BigInt";
      else if (tag !== "Error" && (v instanceof Promise ||brand(WeakMap.prototype.has) || brand(WeakSet.prototype.has))) tag = "Uncloneable";
      else if (tag !== "Error") tag = "Object";
      switch (tag) {
        case "Boolean": out = Object(Boolean.prototype.valueOf.call(v)); break;
        case "Number": out = Object(Number.prototype.valueOf.call(v)); break;
        case "String": out = Object(String.prototype.valueOf.call(v)); break;
        case "BigInt": out = Object(BigInt.prototype.valueOf.call(v)); break;
        case "Date": out = new globalThis.Date(getTime(v)); break;
        case "RegExp": out = new RegExp(v.source, v.flags); break;
        case "Map": out = new Map(); memo.set(v, out); Array.from(Map.prototype.entries.call(v)).forEach(function (e) { out.set(walk(e[0]), walk(e[1])); }); return out;
        case "Set": out = new Set(); memo.set(v, out); Array.from(Set.prototype.values.call(v)).forEach(function (e) { out.add(walk(e)); }); return out;
        case "Error": {
          var nm = ERRORS.indexOf(v.name) >= 0 ? v.name : "Error";
          out = new globalThis[nm](v.message === undefined ? undefined : String(v.message));
          if (typeof v.stack === "string") Object.defineProperty(out, "stack", { value: v.stack, configurable: true, writable: true });
          memo.set(v, out); return out;
        }
        case "Array": out = new Array(v.length); memo.set(v, out); Object.keys(v).forEach(function (k) { out[k] = walk(v[k]); }); return out;
        case "Object": case "Arguments": out = {}; memo.set(v, out); Object.keys(v).forEach(function (k) { out[k] = walk(v[k]); }); return out;
        default: throw cloneErr("#<" + tag + "> could not be cloned.");
      }
      memo.set(v, out);
      return out;
    }
    var result = walk(value);
    list.forEach(function (b) { if (!memo.has(b)) memo.set(b, moveBuffer(b, abLen.call(b))); else DET.add(b); });
    if (list.length) log({ k: "detach", api: "structuredClone", count: list.length });
    return result;
  }
  globalThis.structuredClone = function structuredClone(value, options) {
    if (arguments.length === 0) throw new TypeError("Failed to execute 'structuredClone' on 'Window': 1 argument required, but only 0 present.");
    var transfer = options !== undefined && options !== null ? Object(options).transfer : undefined;
    return structuredCloneImpl(value, transfer);
  };
  function messageArgs(a, b) {
    // postMessage(msg, transfer) ya da postMessage(msg, { transfer })
    if (Array.isArray(b) || (b && typeof b === "object" && typeof b[Symbol.iterator] === "function" && !("transfer" in Object(b)))) return b;
    return b && typeof b === "object" ? b.transfer : undefined;
  }
  function deliver(target, data) {
    var ev = { type: "message", data: data, origin: "https://example.com", source: null, ports: [] };
    var fire = function () {
      if (typeof target.onmessage === "function") try { target.onmessage(ev); } catch (e) {}
      (globalThis.__peelHandlers || []).forEach(function (h) { if (h.target === target && h.type === "message") try { h.fn.call(target, ev); } catch (e) {} });
    };
    globalThis.setTimeout(fire, 0);
  }
  // window.postMessage(msg, targetOrigin, transfer) ya da (msg, { targetOrigin, transfer })
  globalThis.postMessage = function postMessage(message, a, b) {
    var transfer = typeof a === "string" ? b : messageArgs(message, a);
    deliver(globalThis, structuredCloneImpl(message, transfer));
  };
  if (typeof globalThis.Worker === "function") {
    globalThis.Worker.prototype.postMessage = function postMessage(message, a) { structuredCloneImpl(message, messageArgs(message, a)); };
    globalThis.Worker.prototype.terminate = function terminate() {};
  }
  if (typeof globalThis.MessageChannel !== "function") {
    var MessagePort = function MessagePort() { this.onmessage = null; this.__other = null; };
    MessagePort.prototype.postMessage = function postMessage(message, a) { var d = structuredCloneImpl(message, messageArgs(message, a)); if (this.__other) deliver(this.__other, d); };
    MessagePort.prototype.addEventListener = function (type, fn) { if (globalThis.__peelOn) __peelOn(this, type, fn); };
    MessagePort.prototype.removeEventListener = function () {};
    MessagePort.prototype.start = function () {};
    MessagePort.prototype.close = function () { this.__other = null; };
    globalThis.MessagePort = MessagePort;
    globalThis.MessageChannel = function MessageChannel() {
      if (!new.target) throw new TypeError("Failed to construct 'MessageChannel': Please use the 'new' operator");
      this.port1 = new MessagePort(); this.port2 = new MessagePort();
      this.port1.__other = this.port2; this.port2.__other = this.port1;
    };
  }

  // ---------------------------------------------------------------- E539 Atomics (tek ajan, ana iş parçacığı)
  if (typeof globalThis.Atomics === "undefined") {
    var INT_TYPES = ["Int8Array", "Uint8Array", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "BigInt64Array", "BigUint64Array"];
    var waiters = [];
    function check(ta, waitable) {
      var tag = ta && Object.prototype.toString.call(ta).slice(8, -1);
      if (!ta || INT_TYPES.indexOf(tag) < 0 || (waitable && tag !== "Int32Array" && tag !== "BigInt64Array")) throw new TypeError("[object Array] is not an integer shared typed array.");
      return tag.indexOf("Big") === 0;
    }
    function idx(ta, i) {
      var n = i === undefined ? 0 : Number(i);
      n = n !== n ? 0 : Math.trunc(n);
      if (n < 0 || n >= ta.length) throw new RangeError("Invalid atomic access index");
      return n;
    }
    function val(big, v) { return big ? BigInt(v) : (function (n) { n = Number(n); return n !== n ? 0 : Math.trunc(n); })(v); }
    function rmw(op) {
      return function (ta, i, v) {
        var big = check(ta), k = idx(ta, i), x = val(big, v), old = ta[k];
        ta[k] = op(old, x);
        log({ k: "atomics", op: op.name || "rmw" });
        return old;
      };
    }
    var A = {
      add: rmw(function add(a, b) { return a + b; }), sub: rmw(function sub(a, b) { return a - b; }),
      and: rmw(function and(a, b) { return a & b; }), or: rmw(function or(a, b) { return a | b; }), xor: rmw(function xor(a, b) { return a ^ b; }),
      exchange: rmw(function exchange(a, b) { return b; }),
      compareExchange: function compareExchange(ta, i, expected, replacement) {
        var big = check(ta), k = idx(ta, i), e = val(big, expected), r = val(big, replacement), old = ta[k];
        // karşılaştırma dizinin eleman türüne dönüştürülmüş değerle yapılır
        var tmp = new ta.constructor(1); tmp[0] = e;
        if (old === tmp[0]) ta[k] = r;
        return old;
      },
      load: function load(ta, i) { check(ta); return ta[idx(ta, i)]; },
      store: function store(ta, i, v) { var big = check(ta), k = idx(ta, i), x = val(big, v); ta[k] = x; return Object.is(x, -0) ? 0 : x; },
      isLockFree: function isLockFree(n) { n = Number(n); return n === 1 || n === 2 || n === 4 || n === 8; },
      wait: function wait(ta, i, v) {
        check(ta, true); idx(ta, i);
        throw new TypeError("Atomics.wait cannot be called in this context");
      },
      waitAsync: function waitAsync(ta, i, v, timeout) {
        var big = check(ta, true), k = idx(ta, i), x = val(big, v);
        var t = timeout === undefined ? Infinity : Number(timeout);
        if (ta[k] !== x) return { async: false, value: "not-equal" };
        if (t <= 0) return { async: false, value: "timed-out" };
        var w = { ta: ta, k: k };
        var p = new Promise(function (res) { w.res = res; });
        waiters.push(w);
        if (t !== Infinity && typeof setTimeout === "function") setTimeout(function () { var j = waiters.indexOf(w); if (j >= 0) { waiters.splice(j, 1); w.res("timed-out"); } }, t);
        return { async: true, value: p };
      },
      notify: function notify(ta, i, count) {
        check(ta, true); var k = idx(ta, i);
        var c = count === undefined ? Infinity : Math.max(0, Math.trunc(Number(count)) || 0), n = 0;
        for (var j = 0; j < waiters.length && n < c;) {
          if (waiters[j].ta.buffer === ta.buffer && waiters[j].k === k) { waiters.splice(j, 1)[0].res("ok"); n++; } else j++;
        }
        return n;
      },
      pause: function pause() {},
    };
    Object.defineProperty(A, Symbol.toStringTag, { value: "Atomics", configurable: true });
    globalThis.Atomics = A;
  }

  // ---------------------------------------------------------------- E540 WeakRef / FinalizationRegistry (hiç toplanmayan çalıştırma: spec'e uygun)
  function canBeHeld(v) { return (v !== null && (typeof v === "object" || typeof v === "function")) || (typeof v === "symbol" && Symbol.keyFor(v) === undefined); }
  if (typeof globalThis.WeakRef === "undefined") {
    var WeakRef = function WeakRef(target) {
      if (!new.target) throw new TypeError("Constructor WeakRef requires 'new'");
      if (!canBeHeld(target)) throw new TypeError("WeakRef: target must be an object");
      Object.defineProperty(this, "__t", { value: target });
      log({ k: "weak", api: "WeakRef" });
    };
    WeakRef.prototype.deref = function deref() { return this.__t; };
    Object.defineProperty(WeakRef.prototype, Symbol.toStringTag, { value: "WeakRef", configurable: true });
    globalThis.WeakRef = WeakRef;
  }
  if (typeof globalThis.FinalizationRegistry === "undefined") {
    var FR = function FinalizationRegistry(cb) {
      if (!new.target) throw new TypeError("Constructor FinalizationRegistry requires 'new'");
      if (typeof cb !== "function") throw new TypeError("FinalizationRegistry: cleanup must be callable");
      Object.defineProperty(this, "__cells", { value: [] });
      log({ k: "weak", api: "FinalizationRegistry" });
    };
    FR.prototype.register = function register(target, held, token) {
      if (!canBeHeld(target)) throw new TypeError("FinalizationRegistry.prototype.register: invalid target");
      if (target === held) throw new TypeError("FinalizationRegistry.prototype.register: target and holdings must not be same");
      if (token !== undefined && !canBeHeld(token)) throw new TypeError("FinalizationRegistry.prototype.register: invalid unregister token");
      this.__cells.push({ token: token });
      return undefined;
    };
    FR.prototype.unregister = function unregister(token) {
      if (!canBeHeld(token)) throw new TypeError("Invalid unregisterToken");
      var before = this.__cells.length;
      for (var i = this.__cells.length - 1; i >= 0; i--) if (this.__cells[i].token === token) this.__cells.splice(i, 1);
      return this.__cells.length !== before;
    };
    Object.defineProperty(FR.prototype, Symbol.toStringTag, { value: "FinalizationRegistry", configurable: true });
    globalThis.FinalizationRegistry = FR;
  }

  // ---------------------------------------------------------------- E516 queueMicrotask
  if (typeof globalThis.queueMicrotask !== "function") {
    // yerel then/resolve: analizdeki then kaydına ayrı bir mikro görev olarak düşmesin
    var qmThen = Promise.prototype.then, qmP = Promise;
    globalThis.queueMicrotask = function queueMicrotask(cb) {
      if (typeof cb !== "function") throw new TypeError("Failed to execute 'queueMicrotask': The callback provided as parameter 1 is not a function.");
      qmThen.call(qmP.resolve(), function () {
        log({ k: "micro", api: "queueMicrotask", fn: fname(cb) });
        try { cb(); } catch (e) { log({ k: "error", where: "queueMicrotask", message: String(e && e.message) }); }
      });
    };
  }

  // modelin eklediği global'ler (Intl, Atomics, WeakRef...) programın eklediği global'ler gibi raporlanmasın
  globalThis.__peelBaseGlobals = Object.getOwnPropertyNames(globalThis);
  if (!semOn) return;

  // ---------------------------------------------------------------- E516 olay döngüsü modeli (yalnızca analiz)
  var tasks = [], taskSeq = 0, virtualNow = 0;
  function schedule(kind, fn, ms, args, repeat) {
    if (typeof fn !== "function") { var src = String(fn); fn = function () { (0, eval)(src); }; }
    var id = ++taskSeq;
    var delay = Math.max(0, Number(ms) || 0);
    tasks.push({ id: id, kind: kind, fn: fn, args: args, at: virtualNow + delay, delay: delay, repeat: repeat, runs: 0 });
    return id;
  }
  globalThis.setTimeout = function setTimeout(fn, ms) { return schedule("setTimeout", fn, ms, Array.prototype.slice.call(arguments, 2), false); };
  globalThis.setInterval = function setInterval(fn, ms) { return schedule("setInterval", fn, ms, Array.prototype.slice.call(arguments, 2), true); };
  globalThis.clearTimeout = globalThis.clearInterval = function clearTimeout(id) { tasks = tasks.filter(function (t) { return t.id !== id; }); };
  globalThis.requestAnimationFrame = function requestAnimationFrame(fn) { return schedule("requestAnimationFrame", fn, 16, [0], false); };
  globalThis.__peelTick = function () {
    if (!tasks.length) return false;
    tasks.sort(function (a, b) { return a.at - b.at || a.id - b.id; });
    var t = tasks.shift();
    virtualNow = Math.max(virtualNow, t.at);
    log({ k: "macro", api: t.kind, fn: fname(t.fn), at: virtualNow });
    try { t.fn.apply(globalThis, t.args); } catch (e) { log({ k: "error", where: t.kind, message: String(e && e.message) }); }
    // setInterval en fazla 3 kez: sonsuz döngü modelde kesilir
    if (t.repeat && ++t.runs < 3) { t.at = virtualNow + Math.max(1, t.delay); tasks.push(t); }
    return true;
  };

  // ---------------------------------------------------------------- E516/E517 söz izleme
  var NativePromise = Promise;
  var origThen = NativePromise.prototype.then;
  var tracked = [];
  var states = new WeakMap();
  function track(p, where) {
    if (p && typeof p === "object" && !states.has(p)) { states.set(p, { handled: false, probed: false, settled: null, reason: null, reported: false, where: where }); tracked.push(p); }
    return p;
  }
  function markHandled(p) {
    var s = states.get(p);
    if (s) { if (s.reported && !s.handled) log({ k: "rejectionhandled", where: s.where }); s.handled = true; }
  }
  function isThenable(v) { try { return v !== null && (typeof v === "object" || typeof v === "function") && typeof v.then === "function" && !(v instanceof NativePromise); } catch (e) { return false; } }
  function wrapCb(cb, kind) {
    if (typeof cb !== "function") return cb;
    // ret işleyicisine ulaşan hata da programa görünür: stack'i V8 biçimine (E518)
    return function (v) { log({ k: "micro", api: kind, fn: fname(cb) }); return cb.call(this, kind === "catch" ? v8Format(v) : v); };
  }
  NativePromise.prototype.then = function then(a, b) {
    markHandled(this);
    return track(origThen.call(this, wrapCb(a, "then"), wrapCb(b, "catch")), "then");
  };
  var origResolve = NativePromise.resolve;
  globalThis.Promise = new Proxy(NativePromise, {
    construct: function (tg, args, nt) {
      var exec = args[0];
      var wrapped = typeof exec !== "function" ? exec : function (res, rej) {
        return exec(function (v) { if (isThenable(v)) log({ k: "thenable", via: "resolve" }); return res(v); }, rej);
      };
      return track(Reflect.construct(tg, [wrapped], nt), "new Promise");
    },
    get: function (tg, k, r) {
      if (k === "resolve") return function resolve(v) { if (isThenable(v)) log({ k: "thenable", via: "Promise.resolve" }); return track(origResolve.call(this === globalThis.Promise ? tg : this, v), "Promise.resolve"); };
      var v = Reflect.get(tg, k, r);
      if (typeof v === "function" && (k === "reject" || k === "all" || k === "allSettled" || k === "race" || k === "any")) {
        return function () { return track(v.apply(this === globalThis.Promise ? tg : this, arguments), "Promise." + String(k)); };
      }
      return v;
    },
  });
  globalThis.__peelTrack = function (p, where) { return track(p, where); };
  globalThis.__peelTrackFn = function (f, where) {
    var w = function () { return track(Reflect.apply(f, this, arguments), where); };
    try { Object.defineProperty(w, "name", { value: f.name }); Object.defineProperty(w, "length", { value: f.length }); } catch (e) {}
    return w;
  };
  globalThis.__peelAwait = function (v, where) {
    if (v instanceof NativePromise) markHandled(v);
    else if (isThenable(v)) log({ k: "thenable", via: "await", where: where });
    return v;
  };
  globalThis.__peelResume = function (v, where) { log({ k: "micro", api: "await", fn: where }); return v; };
  globalThis.__peelSemMark = function (what) { log({ k: what }); };
  globalThis.__peelProbe = function () {
    tracked.forEach(function (p) {
      var s = states.get(p);
      if (s.probed) return;
      s.probed = true;
      origThen.call(p, function () { s.settled = "fulfilled"; }, function (e) { s.settled = "rejected"; s.reason = String(e && e.message !== undefined ? e.message : e); });
    });
  };
  globalThis.__peelCheck = function () {
    tracked.forEach(function (p) {
      var s = states.get(p);
      if (s.settled === "rejected" && !s.handled && !s.reported) { s.reported = true; log({ k: "unhandled", where: s.where, reason: s.reason }); }
    });
    tracked = tracked.filter(function (p) { var s = states.get(p); return s.settled === null || (!s.handled && s.settled === "rejected"); });
  };
})();
`;
