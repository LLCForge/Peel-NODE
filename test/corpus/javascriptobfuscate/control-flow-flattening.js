// javascript-obfuscator 0.18.8, JavaScriptObfuscate demo_control_flow_flattening.js ayarları: {"compact":false,"controlFlowFlattening":true}
// NEEDLES: "https://api.example.com/v1/collect" | "alpha" | "production" | toUpperCase | console.log
var _0x5d7c = [
    'length',
    'inc',
    'alpha',
    'gamma',
    'map',
    'toUpperCase',
    'PEEL',
    'endpoint',
    'retries',
    'log',
    'debug',
    'PRqzz',
    'Hello,\x20'
];
(function (_0x42b3d0, _0x461419) {
    var _0x54e519 = function (_0x438217) {
        while (--_0x438217) {
            _0x42b3d0['push'](_0x42b3d0['shift']());
        }
    };
    _0x54e519(++_0x461419);
}(_0x5d7c, 0x143));
var _0x5ebf = function (_0x16e132, _0x40c6e4) {
    _0x16e132 = _0x16e132 - 0x0;
    var _0x2d499d = _0x5d7c[_0x16e132];
    return _0x2d499d;
};
function greet(_0x22fcee) {
    var _0x4e0e43 = {
        'PRqzz': function (_0x522820, _0x2eb819) {
            return _0x522820 + _0x2eb819;
        }
    };
    return _0x4e0e43[_0x5ebf('0x0')](_0x5ebf('0x1'), _0x22fcee) + '!';
}
var config = {
    'endpoint': 'https://api.example.com/v1/collect',
    'retries': 0x3,
    'debug': ![]
};
function sum(_0x31897e) {
    var _0x16196e = {
        'OBXOs': function (_0x870f33, _0x16cb5a) {
            return _0x870f33 < _0x16cb5a;
        }
    };
    var _0x4816b1 = 0x0;
    for (var _0x1268c8 = 0x0; _0x16196e['OBXOs'](_0x1268c8, _0x31897e[_0x5ebf('0x2')]); _0x1268c8++)
        _0x4816b1 += _0x31897e[_0x1268c8];
    return _0x4816b1;
}
class Counter {
    constructor() {
        this['n'] = 0x0;
    }
    [_0x5ebf('0x3')]() {
        this['n']++;
        return this['n'];
    }
}
var c = new Counter();
c[_0x5ebf('0x3')]();
c[_0x5ebf('0x3')]();
var words = [
    _0x5ebf('0x4'),
    'beta',
    _0x5ebf('0x5')
][_0x5ebf('0x6')](function (_0x20c98b) {
    return _0x20c98b[_0x5ebf('0x7')]();
});
console['log'](greet(_0x5ebf('0x8')));
console['log'](config[_0x5ebf('0x9')], config[_0x5ebf('0xa')] * 0x2, sum([
    0x1,
    0x2,
    0x3,
    0x4
]));
console[_0x5ebf('0xb')](words['join']('-'), c['n'], typeof config[_0x5ebf('0xc')]);
if (config['debug']) {
    console[_0x5ebf('0xb')]('debug\x20mode');
} else {
    console['log']('production');
}
