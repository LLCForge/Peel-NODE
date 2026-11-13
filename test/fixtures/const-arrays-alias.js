// js-confuser: dizi alt nesnesi başka kapsam nesnesine geçiyor ({ v: scope.v }) ve orada başka kökle okunuyor
function inner(s) { return s.v.L[4] + s.v.L[s.v.n]; }
function main(scope = { v: {} }) {
  scope.v.L = [0, 1, "length", "Hello", " world"];
  scope.v.n = 3;
  console.log(scope.v.L[3], inner({ v: scope.v }));
}
main();
// LEVEL: 3
// EXPECT: return " world" + s.v.L[s.v.n];
// EXPECT: scope.v.L = [
