import { encodeShare, decodeShare, isEncrypted, shareUrl, MAX_FRAGMENT } from '../../integrations/share.js';
import { buildReportHtml } from '../../integrations/report-html.js';
import { fastImportStream } from '../../integrations/gitexport.js';
import { createProject, parseProject, serializeProject, upsertFile } from '../../integrations/project.js';
import { toSarif } from '../../integrations/sarif.js';
import { detectTechniques } from '../../integrations/techniques.js';
import { explainWhy } from '../../integrations/why.js';
import { anonymize, buildFixture, issueUrl } from '../../integrations/anonymize.js';
import { h, tx, busy, download, pickFiles, readText, field } from './dom.js';

// J196, G152, G151, H164, H173, J197 arayüzü: paylaşım ve dışa aktarma. Hiçbiri ağa istek atmaz;
// bağlantı içeriği yalnızca URL'nin # kısmındadır, dosyalar cihazda üretilip indirilir.

const baseName = (ctx) => (ctx.name() || 'peeled').replace(/\.(c|m)?js$/i, '');

export function renderShare(root, ctx) {
  const out = h('div', { class: 'pi-out', 'aria-live': 'polite' });
  const withOutput = h('input', { type: 'checkbox' });
  const password = h('input', { type: 'password', class: 'pi-input', autocomplete: 'new-password', minlength: 8, placeholder: tx('boş = şifresiz', 'empty = unencrypted') });
  const make = h('button', { type: 'button', class: 'primary' }, tx('Bağlantı oluştur', 'Create link'));

  make.addEventListener('click', () => busy(make, out, async () => {
    const input = ctx.getInput();
    if (!input.trim()) throw new Error(tx('Girdi boş', 'Input is empty'));
    const payload = { input, name: ctx.name() || undefined };
    if (withOutput.checked && ctx.getOutput()) payload.output = ctx.getOutput();
    const frag = await encodeShare(payload, { password: password.value || undefined });
    if (frag.length > MAX_FRAGMENT) throw new Error(tx('Kod bağlantı için çok büyük: .peel proje dosyası olarak paylaşın.', 'Code too large for a link: share a .peel project file instead.'));
    const url = shareUrl(location.href.split('#')[0], frag);
    const box = h('input', { type: 'text', class: 'pi-input', readOnly: true, value: url });
    const copy = h('button', { type: 'button', class: 'ghost' }, tx('Kopyala', 'Copy'));
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(url); copy.textContent = tx('Kopyalandı', 'Copied'); } catch { box.select(); }
    });
    out.replaceChildren(h('div', { class: 'pi-row' }, box, copy), h('p', { class: 'pi-muted' },
      tx(`${url.length.toLocaleString()} karakter. İçerik yalnızca # sonrasında; sunucuya gönderilmez.`, `${url.length.toLocaleString()} characters. Content lives only after #; it is never sent to a server.`),
      password.value ? tx(' Parolayı bağlantıyla aynı kanaldan göndermeyin.', ' Do not send the password over the same channel as the link.') : ''));
  }));

  const exportsOut = h('div', { class: 'pi-out' });
  const btn = (label, fn) => {
    const b = h('button', { type: 'button', class: 'ghost' }, label);
    b.addEventListener('click', () => busy(b, exportsOut, fn));
    return b;
  };
  const requireRun = () => {
    const last = ctx.last();
    if (!last) throw new Error(tx('Önce kodu çöz', 'Deobfuscate first'));
    return last;
  };

  const html = btn(tx('Önce/sonra raporu (HTML)', 'Before/after report (HTML)'), async () => {
    const l = requireRun();
    download(`${baseName(ctx)}.report.html`, buildReportHtml({
      input: l.input, output: l.output, report: l.report, techniques: detectTechniques(l.input), reasons: explainWhy({ input: l.input, report: l.report }), name: ctx.name() || 'script.js', lang: tx('tr', 'en'),
    }), 'text/html');
  });
  const git = btn(tx('Pass adımları (git)', 'Pass steps (git)'), async () => {
    const l = requireRun();
    download(`${baseName(ctx)}.fi`, fastImportStream({ input: l.input, snapshots: l.snapshots, output: l.output, file: `${baseName(ctx).replace(/[^\w.-]/g, '_')}.js` }), 'text/plain');
    exportsOut.replaceChildren(h('p', { class: 'pi-muted' }, tx('İçe almak için:', 'To import:'), ' ', h('code', {}, `git init peel-steps && cd peel-steps && git fast-import < ${baseName(ctx)}.fi && git checkout main`)));
  });
  const sarif = btn('SARIF', async () => {
    const l = requireRun();
    if (!l.report) throw new Error(tx('Rapor henüz hazır değil', 'Report not ready yet'));
    download(`${baseName(ctx)}.sarif`, JSON.stringify(toSarif(l.report, { output: l.output, uri: `${baseName(ctx)}.js` }), null, 2), 'application/sarif+json');
  });
  const saveProject = btn(tx('Projeyi kaydet (.peel)', 'Save project (.peel)'), async () => {
    const input = ctx.getInput();
    let p = ctx.project() ?? createProject({ name: baseName(ctx) });
    p = upsertFile(p, { name: ctx.name() || 'script.js', input, output: ctx.getOutput() });
    p = { ...p, rules: ctx.rulesText() };
    ctx.setProject(p);
    download(`${baseName(ctx)}.peel`, serializeProject(p), 'application/json');
  });
  const openProject = btn(tx('Proje aç', 'Open project'), async () => {
    const [f] = await pickFiles({ accept: '.peel,application/json' });
    if (!f) return;
    const p = parseProject(await readText(f));
    ctx.setProject(p);
    if (p.rules) ctx.setRulesText(p.rules);
    const first = p.files[0];
    if (first) {
      ctx.setInput(first.input, first.name);
      if (first.output) ctx.setOutput(first.output);
    }
    exportsOut.replaceChildren(h('p', {}, tx(`"${p.name}" açıldı: ${p.files.length} dosya.`, `Opened "${p.name}": ${p.files.length} files.`)),
      ...p.files.map((fl) => {
        const b = h('button', { type: 'button', class: 'tiny' }, fl.label ? `[${fl.label}] ${fl.name}` : fl.name);
        b.addEventListener('click', () => { ctx.setInput(fl.input, fl.name); if (fl.output) ctx.setOutput(fl.output); });
        return b;
      }));
  });

  // J197: anonimleştirilmiş fixture
  const fixture = btn(tx('Anonim fixture hazırla', 'Prepare anonymous fixture'), async () => {
    const l = requireRun();
    const a = anonymize(l.input, { output: l.output });
    const text = buildFixture({ code: a.code, note: `katkı: ${ctx.name() || 'script.js'}` });
    const parts = [h('p', {}, `${tx('Değiştirilen', 'Replaced')}: ${Object.entries(a.replaced).map(([k, v]) => `${k}×${v}`).join(', ') || '-'}`)];
    if (a.leaks.length) {
      parts.push(h('p', { class: 'pi-warn', role: 'alert' }, tx('Çözülmüş çıktıda kodlanmış göstergeler var; girdi bunları gizli taşıyor. Bu örneği paylaşmayın ya da önce elle temizleyin:', 'The deobfuscated output contains encoded indicators hidden in the input. Do not share this sample, or clean it by hand first:')),
        h('ul', {}, a.leaks.slice(0, 20).map((x) => h('li', {}, h('code', {}, `${x.kind}: ${x.value}`)))));
    } else {
      const dl = h('button', { type: 'button', class: 'ghost' }, tx('Fixture dosyasını indir', 'Download fixture file'));
      dl.addEventListener('click', () => download(`${baseName(ctx)}.fixture.js`, text, 'text/javascript'));
      parts.push(dl);
      const u = issueUrl({ title: `Fixture: ${ctx.name() || 'script.js'}`, fixture: text });
      parts.push(u
        ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', class: 'ghost pi-link' }, tx('GitHub issue taslağı aç', 'Open GitHub issue draft'))
        : h('p', { class: 'pi-muted' }, tx('Fixture issue adresine sığmıyor: dosyayı issue\'ya elle ekleyin.', 'Fixture too large for an issue URL: attach the file manually.')));
    }
    exportsOut.replaceChildren(...parts);
  });

  root.replaceChildren(
    h('h4', {}, tx('Paylaşılabilir bağlantı', 'Shareable link')),
    h('div', { class: 'pi-row' }, h('label', { class: 'pi-check' }, withOutput, tx('Çözülmüş çıktıyı da ekle', 'Include deobfuscated output')), field(tx('Parola (uçtan uca şifreleme)', 'Password (end-to-end encryption)'), password), make),
    out,
    h('h4', {}, tx('Dışa aktar', 'Export')),
    h('div', { class: 'pi-row pi-wrap' }, html, git, sarif, saveProject, openProject, fixture),
    exportsOut,
  );
}

