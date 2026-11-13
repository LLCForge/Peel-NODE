function sw(d) {
  var s;
  switch (d) { case 5: s = "five"; break; default: s = "other"; }
  return s;
}
function th(a) {
  a = a | 0;
  var f;
  if (a > 3) { f = 1; console.log("big" + a); } else { f = 0; console.log("small" + a); }
  if (f === 1) { console.log("was big"); } else { console.log("was small"); }
}
function ic(c, x) {
  var r;
  if (c > 1) r = x + 1; else r = x - 1;
  return r;
}
function pr(c) {
  if (c === 2) return true;
  return false;
}
function co(a) {
  a = a | 0;
  if (a > 10) {
    if (a > 5) console.log("implied"); else console.log("corr-dead");
  }
}
var vals = [1, 5, 2, 20];
for (var i = 0; i < vals.length; i++) {
  console.log(sw(vals[i]), ic(vals[i], 10), pr(vals[i]));
  th(vals[i]);
  co(vals[i]);
}
// LEVEL: 3
// EXPECT: d === 5
// GONE: switch (d)
// GONE: f === 1
// EXPECT: c > 1 ?
// EXPECT: return c === 2;
// GONE: corr-dead
