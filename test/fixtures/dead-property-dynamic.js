// özellik adı çalışma anında üretiliyor: hiçbir atama ölü sayılmamalı
function key(i) { return ["sec", "ret"].slice(0, i).join(""); }
function main(scope = { a: {} }) {
  scope.a.secret = function () { return "found"; };
  console.log((1, scope.a[key(2)])());
}
main();
// EXPECT: scope.a.secret = function
