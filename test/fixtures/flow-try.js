// E161: hata fırlatarak akış gizleme açılır; E217: kullanılmayan yakalama parametresi ve boş blok sadeleşir
function hidden(v) {
  var out = [];
  try {
    var marker = 1;
    throw "atla";
  } catch (sig) {
    out.push("yakalandı:" + sig, marker + v);
  }
  try {
    var safe = 2;
  } catch (never) {
    out.push("asla");
  }
  try {
    out.push(JSON.parse("{bad"));
  } catch (ignored) {}
  try {} catch (x) { out.push("boş try"); }
  return out.concat([safe]).join(",");
}
// üye üzerinden çağrı: const-fold programı baştan sona katlamasın
var api = { hidden: hidden };
console.log(api.hidden(3));
api.hidden = null;
// EXPECT: let sig = "atla";
// EXPECT: } catch {}
// EXPECT: safe = 2;
// GONE: throw "atla"
// GONE: asla
// GONE: boş try
