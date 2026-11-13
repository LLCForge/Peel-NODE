// jfogs 1.0.0-alpha.5 obfuscate(UNICODE, { type: "reverse" })
// NEEDLES: "Merhaba dünya, çalışıyor: 漢字" | toUpperCase
(function ($fog$0, $fog$1, $fog$2, $fog$3, $fog$4, $fog$17, $fog$8, $fog$7, $fog$13, $fog$10, $fog$11, $fog$12, $fog$16, $fog$14, $fog$15) {
  
if ("‮" !== $fog$17) {
  return;
}
var $fog$5 = arguments;
var $fog$6;
        
for ($fog$6 = $fog$13; $fog$6 < $fog$8; $fog$6++) {
  if (typeof $fog$5[$fog$6] === $fog$10) {
    $fog$5[$fog$6] = $fog$5[$fog$6][$fog$11]($fog$7)[$fog$12]()[$fog$16]($fog$7);
  }
}
        
for ($fog$6 = $fog$13; $fog$6 < $fog$8 / $fog$15; $fog$6++) {
  var $fog$9 = $fog$5[$fog$6];
  $fog$5[$fog$6] = $fog$5[$fog$8 - $fog$6 - $fog$14];
  $fog$5[$fog$8 - $fog$6 - $fog$14] = $fog$9;
}
        
  var msg = $fog$4;
function shout(s) { return s[$fog$3]() + $fog$2; }
console[$fog$1](shout(msg), msg[$fog$0]);

})("字漢 :royışılaç ,aynüd abahreM", "esaCreppUot", "!", "gol", "htgnel", "‮", 5, "", 0, "string", "split", "reverse", "join", 1, 2);
