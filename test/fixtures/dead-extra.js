// E210 kullanılmayan parametre, E212 kullanılmayan özel üye, E214 return sonrası erişilemeyen kod,
// E215 yinelenen tanım, E219 artık argüman
function main(v) {
  function scale(x, unusedFactor, y) { var r = x * y; return r; }
  function label(text) {
    return "<" + text + ">";
    console.log("asla çalışmaz");
    var late = 5;
  }
  function dup() { return "eski"; }
  function dup() { return "yeni"; }
  class Box {
    #secret = 42;
    #hidden() { return "gizli"; }
    #used = 7;
    get value() { return this.#used; }
  }
  var conf = { mode: "a", size: 1, mode: "b" };
  return [scale(v, 0, 3), label(v, "fazla", 99), dup(), new Box().value, conf.mode, Object.keys(conf).join("")].join(",");
}
// üye üzerinden çağrı: const-fold programı baştan sona katlamasın
var api = { main: main };
console.log(api.main(4));
api.main = null;
// EXPECT: function scale(x, y)
// EXPECT: scale(v, 3)
// EXPECT: label(v)
// GONE: late = 5
// EXPECT: mode: "b",
// GONE: asla çalışmaz
// GONE: eski
// GONE: #secret
// GONE: #hidden
// GONE: fazla
