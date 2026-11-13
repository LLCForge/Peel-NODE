function check() {
  var _0xa = 1;
  var _0xb = "x";
  var _0xc = true;
  var out = [];
  if (_0xa === 1) { out.push("a"); } else { out.push("dead"); }
  if (_0xb !== "x") { out.push("dead2"); } else { out.push("b"); }
  var c = _0xc ? "yes" : "no";
  while (false) { out.push("never"); }
  return out.join(",") + c;
}
console.log(check());
// LEVEL: 3
// EXPECT: out.push("a");
// EXPECT: + "yes"
// GONE: dead
// GONE: never
// GONE: _0xa
