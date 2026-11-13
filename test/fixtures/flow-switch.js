// E163: küçük çok yollu dallanma → if zinciri; E164: literal döndüren büyük dallanma → Map tablosu
function kind(code) {
  var label;
  switch (code) {
    case 1:
    case 2:
      label = "düşük";
      break;
    case 3:
      label = "orta";
      break;
    default:
      label = "yüksek";
  }
  return label;
}
function color(name) {
  switch (name) {
    case "red": return "#f00";
    case "green": return "#0f0";
    case "blue": return "#00f";
    case "black": return "#000";
    default: return "?";
  }
}
// üye üzerinden çağrı: const-fold programı baştan sona katlamasın
var api = { kind: kind, color: color };
console.log(api.kind(2), api.kind(3), api.kind(9), api.color("blue"), api.color("x"), api.color("1"));
api.kind = null;
// EXPECT: if (code === 1 || code === 2) {
// EXPECT: new Map([
// EXPECT: ["black", "#000"],
// EXPECT: .get(name) ?? "?"
// GONE: switch
