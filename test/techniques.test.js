// Ansiklopedi örnekleri gerçekten çözülüyor mu ve tespit desenleri kendi örneğini yakalıyor mu: node test/techniques.test.js
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { deobfuscate } from '../src/core/pipeline.js';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { TECHNIQUES, detectTechniques } from '../src/integrations/techniques.js';
import { PASS_DOCS } from '../src/integrations/tutorial.js';
import { PASSES } from '../src/core/registry.js';

const host = createHost(await getQuickJS());
const sandbox = sandboxApi(async (m) => host.handle(m));

for (const tq of TECHNIQUES) {
  for (const p of tq.passes) assert.ok(PASSES.some((x) => x.id === p), `${tq.id}: bilinmeyen pass ${p}`);
  if (!tq.example) continue;
  assert.ok(detectTechniques(tq.example).some((x) => x.id === tq.id), `${tq.id}: örnek kendi deseniyle tespit edilmiyor`);
  const r = await deobfuscate(tq.example, { level: 4, sandbox, deep: true });
  assert.ok(r.code.includes(tq.expect), `${tq.id}: beklenen "${tq.expect}" yok:\n${r.code}`);
}
// her pass için eğitim açıklaması var
for (const p of PASSES) assert.ok(PASS_DOCS[p.id]?.tr && PASS_DOCS[p.id]?.en, `açıklama eksik: ${p.id}`);
console.log('techniques: ok');
