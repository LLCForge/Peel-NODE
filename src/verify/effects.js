import { fnv1a } from '../util/hash.js';

// Etki tabanlı doğrulama: dışarıdan gözlenebilir etkiler (E706), davranış parmak izi (E711), semantik hash (E712),
// denklik sınıfı kümeleme (E713), hash tabanlı regresyon seçimi (E714), etki farkı motoru (E743/E715), iz denkliği (E708).

// Programın dış dünyaya bıraktığı izler. Okumalar, analiz kancaları, üretilen kod (eval'in açılması deobfuscation'ın
// amacıdır) ve zamanlayıcı kaydı (debug protection setInterval'ı kaldırılır) gözlenebilir sayılmaz.
const OBSERVABLE = new Set(['console', 'net', 'storage.write', 'storage.remove', 'storage.clear', 'cookie.write', 'write',
  'dom', 'dialog', 'history', 'navigate', 'worker', 'worker.post', 'worker.reply', 'blob', 'listener', 'crypto',
  'fingerprint', 'wasm', 'wasm.call']);

export const observable = (effects = []) => effects.filter((e) => OBSERVABLE.has(e.kind));
const key = (e) => `${e.kind}|${e.target}|${e.detail}`;

// E711: etki vektörü — tür başına sayım, sıralı iz özeti, (tür, hedef) kümesi
export function effectVector(effects = [], thrown = []) {
  const obs = observable(effects);
  const counts = {};
  for (const e of obs) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return {
    counts,
    total: obs.length,
    targets: [...new Set(obs.map((e) => `${e.kind}:${e.target}`))].sort(),
    traceHash: fnv1a(obs.map(key).join('\n')),
    thrown: thrown.length > 0,
  };
}

// E712: semantik hash — kodun biçiminden bağımsız, yalnızca gözlenen davranıştan
export function semanticHash(effects = [], thrown = []) {
  return fnv1a(`${observable(effects).map(key).join('\n')}\n#thrown:${thrown.map((x) => String(x).replace(/\d+/g, 'N')).join('|')}`);
}

const multiset = (effects) => {
  const m = new Map();
  for (const e of observable(effects)) m.set(key(e), (m.get(key(e)) ?? 0) + 1);
  return m;
};

export function similarity(a, b) {
  const ma = multiset(a);
  const mb = multiset(b);
  let inter = 0;
  let union = 0;
  for (const k of new Set([...ma.keys(), ...mb.keys()])) {
    inter += Math.min(ma.get(k) ?? 0, mb.get(k) ?? 0);
    union += Math.max(ma.get(k) ?? 0, mb.get(k) ?? 0);
  }
  return union ? inter / union : 1;
}

// E713: önce semantik hash'e göre kesin sınıflar, sonra Jaccard benzerliği eşiği aşan sınıflar birleştirilir
export function cluster(items, { threshold = 0.9 } = {}) {
  const classes = new Map();
  for (const it of items) {
    const h = semanticHash(it.effects, it.thrown ?? []);
    if (!classes.has(h)) classes.set(h, { hash: h, members: [], effects: it.effects });
    classes.get(h).members.push(it.id);
  }
  const list = [...classes.values()];
  const parent = list.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (similarity(list[i].effects, list[j].effects) >= threshold) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  list.forEach((c, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, { representative: c.members[0], hashes: [], members: [] });
    const g = groups.get(r);
    g.hashes.push(c.hash);
    g.members.push(...c.members);
  });
  return [...groups.values()].sort((a, b) => b.members.length - a.members.length);
}

