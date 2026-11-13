// İki dal aynı duruma döner: devamı ("end") iki dala kopyalanmamalı, if/else'ten sonra bir kez yazılmalı
function f(x) {
  var P = 1, Q = 0;
  while (P + Q !== 0) {
    switch (P + Q) {
      case 1: console.log("a"); if (x) { P = 2; } else { P = 3; } break;
      case 2: console.log("yes"); P = 4; break;
      case 3: console.log("no"); P = 4; break;
      case 4: console.log("end"); P = 0; break;
    }
  }
}
f(true);
f(false);
// LEVEL: 3
// EXPECT: } else {
// EXPECT: console.log("no");
// EXPECT: }
// EXPECT:   console.log("end");
// GONE: switch
