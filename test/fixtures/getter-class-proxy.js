// E100: getter proxy; E101: sınıf statik üye proxy; E112: bağımsız operatör fonksiyonu; E97: fonksiyon proxy
function realLog(x) { return "log:" + x; }
function realWarn(x) { return "warn:" + x; }
var target = "hedef";
var holder = { get t() { return target; }, plain: 1 };
class Ops {
  static add(a, b) { return a + b; }
  static lt(a, b) { return a < b; }
  static call(f, x) { return f(x); }
  static K = 10;
}
function mul(a, b) { return a * b; }
var table = { l: realLog, w: realWarn };
function W(k) { return table[k]; }
function main(v) {
  var out = [holder.t, holder.plain, Ops.add(v, Ops.K), Ops.lt(v, 3), Ops.call(String, v), mul(v, 6)];
  out.push(W("l")(v), W("w")("x"));
  return out.join(",");
}
// üye üzerinden çağrı: const-fold programı baştan sona katlamasın
var api = { main: main };
console.log(api.main(2), api.main(5));
api.main = null;
// EXPECT: out = [target, holder.plain, v + 10, v < 3, String(v), v * 6];
// EXPECT: out.push(realLog(v), realWarn("x"));
// GONE: class Ops
// GONE: function mul
// GONE: W(
