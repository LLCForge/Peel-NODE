import { semanticHash } from './effects.js';
import { sha256 } from './proof.js';

// E709: çalıştırma determinizmi — aynı yapılandırmayla k çalıştırma aynı davranışı vermeli; ayrıca zaman ve tohum
// değiştirilince davranış değişiyorsa program ortama bağımlıdır (rapora not düşülür).
// I186: deobfuscation determinizmi ve yeniden üretilebilir çıktı özeti (SHA-256). E710: idempotans.

const wrap = (c) => `try {\n${c}\n} catch (e) { __res.push({ __thrown: String(e) }); }`;

async function hashOf(sandbox, code, config) {
  const r = await sandbox.run(wrap(code), { timeoutMs: 4000, config });
  const thrown = (r.res ?? []).filter((x) => x && x.__thrown).map((x) => x.__thrown);
  return { hash: semanticHash(r.effects ?? [], thrown), lines: (r.out ?? []).length, timedOut: Boolean(r.timedOut) };
}

export async function executionDeterminism(sandbox, code, { config = {}, runs = 3, budget = null } = {}) {
  const hashes = [];
  for (let i = 0; i < runs; i++) {
    hashes.push((await hashOf(sandbox, code, config)).hash);
    budget?.charge?.({ runs: 1 });
  }
  const deterministic = hashes.every((h) => h === hashes[0]);
  const base = hashes[0];
  // ortam duyarlılığı: yalnızca zaman, yalnızca tohum değişince
  const timeHash = (await hashOf(sandbox, code, { ...config, now: (config.now ?? 1700000000000) + 86_400_000 * 400 })).hash;
  const seedHash = (await hashOf(sandbox, code, { ...config, seed: ((config.seed ?? 12345) * 7 + 1) & 0x7fffffff })).hash;
  budget?.charge?.({ runs: 2 });
  return {
    deterministic,
    runs,
    hash: base,
    hashes,
    dependsOnTime: timeHash !== base,
    dependsOnRandom: seedHash !== base,
  };
}

// I186: aynı girdi ve seçenekle iki deobfuscation aynı çıktıyı (SHA-256) üretmeli
export async function pipelineDeterminism(deobfuscate, input, opts = {}, runs = 2) {
  const hashes = [];
  for (let i = 0; i < runs; i++) {
    const r = await deobfuscate(input, { ...opts, onLog: () => {}, onPass: () => {}, onSnapshot: () => {}, onProgress: () => {} });
    hashes.push(await sha256(r.code));
  }
  return { reproducible: hashes.every((h) => h === hashes[0]), sha256: hashes[0], hashes };
}

// E710: idempotans — çıktıyı yeniden çözmek değiştirmemeli; değişiyorsa kalan dönüşüm fırsatı ya da kararsız pass var
export async function idempotence(deobfuscate, output, opts = {}) {
  const r = await deobfuscate(output, { ...opts, onLog: () => {}, onPass: () => {}, onSnapshot: () => {}, onProgress: () => {} });
  const [a, b] = [await sha256(output), await sha256(r.code)];
  const passes = [...new Set((r.events ?? []).filter((e) => e.state === 'ok').map((e) => e.id))];
  const la = output.split('\n');
  const lb = r.code.split('\n');
  let changedLines = 0;
  for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) changedLines++;
  return { idempotent: a === b, before: a, after: b, changedLines, passes };
}
