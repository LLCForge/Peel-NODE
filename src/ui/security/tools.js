// Etkileşimli güvenlik ve motor araçları. Ağ isteği yalnızca npm karşılaştırmasında ve yalnızca kullanıcı
// hedef adresi gördükten sonra ikinci bir tıklamayla yapılır. Aile koleksiyonu ve takip geçmişi oturum
// belleğindedir; kalıcılık için JSON dışa/içe aktarılır.
import { el, muted, h4, table, button, chips, tool, field, status, tr } from './dom.js';
import { incidentReport } from '../../security/incident.js';
import { metadataUrl, validatePackage, fetchPublished, compareWithPublished } from '../../security/npm.js';
import { analyzeExtension } from '../../security/extension.js';
import { createCollection, sampleFeatures } from '../../security/families.js';
import { createTracker, snapshot } from '../../security/tracking.js';
import { searchPassOrder, cascade, deobfuscateRegion, rollbackChain } from '../../core/search.js';
import { splitBundle, moduleFiles } from '../../core/bundle.js';
import { attachInlineMap, generateSourceMap } from '../../core/sourcemap.js';
import { zipStore } from '../../security/archive.js';

const collection = createCollection();
const tracker = createTracker();

const input = (attrs = {}) => el('input', { type: 'text', class: 'sec-input', autocomplete: 'off', spellcheck: 'false', ...attrs });
const fileInput = (accept, onFile) => el('input', { type: 'file', accept, class: 'sec-file', onchange: (e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; } });
const fail = (out, e) => { out.textContent = `${tr('Hata', 'Error')}: ${e.message ?? e}`; };
const busy = async (btn, out, fn) => {
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try { await fn(); } catch (e) { fail(out, e); } finally { btn.disabled = false; btn.removeAttribute('aria-busy'); }
};

function incidentTool(report, a) {
  const title = input({ value: tr('Şüpheli betik', 'Suspicious script') });
  const mask = el('input', { type: 'checkbox', checked: true });
  const out = status();
  const make = async (kind) => {
    const r = await incidentReport({ report, input: a.getInput(), output: a.getOutput(), meta: { title: title.value.slice(0, 200) }, mask: mask.checked });
    if (kind === 'md') a.download('peel-incident.md', r.markdown, 'text/markdown');
    else a.download('peel-incident.json', r.json, 'application/json');
    out.textContent = tr('Rapor indirildi.', 'Report downloaded.');
  };
  return tool(tr('Olay müdahale raporu', 'Incident response report'),
    field(tr('Başlık', 'Title'), title),
    el('label', { class: 'sec-check' }, mask, ` ${tr('Gizli değerleri maskele', 'Mask secrets')}`),
    el('div', { class: 'rep-actions' }, button(tr('Markdown indir', 'Download Markdown'), () => make('md').catch((e) => fail(out, e))),
      button(tr('JSON indir', 'Download JSON'), () => make('json').catch((e) => fail(out, e)))), out);
}

