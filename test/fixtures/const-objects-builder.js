// obfuscator.io transformObjectKeys: boş nesne + ardışık atamalar + takma ad
function greet(name) {
  var a = {};
  a.plus = function (x, y) { return x + y; };
  a.hi = "Hello, ";
  var b = a;
  return b.plus(b.plus(b.hi, name), "!");
}
console.log(greet("PEEL"));
// EXPECT: return "Hello, " + name + "!";
