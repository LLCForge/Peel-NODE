// variableMasking: negatif ve M.length'ten büyük indeksler yereldir (parametre sayısını etkilemez)
function f(...M) { M.length = 1; M[-7] = M[0] * 2; M[200] = M[-7] + 1; return M[200]; }
function g(...M) { M[-2] = "neg-"; return M[-2] + M[0]; }
console.log(f(Number("20")), g(String(4)));
// EXPECT: console.log(
// GONE: ...M
// GONE: M[
