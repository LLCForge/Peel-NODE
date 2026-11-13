// Gölgelenen ve deterministik olmayan ifadeler katlanmamalı
function f(String) {
  return String(1) + typeof undefined;
}
var n = Math.random() * 2;
var t0 = typeof foo === "undefined" ? 1 : 2;
console.log(f(function (x) { return "s" + x; }), n > -1, t0);
// EXPECT: return String(1) + "undefined";
// EXPECT: Math.random() * 2
// EXPECT: typeof foo === "undefined"
