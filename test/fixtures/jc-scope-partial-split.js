// kapsam kökünün bir anahtarı başka makineye değer olarak geçse de ({ P: S.P }), diğer taze anahtarlar yerel
// değişkenlere bölünür
function M(states, scope = { P: {} }, rt, args) { return scope.P.v + states.length; }
function R(states, S = { K: {}, P: {} }, rt, args) {
  S.K.count = states[0];
  S.K.label = "split-";
  S.P.v = states[0] * 10;
  return S.K.label + S.K.count + "/" + M([1, 2], { P: S.P }, rt, args);
}
console.log([1, 2].map(function (i) { return R([i]); }).join());
// EXPECT: "split-"
// GONE: S.K.
