// E184: durum bir nesnenin özelliğinde (s.a); yazmalar sandbox'ta Proxy ile gözlenir
function m(o) {
  var s = { a: 0 };
  while (s.a !== -1) {
    switch (s.a) {
      case 0: o.push("x"); s.a = 3; break;
      case 3: o.push("y"); s.a = 7; break;
      case 7: o.push("z"); s.a = -1; break;
    }
  }
  return o.join("");
}
console.log(m([]));
// LEVEL: 3
// EXPECT: Proxy ile gözlenen durum yazmaları: a=3, a=7, a=-1
// EXPECT: 0 -> 3
