// G152: paylaşılabilir önce/sonra raporu. Tek, bağımsız bir HTML dosyası üretir: betik yok, dış kaynak yok,
// CSP ile her şey kapalı. Tüm içerik kaçışlanır; raporu açan kişi çözülmüş kodu çalıştırmış olmaz.

const MAX_CELLS = 4_000_000;

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function lineDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length * y.length > MAX_CELLS) return null;
  const n = x.length;
  const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push(['same', y[j]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['del', x[i++]]);
    else out.push(['add', y[j++]]);
  }
  while (i < n) out.push(['del', x[i++]]);
  while (j < m) out.push(['add', y[j++]]);
  return out;
}

const L = {
  tr: { title: 'PEEL önce/sonra raporu', before: 'Önce (girdi)', after: 'Sonra (çözülmüş)', diff: 'Satır farkı', summary: 'Özet',
    tooBig: 'Dosyalar satır farkı için çok büyük; iki taraf ayrı gösteriliyor.', risk: 'Risk', iocs: 'Göstergeler (IOC)', techniques: 'Teknikler',
    bytes: 'bayt', note: 'Bu rapor PEEL tarafından cihazda üretildi. İçerikteki kod çalıştırılmaz.', why: 'Neden gizlenmiş olabilir' },
  en: { title: 'PEEL before/after report', before: 'Before (input)', after: 'After (deobfuscated)', diff: 'Line diff', summary: 'Summary',
    tooBig: 'Files are too large for a line diff; both sides are shown separately.', risk: 'Risk', iocs: 'Indicators (IOC)', techniques: 'Techniques',
    bytes: 'bytes', note: 'This report was generated on-device by PEEL. Code inside is never executed.', why: 'Why it may be obfuscated' },
};

/**
 * @param {object} o
 * @param {string} o.input
 * @param {string} o.output
 * @param {object} [o.report]       analyze() sonucu
 * @param {Array}  [o.techniques]   detectTechniques() sonucu
 * @param {Array}  [o.reasons]      explainWhy() sonucu
 * @param {string} [o.name]
 * @param {'tr'|'en'} [o.lang]
 */
export function buildReportHtml({ input, output, report = null, techniques = [], reasons = [], name = 'script.js', lang = 'tr' }) {
  const s = L[lang] ?? L.tr;
  const e = escapeHtml;
  const rows = [];
  rows.push(`<tr><th>${e(s.before)}</th><td>${input.length.toLocaleString()} ${s.bytes}</td></tr>`);
  rows.push(`<tr><th>${e(s.after)}</th><td>${output.length.toLocaleString()} ${s.bytes}</td></tr>`);
  if (report?.threat?.risk) rows.push(`<tr><th>${e(s.risk)}</th><td>${e(report.threat.risk.score)} / 100 (${e(report.threat.risk.level)})</td></tr>`);
  if (report?.fingerprint?.length) rows.push(`<tr><th>Obfuscator</th><td>${report.fingerprint.map((f) => e(`${f.name} (${Math.round(f.confidence * 100)}%)`)).join(', ')}</td></tr>`);
  if (techniques.length) rows.push(`<tr><th>${e(s.techniques)}</th><td>${techniques.map((x) => e(lang === 'tr' ? x.nameTr ?? x.name : x.name)).join(', ')}</td></tr>`);
  const iocs = report?.iocs ? ['urls', 'domains', 'ips', 'emails', 'wallets'].flatMap((k) => (report.iocs[k] ?? []).map((v) => `${k}: ${v}`)).slice(0, 100) : [];

  const diff = lineDiff(input, output);
  let diffHtml;
  if (diff) {
    let ln = 0;
    diffHtml = `<pre class="diff">${diff.map(([k, t]) => `<span class="${k}"><i>${k === 'del' ? '' : ++ln}</i>${k === 'add' ? '+' : k === 'del' ? '-' : ' '} ${e(t)}</span>`).join('\n')}</pre>`;
  } else {
    diffHtml = `<p>${e(s.tooBig)}</p><h3>${e(s.before)}</h3><pre>${e(input)}</pre><h3>${e(s.after)}</h3><pre>${e(output)}</pre>`;
  }

  return `<!DOCTYPE html>
<html lang="${lang === 'en' ? 'en' : 'tr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="referrer" content="no-referrer">
<title>${e(s.title)}: ${e(name)}</title>
<style>
:root { --bg: #0c0c0c; --surface: #121212; --line: #2a2a2a; --text: #ececec; --muted: #9aa0ad; --accent: #f7df1e; --add: #4ade80; --del: #ff6b5b; color-scheme: dark; }
@media (prefers-color-scheme: light) { :root { --bg: #fafafa; --surface: #ffffff; --line: #dddddd; --text: #111111; --muted: #555b66; --accent: #8a7a00; --add: #137333; --del: #b3261e; color-scheme: light; } }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, sans-serif; }
main { max-width: 1200px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
h1 { font-size: 20px; margin: 0; } h1 span { color: var(--accent); } h2 { font-size: 16px; margin: 0 0 8px; }
section { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 16px; overflow: auto; }
table { border-collapse: collapse; } th, td { text-align: left; padding: 4px 12px 4px 0; vertical-align: top; } th { color: var(--muted); font-weight: 600; }
pre { margin: 0; font: 12px/1.5 ui-monospace, Consolas, monospace; white-space: pre; }
.diff span { display: block; } .diff i { display: inline-block; width: 48px; color: var(--muted); font-style: normal; user-select: none; }
.diff .add { color: var(--add); } .diff .del { color: var(--del); }
ul { margin: 0; padding-left: 20px; } footer { color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<main>
<h1><span>PEEL</span> · ${e(s.title)} · ${e(name)}</h1>
<section><h2>${e(s.summary)}</h2><table>${rows.join('')}</table></section>
${reasons.length ? `<section><h2>${e(s.why)}</h2><ul>${reasons.map((r) => `<li><b>${e(r.title[lang] ?? r.title.tr)}</b>: ${e(r.detail[lang] ?? r.detail.tr)}</li>`).join('')}</ul></section>` : ''}
${iocs.length ? `<section><h2>${e(s.iocs)}</h2><ul>${iocs.map((x) => `<li><code>${e(x)}</code></li>`).join('')}</ul></section>` : ''}
<section><h2>${e(s.diff)}</h2>${diffHtml}</section>
<footer>${e(s.note)}</footer>
</main>
</body>
</html>
`;
}
