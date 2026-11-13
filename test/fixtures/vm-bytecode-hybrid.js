// E653: hibrit VM + host kodu — bytecode, programın kendi fonksiyonunu (helper) ve console'u çağırıyor
function helper(x) { return "<" + x + ">"; }
function vm(code, K, G) {
  var pc = 0, S = [];
  for (;;) {
    var op = code[pc++];
    if (op === 1) S.push(K[code[pc++]]);
    else if (op === 2) S.push(G[K[code[pc++]]]);
    else if (op === 3) { var a = S.pop(); var f = S.pop(); S.push(f(a)); }
    else if (op === 4) { var v = S.pop(); var c = S.pop(); c.log(v); }
    else if (op === 5) return;
  }
}
vm([2, 2, 2, 0, 1, 1, 3, 4, 5], ["helper", "kanca", "console"], { helper: helper, console: console });
// LEVEL: 3
// EXPECT: PEEL VM-LIFT
// EXPECT: log("<kanca>")
// GONE: S.pop()
