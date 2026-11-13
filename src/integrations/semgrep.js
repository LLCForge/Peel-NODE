import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// H172: Semgrep entegrasyonu. Çözülmüş çıktı geçici bir dosyaya yazılır ve yerel `semgrep` ile taranır
// (Semgrep kurulu olmalı: pip install semgrep). Varsayılan kural seti PEEL ile gelir
// (extensions/semgrep/peel.yml); kullanıcı kendi yapılandırmasını verebilir. --metrics=off ile
// Semgrep'in kullanım verisi göndermesi kapatılır, yalnızca yerel kural dosyaları kabul edilir.

export const DEFAULT_RULES = fileURLToPath(new URL('../../extensions/semgrep/peel.yml', import.meta.url));
const TIMEOUT_MS = 120_000;
const MAX_OUT = 64 * 1024 * 1024;

const LEVEL = { ERROR: 'error', WARNING: 'warning', INFO: 'note' };

/** Semgrep --json çıktısını sadeleştirir. */
export function normalizeSemgrep(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  return (data?.results ?? []).map((r) => ({
    ruleId: String(r.check_id ?? 'semgrep').split('.').pop(),
    message: String(r.extra?.message ?? r.check_id ?? '').trim(),
    level: LEVEL[r.extra?.severity] ?? 'warning',
    line: r.start?.line ?? 1,
    endLine: r.end?.line ?? null,
    code: String(r.extra?.lines ?? '').slice(0, 500),
  }));
}

/**
 * @param {string} code      taranacak (çözülmüş) kod
 * @param {{config?: string, bin?: string}} [o]  config yerel bir dosya yolu olmalı
 */
export async function runSemgrep(code, { config = DEFAULT_RULES, bin = 'semgrep' } = {}) {
  if (/^(https?:|p\/|r\/|auto$)/i.test(config)) throw new Error('Semgrep yapılandırması yerel bir dosya olmalı (uzak kural seti indirilmez)');
  const dir = await mkdtemp(join(tmpdir(), 'peel-semgrep-'));
  const file = join(dir, 'peeled.js');
  try {
    await writeFile(file, code);
    const out = await new Promise((resolve, reject) => {
      const p = spawn(bin, ['scan', '--json', '--quiet', '--metrics=off', '--disable-version-check', '--config', config, file], { shell: false });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { p.kill(); reject(new Error('Semgrep zaman aşımı')); }, TIMEOUT_MS);
      p.stdout.on('data', (d) => {
        stdout += d;
        if (stdout.length > MAX_OUT) { p.kill(); reject(new Error('Semgrep çıktısı çok büyük')); }
      });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(e.code === 'ENOENT' ? 'semgrep bulunamadı: pip install semgrep' : e.message));
      });
      p.on('close', (status) => {
        clearTimeout(timer);
        // semgrep bulgu varken de 0 döner; 1 = bulgu (--error ile), 2+ = hata
        if (status > 1) reject(new Error(`Semgrep hata verdi (${status}): ${stderr.slice(0, 500)}`));
        else resolve(stdout);
      });
    });
    return normalizeSemgrep(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