function npmTool(a) {
  const name = input({ placeholder: 'left-pad', maxlength: '214' });
  const version = input({ placeholder: '1.3.0', value: 'latest', maxlength: '64' });
  const path = input({ placeholder: tr('isteğe bağlı: lib/index.js', 'optional: lib/index.js') });
  const out = status();
  const result = el('div');
  const confirm = el('div');
  let controller = null;
  const prepare = () => {
    confirm.textContent = '';
    result.textContent = '';
    const err = validatePackage(name.value.trim(), version.value.trim());
    if (err) { out.textContent = err; return; }
    const url = metadataUrl(name.value.trim(), version.value.trim());
    out.textContent = '';
    const go = button(tr('İndir ve karşılaştır', 'Download and compare'), () => busy(go, out, async () => {
      controller = new AbortController();
      out.textContent = tr('İndiriliyor…', 'Downloading…');
      const pub = await fetchPublished(name.value.trim(), version.value.trim(), { signal: controller.signal });
      const cmp = await compareWithPublished(a.getText(), pub, path.value.trim() || null);
      out.textContent = `${pub.name}@${pub.version} · ${tr('bütünlük', 'integrity')}: ${pub.integrity.reason} · ${cmp.verdict ?? tr('eşleşen dosya yok', 'no matching file')}`;
      result.replaceChildren(
        el('p', { class: 'rep-muted' }, `${tr('Dosya', 'File')}: ${cmp.file ?? '–'}${cmp.similarity != null ? ` (${tr('benzerlik', 'similarity')} ${cmp.similarity})` : ''} · +${cmp.addedCount ?? 0} / −${cmp.removedCount ?? 0}`),
        Object.keys(cmp.installScripts).length ? h4(tr('Kurulum betikleri', 'Install scripts')) : null,
        chips(Object.entries(cmp.installScripts).map(([k, v]) => `${k}: ${v}`)),
        cmp.newApis?.length ? h4(tr('Yeni şüpheli API\'ler', 'New suspicious APIs')) : null, chips(cmp.newApis ?? []),
        cmp.newUrls?.length ? h4(tr('Yeni URL\'ler', 'New URLs')) : null, chips(cmp.newUrls ?? []),
        cmp.added?.length ? h4(tr('Yayımlanan sürümde olmayan satırlar', 'Lines not in the published version')) : null,
        table(['+'], (cmp.added ?? []).map((l) => [l.slice(0, 300)]), ['mono']));
    }));
    confirm.replaceChildren(el('p', {}, tr('Şu adrese istek gönderilecek (yalnızca paket adı ve sürüm; kodunuz gönderilmez):', 'A request will be sent to (package name and version only; your code is not sent):')),
      el('p', { class: 'mono' }, url), el('p', { class: 'rep-muted' }, tr('Ardından metadata\'daki registry.npmjs.org tarball adresi indirilecek.', 'Then the registry.npmjs.org tarball listed in the metadata is downloaded.')),
      el('div', { class: 'rep-actions' }, go, button(tr('Vazgeç', 'Cancel'), () => { controller?.abort(); confirm.textContent = ''; })));
  };
  return tool(tr('npm supply-chain karşılaştırması', 'npm supply-chain comparison'),
    muted(tr('Analiz edilen betik, npm\'de yayımlanmış sürümdeki dosyayla karşılaştırılır.', 'The analysed script is compared with the file in the published npm version.')),
    field(tr('Paket', 'Package'), name), field(tr('Sürüm', 'Version'), version), field(tr('Paket içi yol', 'Path in package'), path),
    el('div', { class: 'rep-actions' }, button(tr('Hedefi göster', 'Show target'), prepare)), confirm, out, result);
}

function extensionTool(a) {
  const out = status();
  const result = el('div');
  const onFile = async (f) => {
    if (f.size > 100 << 20) { out.textContent = tr('Dosya 100 MB sınırını aşıyor.', 'File exceeds the 100 MB limit.'); return; }
    try {
      const ext = analyzeExtension(new Uint8Array(await f.arrayBuffer()));
      out.textContent = `${ext.name} ${ext.version} · ${ext.format.toUpperCase()} · MV${ext.manifestVersion ?? '?'} · risk ${ext.risk.score} (${ext.risk.level})`;
      result.replaceChildren(
        ext.findings.length ? h4(tr('Bulgular', 'Findings')) : null, chips(ext.findings),
        h4(tr('İzinler', 'Permissions')),
        table([tr('İzin', 'Permission'), 'risk'], ext.permissions.map((p) => [p.permission, p.risk]), ['mono', '']) ?? muted('–'),
        ext.contentScripts.length ? h4(tr('İçerik betikleri', 'Content scripts')) : null,
        table(['matches', 'js', 'run_at'], ext.contentScripts.map((c) => [c.matches.join(' '), c.js.join(' '), c.runAt]), ['mono', 'mono', '']),
        ext.background.length ? el('p', { class: 'rep-muted' }, `${tr('Arka plan', 'Background')}: ${ext.background.join(', ')}`) : null,
        ext.csp ? el('p', { class: 'rep-muted' }, `CSP: ${ext.csp}`) : null,
        h4(tr('Betikler', 'Scripts')),
        ext.scripts.length ? el('table', { class: 'rep-table' }, el('tbody', {}, ...ext.scripts.slice(0, 60).map((s) => el('tr', {},
          el('td', { class: 'mono' }, s.name), el('td', { class: 'rep-muted' }, [...s.tools, ...s.apis].join(' · ') || '–'),
          el('td', { class: 'mono' }, s.domains.join(' ') || '–'),
          el('td', {}, button(tr('Girdiye yükle', 'Load as input'), () => { a.setInput(ext.read(s.name) ?? ''); out.textContent = `${s.name} ${tr('girdiye yüklendi', 'loaded as input')}`; }, 'ghost small'))))))
          : muted(tr('JS dosyası yok.', 'No JS files.')),
        el('p', { class: 'rep-muted' }, `${ext.files.length} ${tr('dosya', 'files')}`));
    } catch (e) { fail(out, e); }
  };
  return tool(tr('Tarayıcı eklentisi (.crx/.xpi) analizi', 'Browser extension (.crx/.xpi) analysis'),
    muted(tr('Paket tarayıcıda açılır; hiçbir yere gönderilmez.', 'The package is unpacked in the browser; nothing is uploaded.')),
    field(tr('Eklenti dosyası', 'Extension file'), fileInput('.crx,.xpi,.zip', onFile)), out, result);
}

