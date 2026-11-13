import { semanticDiff, portNames } from '../../integrations/compare.js';
import { h, tx, pickFiles, readText, busy, download } from './dom.js';

// G141/G142/G145/G147/G148 arayüzü: eski sürüm dosyası seçilir, iki taraf da çözülür ve
// yeniden adlandırmadan bağımsız fonksiyon raporu gösterilir. Adlar eski sürümden yeni çıktıya taşınabilir.
export function renderCompare(root, ctx) {
  const out = h('div', { class: 'pi-out', 'aria-live': 'polite' });
  let older = null;
  const label = h('span', { class: 'pi-muted' }, tx('Eski sürüm seçilmedi', 'No old version selected'));
  const pick = h('button', { type: 'button', class: 'ghost' }, tx('Eski sürümü seç', 'Choose old version'));
  const run = h('button', { type: 'button', class: 'primary' }, tx('Mevcut girdiyle karşılaştır', 'Compare with current input'));

  pick.addEventListener('click', async () => {
    const [f] = await pickFiles();
    if (!f) return;
    older = { name: f.name, text: await readText(f) };
    label.textContent = f.name;
  });

  run.addEventListener('click', () => busy(run, out, async () => {
    if (!older) throw new Error(tx('Önce eski sürümü seç', 'Choose the old version first'));
    const current = ctx.getInput();
    if (!current.trim()) throw new Error(tx('Girdi boş', 'Input is empty'));
    const sandbox = ctx.getSandbox();
    const solve = async (code) => {
      const r = await ctx.deobfuscate(code, { level: 4, sandbox, deep: Boolean(sandbox) });
      if (r.error) throw new Error(`Parse: ${r.error}`);
      return r.code;
    };
    const a = await solve(older.text);
    const b = ctx.getOutput() && ctx.last()?.input === current ? ctx.getOutput() : await solve(current);
    const d = semanticDiff(a, b, { oldInput: older.text, newInput: current });
    out.replaceChildren(...view(d, a, b, ctx));
  }));

  root.replaceChildren(
    h('p', { class: 'pi-muted' }, tx('İki sürüm de çözülür; yalnızca adı değişen fonksiyonlar "aynı" sayılır. Eşleştirme: yapısal özet, çağrı grafiği, benzerlik.',
      'Both versions are deobfuscated; functions that only changed names count as "same". Matching: structural hash, call graph, similarity.')),
    h('div', { class: 'pi-row' }, pick, label, run),
    out,
  );
}

function view(d, oldCode, newCode, ctx) {
  const s = d.summary;
  const items = [];
  if (d.techniques?.new.length) {
    items.push(h('p', { class: 'pi-warn', role: 'alert' }, `${tx('Yeni gizleme tekniği', 'New obfuscation technique')}: ${d.techniques.new.map((x) => x.name).join(', ')}`));
  }
  items.push(h('p', {}, s.equivalent
    ? tx('Yapısal fark yok: yalnızca adlar ve biçim değişmiş.', 'No structural difference: only names and formatting changed.')
    : tx(`${s.same} aynı · ${s.changed} değişmiş · ${s.added} eklenmiş · ${s.removed} silinmiş`, `${s.same} same · ${s.changed} changed · ${s.added} added · ${s.removed} removed`)));
  const rows = d.functions.filter((f) => f.status !== 'same').map((f) => h('tr', { class: `pi-${f.status}` },
    h('td', {}, { changed: '~', added: '+', removed: '−' }[f.status]),
    h('td', {}, f.old ? `${f.old.name}:${f.old.line}` : '—'),
    h('td', {}, f.new ? `${f.new.name}:${f.new.line}` : '—'),
    h('td', {}, f.status === 'changed' ? `${Math.round(f.similarity * 100)}% · ${f.via}` : ''),
    h('td', {}, f.changes ? [...f.changes.stringsAdded.slice(0, 3).map((x) => `+"${x}"`), ...f.changes.globalsAdded.slice(0, 3).map((x) => `+${x}`)].join(' ') : '')));
  if (rows.length) {
    items.push(h('table', { class: 'pi-table' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, tx('Eski', 'Old')), h('th', {}, tx('Yeni', 'New')), h('th', {}, tx('Benzerlik', 'Similarity')), h('th', {}, tx('Değişiklik', 'Change')))),
      h('tbody', {}, rows)));
  }
  if (s.stringsAdded.length) items.push(h('p', {}, `${tx('Yeni string', 'New strings')}: `, h('code', {}, s.stringsAdded.slice(0, 20).join(' · '))));
  if (s.globalsAdded.length) items.push(h('p', {}, `${tx('Yeni API', 'New APIs')}: `, h('code', {}, s.globalsAdded.join(', '))));

  const port = h('button', { type: 'button', class: 'ghost' }, tx('Adları yeni sürüme taşı', 'Port names to new version'));
  const res = h('div');
  port.addEventListener('click', () => busy(port, res, async () => {
    const p = await portNames(oldCode, newCode);
    ctx.setOutput(p.code);
    res.replaceChildren(h('p', {}, tx(`${p.renamed.length} ad taşındı, ${p.skipped} çakışma atlandı. Çıktı güncellendi.`, `${p.renamed.length} names ported, ${p.skipped} clashes skipped. Output updated.`)));
  }));
  const json = h('button', { type: 'button', class: 'ghost' }, tx('Raporu JSON indir', 'Download report JSON'));
  json.addEventListener('click', () => download('peel-diff.json', JSON.stringify(d, null, 2), 'application/json'));
  items.push(h('div', { class: 'pi-row' }, port, json), res);
  return items;
}
