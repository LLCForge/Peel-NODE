// A-23: sabit nesneli with bloğu açık özellik erişimine çevrilir
var outside = "dış";
function show() {
  var cfg = { greeting: "merhaba", count: 2, label: function () { return this.greeting + "!"; } };
  var out = [];
  with (cfg) {
    count = count + 1;
    out.push(greeting, count, label(), outside, typeof toString);
  }
  return out.join(" ") + " " + cfg.count;
}
console.log(show());
// EXPECT: cfg.count = cfg.count + 1;
// EXPECT: cfg.label(), outside, typeof cfg.toString
// GONE: with (