/** Sayfa #peel=... ile açıldıysa içeriği girdiye yükler; şifreliyse parola ister. Fragment adres çubuğundan silinir. */
export async function loadSharedFragment(ctx) {
  const frag = location.hash;
  if (!frag.startsWith('#peel=')) return;
  history.replaceState(null, '', location.pathname + location.search);
  let password;
  if (isEncrypted(frag)) {
    password = await askPassword();
    if (password === null) return;
  }
  try {
    const p = await decodeShare(frag, { password });
    if (!p) return;
    ctx.setInput(p.input, p.name);
    if (p.output) ctx.setOutput(p.output);
    ctx.notify(tx('Paylaşılan kod yüklendi', 'Shared code loaded'), 'ok');
  } catch (e) {
    ctx.notify(e.message, 'err');
  }
}

function askPassword() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'password', class: 'pi-input', autocomplete: 'off', required: true });
    // Vazgeç submit değil: Enter her zaman "Aç" ile gönderir
    const cancel = h('button', { type: 'button', class: 'ghost' }, tx('Vazgeç', 'Cancel'));
    const dlg = h('dialog', { class: 'pi-dialog pi-small', 'aria-label': tx('Parola', 'Password') },
      h('form', { method: 'dialog' },
        h('p', {}, tx('Bu paylaşım parola ile şifrelenmiş.', 'This share is password-protected.')),
        field(tx('Parola', 'Password'), input),
        h('div', { class: 'pi-row' }, cancel, h('button', { value: 'ok', class: 'primary' }, tx('Aç', 'Open')))));
    // sonuç submit/vazgeç/Escape anında verilir; yalnızca 'close' olayına güvenilmez (bazı gömülü tarayıcılar geciktirir)
    let done = false;
    const settle = (value) => {
      if (done) return;
      done = true;
      resolve(value);
      if (dlg.open) dlg.close();
      dlg.remove();
    };
    cancel.addEventListener('click', () => settle(null));
    dlg.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); settle(input.value); });
    dlg.addEventListener('cancel', () => settle(null));
    dlg.addEventListener('close', () => settle(dlg.returnValue === 'ok' ? input.value : null));
    document.body.append(dlg);
    dlg.showModal();
  });
}
