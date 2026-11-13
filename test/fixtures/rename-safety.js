// E227/E230: with ve eval'in görebildiği isimler korunur; diğer kapsamlardaki isimler yine de adlandırılır
function _0x11(_0x22) { return eval("_0x22 * 2"); }
function _0x33(_0x44) { var _0x55 = _0x44 + 1; return _0x55; }
function _0x66(_0x77) { with (_0x77) { return _0x88; } var _0x88; }
console.log(_0x11(2), _0x33(3), _0x66({ _0x88: 5 }));
// EXPECT: eval("_0x22 * 2")
// EXPECT: with (_0x77)
// GONE: _0x44
// GONE: _0x55
