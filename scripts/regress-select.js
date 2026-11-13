#!/usr/bin/env node
// E714: hash tabanlı regresyon seçimi. `--record` her fixture'ı çözüp değişiklik yapan pass'leri ve çıktının semantik
// hash'ini test/.regress.json'a yazar; argümansız çalıştırma pass kaynak özetlerini kayıtla karşılaştırıp yeniden
// çalıştırılması gereken fixture'ları listeler: `node test/run.js <ad>` ile tek tek çalıştırılabilir.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fnv1a } from '../src/util/hash.js';
import { selectRegression, semanticHash } from '../src/verify/effects.js';
import { PASSES } from '../src/core/registry.js';

const root = new URL('../', import.meta.url);
const CACHE = new URL('test/.regress.json', root);
const FILES = Object.fromEntries(readdirSync(new URL('src/passes/', root)).map((f) => [f, readFileSync(new URL(`src/passes/${f}`, root), 'utf8')]));

// pass id → kaynak dosya özeti (dosya adı registry'deki modül sırasından eşleştirilir)
export function passHashes() {
  const out = {};
  const files = Object.keys(FILES).sort();
  for (const p of PASSES) {
    const f = files.find((x) => x.replace(/^\d+-/, '').replace(/\.js$/, '') === p.id || x.includes(p.id));
    out[p.id] = f ? fnv1a(FILES[f]) : 'yok';
  }
  return out;
}

async function record() {
  const { getQuickJS } = await import('quickjs-emscripten');
  const { createHost, sandboxApi } = await import('../src/sandbox/core.js');
  const { deobfuscate } = await import('../src/core/pipeline.js');
  const host = createHost(await getQuickJS());
  const sb = sandboxApi(async (m) => host.handle(m));
  const samples = [];
  for (const f of readdirSync(new URL('test/fixtures/', root)).filter((x) => x.endsWith('.js')).sort()) {
    const src = readFileSync(new URL(`test/fixtures/${f}`, root), 'utf8').replace(/^\s*\/\/\s*(EXPECT|GONE|LEVEL|SKIP)\b:?.*$/gm, '');
    const r = await deobfuscate(src, { level: 4, sandbox: sb, deep: true });
    const run = await sb.run(`try {\n${r.code}\n} catch (e) {}`, { timeoutMs: 4000 });
    samples.push({ id: f, passes: [...new Set(r.events.filter((e) => e.state === 'ok').map((e) => e.id))], semHash: semanticHash(run.effects ?? []) });
    console.error(`kayıt: ${f}`);
  }
  writeFileSync(CACHE, JSON.stringify({ passHashes: passHashes(), samples }, null, 2));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  if (process.argv.includes('--record')) await record();
  else if (!existsSync(CACHE)) console.error('Kayıt yok: önce `node scripts/regress-select.js --record`');
  else {
    const cache = JSON.parse(readFileSync(CACHE, 'utf8'));
    const sel = selectRegression({ samples: cache.samples, previousPassHashes: cache.passHashes, currentPassHashes: passHashes() });
    console.log(`değişen pass'ler: ${sel.changedPasses.join(', ') || 'yok'} · atlanan: ${sel.skipped}`);
    for (const s of sel.selected) console.log(`${s.id}\t${s.reason}`);
  }
}
