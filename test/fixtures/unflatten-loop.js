// Makine gerçek bir döngü içeriyor (aynı durum tekrar ediyor): etiketli while olarak geri kurulmalı
function count(n) {
  var P = 0, Q = 1;
  var i = 0;
  while (P + Q !== 0) {
    switch (P + Q) {
      case 1:
        i++;
        if (i >= n) { P = -1; }
        break;
    }
  }
  return i;
}
console.log(count(3), count(1));
// LEVEL: 3
// EXPECT: do {
// EXPECT: } while (!(i >= n));
// GONE: switch
// GONE: P + Q
