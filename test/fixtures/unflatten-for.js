// for döngüsünün düzleştirilmiş hali: koşul gövdeden önce kontrol ediliyor → while (C) { … } olmalı
function total(list) {
  var s = 0, i;
  var P = 1, Q = 0;
  while (P + Q !== 99) {
    switch (P + Q) {
      case 1: i = 0; P = 2; break;
      case 2: if (i < list.length) { P = 3; } else { P = 5; } break;
      case 3: s += list[i]; P = 4; break;
      case 4: i++; P = 2; break;
      case 5: console.log("sum", s); P = 99; break;
    }
  }
  return s;
}
console.log(total([1, 2, 3, 4]), total([]));
// LEVEL: 3
// EXPECT: while (i < list.length) {
// EXPECT: s += list[i];
// EXPECT: console.log("sum", s);
// GONE: switch
// GONE: while (true)