function familiesTool(report, a) {
  const label = input({ value: `${tr('örnek', 'sample')} ${collection.list().length + 1}`, maxlength: '200' });
  const threshold = el('input', { type: 'number', min: '0.1', max: '1', step: '0.05', value: '0.6', class: 'sec-input' });
  const out = status();
  const result = el('div');
  const show = () => {
    const fams = collection.families(Number(threshold.value) || 0.6);
    result.replaceChildren(table([tr('Aile', 'Family'), tr('Boyut', 'Size'), tr('Polimorfik', 'Polymorphic'), tr('Üyeler', 'Members'), tr('Ortak IOC', 'Shared IOCs')],
      fams.map((f) => [f.family, f.size, f.polymorphic ? tr('evet', 'yes') : '–', f.members.map((m) => m.label).join(', '), f.sharedIocs.join(', ') || '–']), ['mono', 'num', '', '', 'mono'])
      ?? muted(tr('Koleksiyon boş.', 'Collection is empty.')));
  };
  return tool(tr('Polimorfik varyant aileleri', 'Polymorphic variant families'),
    muted(tr('Çözülmüş çıktılar gizlemeden bağımsız özelliklerle (MinHash, AST şekli, IOC) kümelenir.', 'Deobfuscated outputs are clustered by obfuscation-independent features (MinHash, AST shape, IOCs).')),
    field(tr('Etiket', 'Label'), label), field(tr('Benzerlik eşiği', 'Similarity threshold'), threshold),
    el('div', { class: 'rep-actions' },
      button(tr('Bu örneği ekle', 'Add this sample'), () => {
        const n = collection.add(sampleFeatures({ label: label.value.trim() || 'örnek', output: a.getOutput(), iocs: report.iocs, fingerprint: report.fingerprint }));
        out.textContent = `${n} ${tr('örnek', 'samples')}`;
        show();
      }),
      button(tr('Aileleri göster', 'Show families'), show),
      button(tr('Dışa aktar', 'Export'), () => a.download('peel-families.json', collection.export(), 'application/json')),
      button(tr('Koleksiyonu temizle', 'Clear collection'), () => { collection.clear(); show(); })),
    field(tr('İçe aktar', 'Import'), fileInput('.json', async (f) => { try { out.textContent = `+${collection.import(await f.text())}`; show(); } catch (e) { fail(out, e); } })),
    out, result);
}

