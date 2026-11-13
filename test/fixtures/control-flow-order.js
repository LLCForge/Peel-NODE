// E152: sayı dizili dispatcher; E154: sırası hesaplanan dispatcher (bağlamda gözlenip düzleştirilir)
function numeric(x) {
  var order = [2, 0, 1], i = 0;
  while (true) {
    switch (order[i++]) {
      case 0: x = x * 2; continue;
      case 1: return x + 1;
      case 2: x = x - 3; continue;
    }
    break;
  }
}
function computed(s) {
  var seq = "2|0|1".split("|").reverse(), j = 0;
  while (!![]) {
    switch (seq[j++]) {
      case "0": s += "b"; continue;
      case "1": s += "a"; continue;
      case "2": return s + "c";
    }
    break;
  }
}
// tür uyuşmazlığı: string sıra sayısal case'lerle eşleşmez, döngü hemen biter
function mismatch(v) {
  var o = "1|0".split("|"), k = 0;
  while (true) {
    switch (o[k++]) {
      case 0: v = "zero"; continue;
      case 1: v = "one"; continue;
    }
    break;
  }
  return v;
}
// üye üzerinden çağrı: const-fold programı baştan sona katlamasın
var api = { numeric: numeric, computed: computed, mismatch: mismatch };
console.log(api.numeric(10), api.computed(">"), api.mismatch("same"));
api.numeric = null;
// EXPECT: x = x - 3;
// EXPECT: x = x * 2;
// EXPECT: return x + 1;
// EXPECT: s += "a";
// EXPECT: s += "b";
// EXPECT: return s + "c";
// GONE: order[
// GONE: seq[
