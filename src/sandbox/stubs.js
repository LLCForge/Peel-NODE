import { parseWasm } from './wasm.js';

// QuickJS içinde çalışan sahte tarayıcı ortamı: ağ yok, gerçek DOM yok, zaman/rastgelelik sabit.
// __out: programın console çıktısı (davranış karşılaştırması). __res: pass'lerin kendi probe sonuçları.
// Kayıt mekanizmaları (etki günlüğü, gölge bellek, kancalar) programa görünmez; programın gözlediği her şey
// temel ve aday çalıştırmada aynıdır. Yalnızca analizde açılan davranış __peelConfig.capture / .watch ile gelir.
export const STUBS = `
globalThis.__out = [];
globalThis.__res = [];
// __peelConfig: { now, seed, profile: { navigator, screen, webgl }, cookie, storage, responses: [{ match, status, body }], capture, watch }
var __cfg = globalThis.__peelConfig || {};
// E729: etki günlüğü — dışarıdan gözlenebilir her etki sırayla (tür, hedef, kısa ayrıntı)
globalThis.__peelEffects = [];
var __peelSeq = 0;
function __peelStr(v) {
  var t = typeof v;
  if (v == null || t === "string" || t === "number" || t === "boolean") return String(v).slice(0, 300);
  return "[" + t + "]";
}
function __peelFx(kind, target, detail) {
  if (__peelEffects.length < 3000) __peelEffects.push({ seq: __peelSeq++, kind: kind, target: String(target), detail: detail === undefined ? "" : __peelStr(detail) });
}
// E732: gölge bellek — nesneler için WeakMap, string'ler için değer tablosu; etiket = değerin kaynağı (taint)
globalThis.__peelShadow = (function () {
  var objs = new WeakMap(), strs = new Map();
  return {
    set: function (v, label) {
      if (v !== null && (typeof v === "object" || typeof v === "function")) objs.set(v, label);
      else if (typeof v === "string" && v.length >= 4 && strs.size < 1000 && !strs.has(v)) strs.set(v, label);
    },
    get: function (v) {
      if (v !== null && (typeof v === "object" || typeof v === "function")) return objs.get(v);
      return typeof v === "string" ? strs.get(v) : undefined;
    },
    strings: function () { return Array.from(strs.entries()); },
  };
})();
// C54: taint — kaynak değerin (çerez, depolama, navigator, konum…) ağ çıkışında ham ya da kodlanmış görünmesi
globalThis.__peelTaint = [];
function __peelTaintCheck(sink, text) {
  if (!text || __peelTaint.length >= 200) return;
  var list = __peelShadow.strings();
  for (var i = 0; i < list.length; i++) {
    var s = list[i][0], forms = [["ham", s]];
    try { forms.push(["encodeURIComponent", encodeURIComponent(s)]); } catch (e) {}
    try { forms.push(["base64", btoa(s)]); } catch (e) {}
    forms.push(["hex", Array.from(s).map(function (c) { var h = c.charCodeAt(0).toString(16); return h.length < 2 ? "0" + h : h; }).join("")]);
    forms.push(["ters", s.split("").reverse().join("")]);
    for (var j = 0; j < forms.length; j++) {
      if (forms[j][1].length >= 4 && text.indexOf(forms[j][1]) >= 0) {
        __peelTaint.push({ source: list[i][1], sink: sink, via: forms[j][0], value: s.slice(0, 80) });
        break;
      }
    }
  }
}
// E730: onRead/onWrite/onCall kanca API'si — yol ("navigator.userAgent", "localStorage.setItem") üzerine kurulur
globalThis.__peelHookLog = [];
globalThis.__peel = (function () {
  var installed = {};
  function resolve(path) {
    var parts = String(path).split("."), key = parts.pop(), obj = globalThis;
    for (var i = 0; i < parts.length; i++) { if (obj == null) return null; obj = obj[parts[i]]; }
    return obj == null ? null : { obj: obj, key: key };
  }
  function fire(list, info) { for (var i = 0; i < list.length; i++) { try { list[i](info); } catch (e) {} } }
  function install(path) {
    if (installed[path]) return installed[path];
    var r = resolve(path);
    if (!r) throw new Error("kanca yolu bulunamadı: " + path);
    var h = { read: [], write: [], call: [] }, cur = r.obj[r.key], wrapped = null;
    function wrap(fn) {
      if (typeof fn !== "function") return fn;
      var w = function () {
        var args = Array.prototype.slice.call(arguments);
        var res = new.target ? Reflect.construct(fn, args, new.target) : Reflect.apply(fn, this, args);
        fire(h.call, { path: path, args: args, result: res, self: this });
        return res;
      };
      w.prototype = fn.prototype;
      return w;
    }
    Object.defineProperty(r.obj, r.key, {
      configurable: true, enumerable: true,
      get: function () { fire(h.read, { path: path, value: cur }); return wrapped || (wrapped = wrap(cur)); },
      set: function (v) { fire(h.write, { path: path, value: v, old: cur }); cur = v; wrapped = null; },
    });
    return (installed[path] = h);
  }
  return {
    onRead: function (path, fn) { install(path).read.push(fn); },
    onWrite: function (path, fn) { install(path).write.push(fn); },
    onCall: function (path, fn) { install(path).call.push(fn); },
    shadow: __peelShadow,
    effect: __peelFx,
  };
})();
// Kayıtlar (yalnızca analizde okunur): olay işleyicileri, setInterval geri çağrıları, kripto çağrıları
globalThis.__peelHandlers = [];
globalThis.__peelTimers = [];
globalThis.__peelCrypto = [];
function __peelOn(target, type, fn) {
  if (typeof fn === "function" && __peelHandlers.length < 300) __peelHandlers.push({ target: target, type: String(type), fn: fn });
  if (typeof fn === "function") __peelFx("listener", type);
}
(function () {
  var FIXED = typeof __cfg.now === "number" ? __cfg.now : 1700000000000;
  var RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [FIXED])); }
    static now() { return FIXED; }
  };
  var seed = typeof __cfg.seed === "number" ? __cfg.seed : 12345;
  Math.random = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
})();
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.top = globalThis;
globalThis.parent = globalThis;
globalThis.frames = globalThis;
globalThis.document = {
  cookie: String(__cfg.cookie || ""), referrer: "", title: "", readyState: "complete",
  createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute: () => null, appendChild() {}, removeChild() {},
    addEventListener(t, f) { __peelOn(this, t, f); }, getContext: () => ({ fillRect() {}, drawImage() {}, fillText() {} }) }),
  getElementById: () => null, getElementsByClassName: () => [], getElementsByTagName: () => [],
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener(t, f) { __peelOn(document, t, f); }, removeEventListener() {},
  body: { appendChild() {}, style: {}, classList: { add() {}, remove() {} } },
  head: { appendChild() {} },
  documentElement: { style: {}, clientWidth: 1920, clientHeight: 1080 },
  createTextNode: () => ({}), createDocumentFragment: () => ({ appendChild() {} }),
};
globalThis.navigator = { userAgent: "Mozilla/5.0", language: "en-US", languages: ["en-US"],
  platform: "Win32", vendor: "", plugins: [], webdriver: false, cookieEnabled: true };
globalThis.location = { href: "https://example.com/", hostname: "example.com", protocol: "https:",
  pathname: "/", search: "", hash: "", origin: "https://example.com" };
globalThis.addEventListener = function (t, f) { __peelOn(globalThis, t, f); };
globalThis.removeEventListener = function () {};
globalThis.localStorage = { _d: Object.assign({}, __cfg.storage || {}),
  getItem(k) { var v = this._d[k] ?? null; if (v !== null) __peelShadow.set(v, "localStorage:" + k); __peelFx("storage.read", k); return v; },
  setItem(k, v) { this._d[k] = String(v); __peelFx("storage.write", k, String(v)); },
  removeItem(k) { delete this._d[k]; __peelFx("storage.remove", k); },
  clear() { this._d = {}; __peelFx("storage.clear", "*"); },
  key(i) { return Object.keys(this._d)[i] ?? null; },
  get length() { return Object.keys(this._d).length; } };
globalThis.sessionStorage = globalThis.localStorage;
// C55: eval/Function/setTimeout(string)/document.write/script ile üretilen kod
globalThis.__peelDyn = [];
function __peelDynCode(via, code) {
  if (typeof code !== "string") return;
  if (__peelDyn.length < 100) __peelDyn.push({ via: via, code: code.slice(0, 20000), length: code.length });
  __peelFx("eval", via, code);
}
globalThis.setTimeout = (f) => { __peelFx("timer", "setTimeout"); if (typeof f === "string") __peelDynCode("setTimeout", f); try { if (typeof f === "function") f(); } catch (e) {} return 0; };
globalThis.setInterval = (f) => { __peelFx("timer", "setInterval"); if (typeof f === "string") __peelDynCode("setInterval", f); if (typeof f === "function" && __peelTimers.length < 100) __peelTimers.push(f); return 0; };
globalThis.clearTimeout = () => {};
globalThis.clearInterval = () => {};
globalThis.requestAnimationFrame = (f) => { try { f(0); } catch (e) {} return 0; };
globalThis.cancelAnimationFrame = () => {};
globalThis.console = {
  log(...a) {
    var line = a.map(x => {
      try { return typeof x === "object" && x !== null ? JSON.stringify(x) : String(x); }
      catch (e) { return String(x); }
    }).join(" ");
    __out.push(line);
    __peelFx("console", "log", line);
  },
  error(...a) { var line = "!ERR " + a.map(String).join(" "); __out.push(line); __peelFx("console", "error", line); },
  warn() {}, info() {}, debug() {}, trace() {}, table() {},
};
globalThis.alert = (m) => { __peelFx("dialog", "alert", m); };
globalThis.prompt = (m) => { __peelFx("dialog", "prompt", m); return null; };
globalThis.confirm = (m) => { __peelFx("dialog", "confirm", m); return true; };
globalThis.DOMParser = function () { this.parseFromString = () => ({ querySelectorAll: () => [], querySelector: () => null }); };
globalThis.crypto = {
  getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = (i * 97 + 13) & 255; return a; },
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
  subtle: (function () {
    var buf = () => Promise.resolve(new ArrayBuffer(32));
    // girdi/çıktı kaydı: algoritma adı ve verinin ilk baytları (analiz raporu)
    function preview(d) {
      try {
        if (typeof d === "string") return d.slice(0, 64);
        var a = Array.from(new Uint8Array(d && d.buffer ? d.buffer : d || [])).slice(0, 32);
        return a.map(function (x) { return (x < 16 ? "0" : "") + x.toString(16); }).join("");
      } catch (e) { return ""; }
    }
    function rec(op, alg, data, fn) {
      return function () {
        var name = String(alg && (alg.name || alg) || "");
        if (__peelCrypto.length < 200) __peelCrypto.push({ op: op, alg: name, data: preview(data) });
        __peelFx("crypto", op, name);
        return fn();
      };
    }
    var api = {};
    ["importKey", "exportKey", "digest", "encrypt", "decrypt", "sign", "verify", "generateKey", "deriveBits", "deriveKey"].forEach(function (op) {
      api[op] = function (a, b, c) {
        var alg = op === "importKey" || op === "exportKey" ? b : a;
        var data = op === "digest" ? b : op === "importKey" ? c : op === "encrypt" || op === "decrypt" || op === "sign" ? c : null;
        var result = op === "verify" ? () => Promise.resolve(true) : op === "importKey" || op === "generateKey" || op === "deriveKey" ? () => Promise.resolve({}) : buf;
        return rec(op, alg, data, result)();
      };
    });
    return api;
  })(),
};
globalThis.performance = { now: () => 0, timeOrigin: 1700000000000 };
globalThis.TextEncoder = function () { this.encode = (s) => Uint8Array.from(unescape(encodeURIComponent(String(s ?? ""))), (c) => c.charCodeAt(0)); };
globalThis.TextDecoder = function () { this.decode = (b) => decodeURIComponent(escape(String.fromCharCode.apply(null, Array.from(new Uint8Array(b && b.buffer ? b.buffer : b || []))))); };
// DOM kurucuları: koruma kodları prototype'larını dondurur/inceler; yoksa program erken çöker
(function () {
  var names = ["EventTarget", "Node", "Element", "HTMLElement", "HTMLCanvasElement", "HTMLImageElement",
    "HTMLInputElement", "HTMLIFrameElement", "HTMLScriptElement", "Document", "Event", "CustomEvent",
    "MutationObserver", "WebSocket", "Worker", "Blob", "File", "FileReader", "Image",
    "CanvasRenderingContext2D", "WebGLRenderingContext", "AudioContext", "OfflineAudioContext", "Notification"];
  names.forEach(function (n) {
    if (globalThis[n]) return;
    var C = function () {};
    C.prototype.addEventListener = function () {};
    C.prototype.getContext = function () { return { fillRect() {}, drawImage() {}, fillText() {}, getImageData: () => ({ data: [] }) }; };
    C.prototype.toDataURL = function () { return "data:,"; };
    globalThis[n] = C;
  });
  globalThis.URL = globalThis.URL || function (u) { this.href = String(u); };
})();
globalThis.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24 };
globalThis.history = { length: 1, pushState() { __peelFx("history", "pushState", arguments[2]); }, replaceState() { __peelFx("history", "replaceState", arguments[2]); } };

// C53: canvas / WebGL / Audio parmak izi API'leri — çağrılar __peelFp'ye kaydedilir
globalThis.__peelFpLog = [];
function __peelFp(api, detail) { if (__peelFpLog.length < 300) __peelFpLog.push({ api: api, detail: __peelStr(detail) }); __peelFx("fingerprint", api, detail); }
var __peelCanvasData = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
__peelShadow.set(__peelCanvasData, "canvas.toDataURL");
function __peelContext(type) {
  var gl = /webgl/i.test(type), prof = (__cfg.profile || {}).webgl || {};
  __peelFp("canvas.getContext", type);
  if (gl) {
    var vendor = prof.vendor || "Google Inc. (Intel)", renderer = prof.renderer || "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)";
    __peelShadow.set(renderer, "webgl.renderer");
    return {
      VENDOR: 7936, RENDERER: 7937, VERSION: 7938,
      getParameter: function (p) {
        __peelFp("webgl.getParameter", p);
        return p === 37445 || p === 7936 ? vendor : p === 37446 || p === 7937 ? renderer : p === 7938 ? "WebGL 1.0" : 0;
      },
      getExtension: function (n) { __peelFp("webgl.getExtension", n); return n === "WEBGL_debug_renderer_info" ? { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 } : null; },
      getSupportedExtensions: function () { __peelFp("webgl.getSupportedExtensions", ""); return ["WEBGL_debug_renderer_info", "OES_texture_float"]; },
      getShaderPrecisionFormat: function () { __peelFp("webgl.getShaderPrecisionFormat", ""); return { rangeMin: 127, rangeMax: 127, precision: 23 }; },
      createBuffer: function () { return {}; }, bindBuffer: function () {}, bufferData: function () {}, createShader: function () { return {}; },
      shaderSource: function () {}, compileShader: function () {}, createProgram: function () { return {}; }, attachShader: function () {},
      linkProgram: function () {}, useProgram: function () {}, drawArrays: function () { __peelFp("webgl.drawArrays", ""); },
      readPixels: function () { __peelFp("webgl.readPixels", ""); },
    };
  }
  return {
    canvas: null, font: "", fillStyle: "", textBaseline: "",
    fillRect: function () {}, drawImage: function () {}, beginPath: function () {}, arc: function () {}, fill: function () {},
    closePath: function () {}, rect: function () {}, stroke: function () {},
    fillText: function (t) { __peelFp("canvas.fillText", t); },
    strokeText: function (t) { __peelFp("canvas.strokeText", t); },
    measureText: function (t) { __peelFp("canvas.measureText", t); return { width: String(t).length * 7 }; },
    getImageData: function (x, y, w, h) { __peelFp("canvas.getImageData", w + "x" + h); return { data: new Uint8ClampedArray(Math.min(4 * (w || 1) * (h || 1), 1 << 20)) }; },
    isPointInPath: function () { __peelFp("canvas.isPointInPath", ""); return false; },
  };
}
(function () {
  function AudioCtx(kind) {
    return function () {
      __peelFp(kind, "");
      var param = function () { return { value: 0, setValueAtTime: function () {} }; };
      var node = function (n) {
        return function () {
          __peelFp("audio." + n, "");
          return { connect: function () {}, disconnect: function () {}, start: function () {}, stop: function () {}, type: "",
            frequency: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), gain: param(),
            getFloatFrequencyData: function () {} };
        };
      };
      this.destination = {}; this.sampleRate = 44100; this.currentTime = 0;
      this.createOscillator = node("createOscillator"); this.createDynamicsCompressor = node("createDynamicsCompressor");
      this.createAnalyser = node("createAnalyser"); this.createGain = node("createGain"); this.createScriptProcessor = node("createScriptProcessor");
      this.startRendering = function () {
        __peelFp("audio.startRendering", "");
        var buf = new Float32Array(4500);
        for (var i = 0; i < buf.length; i++) buf[i] = Math.sin(i / 7) * 1e-4;
        return Promise.resolve({ getChannelData: function () { return buf; }, length: buf.length });
      };
      this.close = function () { return Promise.resolve(); };
    };
  }
  globalThis.AudioContext = globalThis.webkitAudioContext = AudioCtx("AudioContext");
  globalThis.OfflineAudioContext = globalThis.webkitOfflineAudioContext = AudioCtx("OfflineAudioContext");
  globalThis.HTMLCanvasElement.prototype.getContext = function (type) { return __peelContext(String(type)); };
  globalThis.HTMLCanvasElement.prototype.toDataURL = function () { __peelFp("canvas.toDataURL", ""); return __peelCanvasData; };
})();

// Gözlem: kodun nereye istek atmaya çalıştığı ve hangi tarayıcı özelliklerini okuduğu (rapor için)
globalThis.__peelNet = [];
globalThis.__peelReads = {};
(function () {
  function count(key) { __peelReads[key] = (__peelReads[key] || 0) + 1; }
  function net(api, url, o) {
    if (__peelNet.length >= 500) return;
    var u = String(url && url.url || url || ""), body = o && o.body != null ? String(o.body).slice(0, 300) : "";
    __peelNet.push({ api: api, url: u, method: (o && o.method) || "", body: body });
    __peelFx("net", api, ((o && o.method) || "") + " " + u + (body ? " " + body : ""));
    // köken kısmı hariç: konum değerleri göreli URL'lerde doğal olarak bulunur
    __peelTaintCheck(api, u.replace(/^[a-z]+:\\/\\/[^/]+/i, "") + " " + body);
  }
  globalThis.__peelNetRecord = net;
  // E731: builtin'lerde proxy tuzağı — okuma sayımı, string değerlere taint etiketi, yazmalar etki günlüğüne
  function watch(name, obj) {
    return new Proxy(obj, {
      get: function (t, k, r) {
        var v = Reflect.get(t, k, r);
        if (typeof k === "string") {
          count(name + "." + k);
          if (typeof v === "string") {
            __peelShadow.set(v, name + "." + k);
            if (k === "cookie") v.split(";").forEach(function (p) { __peelShadow.set(p.split("=").slice(1).join("=").trim(), "document.cookie"); });
          }
        }
        return v;
      },
      set: function (t, k, v, r) {
        if (typeof k === "string") __peelFx(k === "cookie" ? "cookie.write" : "write", name + "." + k, v);
        return Reflect.set(t, k, v, r);
      },
    });
  }
  // sahte yanıtlar: __cfg.responses içinde URL'si eşleşen ilk kayıt, yoksa boş 200
  function respond(url) {
    var u = String(url && url.url || url || "");
    var list = __cfg.responses || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].match && u.indexOf(list[i].match) >= 0) return list[i];
    return { status: 200, body: "" };
  }
  function response(url) {
    var r = respond(url), body = String(r.body == null ? "" : r.body);
    return { ok: (r.status || 200) < 400, status: r.status || 200, url: String(url && url.url || url || ""),
      text: () => Promise.resolve(body), json: () => Promise.resolve(body ? JSON.parse(body) : {}),
      arrayBuffer: () => Promise.resolve(Uint8Array.from(body, (c) => c.charCodeAt(0) & 255).buffer),
      headers: { get: () => null } };
  }
  globalThis.__peelRespond = respond;
  globalThis.fetch = function (url, o) { net("fetch", url, { method: (o && o.method) || "GET", body: o && o.body }); return Promise.resolve(response(url)); };
  globalThis.XMLHttpRequest = function () {
    var m = "GET", u = "";
    var self = this;
    this.readyState = 0;
    this.open = function (a, b) { m = a; u = b; self.readyState = 1; };
    this.send = function (b) {
      net("xhr", u, { method: m, body: b });
      var r = response(u);
      self.readyState = 4; self.status = r.status; self.responseText = self.response = "";
      r.text().then(function (t) { self.responseText = self.response = t; });
    };
    this.setRequestHeader = function () {};
    this.addEventListener = function (t, f) { __peelOn(self, t, f); };
  };
  globalThis.WebSocket = function (u) {
    net("websocket", u);
    this.send = function (d) { net("websocket.send", u, { body: d }); };
    this.close = function () {};
    this.addEventListener = function () {};
  };
  navigator.sendBeacon = function (u, d) { net("beacon", u, { method: "POST", body: d }); return true; };
  function Img() {}
  Object.defineProperty(Img.prototype, "src", { set: function (v) { net("image", v); this._src = v; }, get: function () { return this._src || ""; } });
  globalThis.Image = Img;
  var create = document.createElement;
  document.createElement = function (tag) {
    var name = String(tag).toLowerCase(), el = create(tag), src = "", html = "", kind = name === "script" ? "script" : "element";
    el.tagName = name.toUpperCase();
    __peelFx("dom", "createElement", name);
    Object.defineProperty(el, "src", { set: function (v) { src = v; net(kind, v); }, get: function () { return src; } });
    Object.defineProperty(el, "innerHTML", { set: function (v) { html = String(v); __peelFx("dom", "innerHTML", html); if (kind === "script") __peelDynCode("script", html); }, get: function () { return html; } });
    if (kind === "script") ["text", "textContent"].forEach(function (p) {
      var val = "";
      Object.defineProperty(el, p, { set: function (v) { val = String(v); __peelDynCode("script", val); }, get: function () { return val; } });
    });
    el.toDataURL = function () { count("canvas.toDataURL"); __peelFp("canvas.toDataURL", ""); return __peelCanvasData; };
    el.getContext = function (type) { return __peelContext(String(type)); };
    return el;
  };
  document.write = document.writeln = function () {
    var s = Array.prototype.join.call(arguments, "");
    __peelFx("dom", "document.write", s);
    (s.match(/<script[^>]*>[\\s\\S]*?<\\/script>/gi) || []).forEach(function (x) { __peelDynCode("document.write", x.replace(/^<script[^>]*>|<\\/script>$/gi, "")); });
    (s.match(/<(?:script|img|iframe)[^>]+src=["']?[^"' >]+/gi) || []).forEach(function (x) { net("document.write", x.replace(/^.*src=["']?/i, "")); });
  };
  globalThis.document = watch("document", document);
  globalThis.navigator = watch("navigator", navigator);
  globalThis.screen = watch("screen", screen);
  // yönlendirme: location.href = …, assign/replace, window.open
  location.assign = function (u) { net("navigate", u); };
  location.replace = function (u) { net("navigate", u); };
  location.reload = function () { __peelFx("navigate", "reload"); };
  globalThis.open = function (u) { net("window.open", u); return null; };
  globalThis.location = new Proxy(location, {
    get: function (t, k, r) {
      var v = Reflect.get(t, k, r);
      if (typeof k === "string") { count("location." + k); if (typeof v === "string" && k !== "protocol") __peelShadow.set(v, "location." + k); }
      return v;
    },
    set: function (t, k, v) { if (k === "href") net("navigate", v); else __peelFx("write", "location." + String(k), v); t[k] = v; return true; },
  });
  // tarayıcı profili: navigator/screen alanlarının üzerine yazılır (bot ve gerçek kullanıcı karşılaştırması)
  var prof = __cfg.profile || {};
  Object.assign(navigator, prof.navigator || {});
  Object.assign(screen, prof.screen || {});
})();
// QuickJS "".fontcolor() gibi HTML yöntemlerini argümansız çağırınca hata verir; tarayıcılar
// <font color="undefined"> üretir. jsfuck " karakterini buradan alır: tarayıcı davranışına eşitle.
(function () {
  try { "".fontcolor(); return; } catch (e) {}
  var tags = { anchor: ["a", "name"], fontcolor: ["font", "color"], fontsize: ["font", "size"], link: ["a", "href"] };
  Object.keys(tags).forEach(function (k) {
    var tag = tags[k][0], attr = tags[k][1];
    Object.defineProperty(String.prototype, k, { writable: true, configurable: true, value: function (v) {
      if (this === null || this === undefined) throw new TypeError("String.prototype." + k + " called on null or undefined");
      return "<" + tag + " " + attr + '="' + String(v).replace(/"/g, "&quot;") + '">' + String(this) + "</" + tag + ">";
    } });
  });
})();
// obfuscator.io selfDefending: fn.toString().search("(((.+)+)+)+$"). QuickJS'in özyinelemeli regex motoru uzun
// metinde host yığınını taşırır (tarayıcıda anında biter). Kalıbın anlamı kesin hesaplanır: en soldaki eşleşme,
// sonunda satır sonu içermeyen boş olmayan son satırın başıdır; son karakter satır sonuysa eşleşme yoktur.
(function () {
  var NESTED = "(((.+)+)+)+$";
  var realSearch = String.prototype.search;
  var lastLine = function (s) {
    var i = Math.max(s.lastIndexOf("\\n"), s.lastIndexOf("\\r"), s.lastIndexOf("\\u2028"), s.lastIndexOf("\\u2029")) + 1;
    return i < s.length ? i : -1;
  };
  Object.defineProperty(String.prototype, "search", { writable: true, configurable: true, value: function search(re) {
    if (this === null || this === undefined) throw new TypeError("String.prototype.search called on null or undefined");
    var src = typeof re === "string" ? re : re instanceof RegExp && re.flags === "" ? re.source : null;
    if (src === NESTED) return lastLine(String(this));
    return realSearch.call(this, re);
  } });
})();

// C66: Blob, object URL ve Worker yakalama — worker kodu analizde ayrı sandbox'ta çalıştırılır
globalThis.__peelWorkers = [];
var __peelBlobs = {};
(function () {
  function text(p) {
    if (typeof p === "string") return p;
    if (p && typeof p._text === "string") return p._text;
    try { return String.fromCharCode.apply(null, Array.from(new Uint8Array(p && p.buffer ? p.buffer : p))); } catch (e) { return String(p); }
  }
  globalThis.Blob = function (parts, opts) {
    var self = this;
    this._text = (parts || []).map(text).join("");
    this.size = this._text.length;
    this.type = (opts && opts.type) || "";
    this.text = function () { return Promise.resolve(self._text); };
    this.arrayBuffer = function () { return Promise.resolve(Uint8Array.from(self._text, function (c) { return c.charCodeAt(0) & 255; }).buffer); };
  };
  var seq = 0;
  URL.createObjectURL = function (b) {
    var u = "blob:https://example.com/peel-" + (++seq);
    __peelBlobs[u] = b && typeof b._text === "string" ? b._text : "";
    __peelFx("blob", u, __peelBlobs[u]);
    return u;
  };
  URL.revokeObjectURL = function () {};
  function source(u) {
    if (__peelBlobs[u] != null) return __peelBlobs[u];
    var m = /^data:[^,]*?(;base64)?,(.*)$/i.exec(u);
    if (m) { try { return m[1] ? atob(m[2]) : decodeURIComponent(m[2]); } catch (e) { return null; } }
    return null;
  }
  function W(kind) {
    return function (url) {
      var u = String(url && url.href || url), code = source(u), self = this;
      if (code == null) __peelNetRecord(kind, u); else __peelFx("worker", kind, u);
      var rec = { id: __peelWorkers.length, kind: kind, url: u, code: code, inbox: [], listeners: [], onmessage: null, terminated: false };
      if (__peelWorkers.length < 10) __peelWorkers.push(rec);
      var port = {
        postMessage: function (m) {
          var c;
          try { c = JSON.stringify(m); } catch (e) { c = JSON.stringify(String(m)); }
          rec.inbox.push(c === undefined ? "null" : c);
          __peelFx("worker.post", u, c);
        },
        start: function () {}, close: function () {},
        addEventListener: function (t, f) { if (t === "message" && typeof f === "function") rec.listeners.push(f); },
      };
      Object.defineProperty(port, "onmessage", { get: function () { return rec.onmessage; }, set: function (f) { rec.onmessage = f; } });
      if (kind === "SharedWorker") { this.port = port; return; }
      this.postMessage = port.postMessage;
      this.addEventListener = function (t, f) { port.addEventListener(t, f); __peelFx("listener", t); };
      this.removeEventListener = function () {};
      this.terminate = function () { rec.terminated = true; };
      Object.defineProperty(this, "onmessage", { get: function () { return rec.onmessage; }, set: function (f) { rec.onmessage = f; } });
    };
  }
  globalThis.Worker = W("Worker");
  globalThis.SharedWorker = W("SharedWorker");
  // worker'dan dönen mesajları ana programa iletir (analiz orkestrasyonu çağırır)
  globalThis.__peelDeliverWorker = function (id, list) {
    var rec = __peelWorkers[id];
    if (!rec || rec.terminated) return 0;
    var n = 0;
    list.forEach(function (m) {
      var ev = { data: JSON.parse(m), type: "message", target: null };
      var fns = rec.listeners.slice();
      if (typeof rec.onmessage === "function") fns.push(rec.onmessage);
      fns.forEach(function (f) { try { f(ev); n++; } catch (e) {} });
    });
    return n;
  };
})();

// C64: WebAssembly — modül baytları ayrıştırılır, import/export ve çağrılar kaydedilir (gerçek wasm çalıştırılmaz)
globalThis.__peelWasm = [];
globalThis.__peelWasmParse = ${parseWasm.toString()};
(function () {
  function bytesOf(src) {
    if (src instanceof ArrayBuffer) return new Uint8Array(src);
    if (src && src.buffer instanceof ArrayBuffer) return new Uint8Array(src.buffer, src.byteOffset || 0, src.byteLength);
    throw new TypeError("WebAssembly: BufferSource bekleniyor");
  }
  function mkErr(n) { return function (m) { var e = new Error(m); e.name = n; return e; }; }
  var CompileError = mkErr("CompileError"), LinkError = mkErr("LinkError"), RuntimeError = mkErr("RuntimeError");
  function Memory(d) {
    this.buffer = new ArrayBuffer(Math.min((d && d.initial) || 1, 64) * 65536);
    this.grow = function (n) {
      var old = this.buffer.byteLength / 65536, nb = new ArrayBuffer(Math.min(old + (n || 0), 64) * 65536);
      new Uint8Array(nb).set(new Uint8Array(this.buffer));
      this.buffer = nb;
      return old;
    };
  }
  function Table(d) { this.length = (d && d.initial) || 0; this.get = function () { return null; }; this.set = function () {}; this.grow = function (n) { var o = this.length; this.length += n; return o; }; }
  function Global(d, v) { this.value = v || 0; this.valueOf = function () { return this.value; }; }
  function Module(src) {
    var b = bytesOf(src), info;
    try { info = __peelWasmParse(b); } catch (e) { throw new CompileError(String(e.message)); }
    this.__info = info;
    this.__rec = { size: b.length, version: info.version, imports: info.imports, exports: info.exports, memories: info.memories,
      tables: info.tables, globals: info.globals.length, start: info.start, custom: info.custom, functions: info.functions.length, provided: [], calls: [] };
    if (__peelWasm.length < 20) __peelWasm.push(this.__rec);
    __peelFx("wasm", "compile", b.length + " bayt");
  }
  Module.exports = function (m) { return m.__info.exports.map(function (e) { return { name: e.name, kind: e.kind }; }); };
  Module.imports = function (m) { return m.__info.imports.map(function (e) { return { module: e.module, name: e.name, kind: e.kind }; }); };
  Module.customSections = function (m, n) { return m.__info.custom.filter(function (c) { return c.name === n; }).map(function () { return new ArrayBuffer(0); }); };
  function Instance(mod, imports) {
    var rec = mod.__rec, ex = {};
    rec.provided = Object.keys(imports || {}).map(function (k) { return k + ": " + Object.keys(imports[k] || {}).join(", "); });
    mod.__info.imports.forEach(function (i) {
      var m = imports && imports[i.module];
      if (!m || !(i.name in m)) throw new LinkError("import eksik: " + i.module + "." + i.name);
    });
    mod.__info.exports.forEach(function (e) {
      if (e.kind === "func") ex[e.name] = function () {
        var a = Array.prototype.slice.call(arguments, 0, 8).map(__peelStr);
        if (rec.calls.length < 200) rec.calls.push({ name: e.name, args: a });
        __peelFx("wasm.call", e.name, a.join(","));
        return 0;
      };
      else if (e.kind === "memory") ex[e.name] = new Memory({ initial: (mod.__info.memories[0] || { min: 1 }).min });
      else if (e.kind === "table") ex[e.name] = new Table({ initial: 0 });
      else ex[e.name] = new Global({}, 0);
    });
    this.exports = Object.freeze(ex);
  }
  globalThis.WebAssembly = {
    Module: Module, Instance: Instance, Memory: Memory, Table: Table, Global: Global,
    CompileError: CompileError, LinkError: LinkError, RuntimeError: RuntimeError,
    validate: function (b) { try { __peelWasmParse(bytesOf(b)); return true; } catch (e) { return false; } },
    compile: function (b) { try { return Promise.resolve(new Module(b)); } catch (e) { return Promise.reject(e); } },
    instantiate: function (b, imp) {
      try {
        if (b instanceof Module) return Promise.resolve(new Instance(b, imp));
        var m = new Module(b);
        return Promise.resolve({ module: m, instance: new Instance(m, imp) });
      } catch (e) { return Promise.reject(e); }
    },
    compileStreaming: function (r) { return Promise.resolve(r).then(function (x) { return x.arrayBuffer(); }).then(function (b) { return new Module(b); }); },
    instantiateStreaming: function (r, imp) { return Promise.resolve(r).then(function (x) { return x.arrayBuffer(); }).then(function (b) { return globalThis.WebAssembly.instantiate(b, imp); }); },
  };
})();

// Analiz kipi (yalnızca rapor çalıştırması): Function kurucularına verilen kod ve eval argümanları yakalanır
if (__cfg.capture) {
  (function () {
    function wrapCtor(Real) {
      var W = function () {
        var a = Array.prototype.slice.call(arguments);
        __peelDynCode(Real.name || "Function", a.length ? String(a[a.length - 1]) : "");
        return Reflect.apply(Real, this, a);
      };
      W.prototype = Real.prototype;
      try { Object.defineProperty(W, "name", { value: Real.name }); } catch (e) {}
      try { Object.defineProperty(Real.prototype, "constructor", { value: W, writable: true, configurable: true }); } catch (e) {}
      return W;
    }
    globalThis.Function = wrapCtor(Function);
    wrapCtor(Object.getPrototypeOf(async function () {}).constructor);
    wrapCtor(Object.getPrototypeOf(function* () {}).constructor);
    var realEval = globalThis.eval;
    var evalWrap = function (x) { __peelDynCode("eval", x); return realEval(x); };
    globalThis.eval = evalWrap;
    // doğrudan eval çağrıları (yerel kapsam): çağrı süresince gerçek eval yerine konur, sonra sarmalayıcı geri gelir
    globalThis.__peelCode = function (via, x) { __peelDynCode(via, x); return x; };
    globalThis.__peelEvalOn = function () { globalThis.eval = realEval; };
    globalThis.__peelEvalOff = function (v) { globalThis.eval = evalWrap; return v; };
  })();
}
// Bildirime dayalı kancalar (yalnızca analiz yapılandırması): her olay etki günlüğüne "hook" olarak düşer
(__cfg.watch || []).slice(0, 50).forEach(function (w) {
  var path = typeof w === "string" ? w : w && w.path, on = (w && w.on) || ["read", "write", "call"];
  try {
    if (on.indexOf("read") >= 0) __peel.onRead(path, function (i) { __peelHookLog.push({ kind: "read", path: i.path, value: __peelStr(i.value) }); __peelFx("hook.read", i.path); });
    if (on.indexOf("write") >= 0) __peel.onWrite(path, function (i) { __peelHookLog.push({ kind: "write", path: i.path, value: __peelStr(i.value) }); __peelFx("hook.write", i.path, i.value); });
    if (on.indexOf("call") >= 0) __peel.onCall(path, function (i) { __peelHookLog.push({ kind: "call", path: i.path, args: i.args.slice(0, 5).map(__peelStr) }); __peelFx("hook.call", i.path); });
  } catch (e) { __peelHookLog.push({ kind: "error", path: String(path), value: String(e.message) }); }
});
globalThis.__peelBaseGlobals = Object.getOwnPropertyNames(globalThis);
`;
