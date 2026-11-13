import { applyNameMap } from '../naming/names.js';

// H164: .peel proje biçimi. Bir analiz oturumunu tek JSON dosyasında taşır: dosyalar (girdi/çıktı),
// seçenekler, kullanıcı yeniden adlandırmaları, dönüşüm kuralları, sürüm etiketleri ve notlar.
// Okuma katı doğrulamalıdır: bilinmeyen alanlar atılır, tipler ve boyutlar denetlenir.

export const FORMAT = 'peel-project';
export const VERSION = 1;
const MAX_FILES = 500;
const MAX_CODE = 32 * 1024 * 1024;
const MAX_TEXT = 100_000;
const IDENT = /^[A-Za-z_$][\w$]*$/;

const str = (v, max, field) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new Error(`.peel: ${field} string olmalı`);
  if (v.length > max) throw new Error(`.peel: ${field} çok uzun`);
  return v;
};

function renamesOf(v, field) {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`.peel: ${field} nesne olmalı`);
  const out = {};
  for (const [a, b] of Object.entries(v)) {
    if (!IDENT.test(a) || typeof b !== 'string' || !IDENT.test(b)) throw new Error(`.peel: ${field} içinde geçersiz ad: ${a}`);
    out[a] = b;
  }
  return out;
}

function optionsOf(v) {
  const o = v && typeof v === 'object' ? v : {};
  const level = Number(o.level ?? 4);
  if (![1, 2, 3, 4].includes(level)) throw new Error('.peel: options.level 1-4 olmalı');
  return {
    level,
    sandbox: o.sandbox !== false,
    deep: o.deep !== false,
    only: Array.isArray(o.only) ? o.only.filter((x) => typeof x === 'string').slice(0, 100) : null,
  };
}

export function createProject({ name = 'PEEL projesi', files = [], options = {}, rules = '', notes = '' } = {}) {
  const now = new Date().toISOString();
  return validateProject({ format: FORMAT, version: VERSION, name, created: now, updated: now, options, rules, notes, files });
}

export function validateProject(p) {
  if (!p || typeof p !== 'object' || p.format !== FORMAT) throw new Error('.peel dosyası değil');
  if (p.version !== VERSION) throw new Error(`.peel sürümü desteklenmiyor: ${p.version}`);
  if (!Array.isArray(p.files) || p.files.length > MAX_FILES) throw new Error('.peel: files dizi olmalı');
  return {
    format: FORMAT,
    version: VERSION,
    name: str(p.name, 200, 'name') || 'PEEL projesi',
    created: str(p.created, 40, 'created'),
    updated: str(p.updated, 40, 'updated'),
    options: optionsOf(p.options),
    rules: str(p.rules, MAX_TEXT, 'rules'),
    notes: str(p.notes, MAX_TEXT, 'notes'),
    files: p.files.map((f, i) => {
      if (!f || typeof f !== 'object') throw new Error(`.peel: files[${i}] nesne olmalı`);
      const name = str(f.name, 500, `files[${i}].name`);
      if (!name) throw new Error(`.peel: files[${i}].name boş`);
      return {
        name,
        input: str(f.input, MAX_CODE, `files[${i}].input`),
        output: str(f.output, MAX_CODE, `files[${i}].output`),
        label: str(f.label, 100, `files[${i}].label`),
        note: str(f.note, MAX_TEXT, `files[${i}].note`),
        renames: renamesOf(f.renames, `files[${i}].renames`),
      };
    }),
  };
}

export const parseProject = (text) => {
  if (typeof text !== 'string' || text.length > MAX_CODE * 4) throw new Error('.peel dosyası çok büyük');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('.peel dosyası JSON değil'); }
  return validateProject(data);
};

export const serializeProject = (p) => `${JSON.stringify({ ...validateProject(p), updated: new Date().toISOString() }, null, 2)}\n`;

/** Projeye dosya ekler ya da aynı adlı dosyayı günceller. */
export function upsertFile(p, file) {
  const files = p.files.filter((f) => f.name !== file.name);
  const prev = p.files.find((f) => f.name === file.name);
  files.push({ ...prev, ...file, renames: { ...(prev?.renames ?? {}), ...(file.renames ?? {}) } });
  return validateProject({ ...p, files });
}

/**
 * Kullanıcı yeniden adlandırmalarını koda uygular. Tek uygulama: anlamlandırma modülünün scope-güvenli
 * yeniden adlandırıcısı (with/eval/window.x kapsamları korunur, çakışan hedef ad atlanır).
 * @returns {Promise<{code: string, applied: number, skipped: string[]}>}
 */
export async function applyRenames(code, renames) {
  const map = renamesOf(renames, 'renames');
  if (!Object.keys(map).length) return { code, applied: 0, skipped: [] };
  const r = await applyNameMap(code, map);
  return { code: r.code, applied: r.renamed.length, skipped: [...new Set(r.skipped.map((x) => x.name))] };
}
