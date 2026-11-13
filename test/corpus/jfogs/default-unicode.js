// jfogs 1.0.0-alpha.5 obfuscate(UNICODE, { type: "" })
// NEEDLES: "Merhaba dünya, çalışıyor: 漢字" | toUpperCase
(function ($fog$5, $fog$0, $fog$1, $fog$2, $fog$3, $fog$4) {
  
if ("‮" !== $fog$5) {
  return;
}
        
  var msg = $fog$0;
function shout(s) { return s[$fog$1]() + $fog$2; }
console[$fog$3](shout(msg), msg[$fog$4]);

})("‮", "Merhaba dünya, çalışıyor: 漢字", "toUpperCase", "!", "log", "length");
