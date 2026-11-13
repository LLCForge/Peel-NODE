// Rapordaki salt-okunur güvenlik/motor bulguları: araç tespiti ve profil, ayarlar, sürümler, decoder zinciri,
// pass güveni, exfiltration haritası, anti-bot, phishing uç noktaları, kripto ve istatistik.
import { el, muted, h4, table, chips, section, tr } from './dom.js';

export function renderDetection(root, data) {
  const d = data.detection;
  if (!d) return;
  const tools = table([tr('Araç', 'Tool'), tr('Skor', 'Score'), tr('Kanıt', 'Evidence'), tr('Profil', 'Profile')],
    d.tools.slice(0, 12).map((x) => [x.name, x.score, x.evidence.join(' · '), x.profile]), ['', 'num', 'rep-muted', 'mono']);
  root.append(section(tr('Obfuscator parmak izi', 'Obfuscator fingerprint'),
    tools ?? muted(tr('Bilinen bir araç imzası bulunamadı.', 'No known tool signature found.')),
    el('p', { class: 'rep-muted' }, `${tr('Otomatik profil', 'Automatic profile')}: `, el('b', {}, d.profile.profile), ` — ${d.profile.reason}`),
    d.versions.length ? h4(tr('Sürüm', 'Version')) : null,
    table([tr('Araç', 'Tool'), tr('Sürüm', 'Version'), tr('Kanıt', 'Evidence')], d.versions.map((v) => [v.tool, v.version, v.evidence]), ['', 'mono', 'rep-muted']),
    d.chains.maxDepth ? el('p', { class: 'rep-muted' }, `${tr('Decoder zinciri derinliği', 'Decoder chain depth')}: ${d.chains.maxDepth}`) : null,
    table([tr('Fonksiyon', 'Function'), tr('Katman', 'Layers')], d.chains.chains.map((c) => [c.name, c.depth]), ['mono', 'num'])));
  if (data.passConfidence?.length) {
    root.append(section(tr('Pass güven skoru', 'Pass confidence'),
      table(['Pass', tr('Güven', 'Confidence'), 'ok', tr('geri alma', 'rollbacks'), tr('Gerekçe', 'Reason')],
        data.passConfidence.map((p) => [p.id, p.score, p.ok, p.fail, p.reasons.join(' · ')]), ['mono', 'num', 'num', 'num', 'rep-muted'])));
  }
}

export function renderRuntimeSecurity(root, data) {
  const s = data.security;
  if (!s) return;
  root.append(section(tr('Exfiltration haritası', 'Exfiltration map'),
    table([tr('Kaynak', 'Source'), tr('Kodlama', 'Encoding'), 'API', tr('Yöntem', 'Method'), tr('Hedef', 'Target'), tr('Yer', 'Where')],
      s.exfil.map((e) => [e.source, e.encoding, e.api, e.method || '–', e.url, e.where]), ['mono', 'mono', 'mono', '', 'mono', ''])
      ?? muted(tr('İşaretli çerez/depolama/UA verisi hiçbir ağ çağrısında görülmedi.', 'No marked cookie/storage/UA data seen in any network call.'))));
  const ab = s.antibot;
  root.append(section(tr('Anti-bot sinyalleri', 'Anti-bot signals'),
    ab.diff ? el('p', {}, ab.detectsBot
      ? tr('Program gerçek tarayıcı ve headless bot profilinde FARKLI davranıyor.', 'The program behaves DIFFERENTLY in a real browser vs a headless bot profile.')
      : tr('Gerçek tarayıcı ve headless profilde davranış aynı.', 'Same behaviour in real-browser and headless profiles.')) : muted(tr('Profil karşılaştırması için sandbox gerekli.', 'Sandbox required for profile comparison.')),
    ab.apis.length ? h4(tr('Bot tespit API\'leri', 'Bot detection APIs')) : null, chips(ab.apis),
    ab.vendors.length ? h4(tr('Bot koruma sağlayıcıları', 'Bot protection vendors')) : null, chips(ab.vendors),
    ab.diff && ab.diff.onlyHuman.length ? h4(tr('Yalnızca gerçek tarayıcıda', 'Only in real browser')) : null,
    ab.diff ? table(['', ''], ab.diff.onlyHuman.map((x) => [tr('insan', 'human'), x]), ['rep-muted', 'mono']) : null,
    ab.diff && ab.diff.onlyBot.length ? h4(tr('Yalnızca bot profilinde', 'Only in bot profile')) : null,
    ab.diff ? table(['', ''], ab.diff.onlyBot.map((x) => ['bot', x]), ['rep-muted', 'mono']) : null));
  root.append(section(tr('Phishing / toplama uç noktaları', 'Phishing / collection endpoints'),
    table(['URL', tr('Tür', 'Kind'), tr('Kanal', 'Channel'), tr('Değerlendirme', 'Verdict')],
      s.phishing.map((p) => [p.url, p.kinds.join(', ') || '–', p.via.join(', '), p.verdict]), ['mono', '', 'rep-muted', ''])
      ?? muted(tr('Şüpheli toplama uç noktası bulunamadı.', 'No suspicious collection endpoint found.'))));
}

