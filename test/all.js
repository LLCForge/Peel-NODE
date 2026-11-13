// test/*.test.js dosyalarının hepsini sırayla ayrı süreçte çalıştırır; biri başarısız olursa çıkış kodu 1.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();
const failed = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(f);
}
console.log(`\nbirim testleri: ${files.length - failed.length}/${files.length}${failed.length ? ` — başarısız: ${failed.join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
