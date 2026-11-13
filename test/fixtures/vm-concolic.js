// Madde 27/36/E195: with içindeki makine düz koda çevrilemez; tek çalıştırma yalnızca n > 2 yolunu görür.
// Dal zorlamalı ek çalıştırma diğer yolu bulur; 99 numaralı case hiçbir çalıştırmada görülmez.
function machine(U, n) {
  var P = 0, Q = 1;
  while (P + Q !== 0) {
    with (U) {
      switch (P + Q) {
        case 1: if (n > 2) { P = 4; } else { P = 9; } break;
        case 5: log("big"); P = 0; Q = 0; break;
        case 10: log("small"); P = 0; Q = 0; break;
        case 99: log("never"); P = 0; Q = 0; break;
        default: P = 0; Q = 0;
      }
    }
  }
}
machine({ log: function (m) { console.log(m); } }, 5);
// LEVEL: 3
// EXPECT: 1 -> 5
// EXPECT: zorlanmış dallarla bulunan ek geçişler
// EXPECT: 1 -> 10
// EXPECT: ulaşılmayan case'ler (gözlenmedi): 99
