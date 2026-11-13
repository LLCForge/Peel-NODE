function run() {
  var _0xorder = "2|0|3|1".split("|"), _0xi = 0;
  while (!![]) {
    switch (_0xorder[_0xi++]) {
      case "0": console.log("a"); continue;
      case "1": console.log("d"); continue;
      case "2": console.log("b"); continue;
      case "3": console.log("c"); continue;
    }
    break;
  }
}
run();
// LEVEL: 3
// EXPECT: console.log("b");
// EXPECT: console.log("d");
// GONE: switch
// GONE: _0xorder
