import { maskSecrets } from '../core/threat.js';

// I185: yanlış sonuç bildirme şablonu — GitHub issue gövdesi (Markdown). Kod paylaşılmadan önce anahtarlar maskelenir;
// kod parçası isteğe bağlıdır ve kısaltılır. URL'ye gömülmez: kopyalanır ya da indirilir (gizlilik).

const MAX_SNIPPET = 4000;

export function issueTemplate({ report = null, settings = null, input = '', output = '', includeCode = false, version = '0.1.0', note = '' } = {}) {
  const m = report?.metrics ?? {};
  const rollbacks = (report?.rollbacks ?? []).map((r) => `- \`${r.id}\` (tur ${r.round}): ${r.reason ?? ''}`);
  const v = report?.verification;
  const failures = v?.failure?.failures ?? [];
  const snippet = (code) => {
    const { code: masked, count } = maskSecrets(code.slice(0, MAX_SNIPPET));
    return `${masked}${code.length > MAX_SNIPPET ? `\n/* … ${code.length - MAX_SNIPPET} karakter kısaltıldı */` : ''}${count ? `\n/* ${count} gizli değer maskelendi */` : ''}`;
  };
  const env = typeof navigator !== 'undefined' ? navigator.userAgent : `Node ${globalThis.process?.version ?? ''}`;
  return [
    '---',
    'name: Yanlış sonuç / Wrong result',
    'about: PEEL çıktısı girdiyle aynı davranmıyor ya da hatalı',
    'labels: wrong-result',
    '---',
    '',
    '## Ne oldu?',
    '',
    note || '<!-- Beklenen ve gözlenen davranışı kısaca anlatın -->',
    '',
    '## Ortam',
    '',
    `- PEEL: ${version}`,
    `- Çalışma ortamı: ${env}`,
    `- Sandbox ayarları: \`${JSON.stringify(settings ?? {})}\``,
    '',
    '## Özetler',
    '',
    `- Girdi boyutu: ${m.inBytes ?? input.length} bayt, çıktı: ${m.outBytes ?? output.length} bayt`,
    `- Çıktı özeti (FNV-1a): \`${m.outputHash ?? '-'}\``,
    `- Doğrulama düzeyi: ${v?.level ?? '-'}; güven skoru: ${report?.trust?.score ?? '-'}`,
    report?.fingerprint?.length ? `- Tespit: ${report.fingerprint.map((f) => f.name).join(', ')}` : '- Tespit: -',
    '',
    '## Geri alınan pass\'ler',
    '',
    ...(rollbacks.length ? rollbacks : ['- yok']),
    '',
    '## Başarısız denetimler',
    '',
    ...(failures.length ? failures.map((f) => `- **${f.check}**: ${f.summary}`) : ['- yok']),
    '',
    ...(includeCode ? ['## Girdi (maskelenmiş, kısaltılmış)', '', '```js', snippet(input), '```', '', '## Çıktı (maskelenmiş, kısaltılmış)', '', '```js', snippet(output), '```', '']
      : ['<!-- Kod eklemek isterseniz önce gizli bilgileri çıkarın. -->', '']),
  ].join('\n');
}
