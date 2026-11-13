(function () {
  var a = Function.prototype.toString;
  if (a.call(a).indexOf("native") === -1) {
    while (true) {}
  }
})();
console.log("alive");
// EXPECT: console.log("alive");
// GONE: toString
