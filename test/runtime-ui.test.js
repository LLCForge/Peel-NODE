// Gerçek DOM modu, arayüz veri modelleri ve analiz entegrasyonu: node test/runtime-ui.test.js
// C61/C62/C65/I177 (görünüm modelleri), analyze → dynamic/verification
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { buildRealDomDoc, sanitizeResult, runRealDom, CSP } from '../src/sandbox/realdom.js';
import { lineModel } from '../src/ui/runtime/coverage.js';
import { layout } from '../src/ui/runtime/callgraph.js';
import { deobfuscate } from '../src/core/pipeline.js';
import { analyze } from '../src/core/analyze.js';

// C65: belge yapısı — iki katmanlı sandbox, CSP ağı ve yönlendirmeyi kapatır, kod </script> ile kaçamaz
const doc = buildRealDomDoc('console.log("</script><script>alert(1)</script>")', { token: 'peel-test-token-1' });
assert.ok(doc.includes(CSP.replace(/'/g, "'")) && /default-src 'none'/.test(CSP) && /frame-src 'none'/.test(CSP) && /form-action 'none'/.test(CSP));
assert.ok(!/connect-src|https?:/.test(CSP), 'CSP hiçbir ağ kaynağına izin vermez');
assert.equal((doc.match(/<\/script>/g) ?? []).length, 1, 'yalnızca dış betik kapanır; iç belge ve kod kaçışlı');
assert.ok(doc.includes('f.setAttribute("sandbox", "allow-scripts")') && !doc.includes('allow-same-origin'));
assert.throws(() => buildRealDomDoc('1', { token: '"><x' }), /belirteç/);
const clean = sanitizeResult({ console: ['a'.repeat(5000)], blocked: [{ directive: 'connect-src', uri: 'https://x' }], listeners: { click: 2 }, dom: 1 });
assert.equal(clean.console[0].length, 2000);
assert.equal(clean.dom, '1');
assert.deepEqual(sanitizeResult(null).console, []);
await assert.rejects(runRealDom('1', {}), /onay/);
await assert.rejects(runRealDom('1', { consent: 'evet' }), /onay/);

// C62/I177/C63: satır modeli
const lines = lineModel('a();\nb("x");\nc();', { lines: [[1, 2], [2, 0]] }, [{ line: 2, endLine: 2, column: 2, endColumn: 5, pass: 'string-array' }], [{ source: 'çıktı', line: 3, kind: 'debugger' }]);
assert.deepEqual(lines.map((l) => l.hits), [2, 0, null]);
assert.equal(lines[1].observed[0].pass, 'string-array');
assert.equal(lines[2].trap, 'debugger');

// C61: çağrı grafiği yerleşimi
const lay = layout({ nodes: [{ id: 0, name: 'main', calls: 1 }, { id: 1, name: 'leaf', calls: 3 }], edges: [{ from: -1, to: 0, count: 1 }, { from: 0, to: 1, count: 3 }] });
assert.ok(lay.pos.get(1).x > lay.pos.get(0).x && lay.pos.get(0).x > lay.pos.get(-1).x);

// analiz entegrasyonu: rapora dinamik ve doğrulama bölümleri eklenir; JSON'a kaynak kod girmez
const host = createHost(await getQuickJS());
const sb = sandboxApi(async (m) => host.handle(m));
const input = 'var _0x1 = ["\\x6f\\x6b"]; function go() { console.log(_0x1[0]); fetch("/x?c=" + document.cookie); } go();';
const res = await deobfuscate(input, { level: 4, sandbox: sb, deep: true });
const rep = await analyze({ input, text: res.text, output: res.code, events: res.events, sandbox: sb });
assert.ok(rep.dynamic.coverage.ok && rep.dynamic.capture.ok);
assert.equal(rep.verification.level, 'effects');
assert.ok(rep.verification.trust.score > 0 && rep.verification.success.score >= 0);
assert.ok(rep.verification.verification.checks.effects.equal);
assert.ok(!JSON.stringify(rep).includes('"code":{"text"'));
const noSb = await analyze({ input, text: res.text, output: res.code, events: res.events, sandbox: null });
assert.equal(noSb.dynamic.capture.ok, false);
assert.equal(noSb.verification.verification, null);
console.log('runtime-ui: ok');
