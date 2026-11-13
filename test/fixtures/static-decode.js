var enc = "%68%74%74%70%73%3A%2F%2Fevil.example%2Fgate";
var url = decodeURIComponent(enc);
var u2 = unescape("%u0063%u006F%u006F%u006B%u0069%u0065");
var port = parseInt("1f90", 16);
var codes = [104, 105, 100, 100, 101, 110];
var word = String.fromCharCode.apply(null, codes);
var digits = [4, 4, 3].join("");
var rev = "olleh".split("").reverse().join("");
var txt = new TextDecoder("utf-8").decode(new Uint8Array([112, 97, 121, 108, 111, 97, 100]));
var e = encodeURIComponent("a b&c");
console.log(url, u2, port, word, digits, rev, txt, e);
// EXPECT: "https://evil.example/gate"
// EXPECT: "cookie"
// EXPECT: 8080
// EXPECT: "hidden"
// EXPECT: "443"
// EXPECT: "hello"
// EXPECT: "payload"
// EXPECT: "a%20b%26c"
// GONE: TextDecoder
// GONE: unescape
// GONE: parseInt
