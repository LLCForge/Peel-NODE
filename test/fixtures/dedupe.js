// aynı gövdeli iki fonksiyon: ikincisinin çağrıları birinciye yönlenir, kopya silinir
function sumA(arr) { var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i]; return s; }
function sumB(list) { var t = 0; for (var j = 0; j < list.length; j++) t += list[j]; return t; }
console.log(sumA([1, 2]), sumB([3, 4]));
// EXPECT: sumA([3, 4])
// GONE: sumB
