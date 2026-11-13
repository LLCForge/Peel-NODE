// Tarayıcıda çözüm geçmişi deposu (G146): IndexedDB, yalnızca bu cihazda. IndexedDB kullanılamazsa
// (gizli pencere, kapalı site verisi) bellek içi depoya düşer ve geçmiş sekme kapanınca silinir.
import { memoryStore } from '../../integrations/history.js';
import { openDb } from '../store.js';

const STORE = 'history';
const KEY = 'entries';

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function browserStore() {
  try {
    const db = await openDb();
    return {
      persistent: true,
      async load() { return (await tx(db, 'readonly', (s) => s.get(KEY))) ?? []; },
      async save(entries) { await tx(db, 'readwrite', (s) => s.put(entries, KEY)); },
    };
  } catch {
    return { persistent: false, ...memoryStore() };
  }
}
