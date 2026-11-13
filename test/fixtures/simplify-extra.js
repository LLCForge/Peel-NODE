// A-14 şablon literalindeki gömülü string'ler, E126 instanceof/in, E136 !!x, E138 +"", E140 0+x, E142 x*0, E162 return zincirleri
var LIMIT = 40;
function main(a, b, name) {
  var out = [];
  out.push(`Merhaba ${"dünya"}, ${name} ${7}${`!`}`);
  out.push("s" instanceof String, [1, 2] instanceof Array, "k" in { k: 1 }, 2 in [5, 6], "zz" in { k: 1 });
  var flag = !!name;
  out.push(flag, +"", +"12", +true, +[]);
  out.push(0 + (a | b), (a & b) + 0, (a * 2) - 0, (LIMIT >>> 1) * 0, 0 * (LIMIT & 255));
  return out.push(name), out.push(pick(a, b)), out.join(";");
}
function pick(a, b) {
  return a > b ? (a++, "büyük" + a) : a < b ? "küçük" : "eşit";
}
// üye üzerinden çağrı: const-fold programı baştan sona katlamasın
var api = { main: main };
console.log(api.main(6, 3, "peel"), api.main(1, 1, ""));
api.main = null;
// EXPECT: `Merhaba dünya, ${name} 7!`
// EXPECT: false, true, true, false, false
// EXPECT: const flag = Boolean(name);
// EXPECT: out.push(flag, 0, 12, 1, 0);
// EXPECT: out.push(a | b, a & b, a * 2, 0, 0);
// EXPECT: out.push(name);
// EXPECT: return out.join(";");
// EXPECT: if (a > b) {
// GONE: !!name
