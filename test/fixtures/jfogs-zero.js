(function ($fog$0, $fog$1, $fog$2, $fog$3, $fog$4, $fog$20, $fog$8, $fog$9, $fog$10, $fog$17, $fog$18, $fog$16, $fog$11, $fog$13, $fog$14, $fog$15, $fog$19) {
  
if ("‮" !== $fog$20) {
  return;
}

var $fog$5 = arguments;
for (var $fog$6 = $fog$13; $fog$6 < $fog$8; $fog$6++) {
  if (typeof $fog$5[$fog$6] !== $fog$9) {
    continue;
  }
  $fog$5[$fog$6] = $fog$5[$fog$6][$fog$10]($fog$17,
    function (a) {
      return {
        '\u200c': $fog$13,
        '\u200d': $fog$14
      }[a];
    }
  )[$fog$10]($fog$18, function (a) {
    return $fog$16[$fog$11]($fog$19(a, $fog$15));
  });
}
    
  function hi(name) { return $fog$0 + name; }
var total = $fog$1 * $fog$2;
console[$fog$3](hi($fog$4), total);

})("‍‌‌‍‌‌‌‍‍‌‍‌‌‍‌‍‌‍‍‌‌‌‍‌‌‌‌‌", 6, 7, "‍‍‌‍‍‌‌‍‍‌‍‍‍‍‍‍‌‌‍‍‍", "‍‌‍‌‌‌‌‍‌‌‌‍‌‍‍‌‌‌‍‌‍‍‌‌‍‍‌‌", "‮", 5, "string", "replace", /./g, /.{7}/g, String, "fromCharCode", 0, 1, 2, parseInt);
// EXPECT: return "Hi, " + name;
// EXPECT: console.log(hi("PEEL")
// GONE: $fog$
// GONE: fromCharCode