function trackingTool(report, a) {
  const label = input({ placeholder: 'https://cdn.example.com/app.js', maxlength: '300' });
  const out = status();
  const result = el('div');
  return tool(tr('Script değişim takibi', 'Script change tracking'),
    muted(tr('Aynı etiketli betiğin her analizi önceki sürümüyle karşılaştırılır.', 'Each analysis of a script with the same label is compared with its previous version.')),
    field(tr('Betik etiketi (URL ya da ad)', 'Script label (URL or name)'), label),
    el('div', { class: 'rep-actions' },
      button(tr('Kaydet ve karşılaştır', 'Record and compare'), () => {
        const l = label.value.trim();
        if (!l) { out.textContent = tr('Etiket gerekli.', 'Label required.'); return; }
        const ch = tracker.record(snapshot({ label: l, report, output: a.getOutput() }));
        out.textContent = `${tracker.history(l).length} ${tr('sürüm kayıtlı', 'versions recorded')}`;
        if (!ch) { result.replaceChildren(muted(tr('İlk kayıt: karşılaştırılacak önceki sürüm yok.', 'First record: no previous version to compare.'))); return; }
        const row = (k, d) => [k, d.added.join(', ') || '–', d.removed.join(', ') || '–'];
        result.replaceChildren(
          el('p', {}, ch.changed ? `${tr('Değişti', 'Changed')}: +${ch.linesAdded} / −${ch.linesRemoved} ${tr('satır', 'lines')}, risk ${ch.riskDelta >= 0 ? '+' : ''}${ch.riskDelta}` : tr('Değişiklik yok.', 'No change.')),
          chips(ch.alerts),
          table(['', tr('eklenen', 'added'), tr('kaldırılan', 'removed')], [row('domain', ch.domains), row('url', ch.urls), row('ip', ch.ips), row('API', ch.apis), row(tr('sınıf', 'class'), ch.classes)]
            .filter((r) => r[1] !== '–' || r[2] !== '–'), ['', 'mono', 'mono']));
      }),
      button(tr('Geçmişi dışa aktar', 'Export history'), () => a.download('peel-tracking.json', tracker.export(), 'application/json'))),
    field(tr('Geçmişi içe aktar', 'Import history'), fileInput('.json', async (f) => { try { out.textContent = `+${tracker.import(await f.text())}`; } catch (e) { fail(out, e); } })),
    out, result);
}

function engineTool(a) {
  const out = status();
  const result = el('div');
  const apply = (code) => button(tr('Sonucu çıktıya yaz', 'Write result to output'), () => { a.setOutput(code); out.textContent = tr('Çıktı güncellendi.', 'Output updated.'); });
  const order = button(tr('Pass sırası ara', 'Search pass order'), () => busy(order, out, async () => {
    out.textContent = tr('Sıralar deneniyor…', 'Trying orders…');
    const r = await searchPassOrder(a.getInput(), { sandbox: a.sandbox, extra: 2 });
    out.textContent = r.best ? `${tr('En iyi', 'Best')}: ${r.best.name} (${r.best.score})` : tr('Sonuç yok.', 'No result.');
    result.replaceChildren(table([tr('Sıra', 'Order'), tr('Skor', 'Score'), tr('Doğrulandı', 'Verified'), tr('Geri alma', 'Rollbacks')],
      r.tried.map((x) => [x.name, x.score ?? x.error, x.verified ? tr('evet', 'yes') : '–', x.rollbacks ?? '–']), ['', 'num', '', 'num']), r.best ? apply(r.best.code) : null);
  }));
  const casc = button(tr('Kademeli saldırı', 'Cascading attack'), () => busy(casc, out, async () => {
    out.textContent = tr('Kademeler çalışıyor…', 'Running stages…');
    const r = await cascade(a.getInput(), { sandbox: a.sandbox });
    out.textContent = `${tr('Son skor', 'Final score')}: ${r.score}`;
    result.replaceChildren(table([tr('Seviye', 'Level'), tr('Skor', 'Score'), tr('İyileşti', 'Improved'), tr('Doğrulandı', 'Verified')],
      r.stages.map((s) => [s.level, s.score ?? s.error, s.improved ? tr('evet', 'yes') : '–', s.verified ? tr('evet', 'yes') : '–']), ['num', 'num', '', '']), apply(r.code));
  }));
  const region = button(tr('Seçili bölgeyi çöz', 'Deobfuscate selection'), () => busy(region, out, async () => {
    const sel = a.getSelection();
    if (!sel || sel.start === sel.end) { out.textContent = tr('Girdide bir bölge seçin.', 'Select a region in the input.'); return; }
    const r = await deobfuscateRegion(a.getInput(), sel.start, sel.end, { sandbox: a.sandbox });
    if (!r.ok) { out.textContent = r.reason; return; }
    out.textContent = tr('Bölge çözüldü; girdinin geri kalanı değişmedi.', 'Region deobfuscated; the rest of the input is unchanged.');
    result.replaceChildren(el('pre', { class: 'sec-pre' }, r.after), button(tr('Girdiye uygula', 'Apply to input'), () => a.setInput(r.code)));
  }));
  const chain = button(tr('Geri alma zinciri', 'Rollback chain'), () => busy(chain, out, async () => {
    if (!a.sandbox) { out.textContent = tr('Sandbox gerekli.', 'Sandbox required.'); return; }
    const r = await rollbackChain(a.getInput(), a.snapshots(), { sandbox: a.sandbox });
    if (!r.culprit) { out.textContent = r.reason; result.textContent = ''; return; }
    out.textContent = `${tr('Davranışı bozan pass', 'Breaking pass')}: ${r.culprit.id} (${tr('tur', 'round')} ${r.culprit.round}) · ${tr('bağımlı', 'dependent')}: ${r.dependents.join(', ') || '–'} · ${r.fixed ? tr('düzeltildi', 'fixed') : tr('düzelmedi', 'not fixed')}`;
    result.replaceChildren(r.fixed ? apply(r.code) : null);
  }));
  return tool(tr('Motor araçları', 'Engine tools'),
    muted(tr('Pass sırası arama, seviye 1→4 kademeli çözme, seçili bölgede artımlı çözme ve davranışı bozan pass\'i bağımlılarıyla geri alma.', 'Pass order search, level 1→4 cascade, incremental region deobfuscation and rolling back the breaking pass with its dependents.')),
    el('div', { class: 'rep-actions' }, order, casc, region, chain), out, result);
}

