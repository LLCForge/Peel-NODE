// E632-E636: obfuscator.io rc4 string tablosu (javascript-obfuscator 5, seed 7); rapor statik rotasyonu ve kısmi tabloyu gösterir
function _0x35dd(_0x1f5049, _0x11daa1) {
    _0x1f5049 = _0x1f5049 - 0x12b;
    var _0x3a3715 = _0x3a37();
    var _0x35dd44 = _0x3a3715[_0x1f5049];
    if (_0x35dd['wMmnxl'] === undefined) {
        var _0x2fa489 = function (_0x52df8b) {
            var _0x5efba2 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';
            var _0x2d8fb7 = '', _0x1cf950 = '';
            for (var _0x59f2a1 = 0x0, _0x3ec657, _0x171dba, _0x4d781e = 0x0; _0x171dba = _0x52df8b['charAt'](_0x4d781e++); ~_0x171dba && (_0x3ec657 = _0x59f2a1 % 0x4 ? _0x3ec657 * 0x40 + _0x171dba : _0x171dba, _0x59f2a1++ % 0x4) ? _0x2d8fb7 += String['fromCharCode'](0xff & _0x3ec657 >> (-0x2 * _0x59f2a1 & 0x6)) : 0x0) {
                _0x171dba = _0x5efba2['indexOf'](_0x171dba);
            }
            for (var _0x11b7a2 = 0x0, _0x272f84 = _0x2d8fb7['length']; _0x11b7a2 < _0x272f84; _0x11b7a2++) {
                _0x1cf950 += '%' + ('00' + _0x2d8fb7['charCodeAt'](_0x11b7a2)['toString'](0x10))['slice'](-0x2);
            }
            return decodeURIComponent(_0x1cf950);
        };
        var _0x3f7215 = function (_0x477d12, _0x70c06) {
            var _0x16a2ca = [], _0x44ca6b = 0x0, _0x5f0d7b, _0x1c5a06 = '';
            _0x477d12 = _0x2fa489(_0x477d12);
            var _0xb32654;
            for (_0xb32654 = 0x0; _0xb32654 < 0x100; _0xb32654++) {
                _0x16a2ca[_0xb32654] = _0xb32654;
            }
            for (_0xb32654 = 0x0; _0xb32654 < 0x100; _0xb32654++) {
                _0x44ca6b = (_0x44ca6b + _0x16a2ca[_0xb32654] + _0x70c06['charCodeAt'](_0xb32654 % _0x70c06['length'])) % 0x100, _0x5f0d7b = _0x16a2ca[_0xb32654], _0x16a2ca[_0xb32654] = _0x16a2ca[_0x44ca6b], _0x16a2ca[_0x44ca6b] = _0x5f0d7b;
            }
            _0xb32654 = 0x0, _0x44ca6b = 0x0;
            for (var _0x2b0c53 = 0x0; _0x2b0c53 < _0x477d12['length']; _0x2b0c53++) {
                _0xb32654 = (_0xb32654 + 0x1) % 0x100, _0x44ca6b = (_0x44ca6b + _0x16a2ca[_0xb32654]) % 0x100, _0x5f0d7b = _0x16a2ca[_0xb32654], _0x16a2ca[_0xb32654] = _0x16a2ca[_0x44ca6b], _0x16a2ca[_0x44ca6b] = _0x5f0d7b, _0x1c5a06 += String['fromCharCode'](_0x477d12['charCodeAt'](_0x2b0c53) ^ _0x16a2ca[(_0x16a2ca[_0xb32654] + _0x16a2ca[_0x44ca6b]) % 0x100]);
            }
            return _0x1c5a06;
        };
        _0x35dd['ywgjgP'] = _0x3f7215, _0x35dd['lqtoEh'] = {}, _0x35dd['wMmnxl'] = !![];
    }
    var _0x4c8614 = _0x3a3715[0x0];
    _0x35dd['SfAasy'] !== _0x4c8614 && (_0x35dd['lqtoEh'] = {}, _0x35dd['SfAasy'] = _0x4c8614);
    var _0x224b78 = _0x35dd['lqtoEh'][_0x1f5049];
    return _0x224b78 === undefined ? (_0x35dd['YkDKej'] === undefined && (_0x35dd['YkDKej'] = !![]), _0x35dd44 = _0x35dd['ywgjgP'](_0x35dd44, _0x11daa1), _0x35dd['lqtoEh'][_0x1f5049] = _0x35dd44) : _0x35dd44 = _0x224b78, _0x35dd44;
}
(function (_0x554d17, _0x307663) {
    var _0x132016 = _0x554d17();
    while (!![]) {
        try {
            var _0x2bcfb = -parseInt(_0x35dd(0x142, '#8ep')) / 0x1 * (-parseInt(_0x35dd(0x12f, 'ZJJY')) / 0x2) + parseInt(_0x35dd(0x133, 'uZXj')) / 0x3 + parseInt(_0x35dd(0x12c, 'l6%a')) / 0x4 * (-parseInt(_0x35dd(0x13e, 'oxDp')) / 0x5) + parseInt(_0x35dd(0x144, '5TvU')) / 0x6 + -parseInt(_0x35dd(0x147, 'lp9M')) / 0x7 + -parseInt(_0x35dd(0x13c, 'Og*x')) / 0x8 + parseInt(_0x35dd(0x138, 'su)1')) / 0x9;
            if (_0x2bcfb === _0x307663)
                break;
            else
                _0x132016['push'](_0x132016['shift']());
        } catch (_0x4117d1) {
            _0x132016['push'](_0x132016['shift']());
        }
    }
}(_0x3a37, 0x5b279));
function greet(_0x2d8fb7) {
    return console[_0x35dd(0x139, '3[[n')](_0x35dd(0x143, 'pUiX') + _0x2d8fb7, _0x35dd(0x13a, 'su)1'), _0x35dd(0x13b, 'E[7h'), _0x35dd(0x12b, 'HMb#'), _0x35dd(0x136, 'HMb#')), _0x35dd(0x12e, 'W7mA') + _0x35dd(0x13d, '#8ep');
}
function _0x3a37() {
    var _0x29149c = [
        'e8k2umoxveZcICkOvmkOdSke',
        'WQ4MFmkFzJ4',
        'l8kpW4XeisGgWPLRWRL1khW',
        'W5y4W5PwW7JcVHW',
        'BwOjW7u',
        'uLpcK8ojzCk2CCkTW7nzkmkUWPa',
        'WPhcLmoFpW',
        'yt4UW7SHcMJdIHCdW7LgW6W',
        'W5ddR8ksjKG',
        'WQDSke9H',
        'W7ZcRYHxWQXkW5O',
        'WQLfgKT1gCksW7X5rLRcVM0',
        'hSo+WRpdUbqMW69Jv0NdTeDd',
        'g8kSW64',
        'WPpcT8opAHRdNLCmh8orW7RcQa',
        'zsBcKSkuW6Lnpa',
        'jtHeWQWAWQZcKCoNW6xcIbZdO8kt',
        'WPtcKmogm8k+',
        'WRBdTSo+W5v0ltPgrg8ada',
        'WQ0MWO3dGmo6W57cGgKwW4FcSsav',
        'WOrVW48',
        'W6L5W43cNmkM',
        'W6aOWRqUhW',
        'rSoZWR/cMXPlrKqGDrtdOsa',
        'qmoWeSkgdrtcPG',
        'WONdLSk8WQ3dRmo2ma',
        'lSkkW41jlcScWRLuWQnukLG',
        'W7bZnG',
        'WOpcSmkBW4msmmkSA8olvhNdMCkH'
    ];
    _0x3a37 = function () {
        return _0x29149c;
    };
    return _0x3a37();
}
console[_0x35dd(0x132, 'Og*x')](greet(_0x35dd(0x146, '30K2')), _0x35dd(0x140, '3J0c'), _0x35dd(0x12d, 'uZXj'));
// LEVEL: 4
// EXPECT: "world"
// EXPECT: "deltaepsilon"
// GONE: parseInt
