// Madde 28: for(;;) + etiketli makine döngüsü, case içinde let ve makineyi hedefleyen etiketli break/continue
function f() {
  var P = 0, out = [];
  M: for (;;) {
    switch (P) {
      case 0: let x = 5; out.push(x); P = 2; break;
      case 2: if (out.length > 3) break M; out.push(out.length); P = 0; continue M;
    }
  }
  return out.join(",");
}
console.log(f());
// LEVEL: 3
// EXPECT: out.push(5);
// EXPECT: while (true)
// GONE: switch (
// GONE: M:
