var _0x9 = ["Z2V0", "dGl0bGU=", "bG9n"];
function _0xd(i) {
  _0xd = function (j) {
    var k = _0xd.c[j];
    if (k === undefined) { k = atob(_0x9[j]); _0xd.c[j] = k; }
    return k;
  };
  _0xd.c = {};
  return _0xd(i);
}
function readTitle() { return document.title; }
function pureLabel() { return "x" + _0xd(1); }
console[_0xd(2)](_0xd(0), readTitle(), pureLabel());
// LEVEL: 3
// EXPECT: console.log("get", readTitle(), pureLabel());
// EXPECT: return "xtitle";
