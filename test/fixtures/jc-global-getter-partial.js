// global getter'ın yalnızca global nesneye çözülen çağrıları değiştirilir; diğerleri yerinde kalır
(function () {
  let G;
  G = function (...a) {
    let n;
    [n] = a;
    switch (n) {
      case "c0n": return console;
      case "s": return "plain-" + n;
    }
    return;
  };
  G("c0n").log("partial-getter", G("s"));
})();
// EXPECT: console.log("partial-getter"
