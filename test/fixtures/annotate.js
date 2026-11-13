// fonksiyon özetleri (73), JSDoc tipleri (76) ve bölüm başlıkları (E238)
var BASE = "https://api.example.com";
var RETRIES = 3;
function buildUrl(path) { return BASE + path; }
function count(items) { var n = 0; for (var i = 0; i < items.length; i++) n++; return n; }
function isEven(n) { return n % 2 === 0; }
function show(text) { document.title = text; }
console.log(buildUrl("/x"), count([1, 2]), isEven(4), RETRIES);
show("ok");
// EXPECT: @summary
// EXPECT: @param {string} path
// EXPECT: @returns {boolean}
// EXPECT: // ── Sayfa (DOM) işlemleri ──
// EXPECT: // ── Ana akış ──
