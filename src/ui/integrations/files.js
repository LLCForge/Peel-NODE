import { readAsar, isScript } from '../../integrations/asar.js';
import { symbolMap, renameAcross } from '../../integrations/multifile.js';
import { h, tx, busy, pickFiles, readText, download, MAX_FILE } from './dom.js';

// G154 Electron .asar açma ve G153 çoklu dosya sembol eşleme arayüzü.
const MAX_ASAR = 512 * 1024 * 1024;

function asarPanel(ctx) {
  const out = h('div', { class: 'pi-out', 'aria-live': 'polite' });
  const open = h('button', { type: 'button', class: 'primary' }, tx('.asar arşivi aç', 'Open .asar archive'));
  open.addEventListener('click', () => busy(open, out, async () => {
    const [f] = await pickFiles({ accept: '.asar' });
    if (!f) return;
    if (f.size > MAX_ASAR) throw new Error(tx('Arşiv çok büyük (en fazla 512 MB)', 'Archive too large (max 512 MB)'));
    const a = readAsar(new Uint8Array(await f.arrayBuffer()));
    const scripts = a.files.filter((x) => isScript(x.path) && !x.unpacked && !x.link);
    const filter = h('input', { type: 'search', class: 'pi-input', placeholder: tx('Filtre', 'Filter') });
    const list = h('div', { class: 'pi-list', role: 'list' });
    const draw = () => {
      const q = filter.value.toLowerCase();
      list.replaceChildren(...scripts.filter((x) => x.path.toLowerCase().includes(q)).slice(0, 500).map((x) => {
        const b = h('button', { type: 'button', class: 'pi-item', role: 'listitem' }, x.path, h('span', { class: 'pi-muted' }, ` ${x.size.toLocaleString()} B`));
        b.addEventListener('click', () => {
          if (x.size > MAX_FILE) { out.prepend(h('p', { class: 'pi-err' }, tx('Dosya çok büyük', 'File too large'))); return; }
          ctx.setInput(a.readText(x.path), x.path.split('/').pop());
        });
        return b;
      }));
    };
    filter.addEventListener('input', draw);
    draw();
    out.replaceChildren(h('p', {}, tx(`${f.name}: ${a.files.length} dosya, ${scripts.length} script. Bir script'e tıkla, girdiye yüklensin.`, `${f.name}: ${a.files.length} files, ${scripts.length} scripts. Click a script to load it.`)),
      a.files.some((x) => x.unpacked) ? h('p', { class: 'pi-muted' }, tx('Bazı dosyalar app.asar.unpacked klasöründe; arşivde verileri yok.', 'Some files live in app.asar.unpacked; their data is not in the archive.')) : '',
      filter, list);
  }));
  return h('div', {}, h('p', { class: 'pi-muted' }, tx('Electron uygulamalarının resources/app.asar dosyası tarayıcıda açılır; hiçbir şey yüklenmez.', 'An Electron app\'s resources/app.asar is opened in the browser; nothing is uploaded.')), open, out);
}

function symbolsPanel(ctx) {
  const out = h('div', { class: 'pi-out', 'aria-live': 'polite' });
  const open = h('button', { type: 'button', class: 'primary' }, tx('Birden çok script seç', 'Choose several scripts'));
  const deob = h('input', { type: 'checkbox', checked: true });
  open.addEventListener('click', () => busy(open, out, async () => {
    const picked = await pickFiles({ multiple: true });
    if (picked.length < 2) throw new Error(tx('En az iki dosya seç', 'Choose at least two files'));
    const files = [];
    for (const f of picked) {
      let code = await readText(f);
      if (deob.checked) {
        const r = await ctx.deobfuscate(code, { level: 4, sandbox: ctx.getSandbox(), deep: Boolean(ctx.getSandbox()) });
        if (!r.error) code = r.code;
      }
      files.push({ name: f.name, code });
    }
    const m = symbolMap(files);
    const renameFrom = h('input', { type: 'text', class: 'pi-input', placeholder: tx('eski ad', 'old name'), pattern: '[A-Za-z_$][\\w$]*' });
    const renameTo = h('input', { type: 'text', class: 'pi-input', placeholder: tx('yeni ad', 'new name'), pattern: '[A-Za-z_$][\\w$]*' });
    const apply = h('button', { type: 'button', class: 'ghost' }, tx('Tüm dosyalarda yeniden adlandır ve indir', 'Rename across files and download'));
    const res = h('div');
    apply.addEventListener('click', () => busy(apply, res, async () => {
      const renamed = await renameAcross(files, { [renameFrom.value.trim()]: renameTo.value.trim() });
      for (const f of renamed) if (f.renamed) download(f.name, f.code, 'text/javascript');
      res.replaceChildren(h('p', {}, renamed.map((f) => `${f.name}: ${f.renamed}`).join(' · ')));
    }));
    out.replaceChildren(
      h('h4', {}, tx('Dosyalar arası bağımlılıklar', 'Cross-file dependencies')),
      m.edges.length ? h('ul', {}, m.edges.map((e) => h('li', {}, `${e.from} → ${e.to}: `, h('code', {}, e.symbols.join(', '))))) : h('p', { class: 'pi-muted' }, tx('Paylaşılan sembol yok.', 'No shared symbols.')),
      h('h4', {}, tx('Paylaşılan semboller', 'Shared symbols')),
      h('table', { class: 'pi-table' }, h('tbody', {}, m.shared.map((s) => h('tr', {},
        h('td', {}, h('code', {}, s.name)),
        h('td', {}, [...new Set(s.definedIn.map((d) => `${d.file}:${d.line}`))].join(', ')),
        h('td', {}, [...new Set(s.usedIn.map((u) => u.file))].join(', ')))))),
      m.conflicts.length ? h('p', { class: 'pi-warn' }, `${tx('Birden çok dosyada tanımlı', 'Defined in several files')}: ${m.conflicts.map((s) => s.name).join(', ')}`) : '',
      m.errors.length ? h('p', { class: 'pi-err' }, m.errors.map((e) => `${e.file}: ${e.error}`).join(' · ')) : '',
      h('div', { class: 'pi-row' }, renameFrom, renameTo, apply), res,
    );
    ctx.setInput(files[0].code, files[0].name);
  }));
  return h('div', {}, h('p', { class: 'pi-muted' }, tx('Aynı sayfaya yüklenen script\'ler global kapsamı paylaşır: hangi dosyanın hangisine bağlı olduğu ve paylaşılan adlar çıkarılır.', 'Scripts on the same page share the global scope: dependencies between files and shared names are extracted.')),
    h('div', { class: 'pi-row' }, h('label', { class: 'pi-check' }, deob, tx('Önce çöz', 'Deobfuscate first')), open), out);
}

export function renderFiles(root, ctx) {
  root.replaceChildren(h('h4', {}, 'Electron .asar'), asarPanel(ctx), h('h4', {}, tx('Çoklu dosya sembol eşleme', 'Multi-file symbol map')), symbolsPanel(ctx));
}
