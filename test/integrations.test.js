// Entegrasyon modüllerinin öz-denetimi: node test/integrations.test.js
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { getQuickJS } from 'quickjs-emscripten';
import { deobfuscate } from '../src/core/pipeline.js';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { encodeShare, decodeShare, isEncrypted, shareUrl } from '../src/integrations/share.js';
import { fastImportStream, commitCount } from '../src/integrations/gitexport.js';
import { readAsar, writeAsar } from '../src/integrations/asar.js';
import { symbolMap, renameAcross } from '../src/integrations/multifile.js';
import { createProject, parseProject, serializeProject, upsertFile, applyRenames } from '../src/integrations/project.js';
import { resolvePasses, definePlugin } from '../src/integrations/plugins.js';
import { PASSES } from '../src/core/registry.js';
import { generateKeyPair, signPlugin, verifyPlugin } from '../src/integrations/signing.js';
import { parseRules, rulesPlugin } from '../src/integrations/rules.js';
import { toSarif } from '../src/integrations/sarif.js';
import { normalizeSemgrep } from '../src/integrations/semgrep.js';
import { resolveStyle, formatWithStyle, fromEditorconfig, fromEslint } from '../src/integrations/style.js';
import { explainWhy } from '../src/integrations/why.js';
import { anonymize, buildFixture, issueUrl } from '../src/integrations/anonymize.js';
import { createHistory, memoryStore } from '../src/integrations/history.js';
import { buildReportHtml } from '../src/integrations/report-html.js';
import { unseen, latestSeq } from '../src/integrations/changelog.js';
import { startServer } from '../src/server/http.js';
import { verifySlack, verifyDiscord, extractCode } from '../src/server/bots.js';
import * as lib from '../src/index.js';

const host = createHost(await getQuickJS());
const sandbox = sandboxApi(async (m) => host.handle(m));

