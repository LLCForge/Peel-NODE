function f(a) {
  var mode = 2;
  var scale = mode * 10;
  var b = a;
  var out = b + scale;
  if (mode !== 2) { console.log("sccp-dead"); }
  var tt = (a | 0) * 3;
  var t2 = 7 * 6;
  return out;
}
var xs = [1, 2, "x"];
for (var i = 0; i < xs.length; i++) console.log(f(xs[i]));
// LEVEL: 3
// GONE: sccp-dead
// GONE: var tt
// GONE: t2
// GONE: scale
// EXPECT: a + 20
