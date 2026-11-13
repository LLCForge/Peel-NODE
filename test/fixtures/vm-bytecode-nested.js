// VM içinde VM: dış yığın VM'inin bytecode'u, kendi bytecode'unu (K[1]) çalıştıran ikinci bir yorumlayıcı.
// Dış VM düz koda çevrilince iç yorumlayıcı döngüsü ortaya çıkar; bir sonraki turda o da çevrilir (E654/E655).
function run(code, K, G) {
  var pc = 0, S = [], R = [];
  while (pc < code.length) {
    var op = code[pc++];
    switch (op) {
      case 0: S.push(K[code[pc++]]); break;
      case 1: S.push(R[code[pc++]]); break;
      case 2: R[code[pc++]] = S.pop(); break;
      case 3: var b = S.pop(); var a = S.pop(); S.push(a + b); break;
      case 4: b = S.pop(); a = S.pop(); S.push(a < b); break;
      case 5: b = S.pop(); a = S.pop(); S.push(a === b); break;
      case 6: pc = code[pc]; break;
      case 7: var t = code[pc++]; if (!S.pop()) pc = t; break;
      case 8: b = S.pop(); a = S.pop(); S.push(a[b]); break;
      case 9: var k = S.pop(); var o = S.pop(); S.push(o); S.push(o[k]); break;
      case 10: var n = code[pc++]; var args = S.splice(S.length - n, n); var f = S.pop(); var self = S.pop(); S.push(f.apply(self, args)); break;
      case 11: S.pop(); break;
      case 12: return S.pop();
      case 13: S.push(G); break;
      case 14: b = S.pop(); a = S.pop(); S.push(a * b); break;
    }
  }
}
run([0,1,2,3,0,4,2,1,0,0,2,0,1,0,1,3,0,2,8,4,7,171,1,3,1,0,8,2,2,1,0,0,3,3,2,0,1,2,0,3,5,7,65,1,1,0,8,9,1,3,1,0,8,10,1,11,1,0,0,3,3,2,0,6,12,1,2,0,5,5,7,105,1,1,0,9,9,10,0,2,4,1,1,0,9,9,10,0,2,5,1,1,0,8,9,1,5,1,4,3,10,1,11,6,12,1,2,0,6,5,7,145,1,1,0,9,9,10,0,2,4,1,1,0,9,9,10,0,2,5,1,1,0,8,9,1,5,1,4,14,10,1,11,6,12,1,2,0,7,5,7,12,13,0,10,8,0,11,9,1,1,0,9,9,10,0,10,1,11,6,12,0,0,12],
  [0, [1, 5, 1, 7, 2, 1, 3, 4, 3], "length", 1, [], 2, 4, 3, "push", "pop", "console", "log"], globalThis);
// LEVEL: 3
// EXPECT: derinlik=2
// EXPECT: .log(36)
// GONE: switch (
