// VS Code eklentisinin VS Code'dan bağımsız çekirdeği: node test/vscode-service.test.js
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as peel from '../src/index.js';

const { createService } = createRequire(import.meta.url)('../extensions/vscode/service.js');
const s = createService(peel);

assert.deepEqual(s.options({ level: 9, sandbox: false }), { level: 4, sandbox: false, deep: true });
const a = await s.analyzeText('var _0x1 = ["aHR0cHM6Ly9ldmlsLmV4YW1wbGUvYw==", "bG9n"]; function _0x2(i) { return atob(_0x1[i]); } console[_0x2(1)](_0x2(0));', {});
assert.equal(a.result.code, 'console.log("https://evil.example/c");\n');
assert.match(s.reportMarkdown(a), /urls: `https:\/\/evil\.example\/c`/);
assert.match(s.reportMarkdown(a, 'en'), /# PEEL report/);
assert.ok(s.diagnostics(a.report, a.result.code).some((d) => d.message.includes('evil.example')));
const c = await s.compareTexts('console.log(1);', 'console.log(2, typeof localStorage);', {});
assert.equal(c.diff.summary.equivalent, false);
await assert.rejects(s.deobfuscateText('var = ;', {}), /parse edilemedi/);
console.log('vscode-service: ok');
