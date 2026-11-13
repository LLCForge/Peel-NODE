// js-confuser: decoder kapsam nesnesinde, this'siz çağrılıyor: (1, scope.a.d)(…)
function main(scope = { a: {} }) {
  scope.a.d = function (i, k) {
    var s = "Ifmmp!xpsme";
    return s.slice(i, i + k).split("").map(function (c) { return String.fromCharCode(c.charCodeAt(0) - 1); }).join("");
  };
  scope.a.n = function (x) { return x * 2; };
  // CFF sarmalayıcısı gibi: kaynağı ipucu vermez, tek çağrı
  scope.a.w = function (i, k) { return (1, scope.a.d)(i, k); };
  // string döndürür ama yan etkisi var: dokunulmamalı
  scope.a.s = function (i) { console.log("side"); return "x" + i; };
  console.log((1, scope.a.d)(0, 5) + (1, scope.a.d)(5, 6), (1, scope.a.n)(4), (1, scope.a.w)(6, 5), (1, scope.a.s)(7));
}
main();
// LEVEL: 3
// EXPECT: "Hello world"
// EXPECT: (1, scope.a.n)(4)
// EXPECT: "world",
// EXPECT: (1, scope.a.s)(7)
