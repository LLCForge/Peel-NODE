var _0xa = 1;
var _0xb = 2;
function _0xunused() { return 42; }
function _0xused() { return _0xa; }
var _0xside = console.log("side effect");
console.log(_0xused());
// EXPECT: console.log("side effect");
// GONE: 42
// GONE: = 2
