// E166: break/continue normalleştirme (etkisiz atlamalar, gereksiz etiketler); E170: guard cümlesi üretimi
function scan(list) {
  var out = [];
  outer: for (var i = 0; i < list.length; i++) {
    if (list[i] < 0) continue outer;
    inner: while (true) {
      out.push(list[i]);
      break inner;
    }
    continue;
  }
  return out;
}
function report(user) {
  if (user) {
    var name = user.name;
    console.log("kullanıcı", name);
  }
}
function evens(list) {
  var r = [];
  for (var j = 0; j < list.length; j++) {
    if (list[j] % 2 === 0) {
      r.push(list[j]);
      r.push("!");
    }
  }
  return r;
}
// üye üzerinden çağrı: const-fold programı baştan sona katlamasın
var api = { scan: scan, report: report, evens: evens };
console.log(api.scan([1, -2, 3]).join(), api.evens([1, 2, 4]).join());
api.report({ name: "ada" });
api.report(null);
api.scan = null;
// EXPECT: if (list[i] < 0) continue;
// EXPECT: if (!user) return;
// EXPECT: if (list[j] % 2 !== 0) continue;
// GONE: outer:
// GONE: inner:
