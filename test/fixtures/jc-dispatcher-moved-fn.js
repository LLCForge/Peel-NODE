// js-confuser yüksek ayar: dağıtıcının iç fonksiyonu hiç verilmeyen bir parametreye taşınmış (if (!mk) mk = …),
// girdi rest dizisiyle maskelenmiş (negatif/büyük indeksler), dönüş üçlü ifadeyle sarılıyor
var P, cache = {};
function D(name, flag, ret, lens = {}, mk, out, fns) {
  if (!mk) {
    mk = function (o) { return o; };
  }
  lens = mk(lens);
  fns = {
    k: function (...M) { [M[5], [M[-1]]] = P; M[70] = M[-1] + "!"; return M[70]; },
  };
  if (flag === "clr") { P = []; }
  if (flag === "ref") {
    var mk2 = function (...v) { P = v; return fns[name].apply(this); };
    out = cache[name] || (cache[name] = mk2);
  } else {
    out = fns[name]();
  }
  return ret === "box" ? { v: out } : out;
}
function call(...a) { var o = {}; P = [o, a]; return new D("k", "x", "box").v; }
console.log(call("moved-fn"));
// EXPECT: "!"
// GONE: fns[
// GONE: "box"
// GONE: M[
