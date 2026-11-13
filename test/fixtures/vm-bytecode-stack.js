// Elle yazılmış yığın tabanlı bytecode VM: toplam = 0..2 için i*2 toplamı, sonra console.log
function run(code, K, G) {
  var pc = 0, S = [], R = [];
  while (pc < code.length) {
    var op = code[pc++];
    switch (op) {
      case 0: S.push(K[code[pc++]]); break;
      case 1: S.push(R[code[pc++]]); break;
      case 2: R[code[pc++]] = S.pop(); break;
      case 3: var b = S.pop(); var a = S.pop(); S.push(a + b); break;
      case 4: b = S.pop(); a = S.pop(); S.push(a * b); break;
      case 5: b = S.pop(); a = S.pop(); S.push(a < b); break;
      case 6: pc = code[pc]; break;
      case 7: var t = code[pc++]; if (!S.pop()) pc = t; break;
      case 8: S.push(G[K[code[pc++]]]); break;
      case 9: var k = S.pop(); var o = S.pop(); S.push(o); S.push(o[k]); break;
      case 10: var n = code[pc++]; var args = S.splice(S.length - n, n); var f = S.pop(); var self = S.pop(); S.push(f.apply(self, args)); break;
      case 11: S.pop(); break;
      case 12: return S.pop();
    }
  }
}
console.log(run([0, 0, 2, 0, 0, 0, 2, 1, 1, 1, 0, 1, 5, 7, 34, 1, 0, 1, 1, 0, 2, 4, 3, 2, 0, 1, 1, 0, 3, 3, 2, 1, 6, 8, 8, 4, 0, 5, 9, 0, 6, 1, 0, 10, 2, 11, 1, 0, 12], [0, 3, 2, 1, "console", "log", "sum"], globalThis));
// LEVEL: 3
// EXPECT: PEEL VM-LIFT
// EXPECT: "sum"
// GONE: switch (
// GONE: function run(
// EXPECT: while (_r1 < 3)
// GONE: S.pop()
