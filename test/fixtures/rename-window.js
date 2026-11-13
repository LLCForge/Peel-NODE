// E228: window.x ile okunan global korunur, diğeri adlandırılır
var _0x12 = 5;
var _0x34 = "hello";
console.log(window._0x12, _0x12, _0x34);
// EXPECT: var _0x12 = 5;
// EXPECT: window._0x12
// GONE: _0x34
