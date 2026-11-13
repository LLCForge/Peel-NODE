Function("a", "b", "console.log(a + b)")(1, 2);
// EXPECT: (function (a, b) {
// EXPECT: console.log(a + b);
// GONE: Function(
