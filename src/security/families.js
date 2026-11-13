// E112: polimorfik varyant aileleri. Her örneğin çözülmüş çıktısından gizleme bağımsız özellikler çıkarılır
// (adlar/sayılar/string'ler soyutlanmış token şingılları → MinHash, AST düğüm tipi dizisi, IOC'ler);
// benzerlik eşiğini aşan örnekler birleşim-bul ile aynı aileye konur. Koleksiyon oturum belleğinde tutulur,
// JSON olarak dışa/içe aktarılabilir.
import { parse } from '../core/parse.js';
import { traverse } from '../util/ast.js';
import { fnv1a } from '../util/hash.js';

const PERMS = 64;
const SHINGLE = 5;
// MinHash için sabit tohumlu 32 bit karma aileleri (a*x + b mod 2^32)
const SEEDS = Array.from({ length: PERMS }, (_, i) => [(Math.imul(i + 1, 0x9e3779b1) | 1) >>> 0, Math.imul(i + 7, 0x85ebca6b) >>> 0]);

const KEYWORDS = new Set(['var', 'let', 'const', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'new', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'this', 'null', 'true', 'false',
  'undefined', 'class', 'extends', 'async', 'await', 'yield', 'delete', 'void']);
// API/global adları korunur (davranışı anlatır); yerel adlar soyutlanır
const KEEP = /^(document|window|navigator|location|fetch|XMLHttpRequest|eval|Function|atob|btoa|JSON|Math|String|Array|Object|console|localStorage|sessionStorage|setTimeout|setInterval|addEventListener|querySelector(All)?|getElementById|cookie|value|send|open|src|href|createElement|appendChild|sendBeacon|WebSocket|crypto|subtle|charCodeAt|fromCharCode|split|join|replace|push)$/;

export function normalizedTokens(code) {
  const toks = code.match(/[A-Za-z_$][\w$]*|0x[0-9a-f]+|\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[^\s\w]/gi) ?? [];
  return toks.map((x) => {
    if (/^["'`]/.test(x)) return 'S';
    if (/^(0x|\d)/i.test(x)) return 'N';
    if (/^[A-Za-z_$]/.test(x)) return KEYWORDS.has(x) || KEEP.test(x) ? x : 'I';
    return x;
  });
}

export function minhash(tokens) {
  const sig = new Array(PERMS).fill(0xffffffff);
  for (let i = 0; i + SHINGLE <= tokens.length; i++) {
    const h = parseInt(fnv1a(tokens.slice(i, i + SHINGLE).join(' ')), 16) >>> 0;
    for (let k = 0; k < PERMS; k++) {
      const v = (Math.imul(SEEDS[k][0], h) + SEEDS[k][1]) >>> 0;
      if (v < sig[k]) sig[k] = v;
    }
  }
  return sig;
}

export const similarity = (a, b) => a.reduce((n, v, i) => n + (v === b[i] ? 1 : 0), 0) / PERMS;

function astShape(code) {
  try {
    const types = [];
    traverse(parse(code), { enter(p) { if (types.length < 20000) types.push(p.node.type); } });
    return fnv1a(types.join(','));
  } catch { return null; }
}

/** Örnek özellikleri (rapor + çıktıdan) */
export function sampleFeatures({ label, output, iocs = {}, fingerprint = [] }) {
  return {
    id: fnv1a(`${label}|${output.length}|${fnv1a(output)}`),
    label,
    added: new Date().toISOString(),
    outputHash: fnv1a(output),
    shape: astShape(output),
    sig: minhash(normalizedTokens(output)),
    iocs: [...new Set([...(iocs.domains ?? []), ...(iocs.urls ?? []), ...(iocs.ips ?? []), ...(iocs.wallets ?? [])])].slice(0, 100),
    tools: fingerprint.map((f) => f.name),
  };
}

/** Benzerlik eşiğiyle ailelere ayırır; aynı AST şekli ya da ortak IOC + orta benzerlik de birleştirir */
export function clusterFamilies(samples, threshold = 0.6) {
  const parent = samples.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const pairs = [];
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const a = samples[i];
      const b = samples[j];
      const s = similarity(a.sig, b.sig);
      const sharedIoc = a.iocs.some((x) => b.iocs.includes(x));
      const sameShape = a.shape && a.shape === b.shape;
      if (s >= threshold || sameShape || (sharedIoc && s >= threshold / 2)) {
        parent[find(i)] = find(j);
        pairs.push({ a: a.label, b: b.label, similarity: Number(s.toFixed(2)), sameShape: Boolean(sameShape), sharedIoc });
      }
    }
  }
  const groups = new Map();
  samples.forEach((s, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(s);
  });
  return [...groups.values()].map((members, k) => {
    const shared = members.length > 1 ? members[0].iocs.filter((x) => members.every((m) => m.iocs.includes(x))) : [];
    return {
      family: `F${k + 1}`,
      size: members.length,
      members: members.map((m) => ({ label: m.label, outputHash: m.outputHash, tools: m.tools })),
      sharedIocs: shared.slice(0, 30),
      polymorphic: members.length > 1 && new Set(members.map((m) => m.outputHash)).size > 1,
    };
  }).sort((a, b) => b.size - a.size).map((f) => ({ ...f, links: pairs.filter((p) => f.members.some((m) => m.label === p.a)) }));
}

// Oturum koleksiyonu
export function createCollection(initial = []) {
  const samples = [...initial];
  return {
    add(s) { if (!samples.some((x) => x.id === s.id)) samples.push(s); return samples.length; },
    remove(id) { const i = samples.findIndex((x) => x.id === id); if (i >= 0) samples.splice(i, 1); },
    clear() { samples.length = 0; },
    list: () => [...samples],
    families: (threshold) => clusterFamilies(samples, threshold),
    export: () => JSON.stringify({ peel: 'families', version: 1, samples }, null, 2),
    import(json) {
      const data = JSON.parse(json);
      if (data?.peel !== 'families' || !Array.isArray(data.samples)) throw new Error('PEEL aile dosyası değil');
      let n = 0;
      for (const s of data.samples) {
        if (typeof s?.label !== 'string' || !Array.isArray(s.sig) || s.sig.length !== PERMS || !Array.isArray(s.iocs)) continue;
        const before = samples.length;
        this.add({ id: String(s.id), label: s.label.slice(0, 200), added: String(s.added ?? ''), outputHash: String(s.outputHash ?? ''),
          shape: s.shape ? String(s.shape) : null, sig: s.sig.map((x) => Number(x) >>> 0), iocs: s.iocs.map(String).slice(0, 100),
          tools: Array.isArray(s.tools) ? s.tools.map(String) : [] });
        if (samples.length > before) n++;
      }
      return n;
    },
  };
}
