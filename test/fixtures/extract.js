// tekrar eden deyim dizisi aynı kapsamda bir yardımcı fonksiyona çıkarılır
function step(state) {
  state.count++;
  state.history.push(state.count);
  console.log("adım", state.count, state.history.length);
  state.count++;
  state.history.push(state.count);
  console.log("adım", state.count, state.history.length);
  return state;
}
console.log(step({ count: 0, history: [] }).count);
// EXPECT: function extracted1() {
// EXPECT: extracted1();
