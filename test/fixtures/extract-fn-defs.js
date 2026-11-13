// fonksiyon tanımlayan atamalar yardımcıya çıkarılmaz (tanım gizlenir, henüz açılmamış yapılar saklanır)
function make(o, flag) {
  if (flag) {
    o.a = function (x) { return x + 1; };
    o.b = function (x) { return x * 2; };
    o.c = function (x) { return o.a(o.b(x)); };
    return o.c(3);
  }
  o.a = function (x) { return x + 1; };
  o.b = function (x) { return x * 2; };
  o.c = function (x) { return o.a(o.b(x)); };
  return o.c(4) + 1;
}
console.log(["", "y"].map(function (f) { return make({}, f); }).join());
// EXPECT: console.log(
// GONE: extracted1
