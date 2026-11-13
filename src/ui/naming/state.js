import { fnv1a } from '../../util/hash.js';
import { parseNameMap } from '../../naming/names.js';
import { getLang } from '../../i18n.js';

// Kullanıcıya özel kolaylıklar tarayıcıda saklanır: seçenekler, ad sözlüğü (E231), dosya başına ad haritası (87),
// biçim profili (E239). Depolama kapalıysa bellekte çalışır.

const KEY_OPTIONS = 'peel.naming.options';
const KEY_DICT = 'peel.naming.dict';
const KEY_FORMAT = 'peel.naming.format';
const mapKey = (input) => `peel.naming.map.${fnv1a(input)}`;
const memory = new Map();
const MAX_SNAPSHOTS = 120;

function read(key) {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) return v;
  } catch { /* depolama kapalı */ }
  return memory.get(key) ?? null;
}
function write(key, value) {
  memory.set(key, value);
  try { localStorage.setItem(key, value); } catch { /* depolama kapalı ya da dolu */ }
}

const parseNames = (text) => {
  const r = parseNameMap(text ?? '{}');
  return r.ok ? r.names : {};
};

export function getOptions() {
  try { return { ...JSON.parse(read(KEY_OPTIONS) ?? '{}') }; } catch { return {}; }
}
export function setOption(key, value) {
  const o = getOptions();
  o[key] = Boolean(value);
  write(KEY_OPTIONS, JSON.stringify(o));
}

export const getDict = () => parseNames(read(KEY_DICT));
export const setDict = (names) => write(KEY_DICT, JSON.stringify(names));

export const getMap = (input) => parseNames(read(mapKey(input)));
export const setMap = (input, names) => write(mapKey(input), JSON.stringify(names));

export const getFormat = () => read(KEY_FORMAT) ?? 'default';
export const setFormat = (p) => write(KEY_FORMAT, p);

/** Pipeline seçenekleri: geçiş anahtarları + önce sözlük sonra dosya haritası */
export function namingOptions(input) {
  return { ...getOptions(), lang: getLang(), names: { ...getDict(), ...getMap(input) } };
}

// Açıklamalı fark için pipeline anlık görüntüleri (bellekte, son çözüm)
let snapshots = [];
export const resetSnapshots = () => { snapshots = []; };
export const recordSnapshot = (s) => { if (snapshots.length < MAX_SNAPSHOTS) snapshots.push({ id: s.id, round: s.round, code: s.code }); };
export const getSnapshots = () => snapshots;

/** "eski=yeni" satırlarından sözlük; geçersiz satırlar atlanır */
export function parseDictText(text) {
  const obj = {};
  for (const line of String(text).split('\n')) {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*[=:]\s*([A-Za-z_$][\w$]*)\s*$/.exec(line);
    if (m) obj[m[1]] = m[2];
  }
  return parseNames(JSON.stringify(obj));
}
export const dictToText = (d) => Object.entries(d).map(([k, v]) => `${k}=${v}`).join('\n');
