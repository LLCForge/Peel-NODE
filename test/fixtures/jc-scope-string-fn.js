// kapsam nesnesindeki string→string fonksiyon (az çağrılı, kaynağı decoder'a benzemiyor, sayısal argümansız)
// decoder sayılmaz: çağrısını değerle değiştirmek yan etkisini (sayaç) silerdi
var S = { K: {} };
S.K.n = 0;
S.K.f = function (s) { S.K.n++; return "<" + s + ">"; };
var r = (1, S.K.f)("scoped");
console.log(r, S.K.n);
// EXPECT: console.log(
// EXPECT: "scoped"
