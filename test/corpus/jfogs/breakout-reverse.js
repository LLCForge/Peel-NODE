// jfogs 1.0.0-alpha.5 obfuscate(SOURCE, { breakout: true, type: "reverse" })
// NEEDLES: "https://api.example.com/v1/collect" | "alpha" | "production" | toUpperCase | console.log
var $fog$39 = {};
(function ($fog$0, $fog$1, $fog$2, $fog$3, $fog$4, $fog$5, $fog$6, $fog$7, $fog$8, $fog$9, $fog$10, $fog$11, $fog$12, $fog$13, $fog$14, $fog$15, $fog$16, $fog$17, $fog$18, $fog$19, $fog$20, $fog$21, $fog$22, $fog$23, $fog$24, $fog$25, $fog$38, $fog$29, $fog$28, $fog$34, $fog$31, $fog$32, $fog$33, $fog$37, $fog$35, $fog$36) {
  
if ("‮" !== $fog$38) {
  return;
}
var $fog$26 = arguments;
var $fog$27;
        
for ($fog$27 = $fog$34; $fog$27 < $fog$29; $fog$27++) {
  if (typeof $fog$26[$fog$27] === $fog$31) {
    $fog$26[$fog$27] = $fog$26[$fog$27][$fog$32]($fog$28)[$fog$33]()[$fog$37]($fog$28);
  }
}
        
for ($fog$27 = $fog$34; $fog$27 < $fog$29 / $fog$36; $fog$27++) {
  var $fog$30 = $fog$26[$fog$27];
  $fog$26[$fog$27] = $fog$26[$fog$29 - $fog$27 - $fog$35];
  $fog$26[$fog$29 - $fog$27 - $fog$35] = $fog$30;
}
        
  
function greet(name) { return $fog$25 + name + $fog$24; }
var config = { endpoint: $fog$23, retries: $fog$22, debug: $fog$21 };
function sum(list) { var s = $fog$20; for (var i = $fog$20; i < list[$fog$19]; i++) s += list[i]; return s; }
class Counter { constructor() { this[$fog$18] = $fog$20; } inc() { this[$fog$18]++; return this[$fog$18]; } }
var c = new Counter(); c[$fog$17](); c[$fog$17]();
var words = [$fog$15, $fog$14, $fog$13][$fog$16](function (w) { return w[$fog$12](); });
console[$fog$11](greet($fog$10));
console[$fog$11](config[$fog$9], config[$fog$8] * $fog$7, sum([$fog$6, $fog$7, $fog$22, $fog$5]));
console[$fog$11](words[$fog$4]($fog$3), c[$fog$18], typeof config[$fog$2]);
if (config[$fog$2]) { console[$fog$11]($fog$1); } else { console[$fog$11]($fog$0); }

  $fog$39.greet = greet;
$fog$39.config = config;
$fog$39.sum = sum;
$fog$39.c = c;
$fog$39.words = words;
})(" ,olleH", "!", "tcelloc/1v/moc.elpmaxe.ipa//:sptth", 3, false, 0, "htgnel", "n", "cni", "pam", "ahpla", "ateb", "ammag", "esaCreppUot", "gol", "LEEP", "tniopdne", "seirter", 2, 1, 4, "nioj", "-", "gubed", "edom gubed", "noitcudorp", "‮", 26, "", 0, "string", "split", "reverse", "join", 1, 2);
var greet = $fog$39.greet;
var config = $fog$39.config;
var sum = $fog$39.sum;
var c = $fog$39.c;
var words = $fog$39.words;
