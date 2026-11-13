function h(a) {
  var o = { x: 1, y: 2 };
  o.x = o.x + (a | 0);
  o.y = o.x * 2;
  return o.x + o.y;
}
var vs = [1, 5, -3];
for (var i = 0; i < vs.length; i++) console.log(h(vs[i]));
// LEVEL: 3
// GONE: o.x
// GONE: o.y
