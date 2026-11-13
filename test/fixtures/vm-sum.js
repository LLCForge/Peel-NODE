function machine() {
  var P = 0, Q = 0;
  while (P + Q !== -1) {
    switch (P + Q) {
      case 0: P += 2; continue;
      case 2: console.log("a"); Q += 2; continue;
      case 4: console.log("b"); P += 3; continue;
      case 7: P += 1; continue;
      case 8: console.log("c"); P += 1; continue;
      case 9: Q += 1; continue;
      case 10: console.log("d"); P = -1; Q = 0; continue;
    }
  }
}
machine();
// LEVEL: 3
// EXPECT: console.log("a");
// EXPECT: console.log("d");
// GONE: switch
// GONE: P +=
// GONE: __peelS
