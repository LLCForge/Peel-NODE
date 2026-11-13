import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { resolveStyle } from './style.js';

// Node: verilen dizinden köke doğru yürüyerek ilk bulunan yapılandırma dosyalarını okur (H171).
const FILES = {
  prettierrc: ['.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml'],
  packageJson: ['package.json'],
  eslintrc: ['.eslintrc.json', '.eslintrc'],
  editorconfig: ['.editorconfig'],
};

async function tryRead(p) {
  try { return await readFile(p, 'utf8'); } catch { return null; }
}

export async function findStyle(startDir) {
  const found = {};
  let dir = resolve(startDir);
  for (;;) {
    for (const [key, names] of Object.entries(FILES)) {
      if (found[key]) continue;
      for (const n of names) {
        const text = await tryRead(join(dir, n));
        if (text === null) continue;
        // package.json yalnızca prettier alanı varsa sayılır
        if (key === 'packageJson' && !/"prettier"\s*:/.test(text)) continue;
        found[key] = text;
        break;
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolveStyle(found);
}
