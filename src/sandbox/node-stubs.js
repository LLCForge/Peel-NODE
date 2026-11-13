// Node.js çalışma ortamı öykünmesi (QuickJS içinde, STUBS ve SEMANTIC_STUBS'tan sonra, eklentilerden önce çalışır).
// Etkinleşme: __peelConfig.env === 'node' (src/sandbox/env.js'teki withEnv sarmalayıcısı her isteğe ekler).
// Tarayıcı global'leri (window, document, navigator, location, localStorage, DOM kurucuları...) silinir; paylaşılan
// altyapı (etki günlüğü __peelEffects, ağ kaydı __peelNet, gölge bellek/taint, __peelDynCode katman yakalama) kalır.
//
// ── Etki günlüğü sözleşmesi (rapor/tehdit tarafı için) ─────────────────────────────────────────────────────────────
// Her kayıt __peelEffects içinde { seq, kind, target, detail } (detail en fazla 300 karakter). Node'a özgü türler:
//   node.require   target: modül adı ('node:' öneki atılmış, ör. "child_process", "./x.js", "axios")
//                  detail: "builtin" | "file" (önceden yazılmış ya da sanal dosya) | "mock" (kurulu olmayan paket)
//   node.env.read  target: değişken adı (process.env.X, 'X' in process.env)   detail: ""
//   node.env.write target: değişken adı   detail: yeni değer ("<deleted>" silme)
//   node.env.enum  target: "*" (Object.keys(process.env), JSON.stringify(process.env), for-in)
//   node.exit      target: çıkış kodu ya da "abort"   (program durdurulur: özel hata fırlatılır)
//   node.process   target: yöntem (kill, chdir, dlopen, setuid, ...)   detail: argümanlar
//   node.fs.<op>   op ∈ read | write | append | delete | mkdir | copy | rename | chmod | link | stat | list | open | watch
//                  target: yol (programın verdiği biçimde)   detail: read → "self" | "vfs" | "missing",
//                  write/append → içerik önizlemesi, copy/rename/link → hedef yol, chmod → mod
//   node.exec      target: API (exec, execSync, spawn, spawnSync, fork, execFile, execFileSync, cluster.fork, stdin)
//                  detail: komut satırı (komut + argümanlar boşlukla), stdin → yazılan veri
//   node.os        target: okunan os yöntemi (hostname, userInfo, homedir, networkInterfaces, cpus, ...)
//   node.worker    target: dosya adı ya da "eval" | "postMessage"   detail: kod/mesaj önizlemesi
//   node.stdin     target: "question" | "read"   detail: istem metni
//   node.mock.call target: taklit yolu (ör. "axios.post", "discord.js.Client.login")   detail: argüman önizlemeleri ", " ile
//   node.mock.new  target: taklit yolu (new ile)   detail: argümanlar
//   node.mock.set  target: taklit yolu + özellik   detail: değer
// Ortak türler: "net" (target: API, ör. "https.request", "net.connect", "net.write", "dgram.send", "dns.lookup",
//   "http.listen", "axios.post"; detail: "METHOD url body") — aynı kayıt __peelNet'e { api, url, method, body } olarak
//   düşer. URL biçimleri: http(s)://..., tcp://host:port, tls://host:port, udp://host:port; dns için çıplak alan adı.
//   "eval" (target: via — "vm.runInThisContext", "vm.runInNewContext", "vm.Script", "vm.compileFunction",
//   "module._compile", "require" (sanal dosya), "child_process" (node -e / node dosya.js), "worker_threads",
//   "eval", "Function"; detail: kod) — kodun tamamı (20000 karaktere kadar) __peelDyn listesindedir.
//   "crypto" (target: "node.createHash" | "node.createHmac" | "node.createCipheriv" | "node.createDecipheriv" |
//   "node.pbkdf2"; detail: algoritma) — __peelCrypto'ya { op, alg, data(hex önizleme) } kaydı.
//   "console" (target: "log" | "error" | "stdout" | "stderr"), "listener" (target: "process.<olay>"), "timer".
// Taint etiketleri (__peelShadow): "process.env.X", "fs:<yol>", "os.<yöntem>", "net:<url>".
// Doğrulamada gözlenebilir sayılanlar src/verify/effects.js OBSERVABLE listesindedir (okumalar sayılmaz).
//
// __peelConfig.node: { source: kendi kaynağı (fs.readFileSync(__filename)), files: { yol: içerik }, env: { ad: değer },
//   argv: [ek argümanlar], alt: true → dış girdiler farklı döner (katman açma pass'inin bağımsızlık denetimi) }.
// process.env yalnızca sabit, sır içermeyen Windows sistem değişkenlerini taşır (APPDATA, USERPROFILE...): token/anahtar yok.

export const NODE_EFFECT_KINDS = ['node.require', 'node.env.read', 'node.env.write', 'node.env.enum', 'node.exit',
  'node.process', 'node.fs.read', 'node.fs.write', 'node.fs.append', 'node.fs.delete', 'node.fs.mkdir', 'node.fs.copy',
  'node.fs.rename', 'node.fs.chmod', 'node.fs.link', 'node.fs.stat', 'node.fs.list', 'node.fs.open', 'node.fs.watch',
  'node.exec', 'node.os', 'node.worker', 'node.stdin', 'node.mock.call', 'node.mock.new', 'node.mock.set'];

// Dışarıdan gözlenebilir Node etkileri: davranış doğrulamasında karşılaştırılır (okumalar ve kayıt amaçlı türler hariç)
export const NODE_OBSERVABLE = ['node.env.write', 'node.exit', 'node.process', 'node.fs.write', 'node.fs.append',
  'node.fs.delete', 'node.fs.mkdir', 'node.fs.copy', 'node.fs.rename', 'node.fs.chmod', 'node.fs.link', 'node.exec',
  'node.worker', 'node.mock.call', 'node.mock.new'];

