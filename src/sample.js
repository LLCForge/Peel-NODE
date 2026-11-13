// "Örnek kodla dene" butonunun yüklediği, obfuscator.io tarzı kısa bir girdi:
// rotasyonlu base64 string tablosu, window alias'ı, debug koruması, akış düzleştirme, boş sarmalayıcı.
export const SAMPLE = `var _0x3c = ["c3RhdHVzOiBvaw==", "UE9TVA==", "bG9n", "Y29uc29sZQ==", "aHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vdjEvY29sbGVjdA==", "ZmV0Y2g=", "UEVFTA=="];
(function (_0x1, _0x2) { while (--_0x2) { _0x1.push(_0x1.shift()); } }(_0x3c, 0x3));
function _0x4d(_0xi) { _0xi = _0xi - 0x0; return atob(_0x3c[_0xi]); }
var _0xg = window;
(function () {
  setInterval(function () { debugger; }, 0xfa0);
})();
function _0xad() { _0xad = function () {}; }
function _0xe() {}
function run() {
  var _0xorder = "2|0|1".split("|"), _0xn = 0x0;
  while (!![]) {
    switch (_0xorder[_0xn++]) {
      case "0": _0xg[_0x4d(0x1)][_0x4d(0x0)](_0x4d(0x4) + " " + _0x4d(0x5)); continue;
      case "1": _0xg[_0x4d(0x3)](_0x4d(0x2), { "method": _0x4d(0x6), "body": "id=" + 0x1f * 0x2 }); continue;
      case "2": _0xad(0x1); continue;
    }
    break;
  }
}
if ("x" in _0xe) { _0xad(0x0); } else { run(); }
`;
