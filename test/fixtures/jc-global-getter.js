// js-confuser globalConcealing: ad→global switch'i olan getter (kapsam nesnesinden yerel değişkene bölünmüş);
// tek string argümanlı çağrılar global nesneye çözülür, getter dışarıya yazmıyor
(function () {
  let G;
  G = function (...a) {
    let name;
    [name] = a;
    switch (name) {
      case "c0nsole": return console;
      case "0bj": return Object;
    }
    return;
  };
  G("c0nsole").log("global-getter", typeof G("0bj").keys);
})();
// EXPECT: console.log("global-getter"
// GONE: G(
// GONE: c0nsole
