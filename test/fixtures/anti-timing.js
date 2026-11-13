// Madde 44: zamanlama tabanlı anti-debug kontrolleri
var t0 = Date.now();
function work() { var s = 0; for (var i = 0; i < 10; i++) s += i; return s; }
var r = work();
if (Date.now() - t0 > 100) { debugger; while (true) {} }
console.log(r);
var p0 = performance.now();
console.log("b");
if (performance.now() - p0 > 50) { location.reload(); } else { console.log("fast"); }
// LEVEL: 3
// EXPECT: console.log("fast");
// GONE: Date.now() - t0
// GONE: location.reload
// GONE: while (true)
