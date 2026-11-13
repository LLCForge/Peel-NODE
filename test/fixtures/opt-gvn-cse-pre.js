function g(n, flag) {
  n = n | 0;
  var p = n * n + 7;
  var q = n * n + 7;
  var r = (n * 5 - 1) * ((n * 5 - 1) + 2);
  var s;
  if (flag) { s = n * 3 + 1; console.log("then"); } else { s = 0; console.log("else"); }
  var u = n * 3 + 1;
  return [p, q, r, s, u].join(",");
}
var cases = [[1, true], [4, false], [-2, true]];
for (var i = 0; i < cases.length; i++) console.log(g(cases[i][0], cases[i][1]));
// LEVEL: 3
// GONE: var q = n * n + 7
// GONE: var u = n * 3 + 1
// EXPECT: _cse
// EXPECT: _pre
