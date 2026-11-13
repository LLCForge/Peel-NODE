// A-17: destructuring ile gizlenmiş atamalar düz atamaya açılır (takas gibi kendine başvuranlar açılmaz)
function run(seed) {
  var [alpha, beta] = [seed + 1, "beta"];
  var { k1: gamma, k2: delta } = { k1: 3, k2: "delta" };
  var first, second;
  [first, second] = [alpha * 2, beta];
  var [p, q] = [1, 2];
  [p, q] = [q, p];
  return [alpha, beta, gamma, delta, first, second, p, q].join(",");
}
// üye üzerinden çağrı: const-fold programı baştan sona katlamasın
var api = { run: run };
console.log(api.run(4));
api.run = null;
// EXPECT: alpha = seed + 1
// EXPECT: [alpha, "beta", 3, "delta", first
// EXPECT: first = alpha * 2;
// EXPECT: [p, q] = [q, p];
// GONE: [alpha, beta]
// GONE: k1:
