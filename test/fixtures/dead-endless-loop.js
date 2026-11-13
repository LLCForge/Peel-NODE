// break'siz while (true) sonrası erişilemez; sonucu kullanılmayan literal tablo deyimi etkisiz
function lock(t) {
  if (t < 0) {
    while (true) {
      if (t > 5) { while (true) {} }
      for (;;) { break; }
    }
    console.log("never-reached");
  }
  return t;
}
[1, "table-literal", null, undefined, -2, { k: [true] }];
Object.create(null);
console.log(lock(Math.abs(3)));
// EXPECT: console.log(
// GONE: never-reached
// GONE: table-literal
// GONE: create(null)
