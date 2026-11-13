var g = Function("return this")();
g.console.log("x");
// EXPECT: console.log("x");
// GONE: Function(
