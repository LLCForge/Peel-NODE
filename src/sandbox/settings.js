import { PROFILES } from '../core/threat.js';

// Sandbox ayarları veri modeli (C46/C50/C67/C70): tarayıcı profili, zaman makinesi, çerez/depolama, sahte yanıtlar,
// bellek/süre sınırları. Doğrulanmış ayarlar her sandbox isteğine aynı biçimde uygulanır (client.js): temel ve aday
// çalıştırma aynı ortamı görür. Gerçek DOM onayı bilerek saklanmaz; her oturumda yeniden istenir.

export const LIMITS = {
  memoryMB: [16, 1024],
  timeoutMs: [500, 60000],
  responses: 50,
  storageKeys: 200,
  text: 20000,
};
export const VERIFY_LEVELS = ['none', 'parse', 'behaviour', 'effects', 'functions', 'proof'];

export const defaultSettings = () => ({
  profile: 'default',
  now: null, // null → sabit 1700000000000 (14 Kasım 2023)
  seed: null, // null → 12345
  cookie: '',
  storage: {},
  responses: [],
  memoryMB: null, // null → motor varsayılanı (çalıştırma 64 MB, bağlam 96 MB)
  timeoutMs: null, // null → isteğin kendi süresi
  verifyLevel: 'effects',
  watch: [],
});

const clampInt = (v, [lo, hi]) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : null);
const str = (v, max = LIMITS.text) => (typeof v === 'string' ? v.slice(0, max) : '');

// Güven sınırı: dışarıdan (localStorage, arayüz, JSON) gelen her alan burada doğrulanır; geçersiz alan varsayılana döner
export function validateSettings(input) {
  const d = defaultSettings();
  const o = input && typeof input === 'object' ? input : {};
  const errors = [];
  const s = { ...d };
  if (o.profile === 'default' || Object.hasOwn(PROFILES, o.profile)) s.profile = o.profile;
  else if (o.profile != null) errors.push(`profil: ${String(o.profile).slice(0, 40)}`);
  if (o.now != null) {
    const n = typeof o.now === 'string' ? Date.parse(o.now) : Number(o.now);
    if (Number.isFinite(n) && n >= 0 && n <= 8.64e15) s.now = Math.round(n); else errors.push('zaman');
  }
  if (o.seed != null) {
    const n = Number(o.seed);
    if (Number.isInteger(n) && n >= 0 && n <= 0x7fffffff) s.seed = n; else errors.push('tohum');
  }
  s.cookie = str(o.cookie).replace(/[\r\n]/g, '');
  if (o.storage && typeof o.storage === 'object' && !Array.isArray(o.storage)) {
    for (const [k, v] of Object.entries(o.storage).slice(0, LIMITS.storageKeys)) s.storage[str(k, 200)] = str(String(v ?? ''));
  }
  if (Array.isArray(o.responses)) {
    s.responses = o.responses.slice(0, LIMITS.responses)
      .filter((r) => r && typeof r.match === 'string' && r.match.length > 0)
      .map((r) => ({ match: str(r.match, 500), status: clampInt(Number(r.status ?? 200), [100, 599]) ?? 200, body: str(String(r.body ?? '')) }));
  }
  if (o.memoryMB != null) s.memoryMB = clampInt(Number(o.memoryMB), LIMITS.memoryMB);
  if (o.timeoutMs != null) s.timeoutMs = clampInt(Number(o.timeoutMs), LIMITS.timeoutMs);
  if (VERIFY_LEVELS.includes(o.verifyLevel)) s.verifyLevel = o.verifyLevel;
  if (Array.isArray(o.watch)) s.watch = o.watch.filter((w) => typeof w === 'string' && /^[\w$]+(\.[\w$]+)+$/.test(w)).slice(0, 50);
  return { settings: s, errors };
}

// Ayarları sandbox yapılandırmasına çevirir (stub'ların okuduğu __peelConfig)
export function toConfig(s) {
  const c = {};
  if (s.now != null) c.now = s.now;
  if (s.seed != null) c.seed = s.seed;
  if (s.profile !== 'default') c.profile = PROFILES[s.profile];
  if (s.cookie) c.cookie = s.cookie;
  if (Object.keys(s.storage).length) c.storage = s.storage;
  if (s.responses.length) c.responses = s.responses;
  return c;
}

// İsteğe ayarları uygular: yapılandırma verilmemişse ayarlardan gelir; sınırlar her isteğe uygulanır
export function applySettings(msg, s) {
  const out = { ...msg };
  if (out.config == null && ['run', 'batch', 'open'].includes(out.type)) out.config = toConfig(s);
  if (s.memoryMB != null && ['run', 'batch', 'open'].includes(out.type)) out.memoryMB = s.memoryMB;
  if (s.timeoutMs != null && (out.type === 'run' || out.type === 'open')) out.timeoutMs = s.timeoutMs;
  return out;
}

const KEY = 'peel.sandbox';
// yalnızca tarayıcıda kalıcı (Node 25'in deneysel localStorage'ı uyarı basar)
const store = () => (typeof document !== 'undefined' ? globalThis.localStorage : null);
let current = load();
const listeners = new Set();

function load() {
  try {
    const raw = store()?.getItem(KEY);
    if (raw) return validateSettings(JSON.parse(raw)).settings;
  } catch { /* depolama kapalı ya da bozuk kayıt */ }
  return defaultSettings();
}

export const getSettings = () => current;

export function setSettings(next) {
  const { settings, errors } = validateSettings(next);
  current = settings;
  try { store()?.setItem(KEY, JSON.stringify(settings)); } catch { /* depolama kapalı */ }
  for (const fn of listeners) fn(settings);
  return { settings, errors };
}

export function onSettings(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
