var _0xg = window;
var _0xp = function (k) {
  switch (k) {
    case "0": return _0xg.document;
    case "1": return _0xg.navigator;
    case "2": return _0xg.location;
    case "3": return _0xg.console;
    case "4": return _0xg.document.title;
  }
};
_0xp("3").log(_0xp("2").href);
_0xp("0").title = "x";
// LEVEL: 3
// EXPECT: console.log(location.href);
// EXPECT: document.title = "x";
// GONE: _0xp
// GONE: _0xg
