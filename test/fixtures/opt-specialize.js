function op(kind, a, b) {
  var r;
  if (kind === "add") { r = a + b; }
  else if (kind === "mul") { r = a * b; }
  else { r = 0; for (var i = 0; i < 3; i++) r = r + a; }
  return r;
}
function machine(state, tag) {
  var out = [];
  for (var k = 0; k < 4; k++) {
    switch (state) {
      case 0: out.push("a" + tag); state = 2; break;
      case 2: out.push("b"); state = 3; break;
      case 3: out.push("c"); state = 0; break;
    }
  }
  return out.join("-");
}
var vals = [2, 3, 4];
for (var i = 0; i < vals.length; i++) {
  console.log(op("add", vals[i], 1), op("mul", vals[i], 2), machine(0, vals[i]));
}
// LEVEL: 4
// EXPECT: _op_s
// EXPECT: _machine_s
