// anlam koruyan sadeleştirmeler: her satırın çıktısı orijinalle aynı olmalı
function main(a, b, flag) {
  var out = [];
  var x = (a | b) | 0;
  var y = ~~(a & b);
  var z = (a - b) * 1;
  if (!!flag) out.push("bang");
  if (!(!a || !b)) out.push("demorgan");
  out.push(flag ? flag : "fallback", a ? "same" : "same");
  flag && out.push("and");
  flag || out.push("or");
  flag ? out.push("t") : out.push("f");
  if (a) { if (b) { out.push("nested"); } }
  if (flag) {} else { out.push("emptyThen"); }
  do { out.push("once"); } while (false);
  while (true) { out.push("loop-once"); break; }
  out.push(/ab+c/i.source, /^\d+$/.test("123"));
  out.push(arguments[0] + arguments[1]);
  out.push(ident(7), seven(1, 2));
  out.push(Math.max.call(Math, 1, 9), pick.call(undefined, "c"));
  return [x, y, z].concat(out).join(",");
}
function check(v) { if (v > 1) { return "big"; } else { var r = "small"; return r; } }
function ident(v) { return v; }
function seven() { return 7; }
function pick(v) { return v; }
// üye üzerinden çağrı: const-fold programı baştan sona katlamasın
var api = { main: main, check: check };
console.log(api.main(6, 3, 0), api.check(5), api.check(0));
api.main = null;
// EXPECT: x = a | b;
// EXPECT: y = a & b;
// EXPECT: z = a - b;
// EXPECT: if (flag) out.push("bang");
// EXPECT: if (a && b) out.push("demorgan");
// EXPECT: flag || "fallback", "same"
// EXPECT: if (flag) out.push("and");
// EXPECT: if (!flag) out.push("or");
// EXPECT: if (!flag) {
// EXPECT: out.push("once");
// EXPECT: out.push("loop-once");
// EXPECT: "ab+c", true
// EXPECT: out.push(a + b);
// EXPECT: out.push(9, "c");
// GONE: arguments
// GONE: do {
