// obfuscator.io fonksiyon sarmalayıcıları: decoder'a giden çağrılar çağrı yerinde açılır
var table = ["Hello", "world", "!"];
function dec(i, k) { return table[i - 10] + k; }
function main() {
  function w1(a, b, c) { return dec(c - -5, b); }
  function w2(a, b) { return dec(a - 3, ""); }
  // gölgeleme: çağrı yerinde dec başka bir fonksiyon, açılmamalı
  function inner() { var dec = function () { return "other"; }; return w1(0, "", 5) + dec(); }
  console.log(w1(0, "?", 5), w2(14), inner());
}
main();
// EXPECT: "Hello?", "world"
// EXPECT: return w1("", 5) + dec();
