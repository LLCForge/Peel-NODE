// js-confuser iç fonksiyonu: literal dizi kapsam nesnesinde; içteki aynı adlı parametre başka bir nesne
function main(scope = { a: {} }) {
  scope.a.L = [0, 1, "length", "Hello", " world"];
  var inner = function (scope) { return scope.a.L[0]; };
  console.log(scope.a.L[3] + scope.a.L[4], inner({ a: { L: ["other"] } }));
}
main();
// LEVEL: 3
// EXPECT: "Hello world",
// EXPECT: return scope.a.L[0];
