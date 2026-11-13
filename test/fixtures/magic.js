// sihirli sayılar bağlamlarına göre adlandırılmış sabitlere bağlanır
function onKey(e) {
  if (e.keyCode === 13) return "enter";
  if (e.keyCode === 27) return "escape";
  return "other";
}
function crcStep(c) { return (c >>> 1) ^ 0xedb88320; }
var tomorrow = Date.now() + 86400000;
console.log(onKey({ keyCode: 13 }), onKey({ keyCode: 27 }), tomorrow > 0, crcStep(tomorrow % 7) !== 0);
// EXPECT: e.keyCode === KEY_ENTER
// EXPECT: e.keyCode === KEY_ESCAPE
// EXPECT: const MS_PER_DAY = 86400000;
// EXPECT: CRC32_POLY