// paylaşım: düz ve şifreli, yanlış parola, kurcalanmış veri
{
  const f = await encodeShare({ input: 'var x = "ğüşİ";', name: 'a.js' });
  assert.match(f, /^peel=z1\.[\w-]+$/);
  assert.deepEqual(await decodeShare(`#${f}`), { v: 1, input: 'var x = "ğüşİ";', name: 'a.js' });
  const e = await encodeShare({ input: 'gizli()' }, { password: 'uzun-parola-123' });
  assert.ok(isEncrypted(e) && !e.includes('gizli'));
  assert.equal((await decodeShare(e, { password: 'uzun-parola-123' })).input, 'gizli()');
  await assert.rejects(decodeShare(e, { password: 'yanlis-parola' }), /Parola yanlış/);
  await assert.rejects(decodeShare(e), /parola/);
  await assert.rejects(encodeShare({ input: 'x' }, { password: 'kısa' }), /8 karakter/);
  assert.equal(await decodeShare('#baska=1'), null);
  assert.match(shareUrl('http://localhost:5173/', f), /^http:\/\/localhost:5173\/#peel=z1\./);
}

// git fast-import akışı: bayt uzunlukları UTF-8, değişmeyen adım commit üretmez
{
  const s = fastImportStream({ input: 'ç', snapshots: [{ id: 'girdi', round: 0, code: 'ç' }, { id: 'rename', round: 1, code: 'ş;' }], output: 'ş;\n', time: 1 });
  assert.equal(commitCount(s), 3);
  assert.match(s, /data 2\nç\n/);
  assert.throws(() => fastImportStream({ input: '', file: '../x' }), /Geçersiz dosya/);
}

// asar: yaz/oku, yol geçişi reddi
{
  const buf = writeAsar({ 'package.json': '{"main":"main.js"}', 'lib/main.js': 'console.log(1)' });
  const a = readAsar(buf);
  assert.deepEqual(a.files.map((f) => f.path).sort(), ['lib/main.js', 'package.json']);
  assert.equal(a.readText('lib/main.js'), 'console.log(1)');
  assert.throws(() => writeAsar({ '../evil.js': 'x' }), /Geçersiz asar/);
  const evil = writeAsar({ ab: 'x' });
  const json = new TextDecoder().decode(evil.subarray(16, 16 + evil[12]));
  const bad = new TextEncoder().encode(json.replace('"ab"', '".."'));
  evil.set(bad, 16);
  assert.throws(() => readAsar(evil), /Geçersiz asar/);
  assert.throws(() => readAsar(new Uint8Array(20)), /asar arşivi değil/);
}

// çoklu dosya sembol eşleme
{
  const files = [
    { name: 'lib.js', code: 'var api = { send: function () {} }; window.cfg = { url: "x" };' },
    { name: 'app.js', code: 'api.send(window.cfg.url); var local = 1;' },
  ];
  const m = symbolMap(files);
  assert.ok(m.shared.some((s) => s.name === 'api'));
  assert.ok(m.edges.some((e) => e.from === 'app.js' && e.to === 'lib.js' && e.symbols.includes('cfg')));
  const r = await renameAcross(files, { api: 'transport' });
  assert.match(r[0].code, /var transport =/);
  assert.match(r[1].code, /transport\.send/);
}

// .peel proje biçimi
{
  let p = createProject({ name: 'deneme', options: { level: 3 } });
  p = upsertFile(p, { name: 'a.js', input: 'var _0x1 = 1; console.log(_0x1);', renames: { _0x1: 'count' } });
  const back = parseProject(serializeProject(p));
  assert.equal(back.options.level, 3);
  assert.deepEqual(back.files[0].renames, { _0x1: 'count' });
  assert.throws(() => parseProject('{"format":"x"}'), /\.peel dosyası değil/);
  assert.throws(() => upsertFile(p, { name: 'b.js', renames: { 'a b': 'c' } }), /geçersiz ad/);
  const a = await applyRenames(back.files[0].input, back.files[0].renames);
  assert.match(a.code, /var count = 1;\s*console\.log\(count\)/);
}

// eklenti sistemi: yerleşim, doğrulama, pipeline'da çalışma ve geri alma
{
  const list = resolvePasses(PASSES, [{ id: 'mine', kind: 'ast', after: 'simplify', run() {} }]);
  assert.equal(list[list.findIndex((p) => p.id === 'simplify') + 1].id, 'mine');
  assert.throws(() => definePlugin({ id: 'rename', kind: 'ast', run() {} }, PASSES.map((p) => p.id)), /çakışıyor/);
  assert.throws(() => resolvePasses(PASSES, [{ id: 'x1', kind: 'text', after: 'simplify', run() {} }]), /arkasına konamaz/);
  const upper = { id: 'upper', kind: 'ast', level: 1, run(ast, { traverse, t }) { traverse(ast, { StringLiteral(p) { if (p.node.value === 'a') p.replaceWith(t.stringLiteral('A')); } }); } };
  const r1 = await deobfuscate('console.log("a");', { level: 1, sandbox, plugins: [upper] });
  assert.match(r1.code, /"A"/);
  // davranışı değiştirdiği için derin modda geri alınır
  const r2 = await deobfuscate('console.log("a");', { level: 1, sandbox, deep: true, plugins: [upper] });
  assert.match(r2.code, /"a"/);
  assert.ok(r2.events.some((e) => e.id === 'upper' && e.state === 'fail'));
}

// imzalı eklenti
{
  const kp = await generateKeyPair();
  const other = await generateKeyPair();
  const code = 'export default { id: "noop", kind: "ast", run() {} };';
  const b = await signPlugin({ manifest: { id: 'noop', version: '1.0.0' }, code, ...kp });
  assert.equal((await verifyPlugin(JSON.stringify(b), [kp.publicKey])).manifest.id, 'noop');
  await assert.rejects(verifyPlugin(b, [other.publicKey]), /güvenilenler/);
  await assert.rejects(verifyPlugin({ ...b, code: `${code}//x` }, [kp.publicKey]), /İmza geçersiz/);
  const plugin = await lib.importPluginSource(b.code);
  assert.equal(plugin.id, 'noop');
}

// kural dili
{
  assert.throws(() => parseRules('$a + 0 ==> $b'), /\$b desende yok/);
  assert.throws(() => parseRules('$a ==> 1'), /meta değişken/);
  assert.throws(() => parseRules('$a + 1 ==> $a when weird($a)'), /geçersiz koşul/);
  const r = await deobfuscate('var n = 2; console.log(!!n, f.call(undefined, 1, 2)); function f(a, b) { return a + b; }', {
    level: 1, sandbox, deep: true,
    plugins: [rulesPlugin('@cift !!$x ==> Boolean($x)\n@call $f.call(undefined, $$a) ==> $f($$a)\n@sifir $a * 1 ==> $a when number($a)')],
  });
  assert.match(r.code, /Boolean\(n\)/);
  assert.match(r.code, /f\(1, 2\)/);
}

// SARIF ve Semgrep
{
  const report = {
    threat: { classes: [{ id: 'skimmer', score: 40, evidence: ['form alanı değerleri okunuyor'] }], risk: { score: 40, level: 'medium' } },
    apis: [{ name: 'fetch', count: 1, why: 'ağ isteği' }], iocs: { urls: ['https://evil.example/c'] }, rollbacks: [], fingerprint: [],
  };
  const sem = normalizeSemgrep({ results: [{ check_id: 'extensions.semgrep.peel-beacon', start: { line: 2 }, end: { line: 2 }, extra: { message: 'beacon', severity: 'INFO', lines: 'x' } }] });
  assert.deepEqual(sem[0], { ruleId: 'peel-beacon', message: 'beacon', level: 'note', line: 2, endLine: 2, code: 'x' });
  const s = toSarif(report, { output: 'a\nfetch("https://evil.example/c")', semgrep: sem });
  assert.equal(s.version, '2.1.0');
  const results = s.runs[0].results;
  assert.ok(results.find((x) => x.ruleId === 'peel/ioc/urls').locations[0].physicalLocation.region.startLine === 2);
  assert.ok(results.every((x) => s.runs[0].tool.driver.rules[x.ruleIndex].id === x.ruleId));
}

// stil yapılandırması
{
  assert.deepEqual(fromEditorconfig('[*]\nindent_style = tab\n[*.py]\nindent_size = 8\n[*.{js,ts}]\nmax_line_length = 80'), { useTabs: true, printWidth: 80 });
  assert.deepEqual(fromEslint({ rules: { quotes: ['error', 'single'], semi: ['error', 'never'], indent: ['error', 4] } }), { tabWidth: 4, useTabs: false, singleQuote: true, semi: false });
  const st = resolveStyle({ prettierrc: 'semi: false\nsingleQuote: true', editorconfig: '[*]\nindent_size = 4' });
  assert.equal(await formatWithStyle('var a = "x"; function f() { return a; }', st), "var a = 'x'\nfunction f() {\n    return a\n}\n");
}

// neden gizlenmiş, anonimleştirme, rapor, geçmiş, changelog
{
  const why = explainWhy({ input: 'setInterval(function () { debugger; }, 4000);', report: null });
  assert.ok(why.some((x) => x.id === 'antiAnalysis'));
  const mal = explainWhy({ input: 'x', report: { threat: { classes: [{ id: 'skimmer', score: 40, evidence: ['kart'] }] } } });
  assert.equal(mal[0].id, 'malware');

  const an = anonymize('// gizli yorum\nvar u = "https://evil.ru/c?id=1", m = "bob@corp.com", ip = "8.8.8.8", k = "sk_live_abcdefghijk123";', { output: 'fetch("https://hidden.xyz/x")' });
  assert.ok(!an.code.includes('evil.ru') && !an.code.includes('bob@corp') && !an.code.includes('8.8.8.8') && !an.code.includes('sk_live') && !an.code.includes('gizli yorum'));
  assert.match(an.code, /https:\/\/example\.com\/path1/);
  assert.deepEqual(an.leaks.map((l) => l.kind), ['url', 'domain']);
  const fx = buildFixture({ code: 'a();', expect: ['a()'] });
  assert.equal(fx, '// EXPECT: a()\na();\n');
  assert.match(issueUrl({ title: 't', fixture: fx }), /^https:\/\/github\.com\/LLCForge\/Peel-JS\/issues\/new\?/);
  assert.equal(issueUrl({ title: 't', fixture: 'x'.repeat(10000) }), null);

  const html = buildReportHtml({ input: '<script>alert(1)</script>', output: 'alert(1);', name: '"x".js' });
  assert.ok(!html.includes('<script>alert') && html.includes('&lt;script&gt;') && html.includes("default-src 'none'"));

  const h = createHistory(memoryStore());
  const out1 = 'function a(x) { return x + 1; } function b() { return 2; }';
  const e1 = await h.add({ name: 'v1', source: 's', input: 'in1', output: out1 });
  assert.equal((await h.seen('in1')).exact.length, 1);
  assert.equal((await h.seen('in2', out1)).sameOutput.length, 1);
  assert.equal((await h.seen('in3', 'function q(y) { return y + 1; } function r() { return 2; } function z() {}')).similar.length, 1);
  await h.update(e1.id, { label: 'v1.0', note: 'ilk' });
  assert.equal((await h.get(e1.id)).label, 'v1.0');
  const t1 = await h.track({ source: 's', input: 'in1', output: out1 });
  assert.equal(t1.changed, false);
  const t2 = await h.track({ source: 's', input: 'in2', output: `${out1} function c() { return fetch("u"); }` });
  assert.equal(t2.changed, true);
  assert.equal(t2.diff.summary.added, 1);
  assert.equal((await h.versions('s')).length, 2);

  assert.equal(unseen(latestSeq()).length, 0);
  assert.ok(unseen(0).length >= 10);
}

// REST API: loopback, token, Host, Origin, boyut sınırı, gerçek çözme
{
  await assert.rejects(startServer({ host: '0.0.0.0', port: 0 }), /loopback/);
  const s = await startServer({ port: 0, token: 'test-token-1234567890', maxBody: 4096 });
  const call = (path, { method = 'POST', body, headers = {} } = {}) => fetch(`${s.url}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token-1234567890', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    assert.equal((await fetch(`${s.url}/health`)).status, 200);
    assert.equal((await call('/v1/deobfuscate', { body: { code: '1' }, headers: { Authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await call('/v1/deobfuscate', { body: { code: '1' }, headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call('/v1/deobfuscate', { body: { code: 'x'.repeat(10000) } })).status, 413);
    assert.equal((await call('/v1/deobfuscate', { body: { code: 1 } })).status, 400);
    assert.equal((await call('/v1/deobfuscate', { body: { code: 'a', level: 9 } })).status, 400);
    const ok = await call('/v1/deobfuscate', { body: { code: 'eval(atob("Y29uc29sZS5sb2coMSk="))', analyze: true } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    const j = await ok.json();
    assert.match(j.code, /console\.log\(1\)/);
    assert.ok(j.report.threat);
    const d = await (await call('/v1/diff', { body: { old: 'function a(){return 1}', new: 'function b(){return 1}' } })).json();
    assert.equal(d.diff.summary.equivalent, true);
  } finally {
    await s.close();
  }
}

// botlar: imza doğrulama
{
  const ts = String(Math.floor(Date.now() / 1000));
  const body = 'text=eval(1)&response_url=https%3A%2F%2Fhooks.slack.com%2Fx';
  const sig = `v0=${createHmac('sha256', 'sekret').update(`v0:${ts}:${body}`).digest('hex')}`;
  assert.equal(verifySlack({ secret: 'sekret', timestamp: ts, signature: sig, body }), true);
  assert.equal(verifySlack({ secret: 'sekret', timestamp: String(Number(ts) - 1000), signature: sig, body }), false);
  assert.equal(verifySlack({ secret: 'baska', timestamp: ts, signature: sig, body }), false);
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('hex');
  const msg = '{"type":1}';
  const dsig = Buffer.from(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, Buffer.from(ts + msg))).toString('hex');
  assert.equal(await verifyDiscord({ publicKey: pub, timestamp: ts, signature: dsig, body: msg }), true);
  assert.equal(await verifyDiscord({ publicKey: pub, timestamp: ts, signature: dsig, body: '{"type":2}' }), false);
  assert.equal(extractCode('```js\nif (a &lt; b) x();\n```'), 'if (a < b) x();\n');
}

// kütüphane API'si
{
  const r = await lib.peel('eval(atob("Y29uc29sZS5sb2coMik="))');
  assert.match(r.code, /console\.log\(2\)/);
  assert.ok(r.report.metrics);
  const n = await lib.deobfuscate('console.log(0x10);', { sandbox: false });
  assert.match(n.code, /console\.log\(16\)/);
  assert.ok(lib.passes().length === PASSES.length);
}
console.log('integrations: ok');
