// js-confuser rgf benzeri: fonksiyon kaynağı kodlanmış string'de, çalışma anında üretiliyor
var add = new Function("a", "b", atob("cmV0dXJuIGEgKyBiICsgMTs="));
// kaynağı parametreden gelen üretici: farklı çağrılarda farklı kod, dokunulmamalı
var make = function (src) { return new Function("x", src); };
console.log(add(2, 3), make("return x * 2")(4));
// LEVEL: 3
// EXPECT: var add = function (a, b) {
// EXPECT: return a + b + 1;
// EXPECT: return new Function("x", src);
