// E637: proxy anahtarları closure içinde hesaplanıyor; statik çözülemiyor, çalıştırılarak tamamlanır
var run = (function () {
  var K1 = Math.random() < 2 ? "lg" : "x", K2 = Math.random() < 2 ? "wn" : "y", K3 = Math.random() < 2 ? "ab" : "z";
  function V(k) {
    switch (k) {
      case K1: return console.log;
      case K2: return console.warn;
      case K3: return Math.abs;
    }
  }
  return function () { V("wn")("uyarı"); V("lg")("hi", V("ab")(-3)); };
})();
run();
// LEVEL: 3
// EXPECT: console.log)("hi", 3)
// EXPECT: console.warn)("uyarı")
// GONE: V("lg")
