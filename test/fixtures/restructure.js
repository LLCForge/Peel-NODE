var flags = /ab+c/gi.flags;
var isGlobal = /x/g.global;
var srcLen = "abc".length;
var asText = /a\/b/m.toString();
var [host, port] = ["evil.example", 8080];
var { k: key, v: val } = { k: "id", v: 42 };
var { log: print } = console;
var u = void 0;
function pick(n) {
  return n > 10 ? "big" : n > 5 ? "mid" : "small";
}
globalThis.pick = pick;
var level;
level = port > 9000 ? 3 : port > 8000 ? 2 : 1;
function add(...M) {
  M.length = 2;
  return M[0] + M[1];
}
var cfg = { base: "https://", tld: ".example" };
var full;
with (cfg) {
  full = base + host + tld;
}
print(flags, isGlobal, srcLen, asText, host, port, key, val, u === undefined, pick(7), level, add(2, 3), full);
// EXPECT: "gi"
// EXPECT: = true
// EXPECT: = 3
// EXPECT: "/a\\/b/m"
// EXPECT: = "evil.example"
// EXPECT: = console.log
// EXPECT: if (n > 10)
// EXPECT: `https://${host}.example`
// GONE: with (
// GONE: M.length
// GONE: void 0
// EXPECT: } else if (port > 8000) {
