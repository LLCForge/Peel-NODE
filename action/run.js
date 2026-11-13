// H162: GitHub Action giriş betiği. Girdiler ortam değişkenlerinden okunur (betiğe ${{ }} ile metin
// enjekte edilmez), dosyalar workspace içinde glob ile çözülür, PEEL CLI'ı --json ile çalıştırılır;
// çıktılar $GITHUB_OUTPUT'a, özet tablo $GITHUB_STEP_SUMMARY'ye yazılır.
import { appendFileSync, globSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const workspace = resolve(env.GITHUB_WORKSPACE ?? process.cwd());
const cli = fileURLToPath(new URL('../bin/peel.js', import.meta.url));
const RISKS = ['none', 'low', 'medium', 'high'];

function fail(msg) {
  console.log(`::error::${msg.replace(/\r?\n/g, ' ')}`);
  process.exit(1);
}

// workspace dışına çıkan yollar reddedilir
const inside = (p) => {
  const rel = relative(workspace, resolve(workspace, p));
  return rel && !rel.startsWith('..') && !isAbsolute(rel);
};

const patterns = String(env.PEEL_FILES ?? '').split(/[\s,]+/).filter(Boolean);
if (!patterns.length) fail('files girdisi boş');
const files = [...new Set(patterns.flatMap((p) => (/[*?[{]/.test(p) ? globSync(p, { cwd: workspace }) : [p])))]
  .filter((p) => /\.(c|m)?js$/i.test(p));
if (!files.length) fail(`Desenlere uyan .js dosyası yok: ${patterns.join(' ')}`);
for (const f of files) if (!inside(f)) fail(`Workspace dışındaki yol reddedildi: ${f}`);

const outDir = env.PEEL_OUT_DIR || 'peel-out';
if (!inside(outDir)) fail('out-dir workspace içinde olmalı');
const level = env.PEEL_LEVEL || '4';
if (!['1', '2', '3', '4'].includes(level)) fail('level 1-4 olmalı');
const failOn = env.PEEL_FAIL_ON || 'none';
if (!RISKS.includes(failOn)) fail('fail-on none|low|medium|high olmalı');
mkdirSync(resolve(workspace, outDir), { recursive: true });

const args = [cli, ...files, '--json', '--quiet', '--out-dir', outDir, '--level', level];
const single = files.length === 1;
if (env.PEEL_SARIF !== 'false') args.push('--sarif', single ? `${outDir}/${files[0].split(/[\\/]/).pop()}.sarif` : 'on');
if (env.PEEL_HTML === 'true') args.push('--html', single ? `${outDir}/${files[0].split(/[\\/]/).pop()}.report.html` : 'on');
if (failOn !== 'none') args.push('--fail-on', failOn);
if (env.PEEL_RULES) {
  if (!inside(env.PEEL_RULES)) fail('rules workspace içinde olmalı');
  args.push('--rules', env.PEEL_RULES);
}

const r = spawnSync(process.execPath, args, { cwd: workspace, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
let results;
try {
  const parsed = JSON.parse(r.stdout);
  results = Array.isArray(parsed) ? parsed : [parsed];
} catch {
  fail(`PEEL çıktısı okunamadı (çıkış kodu ${r.status})`);
}

const maxRisk = Math.max(0, ...results.map((x) => x.risk?.score ?? 0));
const out = (k, v) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`);
out('out-dir', outDir);
out('sarif', outDir);
out('max-risk', maxRisk);
out('files', results.length);

const esc = (s) => String(s).replace(/[|<>]/g, (c) => `&#${c.charCodeAt(0)};`);
const rows = results.map((x) => `| ${esc(x.file)} | ${x.ok ? 'tamam' : `hata: ${esc(x.error ?? '')}`} | ${x.risk ? `${x.risk.score} (${x.risk.level})` : '-'} | ${esc((x.techniques ?? []).join(', ') || '-')} | ${x.verified ? 'evet' : 'hayır'} |`);
const summary = `### PEEL\n\n| Dosya | Durum | Risk | Teknikler | Davranış doğrulandı |\n|---|---|---|---|---|\n${rows.join('\n')}\n`;
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
for (const x of results) {
  if (!x.ok) console.log(`::error file=${x.file}::${esc(x.error ?? 'çözülemedi')}`);
  else if (x.risk && x.risk.level !== 'none') console.log(`::warning file=${x.file}::PEEL risk ${x.risk.score}/100 (${x.risk.level})`);
}
process.exit(r.status ?? 1);
