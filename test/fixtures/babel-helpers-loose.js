// Babel 7.28 loose: true gerçek çıktısı: _createForOfIteratorHelperLoose, _extends, _objectWithoutPropertiesLoose, (_o = {}, …) nesne literali, _inheritsLoose + _proto + S.call(this) || this
var _lit;
function _inheritsLoose(t, o) { t.prototype = Object.create(o.prototype), t.prototype.constructor = t, _setPrototypeOf(t, o); }
function _setPrototypeOf(t, e) { return _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function (t, e) { return t.__proto__ = e, t; }, _setPrototypeOf(t, e); }
function _regenerator() { /*! regenerator-runtime -- Copyright (c) 2014-present, Facebook, Inc. -- license (MIT): https://github.com/babel/babel/blob/main/packages/babel-helpers/LICENSE */ var e, t, r = "function" == typeof Symbol ? Symbol : {}, n = r.iterator || "@@iterator", o = r.toStringTag || "@@toStringTag"; function i(r, n, o, i) { var c = n && n.prototype instanceof Generator ? n : Generator, u = Object.create(c.prototype); return _regeneratorDefine2(u, "_invoke", function (r, n, o) { var i, c, u, f = 0, p = o || [], y = !1, G = { p: 0, n: 0, v: e, a: d, f: d.bind(e, 4), d: function d(t, r) { return i = t, c = 0, u = e, G.n = r, a; } }; function d(r, n) { for (c = r, u = n, t = 0; !y && f && !o && t < p.length; t++) { var o, i = p[t], d = G.p, l = i[2]; r > 3 ? (o = l === n) && (u = i[(c = i[4]) ? 5 : (c = 3, 3)], i[4] = i[5] = e) : i[0] <= d && ((o = r < 2 && d < i[1]) ? (c = 0, G.v = n, G.n = i[1]) : d < l && (o = r < 3 || i[0] > n || n > l) && (i[4] = r, i[5] = n, G.n = l, c = 0)); } if (o || r > 1) return a; throw y = !0, n; } return function (o, p, l) { if (f > 1) throw TypeError("Generator is already running"); for (y && 1 === p && d(p, l), c = p, u = l; (t = c < 2 ? e : u) || !y;) { i || (c ? (c > 1 && (G.n = c < 3 ? -1 : u), d(c, u)) : G.v = u); try { if (f = 2, i) { if (c || (o = "next"), t = i[o]) { if (!(t = t.call(i, u))) throw TypeError("iterator result is not an object"); if (!t.done) return t; u = t.value, c < 2 && (c = 0); } else 1 === c && (t = i.return) && t.call(i), c < 2 && (u = TypeError("The iterator does not provide a '" + o + "' method"), c = 1); i = e; } else if ((t = (y = G.n < 0) ? u : r.call(n, G)) !== a) break; } catch (t) { i = e, c = 1, u = t; } finally { f = 1; } } return { value: t, done: y }; }; }(r, o, i), !0), u; } var a = {}; function Generator() {} function GeneratorFunction() {} function GeneratorFunctionPrototype() {} t = Object.getPrototypeOf; var c = [][n] ? t(t([][n]())) : (_regeneratorDefine2(t = {}, n, function () { return this; }), t), u = GeneratorFunctionPrototype.prototype = Generator.prototype = Object.create(c); function f(e) { return Object.setPrototypeOf ? Object.setPrototypeOf(e, GeneratorFunctionPrototype) : (e.__proto__ = GeneratorFunctionPrototype, _regeneratorDefine2(e, o, "GeneratorFunction")), e.prototype = Object.create(u), e; } return GeneratorFunction.prototype = GeneratorFunctionPrototype, _regeneratorDefine2(u, "constructor", GeneratorFunctionPrototype), _regeneratorDefine2(GeneratorFunctionPrototype, "constructor", GeneratorFunction), GeneratorFunction.displayName = "GeneratorFunction", _regeneratorDefine2(GeneratorFunctionPrototype, o, "GeneratorFunction"), _regeneratorDefine2(u), _regeneratorDefine2(u, o, "Generator"), _regeneratorDefine2(u, n, function () { return this; }), _regeneratorDefine2(u, "toString", function () { return "[object Generator]"; }), (_regenerator = function _regenerator() { return { w: i, m: f }; })(); }
function _regeneratorDefine2(e, r, n, t) { var i = Object.defineProperty; try { i({}, "", {}); } catch (e) { i = 0; } _regeneratorDefine2 = function _regeneratorDefine(e, r, n, t) { function o(r, n) { _regeneratorDefine2(e, r, function (e) { return this._invoke(r, n, e); }); } r ? i ? i(e, r, { value: n, enumerable: !t, configurable: !t, writable: !t }) : e[r] = n : (o("next", 0), o("throw", 1), o("return", 2)); }, _regeneratorDefine2(e, r, n, t); }
var _marked = /*#__PURE__*/_regenerator().m(gen);
function _objectWithoutPropertiesLoose(r, e) { if (null == r) return {}; var t = {}; for (var n in r) if ({}.hasOwnProperty.call(r, n)) { if (-1 !== e.indexOf(n)) continue; t[n] = r[n]; } return t; }
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function _createForOfIteratorHelperLoose(r, e) { var t = "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"]; if (t) return (t = t.call(r)).next.bind(t); if (Array.isArray(r) || (t = _unsupportedIterableToArray(r)) || e && r && "number" == typeof r.length) { t && (r = t); var o = 0; return function () { return o >= r.length ? { done: !0 } : { done: !1, value: r[o++] }; }; } throw new TypeError("Invalid attempt to iterate non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }
function _unsupportedIterableToArray(r, a) { if (r) { if ("string" == typeof r) return _arrayLikeToArray(r, a); var t = {}.toString.call(r).slice(8, -1); return "Object" === t && r.constructor && (t = r.constructor.name), "Map" === t || "Set" === t ? Array.from(r) : "Arguments" === t || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : void 0; } }
function _arrayLikeToArray(r, a) { (null == a || a > r.length) && (a = r.length); for (var e = 0, n = Array(a); e < a; e++) n[e] = r[e]; return n; }
var pts = [[1, 2], [3, 4]];
var out = [];
for (var _i = 0, _pts = pts; _i < _pts.length; _i++) {
  var _pts$_i = _pts[_i],
    x = _pts$_i[0],
    y = _pts$_i[1];
  out.push(x + y);
}
for (var _iterator = _createForOfIteratorHelperLoose(new Set(["a", "b"])), _step; !(_step = _iterator()).done;) {
  var s = _step.value;
  out.push(s);
}
var base = {
  a: 1,
  b: 2
};
var merged = _extends({}, base, {
  c: 3
});
var key = "dyn";
var lit = (_lit = {}, _lit[key] = 1, _lit.plain = 2, _lit);
var a = merged.a,
  rest = _objectWithoutPropertiesLoose(merged, ["a"]);
var kinds = [out.length, "s", null, function () {
  return 1;
}].map(function (v) {
  return typeof v;
});
function swap(pair) {
  var p = pair[0],
    q = pair[1];
  return [q, p];
}
function first(list) {
  var h = list[0],
    t = _arrayLikeToArray(list).slice(1);
  return [].concat(t, [h]);
}
function biggest(xs) {
  return Math.max.apply(Math, xs);
}
function gen() {
  return _regenerator().w(function (_context) {
    while (1) switch (_context.n) {
      case 0:
        _context.n = 1;
        return 1;
      case 1:
        _context.n = 2;
        return 2;
      case 2:
        return _context.a(2);
    }
  }, _marked);
}
var fromGen = [];
for (var _iterator2 = _createForOfIteratorHelperLoose(gen()), _step2; !(_step2 = _iterator2()).done;) {
  var g = _step2.value;
  fromGen.push(g);
}
var m = new Map([["k", 1]]);
for (var _iterator3 = _createForOfIteratorHelperLoose(m), _step3; !(_step3 = _iterator3()).done;) {
  var _step3$value = _step3.value,
    mk = _step3$value[0],
    mv = _step3$value[1];
  fromGen.push(mk + mv);
}
var extra = _extends({}, base, {
  d: 4
});
var Shape = /*#__PURE__*/function () {
  "use strict";

  function Shape(n) {
    this.n = n;
  }
  var _proto = Shape.prototype;
  _proto.area = function area() {
    return this.n;
  };
  return Shape;
}();
var Square = /*#__PURE__*/function (_Shape) {
  "use strict";

  function Square(n) {
    return _Shape.call(this, n * n) || this;
  }
  _inheritsLoose(Square, _Shape);
  var _proto2 = Square.prototype;
  _proto2.area = function area() {
    return _Shape.prototype.area.call(this) + 0;
  };
  return Square;
}(Shape);
console.log(out.join(","), JSON.stringify(merged), JSON.stringify(lit), a, JSON.stringify(rest), kinds.join(","));
console.log(swap([1, 2]).join(","), first([5, 6, 7]).join(","), biggest([3, 9]), fromGen.join(","), JSON.stringify(extra), new Square(3).area());
// EXPECT: of new Set(["a", "b"]))
// EXPECT: ...base,
// EXPECT: [key]: 1,
// EXPECT: ...rest } = merged;
// EXPECT: class Square extends _Shape {
// EXPECT: super(n * n);
// EXPECT: super.area()
// GONE: _iterator.s()
// GONE: _inherits(Square
// GONE: _objectSpread(_objectSpread
// EXPECT: _pts$_i of pts)
// EXPECT: _step3$value of m)
// GONE: _objectWithoutPropertiesLoose(merged
// GONE: _extends({}, base
// GONE: _inheritsLoose(Square
// GONE: _proto.area
