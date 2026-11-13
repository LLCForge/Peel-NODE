// jfogs 1.0.0-alpha.5 obfuscate(SOURCE, { breakout: true })
// NEEDLES: "https://api.example.com/v1/collect" | "alpha" | "production" | toUpperCase | console.log
var $fog$27 = {};
(function ($fog$26, $fog$0, $fog$1, $fog$2, $fog$3, $fog$4, $fog$5, $fog$6, $fog$7, $fog$8, $fog$9, $fog$10, $fog$11, $fog$12, $fog$13, $fog$14, $fog$15, $fog$16, $fog$17, $fog$18, $fog$19, $fog$20, $fog$21, $fog$22, $fog$23, $fog$24, $fog$25) {
  
if ("‮" !== $fog$26) {
  return;
}
        
  
function greet(name) { return $fog$0 + name + $fog$1; }
var config = { endpoint: $fog$2, retries: $fog$3, debug: $fog$4 };
function sum(list) { var s = $fog$5; for (var i = $fog$5; i < list[$fog$6]; i++) s += list[i]; return s; }
class Counter { constructor() { this[$fog$7] = $fog$5; } inc() { this[$fog$7]++; return this[$fog$7]; } }
var c = new Counter(); c[$fog$8](); c[$fog$8]();
var words = [$fog$10, $fog$11, $fog$12][$fog$9](function (w) { return w[$fog$13](); });
console[$fog$14](greet($fog$15));
console[$fog$14](config[$fog$16], config[$fog$17] * $fog$18, sum([$fog$19, $fog$18, $fog$3, $fog$20]));
console[$fog$14](words[$fog$21]($fog$22), c[$fog$7], typeof config[$fog$23]);
if (config[$fog$23]) { console[$fog$14]($fog$24); } else { console[$fog$14]($fog$25); }

  $fog$27.greet = greet;
$fog$27.config = config;
$fog$27.sum = sum;
$fog$27.c = c;
$fog$27.words = words;
})("‮", "Hello, ", "!", "https://api.example.com/v1/collect", 3, false, 0, "length", "n", "inc", "map", "alpha", "beta", "gamma", "toUpperCase", "log", "PEEL", "endpoint", "retries", 2, 1, 4, "join", "-", "debug", "debug mode", "production");
var greet = $fog$27.greet;
var config = $fog$27.config;
var sum = $fog$27.sum;
var c = $fog$27.c;
var words = $fog$27.words;
