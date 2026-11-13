// Madde 45: iki ayrı fonksiyon tek bir makinede birleştirilmiş; başlangıç durumu parametreyle seçiliyor
function dispatch(s, a) {
  var P = s;
  while (P !== -1) {
    switch (P) {
      case 1: console.log("A", a); P = 2; break;
      case 2: console.log("B"); P = -1; break;
      case 10: console.log("C", a * 2); P = 11; break;
      case 11: console.log("D"); P = -1; break;
    }
  }
}
dispatch(1, 3);
dispatch(10, 4);
dispatch(1, 5);
// LEVEL: 3
// EXPECT: function dispatch_1(
// EXPECT: function dispatch_10(
// GONE: switch (
// GONE: function dispatch(
