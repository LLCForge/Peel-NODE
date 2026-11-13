// js-confuser: rest parametre + length hilesi → gerçek parametreler
function sum3(...M) {
  M.length = 3;
  var total = M[0] + M[1];
  if (M[2] !== undefined) total += M[2];
  M[0] = 0;
  return total + M[0];
}
var mul = function (...Q) {
  Q.length = 2;
  return Q[0] * Q[1];
};
console.log(sum3(1, 2), sum3(1, 2, 3, 4), mul(6, 7));
// EXPECT: var mul = function (arg0, arg1)
// GONE: .length = 3
// GONE: ...Q
