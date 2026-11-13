// açıklamalar çıktıyı gereksiz büyütmez: gövdeden bilgi çıkmayan fonksiyona kalıp özet yazılmaz, hesaplanan
// değişkenler ana akışı tek deyimlik bölümlere bölmez
var total = 0;
function add(a, b) { return a + b; }
function pick(o) { return o.k; }
function loop(list) { var s = 0; for (var i = 0; i < list.length; i++) s += list[i]; return s; }
var r = add(1, 2);
console.log(r, pick({ k: "kk" }));
var q = loop([r, 2]);
console.log(q);
total = r + q;
console.log(total);
// EXPECT: @summary Döngü içerir
// EXPECT: // ── Ana akış ──
// GONE: Bir değer hesaplar
// GONE: ── Değişkenler
// GONE: @param {*} o
