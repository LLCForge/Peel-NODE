import { createHistory } from '../../integrations/history.js';
import { formatDiff } from '../../integrations/compare.js';
import { browserStore } from './history-store.js';
import { h, tx, busy, pre } from './dom.js';

// G143/G144/G146/G155 arayüzü. Her çözüm (girdi + çıktı) bu cihazdaki IndexedDB'ye kaydedilir; aynı dosya adıyla
// gelen yeni sürüm "izlenen script" olarak önceki sürümle karşılaştırılır; aynı/benzer çözüm görüldüyse uyarı verilir.
let historyPromise = null;
let persistent = true;
export const getHistory = () => (historyPromise ??= browserStore().then((s) => {
  persistent = s.persistent;
  return createHistory(s);
}));

/** Her başarılı çözümden sonra çağrılır; uyarı metnini (varsa) döndürür. */
export async function recordRun({ input, output, name, stats }) {
  const h0 = await getHistory();
  const seen = await h0.seen(input, output);
  const date = (t) => new Date(t).toLocaleDateString();
  let warning = null;
  const nm = (e) => e.name || tx('adsız', 'untitled');
  if (seen.exact.length) warning = tx(`Bu girdi daha önce görüldü: ${nm(seen.exact[0])} (${date(seen.exact[0].time)})`, `Seen before: ${nm(seen.exact[0])} (${date(seen.exact[0].time)})`);
  else if (seen.sameOutput.length) warning = tx(`Farklı girdi, aynı çözüm: ${seen.sameOutput[0].name}`, `Different input, same result: ${seen.sameOutput[0].name}`);
  else if (seen.similar.length) warning = tx(`Benzer çözüm görüldü: ${seen.similar[0].entry.name} (%${Math.round(seen.similar[0].score * 100)})`, `Similar result seen: ${seen.similar[0].entry.name} (${Math.round(seen.similar[0].score * 100)}%)`);
  const source = name ? `file:${name}` : '';
  const t = source ? await h0.track({ source, name, input, output, stats }) : { changed: true, diff: null, entry: await h0.add({ name: '', input, output, stats }) };
  let change = null;
  if (t.previous && t.changed && t.diff) change = formatDiff(t.diff, tx('tr', 'en'));
  return { warning, change };
}

export function renderHistory(root, ctx) {
  const list = h('div', { class: 'pi-list', role: 'list' });
  const detail = h('div', { class: 'pi-out', 'aria-live': 'polite' });
  const clear = h('button', { type: 'button', class: 'ghost danger' }, tx('Geçmişi temizle', 'Clear history'));

  const refresh = async () => {
    const hist = await getHistory();
    const entries = (await hist.list()).reverse();
    if (!entries.length) {
      list.replaceChildren(h('p', { class: 'pi-muted' }, tx('Henüz kayıt yok. Çözülen her kod burada listelenir.', 'No entries yet. Every deobfuscation is listed here.')));
      return;
    }
    list.replaceChildren(...entries.map((e) => {
      const open = h('button', { type: 'button', class: 'pi-item', role: 'listitem' },
        h('b', {}, e.label ? `[${e.label}] ` : '', e.name || tx('(adsız)', '(untitled)')),
        h('span', { class: 'pi-muted' }, ` ${new Date(e.time).toLocaleString()} · ${e.inputSize.toLocaleString()} → ${e.outputSize.toLocaleString()}`),
        e.note ? h('span', { class: 'pi-muted' }, ` · ${e.note}`) : null);
      open.addEventListener('click', () => showEntry(e.id));
      return open;
    }));
  };

  const showEntry = async (id) => {
    const hist = await getHistory();
    const e = await hist.get(id);
    if (!e) return;
    const label = h('input', { type: 'text', value: e.label, maxlength: 100, class: 'pi-input' });
    const note = h('textarea', { rows: 2, maxlength: 2000, class: 'pi-input' }, e.note);
    const save = h('button', { type: 'button', class: 'ghost' }, tx('Etiketi/notu kaydet', 'Save label/note'));
    save.addEventListener('click', async () => { await hist.update(id, { label: label.value, note: note.value }); await refresh(); });
    const load = h('button', { type: 'button', class: 'ghost accent', disabled: e.input === null }, tx('Girdiye yükle', 'Load into input'));
    load.addEventListener('click', () => { ctx.setInput(e.input, e.name); if (e.output) ctx.setOutput(e.output); });
    const del = h('button', { type: 'button', class: 'ghost danger' }, tx('Sil', 'Delete'));
    del.addEventListener('click', async () => { await hist.remove(id); detail.replaceChildren(); await refresh(); });
    const versions = e.source ? await hist.versions(e.source) : [];
    detail.replaceChildren(
      h('h4', {}, e.name || tx('(adsız)', '(untitled)')),
      h('p', { class: 'pi-muted' }, `${tx('Teknikler', 'Techniques')}: ${e.techniques.join(', ') || '-'} · ${tx('sürüm', 'version')} ${versions.findIndex((v) => v.id === id) + 1}/${Math.max(1, versions.length)}`),
      h('label', { class: 'pi-field' }, h('span', {}, tx('Sürüm etiketi', 'Version label')), label),
      h('label', { class: 'pi-field' }, h('span', {}, tx('Not', 'Note')), note),
      h('div', { class: 'pi-row' }, save, load, del),
      e.output ? pre(e.output.slice(0, 20000)) : h('p', { class: 'pi-muted' }, tx('Çıktı çok büyük olduğu için yalnızca özeti saklandı.', 'Output too large; only its summary was kept.')),
    );
  };

  clear.addEventListener('click', () => busy(clear, detail, async () => {
    if (!window.confirm(tx('Bu cihazdaki tüm PEEL geçmişi kalıcı olarak silinsin mi?', 'Permanently delete all PEEL history on this device?'))) return;
    await (await getHistory()).clear();
    detail.replaceChildren();
    await refresh();
  }));

  const info = h('p', { class: 'pi-muted' });
  root.replaceChildren(info, h('div', { class: 'pi-split' }, list, detail), h('div', { class: 'pi-row' }, clear));
  getHistory().then(() => {
    info.textContent = persistent
      ? tx('Geçmiş yalnızca bu tarayıcıda (IndexedDB) tutulur; hiçbir yere gönderilmez.', 'History stays in this browser (IndexedDB); it is never sent anywhere.')
      : tx('Tarayıcı depolaması kapalı: geçmiş sekme kapanınca silinir.', 'Browser storage is off: history is lost when the tab closes.');
    return refresh();
  });
}
