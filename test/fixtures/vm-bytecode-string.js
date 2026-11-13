// jsvmp tarzı: bytecode şifreli string, çalışma anında çözülüyor; opcode'lar XOR'lu, if-chain dağıtım
var names = ["console", "log", "ok:"];
var enc = "\x7f!z'z&yz)x~ }";
var bc = "";
for (var i = 0; i < enc.length; i++) bc += String.fromCharCode(enc.charCodeAt(i) ^ 33);
var st = [], ip = 0;
while (ip < bc.length) {
  var o = bc.charCodeAt(ip++) ^ 90;
  if (o === 1) { st.push(bc.charCodeAt(ip++)); }
  else if (o === 2) { var y = st.pop(); st.push(st.pop() * y); }
  else if (o === 3) { var y = st.pop(); st.push(st.pop() - y); }
  else if (o === 4) { st.push(globalThis[names[bc.charCodeAt(ip++)]]); }
  else if (o === 5) { var v = st.pop(); var c = st.pop(); c[names[bc.charCodeAt(ip++)]](names[2], v); }
  else if (o === 6) { break; }
}
// LEVEL: 3
// EXPECT: PEEL VM-LIFT
// EXPECT: bytecode: çalışma anında yakalandı
// EXPECT: ("ok:", 34)
// GONE: st.pop()
// GONE: if (o ===
