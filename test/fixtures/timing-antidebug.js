// E203: zamanlama tabanlı anti-debug (debugger etrafında geçen süre ölçümü) kaldırılır
function guarded(v) {
  var started = Date.now();
  debugger;
  if (Date.now() - started > 100) {
    while (true) {}
  }
  var t1 = performance.now();
  if (200 < performance.now() - t1) {
    return "yavaş";
  } else {
    console.log("normal", v);
  }
  return v * 2;
}
// üye üzerinden çağrı: const-fold programı baştan sona katlamasın
var api = { guarded: guarded };
console.log(api.guarded(21));
api.guarded = null;
// EXPECT: console.log("normal", v);
// GONE: Date.now
// GONE: performance.now
// GONE: yavaş
