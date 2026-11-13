function licm(n, k) {
  k = k | 0;
  var t = 0;
  for (var i = 0; i < n; i++) { t = t + (k * k + 3); }
  return t;
}
function sr() {
  var t = 0;
  for (var i = 0; i < 100; i++) { t = t + i * 4; }
  return t;
}
function iv(arr) {
  var r = [];
  for (var i = 0, j = 7; i < 40; i++, j += 2) { if (i < arr.length) r.push(j); }
  return r.join();
}
function unroll(p) {
  var s = "";
  for (var i = 0; i < 3; i++) { s = s + "u" + i; }
  return s + p;
}
function peel(n) {
  var first = true, out = "";
  for (var i = 0; i < n; i++) {
    if (first) out = out + "["; else out = out + ",";
    out = out + i;
    first = false;
  }
  return out + "]";
}
function fuse(n) {
  var a = [0, 0, 0, 0, 0, 0, 0, 0], b = [0, 0, 0, 0, 0, 0, 0, 0];
  for (var i = 0; i < n; i++) { a[i] = i * 2; }
  for (i = 0; i < n; i++) { b[i] = a[i] + 1; }
  return a.join() + "|" + b.join();
}
function fission() {
  var small = [0, 0, 0, 0], big = [1, 2, 3, 4];
  for (var i = 0; i < 4; i++) {
    small[i] = i + 100;
    big[i] = big[i] * 3 + i;
    big[i] = big[i] * 5 + i * 2;
    big[i] = big[i] * 7 + i * 3;
    big[i] = big[i] * 11 + i * 4;
    big[i] = big[i] * 13 + i * 5;
    big[i] = big[i] * 17 + i * 6;
    big[i] = big[i] * 19 + i * 7;
    big[i] = big[i] * 23 + i * 8;
    big[i] = big[i] * 29 + i * 9;
    big[i] = big[i] * 31 + i * 10;
    big[i] = big[i] % 1000003 + i * 11;
    big[i] = big[i] % 1000033 + i * 12;
  }
  return small.join() + "|" + big.join();
}
var ns = [0, 3, 5];
for (var q = 0; q < ns.length; q++) {
  console.log(licm(ns[q], ns[q] + 1), iv([1, 2, ns[q]]), unroll(ns[q]), peel(ns[q]), fuse(ns[q]));
}
console.log(sr(), fission());
// LEVEL: 3
// EXPECT: _inv
// EXPECT: _sr
// GONE: i * 4
// GONE: j += 2
// GONE: i < 3
// GONE: if (first)
// GONE: for (i = 0;
// EXPECT: small[0] = 100
