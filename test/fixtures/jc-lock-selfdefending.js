(function(){var namedFunction=function(){const test=function(){const regExp=new RegExp("\n");return regExp["test"](namedFunction)};if(test()){while(true){}}};return namedFunction()})();function hi(name){(function(){var namedFunction=function(){const test=function(){const regExp=new RegExp("\n");return regExp["test"](namedFunction)};if(test()){while(true){}}};return namedFunction()})();return"Hi, "+name}var total=6*7;console["log"](hi("PEEL"),total);
// EXPECT: return "Hi, " + name;
// GONE: while (true)
// GONE: RegExp