/* eslint-disable no-var, prefer-rest-params */
// Kendi kendine yeten çalışma zamanı: toString() ile sandbox'a gömülür, modül kapsamındaki hiçbir şeye başvurmaz.
function nodeRuntime(g) {
  var cfg = g.__peelConfig || {};
  var ncfg = cfg.node || {};
  var ALT = Boolean(ncfg.alt);
  var fx = function (k, t, d) { g.__peelFx(k, t, d); };
  var shadow = g.__peelShadow;
  var slice = function (a, i) { return Array.prototype.slice.call(a, i || 0); };
  var hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  var later = function (fn) { Promise.resolve().then(function () { try { fn(); } catch (e) { /* geri çağrı hatası programı durdurmaz */ } }); };
  var dyn = function (via, code) { g.__peelDynCode(via, code); };
  var FILENAME = '/app/index.js';
  var DIRNAME = '/app';
  var HOME = 'C:\\Users\\user';
  var cwd = DIRNAME;
  // yakalama kipinde (capture) Function/eval sarmalayıcıları kodu ikinci kez kaydetmesin: tek seferlik atlama işareti
  var skip = function (s) { if (cfg.capture) g.__peelDynSkip = s; };

  // ── tarayıcı ortamını kaldır ──
  ['window', 'self', 'top', 'parent', 'frames', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage',
    'history', 'screen', 'alert', 'prompt', 'confirm', 'open', 'addEventListener', 'removeEventListener',
    'requestAnimationFrame', 'cancelAnimationFrame', 'DOMParser', 'XMLHttpRequest', 'Image', 'Node', 'Element',
    'HTMLElement', 'HTMLCanvasElement', 'HTMLImageElement', 'HTMLInputElement', 'HTMLIFrameElement', 'HTMLScriptElement',
    'Document', 'MutationObserver', 'FileReader', 'CanvasRenderingContext2D', 'WebGLRenderingContext', 'AudioContext',
    'webkitAudioContext', 'OfflineAudioContext', 'webkitOfflineAudioContext', 'Notification', 'Worker', 'SharedWorker',
  ].forEach(function (k) { try { delete g[k]; } catch (e) { /* silinemeyen */ } });

  function preview(v) {
    if (mockSet.has(v)) return '[mock]';
    if (typeof v === 'string') return v.slice(0, 300);
    if (typeof v === 'function') return '[function]';
    if (v instanceof Uint8Array) return latin1Of(v.subarray(0, 300));
    if (v && typeof v === 'object') {
      try { var s = JSON.stringify(v); return s === undefined ? String(v) : s.slice(0, 300); } catch (e) { return '[object]'; }
    }
    return String(v);
  }
  function hostCall(op, o) {
    var r = JSON.parse(g.__peelHostNode(op, JSON.stringify(o)));
    if (!r.ok) throw new Error(r.e);
    return r;
  }

  // ── Buffer ──
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var B64REV = {};
  for (var bi = 0; bi < 64; bi++) { B64REV[B64.charCodeAt(bi)] = bi; B64REV[B64URL.charCodeAt(bi)] = bi; }
  function latin1Of(b, s, e) {
    var out = '';
    s = s || 0; e = e === undefined ? b.length : e;
    for (var i = s; i < e; i += 8192) out += String.fromCharCode.apply(null, Array.prototype.slice.call(b.subarray(i, Math.min(e, i + 8192))));
    return out;
  }
  function normEnc(e) {
    var x = String(e === undefined || e === null ? 'utf8' : e).toLowerCase();
    if (x === 'utf8' || x === 'utf-8') return 'utf8';
    if (x === 'ucs2' || x === 'ucs-2' || x === 'utf16le' || x === 'utf-16le') return 'utf16le';
    if (x === 'latin1' || x === 'binary') return 'latin1';
    if (x === 'base64' || x === 'base64url' || x === 'hex' || x === 'ascii') return x;
    return null;
  }
  function encOrThrow(e) {
    var n = normEnc(e);
    if (!n) { var err = new TypeError('Unknown encoding: ' + e); err.code = 'ERR_UNKNOWN_ENCODING'; throw err; }
    return n;
  }
  function utf8Bytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
        var cp = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else {
        if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return out;
  }
  function utf8Decode(b, s, e) {
    var units = [], out = '';
    for (var i = s; i < e;) {
      var c = b[i], need = c < 0x80 ? 0 : (c & 0xe0) === 0xc0 ? 1 : (c & 0xf0) === 0xe0 ? 2 : (c & 0xf8) === 0xf0 ? 3 : -1;
      var cp = need === 0 ? c : need === 1 ? c & 31 : need === 2 ? c & 15 : c & 7, ok = need >= 0 && i + need < e;
      for (var j = 1; ok && j <= need; j++) { if ((b[i + j] & 0xc0) !== 0x80) ok = false; else cp = (cp << 6) | (b[i + j] & 63); }
      if (ok && ((need === 1 && cp < 0x80) || (need === 2 && (cp < 0x800 || (cp >= 0xd800 && cp < 0xe000))) || (need === 3 && (cp < 0x10000 || cp > 0x10ffff)))) ok = false;
      if (!ok) { units.push(0xfffd); i++; } else {
        if (cp >= 0x10000) { cp -= 0x10000; units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); } else units.push(cp);
        i += need + 1;
      }
      if (units.length >= 8192) { out += String.fromCharCode.apply(null, units); units = []; }
    }
    return out + String.fromCharCode.apply(null, units);
  }
  function encode(s, enc) {
    s = String(s);
    switch (enc) {
      case 'utf8': return utf8Bytes(s);
      case 'latin1': case 'ascii': { var a = new Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 255; return a; }
      case 'utf16le': { var u = []; for (var k = 0; k < s.length; k++) { var c = s.charCodeAt(k); u.push(c & 255, c >> 8); } return u; }
      case 'hex': { var h = []; for (var x = 0; x + 1 < s.length; x += 2) { var v = parseInt(s.substr(x, 2), 16); if (!/^[0-9a-fA-F]{2}$/.test(s.substr(x, 2))) break; h.push(v); } return h; }
      case 'base64': case 'base64url': {
        var out = [], acc = 0, bits = 0;
        for (var p = 0; p < s.length; p++) {
          var cc = s.charCodeAt(p) & 255; // Node gibi: iki baytlık karakterlerin alt baytı
          if (cc === 61) break;
          var d = B64REV[cc];
          if (d === undefined) continue;
          acc = (acc << 6) | d; bits += 6;
          if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
        }
        return out;
      }
    }
    return [];
  }
  function decode(b, enc, s, e) {
    switch (enc) {
      case 'utf8': return utf8Decode(b, s, e);
      case 'latin1': return latin1Of(b, s, e);
      case 'ascii': { var a = ''; for (var i = s; i < e; i++) a += String.fromCharCode(b[i] & 127); return a; }
      case 'utf16le': { var u = ''; for (var k = s; k + 1 < e; k += 2) u += String.fromCharCode(b[k] | (b[k + 1] << 8)); return u; }
      case 'hex': { var h = ''; for (var x = s; x < e; x++) h += (b[x] < 16 ? '0' : '') + b[x].toString(16); return h; }
      case 'base64': case 'base64url': {
        var A = enc === 'base64' ? B64 : B64URL, out = '';
        for (var p = s; p < e; p += 3) {
          var n = (b[p] << 16) | ((p + 1 < e ? b[p + 1] : 0) << 8) | (p + 2 < e ? b[p + 2] : 0);
          out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (p + 1 < e ? A[(n >> 6) & 63] : enc === 'base64' ? '=' : '') + (p + 2 < e ? A[n & 63] : enc === 'base64' ? '=' : '');
        }
        return out;
      }
    }
    return '';
  }

  class FastBuffer extends Uint8Array {}
  function Buffer(a, b, c) { return typeof a === 'number' ? Buffer.alloc(a) : Buffer.from(a, b, c); }
  Buffer.prototype = FastBuffer.prototype;
  Object.defineProperty(FastBuffer.prototype, 'constructor', { value: Buffer, writable: true, configurable: true });
  Object.setPrototypeOf(Buffer, Uint8Array);
  Object.defineProperty(Buffer, Symbol.species, { get: function () { return FastBuffer; }, configurable: true });
  var make = function (n) { return new FastBuffer(n); };
  var fromBytes = function (arr) { var o = make(arr.length); for (var i = 0; i < arr.length; i++) o[i] = arr[i]; return o; };
  Buffer.poolSize = 8192;
  Buffer.from = function (v, encOrOff, len) {
    if (typeof v === 'string') return fromBytes(encode(v, encOrThrow(encOrOff)));
    if (v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer)) {
      var off = encOrOff >>> 0;
      return new FastBuffer(v, off, len === undefined ? v.byteLength - off : len >>> 0);
    }
    if (ArrayBuffer.isView(v)) {
      if (v instanceof Uint8Array) return fromBytes(v);
      var t = make(v.length); for (var i = 0; i < v.length; i++) t[i] = Number(v[i]) & 255; return t;
    }
    if (Array.isArray(v)) { var o = make(v.length); for (var j = 0; j < v.length; j++) o[j] = Number(v[j]) & 255; return o; }
    if (v && typeof v === 'object') {
      if (v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
      if (typeof v.length === 'number') return Buffer.from(Array.prototype.slice.call(v));
      var prim = typeof v[Symbol.toPrimitive] === 'function' ? v[Symbol.toPrimitive]('string') : v.valueOf();
      if (typeof prim === 'string' || ArrayBuffer.isView(prim)) return Buffer.from(prim, encOrOff);
    }
    var err = new TypeError('The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object.');
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  };
  Buffer.alloc = function (n, fill, enc) { var b = make(n >>> 0); if (fill !== undefined && fill !== 0) b.fill(fill, 0, b.length, enc); return b; };
  Buffer.allocUnsafe = Buffer.allocUnsafeSlow = function (n) { return make(n >>> 0); };
  Buffer.isBuffer = function (x) { return x instanceof FastBuffer; };
  Buffer.isEncoding = function (e) { return typeof e === 'string' && normEnc(e) !== null; };
  Buffer.byteLength = function (s, enc) {
    if (typeof s !== 'string') return s.byteLength !== undefined ? s.byteLength : s.length;
    return encode(s, encOrThrow(enc)).length;
  };
  Buffer.concat = function (list, total) {
    var n = total === undefined ? list.reduce(function (a, x) { return a + x.length; }, 0) : total;
    var out = make(n), o = 0;
    for (var i = 0; i < list.length && o < n; i++) { var x = list[i]; var k = Math.min(x.length, n - o); out.set(x.subarray ? x.subarray(0, k) : Array.prototype.slice.call(x, 0, k), o); o += k; }
    return out;
  };
  Buffer.compare = function (a, b) { return Buffer.prototype.compare.call(a, b); };
  Buffer.of = function () { return fromBytes(slice(arguments)); };
  var BP = FastBuffer.prototype;
  BP.toString = function (enc, s, e) {
    s = Math.max(0, s >>> 0); e = e === undefined ? this.length : Math.min(this.length, e >>> 0);
    if (e <= s) return '';
    return decode(this, encOrThrow(enc), s, e);
  };
  BP.toLocaleString = BP.toString;
  BP.toJSON = function () { return { type: 'Buffer', data: Array.prototype.slice.call(this) }; };
  BP.equals = function (o) { if (this.length !== o.length) return false; for (var i = 0; i < o.length; i++) if (this[i] !== o[i]) return false; return true; };
  BP.compare = function (o) {
    var n = Math.min(this.length, o.length);
    for (var i = 0; i < n; i++) if (this[i] !== o[i]) return this[i] < o[i] ? -1 : 1;
    return this.length === o.length ? 0 : this.length < o.length ? -1 : 1;
  };
  BP.slice = function (s, e) { return this.subarray(s, e); };
  var needle = function (v, enc) { return typeof v === 'number' ? [v & 255] : typeof v === 'string' ? encode(v, encOrThrow(enc)) : v; };
  BP.indexOf = function (v, from, enc) {
    if (typeof from === 'string') { enc = from; from = 0; }
    var n = needle(v, enc), start = from === undefined ? 0 : from < 0 ? Math.max(0, this.length + from) : from;
    outer: for (var i = start; i <= this.length - n.length; i++) { for (var j = 0; j < n.length; j++) if (this[i + j] !== n[j]) continue outer; return i; }
    return -1;
  };
  BP.lastIndexOf = function (v, from, enc) {
    var n = needle(v, enc), start = from === undefined ? this.length - n.length : Math.min(from, this.length - n.length);
    outer: for (var i = start; i >= 0; i--) { for (var j = 0; j < n.length; j++) if (this[i + j] !== n[j]) continue outer; return i; }
    return -1;
  };
  BP.includes = function (v, from, enc) { return this.indexOf(v, from, enc) !== -1; };
  BP.write = function (s, off, len, enc) {
    if (typeof off === 'string') { enc = off; off = 0; len = undefined; } else if (typeof len === 'string') { enc = len; len = undefined; }
    off = off >>> 0;
    var bytes = encode(s, encOrThrow(enc)), n = Math.min(bytes.length, this.length - off, len === undefined ? Infinity : len);
    for (var i = 0; i < n; i++) this[off + i] = bytes[i];
    return n;
  };
  BP.copy = function (target, ts, ss, se) {
    ts = ts >>> 0; ss = ss >>> 0; se = se === undefined ? this.length : Math.min(se, this.length);
    var n = Math.max(0, Math.min(se - ss, target.length - ts));
    for (var i = 0; i < n; i++) target[ts + i] = this[ss + i];
    return n;
  };
  var u8fill = Uint8Array.prototype.fill;
  BP.fill = function (v, s, e, enc) {
    if (typeof s === 'string') { enc = s; s = 0; e = this.length; }
    s = s === undefined ? 0 : s >>> 0; e = e === undefined ? this.length : e >>> 0;
    if (typeof v === 'number') return u8fill.call(this, v & 255, s, e);
    var pat = needle(v, enc);
    if (!pat.length) return u8fill.call(this, 0, s, e);
    for (var i = s, j = 0; i < e; i++, j = (j + 1) % pat.length) this[i] = pat[j];
    return this;
  };
  BP.swap16 = function () { for (var i = 0; i + 1 < this.length; i += 2) { var t = this[i]; this[i] = this[i + 1]; this[i + 1] = t; } return this; };
  BP.reverse = function () { Uint8Array.prototype.reverse.call(this); return this; };
  BP.inspect = function () { return '<Buffer ' + Array.prototype.map.call(this.subarray(0, 50), function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join(' ') + (this.length > 50 ? ' ... ' : '') + '>'; };
  (function () {
    var view = function (b) { return new DataView(b.buffer, b.byteOffset, b.byteLength); };
    var spec = [['UInt8', 'Uint8', 1], ['Int8', 'Int8', 1], ['UInt16', 'Uint16', 2], ['Int16', 'Int16', 2], ['UInt32', 'Uint32', 4],
      ['Int32', 'Int32', 4], ['Float', 'Float32', 4], ['Double', 'Float64', 8], ['BigUInt64', 'BigUint64', 8], ['BigInt64', 'BigInt64', 8]];
    spec.forEach(function (s) {
      var name = s[0], dv = s[1], single = s[2] === 1;
      (single ? [''] : ['LE', 'BE']).forEach(function (end) {
        var le = end === 'LE';
        var rd = function (off) { off = off === undefined ? 0 : off; if (off < 0 || off + s[2] > this.length) { var e = new RangeError('The value of "offset" is out of range.'); e.code = 'ERR_OUT_OF_RANGE'; throw e; } return view(this)['get' + dv](off, le); };
        var wr = function (v, off) { off = off === undefined ? 0 : off; view(this)['set' + dv](off, v, le); return off + s[2]; };
        BP['read' + name + end] = rd; BP['write' + name + end] = wr;
        if (name.indexOf('UInt') >= 0) { BP['read' + name.replace('UInt', 'Uint') + end] = rd; BP['write' + name.replace('UInt', 'Uint') + end] = wr; }
      });
    });
    var rdN = function (le, signed) {
      return function (off, n) {
        var v = 0;
        for (var i = 0; i < n; i++) v = v * 256 + this[off + (le ? n - 1 - i : i)];
        return signed && v >= Math.pow(2, 8 * n - 1) ? v - Math.pow(2, 8 * n) : v;
      };
    };
    var wrN = function (le) {
      return function (v, off, n) {
        v = v < 0 ? v + Math.pow(2, 8 * n) : v;
        for (var i = 0; i < n; i++) { this[off + (le ? i : n - 1 - i)] = v % 256; v = Math.floor(v / 256); }
        return off + n;
      };
    };
    BP.readUIntLE = BP.readUintLE = rdN(true, false); BP.readUIntBE = BP.readUintBE = rdN(false, false);
    BP.readIntLE = rdN(true, true); BP.readIntBE = rdN(false, true);
    BP.writeUIntLE = BP.writeUintLE = BP.writeIntLE = wrN(true); BP.writeUIntBE = BP.writeUintBE = BP.writeIntBE = wrN(false);
  })();
  var toBuf = function (d, enc) { return Buffer.isBuffer(d) ? d : typeof d === 'string' ? Buffer.from(d, enc) : Buffer.from(d); };
  var fromLatin1 = function (s) { var o = make(s.length); for (var i = 0; i < s.length; i++) o[i] = s.charCodeAt(i); return o; };

  // ── EventEmitter ──
  function EventEmitter() { EventEmitter.init.call(this); }
  EventEmitter.init = function () { if (!this._events || this._events === Object.getPrototypeOf(this)._events) { this._events = Object.create(null); } };
  var EP = EventEmitter.prototype;
  EP._events = undefined;
  EP._maxListeners = undefined;
  var evs = function (self) { if (!self._events) self._events = Object.create(null); return self._events; };
  EP.on = EP.addListener = function (type, fn) {
    if (typeof fn !== 'function') throw new TypeError('The "listener" argument must be of type function');
    if (evs(this).newListener && type !== 'newListener') this.emit('newListener', type, fn.listener || fn);
    (evs(this)[type] = evs(this)[type] || []).push(fn);
    return this;
  };
  EP.prependListener = function (type, fn) { (evs(this)[type] = evs(this)[type] || []).unshift(fn); return this; };
  var onceWrap = function (self, type, fn) { var w = function () { self.removeListener(type, w); return fn.apply(this, arguments); }; w.listener = fn; return w; };
  EP.once = function (type, fn) { return this.on(type, onceWrap(this, type, fn)); };
  EP.prependOnceListener = function (type, fn) { return this.prependListener(type, onceWrap(this, type, fn)); };
  EP.off = EP.removeListener = function (type, fn) {
    var l = evs(this)[type];
    if (!l) return this;
    for (var i = l.length - 1; i >= 0; i--) if (l[i] === fn || l[i].listener === fn) { l.splice(i, 1); break; }
    if (!l.length) delete evs(this)[type];
    return this;
  };
  EP.removeAllListeners = function (type) { if (type === undefined) this._events = Object.create(null); else delete evs(this)[type]; return this; };
  EP.emit = function (type) {
    var l = evs(this)[type], args = slice(arguments, 1);
    if (!l || !l.length) {
      if (type === 'error') throw args[0] instanceof Error ? args[0] : new Error('Unhandled error. (' + preview(args[0]) + ')');
      return false;
    }
    l = l.slice();
    for (var i = 0; i < l.length; i++) l[i].apply(this, args);
    return true;
  };
  EP.listeners = function (t) { return (evs(this)[t] || []).map(function (f) { return f.listener || f; }); };
  EP.rawListeners = function (t) { return (evs(this)[t] || []).slice(); };
  EP.listenerCount = function (t) { return (evs(this)[t] || []).length; };
  EP.eventNames = function () { return Reflect.ownKeys(evs(this)); };
  EP.setMaxListeners = function (n) { this._maxListeners = n; return this; };
  EP.getMaxListeners = function () { return this._maxListeners === undefined ? 10 : this._maxListeners; };
  EventEmitter.EventEmitter = EventEmitter;
  EventEmitter.defaultMaxListeners = 10;
  EventEmitter.errorMonitor = Symbol('events.errorMonitor');
  EventEmitter.captureRejections = false;
  EventEmitter.once = function (em, name) { return new Promise(function (res, rej) { em.once(name, function () { res(slice(arguments)); }); if (name !== 'error') em.once('error', rej); }); };
  EventEmitter.listenerCount = function (em, t) { return em.listenerCount(t); };
  EventEmitter.setMaxListeners = function () {};
  var inherits = function (C, S) { Object.setPrototypeOf(C.prototype, S.prototype); Object.setPrototypeOf(C, S); C.super_ = S; };
  var emitter = function () { var e = new EventEmitter(); return e; };

  // ── akışlar ──
  function Stream(opts) { EventEmitter.call(this); this._opts = opts || {}; this.readable = true; this.writable = true; this.destroyed = false; }
  inherits(Stream, EventEmitter);
  Stream.prototype.pipe = function (dest) {
    var self = this;
    this.on('data', function (c) { if (dest && typeof dest.write === 'function') dest.write(c); });
    this.on('end', function () { if (dest && typeof dest.end === 'function' && dest !== proc.stdout && dest !== proc.stderr) dest.end(); });
    if (dest && typeof dest.emit === 'function') later(function () { dest.emit('pipe', self); });
    return dest;
  };
  Stream.prototype.unpipe = function () { return this; };
  function Readable(opts) { Stream.call(this, opts); this._enc = null; this._flowing = null; if (opts && typeof opts.read === 'function') this._read = opts.read; }
  inherits(Readable, Stream);
  var RP = Readable.prototype;
  RP.push = function (chunk, enc) {
    if (chunk === null) { var self = this; later(function () { self.readableEnded = true; self.emit('end'); self.emit('close'); }); return false; }
    var c = this._enc ? (typeof chunk === 'string' ? chunk : toBuf(chunk, enc).toString(this._enc)) : typeof chunk === 'string' && !this._opts.objectMode ? Buffer.from(chunk, enc) : chunk;
    this.emit('data', c);
    return true;
  };
  RP.setEncoding = function (e) { this._enc = encOrThrow(e); return this; };
  RP.read = function () { return null; };
  RP.resume = function () { this._flowing = true; return this; };
  RP.pause = function () { this._flowing = false; return this; };
  RP.isPaused = function () { return this._flowing === false; };
  RP.destroy = function (err) { this.destroyed = true; var self = this; later(function () { if (err && self.listenerCount('error')) self.emit('error', err); self.emit('close'); }); return this; };
  RP.unshift = function () {};
  RP.wrap = function () { return this; };
  RP[Symbol.asyncIterator] = function () {
    var self = this, queue = [], done = false, waiting = null;
    self.on('data', function (c) { if (waiting) { var w = waiting; waiting = null; w({ value: c, done: false }); } else queue.push(c); });
    self.on('end', function () { done = true; if (waiting) { var w = waiting; waiting = null; w({ value: undefined, done: true }); } });
    return { next: function () { if (queue.length) return Promise.resolve({ value: queue.shift(), done: false }); if (done) return Promise.resolve({ value: undefined, done: true }); return new Promise(function (r) { waiting = r; }); }, return: function () { return Promise.resolve({ done: true }); } };
  };
  Readable.from = function (it) { var r = new Readable({ objectMode: true }); later(function () { try { for (var x of it) r.push(x); } catch (e) { /* yinelenemeyen */ } r.push(null); }); return r; };
  function Writable(opts) { Stream.call(this, opts); this.readable = false; this._chunks = []; this.writableEnded = false; }
  inherits(Writable, Stream);
  var WP = Writable.prototype;
  WP._sink = function (chunk) { this._chunks.push(chunk); };
  WP.write = function (chunk, enc, cb) {
    if (typeof enc === 'function') { cb = enc; enc = undefined; }
    if (this._opts && typeof this._opts.write === 'function') this._opts.write.call(this, chunk, enc, function () {});
    else this._sink(chunk, enc);
    if (typeof cb === 'function') later(cb);
    return true;
  };
  WP.end = function (chunk, enc, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = undefined; } else if (typeof enc === 'function') { cb = enc; enc = undefined; }
    if (chunk !== undefined && chunk !== null) this.write(chunk, enc);
    if (this.writableEnded) return this;
    this.writableEnded = true;
    var self = this;
    later(function () { self.emit('finish'); self.emit('close'); if (typeof cb === 'function') cb(); });
    return this;
  };
  WP.cork = WP.uncork = function () {};
  WP.close = function (cb) { var self = this; later(function () { self.emit('close'); if (typeof cb === 'function') cb(); }); };
  WP.setDefaultEncoding = function () { return this; };
  WP.destroy = RP.destroy;
  function Duplex(opts) { Readable.call(this, opts); this.writable = true; this._chunks = []; }
  inherits(Duplex, Readable);
  ['write', 'end', 'cork', 'uncork', 'setDefaultEncoding', '_sink'].forEach(function (k) { Duplex.prototype[k] = WP[k]; });
  function Transform(opts) { Duplex.call(this, opts); var self = this; if (opts && typeof opts.transform === 'function') this._transform = opts.transform; this.on('finish', function () { later(function () { self.push(null); }); }); }
  inherits(Transform, Duplex);
  Transform.prototype._transform = function (c, e, cb) { cb(null, c); };
  Transform.prototype._sink = function (chunk, enc) { var self = this; this._transform(chunk, enc, function (err, out) { if (out !== undefined && out !== null) self.push(out); }); };
  function PassThrough(opts) { Transform.call(this, opts); }
  inherits(PassThrough, Transform);
  var streamMod = Stream;
  Object.assign(Stream, { Stream: Stream, Readable: Readable, Writable: Writable, Duplex: Duplex, Transform: Transform, PassThrough: PassThrough,
    pipeline: function () { var a = slice(arguments), cb = typeof a[a.length - 1] === 'function' ? a.pop() : null; for (var i = 0; i + 1 < a.length; i++) a[i].pipe(a[i + 1]); if (cb) later(function () { cb(null); }); return a[a.length - 1]; },
    finished: function (s, cb) { if (typeof cb === 'function') later(function () { cb(null); }); },
  });
  Stream.promises = { pipeline: function () { Stream.pipeline.apply(null, slice(arguments)); return Promise.resolve(); }, finished: function () { return Promise.resolve(); } };

  // ── path (posix + win32; varsayılan win32 çünkü platform 'win32') ──
  function normParts(parts, abs) {
    var out = [];
    parts.forEach(function (p) {
      if (!p || p === '.') return;
      if (p === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); } else out.push(p);
    });
    return out;
  }
  var assertPath = function (p) { if (typeof p !== 'string') { var e = new TypeError('The "path" argument must be of type string. Received ' + (p === null ? 'null' : typeof p)); e.code = 'ERR_INVALID_ARG_TYPE'; throw e; } };
  var posix = {
    sep: '/', delimiter: ':',
    normalize: function (p) {
      assertPath(p);
      if (!p) return '.';
      var abs = p[0] === '/', trail = p[p.length - 1] === '/';
      var r = normParts(p.split('/'), abs).join('/');
      if (!r && !abs) r = '.';
      if (r && trail) r += '/';
      return (abs ? '/' : '') + r;
    },
    join: function () { var a = slice(arguments); a.forEach(assertPath); var j = a.filter(function (x) { return x; }).join('/'); return j ? posix.normalize(j) : '.'; },
    resolve: function () {
      var r = '', abs = false;
      for (var i = arguments.length - 1; i >= -1 && !abs; i--) { var p = i >= 0 ? arguments[i] : cwd.replace(/\\/g, '/'); assertPath(p); if (!p) continue; r = p + '/' + r; abs = p[0] === '/'; }
      r = normParts(r.split('/'), abs).join('/');
      return (abs ? '/' : '') + r || '.';
    },
    isAbsolute: function (p) { assertPath(p); return p[0] === '/'; },
    dirname: function (p) {
      assertPath(p);
      if (!p) return '.';
      var s = p.replace(/\/+$/, ''), i = s.lastIndexOf('/');
      if (i < 0) return '.';
      return i === 0 ? '/' : s.slice(0, i).replace(/\/+$/, '') || '/';
    },
    basename: function (p, ext) { assertPath(p); var b = p.replace(/\/+$/, ''); b = b.slice(b.lastIndexOf('/') + 1); if (ext && b !== ext && b.slice(-ext.length) === ext) b = b.slice(0, -ext.length); return b; },
    extname: function (p) { assertPath(p); var b = posix.basename(p), i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); },
    relative: function (from, to) {
      var f = posix.resolve(from).split('/').filter(Boolean), t = posix.resolve(to).split('/').filter(Boolean), i = 0;
      while (i < f.length && i < t.length && f[i] === t[i]) i++;
      return f.slice(i).map(function () { return '..'; }).concat(t.slice(i)).join('/');
    },
    parse: function (p) { assertPath(p); var base = posix.basename(p), ext = posix.extname(p); return { root: p[0] === '/' ? '/' : '', dir: p.indexOf('/') >= 0 ? posix.dirname(p) : '', base: base, ext: ext, name: ext ? base.slice(0, -ext.length) : base }; },
    format: function (o) { var dir = o.dir || o.root || '', base = o.base || (o.name || '') + (o.ext || ''); return dir ? (dir === o.root ? dir + base : dir + '/' + base) : base; },
    toNamespacedPath: function (p) { return p; },
  };
  var drive = function (p) { var m = /^([a-zA-Z]:)?([\s\S]*)$/.exec(p); return { d: m[1] || '', r: m[2].replace(/\\/g, '/') }; };
  var bs = function (p) { return p.replace(/\//g, '\\'); };
  var win32 = {
    sep: '\\', delimiter: ';',
    normalize: function (p) { assertPath(p); var x = drive(p); var n = x.r ? posix.normalize(x.r) : '.'; return x.d + bs(x.d && n === '.' ? '' : n) || '.'; },
    join: function () { var a = slice(arguments); a.forEach(assertPath); var j = a.filter(function (x) { return x; }).join('\\'); return j ? win32.normalize(j) : '.'; },
    resolve: function () {
      var parts = [], d = '';
      for (var i = arguments.length - 1; i >= -1; i--) {
        var p = i >= 0 ? arguments[i] : cwd;
        assertPath(p);
        if (!p) continue;
        var x = drive(p);
        if (d && x.d && x.d.toLowerCase() !== d.toLowerCase()) continue;
        if (!d) d = x.d;
        parts.unshift(x.r);
        if (x.r[0] === '/') break;
      }
      return d + bs('/' + normParts(parts.join('/').split('/'), true).join('/'));
    },
    isAbsolute: function (p) { assertPath(p); return /^([a-zA-Z]:)?[\\/]/.test(p); },
    dirname: function (p) { var x = drive(p); var r = posix.dirname(x.r); return x.d + bs(r === '.' && x.d ? '' : r); },
    basename: function (p, ext) { return posix.basename(drive(p).r, ext); },
    extname: function (p) { return posix.extname(drive(p).r); },
    relative: function (a, b) { return bs(posix.relative(drive(win32.resolve(a)).r, drive(win32.resolve(b)).r)); },
    parse: function (p) { var x = drive(p), o = posix.parse(x.r); return { root: x.d + bs(o.root), dir: o.dir ? x.d + bs(o.dir) : x.d, base: o.base, ext: o.ext, name: o.name }; },
    format: function (o) { return bs(posix.format(o)); },
    toNamespacedPath: function (p) { return p; },
  };
  posix.posix = win32.posix = posix;
  posix.win32 = win32.win32 = win32;
  var pathMod = win32;
  var dirOf = function (f) { return posix.dirname(String(f).replace(/\\/g, '/')); };

  // ── URL / URLSearchParams / querystring ──
  var formEnc = function (s) { return encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()~]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); }); };
  var formDec = function (s) { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return s; } };
  function URLSearchParams(init) {
    if (!(this instanceof URLSearchParams)) throw new TypeError("Class constructor URLSearchParams cannot be invoked without 'new'");
    this._list = []; this._url = null;
    var self = this;
    if (typeof init === 'string') self._parse(init);
    else if (init instanceof URLSearchParams) self._list = init._list.map(function (p) { return p.slice(); });
    else if (Array.isArray(init)) init.forEach(function (p) { self._list.push([String(p[0]), String(p[1])]); });
    else if (init && typeof init === 'object') Object.keys(init).forEach(function (k) { self._list.push([k, String(init[k])]); });
  }
  var SP = URLSearchParams.prototype;
  SP._parse = function (s) { var self = this; self._list = []; s.replace(/^\?/, '').split('&').forEach(function (kv) { if (!kv) return; var i = kv.indexOf('='); self._list.push(i < 0 ? [formDec(kv), ''] : [formDec(kv.slice(0, i)), formDec(kv.slice(i + 1))]); }); };
  SP._sync = function () { if (this._url) { var s = this.toString(); this._url._search = s ? '?' + s : ''; } };
  SP.append = function (k, v) { this._list.push([String(k), String(v)]); this._sync(); };
  SP.delete = function (k) { this._list = this._list.filter(function (p) { return p[0] !== k; }); this._sync(); };
  SP.get = function (k) { for (var i = 0; i < this._list.length; i++) if (this._list[i][0] === k) return this._list[i][1]; return null; };
  SP.getAll = function (k) { return this._list.filter(function (p) { return p[0] === k; }).map(function (p) { return p[1]; }); };
  SP.has = function (k) { return this._list.some(function (p) { return p[0] === k; }); };
  SP.set = function (k, v) { var i = this._list.findIndex(function (p) { return p[0] === k; }); if (i < 0) this._list.push([String(k), String(v)]); else { this._list[i][1] = String(v); this._list = this._list.filter(function (p, j) { return j <= i || p[0] !== k; }); } this._sync(); };
  SP.sort = function () { this._list.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; }); this._sync(); };
  SP.forEach = function (fn, self) { this._list.forEach(function (p) { fn.call(self, p[1], p[0], this); }, this); };
  SP.keys = function () { return this._list.map(function (p) { return p[0]; })[Symbol.iterator](); };
  SP.values = function () { return this._list.map(function (p) { return p[1]; })[Symbol.iterator](); };
  SP.entries = SP[Symbol.iterator] = function () { return this._list.map(function (p) { return p.slice(); })[Symbol.iterator](); };
  SP.toString = function () { return this._list.map(function (p) { return formEnc(p[0]) + '=' + formEnc(p[1]); }).join('&'); };
  Object.defineProperty(SP, 'size', { get: function () { return this._list.length; } });
  var PORTS = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21' };
  var URL_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(?:\/\/(?:([^:@/?#]*)(?::([^@/?#]*))?@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d*))?)?([^?#]*)(\?[^#]*)?(#[\s\S]*)?$/;
  function URLImpl(input, base) {
    if (!(this instanceof URLImpl)) throw new TypeError("Class constructor URL cannot be invoked without 'new'");
    var s = String(input && input.href !== undefined ? input.href : input).trim();
    var m = URL_RE.exec(s);
    if (!m || (PORTS[m[1].toLowerCase()] && m[4] === undefined)) {
      if (base === undefined) { var e = new TypeError('Invalid URL'); e.code = 'ERR_INVALID_URL'; e.input = s; throw e; }
      var b = base instanceof URLImpl ? base : new URLImpl(base);
      var origin = b.protocol + '//' + (b.username ? b.username + (b.password ? ':' + b.password : '') + '@' : '') + b.host;
      if (s.slice(0, 2) === '//') s = b.protocol + s;
      else if (s[0] === '/') s = origin + s;
      else if (s[0] === '?') s = origin + b.pathname + s;
      else if (s[0] === '#') s = origin + b.pathname + b.search + s;
      else s = origin + b.pathname.replace(/[^/]*$/, '') + s;
      m = URL_RE.exec(s);
      if (!m) { var e2 = new TypeError('Invalid URL'); e2.code = 'ERR_INVALID_URL'; throw e2; }
    }
    this.protocol = m[1].toLowerCase();
    this.username = m[2] || ''; this.password = m[3] || '';
    this.hostname = (m[4] || '').toLowerCase();
    this.port = m[5] && m[5] !== PORTS[this.protocol] ? m[5] : '';
    var special = Boolean(PORTS[this.protocol]) || this.protocol === 'file:';
    var segs = (m[6] || '').replace(/\\/g, special ? '/' : '\\').split('/'), out = [];
    segs.forEach(function (x, i) { if (x === '..') { if (out.length > 1) out.pop(); } else if (x !== '.' || i === 0) out.push(x); });
    if (segs.length && (segs[segs.length - 1] === '.' || segs[segs.length - 1] === '..')) out.push('');
    this.pathname = out.join('/') || (special ? '/' : '');
    if (special && this.pathname[0] !== '/') this.pathname = '/' + this.pathname;
    this._search = m[7] && m[7] !== '?' ? m[7] : '';
    this.hash = m[8] && m[8] !== '#' ? m[8] : '';
    this.searchParams = new URLSearchParams(this._search);
    this.searchParams._url = this;
  }
  var UP = URLImpl.prototype;
  Object.defineProperties(UP, {
    search: { get: function () { return this._search; }, set: function (v) { v = String(v); this._search = v && v[0] !== '?' ? '?' + v : v === '?' ? '' : v; this.searchParams._parse(this._search); }, enumerable: true },
    host: { get: function () { return this.hostname + (this.port ? ':' + this.port : ''); }, enumerable: true },
    origin: { get: function () { return PORTS[this.protocol] ? this.protocol + '//' + this.host : 'null'; }, enumerable: true },
    href: {
      get: function () { return this.protocol + (this.hostname || PORTS[this.protocol] || this.protocol === 'file:' ? '//' : '') + (this.username ? this.username + (this.password ? ':' + this.password : '') + '@' : '') + this.host + this.pathname + this._search + this.hash; },
      set: function (v) { var n = new URLImpl(v); var self = this; ['protocol', 'username', 'password', 'hostname', 'port', 'pathname', '_search', 'hash'].forEach(function (k) { self[k] = n[k]; }); this.searchParams._parse(this._search); },
      enumerable: true,
    },
  });
  UP.toString = UP.toJSON = function () { return this.href; };
  URLImpl.canParse = function (u, b) { try { new URLImpl(u, b); return true; } catch (e) { return false; } };
  if (g.URL && g.URL.createObjectURL) { URLImpl.createObjectURL = g.URL.createObjectURL; URLImpl.revokeObjectURL = g.URL.revokeObjectURL; }
  g.URL = URLImpl;
  g.URLSearchParams = URLSearchParams;
  var querystring = {
    escape: function (s) { return encodeURIComponent(s); },
    unescape: function (s) { return formDec(s); },
    parse: function (s, sep, eq) {
      var out = {};
      String(s || '').split(sep || '&').forEach(function (kv) {
        if (!kv) return;
        var i = kv.indexOf(eq || '='), k = formDec(i < 0 ? kv : kv.slice(0, i)), v = i < 0 ? '' : formDec(kv.slice(i + 1));
        if (!hasOwn(out, k)) out[k] = v; else if (Array.isArray(out[k])) out[k].push(v); else out[k] = [out[k], v];
      });
      return out;
    },
    stringify: function (o, sep, eq) {
      return Object.keys(o || {}).map(function (k) {
        var v = o[k], e = function (x) { return encodeURIComponent(k) + (eq || '=') + encodeURIComponent(x === undefined || x === null ? '' : typeof x === 'object' ? '' : String(x)); };
        return Array.isArray(v) ? v.map(e).join(sep || '&') : e(v);
      }).join(sep || '&');
    },
  };
  querystring.decode = querystring.parse; querystring.encode = querystring.stringify;
  var urlMod = {
    URL: URLImpl, URLSearchParams: URLSearchParams,
    parse: function (s, parseQuery) {
      var u;
      try { u = new URLImpl(s); } catch (e) { var p = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(String(s)); return { protocol: null, slashes: null, auth: null, host: null, port: null, hostname: null, hash: p[3] || null, search: p[2] || null, query: parseQuery ? querystring.parse((p[2] || '').slice(1)) : (p[2] || '').slice(1) || null, pathname: p[1] || null, path: p[1] + (p[2] || ''), href: String(s) }; }
      return { protocol: u.protocol, slashes: true, auth: u.username ? u.username + (u.password ? ':' + u.password : '') : null, host: u.host, port: u.port || null, hostname: u.hostname, hash: u.hash || null, search: u.search || null, query: parseQuery ? querystring.parse(u.search.slice(1)) : u.search.slice(1) || null, pathname: u.pathname, path: u.pathname + u.search, href: u.href };
    },
    format: function (o) { if (o instanceof URLImpl) return o.href; if (typeof o === 'string') return o; var q = o.search || (o.query && typeof o.query === 'object' ? '?' + querystring.stringify(o.query) : ''); return (o.protocol ? o.protocol.replace(/:?$/, ':') + '//' : '') + (o.auth ? o.auth + '@' : '') + (o.host || (o.hostname || '') + (o.port ? ':' + o.port : '')) + (o.pathname || '') + q + (o.hash || ''); },
    resolve: function (from, to) { try { return new URLImpl(to, new URLImpl(from, 'resolve://')).href.replace(/^resolve:\/\//, ''); } catch (e) { return to; } },
    fileURLToPath: function (u) { var x = typeof u === 'string' ? new URLImpl(u) : u; return decodeURIComponent(x.pathname).replace(/^\/([a-zA-Z]:)/, '$1'); },
    pathToFileURL: function (p) { return new URLImpl('file://' + (String(p)[0] === '/' ? '' : '/') + String(p).replace(/\\/g, '/')); },
    domainToASCII: function (d) { return String(d); }, domainToUnicode: function (d) { return String(d); },
  };

  // ── util ──
  var CUSTOM = Symbol.for('nodejs.util.promisify.custom');
  var INSPECT = Symbol.for('nodejs.util.inspect.custom');
  function inspect(v, opts, depth) {
    depth = depth || 0;
    if (typeof v === 'string') return depth ? "'" + v + "'" : v;
    if (typeof v === 'function') return '[Function: ' + (v.name || '(anonymous)') + ']';
    if (typeof v === 'bigint') return String(v) + 'n';
    if (v === null || typeof v !== 'object') return String(v);
    if (mockSet.has(v)) return '[mock]';
    if (typeof v[INSPECT] === 'function') return String(v[INSPECT](depth, opts || {}));
    if (Buffer.isBuffer(v)) return v.inspect();
    if (v instanceof Error) return v.stack || String(v);
    if (depth > 2) return Array.isArray(v) ? '[Array]' : '[Object]';
    if (Array.isArray(v)) return '[ ' + v.slice(0, 100).map(function (x) { return inspect(x, opts, depth + 1); }).join(', ') + ' ]';
    var keys = Object.keys(v);
    return keys.length ? '{ ' + keys.slice(0, 100).map(function (k) { return k + ': ' + inspect(v[k], opts, depth + 1); }).join(', ') + ' }' : '{}';
  }
  inspect.custom = INSPECT;
  function format(f) {
    var args = slice(arguments, 1), i = 0, s;
    if (typeof f !== 'string') { args.unshift(f); s = ''; } else {
      s = f.replace(/%([sdifjoOc%])/g, function (m, c) {
        if (c === '%') return '%';
        if (i >= args.length) return m;
        var a = args[i++];
        switch (c) {
          case 's': return typeof a === 'string' ? a : inspect(a);
          case 'd': case 'i': { var n = Number(a); return String(c === 'i' ? Math.trunc(n) : n); }
          case 'f': return String(parseFloat(a));
          case 'j': try { return JSON.stringify(a); } catch (e) { return '[Circular]'; }
          case 'c': return '';
          default: return inspect(a);
        }
      });
      args = args.slice(i);
    }
    return [s].concat(args.map(function (a) { return typeof a === 'string' ? a : inspect(a); })).filter(function (x, k) { return k > 0 || x !== '' || !args.length; }).join(' ');
  }
  function promisify(fn) {
    if (typeof fn !== 'function') throw new TypeError('The "original" argument must be of type function');
    if (typeof fn[CUSTOM] === 'function') return fn[CUSTOM];
    var p = function () {
      var self = this, args = slice(arguments);
      return new Promise(function (res, rej) { fn.apply(self, args.concat([function (err, v) { if (err) rej(err); else res(v); }])); });
    };
    Object.setPrototypeOf(p, Object.getPrototypeOf(fn));
    return p;
  }
  promisify.custom = CUSTOM;
  function TextDecoderNode(enc, opts) { this.encoding = String(enc || 'utf-8').toLowerCase(); this._enc = encOrThrow(this.encoding === 'utf-16le' ? 'utf16le' : this.encoding === 'iso-8859-1' || this.encoding === 'windows-1252' ? 'latin1' : this.encoding); this.fatal = Boolean(opts && opts.fatal); }
  TextDecoderNode.prototype.decode = function (b) { if (b === undefined) return ''; var u = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength); var s = decode(u, this._enc, 0, u.length); return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; };
  function TextEncoderNode() { this.encoding = 'utf-8'; }
  TextEncoderNode.prototype.encode = function (s) { return Uint8Array.from(utf8Bytes(String(s === undefined ? '' : s))); };
  TextEncoderNode.prototype.encodeInto = function (s, dst) { var b = utf8Bytes(String(s)), n = Math.min(b.length, dst.length); for (var i = 0; i < n; i++) dst[i] = b[i]; return { read: s.length, written: n }; };
  g.TextDecoder = TextDecoderNode;
  g.TextEncoder = TextEncoderNode;
  var typeTag = function (v) { return Object.prototype.toString.call(v).slice(8, -1); };
  var util = {
    format: format, formatWithOptions: function (o) { return format.apply(null, slice(arguments, 1)); }, inspect: inspect, promisify: promisify, inherits: inherits,
    callbackify: function (fn) { return function () { var a = slice(arguments), cb = a.pop(); fn.apply(this, a).then(function (v) { cb(null, v); }, function (e) { cb(e); }); }; },
    deprecate: function (fn) { return fn; }, debuglog: function () { return function () {}; }, debug: function () { return function () {}; },
    isDeepStrictEqual: function (a, b) { try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return a === b; } },
    isArray: Array.isArray, isBuffer: Buffer.isBuffer, isString: function (v) { return typeof v === 'string'; }, isNumber: function (v) { return typeof v === 'number'; },
    isFunction: function (v) { return typeof v === 'function'; }, isObject: function (v) { return v !== null && typeof v === 'object'; }, isUndefined: function (v) { return v === undefined; },
    isNullOrUndefined: function (v) { return v == null; }, isPrimitive: function (v) { return v === null || (typeof v !== 'object' && typeof v !== 'function'); },
    isRegExp: function (v) { return v instanceof RegExp; }, isDate: function (v) { return v instanceof Date; }, isError: function (v) { return v instanceof Error; },
    types: {
      isPromise: function (v) { return v instanceof Promise; }, isRegExp: function (v) { return v instanceof RegExp; }, isDate: function (v) { return v instanceof Date; },
      isUint8Array: function (v) { return v instanceof Uint8Array; }, isTypedArray: function (v) { return ArrayBuffer.isView(v) && !(v instanceof DataView); },
      isAnyArrayBuffer: function (v) { return v instanceof ArrayBuffer; }, isArrayBuffer: function (v) { return v instanceof ArrayBuffer; }, isProxy: function () { return false; },
      isAsyncFunction: function (v) { return typeTag(v) === 'AsyncFunction'; }, isGeneratorFunction: function (v) { return /GeneratorFunction$/.test(typeTag(v)); },
      isNativeError: function (v) { return v instanceof Error; }, isMap: function (v) { return v instanceof Map; }, isSet: function (v) { return v instanceof Set; },
    },
    TextDecoder: TextDecoderNode, TextEncoder: TextEncoderNode,
    stripVTControlCharacters: function (s) { return String(s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''); },
    toUSVString: function (s) { return String(s); }, parseArgs: function () { return { values: {}, positionals: [] }; },
  };

  // ── sanal dosya sistemi ──
  function pathStr(p) {
    if (p instanceof URLImpl) return urlMod.fileURLToPath(p);
    if (p instanceof Uint8Array) return Buffer.from(p).toString();
    if (typeof p === 'number') return 'fd:' + p;
    if (typeof p !== 'string') assertPath(p);
    return p;
  }
  function vkey(p) {
    var s = pathStr(p).replace(/\\/g, '/');
    if (/^[a-zA-Z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1);
    else if (s[0] !== '/') s = cwd.replace(/\\/g, '/') + '/' + s;
    var d = /^[A-Z]:/.test(s) ? s.slice(0, 2) : '';
    var n = posix.normalize(s.slice(d.length) || '/');
    return d + (n.length > 1 ? n.replace(/\/$/, '') : n);
  }
  var files = Object.create(null);
  var dirs = Object.create(null);
  var addDirs = function (k) { var d = k; while (true) { var i = d.lastIndexOf('/'); if (i < 0) break; d = d.slice(0, i) || (/^[A-Z]:/.test(k) ? '' : '/'); if (!d) break; dirs[d] = true; if (d === '/' || /^[A-Z]:$/.test(d)) break; } };
  var SELF = vkey(FILENAME);
  if (typeof ncfg.source === 'string') files[SELF] = Buffer.from(ncfg.source);
  Object.keys(ncfg.files || {}).forEach(function (p) { files[vkey(p)] = Buffer.from(String(ncfg.files[p])); });
  Object.keys(files).forEach(addDirs);
  dirs['/'] = dirs['/app'] = dirs['C:'] = dirs['C:/Users'] = dirs['C:/Users/user'] = true;
  function sysErr(code, syscall, p) {
    var msg = { ENOENT: 'no such file or directory', EISDIR: 'illegal operation on a directory', ENOTDIR: 'not a directory', EBADF: 'bad file descriptor' }[code] || 'operation not permitted';
    var e = new Error(code + ': ' + msg + ', ' + syscall + " '" + p + "'");
    e.code = code; e.errno = { ENOENT: -4058, EISDIR: -4068, ENOTDIR: -4052, EBADF: -4083 }[code] || -4048; e.syscall = syscall; e.path = p;
    return e;
  }
  var encOpt = function (o) { var e = typeof o === 'string' ? o : o && o.encoding; return e && e !== 'buffer' ? e : null; };
  function Stats(size, isDir) {
    this.dev = 1; this.mode = isDir ? 16822 : 33206; this.nlink = 1; this.uid = 0; this.gid = 0; this.rdev = 0; this.blksize = 4096; this.ino = 1;
    this.size = size; this.blocks = Math.ceil(size / 4096);
    var t = new Date(1700000000000);
    this.atimeMs = this.mtimeMs = this.ctimeMs = this.birthtimeMs = 1700000000000; this.atime = this.mtime = this.ctime = this.birthtime = t;
    this._dir = isDir;
  }
  Stats.prototype.isFile = function () { return !this._dir; };
  Stats.prototype.isDirectory = function () { return this._dir; };
  ['isSymbolicLink', 'isFIFO', 'isSocket', 'isBlockDevice', 'isCharacterDevice'].forEach(function (k) { Stats.prototype[k] = function () { return false; }; });
  function Dirent(name, isDir) { this.name = name; this._dir = isDir; }
  Dirent.prototype = Object.create(Stats.prototype);
  var altBuf = function (k) { return Buffer.from('peel-alt:' + k); };
  var fds = {}, fdSeq = 10;
  var fs = {};
  fs.readFileSync = function (p, opts) {
    if (typeof p === 'number' && fds[p]) p = fds[p].path;
    var s = pathStr(p), k = vkey(p);
    var b = files[k];
    if (!b) {
      if (dirs[k]) throw sysErr('EISDIR', 'read', s);
      fx('node.fs.read', s, 'missing');
      if (!ALT) throw sysErr('ENOENT', 'open', s);
      b = altBuf(k);
    } else fx('node.fs.read', s, k === SELF ? 'self' : 'vfs');
    var e = encOpt(opts), out = e ? b.toString(e) : Buffer.from(b);
    if (e && k !== SELF) shadow.set(out, 'fs:' + s);
    return out;
  };
  var put = function (kind, p, data, opts, append) {
    var s = pathStr(p), k = vkey(p), b = toBuf(data, encOpt(opts) || 'utf8');
    fx(kind, s, latin1Of(b.subarray(0, 300)));
    files[k] = append && files[k] ? Buffer.concat([files[k], b]) : Buffer.from(b);
    addDirs(k);
    g.__peelTaintCheck(kind, latin1Of(b.subarray(0, 4000)));
  };
  fs.writeFileSync = function (p, d, o) {
    if (typeof p === 'number' && fds[p]) { fs.writeSync(p, d); return; }
    var flag = o && typeof o === 'object' && o.flag;
    put(flag && flag[0] === 'a' ? 'node.fs.append' : 'node.fs.write', p, d, o, flag && flag[0] === 'a');
  };
  fs.appendFileSync = function (p, d, o) { put('node.fs.append', p, d, o, true); };
  fs.truncateSync = function (p, len) { var k = vkey(p); fx('node.fs.write', pathStr(p), ''); files[k] = (files[k] || Buffer.alloc(0)).subarray(0, len || 0); };
  fs.existsSync = function (p) { var s; try { s = pathStr(p); } catch (e) { return false; } var k = vkey(s); fx('node.fs.stat', s, 'exists'); return Boolean(files[k] || dirs[k]) || ALT; };
  fs.statSync = fs.lstatSync = function (p, o) {
    var s = pathStr(p), k = vkey(p);
    fx('node.fs.stat', s, 'stat');
    if (files[k]) return new Stats(files[k].length, false);
    if (dirs[k]) return new Stats(0, true);
    if (ALT) return new Stats(9, false);
    if (o && o.throwIfNoEntry === false) return undefined;
    throw sysErr('ENOENT', 'stat', s);
  };
  fs.fstatSync = function (fd) { return fds[fd] ? fs.statSync(fds[fd].path) : new Stats(0, false); };
  fs.accessSync = function (p) { var k = vkey(p); fx('node.fs.stat', pathStr(p), 'access'); if (!files[k] && !dirs[k] && !ALT) throw sysErr('ENOENT', 'access', pathStr(p)); };
  fs.readdirSync = function (p, o) {
    var s = pathStr(p), k = vkey(p), pre = k === '/' ? '/' : k + '/', names = {};
    fx('node.fs.list', s, '');
    if (!dirs[k]) {
      if (files[k]) throw sysErr('ENOTDIR', 'scandir', s);
      if (!ALT) throw sysErr('ENOENT', 'scandir', s);
      names['peel-alt.txt'] = false;
    }
    Object.keys(files).concat(Object.keys(dirs)).forEach(function (x) { if (x.indexOf(pre) === 0 && x.length > pre.length) { var n = x.slice(pre.length).split('/')[0]; names[n] = names[n] || Boolean(dirs[pre + n]); } });
    return Object.keys(names).sort().map(function (n) { return o && o.withFileTypes ? new Dirent(n, names[n]) : n; });
  };
  fs.mkdirSync = function (p, o) { var k = vkey(p); fx('node.fs.mkdir', pathStr(p), o && o.recursive ? 'recursive' : ''); dirs[k] = true; addDirs(k); return o && o.recursive ? pathStr(p) : undefined; };
  fs.mkdtempSync = function (prefix) { var p = String(prefix) + 'peel01'; fs.mkdirSync(p); return p; };
  fs.rmSync = fs.unlinkSync = fs.rmdirSync = function (p) {
    var s = pathStr(p), k = vkey(p);
    fx('node.fs.delete', s, '');
    delete files[k]; delete dirs[k];
    Object.keys(files).forEach(function (x) { if (x.indexOf(k + '/') === 0) delete files[x]; });
  };
  fs.copyFileSync = fs.cpSync = function (a, b) {
    var ka = vkey(a);
    fx('node.fs.copy', pathStr(a), pathStr(b));
    files[vkey(b)] = files[ka] ? Buffer.from(files[ka]) : ALT ? altBuf(ka) : Buffer.alloc(0);
    addDirs(vkey(b));
  };
  fs.renameSync = function (a, b) { var ka = vkey(a), kb = vkey(b); fx('node.fs.rename', pathStr(a), pathStr(b)); if (files[ka]) { files[kb] = files[ka]; delete files[ka]; } if (dirs[ka]) { dirs[kb] = true; delete dirs[ka]; } addDirs(kb); };
  fs.chmodSync = fs.lchmodSync = function (p, m) { fx('node.fs.chmod', pathStr(p), String(m)); };
  fs.chownSync = fs.lchownSync = function (p, u, gid) { fx('node.fs.chmod', pathStr(p), 'chown ' + u + ':' + gid); };
  fs.utimesSync = fs.lutimesSync = function (p) { fx('node.fs.chmod', pathStr(p), 'utimes'); };
  fs.fchmodSync = function (fd, m) { fx('node.fs.chmod', fds[fd] ? fds[fd].path : 'fd:' + fd, String(m)); };
  fs.symlinkSync = fs.linkSync = function (t, p) { fx('node.fs.link', pathStr(p), pathStr(t)); };
  fs.readlinkSync = function (p) { fx('node.fs.stat', pathStr(p), 'readlink'); throw sysErr('ENOENT', 'readlink', pathStr(p)); };
  fs.realpathSync = function (p) { return pathStr(p); };
  fs.realpathSync.native = fs.realpathSync;
  fs.openSync = function (p, flags) {
    var s = pathStr(p), f = String(flags || 'r');
    fx('node.fs.open', s, f);
    if (f[0] === 'r' && !files[vkey(s)] && !ALT) throw sysErr('ENOENT', 'open', s);
    if (f[0] === 'w') files[vkey(s)] = Buffer.alloc(0);
    var fd = ++fdSeq;
    fds[fd] = { path: s, pos: 0 };
    return fd;
  };
  fs.closeSync = function (fd) { delete fds[fd]; };
  fs.writeSync = function (fd, d, a, b, c) {
    if (fd === 1 || fd === 2) { (fd === 1 ? proc.stdout : proc.stderr).write(d); return String(d).length; }
    var f = fds[fd];
    if (!f) throw sysErr('EBADF', 'write', 'fd:' + fd);
    var buf = typeof d === 'string' ? Buffer.from(d, typeof b === 'string' ? b : 'utf8') : toBuf(d).subarray(a || 0, b === undefined ? undefined : (a || 0) + b);
    put('node.fs.write', f.path, buf, null, true);
    return buf.length;
  };
  fs.readSync = function (fd, buf, off, len, pos) {
    var f = fds[fd];
    if (!f) throw sysErr('EBADF', 'read', 'fd:' + fd);
    var src = files[vkey(f.path)] || (ALT ? altBuf(f.path) : Buffer.alloc(0));
    var start = typeof pos === 'number' ? pos : f.pos, n = Math.min(len === undefined ? buf.length : len, src.length - start);
    if (n <= 0) return 0;
    src.copy(buf, off || 0, start, start + n);
    f.pos = start + n;
    fx('node.fs.read', f.path, 'fd');
    return n;
  };
  fs.fsyncSync = fs.fdatasyncSync = function () {};
  fs.watch = function (p) { fx('node.fs.watch', pathStr(p), ''); var w = emitter(); w.close = function () {}; w.ref = w.unref = function () { return w; }; return w; };
  fs.watchFile = function (p) { fx('node.fs.watch', pathStr(p), 'watchFile'); };
  fs.unwatchFile = function () {};
  fs.createReadStream = function (p, o) {
    var r = new Readable(), s = pathStr(p), k = vkey(p);
    r.path = s; r.bytesRead = 0;
    if (encOpt(o)) r.setEncoding(encOpt(o));
    later(function () {
      var b = files[k];
      fx('node.fs.read', s, b ? (k === SELF ? 'self' : 'vfs') : 'missing');
      if (!b && !ALT) { if (r.listenerCount('error')) r.emit('error', sysErr('ENOENT', 'open', s)); return; }
      b = b || altBuf(k);
      r.emit('open', 3); r.emit('ready');
      r.bytesRead = b.length;
      if (b.length) r.push(Buffer.from(b));
      r.push(null);
    });
    return r;
  };
  fs.createWriteStream = function (p, o) {
    var w = new Writable(), s = pathStr(p), app = o && o.flags && o.flags[0] === 'a';
    w.path = s; w.bytesWritten = 0;
    if (!app) put('node.fs.write', s, '', null, false);
    w._sink = function (c, enc) { var b = toBuf(c, enc); w.bytesWritten += b.length; put('node.fs.append', s, b, null, true); };
    later(function () { w.emit('open', 4); w.emit('ready'); });
    return w;
  };
  fs.constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 256, O_EXCL: 1024, O_TRUNC: 512, O_APPEND: 8, COPYFILE_EXCL: 1 };
  Object.assign(fs, fs.constants);
  fs.Stats = Stats; fs.Dirent = Dirent; fs.ReadStream = Readable; fs.WriteStream = Writable;
  fs.promises = {};
  ['readFile', 'writeFile', 'appendFile', 'unlink', 'rm', 'rmdir', 'mkdir', 'mkdtemp', 'copyFile', 'cp', 'rename', 'chmod', 'chown', 'lchown',
    'utimes', 'stat', 'lstat', 'access', 'readdir', 'realpath', 'symlink', 'link', 'readlink', 'truncate', 'open', 'close', 'fstat', 'fchmod'].forEach(function (name) {
    var sync = fs[name + 'Sync'];
    if (!sync) return;
    fs[name] = function () {
      var a = slice(arguments), cb = typeof a[a.length - 1] === 'function' ? a.pop() : null, res, err = null;
      try { res = sync.apply(fs, a); } catch (e) { err = e; }
      if (cb) later(function () { if (err) cb(err); else cb(null, res); });
    };
    fs.promises[name] = function () {
      var a = slice(arguments);
      return new Promise(function (res, rej) { try { res(sync.apply(fs, a)); } catch (e) { rej(e); } });
    };
  });
  fs.promises.open = function (p, flags) {
    return new Promise(function (res) {
      var fd = fs.openSync(p, flags);
      res({ fd: fd, readFile: function (o) { return fs.promises.readFile(p, o); }, writeFile: function (d, o) { return fs.promises.writeFile(p, d, o); },
        write: function (d) { return Promise.resolve({ bytesWritten: fs.writeSync(fd, d) }); }, close: function () { fs.closeSync(fd); return Promise.resolve(); },
        stat: function () { return fs.promises.stat(p); } });
    });
  };
  fs.promises.constants = fs.constants;
  fs.exists = function (p, cb) { var r = fs.existsSync(p); if (typeof cb === 'function') later(function () { cb(r); }); };
  fs.read = function (fd, buf, off, len, pos, cb) { var n = 0, err = null; try { n = fs.readSync(fd, buf, off, len, pos); } catch (e) { err = e; } if (typeof cb === 'function') later(function () { cb(err, n, buf); }); };
  fs.write = function (fd, d) { var a = slice(arguments), cb = typeof a[a.length - 1] === 'function' ? a.pop() : null, n = 0, err = null; try { n = fs.writeSync.apply(fs, a); } catch (e) { err = e; } if (cb) later(function () { cb(err, n); }); };

  // ── modül sistemi ──
  var cache = Object.create(null);
  function Module(id, parent) {
    this.id = id; this.path = DIRNAME; this.exports = {}; this.filename = id; this.loaded = false;
    this.children = []; this.paths = ['/app/node_modules', '/node_modules']; this.parent = parent || null;
    if (parent && parent.children) parent.children.push(this);
  }
  Module.prototype._compile = function (content, filename, via) {
    var src = String(content);
    filename = filename === undefined ? this.filename : String(filename);
    if (via !== false) dyn(via || 'module._compile', src);
    var body = src.replace(/^#![^\n]*/, '');
    skip(body);
    var fn = g.Function('exports', 'require', 'module', '__filename', '__dirname', body);
    skip(null);
    var dir = dirOf(filename);
    return fn.call(this.exports, this.exports, makeRequire(dir, this), this, filename, dir);
  };
  Module.prototype.require = function (id) { return makeRequire(dirOf(this.filename), this)(id); };
  var mainModule = new Module('.', null);
  mainModule.filename = FILENAME;
  mainModule.loaded = false;
  cache[SELF] = mainModule;
  function compileFile(k, via) {
    var m = new Module(k, mainModule);
    m.filename = k;
    cache[k] = m;
    if (/\.json$/i.test(k)) { m.exports = JSON.parse(files[k].toString()); } else m._compile(files[k].toString(), k, via);
    m.loaded = true;
    return m;
  }
  function resolveFile(dir, id) {
    var base = vkey(/^([a-zA-Z]:|[\\/])/.test(id) ? id : dir + '/' + id);
    var tries = [base, base + '.js', base + '.json', base + '.cjs', base + '/index.js', base + '/index.json'];
    for (var i = 0; i < tries.length; i++) if (files[tries[i]]) return tries[i];
    return null;
  }
  var mocks = Object.create(null);
  function makeRequire(dir, parent) {
    function require(id) {
      if (typeof id !== 'string') { var e = new TypeError('The "id" argument must be of type string'); e.code = 'ERR_INVALID_ARG_TYPE'; throw e; }
      var name = id.replace(/^node:/, '');
      if (hasOwn(BUILTINS, name)) { fx('node.require', name, 'builtin'); return builtin(name); }
      if (/^(\.{0,2}[\\/]|[a-zA-Z]:)/.test(id)) {
        var k = resolveFile(dir, id);
        if (k) { fx('node.require', id, 'file'); return (cache[k] || compileFile(k, 'require')).exports; }
      }
      fx('node.require', name, 'mock');
      return mocks[name] || (mocks[name] = ALIASES[name] ? ALIASES[name]() : mock(name, false));
    }
    require.resolve = function (id) { var k = resolveFile(dir, id); return k || (hasOwn(BUILTINS, id.replace(/^node:/, '')) ? id : '/app/node_modules/' + id + '/index.js'); };
    require.resolve.paths = function () { return ['/app/node_modules']; };
    require.cache = cache;
    require.main = mainModule;
    require.extensions = Module._extensions;
    return require;
  }
  Module._cache = cache;
  Module._extensions = { '.js': function (m, f) { m._compile(fs.readFileSync(f, 'utf8'), f); }, '.json': function (m, f) { m.exports = JSON.parse(fs.readFileSync(f, 'utf8')); }, '.node': function (m, f) { fx('node.process', 'dlopen', f); } };
  Module._load = function (req) { return makeRequire(DIRNAME, mainModule)(req); };
  Module._resolveFilename = function (req) { return makeRequire(DIRNAME, mainModule).resolve(req); };
  Module._nodeModulePaths = function () { return ['/app/node_modules']; };
  Module.wrapper = ['(function (exports, require, module, __filename, __dirname) { ', '\n});'];
  Module.wrap = function (s) { return Module.wrapper[0] + s + Module.wrapper[1]; };
  Module.createRequire = function (f) { return makeRequire(dirOf(pathStr(f instanceof URLImpl ? urlMod.fileURLToPath(f) : f)), mainModule); };
  Module.isBuiltin = function (n) { return hasOwn(BUILTINS, String(n).replace(/^node:/, '')); };
  Module.runMain = Module.syncBuiltinESMExports = Module.register = function () {};
  Module.Module = Module;
  Module.prototype.load = function (f) { this.filename = f; Module._extensions['.js'](this, f); this.loaded = true; };

  // ── kurulu olmayan paketler: her çağrıyı kaydeden Proxy taklidi ──
  var mockSet = new WeakSet();
  var cbBudget = 200;
  var HTTP_VERBS = { get: 1, post: 1, put: 1, patch: 1, delete: 1, head: 1, request: 1, send: 1, fetch: 1, options: 1 };
  function mockNet(path, args) {
    var url = null, at = -1;
    for (var i = 0; i < args.length && !url; i++) {
      var a = args[i];
      if (typeof a === 'string' && /^(https?|wss?|ftp):\/\//i.test(a)) { url = a; at = i; } else if (a instanceof URLImpl) { url = a.href; at = i; } else if (a && typeof a === 'object' && !mockSet.has(a)) {
        var u = a.url || a.uri || a.baseURL || a.href;
        if (typeof u === 'string' && /^(https?|wss?|ftp):\/\//i.test(u)) { url = u; at = i; }
      }
    }
    if (!url) return;
    var verb = path.split('.').pop().toLowerCase(), opts = args[at] && typeof args[at] === 'object' ? args[at] : null;
    var method = (opts && opts.method) || (HTTP_VERBS[verb] && verb !== 'request' && verb !== 'send' && verb !== 'fetch' ? verb.toUpperCase() : '');
    var body = opts && opts.data !== undefined ? opts.data : opts && opts.body !== undefined ? opts.body : opts && opts.json !== undefined ? opts.json : args[at + 1];
    g.__peelNetRecord(path, url, { method: String(method).toUpperCase(), body: body === undefined || typeof body === 'function' ? undefined : typeof body === 'string' ? body : preview(body) });
  }
  function callMock(path, args, isNew) {
    fx(isNew ? 'node.mock.new' : 'node.mock.call', path, args.map(preview).join(', '));
    mockNet(path, args);
    args.forEach(function (f) {
      if (typeof f !== 'function' || mockSet.has(f) || cbBudget <= 0) return;
      cbBudget--;
      later(function () { if (f.length >= 2) f(null, mock(path + '.cb', false), mock(path + '.cb', false)); else f(mock(path + '.cb', false)); });
    });
    return mock(isNew ? path : path + '()', !isNew);
  }
  function mock(path, thenable) {
    var kids = Object.create(null);
    var target = function () {};
    var p = new Proxy(target, {
      get: function (t, k) {
        if (k === Symbol.toPrimitive) return function (hint) { return hint === 'number' ? (ALT ? 7 : 0) : ALT ? 'peel-alt' : ''; };
        if (k === 'toString' || k === 'toLocaleString') return function () { return ALT ? 'peel-alt' : ''; };
        if (k === 'valueOf') return function () { return ALT ? 7 : 0; };
        if (k === 'toJSON') return function () { return ALT ? 'peel-alt' : {}; };
        if (k === 'then' || k === 'catch' || k === 'finally') {
          if (!thenable) return undefined;
          var settled = Promise.resolve(mock(path + '.result', false));
          return function (a, b) { return settled[k](a, b); };
        }
        if (k === Symbol.iterator) return function () { return [][Symbol.iterator](); };
        if (k === Symbol.asyncIterator) return function () { return { next: function () { return Promise.resolve({ value: undefined, done: true }); } }; };
        if (k === INSPECT) return function () { return '[mock ' + path + ']'; };
        if (typeof k === 'symbol') return undefined;
        if (k === 'prototype') return t.prototype;
        if (k === '__esModule') return false;
        if (k === 'length') return ALT ? 7 : 0;
        if (k === 'name') return path;
        if (!(k in kids)) kids[k] = mock(path + '.' + k, false);
        return kids[k];
      },
      set: function (t, k, v) { if (typeof k === 'string') { kids[k] = v; fx('node.mock.set', path + '.' + k, preview(v)); } return true; },
      has: function () { return true; },
      deleteProperty: function (t, k) { delete kids[k]; return true; },
      apply: function (t, self, args) { return callMock(path, args, false); },
      construct: function (t, args) { return callMock(path, args, true); },
    });
    mockSet.add(p);
    return p;
  }

  // ── process ──
  var proc = new EventEmitter();

  var DEFAULT_ENV = {
    ALLUSERSPROFILE: 'C:\\ProgramData', APPDATA: HOME + '\\AppData\\Roaming', COMPUTERNAME: 'DESKTOP-PEEL01', ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\user', LOCALAPPDATA: HOME + '\\AppData\\Local', NUMBER_OF_PROCESSORS: '4', OS: 'Windows_NT',
    Path: 'C:\\Windows\\system32;C:\\Windows;C:\\Program Files\\nodejs\\', PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS', PROCESSOR_ARCHITECTURE: 'AMD64',
    ProgramData: 'C:\\ProgramData', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', PUBLIC: 'C:\\Users\\Public',
    SystemDrive: 'C:', SystemRoot: 'C:\\Windows', TEMP: HOME + '\\AppData\\Local\\Temp', TMP: HOME + '\\AppData\\Local\\Temp',
    USERDOMAIN: 'DESKTOP-PEEL01', USERNAME: 'user', USERPROFILE: HOME, windir: 'C:\\Windows',
  };
  var envData = Object.assign({}, DEFAULT_ENV, ncfg.env || {});
  if (ALT) Object.keys(envData).forEach(function (k) { envData[k] = envData[k] + '-peel-alt'; });
  var envKey = function (t, k) { if (hasOwn(t, k)) return k; var u = k.toUpperCase(); return Object.keys(t).find(function (x) { return x.toUpperCase() === u; }); };
  proc.env = new Proxy(envData, {
    get: function (t, k) {
      if (typeof k !== 'string') return t[k];
      if (k === 'toJSON' || k === 'constructor') return undefined;
      fx('node.env.read', k, '');
      var key = envKey(t, k), v = key !== undefined ? t[key] : ALT ? 'peel-alt' : undefined;
      if (typeof v === 'string') shadow.set(v, 'process.env.' + k);
      return v;
    },
    set: function (t, k, v) { fx('node.env.write', String(k), String(v)); t[envKey(t, String(k)) || String(k)] = String(v); return true; },
    deleteProperty: function (t, k) { fx('node.env.write', String(k), '<deleted>'); var key = envKey(t, String(k)); if (key !== undefined) delete t[key]; return true; },
    has: function (t, k) { if (typeof k === 'string') fx('node.env.read', k, ''); return typeof k === 'string' && (envKey(t, k) !== undefined || ALT); },
    ownKeys: function (t) { fx('node.env.enum', '*', ''); return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor: function (t, k) { return Reflect.getOwnPropertyDescriptor(t, k); },
  });
  proc.argv = ['C:\\Program Files\\nodejs\\node.exe', FILENAME].concat((ncfg.argv || []).map(String)).concat(ALT ? ['peel-alt'] : []);
  proc.argv0 = 'node';
  proc.execArgv = [];
  proc.execPath = 'C:\\Program Files\\nodejs\\node.exe';
  proc.platform = 'win32';
  proc.arch = 'x64';
  proc.version = 'v20.11.1';
  proc.versions = { node: '20.11.1', v8: '11.3.244.8-node.17', uv: '1.46.0', zlib: '1.2.13.1-motley', modules: '115', openssl: '3.0.13+quic', napi: '9', unicode: '15.0' };
  proc.release = { name: 'node', lts: 'Iron' };
  proc.pid = 4242; proc.ppid = 4000; proc.title = 'node'; proc.debugPort = 9229; proc.exitCode = undefined;
  proc.config = { variables: {} }; proc.features = {}; proc.report = {}; proc.allowedNodeEnvironmentFlags = new Set();
  proc.mainModule = mainModule;
  proc.cwd = function () { return cwd; };
  proc.chdir = function (d) { fx('node.process', 'chdir', String(d)); cwd = String(d); };
  proc.umask = function () { return 18; };
  proc.uptime = function () { return 1.5; };
  proc.hrtime = function (prev) { return prev ? [0, 0] : [1, 0]; };
  proc.hrtime.bigint = function () { return typeof BigInt === 'function' ? BigInt(1000000000) : 1000000000; };
  proc.memoryUsage = function () { return { rss: 52428800, heapTotal: 16777216, heapUsed: 8388608, external: 1048576, arrayBuffers: 65536 }; };
  proc.memoryUsage.rss = function () { return 52428800; };
  proc.cpuUsage = function () { return { user: 100000, system: 20000 }; };
  proc.resourceUsage = function () { return { userCPUTime: 100000, systemCPUTime: 20000, maxRSS: 51200 }; };
  proc.getActiveResourcesInfo = function () { return []; };
  proc.emitWarning = function () {};
  proc.nextTick = function (fn) { var a = slice(arguments, 1); Promise.resolve().then(function () { fn.apply(null, a); }); };
  proc.binding = proc._linkedBinding = function (n) { fx('node.process', 'binding', String(n)); throw new Error('No such module: ' + n); };
  proc.dlopen = function (m, f) { fx('node.process', 'dlopen', String(f)); throw new Error('dlopen desteklenmiyor: ' + f); };
  ['kill', 'setuid', 'setgid', 'seteuid', 'setegid', 'setgroups', 'initgroups', 'setUncaughtExceptionCaptureCallback', 'setSourceMapsEnabled'].forEach(function (k) {
    proc[k] = function () { fx('node.process', k, slice(arguments).map(preview).join(' ')); return true; };
  });
  var exitErr = function (code) { var e = new Error('process.exit(' + code + ')'); e.__peelExit = true; return e; };
  proc.exit = function (code) {
    var c = code === undefined ? (proc.exitCode || 0) : code;
    fx('node.exit', String(c), '');
    try { proc.emit('exit', c); } catch (e) { /* çıkış dinleyicisi */ }
    throw exitErr(c);
  };
  proc.reallyExit = proc.exit;
  proc.abort = function () { fx('node.exit', 'abort', ''); throw exitErr('abort'); };
  var procOn = EP.on;
  proc.on = proc.addListener = function (type, fn) { g.__peelFx('listener', 'process.' + String(type)); return procOn.call(this, type, fn); };
  proc.once = function (type, fn) { return proc.on(type, onceWrap(proc, type, fn)); };
  var outStream = function (fd) {
    var w = new Writable();
    w.fd = fd; w.isTTY = false; w.columns = 80; w.rows = 24;
    w.write = function (c, enc, cb) {
      var line = (fd === 2 ? '!ERR ' : '') + (typeof c === 'string' ? c : toBuf(c).toString()).replace(/\n$/, '');
      g.__out.push(line);
      fx('console', fd === 1 ? 'stdout' : 'stderr', line);
      if (typeof enc === 'function') later(enc); else if (typeof cb === 'function') later(cb);
      return true;
    };
    w.end = function (c) { if (c !== undefined) w.write(c); return w; };
    w.getWindowSize = function () { return [80, 24]; }; w.hasColors = function () { return false; }; w.getColorDepth = function () { return 1; };
    w.cursorTo = w.moveCursor = w.clearLine = w.clearScreenDown = function () { return true; };
    return w;
  };
  proc.stdout = outStream(1);
  proc.stderr = outStream(2);
  proc.stdin = new Readable();
  proc.stdin.fd = 0; proc.stdin.isTTY = false;
  proc.stdin.setRawMode = function () { return proc.stdin; };
  proc.stdin.read = function () { fx('node.stdin', 'read', ''); return null; };
  Object.defineProperty(proc, Symbol.toStringTag, { value: 'process', configurable: true });

  // ── zamanlayıcılar: Node Timeout nesneleri (unref/ref) ──
  var tseq = 0;
  function Timeout(id) { this._id = id; this._idleTimeout = 1; }
  Timeout.prototype.ref = Timeout.prototype.unref = Timeout.prototype.refresh = function () { return this; };
  Timeout.prototype.hasRef = function () { return true; };
  Timeout.prototype.close = function () { return this; };
  Timeout.prototype[Symbol.toPrimitive] = function () { return this._id; };
  var st = g.setTimeout, si = g.setInterval;
  var bind = function (f, a) { return typeof f === 'function' && a.length ? function () { return f.apply(null, a); } : f; };
  g.setTimeout = function (f) { st(bind(f, slice(arguments, 2))); return new Timeout(++tseq); };
  g.setInterval = function (f) { si(bind(f, slice(arguments, 2))); return new Timeout(++tseq); };
  g.setImmediate = function (f) { var a = slice(arguments, 1); g.__peelFx('timer', 'setImmediate'); later(function () { f.apply(null, a); }); return new Timeout(++tseq); };
  g.clearImmediate = function () {};
  if (typeof g.queueMicrotask !== 'function') g.queueMicrotask = function (f) { Promise.resolve().then(f); };
  if (typeof g.structuredClone !== 'function') g.structuredClone = function (v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); };
  var timers = { setTimeout: g.setTimeout, setInterval: g.setInterval, setImmediate: g.setImmediate, clearTimeout: g.clearTimeout, clearInterval: g.clearInterval, clearImmediate: g.clearImmediate,
    promises: { setTimeout: function (ms, v) { return Promise.resolve(v); }, setImmediate: function (v) { return Promise.resolve(v); }, setInterval: function () { return { next: function () { return Promise.resolve({ done: true }); }, [Symbol.asyncIterator]: function () { return this; } }; } } };

  // ── os ──
  var osData = {
    hostname: 'DESKTOP-PEEL01', homedir: HOME, tmpdir: HOME + '\\AppData\\Local\\Temp', platform: 'win32', type: 'Windows_NT', release: '10.0.19045',
    arch: 'x64', machine: 'x86_64', version: 'Windows 10 Pro', endianness: 'LE', uptime: 3600, totalmem: 8589934592, freemem: 4294967296,
    availableParallelism: 4, loadavg: [0, 0, 0],
    userInfo: { uid: -1, gid: -1, username: 'user', homedir: HOME, shell: null },
    cpus: [0, 1, 2, 3].map(function () { return { model: 'Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz', speed: 1800, times: { user: 100000, nice: 0, sys: 50000, idle: 900000, irq: 0 } }; }),
    networkInterfaces: { Ethernet: [{ address: '192.168.1.10', netmask: '255.255.255.0', family: 'IPv4', mac: '00:15:5d:01:02:03', internal: false, cidr: '192.168.1.10/24' }],
      'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }] },
  };
  var os = { EOL: '\r\n', devNull: '\\\\.\\nul', constants: { signals: { SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }, errno: {}, priority: {} } };
  Object.keys(osData).forEach(function (k) {
    os[k] = function () {
      fx('node.os', k, '');
      var v = osData[k];
      v = ALT ? (typeof v === 'string' ? v + '-peel-alt' : typeof v === 'number' ? v + 7 : v) : v;
      v = v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
      if (typeof v === 'string') shadow.set(v, 'os.' + k);
      if (k === 'userInfo') { shadow.set(v.username, 'os.userInfo'); shadow.set(v.homedir, 'os.userInfo'); }
      return v;
    };
  });
  os.getPriority = function () { return 0; };
  os.setPriority = function () { fx('node.process', 'setPriority', ''); };

  // ── zlib ──
  function zop(op, data) { return fromLatin1(hostCall('zlib', { op: op, data: latin1Of(toBuf(data)) }).v); }
  var zlib = { constants: { Z_NO_FLUSH: 0, Z_SYNC_FLUSH: 2, Z_FINISH: 4, Z_OK: 0, Z_STREAM_END: 1, Z_DEFAULT_COMPRESSION: -1, Z_BEST_COMPRESSION: 9, BROTLI_PARAM_QUALITY: 1 } };
  Object.assign(zlib, zlib.constants);
  [['inflate', 'inflate'], ['inflateRaw', 'inflateRaw'], ['gunzip', 'gunzip'], ['unzip', 'unzip'], ['deflate', 'deflate'], ['deflateRaw', 'deflateRaw'],
    ['gzip', 'gzip'], ['brotliDecompress', 'brotliDecompress']].forEach(function (x) {
    var name = x[0], op = x[1];
    zlib[name + 'Sync'] = function (d, o) { var r = zop(op, d); return o && o.info ? { buffer: r, engine: {} } : r; };
    zlib[name] = function (d, o, cb) { if (typeof o === 'function') cb = o; var r, err = null; try { r = zop(op, d); } catch (e) { err = e; } if (typeof cb === 'function') later(function () { cb(err, r); }); };
    zlib[name][CUSTOM] = function (d) { return new Promise(function (res, rej) { try { res(zop(op, d)); } catch (e) { rej(e); } }); };
    var cname = 'create' + name[0].toUpperCase() + name.slice(1);
    zlib[cname] = function () {
      var t = new Transform(), parts = [];
      t._sink = function (c, enc) { parts.push(toBuf(c, enc)); };
      t.on('finish', function () { try { t.emit('data', zop(op, Buffer.concat(parts))); } catch (e) { if (t.listenerCount('error')) t.emit('error', e); } });
      return t;
    };
  });
  zlib.brotliCompressSync = zlib.brotliCompress = function () { throw new Error('brotli sıkıştırma desteklenmiyor (Peel sandbox)'); };
  zlib.crc32 = function (d, init) { var c = (init >>> 0) ^ 0xffffffff, b = toBuf(d); for (var i = 0; i < b.length; i++) { c ^= b[i]; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };

  // ── crypto ──
  var hex32 = function (b) { return decode(b, 'hex', 0, Math.min(32, b.length)); };
  var crec = function (op, alg, data) { if (g.__peelCrypto.length < 200) g.__peelCrypto.push({ op: 'node.' + op, alg: String(alg), data: data ? hex32(data) : '' }); fx('crypto', 'node.' + op, String(alg)); };
  var HASH_RE = /^(rsa-)?(md5|sha-?1|sha-?224|sha-?256|sha-?384|sha-?512)$/i;
  var CIPHER_RE = /^aes-?(128|192|256)(-(cbc|ecb|ctr|cfb|cfb8|ofb|gcm))?$/i;
  var keyBuf = function (k) { return k && typeof k === 'object' && k.__peelKey ? k.__peelKey : toBuf(k, 'utf8'); };
  function Hash(alg, key) {
    if (!HASH_RE.test(String(alg))) throw new Error('Digest method not supported');
    this._alg = String(alg); this._key = key === undefined ? null : keyBuf(key); this._parts = []; this._done = false;
  }
  Hash.prototype.update = function (d, enc) { if (this._done) throw new Error('Digest already called'); this._parts.push(toBuf(d, enc)); return this; };
  Hash.prototype.digest = function (enc) {
    this._done = true;
    var data = Buffer.concat(this._parts);
    crec(this._key ? 'createHmac' : 'createHash', this._alg, data);
    var r = this._key ? hostCall('hmac', { alg: this._alg, key: latin1Of(this._key), data: latin1Of(data) }) : hostCall('hash', { alg: this._alg, data: latin1Of(data) });
    var out = fromLatin1(r.v);
    return enc && enc !== 'buffer' ? out.toString(enc) : out;
  };
  Hash.prototype.copy = function () { var h = new Hash(this._alg, this._key === null ? undefined : this._key); h._parts = this._parts.slice(); return h; };
  Hash.prototype.write = function (d) { this.update(d); return true; };
  Hash.prototype.end = function () {};
  function Cipher(alg, key, iv, decrypt, password) {
    var m = CIPHER_RE.exec(String(alg));
    if (!m) throw new Error('Invalid cipher type: ' + alg);
    this._mode = (m[3] || 'cbc').toLowerCase();
    this._o = { alg: String(alg), key: password === undefined ? latin1Of(keyBuf(key)) : '', iv: iv === null || iv === undefined ? null : latin1Of(toBuf(iv, 'utf8')), password: password === undefined ? undefined : latin1Of(toBuf(password, 'utf8')), decrypt: decrypt };
    if (password === undefined && this._o.key.length !== Number(m[1]) / 8) { var e = new RangeError('Invalid key length'); e.code = 'ERR_CRYPTO_INVALID_KEYLEN'; throw e; }
    if (password === undefined && this._mode !== 'ecb' && this._mode !== 'gcm' && (!this._o.iv || this._o.iv.length !== 16)) { var e2 = new TypeError('Invalid initialization vector'); e2.code = 'ERR_CRYPTO_INVALID_IV'; throw e2; }
    this._decrypt = decrypt; this._parts = []; this._emitted = 0; this._pad = true; this._aad = ''; this._tag = null; this._final = false;
    crec(decrypt ? 'createDecipheriv' : 'createCipheriv', alg, null);
  }
  var STREAM_MODES = { ctr: 1, cfb: 1, cfb8: 1, ofb: 1, gcm: 1 };
  // Node gibi: çıktı kodlaması çağrılar arasında bölünmez (base64 üçlüleri, yarım UTF-8 dizileri sonraki parçaya kalır)
  function cipherOut(self, out, enc, flush) {
    if (!enc || enc === 'buffer') return out;
    var e = encOrThrow(enc), b = self._carry ? Buffer.concat([self._carry, out]) : out, keep = 0;
    if (!flush && (e === 'base64' || e === 'base64url')) keep = b.length % 3;
    else if (!flush && e === 'utf8') { for (var i = 1; i <= Math.min(3, b.length); i++) { var c = b[b.length - i]; if ((c & 0xc0) === 0xc0) { keep = (c & 0xf8) === 0xf0 ? (i < 4 ? i : 0) : (c & 0xf0) === 0xe0 ? (i < 3 ? i : 0) : (i < 2 ? i : 0); break; } if ((c & 0x80) === 0) break; } }
    self._carry = keep ? Buffer.from(b.subarray(b.length - keep)) : null;
    return b.subarray(0, b.length - keep).toString(e);
  }
  Cipher.prototype._run = function (data, final) { var o = Object.assign({}, this._o, { data: latin1Of(data), final: final, padding: this._pad, aad: this._aad }); return hostCall('cipher', o); };
  Cipher.prototype.update = function (d, inEnc, outEnc) {
    if (this._final) throw new Error('Unsupported state');
    this._parts.push(toBuf(d, inEnc));
    var all = Buffer.concat(this._parts), avail;
    if (STREAM_MODES[this._mode]) avail = all.length;
    else avail = this._decrypt && this._pad ? (all.length % 16 === 0 ? Math.max(0, all.length - 16) : all.length - (all.length % 16)) : all.length - (all.length % 16);
    var out = avail > this._emitted ? fromLatin1(this._run(all.subarray(0, avail), false).v).subarray(this._emitted) : Buffer.alloc(0);
    this._emitted = Math.max(this._emitted, avail);
    return cipherOut(this, out, outEnc, false);
  };
  Cipher.prototype.final = function (outEnc) {
    if (this._final) throw new Error('Unsupported state');
    this._final = true;
    var all = Buffer.concat(this._parts);
    crec(this._decrypt ? 'decipher.final' : 'cipher.final', this._o.alg, all);
    var r = this._run(all, true);
    if (r.tag) this._tag = fromLatin1(r.tag);
    var out = fromLatin1(r.v).subarray(this._emitted);
    return cipherOut(this, out, outEnc, true);
  };
  Cipher.prototype.setAutoPadding = function (p) { this._pad = p !== false; return this; };
  Cipher.prototype.setAAD = function (b) { this._aad = latin1Of(toBuf(b)); return this; };
  // shortcut: GCM etiketi doğrulanmaz (yük çözümü için gerekmez); kurcalama tespiti gerekirse final'de karşılaştır
  Cipher.prototype.setAuthTag = function (t) { this._tagIn = toBuf(t); return this; };
  Cipher.prototype.getAuthTag = function () { if (!this._tag) throw new Error('Invalid state for operation getAuthTag'); return this._tag; };
  Cipher.prototype.write = function (d) { this.update(d); return true; };
  var rnd = function (n) { var b = make(n >>> 0); for (var i = 0; i < b.length; i++) b[i] = (i * 97 + 13 + (ALT ? 7 : 0)) & 255; return b; };
  var pbkdf2 = function (pass, salt, iter, len, digest) { var p = toBuf(pass, 'utf8'), s = toBuf(salt, 'utf8'); crec('pbkdf2', digest || 'sha1', s); return fromLatin1(hostCall('pbkdf2', { alg: digest || 'sha1', pass: latin1Of(p), salt: latin1Of(s), iter: iter, len: len }).v); };
  var cryptoMod = {
    createHash: function (a) { return new Hash(a); },
    createHmac: function (a, k) { return new Hash(a, k); },
    createCipheriv: function (a, k, iv) { return new Cipher(a, k, iv, false); },
    createDecipheriv: function (a, k, iv) { return new Cipher(a, k, iv, true); },
    createCipher: function (a, pw) { return new Cipher(a, null, null, false, pw); },
    createDecipher: function (a, pw) { return new Cipher(a, null, null, true, pw); },
    createSecretKey: function (k, enc) { var b = toBuf(k, enc); return { __peelKey: b, type: 'secret', symmetricKeySize: b.length, export: function () { return Buffer.from(b); } }; },
    randomBytes: function (n, cb) { var b = rnd(n); if (typeof cb === 'function') { later(function () { cb(null, b); }); return undefined; } return b; },
    pseudoRandomBytes: function (n) { return rnd(n); },
    randomFillSync: function (b, off, n) { var r = rnd(b.length); for (var i = off || 0; i < (n === undefined ? b.length : (off || 0) + n); i++) b[i] = r[i]; return b; },
    randomInt: function (a, b, cb) { var lo = b === undefined || typeof b === 'function' ? 0 : a, hi = b === undefined || typeof b === 'function' ? a : b, v = lo + Math.floor(Math.random() * (hi - lo)); cb = typeof b === 'function' ? b : cb; if (typeof cb === 'function') { later(function () { cb(null, v); }); return undefined; } return v; },
    randomUUID: function () { return ALT ? '00000000-0000-4000-8000-000000000007' : '00000000-0000-4000-8000-000000000000'; },
    getRandomValues: function (a) { return g.crypto.getRandomValues(a); },
    pbkdf2Sync: pbkdf2,
    pbkdf2: function (p, s, i, l, d, cb) { var r, err = null; try { r = pbkdf2(p, s, i, l, d); } catch (e) { err = e; } if (typeof cb === 'function') later(function () { cb(err, r); }); },
    // shortcut: scrypt uygulanmadı (bellek/CPU yoğun); örneklerde görülürse köprüye eklenmeli
    scryptSync: function () { throw new Error('scrypt desteklenmiyor (Peel sandbox)'); },
    scrypt: function () { var cb = arguments[arguments.length - 1]; if (typeof cb === 'function') later(function () { cb(new Error('scrypt desteklenmiyor (Peel sandbox)')); }); },
    timingSafeEqual: function (a, b) { if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length'); for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; },
    getHashes: function () { return ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512']; },
    getCiphers: function () { return ['aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc', 'aes-128-ctr', 'aes-256-ctr', 'aes-128-gcm', 'aes-256-gcm', 'aes-128-ecb', 'aes-256-ecb']; },
    getCurves: function () { return []; },
    constants: {}, webcrypto: g.crypto, subtle: g.crypto && g.crypto.subtle,
    Hash: Hash, Hmac: Hash, Cipher: Cipher, Decipher: Cipher, Cipheriv: Cipher, Decipheriv: Cipher,
  };
  ['createECDH', 'createDiffieHellman', 'getDiffieHellman', 'generateKeyPairSync', 'generateKeyPair', 'generateKeySync', 'createSign', 'createVerify', 'publicEncrypt',
    'privateDecrypt', 'privateEncrypt', 'publicDecrypt', 'createPublicKey', 'createPrivateKey', 'sign', 'verify', 'hkdfSync', 'hkdf', 'X509Certificate', 'KeyObject', 'Certificate',
    'diffieHellman', 'hash'].forEach(function (k) { cryptoMod[k] = mock('crypto.' + k, false); });

  // ── child_process ──
  var execCount = 0;
  function runChild(via, code, filename) {
    dyn(via, code);
    later(function () { try { var m = new Module(filename, mainModule); m.filename = filename; m._compile(code, filename, false); } catch (e) { /* çocuk süreç hatası */ } });
  }
  // node -e "kod" / node dosya.js: önceden yazılmış (sanal) dosyalar ve satır içi kod katman olarak çalıştırılır
  function nodeChild(cmd, args) {
    var parts = args ? [cmd].concat(args) : (String(cmd).match(/"[^"]*"|'[^']*'|\S+/g) || []).map(function (x) { return x.replace(/^(["'])([\s\S]*)\1$/, '$2'); });
    if (!parts.length || !/(^|[\\/])node(\.exe)?$/i.test(parts[0])) return;
    for (var i = 1; i < parts.length; i++) {
      var a = parts[i];
      if (a === '-e' || a === '--eval' || a === '-p' || a === '--print') { if (parts[i + 1] !== undefined) runChild('child_process', String(parts[i + 1]), '/app/[eval]'); return; }
      if (a[0] === '-') continue;
      var k = resolveFile(DIRNAME, a);
      if (k) runChild('child_process', files[k].toString(), k);
      return;
    }
  }
  function ChildProcess(api, line) {
    EventEmitter.call(this);
    this.pid = 31337 + ++execCount; this.exitCode = null; this.signalCode = null; this.killed = false; this.connected = false; this.spawnfile = line;
    var self = this;
    this.stdin = new Writable();
    this.stdin._sink = function (c) { fx('node.exec', 'stdin', preview(typeof c === 'string' ? c : toBuf(c).toString())); };
    this.stdout = new Readable(); this.stderr = new Readable();
    this.stdio = [this.stdin, this.stdout, this.stderr];
    later(function () {
      self.emit('spawn');
      if (ALT) self.stdout.push(Buffer.from('peel-alt'));
      self.stdout.push(null); self.stderr.push(null);
      later(function () { self.exitCode = 0; self.emit('exit', 0, null); self.emit('close', 0, null); });
    });
  }
  inherits(ChildProcess, EventEmitter);
  ChildProcess.prototype.kill = function () { this.killed = true; return true; };
  ChildProcess.prototype.unref = ChildProcess.prototype.ref = function () { return this; };
  ChildProcess.prototype.send = function (m) { fx('node.exec', 'send', preview(m)); return true; };
  ChildProcess.prototype.disconnect = function () {};
  var cmdLine = function (cmd, args) { return [String(cmd)].concat(Array.isArray(args) ? args.map(String) : []).join(' '); };
  var outOf = function (o) { var s = ALT ? 'peel-alt' : ''; return o && o.encoding && o.encoding !== 'buffer' ? s : Buffer.from(s); };
  var child = {
    exec: function (cmd, o, cb) {
      if (typeof o === 'function') { cb = o; o = {}; }
      fx('node.exec', 'exec', String(cmd));
      nodeChild(cmd);
      var cp = new ChildProcess('exec', String(cmd));
      if (typeof cb === 'function') later(function () { var s = ALT ? 'peel-alt' : ''; cb(null, o && o.encoding === 'buffer' ? Buffer.from(s) : s, o && o.encoding === 'buffer' ? Buffer.alloc(0) : ''); });
      return cp;
    },
    execSync: function (cmd, o) { fx('node.exec', 'execSync', String(cmd)); nodeChild(cmd); return outOf(o); },
    spawn: function (cmd, args, o) { if (!Array.isArray(args)) { o = args; args = []; } var line = cmdLine(cmd, args); fx('node.exec', 'spawn', line); nodeChild(cmd, args); return new ChildProcess('spawn', line); },
    spawnSync: function (cmd, args, o) { if (!Array.isArray(args)) { o = args; args = []; } fx('node.exec', 'spawnSync', cmdLine(cmd, args)); nodeChild(cmd, args); var out = outOf(o); return { pid: 31337, status: 0, signal: null, stdout: out, stderr: outOf(o), output: [null, out, outOf(o)] }; },
    execFile: function (f, args, o, cb) {
      var a = slice(arguments, 1); cb = typeof a[a.length - 1] === 'function' ? a.pop() : null; args = Array.isArray(a[0]) ? a[0] : [];
      var line = cmdLine(f, args);
      fx('node.exec', 'execFile', line); nodeChild(f, args);
      if (cb) later(function () { cb(null, ALT ? 'peel-alt' : '', ''); });
      return new ChildProcess('execFile', line);
    },
    execFileSync: function (f, args, o) { if (!Array.isArray(args)) { o = args; args = []; } fx('node.exec', 'execFileSync', cmdLine(f, args)); nodeChild(f, args); return outOf(o); },
    fork: function (mod, args) { var line = cmdLine('node ' + pathStr(mod), Array.isArray(args) ? args : []); fx('node.exec', 'fork', line); nodeChild('node', [pathStr(mod)]); var cp = new ChildProcess('fork', line); cp.connected = true; return cp; },
    ChildProcess: ChildProcess,
  };
  child.exec[CUSTOM] = function (cmd, o) { return new Promise(function (res) { child.exec(cmd, o, function (e, out, err) { res({ stdout: out, stderr: err }); }); }); };
  child.execFile[CUSTOM] = function (f, a, o) { return new Promise(function (res) { child.execFile(f, Array.isArray(a) ? a : [], o, function (e, out, err) { res({ stdout: out, stderr: err }); }); }); };

  // ── ağ: http/https/http2/net/tls/dgram/dns (ağ yok; istek kaydedilir, sahte yanıtla akış ilerler) ──
  function respBody(url) { var r = g.__peelRespond(url) || {}; var body = ALT ? 'peel-alt' : String(r.body === undefined || r.body === null ? '' : r.body); return { status: r.status || 200, body: body }; }
  function IncomingMessage(url, r) {
    Readable.call(this);
    this.statusCode = r.status; this.statusMessage = r.status < 400 ? 'OK' : 'Error'; this.url = url;
    this.headers = { 'content-type': 'text/plain', 'content-length': String(r.body.length) }; this.rawHeaders = []; this.httpVersion = '1.1'; this.complete = false;
    if (r.body) shadow.set(r.body, 'net:' + url);
  }
  inherits(IncomingMessage, Readable);
  function reqArgs(proto, a, b, c) {
    var url, o = {}, cb;
    if (typeof a === 'string' || a instanceof URLImpl) { url = String(a instanceof URLImpl ? a.href : a); if (typeof b === 'function') cb = b; else { o = b || {}; cb = c; } } else {
      o = a || {}; cb = b;
      var host = o.hostname || o.host || 'localhost';
      url = (o.protocol || proto + ':') + '//' + host + (o.port && !/:\d+$/.test(host) ? ':' + o.port : '') + (o.path || '/');
    }
    return { url: url, method: String(o.method || 'GET').toUpperCase(), headers: o.headers || {}, cb: cb };
  }
  function ClientRequest(api, x) {
    Writable.call(this);
    this.method = x.method; this.path = x.url; this._headers = Object.assign({}, x.headers); this._body = []; this._api = api; this._url = x.url; this._sent = false; this.aborted = false;
    if (typeof x.cb === 'function') this.once('response', x.cb);
  }
  inherits(ClientRequest, Writable);
  var CRP = ClientRequest.prototype;
  CRP._sink = function (c, enc) { this._body.push(typeof c === 'string' ? c : toBuf(c, enc).toString()); };
  CRP.end = function (c, enc, cb) {
    if (typeof c === 'function') { cb = c; c = undefined; }
    if (c !== undefined && c !== null && typeof c !== 'function') this._sink(c, enc);
    if (this._sent) return this;
    this._sent = true;
    var self = this, body = this._body.join('');
    g.__peelNetRecord(this._api, this._url, { method: this.method, body: body || undefined });
    later(function () {
      if (self.aborted) return;
      self.emit('finish');
      var r = respBody(self._url), res = new IncomingMessage(self._url, r);
      self.res = res;
      self.emit('response', res);
      later(function () { if (r.body) res.push(r.body); res.complete = true; res.push(null); });
      if (typeof cb === 'function') cb();
    });
    return this;
  };
  CRP.setHeader = function (k, v) { this._headers[String(k).toLowerCase()] = v; return this; };
  CRP.getHeader = function (k) { return this._headers[String(k).toLowerCase()]; };
  CRP.removeHeader = function (k) { delete this._headers[String(k).toLowerCase()]; };
  CRP.getHeaders = function () { return Object.assign({}, this._headers); };
  CRP.flushHeaders = CRP.setNoDelay = CRP.setSocketKeepAlive = function () {};
  CRP.setTimeout = function (ms, cb) { return this; };
  CRP.abort = CRP.destroy = function () { this.aborted = true; return this; };
  function httpMod(proto) {
    var m = {
      request: function (a, b, c) { return new ClientRequest(proto + '.request', reqArgs(proto, a, b, c)); },
      get: function (a, b, c) { var r = new ClientRequest(proto + '.get', reqArgs(proto, a, b, c)); r.end(); return r; },
      createServer: function (o, handler) {
        var s = new EventEmitter();
        if (typeof o === 'function') handler = o;
        if (typeof handler === 'function') s.on('request', handler);
        s.listen = function (port, host, cb) {
          var a = slice(arguments), fn = typeof a[a.length - 1] === 'function' ? a.pop() : null, p = typeof port === 'object' && port ? port.port : port;
          var h = typeof a[1] === 'string' ? a[1] : port && port.host || '0.0.0.0';
          s._port = p;
          g.__peelNetRecord(proto + '.listen', 'tcp://' + h + ':' + p, {});
          later(function () { s.emit('listening'); if (fn) fn(); });
          return s;
        };
        s.close = function (cb) { if (typeof cb === 'function') later(cb); return s; };
        s.address = function () { return { port: s._port, address: '0.0.0.0', family: 'IPv4' }; };
        s.setTimeout = function () { return s; };
        return s;
      },
      Agent: function (o) { this.options = o || {}; this.destroy = function () {}; },
      STATUS_CODES: { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error' },
      METHODS: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
      ClientRequest: ClientRequest, IncomingMessage: IncomingMessage, Server: EventEmitter, ServerResponse: Writable,
      validateHeaderName: function () {}, validateHeaderValue: function () {}, maxHeaderSize: 16384,
    };
    m.globalAgent = new m.Agent();
    return m;
  }
  var http = httpMod('http'), https = httpMod('https');
  function Socket(opts) {
    Duplex.call(this, opts);
    this.remoteAddress = undefined; this.remotePort = undefined; this.bytesWritten = 0; this.connecting = false; this._url = null; this._kind = 'net';
  }
  inherits(Socket, Duplex);
  var SKP = Socket.prototype;
  SKP.connect = function () {
    var a = slice(arguments), cb = typeof a[a.length - 1] === 'function' ? a.pop() : null, o = a[0] && typeof a[0] === 'object' ? a[0] : { port: a[0], host: a[1] };
    var host = o.host || o.hostname || (o.path ? '' : 'localhost'), url = o.path ? 'pipe://' + o.path : (this._kind === 'tls' ? 'tls' : 'tcp') + '://' + host + ':' + o.port;
    this._url = url; this.remoteAddress = host; this.remotePort = o.port; this.connecting = true;
    g.__peelNetRecord(this._kind + '.connect', url, {});
    var self = this;
    if (cb) this.once(this._kind === 'tls' ? 'secureConnect' : 'connect', cb);
    later(function () { self.connecting = false; self.emit('connect'); if (self._kind === 'tls') self.emit('secureConnect'); self.emit('ready'); });
    return this;
  };
  SKP._sink = function (c, enc) { var s = typeof c === 'string' ? c : toBuf(c, enc).toString(); this.bytesWritten += s.length; g.__peelNetRecord(this._kind + '.write', this._url || '', { body: s }); };
  SKP.setEncoding = function (e) { this._enc = encOrThrow(e); return this; };
  SKP.setTimeout = function (ms, cb) { return this; };
  SKP.setKeepAlive = SKP.setNoDelay = SKP.ref = SKP.unref = function () { return this; };
  SKP.address = function () { return { address: '192.168.1.10', port: 50000, family: 'IPv4' }; };
  SKP.end = function (c) { if (c !== undefined && c !== null && typeof c !== 'function') this.write(c); return this; };
  SKP.destroy = function () { this.destroyed = true; return this; };
  SKP.destroySoon = SKP.destroy;
  var netCreate = function (kind) { return function () { var s = new Socket(); s._kind = kind; return s.connect.apply(s, slice(arguments)); }; };
  var isIPv4 = function (s) { return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(String(s)); };
  var isIPv6 = function (s) { return /^[0-9a-f:]+$/i.test(String(s)) && String(s).indexOf(':') >= 0; };
  var net = {
    Socket: Socket, Stream: Socket, connect: netCreate('net'), createConnection: netCreate('net'),
    createServer: function (o, h) { var srv = httpMod('net').createServer(o, h); if (typeof (typeof o === 'function' ? o : h) === 'function') { srv.removeAllListeners('request'); srv.on('connection', typeof o === 'function' ? o : h); } return srv; },
    isIP: function (s) { return isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0; }, isIPv4: isIPv4, isIPv6: isIPv6, Server: EventEmitter,
  };
  var tls = {
    connect: netCreate('tls'), TLSSocket: Socket, createSecureContext: function () { return {}; }, createServer: net.createServer,
    DEFAULT_MIN_VERSION: 'TLSv1.2', DEFAULT_MAX_VERSION: 'TLSv1.3', rootCertificates: [], checkServerIdentity: function () { return undefined; },
  };
  var dgram = {
    createSocket: function () {
      var s = new EventEmitter();
      s.send = function (msg) {
        var a = slice(arguments, 1), cb = typeof a[a.length - 1] === 'function' ? a.pop() : null, port, addr;
        if (typeof a[0] === 'number' && typeof a[1] === 'number' && typeof a[2] === 'number') { port = a[2]; addr = a[3]; } else { port = a[0]; addr = a[1]; }
        g.__peelNetRecord('dgram.send', 'udp://' + (addr || 'localhost') + ':' + port, { body: typeof msg === 'string' ? msg : toBuf(msg).toString() });
        if (cb) later(function () { cb(null, 0); });
      };
      s.bind = function (p) { g.__peelNetRecord('dgram.bind', 'udp://0.0.0.0:' + (typeof p === 'object' && p ? p.port : p), {}); later(function () { s.emit('listening'); }); return s; };
      s.close = function (cb) { if (typeof cb === 'function') later(cb); return s; };
      s.address = function () { return { address: '0.0.0.0', port: 50001, family: 'IPv4' }; };
      s.setBroadcast = s.setTTL = s.setMulticastTTL = s.addMembership = s.ref = s.unref = function () { return s; };
      s.connect = function (port, addr, cb) { g.__peelNetRecord('dgram.connect', 'udp://' + (addr || 'localhost') + ':' + port, {}); if (typeof cb === 'function') later(cb); };
      return s;
    },
  };
  var LOOKUP_IP = function () { return ALT ? '10.0.0.66' : '127.0.0.1'; };
  var dns = {
    lookup: function (host, o, cb) {
      if (typeof o === 'function') { cb = o; o = {}; }
      g.__peelNetRecord('dns.lookup', String(host), {});
      if (typeof cb === 'function') later(function () { if (o && o.all) cb(null, [{ address: LOOKUP_IP(), family: 4 }]); else cb(null, LOOKUP_IP(), 4); });
    },
    reverse: function (ip, cb) { g.__peelNetRecord('dns.reverse', String(ip), {}); if (typeof cb === 'function') later(function () { cb(null, []); }); },
    setServers: function (list) { fx('node.process', 'dns.setServers', preview(list)); }, getServers: function () { return ['8.8.8.8']; },
  };
  ['resolve', 'resolve4', 'resolve6', 'resolveTxt', 'resolveMx', 'resolveCname', 'resolveNs', 'resolveSrv', 'resolveAny', 'resolvePtr', 'resolveSoa'].forEach(function (k) {
    dns[k] = function (host) { var cb = arguments[arguments.length - 1]; g.__peelNetRecord('dns.' + k, String(host), {}); if (typeof cb === 'function') later(function () { cb(null, k === 'resolve4' || k === 'resolve' ? [LOOKUP_IP()] : []); }); };
  });
  dns.promises = {};
  Object.keys(dns).forEach(function (k) {
    if (typeof dns[k] !== 'function' || k === 'setServers' || k === 'getServers') return;
    dns.promises[k] = function () { var a = slice(arguments); return new Promise(function (res, rej) { dns[k].apply(null, a.concat([function (e, v, f) { if (e) rej(e); else res(k === 'lookup' ? { address: v, family: f } : v); }])); }); };
  });
  dns.Resolver = function () { Object.assign(this, dns); };
  dns.promises.Resolver = function () { Object.assign(this, dns.promises); };
  var http2 = {
    connect: function (authority, o, cb) {
      var s = new EventEmitter(), base = String(authority instanceof URLImpl ? authority.href : authority).replace(/\/$/, '');
      g.__peelNetRecord('http2.connect', base, {});
      s.request = function (h) {
        h = h || {};
        var st = new Duplex(), body = [], url = base + (h[':path'] || '/');
        st._sink = function (c, enc) { body.push(typeof c === 'string' ? c : toBuf(c, enc).toString()); };
        st.end = function (c) {
          if (c !== undefined && c !== null && typeof c !== 'function') st._sink(c);
          g.__peelNetRecord('http2.request', url, { method: String(h[':method'] || 'GET'), body: body.join('') || undefined });
          later(function () { var r = respBody(url); st.emit('response', { ':status': r.status }); if (r.body) st.push(r.body); st.push(null); });
          return st;
        };
        st.setEncoding = function () { return st; }; st.close = function () {};
        return st;
      };
      s.close = s.destroy = s.unref = s.ref = function () { return s; };
      if (typeof (typeof o === 'function' ? o : cb) === 'function') later(typeof o === 'function' ? o : cb);
      later(function () { s.emit('connect'); });
      return s;
    },
    constants: { HTTP2_HEADER_PATH: ':path', HTTP2_HEADER_METHOD: ':method', HTTP2_HEADER_STATUS: ':status' },
    createServer: http.createServer, createSecureServer: http.createServer,
  };

  // ── vm ──
  var contexts = new WeakSet();
  // bağlam nesnesi global gibi davranır (shortcut: ayrı realm değil; bağlamda olmayan adlar gerçek global'e düşer)
  var WITH_SRC = 'with (__peelCtx) { return eval(__peelSrc); }';
  skip(WITH_SRC);
  var withRunner = g.Function('__peelCtx', '__peelSrc', WITH_SRC);
  skip(null);
  function runIn(via, code, ctx, record) {
    var src = String(code);
    if (record !== false) dyn(via, src);
    skip(src);
    if (ctx && typeof ctx === 'object' && ctx !== g) return withRunner(ctx, src);
    return (0, g.eval)(src);
  }
  function Script(code, o) { this._code = String(code); this._file = o && o.filename || 'evalmachine.<anonymous>'; dyn('vm.Script', this._code); }
  Script.prototype.runInThisContext = function () { return runIn('vm.Script', this._code, null, false); };
  Script.prototype.runInNewContext = Script.prototype.runInContext = function (ctx) { return runIn('vm.Script', this._code, ctx || {}, false); };
  Script.prototype.createCachedData = function () { return Buffer.alloc(0); };
  var vm = {
    Script: Script,
    runInThisContext: function (c) { return runIn('vm.runInThisContext', c, null); },
    runInNewContext: function (c, ctx) { return runIn('vm.runInNewContext', c, ctx || {}); },
    runInContext: function (c, ctx) { return runIn('vm.runInContext', c, ctx); },
    createContext: function (o) { o = o || {}; contexts.add(o); return o; },
    isContext: function (o) { return contexts.has(o); },
    compileFunction: function (code, params) {
      var src = String(code);
      dyn('vm.compileFunction', src);
      skip(src);
      return g.Function.apply(null, (params || []).map(String).concat([src]));
    },
    measureMemory: function () { return Promise.resolve({}); },
    constants: {},
  };

  // ── worker_threads, readline, diğerleri ──
  function NodeWorker(file, o) {
    EventEmitter.call(this);
    var isEval = o && o.eval, code = isEval ? String(file) : null, name = isEval ? 'eval' : pathStr(file instanceof URLImpl ? urlMod.fileURLToPath(file) : file);
    if (!isEval) { var k = resolveFile(DIRNAME, name); if (k) code = files[k].toString(); }
    fx('node.worker', name, code === null ? '' : code.slice(0, 300));
    if (code !== null) dyn('worker_threads', code);
    this.threadId = 1;
    var self = this;
    later(function () { self.emit('online'); });
  }
  inherits(NodeWorker, EventEmitter);
  NodeWorker.prototype.postMessage = function (m) { fx('node.worker', 'postMessage', preview(m)); };
  NodeWorker.prototype.terminate = function () { return Promise.resolve(0); };
  NodeWorker.prototype.ref = NodeWorker.prototype.unref = function () {};
  function MessagePort() { EventEmitter.call(this); }
  inherits(MessagePort, EventEmitter);
  MessagePort.prototype.postMessage = function (m) { fx('node.worker', 'postMessage', preview(m)); };
  MessagePort.prototype.start = MessagePort.prototype.close = MessagePort.prototype.ref = MessagePort.prototype.unref = function () {};
  var workerThreads = { Worker: NodeWorker, isMainThread: true, parentPort: null, workerData: null, threadId: 0, resourceLimits: {}, SHARE_ENV: Symbol('SHARE_ENV'),
    MessageChannel: function () { this.port1 = new MessagePort(); this.port2 = new MessagePort(); }, MessagePort: MessagePort, BroadcastChannel: MessagePort,
    markAsUntransferable: function () {}, receiveMessageOnPort: function () { return undefined; }, setEnvironmentData: function () {}, getEnvironmentData: function () { return undefined; } };
  function rlInterface() {
    var rl = new EventEmitter();
    rl.question = function (q, o, cb) { if (typeof o === 'function') cb = o; fx('node.stdin', 'question', String(q)); if (typeof cb === 'function') later(function () { cb(ALT ? 'peel-alt' : ''); }); };
    rl.prompt = rl.setPrompt = rl.pause = rl.resume = function () { return rl; };
    rl.write = function () {};
    rl.close = function () { later(function () { rl.emit('close'); }); };
    rl.getPrompt = function () { return '> '; };
    rl.line = ''; rl.terminal = false;
    rl[Symbol.asyncIterator] = function () { return { next: function () { return Promise.resolve({ value: undefined, done: true }); }, return: function () { return Promise.resolve({ done: true }); } }; };
    return rl;
  }
  var readline = { createInterface: rlInterface, Interface: EventEmitter, clearLine: function () { return true; }, clearScreenDown: function () { return true; }, cursorTo: function () { return true; }, moveCursor: function () { return true; }, emitKeypressEvents: function () {} };
  readline.promises = { createInterface: function () { var rl = rlInterface(), q = rl.question; rl.question = function (s) { return new Promise(function (res) { q(s, res); }); }; return rl; } };
  function AssertionError(o) { var e = new Error(o && o.message || 'Assertion failed'); e.name = 'AssertionError'; e.code = 'ERR_ASSERTION'; e.actual = o && o.actual; e.expected = o && o.expected; return e; }
  var fail = function (m, a, e) { throw m instanceof Error ? m : new AssertionError({ message: m, actual: a, expected: e }); };
  var deepEq = function (a, b) { try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return a === b; } };
  function assert(v, m) { if (!v) fail(m || 'The expression evaluated to a falsy value', v, true); }
  Object.assign(assert, {
    ok: assert, AssertionError: AssertionError, fail: function (m) { fail(m || 'Failed'); },
    equal: function (a, b, m) { if (a != b) fail(m, a, b); }, notEqual: function (a, b, m) { if (a == b) fail(m, a, b); }, // eslint-disable-line eqeqeq
    strictEqual: function (a, b, m) { if (!Object.is(a, b)) fail(m, a, b); }, notStrictEqual: function (a, b, m) { if (Object.is(a, b)) fail(m, a, b); },
    deepEqual: function (a, b, m) { if (!deepEq(a, b)) fail(m, a, b); }, deepStrictEqual: function (a, b, m) { if (!deepEq(a, b)) fail(m, a, b); },
    notDeepEqual: function (a, b, m) { if (deepEq(a, b)) fail(m, a, b); }, notDeepStrictEqual: function (a, b, m) { if (deepEq(a, b)) fail(m, a, b); },
    throws: function (fn, x, m) { try { fn(); } catch (e) { return; } fail(typeof x === 'string' ? x : m || 'Missing expected exception.'); },
    doesNotThrow: function (fn) { fn(); }, rejects: function (p) { return Promise.resolve(typeof p === 'function' ? p() : p).then(function () { fail('Missing expected rejection.'); }, function () {}); },
    doesNotReject: function (p) { return Promise.resolve(typeof p === 'function' ? p() : p).then(function () {}); },
    match: function (s, re, m) { if (!re.test(s)) fail(m, s, re); }, doesNotMatch: function (s, re, m) { if (re.test(s)) fail(m, s, re); },
    ifError: function (v) { if (v !== null && v !== undefined) throw v; },
  });
  assert.strict = assert;
  function StringDecoder(enc) { this.encoding = encOrThrow(enc); }
  StringDecoder.prototype.write = function (b) { return typeof b === 'string' ? b : toBuf(b).toString(this.encoding); };
  StringDecoder.prototype.end = function (b) { return b ? this.write(b) : ''; };
  var perf = { performance: g.performance, PerformanceObserver: function () { this.observe = this.disconnect = function () {}; }, monitorEventLoopDelay: function () { return { enable: function () {}, disable: function () {}, mean: 0 }; } };
  var fetchMod = function () { return g.fetch.apply(null, slice(arguments)); };
  fetchMod.default = fetchMod;
  ['Headers', 'Request', 'Response', 'FormData'].forEach(function (k) { fetchMod[k] = g[k] || mock('node-fetch.' + k, false); });

  // ── modül tablosu ──
  var BUILTINS = {
    assert: function () { return assert; }, 'assert/strict': function () { return assert; },
    async_hooks: function () { return { AsyncLocalStorage: function () { var s; this.run = function (v, fn) { s = v; return fn.apply(null, slice(arguments, 2)); }; this.getStore = function () { return s; }; this.enterWith = function (v) { s = v; }; }, AsyncResource: function () { this.runInAsyncScope = function (fn) { return fn.apply(null, slice(arguments, 2)); }; }, createHook: function () { return { enable: function () {}, disable: function () {} }; }, executionAsyncId: function () { return 1; } }; },
    buffer: function () { return { Buffer: Buffer, SlowBuffer: Buffer, kMaxLength: 4294967296, constants: { MAX_LENGTH: 4294967296, MAX_STRING_LENGTH: 536870888 }, atob: g.atob, btoa: g.btoa, Blob: g.Blob, isUtf8: function () { return true; } }; },
    child_process: function () { return child; },
    cluster: function () { return { isMaster: true, isPrimary: true, isWorker: false, workers: {}, fork: function () { fx('node.exec', 'cluster.fork', ''); return new ChildProcess('cluster', 'fork'); }, on: function () {}, setupPrimary: function () {}, setupMaster: function () {} }; },
    console: function () { return g.console; },
    constants: function () { return Object.assign({}, os.constants.signals, fs.constants); },
    crypto: function () { return cryptoMod; },
    dgram: function () { return dgram; },
    diagnostics_channel: function () { return { channel: function () { return { publish: function () {}, subscribe: function () {}, hasSubscribers: false }; }, subscribe: function () {}, hasSubscribers: function () { return false; } }; },
    dns: function () { return dns; }, 'dns/promises': function () { return dns.promises; },
    domain: function () { return { create: function () { var d = new EventEmitter(); d.run = function (fn) { return fn(); }; d.add = d.remove = function () {}; return d; } }; },
    events: function () { return EventEmitter; },
    fs: function () { return fs; }, 'fs/promises': function () { return fs.promises; },
    http: function () { return http; }, https: function () { return https; }, http2: function () { return http2; },
    inspector: function () { return { url: function () { return undefined; }, open: function () { fx('node.process', 'inspector.open', ''); }, close: function () {}, Session: function () { this.connect = this.post = this.disconnect = function () {}; } }; },
    module: function () { return Module; },
    net: function () { return net; },
    os: function () { return os; },
    path: function () { return pathMod; }, 'path/posix': function () { return posix; }, 'path/win32': function () { return win32; },
    perf_hooks: function () { return perf; },
    process: function () { return proc; },
    punycode: function () { return { toASCII: String, toUnicode: String, encode: String, decode: String }; },
    querystring: function () { return querystring; },
    readline: function () { return readline; }, 'readline/promises': function () { return readline.promises; },
    repl: function () { return { start: function () { fx('node.stdin', 'repl', ''); return rlInterface(); } }; },
    stream: function () { return streamMod; }, 'stream/promises': function () { return Stream.promises; }, 'stream/web': function () { return {}; },
    string_decoder: function () { return { StringDecoder: StringDecoder }; },
    sys: function () { return util; },
    timers: function () { return timers; }, 'timers/promises': function () { return timers.promises; },
    tls: function () { return tls; },
    tty: function () { return { isatty: function () { return false; }, ReadStream: Readable, WriteStream: Writable }; },
    url: function () { return urlMod; },
    util: function () { return util; }, 'util/types': function () { return util.types; },
    v8: function () { return { getHeapStatistics: function () { return { total_heap_size: 16777216, used_heap_size: 8388608, heap_size_limit: 4345298944 }; }, serialize: function (v) { return Buffer.from(JSON.stringify(v)); }, deserialize: function (b) { return JSON.parse(toBuf(b).toString()); }, setFlagsFromString: function (s) { fx('node.process', 'v8.setFlagsFromString', String(s)); } }; },
    vm: function () { return vm; },
    wasi: function () { return { WASI: mock('wasi.WASI', false) }; },
    worker_threads: function () { return workerThreads; },
    zlib: function () { return zlib; },
  };
  var builtinCache = Object.create(null);
  function builtin(name) { return builtinCache[name] || (builtinCache[name] = BUILTINS[name]()); }
  var ALIASES = { 'node-fetch': function () { return fetchMod; }, 'cross-fetch': function () { return fetchMod; }, 'isomorphic-fetch': function () { return fetchMod; } };
  Module.builtinModules = Object.keys(BUILTINS);

  // ── global'ler ──
  var mainRequire = makeRequire(DIRNAME, mainModule);
  g.global = g;
  g.process = proc;
  g.Buffer = Buffer;
  g.require = mainRequire;
  g.module = mainModule;
  g.exports = mainModule.exports;
  g.__filename = FILENAME;
  g.__dirname = DIRNAME;
  g.__peelNodeRequire = mainRequire;
  g.__peelBaseGlobals = Object.getOwnPropertyNames(g);
}

export const NODE_STUBS = `(${nodeRuntime.toString()})(globalThis);`;
