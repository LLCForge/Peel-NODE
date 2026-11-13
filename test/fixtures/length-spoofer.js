function S(fn, n) { Object.defineProperty(fn, "length", { value: n }); return fn; }
var add = S(function (a, b) { return a + b; }, 2);
console.log(add(1, 2));
// LEVEL: 3
// EXPECT: var add = function (a, b) {
// GONE: defineProperty
