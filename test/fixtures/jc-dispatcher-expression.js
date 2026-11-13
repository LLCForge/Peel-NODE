// js-confuser yüksek ayar: CFF açıldıktan sonra dağıtıcı tek kez atanan bir fonksiyon ifadesi, argümanları rest
// dizisinden açıyor, fonksiyon tablosu yerel değişkende, temizleme bayrağı boş fonksiyona "in" testiyle korunuyor
(function () {
  let E, P, D, cache, greet;
  E = function () { return; };
  cache = {};
  P = undefined;
  greet = function (...a) { const o = {}; P = [o, a]; return D("g1"); };
  D = function (...R) {
    let name, flag, ret, lens, out, fns, mk;
    [name, flag, ret, lens = {}] = R;
    fns = {
      g1: function () { let x, s; [x, [s]] = P; return "Hi " + s; },
    };
    if (!("zz" in E) && flag === "clr") { P = []; }
    if (flag === "ref") {
      mk = function (...v) { P = v; return fns[name].apply(this); };
      out = cache[name] || (cache[name] = mk);
    } else {
      out = fns[name]();
    }
    return ret === "box" ? { b: out } : out;
  };
  console.log(greet("expr-dispatch"));
})();
// EXPECT: "Hi "
// GONE: fns[
// GONE: "clr"
// GONE: apply(this)
