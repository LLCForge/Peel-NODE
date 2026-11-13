function classify(n) {
  var k = n & 7;
  if ((k * (k + 1)) % 2 === 1) { console.log("opaque-dead-1"); }
  var m = n | 0;
  if (((m | 1) & 1) !== 1) { console.log("opaque-dead-2"); }
  var z = (k * k) % 4;
  if (z === 2 || z === 3) { console.log("opaque-dead-3"); }
  return k > 3 ? "hi" : "lo";
}
var inputs = [3, 12, -5, 1000];
for (var i = 0; i < inputs.length; i++) console.log(classify(inputs[i]));
// LEVEL: 2
// GONE: opaque-dead-1
// GONE: opaque-dead-2
// GONE: opaque-dead-3
// EXPECT: "hi"
