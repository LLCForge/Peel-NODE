(() => {
  var __webpack_modules__ = {
    "./src/a.js"(module, exports, __webpack_require__) {
      "use strict";
      eval("{function twice(n) { return n * 2; }\nmodule.exports = { twice };\n//# sourceURL=webpack://demo/./src/a.js?\n}");
    },
  };
  var cache = {};
  function __webpack_require__(id) {
    if (cache[id]) return cache[id].exports;
    var m = (cache[id] = { exports: {} });
    __webpack_modules__[id](m, m.exports, __webpack_require__);
    return m.exports;
  }
  console.log(__webpack_require__("./src/a.js").twice(21));
})();
// EXPECT: function twice(n) {
// EXPECT: module.exports = {
// GONE: eval(
