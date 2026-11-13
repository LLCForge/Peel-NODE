// durum makinesi açılırken dala kopyalanan ortak kuyruk: if (c) { A; T } T → if (c) { A } T
function f(flag, o) {
  if (flag === "a") {
    o.v = o.v * 3;
    console.log("tail-one", o.v);
    return o.v + 1;
  }
  console.log("tail-one", o.v);
  return o.v + 1;
}
console.log(["a", "b"].map(function (fl, i) { return f(fl, { v: i + 1 }); }).join());
// EXPECT: console.log("tail-one"
// EXPECT: .join()
