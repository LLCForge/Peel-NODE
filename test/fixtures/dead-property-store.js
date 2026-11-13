// açılmış makinelerin ölü sarmalayıcıları: kapsam nesnesine atanan ama hiç okunmayan fonksiyonlar
function main(scope = { a: {} }) {
  scope.a.deadWrap = function () { return 1; };
  scope.a.live = function () { return "live"; };
  scope.a.onready = function () { return "event"; };
  scope.a.toString = function () { return "S"; };
  globalThis.exported = function () { return 2; };
  console.log((1, scope.a.live)(), String(scope.a));
}
main();
// EXPECT: scope.a.live = function
// EXPECT: scope.a.onready = function
// EXPECT: scope.a.toString = function
// EXPECT: globalThis.exported = function
// GONE: deadWrap
