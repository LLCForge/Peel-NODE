// js-confuser global gizleme benzeri: kodlanmış adla global nesneyi döndüren fonksiyon
function g(k) { return globalThis[atob(k)]; }
g("Y29uc29sZQ==").log(g("TWF0aA==").max(2, 7));
// LEVEL: 3
// EXPECT: console.log(7);
// GONE: atob
