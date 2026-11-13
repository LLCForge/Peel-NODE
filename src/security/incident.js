// E114: olay müdahale raporu. Analiz raporundaki tüm bulgular (özet, risk, davranış sınıfları, IOC'ler,
// exfiltration haritası, phishing uç noktaları, anti-bot, kripto çözümleri, kodlama zincirleri, araç tespiti,
// pass zaman çizelgesi, YARA/Suricata kuralları) tek Markdown + JSON paketinde, SHA-256 özetleri ve
// önerilen müdahale adımlarıyla. Paylaşım için gizli değerler isteğe bağlı maskelenir.
import { maskSecrets } from '../core/threat.js';

async function sha256(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 300);
const table = (head, rows) => (rows.length
  ? [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n')
  : '_yok_');

function recommendations(report) {
  const s = report.security ?? {};
  const rec = [];
  const iocs = report.iocs ?? {};
  if ((iocs.domains ?? []).length || (iocs.ips ?? []).length) rec.push('IOC alan adlarını ve IP adreslerini DNS/proxy/güvenlik duvarında engelleyin; ekteki Suricata kurallarını devreye alın.');
  if ((s.exfil ?? []).some((e) => e.source === 'cookie')) rec.push('Çerezler dışarı gönderiliyor: etkilenen kullanıcı oturumlarını sonlandırın, oturum çerezlerini HttpOnly yapın.');
  if ((s.exfil ?? []).some((e) => e.source === 'storage')) rec.push('localStorage/sessionStorage içeriği sızdırılıyor: depolanan token ve anahtarları döndürün (rotate).');
  const cls = (report.threat?.classes ?? []).map((c) => c.id);
  if (cls.includes('magecart') || cls.includes('skimmer')) rec.push('Ödeme sayfası skimmer\'ı: betiğin yüklendiği sayfaları kaldırın, ödeme sağlayıcısını bilgilendirin, etkilenen kartlar için PCI olay sürecini başlatın, CSP ve SRI uygulayın.');
  if (cls.includes('credential-harvest') || (s.phishing ?? []).some((p) => p.credentials)) rec.push('Kimlik bilgisi toplama: ilgili hesapların parolalarını sıfırlatın, MFA zorunlu kılın, phishing uç noktalarını barındırıcıya bildirin.');
  if (cls.includes('keylogger')) rec.push('Tuş kaydedici: betiğin çalıştığı süre boyunca girilen tüm gizli bilgileri ele geçirilmiş sayın.');
  if (cls.includes('miner')) rec.push('Kripto madenci: betiği kaldırın, kaynak sunucudaki sızma noktasını araştırın.');
  if (cls.includes('redirect')) rec.push('Yönlendirme zinciri: hedef alan adlarını engelleyin, kullanıcıları bilgilendirin.');
  if ((report.crypto?.decrypted ?? []).length || (report.crypto?.keys ?? []).length) rec.push('Kodda gömülü şifreleme anahtarları var: bu anahtarlarla korunan tüm verileri açığa çıkmış kabul edin.');
  if (s.antibot?.detectsBot) rec.push('Betik bot/sandbox algılıyor: gerçek kullanıcıda farklı davranabilir; canlı ortam trafiğini ayrıca izleyin.');
  rec.push('Betiğin kaynağını (bağımlılık, CDN, etiket yöneticisi) belirleyin ve dosya bütünlüğü izleme (SRI/hash) ekleyin.');
  return rec;
}

/**
 * @param {object} o
 * @param {object} o.report  analyze() çıktısı (security alanı dahil)
 * @param {string} o.input   orijinal girdi
 * @param {string} o.output  çözülmüş kod
 * @param {object} [o.meta]  { title, analyst, source }
 * @param {boolean} [o.mask] gizli değerleri maskele (paylaşım için)
 */
export async function incidentReport({ report, input, output, meta = {}, mask = true }) {
  const now = new Date().toISOString();
  const [inHash, outHash] = await Promise.all([sha256(input), sha256(output)]);
  const r = report;
  const s = r.security ?? {};
  const risk = r.threat?.risk ?? { score: 0, level: 'none' };
  const iocRows = [];
  for (const k of ['domains', 'urls', 'ips', 'emails', 'wallets', 'jwts']) for (const v of r.iocs?.[k] ?? []) iocRows.push([k, v]);
  const md = [
    `# Olay müdahale raporu — ${meta.title ?? 'PEEL analizi'}`,
    '',
    `- Tarih: ${now}`,
    meta.analyst ? `- Analist: ${meta.analyst}` : null,
    meta.source ? `- Kaynak: ${meta.source}` : null,
    `- Girdi SHA-256: \`${inHash}\` (${input.length} bayt)`,
    `- Çözülmüş SHA-256: \`${outHash}\` (${output.length} bayt)`,
    `- Risk: **${risk.score}/100 (${risk.level})**`,
    '',
    '## Özet',
    (r.threat?.classes ?? []).length
      ? (r.threat.classes.map((c) => `- **${c.id}** (${c.score}): ${c.evidence.join('; ')}`).join('\n'))
      : '- Bilinen kötü amaçlı davranış kalıbı görülmedi.',
    '',
    '## Gizleme ve araç tespiti',
    table(['Araç', 'Skor', 'Kanıt'], (r.detection?.tools ?? []).slice(0, 10).map((d) => [d.name, d.score, d.evidence.join('; ')])),
    '',
    (r.detection?.versions ?? []).length ? table(['Araç', 'Sürüm', 'Kanıt'], r.detection.versions.map((v) => [v.tool, v.version, v.evidence])) : '',
    '',
    '## IOC\'ler',
    table(['Tür', 'Değer'], iocRows.slice(0, 300)),
    '',
    '## Exfiltration haritası',
    table(['Kaynak', 'Kodlama', 'API', 'Yöntem', 'Hedef', 'Yer'], (s.exfil ?? []).map((e) => [e.source, e.encoding, e.api, e.method, e.url, e.where])),
    '',
    '## Phishing / toplama uç noktaları',
    table(['URL', 'Tür', 'Kanal', 'Değerlendirme'], (s.phishing ?? []).map((p) => [p.url, p.kinds.join(', '), p.via.join(', '), p.verdict])),
    '',
    '## Ağ çağrıları (sandbox)',
    table(['API', 'Yöntem', 'URL', 'Gövde'], (r.runtime?.network ?? []).slice(0, 100).map((n) => [n.api, n.method, n.url, n.body])),
    '',
    '## Anti-bot',
    `- Bot tespit API'leri: ${(s.antibot?.apis ?? []).join(', ') || 'yok'}`,
    `- Bot koruma sağlayıcıları: ${(s.antibot?.vendors ?? []).join(', ') || 'yok'}`,
    s.antibot?.diff ? `- Gerçek tarayıcı / headless farkı: ${s.antibot.detectsBot ? 'VAR' : 'yok'} (yalnızca insan: ${s.antibot.diff.onlyHuman.length}, yalnızca bot: ${s.antibot.diff.onlyBot.length})` : '',
    '',
    '## Kripto',
    table(['Kaynak', 'Algoritma', 'Mod', 'Anahtar', 'Düz metin'], (r.crypto?.decrypted ?? []).map((d) => [d.source, d.alg, d.mode ?? '', d.key ?? '', d.text])),
    '',
    table(['Sabit', 'Tür', 'Kanıt'], (r.crypto?.constants ?? []).map((c) => [c.name, c.kind, c.evidence.join('; ')])),
    '',
    '## Kodlanmış string\'ler',
    table(['Değer', 'Kodlama', 'Katman', 'Çözülmüş'], (r.encodings ?? []).slice(0, 50).map((e) => [e.value, e.best.encoding, e.best.layers ?? 1, e.best.text])),
    '',
    '## Önerilen müdahale adımları',
    ...recommendations(r).map((x, i) => `${i + 1}. ${x}`),
    '',
    '## Tespit kuralları',
    r.threat?.yara ? `\`\`\`yara\n${r.threat.yara}\n\`\`\`` : '_YARA kuralı üretilemedi_',
    r.threat?.ids ? `\`\`\`\n${r.threat.ids}\n\`\`\`` : '',
    '',
    '## Zaman çizelgesi (pass süreleri)',
    table(['Pass', 'ms'], (r.passTimes ?? []).map((p) => [p.id, p.ms])),
  ].filter((x) => x !== null).join('\n');
  const json = {
    peel: 'incident', version: 1, generated: now, meta,
    hashes: { inputSha256: inHash, outputSha256: outHash },
    risk, classes: r.threat?.classes ?? [], iocs: r.iocs ?? {}, exfil: s.exfil ?? [], phishing: s.phishing ?? [],
    antibot: s.antibot ?? null, network: r.runtime?.network ?? [], crypto: r.crypto ?? null, detection: r.detection ?? null,
    recommendations: recommendations(r), yara: r.threat?.yara ?? null, ids: r.threat?.ids ?? null,
  };
  const jsonText = JSON.stringify(json, null, 2);
  // özetler uzun hex olduğu için maskeleme onları gizli değer sanar: maskelemeden önce yer tutucuya alınır
  const protect = (text) => text.replaceAll(inHash, '@@PEEL_IN_HASH@@').replaceAll(outHash, '@@PEEL_OUT_HASH@@');
  const restore = (text) => text.replaceAll('@@PEEL_IN_HASH@@', inHash).replaceAll('@@PEEL_OUT_HASH@@', outHash);
  return {
    markdown: mask ? restore(maskSecrets(protect(md)).code) : md,
    json: mask ? restore(maskSecrets(protect(jsonText)).code) : jsonText,
  };
}
