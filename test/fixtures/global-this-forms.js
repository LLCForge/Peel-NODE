// E104 / E105: global nesneye ulaşan dolaylı biçimler globalThis'e birleştirilir
var g1 = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : Function("return this")();
var g2 = new Function("return this")();
var g3 = Function("return (function() {}.constructor(\"return this\")( ));")();
var g4 = (0, eval)("this");
var g5 = (function () { return this; })();
var g6 = (function () { "use strict"; return this; })();
var g7 = globalThis.globalThis;
console.log(g1 === g2, g2 === g3, g3 === g4, g4 === g5, typeof g6, g7 === g1);
// EXPECT: g1 = globalThis;
// EXPECT: g2 = globalThis;
// EXPECT: g3 = globalThis;
// EXPECT: g4 = globalThis;
// EXPECT: g5 = globalThis;
// EXPECT: g6 = undefined;
// EXPECT: g7 = globalThis;
// GONE: return this
// GONE: typeof window
