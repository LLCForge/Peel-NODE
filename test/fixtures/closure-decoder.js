(function (a) {
  var M, N;
  function U() { return globalThis; }
  N = U();
  (function () {
    var tbl = ["bG9n", "Y29uc29sZQ==", "aGVsbG8=", "d29ybGQ="];
    M = function (i) { return atob(tbl[i]); };
  })();
  function V(...O) {
    O.length = 1;
    switch (O[0]) {
      case M(1): return N.console;
      case "x": return N.document;
      case "y": return N.Math;
    }
  }
  function show(N) {
    var k = 2;
    V(M(1))[M(0)](M(k) + " " + M(3));
  }
  show(5);
})();
// LEVEL: 3
// EXPECT: console.log("hello world");
// GONE: V(
// GONE: M(
