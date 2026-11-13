// js-confuser high: dağıtıcı pack IIFE'sinin içinde, bayrak testleri "true &&" kalıntılı, argüman dizisi ayrı
// deyimde atanıyor ve girdiler (variableMasking açılmış) diziyi atama biçimiyle ([a, [b]] = P) okuyor
(function () {
  let payload, cache;
  cache = { __proto__: null };
  payload = undefined;
  function D(name, flag, ret, lengths = {}, out, fresh, value, fns) {
    fns = {
      ["k1"]: function (a) {
        let local9, n;
        [local9, [n]] = payload;
        return n * 2 + (a === undefined ? 0 : 1);
      },
      k2: function () {
        var [x, [s]] = payload;
        return "<" + s + ">";
      },
    };
    if (true && flag === "clr") { payload = []; }
    if (true && flag === "ref") {
      function make() {
        let f = function (...args) { payload = args; return fns[name].apply(this); };
        return f;
      }
      value = cache[name] || (cache[name] = make());
    } else {
      value = fns[name]();
    }
    if (ret === "wrap") { return { box: value }; } else { return value; }
  }
  function dbl(...a) { const o = {}; payload = [o, a]; return new D("k1", "call", "wrap").box; }
  function tag(...a) { let o = {}; payload = [o, a]; return D("k2", "call", "wrap").box; }
  console.log(dbl(21), tag("dispatch-scoped"));
})();
// EXPECT: console.log(
// EXPECT: "<"
// GONE: payload
// GONE: "wrap"
// GONE: .apply(this)
