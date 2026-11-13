// E158 do/while, E159 for(;;), E160 etiketli makine; E156 çoklu yol (iç dallanma), E157 koşulun durum aritmetiğinden kurtarılması
function doWhileMachine(out) {
  var s = 1;
  do {
    switch (s) {
      case 1: out.push("d1"); s = 3; break;
      case 3: out.push("d3"); s = 0; break;
    }
  } while (s !== 0);
  return out;
}
function forMachine(out) {
  for (var q = 5; q !== 9; q += 2) {
    switch (q) {
      case 5: out.push("f5"); break;
      case 7: out.push("f7"); break;
    }
  }
  return out;
}
function labeledMachine(out) {
  var w = 0;
  run: while (true) {
    switch (w) {
      case 0: out.push("l0"); w = 4; continue run;
      case 4: out.push("l4"); break run;
    }
  }
  return out;
}
function conditionMachine(out, flag, n) {
  var k = 0;
  while (k !== 99) {
    switch (k) {
      case 0: k = flag ? 10 : 20; break;
      case 10: out.push("yes"); k = 30; break;
      case 20: out.push("no"); k = 30; break;
      case 30: k += (n > 2) * 5 + 40; break;
      case 70: out.push("small"); k = 99; break;
      case 75: out.push("big"); k = 99; break;
    }
  }
  return out;
}
function innerSwitchMachine(out, mode) {
  var z = 0;
  while (z !== -1) {
    switch (z) {
      case 0:
        switch (mode) {
          case "a": z = 1; break;
          case "b": z = 2; break;
          default: z = 3;
        }
        break;
      case 1: out.push("A"); z = -1; break;
      case 2: out.push("B"); z = -1; break;
      case 3: out.push("other"); z = -1; break;
    }
  }
  return out;
}
// üye üzerinden çağrı: const-fold programı baştan sona katlamasın
var api = { d: doWhileMachine, f: forMachine, l: labeledMachine, c: conditionMachine, i: innerSwitchMachine };
console.log(api.d([]).join(), api.f([]).join(), api.l([]).join());
console.log(api.c([], 1, 5).join(), api.c([], 0, 1).join(), api.i([], "a").join(), api.i([], "b").join(), api.i([], "zz").join());
api.d = null;
// EXPECT: out.push("d1");
// EXPECT: out.push("f7");
// EXPECT: out.push("l4");
// EXPECT: if (flag) {
// EXPECT: if (n > 2) {
// EXPECT: if (mode === "a") {
// GONE: switch
// GONE: do {
// GONE: run:
