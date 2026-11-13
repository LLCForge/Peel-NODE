function machine(U) {
  var P = 1, Q = 2;
  while (P + Q !== 0) {
    with (U) {
      switch (P + Q) {
        case 3: log("x"); P = 4; break;
        case 6: log("y"); P = 0; Q = 0; break;
        default: P = 0; Q = 0;
      }
    }
  }
}
machine({ log: function (m) { console.log(m); } });
// LEVEL: 3
// EXPECT: __peelS = P + Q;
// EXPECT: PEEL VM
// EXPECT: 3 -> 6