function bundleTool(a) {
  const out = status();
  const result = el('div');
  const split = button(tr('Modüllere ayır', 'Split into modules'), () => {
    const s = splitBundle(a.getOutput(), { map: false }) ?? splitBundle(a.getText());
    if (!s?.modules.length) { out.textContent = tr('Tanınan bir bundle modül tablosu yok.', 'No recognised bundle module table.'); result.textContent = ''; return; }
    out.textContent = `${s.kind}: ${s.modules.length} ${tr('modül', 'modules')}`;
    const files = moduleFiles(s);
    result.replaceChildren(
      button(tr('ZIP indir', 'Download ZIP'), () => a.download('peel-modules.zip', zipStore(files), 'application/zip')),
      el('table', { class: 'rep-table' }, el('tbody', {}, ...s.modules.slice(0, 200).map((m, i) => el('tr', {},
        el('td', { class: 'mono' }, m.id), el('td', { class: 'mono' }, files[i].name), el('td', { class: 'mono' }, m.deps.join(', ') || '–'),
        el('td', {}, button(tr('Girdiye yükle', 'Load as input'), () => a.setInput(files[i].text), 'ghost small')))))));
  });
  return tool(tr('Bundle ayırma', 'Bundle splitting'),
    muted('webpack 4/5, webpackChunk, browserify, esbuild, Parcel, Rollup (kaynak haritalı)'), el('div', { class: 'rep-actions' }, split), out, result);
}

function sourceMapTool(a) {
  const out = status();
  return tool(tr('Source map', 'Source map'),
    field(tr('Girdinin source map dosyası (.map): isimleri kurtar', 'Source map for the input (.map): recover names'), fileInput('.map,.json', async (f) => {
      try {
        if (f.size > 50 << 20) throw new Error(tr('dosya çok büyük', 'file too large'));
        // harita girdiye satır içi eklenir; 05-sourcemap pass'i çözme sırasında isimleri kurtarır
        a.setInput(attachInlineMap(a.getInput(), await f.text()));
        out.textContent = tr('Harita girdiye eklendi; çözdüğünüzde isimler kurtarılır.', 'Map attached to the input; names are recovered when you peel.');
      } catch (e) { fail(out, e); }
    })),
    el('div', { class: 'rep-actions' }, button(tr('Çıktı source map\'ini indir', 'Download output source map'), () => {
      try {
        const r = generateSourceMap(a.getText(), a.getOutput());
        a.download('peeled.js.map', JSON.stringify(r.map), 'application/json');
        out.textContent = `${r.matched} ${tr('token eşlendi', 'tokens mapped')} · ${tr('kapsam', 'coverage')} ${Math.round(r.coverage * 100)}%`;
      } catch (e) { fail(out, e); }
    })), out);
}

export function renderTools(root, report, actions) {
  root.append(el('section', { class: 'rep-section' }, el('h3', {}, tr('Araçlar', 'Tools')),
    incidentTool(report, actions), npmTool(actions), extensionTool(actions), familiesTool(report, actions),
    trackingTool(report, actions), engineTool(actions), bundleTool(actions), sourceMapTool(actions)));
}
