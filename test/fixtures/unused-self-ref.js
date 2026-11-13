// yalnızca kendi içinden okunan, tek kez atanmış fonksiyon değişkeni ölüdür (açılmış getter'ın decoder makinesi)
(function () {
  var rec, n = Number("3");
  rec = function (k) { return k > 0 ? rec(k - 1) + "!" : "self"; };
  console.log("kept", n);
})();
// EXPECT: "kept"
// GONE: rec
