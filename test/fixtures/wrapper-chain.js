// E99: sarmalayıcı zinciri (w2 → w1 → dec) tek pass'te açılır; E109: literal olmayan argümanla kısmi uygulama
function dec(i, k) { return String(i) + k + typeof window; }
function main(v) {
  function w1(a, b) { return dec(a - 3, b); }
  function w2(x, y) { return w1(y + 1, x); }
  return [w2("k", 12), w1(v, "p"), w2("z", v * 2)].join("|");
}
// üye üzerinden çağrı: const-fold programı baştan sona katlamasın
var api = { main: main };
console.log(api.main(7));
api.main = null;
// EXPECT: dec(10, "k")
// EXPECT: dec(v - 3, "p")
// EXPECT: dec(v * 2 + 1 - 3, "z")
// GONE: w1(
// GONE: w2(
