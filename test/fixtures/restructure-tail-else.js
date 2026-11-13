// dal ortak sonekle bitiyor ama kuyruğun yalnızca bir kısmı ortak: A ve B if-else kollarına, S bir kez sona
function f(flag, o) {
  if (flag === "a") {
    o.v = o.v * 3;
    console.log("shared-tail", o.v);
    return o.v + 1;
  }
  o.v = o.v + 5;
  console.log("shared-tail", o.v);
  return o.v + 1;
}
console.log(["a", "b"].map(function (fl, i) { return f(fl, { v: i + 1 }); }).join());
// EXPECT: ? _o_1_v * 3 : _o_1_v + 5;
// EXPECT: "shared-tail"
