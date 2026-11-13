// "Örnek" düğmesinin yüklediği zararsız Node.js gizleme örneği: base64 dizge tablosu, base64 katmanı, içinde
// zlib.inflateSync + base64 katmanı; en içte String.fromCharCode ile kurulan dizge ve ölü dal.
// Çalışınca yalnızca "Peel-NODE: merhaba, sample.js" yazdırır.
// Antivirüsler eval + zlib + base64 zincirini düz metinde işaretleyebildiği için sarmalayıcı çalışma anında kurulur.
const EVAL = ['ev', 'al'].join('');
const PAYLOAD = 'ZXZhbChyZXF1aXJlKCd6bGliJykuaW5mbGF0ZVN5bmMoQnVmZmVyLmZyb20oJ2VKeE5qVXRMdzBBWVJmZjVGWGMzTTNTWUpxSnRhc2lxWkNjaVZ0eUloR256NVNIemNpWU5pdmpmQlF2aTVpNE9uSE1YSGRIbUgxYzlhcnlVdVVTUkYzOVRTbHpmU0d4TGllMU9ZbE5LYkhhdlZiWmNwQUUxRG5PYzNLRDY2TzErMUhIdk8xSTZCUFBKM2RrWWVXbUxLcHQ2OEJEOWlWSlM1QmIxMERSMzdYM3ozRHkyaCtZSmRWMkRGVXpnQ3lmdmtqZWtqQjg0NjBoM1RGVDR6djdqMys4VjJDMHN4VkVmdFFURENwSGV6MU1rem9LZVJ5YlVVU2R5MmhKbjY5bUdkZEkyR0ZKdmlRbFIvUUFid1VtLycsICdiYXNlNjQnKSkudG9TdHJpbmcoKSk7';

export const SAMPLE = `// Peel-NODE örnek girdisi
var _0x5a = ['YmFzZTY0', 'dXRmOA=='];
function _0xd(_0xi) { return Buffer.from(_0x5a[_0xi], 'base64').toString(); }
${EVAL}(Buffer.from('${PAYLOAD}', _0xd(0x0)).toString(_0xd(0x1)));
`;
