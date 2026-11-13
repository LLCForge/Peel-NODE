import { detectTechniques } from './techniques.js';

// J199: "Bu kod neden gizlenmiş olabilir?" Kullanılan teknikler, obfuscator imzası ve tehdit
// bulgularından olası amaçlar çıkarılır. Her neden kanıtıyla ve güven düzeyiyle verilir; kesin hüküm değildir.

const R = {
  malware: {
    title: { tr: 'Zararlı yükü gizlemek', en: 'Hiding a malicious payload' },
    detail: {
      tr: 'Davranış analizi veri çalma, madencilik ya da kimlik bilgisi toplama gibi bulgular verdi. Gizleme, güvenlik taramalarından kaçmak için kullanılmış olabilir.',
      en: 'Behaviour analysis found data theft, mining or credential collection. Obfuscation may be used to evade security scanners.',
    },
  },
  loader: {
    title: { tr: 'İkinci aşama yükleyici (dropper)', en: 'Second-stage loader (dropper)' },
    detail: {
      tr: 'Kod kodlanmış bir string\'i çözüp çalıştırıyor ve ağa bağlanıyor. Asıl yük çalışma anında indirilen ya da açılan koddadır.',
      en: 'The code decodes and runs an encoded string and talks to the network. The real payload is fetched or unpacked at runtime.',
    },
  },
  antibot: {
    title: { tr: 'Bot tespiti / dolandırıcılık önleme', en: 'Bot detection / anti-fraud' },
    detail: {
      tr: 'Tarayıcı parmak izi okumaları ve güçlü gizleme birlikte: anti-bot ve reklam dolandırıcılığı önleme script\'leri kurallarını bu şekilde saklar.',
      en: 'Fingerprint reads combined with strong obfuscation: anti-bot and ad-fraud scripts hide their rules this way.',
    },
  },
  tracking: {
    title: { tr: 'İzleme ve analitik', en: 'Tracking and analytics' },
    detail: {
      tr: 'Üçüncü taraf alan adlarına veri gönderimi, çerez ve depolama kullanımı var. Gizleme, reklam engelleyicilerden kaçmak için olabilir.',
      en: 'Data is sent to third-party domains and cookies/storage are used. Obfuscation may help evade ad blockers.',
    },
  },
  ip: {
    title: { tr: 'Ticari kodu / fikri mülkiyeti korumak', en: 'Protecting commercial code / IP' },
    detail: {
      tr: 'Hazır bir obfuscator\'ın tipik ayarları kullanılmış ve zararlı davranış görülmedi. Yaygın sebep, kaynağın kopyalanmasını ve lisans kontrolünün atlanmasını zorlaştırmaktır.',
      en: 'Typical settings of an off-the-shelf obfuscator are used and no malicious behaviour was seen. A common reason is to make copying and licence bypass harder.',
    },
  },
  antiAnalysis: {
    title: { tr: 'Analizi engellemek', en: 'Blocking analysis' },
    detail: {
      tr: 'Debugger tuzakları ya da kendini savunma kodu var: amaç, kodu inceleyen kişiyi yavaşlatmak.',
      en: 'Debugger traps or self-defending code are present: the goal is to slow down whoever inspects the code.',
    },
  },
  vm: {
    title: { tr: 'Yüksek değerli mantığı korumak', en: 'Protecting high-value logic' },
    detail: {
      tr: 'Sanal makine / durum makinesi gizlemesi pahalıdır; genellikle anti-bot, DRM ya da ödeme doğrulama mantığı için kullanılır.',
      en: 'VM / state-machine obfuscation is costly; it usually protects anti-bot, DRM or payment validation logic.',
    },
  },
  minify: {
    title: { tr: 'Yalnızca küçültme (minify)', en: 'Minification only' },
    detail: {
      tr: 'Yalnızca ad kısaltma ve literal kaçışları görüldü. Bu çoğunlukla boyut için yapılır ve tek başına kötü niyet işareti değildir.',
      en: 'Only name shortening and literal escapes were seen. This is usually done for size and is not by itself a sign of bad intent.',
    },
  },
  filterEvasion: {
    title: { tr: 'Filtre atlatma', en: 'Filter evasion' },
    detail: {
      tr: 'JSFuck / aaencode / jjencode gibi kodlamalar, WAF ve XSS filtrelerinden geçmek için tercih edilir.',
      en: 'Encodings like JSFuck / aaencode / jjencode are favoured to slip past WAF and XSS filters.',
    },
  },
};

const MALICIOUS = new Set(['skimmer', 'magecart', 'miner', 'keylogger', 'credential-harvest']);

/**
 * @param {{input: string, report?: object}} o  report: analyze() sonucu (yoksa yalnızca statik çıkarım)
 * @returns {Array<{id: string, title: {tr: string, en: string}, detail: {tr: string, en: string}, confidence: number, evidence: string[]}>}
 */
export function explainWhy({ input, report = null }) {
  const tech = new Set(detectTechniques(input).map((x) => x.id));
  const classes = report?.threat?.classes ?? [];
  const classIds = new Set(classes.map((c) => c.id));
  const net = report?.runtime?.network ?? [];
  const families = (report?.fingerprint ?? []).map((f) => f.name);
  const out = [];
  const add = (id, confidence, evidence) => {
    if (evidence.length) out.push({ id, ...R[id], confidence: Math.min(1, confidence), evidence });
  };

  const bad = classes.filter((c) => MALICIOUS.has(c.id));
  add('malware', 0.5 + bad.reduce((a, c) => a + c.score, 0) / 200, bad.map((c) => `${c.id}: ${c.evidence.join(', ')}`));

  const dyn = tech.has('eval-wrapper') || classIds.has('dynamic-code');
  add('loader', 0.6, dyn && (net.length || (report?.iocs?.urls ?? []).length)
    ? [tech.has('eval-wrapper') ? 'eval/Function sarmalayıcı' : 'dinamik kod yürütme', `${net.length || report.iocs.urls.length} ağ hedefi`]
    : []);

  const strong = tech.has('vm') || tech.has('control-flow-flattening') || tech.has('global-concealing');
  add('antibot', 0.55, classIds.has('fingerprint') && strong ? ['parmak izi okumaları', 'güçlü gizleme (VM/akış düzleştirme)'] : []);

  const third = report?.threat?.privacy?.thirdParties ?? [];
  add('tracking', 0.45, third.length && !bad.length ? [`üçüncü taraf: ${third.slice(0, 5).join(', ')}`] : []);

  add('antiAnalysis', 0.7, [tech.has('debug-protection') && 'debugger tuzağı', tech.has('self-defending') && 'kendini savunma'].filter(Boolean));
  add('vm', 0.6, tech.has('vm') ? ['bytecode yorumlayıcı döngüsü'] : []);
  add('filterEvasion', 0.6, [...tech].filter((x) => x === 'jsfuck' || x === 'aaencode'));

  const commercial = families.filter((f) => f === 'obfuscator.io' || f === 'js-confuser');
  add('ip', 0.4, !bad.length && commercial.length ? commercial.map((f) => `${f} imzası`) : []);

  const heavy = [...tech].filter((x) => !['identifier-mangling', 'escaped-literals', 'unicode-escapes-identifiers'].includes(x));
  add('minify', 0.5, !heavy.length && tech.size && !bad.length ? [...tech] : []);

  return out.sort((a, b) => b.confidence - a.confidence);
}
