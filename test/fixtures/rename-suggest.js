// kullanım kanıtından ad önerisi: DOM seçicisi, olay işleyicisi, ağ fonksiyonu, callback parametreleri
var _0x1a = document.getElementById("login-btn");
function _0x2b(_0x3c) { _0x3c.preventDefault(); return fetch("/api/user/profile").then(function (_0x4d) { return _0x4d.status; }); }
if (_0x1a) _0x1a.addEventListener("click", _0x2b);
[1, 2].forEach(function (_0x5e, _0x6f) { console.log(_0x5e, _0x6f); });
// EXPECT: loginBtn
// EXPECT: function onClick(
// EXPECT: event.preventDefault()
// EXPECT: response.status
// EXPECT: (item, index)
// GONE: _0x
