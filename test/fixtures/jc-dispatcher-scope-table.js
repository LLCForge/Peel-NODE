// js-confuser yüksek ayar: kapsam nesnesi bölünemeyince dispatcher tablosu kendi taze kapsam kökünde
// (S.K.fns = {…}); fonksiyon üretme dalı makinenin içinde kaldığı için .apply(this) görünmüyor
var P;
function M() { return function () {}; }
function D(name, flag, ret, lens = {}, out) {
  let S = { K: {} };
  S.K[name + "_seen"] = true;
  S.K.fns = { g: function () { let a, b; [a, [b]] = P; return "T:" + b; } };
  if (flag === "clr") { P = []; }
  if (flag === "ref") { S.K.out = M(); } else { S.K.out = S.K.fns[name](); }
  if (ret === "box") { return { v: S.K.out }; }
  S.L = {};
  return S.K.out;
}
function g(...a) { var o = {}; P = [o, a]; return new D("g", "x", "box").v; }
console.log(g("scope-table"));
// EXPECT: "T:"
// GONE: fns[
// GONE: "box"
