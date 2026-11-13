// prototype → class: yalnızca new ile kullanılan, metotları yalnızca çağrılan kurucu fonksiyon
(function () {
  function Stack(limit) { this.items = []; this.limit = limit; }
  Stack.prototype.push = function (x) { if (this.items.length < this.limit) this.items.push(x); return this; };
  Stack.prototype.size = function () { return this.items.length; };
  var s = new Stack(2);
  s.push(1).push(2).push(3);
  console.log(s.size(), s instanceof Stack);
})();
// EXPECT: class Stack {
// EXPECT: constructor(limit) {
// EXPECT: size() {
// GONE: Stack.prototype
