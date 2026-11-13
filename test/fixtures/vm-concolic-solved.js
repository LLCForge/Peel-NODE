// Madde 27: gizli durum (7) yalnızca navigator.language === "tr-TR" iken ulaşılır. Temel çalıştırma en-US ile
// 2'ye gider; çözücü yol koşulunu olumsuzlayıp girdiyi bulur, o girdiyle çalıştırma 1 -> 7 geçişini doğrular.
// lang.length > 40 dalı her yol önekinde olanaksızdır (dil en fazla 64 karakter modellenir ama 40'tan uzunsa
// önce 3. case'e gidilir): çözücü bunu kanıtlı olanaksız olarak raporlar.
var lang = navigator.language;
var trace = "";
var U = { mark: 1 };
var P = 0, Q = 1, steps = 0;
while (P + Q !== 0 && steps < 30) {
  steps = steps + 1;
  with (U) {
    switch (P + Q) {
      case 1: if (lang === "tr-TR") { P = 6; } else { P = 1; } break;
      case 2: trace = trace + "b"; if (lang.length > 40 && lang.length < 10) { P = 20; } else { P = 0; Q = 0; } break;
      case 7: trace = trace + "gizli"; P = 0; Q = 0; break;
      case 21: trace = trace + "imkansiz"; P = 0; Q = 0; break;
      default: P = 0; Q = 0;
    }
  }
}
console.log(trace + mark);
// LEVEL: 3
// EXPECT: çözücüyle bulunan girdilerle ek geçişler (doğrulandı)
// EXPECT: 1 -> 7 [çözülmüş girdi: navigator.language="tr-TR"]
// EXPECT: = true: olanaksız
