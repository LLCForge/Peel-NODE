// js-confuser string yardımcısı: global nesne bulucusunun ilk adayı globalThis (diğer adaylar hiç çalışmaz),
// UTF-8 çözücü IIFE'si kendi rest dizisine yazıyor; sonuçları okunmuyorsa hepsi ölüdür
var G, S, A, dec, other;
function getGlobal() {
  let arr, best, items, i, j;
  arr = [function () { return globalThis; }, function () { return window; },
    function () { return new Function(String.fromCharCode(114, 101, 116, 117, 114, 110, 32, 116, 104, 105, 115))(); }];
  best = undefined;
  items = [];
  try { best = Object; items.push("".__proto__.constructor.name); } catch {}
  L: for (i = 0; i < arr.length; i++) try {
    best = arr[i]();
    for (j = 0; j < items.length; j++) if (typeof best[items[j]] === "undefined") continue L;
    return best;
  } catch (e) {}
  return best || this;
}
G = getGlobal() || {};
S = G.String || String;
A = G.Array || Array;
dec = (function (...M) { M.length = 0; M.a = new A(16); M[-3] = S.fromCodePoint || S.fromCharCode; return function (b) { return M[-3](b); }; })();
other = getGlobal();
getGlobal();
function getGlobal2() {
  function helper(x) { return String.fromCharCode(x); }
  let arr, best, items, i, j;
  arr = [function () { return globalThis; }, function () { return new Function(helper(114) + "eturn this")(); }];
  best = undefined;
  items = [];
  try { best = Object; items.push("".__proto__.constructor.name); } catch {}
  L2: for (i = 0; i < arr.length; i++) try {
    best = arr[i]();
    for (j = 0; j < items.length; j++) if (typeof best[items[j]] === "undefined") continue L2;
    return best;
  } catch (e) {}
  return best || this;
}
var other2 = getGlobal2();
console.log("helper-gone");
// EXPECT: console.log("helper-gone")
// GONE: getGlobal
// GONE: fromCodePoint
// GONE: other
