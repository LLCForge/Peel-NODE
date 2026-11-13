// Oturum kaydı: IndexedDB (cihazda kalır) ve JSON dışa/içe aktarma.
// İçe aktarılan JSON güvenilmezdir: her alan türü ve boyutu doğrulanır, bilinmeyen alanlar atılır.

const DB = 'peel';
const STORE = 'session';
const MAX_TEXT = 25 * 1024 * 1024;

// 'peel' veritabanını oturum ve geçmiş depoları paylaşır; ikisi de her açılışta var olmalı
// (sürüm 1'de hangisi önce açıldıysa yalnızca onun deposu oluşuyordu)
const STORES = ['session', 'history'];

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      for (const name of STORES) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
    };
    req.onsuccess = () => {
      // başka sekme daha yeni sürüme yükseltirken açık bağlantı onu kilitlemesin
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB açılamadı'));
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('İşlem iptal edildi'));
    });
  } finally {
    db.close();
  }
}

// JSON gidiş-dönüşü: rapordaki tembel hesap fonksiyonları (lazySymbolic) yapılandırılmış klonlanamaz
export const saveSession = (data) => tx('readwrite', (s) => s.put(JSON.parse(JSON.stringify(data)), 'current'));
export const loadSession = () => tx('readonly', (s) => s.get('current'));
export const clearSession = () => tx('readwrite', (s) => s.delete('current'));

const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const text = (v) => (typeof v === 'string' && v.length <= MAX_TEXT ? v : '');
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

function marks(m) {
  const o = m && typeof m === 'object' ? m : {};
  return {
    bookmarks: (Array.isArray(o.bookmarks) ? o.bookmarks : []).map((n) => int(n, 1, 1e8)).filter((n) => n !== null).slice(0, 5000),
    notes: (Array.isArray(o.notes) ? o.notes : []).filter((x) => x && int(x.line, 1, 1e8) !== null && typeof x.text === 'string')
      .slice(0, 5000).map((x) => ({ line: x.line, text: x.text.slice(0, 4000) })),
  };
}

/** Güvenilmez oturum nesnesini doğrular; geçersizse hata fırlatır */
export function sanitizeSession(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.docs)) throw new Error('session: docs yok');
  const groups = (Array.isArray(raw.groups) ? raw.groups : []).slice(0, 200).map((g) => ({
    id: str(g?.id, 40), name: str(g?.name, 120), color: /^#[0-9a-f]{6}$/i.test(g?.color) ? g.color : '#f7df1e', collapsed: g?.collapsed === true,
  })).filter((g) => g.id);
  const gids = new Set(groups.map((g) => g.id));
  const docs = raw.docs.slice(0, 500).map((d) => ({
    id: str(d?.id, 40),
    name: str(d?.name, 200) || 'untitled.js',
    path: str(d?.path, 500),
    group: gids.has(d?.group) ? d.group : null,
    input: text(d?.input),
    output: text(d?.output),
    marks: { in: marks(d?.marks?.in), out: marks(d?.marks?.out) },
    // rapor ve olaylar yalnızca veri olarak saklanır; arayüzde her zaman textContent ile basılır
    report: d?.report && typeof d.report === 'object' ? d.report : null,
    events: Array.isArray(d?.events) ? d.events.slice(0, 5000).filter((e) => e && typeof e.id === 'string') : [],
    runs: Array.isArray(d?.runs) ? d.runs.slice(-20).filter((r) => r && typeof r === 'object') : [],
  })).filter((d) => d.id);
  if (!docs.length) throw new Error('session: boş');
  return {
    docs,
    groups,
    active: docs.some((d) => d.id === raw.active) ? raw.active : docs[0].id,
    searches: (Array.isArray(raw.searches) ? raw.searches : []).slice(0, 200).filter((s) => s && typeof s.query === 'string')
      .map((s) => ({ name: str(s.name, 120), mode: str(s.mode, 30), query: s.query.slice(0, 2000), opts: s.opts && typeof s.opts === 'object' ? { regex: !!s.opts.regex, caseSensitive: !!s.opts.caseSensitive, wholeWord: !!s.opts.wholeWord, scope: str(s.opts.scope, 20) } : {} })),
    history: (Array.isArray(raw.history) ? raw.history : []).filter((s) => typeof s === 'string').slice(0, 50).map((s) => s.slice(0, 2000)),
  };
}
