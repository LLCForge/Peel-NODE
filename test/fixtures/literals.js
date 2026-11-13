var s = "\x48\x65\x6c\x6c\x6f";
var o = { "key": 0x1f };
console["log"](s, o["key"]);
// EXPECT: s = "Hello";
// EXPECT: console.log(s, 31);
// GONE: \x48
