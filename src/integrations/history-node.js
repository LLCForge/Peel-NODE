import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// Node için dosya tabanlı geçmiş deposu: ~/.peel/history.json (PEEL_HOME ile değiştirilebilir).
// Yazma geçici dosya + rename ile atomiktir: yarıda kalan yazma geçmişi bozmaz.
export const defaultHistoryPath = () => join(process.env.PEEL_HOME || join(homedir(), '.peel'), 'history.json');

export function fileStore(path = defaultHistoryPath()) {
  return {
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error(`Geçmiş dosyası bozuk: ${path}`);
      return data;
    },
    async save(entries) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(entries), { mode: 0o600 });
      await rename(tmp, path);
    },
  };
}
