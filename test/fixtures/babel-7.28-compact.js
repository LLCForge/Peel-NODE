// Babel 7.28 (@babel/preset-env, targets: ie 11) gerçek çıktısı: kompakt _regenerator().m/w, _callSuper, _superPropGet
// Kaynak: Animal/Dog/Puppy sınıf kalıtımı + super.speak(), generator, yield*, async try/catch/finally, await döngüsü
function asyncGeneratorStep(n, t, e, r, o, a, c) { try { var i = n[a](c), u = i.value; } catch (n) { return void e(n); } i.done ? t(u) : Promise.resolve(u).then(r, o); }
function _asyncToGenerator(n) { return function () { var t = this, e = arguments; return new Promise(function (r, o) { var a = n.apply(t, e); function _next(n) { asyncGeneratorStep(a, r, o, _next, _throw, "next", n); } function _throw(n) { asyncGeneratorStep(a, r, o, _next, _throw, "throw", n); } _next(void 0); }); }; }
function _regeneratorValues(e) { if (null != e) { var t = e["function" == typeof Symbol && Symbol.iterator || "@@iterator"], r = 0; if (t) return t.call(e); if ("function" == typeof e.next) return e; if (!isNaN(e.length)) return { next: function next() { return e && r >= e.length && (e = void 0), { value: e && e[r++], done: !e }; } }; } throw new TypeError(_typeof(e) + " is not iterable"); }
function _regenerator() { /*! regenerator-runtime -- Copyright (c) 2014-present, Facebook, Inc. -- license (MIT): https://github.com/babel/babel/blob/main/packages/babel-helpers/LICENSE */ var e, t, r = "function" == typeof Symbol ? Symbol : {}, n = r.iterator || "@@iterator", o = r.toStringTag || "@@toStringTag"; function i(r, n, o, i) { var c = n && n.prototype instanceof Generator ? n : Generator, u = Object.create(c.prototype); return _regeneratorDefine2(u, "_invoke", function (r, n, o) { var i, c, u, f = 0, p = o || [], y = !1, G = { p: 0, n: 0, v: e, a: d, f: d.bind(e, 4), d: function d(t, r) { return i = t, c = 0, u = e, G.n = r, a; } }; function d(r, n) { for (c = r, u = n, t = 0; !y && f && !o && t < p.length; t++) { var o, i = p[t], d = G.p, l = i[2]; r > 3 ? (o = l === n) && (u = i[(c = i[4]) ? 5 : (c = 3, 3)], i[4] = i[5] = e) : i[0] <= d && ((o = r < 2 && d < i[1]) ? (c = 0, G.v = n, G.n = i[1]) : d < l && (o = r < 3 || i[0] > n || n > l) && (i[4] = r, i[5] = n, G.n = l, c = 0)); } if (o || r > 1) return a; throw y = !0, n; } return function (o, p, l) { if (f > 1) throw TypeError("Generator is already running"); for (y && 1 === p && d(p, l), c = p, u = l; (t = c < 2 ? e : u) || !y;) { i || (c ? (c > 1 && (G.n = c < 3 ? -1 : u), d(c, u)) : G.v = u); try { if (f = 2, i) { if (c || (o = "next"), t = i[o]) { if (!(t = t.call(i, u))) throw TypeError("iterator result is not an object"); if (!t.done) return t; u = t.value, c < 2 && (c = 0); } else 1 === c && (t = i.return) && t.call(i), c < 2 && (u = TypeError("The iterator does not provide a '" + o + "' method"), c = 1); i = e; } else if ((t = (y = G.n < 0) ? u : r.call(n, G)) !== a) break; } catch (t) { i = e, c = 1, u = t; } finally { f = 1; } } return { value: t, done: y }; }; }(r, o, i), !0), u; } var a = {}; function Generator() {} function GeneratorFunction() {} function GeneratorFunctionPrototype() {} t = Object.getPrototypeOf; var c = [][n] ? t(t([][n]())) : (_regeneratorDefine2(t = {}, n, function () { return this; }), t), u = GeneratorFunctionPrototype.prototype = Generator.prototype = Object.create(c); function f(e) { return Object.setPrototypeOf ? Object.setPrototypeOf(e, GeneratorFunctionPrototype) : (e.__proto__ = GeneratorFunctionPrototype, _regeneratorDefine2(e, o, "GeneratorFunction")), e.prototype = Object.create(u), e; } return GeneratorFunction.prototype = GeneratorFunctionPrototype, _regeneratorDefine2(u, "constructor", GeneratorFunctionPrototype), _regeneratorDefine2(GeneratorFunctionPrototype, "constructor", GeneratorFunction), GeneratorFunction.displayName = "GeneratorFunction", _regeneratorDefine2(GeneratorFunctionPrototype, o, "GeneratorFunction"), _regeneratorDefine2(u), _regeneratorDefine2(u, o, "Generator"), _regeneratorDefine2(u, n, function () { return this; }), _regeneratorDefine2(u, "toString", function () { return "[object Generator]"; }), (_regenerator = function _regenerator() { return { w: i, m: f }; })(); }
function _regeneratorDefine2(e, r, n, t) { var i = Object.defineProperty; try { i({}, "", {}); } catch (e) { i = 0; } _regeneratorDefine2 = function _regeneratorDefine(e, r, n, t) { function o(r, n) { _regeneratorDefine2(e, r, function (e) { return this._invoke(r, n, e); }); } r ? i ? i(e, r, { value: n, enumerable: !t, configurable: !t, writable: !t }) : e[r] = n : (o("next", 0), o("throw", 1), o("return", 2)); }, _regeneratorDefine2(e, r, n, t); }
var _marked = /*#__PURE__*/_regenerator().m(range),
  _marked2 = /*#__PURE__*/_regenerator().m(delegate);
