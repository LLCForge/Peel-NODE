// H173: analiz raporunu SARIF 2.1.0'a çevirir (GitHub code scanning, VS Code SARIF Viewer, DefectDojo).
// Konum: bulgunun çözülmüş çıktıdaki ilk geçtiği satır. Semgrep sonuçları (H172) varsa aynı dosyaya eklenir.

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const HOME = 'https://github.com/LLCForge/Peel-JS';

const THREAT_TEXT = {
  skimmer: 'Ödeme/form verisi okuyup gönderen kod (skimmer)',
  magecart: 'Magecart: ödeme alanları ve dışarı veri gönderimi birlikte',
  miner: 'Tarayıcıda kripto madenciliği',
  keylogger: 'Tuş vuruşlarını kaydedip gönderen kod',
  'credential-harvest': 'Kimlik bilgisi toplama',
  redirect: 'Yönlendirme zinciri',
  fingerprint: 'Tarayıcı parmak izi toplama',
  'dynamic-code': 'Dinamik kod yürütme (eval/Function)',
  wallet: 'Gömülü kripto cüzdan adresi',
};

function locate(lines, needle) {
  if (!needle) return 1;
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(needle)) return i + 1;
  return 1;
}

/**
 * @param {object} report    analyze() sonucu
 * @param {object} o
 * @param {string} o.output  çözülmüş kod (satır bulmak için)
 * @param {string} [o.uri]   sonuçların bağlanacağı dosya yolu
 * @param {Array}  [o.semgrep] semgrep.js normalizeSemgrep() sonucu
 * @param {string} [o.version]
 */
export function toSarif(report, { output = '', uri = 'peeled.js', semgrep = [], version = '0.1.0' } = {}) {
  const lines = output.split('\n');
  const rules = new Map();
  const results = [];
  const rule = (id, text, level, help) => {
    if (!rules.has(id)) {
      rules.set(id, {
        id,
        name: id.replace(/[^A-Za-z0-9]+/g, ' ').trim().replace(/ (\w)/g, (_, c) => c.toUpperCase()),
        shortDescription: { text },
        helpUri: `${HOME}#readme`,
        help: { text: help ?? text },
        defaultConfiguration: { level },
      });
    }
    return [...rules.keys()].indexOf(id);
  };
  const result = (id, level, message, needle, props) => {
    results.push({
      ruleId: id,
      ruleIndex: [...rules.keys()].indexOf(id),
      level,
      message: { text: message },
      locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: locate(lines, needle) } } }],
      ...(props ? { properties: props } : {}),
    });
  };

  for (const c of report?.threat?.classes ?? []) {
    const id = `peel/threat/${c.id}`;
    const level = c.score >= 50 ? 'error' : 'warning';
    rule(id, THREAT_TEXT[c.id] ?? c.id, level);
    result(id, level, `${THREAT_TEXT[c.id] ?? c.id}: ${c.evidence.join('; ')}`, null, { score: c.score });
  }
  for (const a of report?.apis ?? []) {
    const id = `peel/api/${a.name}`;
    rule(id, `Şüpheli API: ${a.name} (${a.why})`, 'note');
    result(id, 'note', `${a.name} ${a.count} kez kullanılıyor: ${a.why}`, a.name.split('.').pop(), { count: a.count });
  }
  for (const kind of ['urls', 'domains', 'ips', 'emails', 'wallets', 'jwts']) {
    for (const v of report?.iocs?.[kind] ?? []) {
      const id = `peel/ioc/${kind}`;
      rule(id, `Gösterge (IOC): ${kind}`, kind === 'wallets' || kind === 'jwts' ? 'warning' : 'note');
      result(id, rules.get(id).defaultConfiguration.level, `${kind}: ${v}`, v);
    }
  }
  for (const r of report?.rollbacks ?? []) {
    const id = 'peel/rollback';
    rule(id, 'Pass geri alındı: bu bölge tam çözülmemiş olabilir', 'note');
    result(id, 'note', `${r.id}: ${r.reason ?? 'geri alındı'}`, null);
  }
  for (const s of semgrep) {
    const id = `semgrep/${s.ruleId}`;
    rule(id, s.message.slice(0, 200), s.level, s.message);
    results.push({
      ruleId: id,
      ruleIndex: [...rules.keys()].indexOf(id),
      level: s.level,
      message: { text: s.message },
      locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: s.line, ...(s.endLine ? { endLine: s.endLine } : {}) } } }],
    });
  }

  const risk = report?.threat?.risk;
  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'PEEL', informationUri: HOME, version, semanticVersion: version, rules: [...rules.values()] } },
      artifacts: [{ location: { uri }, length: output.length }],
      results,
      ...(risk ? { properties: { riskScore: risk.score, riskLevel: risk.level, fingerprint: (report.fingerprint ?? []).map((f) => f.name) } } : {}),
    }],
  };
}
