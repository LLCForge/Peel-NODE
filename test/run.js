import { readdirSync, readFileSync } from 'node:fs';
import { getQuickJS } from 'quickjs-emscripten';
import { deobfuscate } from '../src/core/pipeline.js';
import { parse } from '../src/core/parse.js';
import { createHost, sandboxApi } from '../src/sandbox/core.js';

// Tarayıcıdaki worker yerine aynı host'u süreç içinde kullan
const host = createHost(await getQuickJS());
const sandbox = sandboxApi(async (msg) => host.handle(msg));

const dir = new URL('./fixtures/', import.meta.url);
const only = process.argv[2];
const DIRECTIVE = /^\s*\/\/\s*(EXPECT|GONE|LEVEL|SKIP)\b:?\s*(.*)$/gm;

const timings = [];
const passStats = new Map();
let fail = 0;
let total = 0;

for (const f of readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
  if (only && !f.includes(only)) continue;
  total++;
  if (process.env.PEEL_TRACE_FIXTURE) process.stderr.write(`>> ${f}
`);
  const raw = readFileSync(new URL(f, dir), 'utf8');
  const directives = [...raw.matchAll(DIRECTIVE)].map((m) => [m[1], m[2].trim()]);
  // Beklenti satırları girdinin parçası değil: çıktıda yorum olarak kalıp GONE kontrolünü yanıltmasınlar
  const src = raw.replace(DIRECTIVE, '');
  const expect = directives.filter(([k]) => k === 'EXPECT').map(([, v]) => v);
  const gone = directives.filter(([k]) => k === 'GONE').map(([, v]) => v);
  const level = Number(directives.find(([k]) => k === 'LEVEL')?.[1] ?? 4);
  const soft = directives.some(([k]) => k === 'SKIP');

  const errs = [];
  const logs = [];
  const t0 = performance.now();
  let out = '';
  try {
    const r = await deobfuscate(src, {
      level,
      sandbox,
      // testte her pass davranış karşılaştırmasından geçer: sessiz bozulma FAIL olarak görünür
      deep: true,
      onLog: (m, lv) => logs.push(`[${lv}] ${m}`),
      onPass: (id, state) => {
        if (state === 'run') return;
        const s = passStats.get(id) ?? { ok: 0, fail: 0, skip: 0 };
        s[state]++;
        passStats.set(id, s);
      },
    });
    if (r.error) errs.push(`parse hatası: ${r.error}`);
    out = r.code;
  } catch (e) {
    errs.push(`çalışma hatası: ${e.stack}`);
  }
  const ms = performance.now() - t0;
  timings.push({ f, ms });

  if (out) {
    try { parse(out); } catch (e) { errs.push(`çıktı parse edilemiyor: ${e.message}`); }
    for (const s of expect) if (!out.includes(s)) errs.push(`beklenen yok: ${s}`);
    for (const s of gone) if (out.includes(s)) errs.push(`kalıntı: ${s}`);
  }
  for (const l of logs) if (l.includes('geri alındı') || l.includes('davranış değişti')) errs.push(l);

  const tag = errs.length ? (soft ? 'soft' : 'FAIL') : 'ok  ';
  if (errs.length && !soft) fail++;
  console.log(`${tag} ${f} (${ms.toFixed(0)}ms)`);
  if (errs.length || only) {
    for (const e of errs) console.log(`     ${e}`);
    if (only) console.log(`--- log ---\n${logs.join('\n')}\n--- çıktı ---\n${out}`);
  }
}

console.log('\n— pass etkinliği (ok / fail / skip) —');
for (const [id, s] of [...passStats].sort()) {
  console.log(`  ${id.padEnd(14)} ${String(s.ok).padStart(3)} ${String(s.fail).padStart(3)} ${String(s.skip).padStart(4)}`);
}
console.log('\n— en yavaş 5 —');
for (const x of [...timings].sort((a, b) => b.ms - a.ms).slice(0, 5)) {
  console.log(`  ${x.ms.toFixed(0).padStart(6)}ms  ${x.f}`);
}
const totalMs = timings.reduce((a, x) => a + x.ms, 0);
console.log(`\ntoplam ${totalMs.toFixed(0)}ms | ${total - fail}/${total}`);
process.exit(fail ? 1 : 0);
