// js-confuser yüksek ayar (pack): program bir IIFE'nin içinde, giriş makinesi gövdenin sonunda "return M(dizi)"
// ile çağrılıyor, kapsam nesnesi varsayılan parametrede ve blok kapsamı (K.L = {}) bloğa girerken kuruluyor
(function (G) {
  function sum(a) { for (var s = 0, i = 0; i < a.length; i++) { s += a[i]; } return s; }
  function M(S, scope = { K: {} }, rt, args) {
    while (sum(S) !== 17)
      switch (sum(S)) {
        case 3: scope.L = {}; scope.L.msg = "pack-"; scope.K.n = 2; S[0] += 4; break;
        case 7: scope.L.msg += "machine"; console.log(scope.L.msg, scope.K.n * 21); S[1] += 10; break;
      }
  }
  console.log("start");
  return M([1, 2]);
})({});
// EXPECT: "start"
// GONE: sum(
// GONE: scope
// GONE: while
