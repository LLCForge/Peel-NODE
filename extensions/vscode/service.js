'use strict';
// VS Code API'sinden bağımsız çekirdek: peel-js modülünü alır, eklentinin ihtiyaç duyduğu işlemleri sunar.
// Böylece aynı mantık Node'da (test/vscode-service.test.js) VS Code olmadan denetlenir.

const LEVELS = new Set([1, 2, 3, 4]);

function options(cfg = {}) {
  return {
    level: LEVELS.has(cfg.level) ? cfg.level : 4,
    sandbox: cfg.sandbox !== false,
    deep: cfg.deep !== false,
  };
}

const lineOf = (code, needle) => {
  const i = needle ? code.indexOf(needle) : -1;
  return i < 0 ? 0 : code.slice(0, i).split('\n').length - 1;
};

function createService(peel) {
  async function deobfuscateText(text, cfg, { signal, onLog } = {}) {
    const o = options(cfg);
    const r = await peel.deobfuscate(text, { level: o.level, sandbox: o.sandbox, deep: o.deep && o.sandbox, signal, onLog });
    if (r.error) throw new Error(`PEEL: parse edilemedi: ${r.error}`);
    return r;
  }

  async function analyzeText(text, cfg, ctx = {}) {
    const r = await deobfuscateText(text, cfg, ctx);
    const report = await peel.analyze({ input: text, text: r.text, output: r.code, events: r.events, sandbox: options(cfg).sandbox });
    return { result: r, report, techniques: peel.detectTechniques(text), reasons: peel.explainWhy({ input: text, report }) };
  }

  function reportMarkdown({ report, techniques, reasons, result }, lang = 'tr') {
    const tr = lang !== 'en';
    const md = [];
    md.push(`# PEEL ${tr ? 'raporu' : 'report'}`, '');
    md.push(`- ${tr ? 'Risk' : 'Risk'}: **${report.threat.risk.score}/100** (${report.threat.risk.level})`);
    md.push(`- ${tr ? 'Davranış doğrulandı' : 'Behaviour verified'}: ${result.verified ? (tr ? 'evet' : 'yes') : (tr ? 'hayır' : 'no')}`);
    if (report.fingerprint.length) md.push(`- Obfuscator: ${report.fingerprint.map((f) => `${f.name} (${Math.round(f.confidence * 100)}%)`).join(', ')}`);
    if (techniques.length) md.push(`- ${tr ? 'Teknikler' : 'Techniques'}: ${techniques.map((x) => (tr ? x.nameTr : x.name)).join(', ')}`);
    if (reasons.length) {
      md.push('', `## ${tr ? 'Neden gizlenmiş olabilir' : 'Why it may be obfuscated'}`);
      for (const r of reasons) md.push(`- **${tr ? r.title.tr : r.title.en}** (${Math.round(r.confidence * 100)}%): ${tr ? r.detail.tr : r.detail.en}`);
    }
    if (report.threat.classes.length) {
      md.push('', `## ${tr ? 'Tehdit sınıfları' : 'Threat classes'}`);
      for (const c of report.threat.classes) md.push(`- \`${c.id}\` (${c.score}): ${c.evidence.join('; ')}`);
    }
    const iocs = ['urls', 'domains', 'ips', 'emails', 'wallets'].flatMap((k) => report.iocs[k].map((v) => `${k}: \`${v.replace(/`/g, "'")}\``));
    if (iocs.length) md.push('', '## IOC', ...iocs.slice(0, 100).map((x) => `- ${x}`));
    if (report.apis.length) md.push('', `## ${tr ? 'Şüpheli API\'ler' : 'Suspicious APIs'}`, ...report.apis.map((a) => `- \`${a.name}\` ×${a.count}: ${a.why}`));
    if (report.rollbacks.length) md.push('', `## ${tr ? 'Geri alınan pass\'ler' : 'Rolled-back passes'}`, ...report.rollbacks.map((e) => `- ${e.id}: ${e.reason ?? ''}`));
    return `${md.join('\n')}\n`;
  }

  // Çözülmüş koddaki bulgular için editör tanılamaları (satır, mesaj, önem)
  function diagnostics(report, code) {
    const out = [];
    for (const c of report.threat.classes) out.push({ line: 0, severity: c.score >= 50 ? 'error' : 'warning', message: `PEEL: ${c.id} (${c.score}) ${c.evidence.join('; ')}` });
    for (const a of report.apis) out.push({ line: lineOf(code, a.name.split('.').pop()), severity: 'information', message: `PEEL: ${a.name}: ${a.why}` });
    for (const u of report.iocs.urls) out.push({ line: lineOf(code, u), severity: 'information', message: `PEEL IOC: ${u}` });
    return out;
  }

  async function compareTexts(oldText, newText, cfg, ctx = {}) {
    const a = await deobfuscateText(oldText, cfg, ctx);
    const b = await deobfuscateText(newText, cfg, ctx);
    const diff = peel.semanticDiff(a.code, b.code, { oldInput: oldText, newInput: newText });
    return { oldCode: a.code, newCode: b.code, diff, summary: peel.formatDiff(diff, cfg.lang === 'en' ? 'en' : 'tr') };
  }

  return { deobfuscateText, analyzeText, reportMarkdown, diagnostics, compareTexts, options };
}

module.exports = { createService };
