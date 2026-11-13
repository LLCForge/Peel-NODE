// jfogs 1.0.0-alpha.5 obfuscate(UNICODE, { type: "zero" })
// NEEDLES: "Merhaba dünya, çalışıyor: 漢字" | toUpperCase
(function ($fog$0, $fog$1, $fog$2, $fog$3, $fog$4, $fog$20, $fog$8, $fog$9, $fog$10, $fog$17, $fog$18, $fog$26, $fog$27, $fog$22, $fog$21, $fog$23, $fog$24, $fog$25, $fog$16, $fog$11, $fog$13, $fog$14, $fog$15, $fog$19) {
  
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
  })[$fog$10](
    $fog$26,
    function(c) {
      var cc = (c[$fog$22]($fog$13) & $fog$24) << $fog$21 | (c[$fog$22]($fog$14) & $fog$25);
      return $fog$16[$fog$11](cc);
    }
  )[$fog$10](
    $fog$27,
    function(c) {
      var cc = (c[$fog$22]($fog$13) & $fog$23) << $fog$21 * $fog$15 | (c[$fog$22]($fog$14) & $fog$25) << $fog$21 | (c[$fog$22](2) & $fog$25);
      return $fog$16[$fog$11](cc);
    }
  );
}
    
  var msg = $fog$0;
function shout(s) { return s[$fog$1]() + $fog$2; }
console[$fog$3](shout(msg), msg[$fog$4]);

})("‌‍‌‌‍‍‌‍‌‍‍‌‌‍‌‍‌‍‍‍‌‌‍‌‌‍‍‌‍‌‌‌‌‍‍‌‌‌‌‍‌‍‍‌‌‌‍‌‌‍‍‌‌‌‌‍‌‌‍‌‌‌‌‌‌‍‍‌‌‍‌‌‍‍‌‌‌‌‍‍‍‌‍‍‍‍‌‌‌‍‍‌‍‍‍‌‌‍‍‍‍‌‌‍‌‍‍‌‌‌‌‍‌‌‍‌‍‍‌‌‌‌‍‌‌‌‌‌‍‍‌‌‌‌‍‍‍‌‍‌‌‍‍‍‌‍‍‌‌‌‌‍‌‍‍‌‍‍‌‌‍‍‌‌‌‍‌‌‍‌‍‍‌‌‌‍‍‍‌‌‌‍‌‍‍‌‌‍‍‍‍‍‍‍‌‌‌‍‌‌‍‌‍‍‌‌‌‍‌‍‍‍‍‌‌‍‌‍‍‌‍‍‍‍‌‍‍‍‌‌‍‌‌‌‍‍‍‌‍‌‌‌‍‌‌‌‌‌‍‍‍‌‌‍‍‌‍‌‍‍‍‍‌‌‍‌‍‌‌‌‍‌‍‍‍‌‌‍‌‍‍‌‍‌‍‍‌‍‍‌‌‍‌‍‍‍", "‌‍‍‍‌‍‌‌‌‍‍‌‍‍‍‍‌‍‌‍‌‍‌‍‌‍‍‍‌‌‌‌‌‍‍‍‌‌‌‌‌‍‍‌‌‍‌‍‌‍‍‍‌‌‍‌‌‍‌‌‌‌‍‍‌‍‍‌‌‌‌‍‌‍‍‍‌‌‍‍‌‍‍‌‌‍‌‍", "‌‌‍‌‌‌‌‍", "‌‍‍‌‍‍‌‌‌‍‍‌‍‍‍‍‌‍‍‌‌‍‍‍", "‌‍‍‌‍‍‌‌‌‍‍‌‌‍‌‍‌‍‍‌‍‍‍‌‌‍‍‌‌‍‍‍‌‍‍‍‌‍‌‌‌‍‍‌‍‌‌‌", "‮", 5, "string", "replace", /./g, /.{8}/g, /[\u00c0-\u00df][\u0080-\u00bf]/g, /[\u00e0-\u00ef][\u0080-\u00bf][\u0080-\u00bf]/g, "charCodeAt", 6, 31, 31, 63, String, "fromCharCode", 0, 1, 2, parseInt);
