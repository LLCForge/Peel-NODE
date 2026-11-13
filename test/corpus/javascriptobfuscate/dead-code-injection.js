// javascript-obfuscator 0.18.8, JavaScriptObfuscate demo_dead_code_injection.js ayarları: {"compact":false,"deadCodeInjection":true,"deadCodeInjectionThreshold":1}
// NEEDLES: "https://api.example.com/v1/collect" | "alpha" | "production" | toUpperCase | console.log
var _0x5d7c = [
    'production',
    'https://api.example.com/v1/collect',
    'length',
    'inc',
    'alpha',
    'beta',
    'gamma',
    'map',
    'log',
    'endpoint',
    'retries',
    'join',
    'debug',
    'debug\x20mode'
];
(function (_0x187d6d, _0x3786f2) {
    var _0x5f321a = function (_0x1a15ec) {
        while (--_0x1a15ec) {
            _0x187d6d['push'](_0x187d6d['shift']());
        }
    };
    _0x5f321a(++_0x3786f2);
}(_0x5d7c, 0x143));
var _0x5ebf = function (_0x16e132, _0x40c6e4) {
    _0x16e132 = _0x16e132 - 0x0;
    var _0x2d499d = _0x5d7c[_0x16e132];
    return _0x2d499d;
};
function greet(_0x367913) {
    return 'Hello,\x20' + _0x367913 + '!';
}
var config = {
    'endpoint': _0x5ebf('0x0'),
    'retries': 0x3,
    'debug': ![]
};
function sum(_0x426851) {
    var _0x73ea7a = 0x0;
    for (var _0x56b0e9 = 0x0; _0x56b0e9 < _0x426851[_0x5ebf('0x1')]; _0x56b0e9++)
        _0x73ea7a += _0x426851[_0x56b0e9];
    return _0x73ea7a;
}
class Counter {
    constructor() {
        this['n'] = 0x0;
    }
    [_0x5ebf('0x2')]() {
        this['n']++;
        return this['n'];
    }
}
var c = new Counter();
c['inc']();
c['inc']();
var words = [
    _0x5ebf('0x3'),
    _0x5ebf('0x4'),
    _0x5ebf('0x5')
][_0x5ebf('0x6')](function (_0x2467b5) {
    return _0x2467b5['toUpperCase']();
});
console[_0x5ebf('0x7')](greet('PEEL'));
console[_0x5ebf('0x7')](config[_0x5ebf('0x8')], config[_0x5ebf('0x9')] * 0x2, sum([
    0x1,
    0x2,
    0x3,
    0x4
]));
console['log'](words[_0x5ebf('0xa')]('-'), c['n'], typeof config[_0x5ebf('0xb')]);
if (config[_0x5ebf('0xb')]) {
    console[_0x5ebf('0x7')](_0x5ebf('0xc'));
} else {
    console[_0x5ebf('0x7')](_0x5ebf('0xd'));
}
