import { fnv1a } from '../util/hash.js';
import { extractFunctions, semanticDiff } from './compare.js';
import { detectTechniques } from './techniques.js';

// Çözüm geçmişi (G146), "bunu daha önce gördün" uyarısı (G144), script izleme (G143) ve
// sürüm etiketi/not (G155). Depolama değiştirilebilir: bellek (test), dosya (Node, history-node.js),
// IndexedDB (tarayıcı, ui/integrations/history-store.js). Hiçbiri ağa bir şey göndermez.

export const MAX_ENTRIES = 300;
export const MAX_STORED_CODE = 512 * 1024; // daha büyük girdi/çıktı yalnızca özetleriyle saklanır
const MAX_FN_HASHES = 4000;
const SIMILAR_MIN = 0.5;
const MAX_TEXT = 2000;

export function memoryStore(initial = []) {
  let data = structuredClone(initial);
  return {
    async load() { return structuredClone(data); },
    async save(entries) { data = structuredClone(entries); },
  };
}

function fnHashes(code) {
  try {
    return [...new Set(extractFunctions(code).fns.slice(1).map((f) => f.hash))].slice(0, MAX_FN_HASHES);
  } catch {
    return [];
  }
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  let inter = 0;
  for (const x of new Set(b)) if (sa.has(x)) inter++;
  return inter / (sa.size + new Set(b).size - inter);
}

const clip = (s, n = MAX_TEXT) => (typeof s === 'string' ? s.slice(0, n) : '');
const newId = (time, inputHash) => `${time.toString(36)}-${inputHash}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * @param {{load(): Promise<object[]>, save(entries: object[]): Promise<void>}} store
 */
export function createHistory(store) {
  let cache = null;
  const all = async () => (cache ??= (await store.load()) ?? []);
  const persist = async () => store.save(cache);

  function makeEntry({ name = '', source = '', input, output = '', label = '', note = '', stats = null, now = Date.now() }) {
    if (typeof input !== 'string') throw new TypeError('input string olmalı');
    const inputHash = fnv1a(input);
    return {
      id: newId(now, inputHash),
      time: now,
      name: clip(name, 200),
      source: clip(source, 2000),
      label: clip(label, 100),
      note: clip(note),
      inputHash,
      outputHash: output ? fnv1a(output) : null,
      inputSize: input.length,
      outputSize: output.length,
      fnHashes: output ? fnHashes(output) : [],
      techniques: detectTechniques(input).map((x) => x.id),
      stats,
      input: input.length <= MAX_STORED_CODE ? input : null,
      output: output && output.length <= MAX_STORED_CODE ? output : null,
    };
  }

  return {
    async list() {
      // listede ağır alanlar olmadan
      return (await all()).map(({ input, output, fnHashes: _f, ...meta }) => ({ ...meta, hasCode: input !== null }));
    },
    async get(id) { return (await all()).find((e) => e.id === id) ?? null; },

    async add(o) {
      const entry = makeEntry(o);
      const list = await all();
      list.push(entry);
      if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
      await persist();
      return entry;
    },

    // G155: sürüm etiketi ve not
    async update(id, { label, note }) {
      const e = (await all()).find((x) => x.id === id);
      if (!e) return null;
      if (label !== undefined) e.label = clip(String(label), 100);
      if (note !== undefined) e.note = clip(String(note));
      await persist();
      return e;
    },

    async remove(id) {
      const list = await all();
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) return false;
      list.splice(i, 1);
      await persist();
      return true;
    },

    async clear() {
      cache = [];
      await persist();
    },

    /**
     * G144: aynı girdi, aynı çıktı ya da yapısal olarak benzer bir çözüm daha önce görüldü mü?
     * @returns {Promise<{exact: object[], sameOutput: object[], similar: Array<{entry: object, score: number}>}>}
     */
    async seen(input, output = '') {
      const list = await all();
      const ih = fnv1a(input);
      const oh = output ? fnv1a(output) : null;
      const fh = output ? fnHashes(output) : [];
      const meta = ({ input: _i, output: _o, fnHashes: _f, ...m }) => m;
      const exact = list.filter((e) => e.inputHash === ih).map(meta);
      const sameOutput = oh ? list.filter((e) => e.outputHash === oh && e.inputHash !== ih).map(meta) : [];
      const similar = fh.length
        ? list.filter((e) => e.inputHash !== ih && e.outputHash !== oh)
          .map((e) => ({ entry: meta(e), score: Number(jaccard(fh, e.fnHashes).toFixed(3)) }))
          .filter((x) => x.score >= SIMILAR_MIN)
          .sort((a, b) => b.score - a.score)
          .slice(0, 10)
        : [];
      return { exact, sameOutput, similar };
    },

    async versions(source) {
      return (await all()).filter((e) => e.source === source).sort((a, b) => a.time - b.time);
    },

    /**
     * G143: bir kaynağın (dosya yolu / URL) yeni sürümünü kaydeder. Girdi değişmediyse kayıt eklenmez.
     * Değiştiyse önceki sürümün çıktısıyla semantik diff döndürür.
     */
    async track({ source, name = '', input, output, label = '', note = '', stats = null, now }) {
      const prev = (await this.versions(source)).at(-1) ?? null;
      if (prev && prev.inputHash === fnv1a(input)) return { changed: false, entry: prev, previous: prev, diff: null };
      const entry = await this.add({ name: name || source, source, input, output, label, note, stats, now });
      let diff = null;
      if (prev?.output && output) {
        try {
          diff = semanticDiff(prev.output, output, { oldInput: prev.input ?? '', newInput: input });
        } catch {
          diff = null; // bir taraf parse edilemiyorsa yalnızca özet değişikliği bildirilir
        }
      }
      return { changed: true, entry, previous: prev, diff };
    },
  };
}
