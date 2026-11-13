// E107: bağlanmış fonksiyonun hemen çağrılması düzleşir; E109: kısmi uygulama çağrı yerinde açılır
function join3(a, b, c) { return [a, b, c].join("-"); }
var obj = { tag: "o", say: function (x) { return this.tag + x; } };
function main(v) {
  var withPrefix = join3.bind(null, "pre");
  var r1 = join3.bind(undefined, v)(2, 3);
  var r2 = obj.say.bind(obj)("!");
  var r3 = withPrefix("mid", "end");
  var r4 = withPrefix("x", "y");
  return [r1, r2, r3, r4].join(" ");
}
// üye üzerinden çağrı: const-fold programı baştan sona katlamasın
var api = { main: main };
console.log(api.main(1));
api.main = null;
// EXPECT: r1 = join3(v, 2, 3);
// EXPECT: r2 = obj.say("!");
// EXPECT: join3.call(null, "pre", "mid", "end")
// GONE: bind
// GONE: withPrefix