// E714: hash tabanlı regresyon seçimi — kaynağı değişen pass'lere dokunan örnekler + her semantik sınıftan bir temsilci
export function selectRegression({ samples, previousPassHashes = {}, currentPassHashes = {} }) {
  const changed = new Set(Object.keys(currentPassHashes).filter((id) => previousPassHashes[id] !== currentPassHashes[id]));
  const picked = new Map();
  for (const s of samples) {
    if (!s.semHash) picked.set(s.id, 'yeni örnek (kayıtlı semantik hash yok)');
    else if ((s.passes ?? []).some((p) => changed.has(p))) picked.set(s.id, `değişen pass: ${s.passes.filter((p) => changed.has(p)).join(', ')}`);
  }
  // değişmemiş pass'lerin sınıflarından birer temsilci: kesişen etkileri yakalamak için ucuz örneklem
  const byClass = new Map();
  for (const s of samples) if (s.semHash && !byClass.has(s.semHash)) byClass.set(s.semHash, s.id);
  for (const id of byClass.values()) if (!picked.has(id)) picked.set(id, 'sınıf temsilcisi');
  return { changedPasses: [...changed], selected: [...picked].map(([id, reason]) => ({ id, reason })), skipped: samples.length - picked.size };
}

// E743: etki farkı motoru — LCS hizalaması; aynı tür+hedefte ardışık sil/ekle "değişti" olarak birleştirilir
export function diffEffects(a = [], b = [], { max = 1500 } = {}) {
  const A = observable(a).slice(0, max);
  const B = observable(b).slice(0, max);
  const n = A.length;
  const m = B.length;
  const ka = A.map(key);
  const kb = B.map(key);
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ka[i] === kb[j]) { ops.push({ op: 'same', a: A[i++], b: B[j++] }); continue; }
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) ops.push({ op: 'add', b: B[j++] });
    else ops.push({ op: 'del', a: A[i++] });
  }
  const merged = [];
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k];
    const nx = ops[k + 1];
    const pair = o.op === 'del' && nx?.op === 'add' ? [o.a, nx.b] : o.op === 'add' && nx?.op === 'del' ? [nx.a, o.b] : null;
    if (pair && pair[0].kind === pair[1].kind && pair[0].target === pair[1].target) {
      merged.push({ op: 'change', a: pair[0], b: pair[1] });
      k++;
    } else merged.push(o);
  }
  const summary = { same: 0, add: 0, del: 0, change: 0 };
  for (const o of merged) summary[o.op]++;
  return { equal: summary.add + summary.del + summary.change === 0, summary, ops: merged.filter((o) => o.op !== 'same').slice(0, 300), truncated: A.length === max || B.length === max };
}

// E708: iz denkliği — gözlenebilir etki dizileri (isteğe bağlı türler dışarıda) birebir aynı mı
export function traceEquivalent(a = [], b = [], { ignore = [] } = {}) {
  const skip = new Set(ignore);
  const A = observable(a).filter((e) => !skip.has(e.kind));
  const B = observable(b).filter((e) => !skip.has(e.kind));
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i++) {
    if (!A[i] || !B[i] || key(A[i]) !== key(B[i])) return { equivalent: false, index: i, a: A[i] ?? null, b: B[i] ?? null };
  }
  return { equivalent: true, length: A.length };
}

// E715: iki programı aynı ortamda çalıştırıp etki farkını çıkarır
export async function effectDiff(sandbox, codeA, codeB, { config = {}, post = null } = {}) {
  const wrap = (c) => `try {\n${c}\n} catch (e) { __res.push({ __thrown: String(e) }); }`;
  const [ra, rb] = [await sandbox.run(wrap(codeA), { timeoutMs: 6000, config, post }), await sandbox.run(wrap(codeB), { timeoutMs: 6000, config, post })];
  const thrown = (r) => (r.res ?? []).filter((x) => x && x.__thrown).map((x) => x.__thrown);
  return {
    a: { ok: ra.ok, error: ra.error ?? null, hash: semanticHash(ra.effects, thrown(ra)), vector: effectVector(ra.effects, thrown(ra)) },
    b: { ok: rb.ok, error: rb.error ?? null, hash: semanticHash(rb.effects, thrown(rb)), vector: effectVector(rb.effects, thrown(rb)) },
    diff: diffEffects(ra.effects, rb.effects),
    trace: traceEquivalent(ra.effects, rb.effects),
    effectsA: ra.effects ?? [],
    effectsB: rb.effects ?? [],
  };
}
