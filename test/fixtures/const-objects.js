// obfuscator.io: sabit anahtar nesnesi ve operatör/çağrı proxy'leri
var o = {
  _0xa: 1179,
  _0xb: "uZJO",
  KJs: function (a, b) { return a + b; },
  Ltr: function (a, b) { return a < b; },
  Ytr: function (f, x, y) { return f(x, y); },
};
var math = { pow: function (b, e) { var r = 1; while (e--) r *= b; return r; } };
// değiştirilen nesneye dokunulmaz
var m = { k: 1 };
m.k = 2;
console.log(o.KJs(o._0xa, 1), o.Ltr(1, 2), o.Ytr(Math.max, 3, 4), o["_0xb"], math.pow(2, 3), m.k);
// EXPECT: 1180
// EXPECT: "uZJO"
// EXPECT: console.log(1180, true, 4, "uZJO"
// EXPECT: m.k = 2;
// GONE: KJs
