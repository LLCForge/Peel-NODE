// js-confuser CFF dönüş bayrağı protokolü: F = undefined; V = g(); if (F) return V;
// iç fonksiyonun gövdesi dış fonksiyonun sonuna açılır
function outer(x) {
  let done, res;
  function inner() {
    let label = "flag-";
    if (x > 1) { done = true; return label + "big"; }
    if (x < -1) return;
    done = true;
    return label + "small";
  }
  done = undefined;
  res = inner();
  if (done) { return res; }
}
// açılmış makine kopyası: tek kez atanan, kapsam parametreli fonksiyon ifadesi, sonda çıplak return
function outer2(x) {
  let done, res, inner2;
  inner2 = function (states, scope = { K: {} }) {
    scope.K.v = "fe-" + x;
    done = true;
    return scope.K.v;
  };
  done = undefined;
  res = inner2([1, 2]);
  if (done) { return res; }
  return;
}
console.log(outer(Math.max(5, 1)), outer(Math.min(0, 1)), outer(-Math.abs(9)), outer2(Number("7")));
// EXPECT: "flag-small"
// EXPECT: "fe-7"
// GONE: done
// GONE: inner
