function _0xe() {}
var _0xf = {};
var v = "q" in _0xf ? "dead" : "live";
if ("z" in _0xe) { console.log("dead2"); }
if ("length" in _0xe) { console.log("has length"); }
console.log(v);
// EXPECT: v = "live";
// EXPECT: console.log("has length");
// GONE: dead2
// GONE: " in
