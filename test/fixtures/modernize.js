// ES5 → modern: let/const, ok fonksiyonu, şablon string, kısa özellik, nesne ayrıştırma, değişken birleştirme
function report(list) {
  var total = 0;
  var label = "toplam";
  var unit;
  unit = "adet";
  var doubled = Array.from(list).map(function (x) { return x * 2; });
  for (var i = 0; i < doubled.length; i++) { total += doubled[i]; }
  var config = { min: list.length, max: list[0] * 9 };
  var min = config.min, max = config.max;
  var count = doubled.length;
  var alias = count;
  console.log("Rapor " + label + " (" + (min + max) + ")", total, unit, { min: min, max: max }, alias);
}
report([1, 2, 3]);
// EXPECT: const doubled = Array.from(list).map((x) => x * 2);
// EXPECT: let total = 0;
// EXPECT: for (let i = 0;
// EXPECT: const { min, max } = config;
// EXPECT: { min, max }
// EXPECT: "adet",
// EXPECT: `Rapor toplam (${min + max})`
// GONE: alias
// GONE: var
