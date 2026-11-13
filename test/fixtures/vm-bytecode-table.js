// Register tabanlı VM, handler tablosu ile dağıtım (ops[prog[ip++]]()), durma bayrağı ile çıkış
var VM = (function () {
  function exec(prog, consts) {
    var regs = [0, 0, 0, 0], ip = 0, halted = false;
    var ops = [
      function () { regs[prog[ip++]] = consts[prog[ip++]]; },
      function () { var d = prog[ip++]; regs[d] = regs[prog[ip++]] + regs[prog[ip++]]; },
      function () { var d = prog[ip++]; regs[d] = regs[prog[ip++]] * regs[prog[ip++]]; },
      function () { console.log(regs[prog[ip++]]); },
      function () { halted = true; },
      function () { var r = prog[ip++]; var t = prog[ip++]; if (regs[r] !== 0) ip = t; },
      function () { var d = prog[ip++]; regs[d] = regs[d] - 1; }
    ];
    while (!halted) ops[prog[ip++]]();
    return regs[0];
  }
  return exec;
})();
console.log(VM([0, 0, 0, 0, 1, 1, 0, 2, 2, 2, 0, 0, 1, 6, 2, 5, 2, 9, 3, 0, 4], [1, 3, 4]));
// LEVEL: 3
// EXPECT: PEEL VM-LIFT
// EXPECT: _r0 = _r0 * 3;
// EXPECT: console.log(_r0);
// GONE: var ops