export function renderCrypto(root, data) {
  const c = data.crypto;
  if (c) {
    const empty = !c.constants.length && !c.calls.length && !c.decrypted.length && !c.rsa.length && !c.keys.length;
    root.append(section(tr('Kripto', 'Cryptography'),
      empty ? muted(tr('Kripto sabiti, çağrısı ya da anahtarı bulunamadı.', 'No crypto constants, calls or keys found.')) : null,
      c.constants.length ? h4(tr('Şifre / hash sabitleri', 'Cipher / hash constants')) : null,
      table([tr('İmza', 'Signature'), tr('Tür', 'Kind'), tr('Kanıt', 'Evidence')], c.constants.map((x) => [x.name, x.kind, x.evidence.join(' · ')]), ['', 'mono', 'mono']),
      c.calls.length ? h4(tr('Kripto çağrıları', 'Crypto calls')) : null,
      table(['API', 'op', tr('Algoritma', 'Algorithm'), tr('Mod', 'Mode'), tr('Anahtar', 'Key'), 'IV', tr('Dolgu', 'Padding')],
        c.calls.map((x) => [x.api, x.op, x.alg, x.mode, x.key, x.iv, x.padding]), ['mono', '', '', '', 'mono', 'mono', '']),
      c.keys.length ? h4(tr('Anahtar adayları', 'Key candidates')) : null,
      table([tr('Ad', 'Name'), tr('Değer', 'Value')], c.keys.map((k) => [k.name, k.value]), ['mono', 'mono']),
      c.ivs.length || c.salts.length ? h4(tr('IV / tuz', 'IV / salt')) : null,
      table([tr('Tür', 'Kind'), tr('Ad', 'Name'), tr('Değer', 'Value')], [...c.ivs.map((v) => ['IV', v.name, v.value]),
        ...c.salts.map((v) => [v.kind, v.value, `${v.salt}${v.iterations ? ` · ${v.iterations} iter` : ''}`])], ['', 'mono', 'mono']),
      c.modes.length ? h4(tr('Mod', 'Mode')) : null, chips(c.modes.map((m) => `${m.mode} · ${m.where}`)),
      c.paddings.length ? h4(tr('Dolgu', 'Padding')) : null, chips(c.paddings),
      c.decrypted.length ? h4(tr('Çözülen şifreli veri', 'Decrypted embedded data')) : null,
      table([tr('Kaynak', 'Source'), tr('Algoritma', 'Algorithm'), tr('Mod', 'Mode'), tr('Anahtar', 'Key'), 'IV', tr('Dolgu', 'Padding'), tr('Düz metin', 'Plaintext')],
        c.decrypted.map((x) => [x.source, x.alg, x.mode, x.key, x.iv, x.padding, x.text]), ['rep-muted', '', '', 'mono', 'mono', '', 'mono']),
      c.rsa.length ? h4('RSA') : null,
      table([tr('Kaynak', 'Source'), tr('Bit', 'Bits'), tr('Özel', 'Private'), tr('Kurtarma', 'Recovery'), tr('Çözülen', 'Decrypted')],
        c.rsa.map((k) => [k.source, k.bits, k.private ? tr('evet', 'yes') : tr('hayır', 'no'), k.recovered ?? '–', k.decrypted.map((x) => x.text).join(' | ') || '–']), ['', 'num', '', '', 'mono'])));
  }
  const st = data.statistics;
  if (st) {
    const code = st.code;
    root.append(section(tr('Entropi ve istatistik', 'Entropy and statistics'),
      code ? el('p', { class: 'rep-muted' }, `${tr('Kod', 'Code')}: ${tr('entropi', 'entropy')} ${code.entropy.entropy} bit/${tr('karakter', 'char')} · ${tr('sıkıştırma oranı', 'compression ratio')} ${code.compression.ratio} (${code.compression.method}) · ${tr('alfabe', 'alphabet')} ${code.distribution.alphabetSize}`) : null,
      table([tr('Blob', 'Blob'), tr('Uzunluk', 'Length'), tr('Entropi', 'Entropy'), tr('Karar', 'Verdict'), tr('Sıkıştırma', 'Compression'), 'IoC', 'ECB', tr('Rastgele', 'Random'), 'Kasiski', tr('Kurtarılan', 'Recovered')],
        st.blobs.map((b) => [b.value, b.length, (b.bytes ?? b.string).entropy, (b.bytes ?? b.string).verdict, b.compression ? b.compression.ratio : '–', b.ioc,
          b.ecb ? `${b.ecb.repeats}×${b.ecb.blockSize}` : '–', b.randomness ? (b.randomness.looksRandom ? 'evet' : `hayır (p=${b.randomness.monobitP})`) : '–',
          b.kasiski.map((k) => k.len).join(',') || '–',
          b.decompressed ? `${b.decompressed.format} (${b.decompressed.size} B): ${b.decompressed.text.slice(0, 80)}` : b.recovered ? `${b.recovered.method} [${b.recovered.key}] ${b.recovered.language?.lang ?? ''}: ${b.recovered.text.slice(0, 80)}` : b.affine ? `afin a=${b.affine.a} b=${b.affine.b}: ${b.affine.text.slice(0, 60)}` : '–']),
        ['mono', 'num', 'num', '', 'num', 'num', 'mono', '', 'mono', 'mono'])
        ?? muted(tr('Yüksek entropili gömülü veri bulunamadı.', 'No high-entropy embedded data found.'))));
  }
}
