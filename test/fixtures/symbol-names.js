// E118: Symbol tutan üretilmiş adlar açıklamasından isimlendirilir
var _0x1a2b = Symbol("on click");
var _0x3c4d = Symbol.for("app.state");
var store = {};
store[_0x1a2b] = "clicked";
store[_0x3c4d] = 42;
console.log(store[_0x1a2b], store[Symbol.for("app.state")], String(_0x1a2b));
// EXPECT: var symOnClick = Symbol("on click");
// EXPECT: var symAppState = Symbol.for("app.state");
// GONE: _0x
