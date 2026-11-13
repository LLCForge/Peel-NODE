// CTF görevleri gerçekten çözülebilir mi ve kendi kodunu test etme akışı çalışıyor mu: node test/ctf.test.js
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { deobfuscate } from '../src/core/pipeline.js';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { CHALLENGES, buildChallenge, checkFlag } from '../src/integrations/ctf.js';
import { testOwnCode } from '../src/integrations/obfuscate.js';
import { resilienceScore } from '../src/integrations/resilience.js';

const host = createHost(await getQuickJS());
const sandbox = sandboxApi(async (m) => host.handle(m));

const FLAGS = { isinma: 'PEEL{str1ng_4rr4y_g0n3}', parcalar: 'PEEL{r0t4t3d_b64}', akis: 'PEEL{fl4tt3n3d_fl0w}', xor: 'PEEL{x0r_by_h4nd}', maks: 'PEEL{m4x_pr3s3t_d0wn}' };

for (const c of CHALLENGES) {
  const code = await buildChallenge(c.id);
  assert.equal(code, await buildChallenge(c.id), `${c.id}: seed deterministik değil`);
  for (const r of c.reveal) assert.ok(!code.includes(r), `${c.id}: ipucu gizlenmemiş: ${r}`);
  const res = await deobfuscate(code, { level: 4, sandbox, deep: true });
  for (const r of c.reveal) assert.ok(res.code.includes(r), `${c.id}: PEEL çıktısında "${r}" yok:\n${res.code.slice(0, 3000)}`);
  assert.equal(await checkFlag(c.id, FLAGS[c.id]), true, `${c.id}: bayrak özeti`);
  assert.equal(await checkFlag(c.id, 'PEEL{yanlis}'), false);
}

// J194/J195: kendi kodu, düşük ön ayarda büyük ölçüde geri gelmeli
const own = `function greet(n) { return "Merhaba, " + n; }\nconsole.log(greet("PEEL"), [1, 2, 3].map(function (x) { return x * 2; }).join(","));`;
const r = await testOwnCode(own, 'low', { deobfuscate, sandbox, seed: 7 });
assert.equal(r.behaviour.same, true, 'davranış aynı kalmalı');
assert.ok(r.resilience.score <= 40, `düşük ön ayar skoru yüksek: ${r.resilience.score}`);
assert.equal(resilienceScore({ original: own, deobfuscated: own }).score, 0);
console.log('ctf: ok');
