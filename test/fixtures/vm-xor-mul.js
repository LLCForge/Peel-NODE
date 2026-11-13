// E180 / madde 29: XOR ve çarpımla kurulan durum ifadesi tek durum değişkenine indirilip açılır
function m() {
  var A = 3, B = 5, C = 1;
  while ((A ^ B) !== 0) {
    switch ((A ^ B) * 2 - C + 1) {
      case 12: console.log("x"); A = 12; break;
      case 18: console.log("y"); B = 12; break;
      case 40: console.log("z"); break;
    }
  }
}
m();
// LEVEL: 3
// EXPECT: console.log("x");
// EXPECT: console.log("y");
// GONE: switch (
// GONE: A ^ B
