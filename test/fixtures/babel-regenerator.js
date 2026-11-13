// Babel 7 + regenerator çıktısı: async/generator, try/catch/finally, döngü ve sınıf yardımcıları geri çevrilmeli
"use strict";
// regenerator-runtime'ın küçük eşdeğeri (mark/wrap, try/catch/finally tamamlama kayıtları)
var regeneratorRuntime = (function () {
  var CONT = {};
  function mark(f) { return f; }
  function wrap(inner, outer, self, tryLocs) {
    var entries = (tryLocs || []).map(function (l) { return { tryLoc: l[0], catchLoc: l[1], finallyLoc: l[2], afterLoc: l[3], completion: null }; });
    var ctx = {
      prev: 0, next: 0, sent: undefined, done: false, rval: undefined,
      stop: function () { this.done = true; return this.rval; },
      abrupt: function (type, arg) {
        for (var i = entries.length - 1; i >= 0; i--) {
          var e = entries[i];
          if (e.finallyLoc !== undefined && e.tryLoc <= this.prev && this.prev < e.finallyLoc) {
            e.completion = { type: type, arg: arg };
            this.next = e.finallyLoc;
            return CONT;
          }
        }
        return this.complete({ type: type, arg: arg });
      },
      complete: function (r) {
        if (r.type === 'throw') throw r.arg;
        if (r.type === 'break' || r.type === 'continue') this.next = r.arg;
        else if (r.type === 'return') { this.rval = r.arg; this.next = 'end'; }
        return CONT;
      },
      finish: function (loc) {
        for (var i = entries.length - 1; i >= 0; i--) {
          var e = entries[i];
          if (e.finallyLoc === loc) {
            var c = e.completion;
            e.completion = null;
            if (c) return this.complete(c);
            if (e.afterLoc !== undefined) this.next = e.afterLoc;
            return CONT;
          }
        }
        throw new Error('finish');
      },
      catch: function (loc) {
        for (var i = entries.length - 1; i >= 0; i--) {
          var e = entries[i];
          if (e.tryLoc === loc) { var c = e.completion; e.completion = null; return c.arg; }
        }
        throw new Error('catch');
      },
    };
    function dispatch(err) {
      for (var i = entries.length - 1; i >= 0; i--) {
        var e = entries[i];
        if (e.tryLoc <= ctx.prev) {
          if (e.catchLoc !== undefined && ctx.prev < e.catchLoc) { e.completion = { type: 'throw', arg: err }; ctx.next = e.catchLoc; return true; }
          if (e.finallyLoc !== undefined && ctx.prev < e.finallyLoc) { e.completion = { type: 'throw', arg: err }; ctx.next = e.finallyLoc; return true; }
        }
      }
      return false;
    }
    function step(method, arg) {
      if (ctx.done) { if (method === 'throw') throw arg; return { value: undefined, done: true }; }
      if (method === 'throw') { ctx.done = false; if (!dispatch(arg)) { ctx.done = true; throw arg; } }
      else ctx.sent = arg;
      for (;;) {
        var r;
        try {
          r = inner.call(self, ctx);
        } catch (e) {
          if (!dispatch(e)) { ctx.done = true; throw e; }
          continue;
        }
        if (r === CONT) continue;
        if (ctx.done) return { value: r, done: true };
        return { value: r, done: false };
      }
    }
    var g = {
      next: function (v) { return step('next', v); },
      throw: function (e) { return step('throw', e); },
      return: function (v) { ctx.done = true; return { value: v, done: true }; },
    };
    g[Symbol.iterator] = function () { return g; };
    return g;
  }
  return { mark: mark, wrap: wrap };
})();
function asyncGeneratorStep(n, t, e, r, o, a, c) { try { var i = n[a](c), u = i.value; } catch (n) { return void e(n); } i.done ? t(u) : Promise.resolve(u).then(r, o); }
function _asyncToGenerator(n) { return function () { var t = this, e = arguments; return new Promise(function (r, o) { var a = n.apply(t, e); function _next(n) { asyncGeneratorStep(a, r, o, _next, _throw, "next", n); } function _throw(n) { asyncGeneratorStep(a, r, o, _next, _throw, "throw", n); } _next(void 0); }); }; }
function _classCallCheck(a, n) { if (!(a instanceof n)) throw new TypeError("Cannot call a class as a function"); }
function _defineProperties(e, r) { for (var t = 0; t < r.length; t++) { var o = r[t]; o.enumerable = o.enumerable || !1, o.configurable = !0, "value" in o && (o.writable = !0), Object.defineProperty(e, o.key, o); } }
function _createClass(e, r, t) { return r && _defineProperties(e.prototype, r), t && _defineProperties(e, t), Object.defineProperty(e, "prototype", { writable: !1 }), e; }
var _marked = /*#__PURE__*/regeneratorRuntime.mark(range);
function range(n) {
  var i;
  return regeneratorRuntime.wrap(function range$(_context) {
    while (1) switch (_context.prev = _context.next) {
      case 0:
        i = 0;
      case 1:
        if (!(i < n)) {
          _context.next = 7;
          break;
        }
        _context.next = 4;
        return i;
      case 4:
        i++;
        _context.next = 1;
        break;
      case 7:
      case "end":
        return _context.stop();
    }
  }, _marked);
}
function load(_x) {
  return _load.apply(this, arguments);
}
function _load() {
  _load = _asyncToGenerator(/*#__PURE__*/regeneratorRuntime.mark(function _callee(x) {
    var res;
    return regeneratorRuntime.wrap(function _callee$(_context2) {
      while (1) switch (_context2.prev = _context2.next) {
        case 0:
          _context2.prev = 0;
          _context2.next = 3;
          return Promise.resolve(x * 2);
        case 3:
          res = _context2.sent;
          if (!(res > 10)) {
            _context2.next = 6;
            break;
          }
          throw new Error("big");
        case 6:
          return _context2.abrupt("return", "ok:" + res);
        case 9:
          _context2.prev = 9;
          _context2.t0 = _context2["catch"](0);
          return _context2.abrupt("return", "err:" + _context2.t0.message);
        case 12:
          _context2.prev = 12;
          console.log("done", x);
          return _context2.finish(12);
        case 15:
        case "end":
          return _context2.stop();
      }
    }, _callee, null, [[0, 9, 12, 15]]);
  }));
  return _load.apply(this, arguments);
}
var Counter = /*#__PURE__*/function () {
  function Counter(start) {
    _classCallCheck(this, Counter);
    this.n = start;
  }
  return _createClass(Counter, [{
    key: "inc",
    value: function inc() {
      this.n++;
      return this.n;
    }
  }]);
}();
var c = new Counter(1);
console.log(Array.from(range(c.inc() + 1)).join(","), c.inc(), c.inc());
load(2).then(function (v) { console.log(v); });
load(9).then(function (v) { console.log(v); });
// EXPECT: function* range(n)
// EXPECT: yield i;
// EXPECT: async function load(x)
// EXPECT: res = await Promise.resolve(x * 2);
// EXPECT: } finally {
// EXPECT: class Counter {
// GONE: regeneratorRuntime.wrap
// GONE: _context
