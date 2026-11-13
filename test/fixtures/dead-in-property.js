// js-confuser deadCode koruması kapsam yolunda: "k" in S.K.f, f'ye programda tek yazma (boş fonksiyon) ve
// testler o atamadan sonra çalışıyor → test false, korunan çağrı ölü
(function () {
  var S = { K: {} };
  S.K.empty = function () { return; };
  S.K.run = function (x) {
    if ("zQx81" in S.K.empty) { console.log("never-guarded"); }
    return x * 2;
  };
  [S].forEach(function (o) { o.K.tag = "t"; });
  console.log("prop-in", S.K.run(Number("4")), S.K.tag);
})();
// EXPECT: "prop-in"
// GONE: never-guarded