function _callSuper(t, o, e) { return o = _getPrototypeOf(o), _possibleConstructorReturn(t, _isNativeReflectConstruct() ? Reflect.construct(o, e || [], _getPrototypeOf(t).constructor) : o.apply(t, e)); }
function _possibleConstructorReturn(t, e) { if (e && ("object" == _typeof(e) || "function" == typeof e)) return e; if (void 0 !== e) throw new TypeError("Derived constructors may only return object or undefined"); return _assertThisInitialized(t); }
function _assertThisInitialized(e) { if (void 0 === e) throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); return e; }
function _isNativeReflectConstruct() { try { var t = !Boolean.prototype.valueOf.call(Reflect.construct(Boolean, [], function () {})); } catch (t) {} return (_isNativeReflectConstruct = function _isNativeReflectConstruct() { return !!t; })(); }
function _superPropGet(t, o, e, r) { var p = _get(_getPrototypeOf(1 & r ? t.prototype : t), o, e); return 2 & r && "function" == typeof p ? function (t) { return p.apply(e, t); } : p; }
function _get() { return _get = "undefined" != typeof Reflect && Reflect.get ? Reflect.get.bind() : function (e, t, r) { var p = _superPropBase(e, t); if (p) { var n = Object.getOwnPropertyDescriptor(p, t); return n.get ? n.get.call(arguments.length < 3 ? e : r) : n.value; } }, _get.apply(null, arguments); }
function _superPropBase(t, o) { for (; !{}.hasOwnProperty.call(t, o) && null !== (t = _getPrototypeOf(t));); return t; }
function _getPrototypeOf(t) { return _getPrototypeOf = Object.setPrototypeOf ? Object.getPrototypeOf.bind() : function (t) { return t.__proto__ || Object.getPrototypeOf(t); }, _getPrototypeOf(t); }
function _inherits(t, e) { if ("function" != typeof e && null !== e) throw new TypeError("Super expression must either be null or a function"); t.prototype = Object.create(e && e.prototype, { constructor: { value: t, writable: !0, configurable: !0 } }), Object.defineProperty(t, "prototype", { writable: !1 }), e && _setPrototypeOf(t, e); }
function _setPrototypeOf(t, e) { return _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function (t, e) { return t.__proto__ = e, t; }, _setPrototypeOf(t, e); }
function _typeof(o) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) { return typeof o; } : function (o) { return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o; }, _typeof(o); }
function _classCallCheck(a, n) { if (!(a instanceof n)) throw new TypeError("Cannot call a class as a function"); }
function _defineProperties(e, r) { for (var t = 0; t < r.length; t++) { var o = r[t]; o.enumerable = o.enumerable || !1, o.configurable = !0, "value" in o && (o.writable = !0), Object.defineProperty(e, _toPropertyKey(o.key), o); } }
function _createClass(e, r, t) { return r && _defineProperties(e.prototype, r), t && _defineProperties(e, t), Object.defineProperty(e, "prototype", { writable: !1 }), e; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == _typeof(i) ? i : i + ""; }
function _toPrimitive(t, e) { if ("object" != _typeof(t) || !t) return t; var r; if ("undefined" != typeof Symbol && void 0 !== (r = t[Symbol.toPrimitive])) { var i = r.call(t, e || "default"); if ("object" != _typeof(i)) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === e ? String : Number)(t); }
var Animal = /*#__PURE__*/function () {
  "use strict";

  function Animal(name) {
    _classCallCheck(this, Animal);
    this.name = name;
  }
  return _createClass(Animal, [{
    key: "speak",
    value: function speak() {
      return this.name + " ses çıkarır";
    }
  }], [{
    key: "kind",
    value: function kind() {
      return "hayvan";
    }
  }]);
}();
var Dog = /*#__PURE__*/function (_Animal) {
  "use strict";

  function Dog(name, breed) {
    var _this;
    _classCallCheck(this, Dog);
    _this = _callSuper(this, Dog, [name]);
    _this.breed = breed;
    return _this;
  }
  _inherits(Dog, _Animal);
  return _createClass(Dog, [{
    key: "speak",
    value: function speak() {
      return _superPropGet(Dog, "speak", this, 3)([]) + " (hav)";
    }
  }, {
    key: "info",
    get: function get() {
      return this.name + "/" + this.breed;
    }
  }]);
}(Animal);
var Puppy = /*#__PURE__*/function (_Dog) {
  "use strict";

  function Puppy() {
    _classCallCheck(this, Puppy);
    return _callSuper(this, Puppy, arguments);
  }
  _inherits(Puppy, _Dog);
  return _createClass(Puppy);
}(Dog);
function range(n) {
  var i;
  return _regenerator().w(function (_context) {
    while (1) switch (_context.n) {
      case 0:
        i = 0;
      case 1:
        if (!(i < n)) {
          _context.n = 3;
          break;
        }
        _context.n = 2;
        return i;
      case 2:
        i++;
        _context.n = 1;
        break;
      case 3:
        return _context.a(2);
    }
  }, _marked);
}
function delegate() {
  return _regenerator().w(function (_context2) {
    while (1) switch (_context2.n) {
      case 0:
        return _context2.d(_regeneratorValues(range(2)), 1);
      case 1:
        _context2.n = 2;
        return 9;
      case 2:
        return _context2.a(2);
    }
  }, _marked2);
}
function load(_x) {
  return _load.apply(this, arguments);
}
function _load() {
  _load = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee(x) {
    var r, _t;
    return _regenerator().w(function (_context3) {
      while (1) switch (_context3.p = _context3.n) {
        case 0:
          _context3.p = 0;
          _context3.n = 1;
          return Promise.resolve(x * 2);
        case 1:
          r = _context3.v;
          if (!(r > 10)) {
            _context3.n = 2;
            break;
          }
          throw new Error("big");
        case 2:
          return _context3.a(2, "ok:" + r);
        case 3:
          _context3.p = 3;
          _t = _context3.v;
          return _context3.a(2, "err:" + _t.message);
        case 4:
          _context3.p = 4;
          console.log("done", x);
          return _context3.f(4);
        case 5:
          return _context3.a(2);
      }
    }, _callee, null, [[0, 3, 4, 5]]);
  }));
  return _load.apply(this, arguments);
}
function total(_x2) {
  return _total.apply(this, arguments);
}
function _total() {
  _total = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee2(list) {
    var s, i, _t2;
    return _regenerator().w(function (_context4) {
      while (1) switch (_context4.n) {
        case 0:
          s = 0;
          i = 0;
        case 1:
          if (!(i < list.length)) {
            _context4.n = 3;
            break;
          }
          _t2 = s;
          _context4.n = 2;
          return Promise.resolve(list[i]);
        case 2:
          s = _t2 += _context4.v;
          i++;
          _context4.n = 1;
          break;
        case 3:
          return _context4.a(2, s);
      }
    }, _callee2);
  }));
  return _total.apply(this, arguments);
}
var d = new Dog("Karabas", "kangal");
var p = new Puppy("Boncuk", "terrier");
console.log(d.speak(), d.info, Dog.kind(), p instanceof Animal, p.speak());
console.log(Array.from(range(d.name.length - 4)).join(","), Array.from(delegate()).join(","));
load(2).then(function (v) {
  return console.log(v);
});
load(9).then(function (v) {
  return console.log(v);
});
total([1, 2, 3]).then(function (v) {
  return console.log(v);
});
// EXPECT: class Animal {
// EXPECT: class Dog extends _Animal {
// EXPECT: super(name);
// EXPECT: super.speak()
// EXPECT: class Puppy extends _Dog {}
// EXPECT: function* range(n)
// EXPECT: yield* range(2);
// EXPECT: async function load(x)
// EXPECT: } finally {
// EXPECT: async function total(list)
// GONE: _inherits(Dog
// GONE: _context
// GONE: _classCallCheck(this
