// E197: başlangıcı çalışma anında gözlenen makine açıldıktan sonra çıkışta yazılan durum hiç okunmuyor
function start() { return 1; }
function run() {
  var P = 1, Q = start() - 1;
  while (P + Q !== 0) {
    switch (P + Q) {
      case 1: console.log("x"); Q = 2; break;
      case 3: console.log("y"); P = 0; Q = 0; break;
    }
  }
  return "ok";
}
console.log(run());
// LEVEL: 3
// EXPECT: console.log("y");
// GONE: P = 0
// GONE: __peelS
// GONE: switch (
