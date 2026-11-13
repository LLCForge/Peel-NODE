function run(state) {
  const L = [0, 1, "length", "Hello", " world", 8];
  var parts = [L[3], L[4]];
  // dinamik indeksli okuma: dizi yerinde kalmalı, sabit indeksliler yine de yazılmalı
  console.log(parts.join(""), parts[L[2]], L[state + 1]);
}
run(4);
// LEVEL: 3
// EXPECT: var parts = ["Hello", " world"];
// EXPECT: parts.length
// EXPECT: L[state + 1]
