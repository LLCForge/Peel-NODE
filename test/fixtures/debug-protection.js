(function () {
  setInterval(function () { debugger; }, 4000);
})();
debugger;
console.log("ok");
// EXPECT: console.log("ok");
// GONE: debugger
// GONE: setInterval
