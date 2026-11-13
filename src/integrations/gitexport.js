// G151: çözümü pass pass bir git commit dizisine çevirir. Çıktı `git fast-import` akışıdır:
// git kurulu olmayan ortamda (tarayıcı) da üretilir, sonra `git fast-import < dosya` ile içe alınır.
// Her commit bir pass'in değişikliğidir; `git log -p` hangi pass'in neyi değiştirdiğini gösterir.

const enc = new TextEncoder();
const bytes = (s) => enc.encode(s).length;

function data(text) {
  return `data ${bytes(text)}\n${text}\n`;
}

/**
 * @param {object} o
 * @param {string} o.input                         ham girdi
 * @param {Array<{id: string, round: number, code: string}>} o.snapshots  pipeline onSnapshot kayıtları (sırayla)
 * @param {string} [o.output]                      son (biçimlendirilmiş) çıktı
 * @param {string} [o.file]                        depodaki dosya adı
 * @param {string} [o.branch]
 * @param {number} [o.time]                        commit zamanı (saniye)
 * @returns {string}
 */
export function fastImportStream({ input, snapshots = [], output, file = 'peeled.js', branch = 'main', time = Math.floor(Date.now() / 1000) }) {
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(file) || file.split('/').some((p) => p === '..' || p === '.')) throw new Error(`Geçersiz dosya adı: ${file}`);
  if (!/^[\w.-]+$/.test(branch)) throw new Error(`Geçersiz dal adı: ${branch}`);
  const steps = [{ msg: 'girdi: ham obfuscated kod', code: input }];
  for (const s of snapshots) {
    steps.push({ msg: s.id === 'girdi' ? 'parse: metin katmanları açıldı' : `pass: ${s.id} (tur ${s.round})`, code: s.code });
  }
  if (typeof output === 'string') steps.push({ msg: 'son: biçimlendirme', code: output });

  let out = '';
  let mark = 0;
  let prevCommit = null;
  let prevCode = null;
  let n = 0;
  for (const s of steps) {
    if (s.code === prevCode) continue; // içerik değişmediyse boş commit üretme
    const blob = ++mark;
    out += `blob\nmark :${blob}\n${data(s.code)}`;
    const commit = ++mark;
    const t = time + n++;
    out += `commit refs/heads/${branch}\nmark :${commit}\n`;
    out += `author PEEL <peel@localhost> ${t} +0000\ncommitter PEEL <peel@localhost> ${t} +0000\n`;
    out += data(s.msg);
    if (prevCommit) out += `from :${prevCommit}\n`;
    out += `M 100644 :${blob} ${file}\n\n`;
    prevCommit = commit;
    prevCode = s.code;
  }
  return `${out}done\n`;
}

export const commitCount = (stream) => (stream.match(/^commit /gm) ?? []).length;
