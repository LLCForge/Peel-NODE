import { TECHNIQUES, detectTechniques } from '../../integrations/techniques.js';
import { LESSONS, PASS_DOCS, playLesson } from '../../integrations/tutorial.js';
import { CHALLENGES, buildChallenge, checkFlag } from '../../integrations/ctf.js';
import { PRESETS, testOwnCode, obfuscate } from '../../integrations/obfuscate.js';
import { explainWhy } from '../../integrations/why.js';
import { PATTERN_CHANGELOG, unseen, latestSeq } from '../../integrations/changelog.js';
import { h, tx, busy, pre, field } from './dom.js';

// J191 eğitim modu, J192 CTF, J193 ansiklopedi, J194/J195 kendi kodunu test et + dayanıklılık,
// J199 neden gizlenmiş, J200 yeni kalıplar. Hepsi cihazda, gerçek motorla çalışır.

const SEEN_KEY = 'peel.changelog.seen';
export function changelogBadge() {
  try { return unseen(Number(localStorage.getItem(SEEN_KEY) ?? 0)).length; } catch { return 0; }
}
function markChangelogSeen() {
  try { localStorage.setItem(SEEN_KEY, String(latestSeq())); } catch { /* depolama kapalı */ }
}

const select = (options, value) => h('select', { class: 'pi-input' }, options.map(([v, label]) => h('option', { value: v, selected: v === value ? true : null }, label)));

function encyclopedia(ctx) {
  const detail = h('div', { class: 'pi-out' });
  const show = (tq) => {
    const run = h('button', { type: 'button', class: 'ghost accent', disabled: !tq.example }, tx('Örneği girdiye yükle', 'Load example into input'));
    run.addEventListener('click', () => ctx.setInput(tq.example, `${tq.id}.js`));
    detail.replaceChildren(
      h('h4', {}, tx(tq.name)),
      h('p', {}, tx(tq.summary)),
      h('p', {}, h('b', {}, tx('Neden kullanılır: ', 'Why it is used: ')), tx(tq.why)),
      h('p', {}, h('b', {}, tx('Çözen pass\'ler: ', 'Solved by: ')), tq.passes.map((p) => `${p} (${tx(PASS_DOCS[p])})`).join(' · ')),
      ...(tq.example ? [h('p', { class: 'pi-muted' }, tx('Örnek:', 'Example:')), pre(tq.example), run] : [h('p', { class: 'pi-muted' }, tx('Bu teknik için kısa bir örnek yok; gerçek obfuscator çıktısında görülür.', 'No short example for this technique; it appears in real obfuscator output.'))]),
    );
  };
  const current = new Set(detectTechniques(ctx.getInput()).map((x) => x.id));
  const list = h('div', { class: 'pi-list', role: 'list' }, TECHNIQUES.map((tq) => {
    const b = h('button', { type: 'button', class: 'pi-item', role: 'listitem' }, tx(tq.name), current.has(tq.id) ? h('span', { class: 'pi-tag' }, tx('girdide', 'in input')) : null);
    b.addEventListener('click', () => show(tq));
    return b;
  }));
  show(TECHNIQUES[0]);
  return h('div', { class: 'pi-split' }, list, detail);
}

function lessons(ctx) {
  const out = h('div', { class: 'pi-out', 'aria-live': 'polite' });
  const pick = select(LESSONS.map((l) => [l.id, tx(l.name)]), LESSONS[0].id);
  const play = h('button', { type: 'button', class: 'primary' }, tx('Dersi oynat', 'Play lesson'));
  play.addEventListener('click', () => busy(play, out, async () => {
    const r = await playLesson(pick.value, ctx.deobfuscate, { sandbox: ctx.getSandbox() });
    let i = 0;
    const stepView = h('div');
    const prev = h('button', { type: 'button', class: 'ghost' }, tx('← Önceki', '← Previous'));
    const next = h('button', { type: 'button', class: 'ghost' }, tx('Sonraki →', 'Next →'));
    const all = [{ pass: tx('girdi', 'input'), code: r.lesson.example, doc: r.lesson.summary }, ...r.steps, { pass: tx('sonuç', 'result'), code: r.result, doc: { tr: 'Biçimlendirilmiş son çıktı.', en: 'Formatted final output.' } }];
    const render = () => {
      const s = all[i];
      prev.disabled = i === 0;
      next.disabled = i === all.length - 1;
      stepView.replaceChildren(h('p', {}, h('b', {}, `${i + 1}/${all.length} · ${s.pass}`), ' — ', tx(s.doc)), pre(s.code));
    };
    prev.addEventListener('click', () => { i--; render(); });
    next.addEventListener('click', () => { i++; render(); });
    render();
    out.replaceChildren(h('p', {}, tx(r.lesson.summary)), h('div', { class: 'pi-row' }, prev, next), stepView,
      h('p', { class: r.solved ? 'pi-ok' : 'pi-warn' }, r.solved ? tx('Çözüldü.', 'Solved.') : tx('Bu ortamda tam çözülemedi (sandbox kapalı olabilir).', 'Not fully solved here (sandbox may be off).')));
  }));
  return h('div', {}, h('div', { class: 'pi-row' }, pick, play), out);
}

function ctf(ctx) {
  const out = h('div', { class: 'pi-out', 'aria-live': 'polite' });
  const pick = select(CHALLENGES.map((c) => [c.id, `${'★'.repeat(c.difficulty)} ${tx(c.title)}`]), CHALLENGES[0].id);
  const load = h('button', { type: 'button', class: 'primary' }, tx('Görevi girdiye yükle', 'Load challenge into input'));
  const hint = h('button', { type: 'button', class: 'ghost' }, tx('İpucu', 'Hint'));
  const flag = h('input', { type: 'text', class: 'pi-input', placeholder: 'PEEL{...}', maxlength: 200, autocomplete: 'off', spellcheck: 'false' });
  const check = h('button', { type: 'button', class: 'ghost accent' }, tx('Bayrağı denetle', 'Check flag'));
  load.addEventListener('click', () => busy(load, out, async () => {
    const code = await buildChallenge(pick.value);
    ctx.setInput(code, `ctf-${pick.value}.js`);
    out.replaceChildren(h('p', {}, tx('Görev girdiye yüklendi. Çöz düğmesine bas, sonra bayrağı bul.', 'Challenge loaded. Press Deobfuscate, then find the flag.')));
  }));
  hint.addEventListener('click', () => out.replaceChildren(h('p', {}, tx(CHALLENGES.find((c) => c.id === pick.value).hint))));
  check.addEventListener('click', () => busy(check, out, async () => {
    const ok = await checkFlag(pick.value, flag.value);
    out.replaceChildren(h('p', { class: ok ? 'pi-ok' : 'pi-warn', role: 'status' }, ok ? tx('Doğru! Bayrak kabul edildi.', 'Correct! Flag accepted.') : tx('Yanlış bayrak, tekrar dene.', 'Wrong flag, try again.')));
  }));
  return h('div', {}, h('p', { class: 'pi-muted' }, tx('Görevler cihazda gerçek obfuscator.io ile sabit seed\'le gizlenir. Bayraklar PEEL{...} biçimindedir.', 'Challenges are obfuscated on-device with real obfuscator.io and a fixed seed. Flags look like PEEL{...}.')),
    h('div', { class: 'pi-row' }, pick, load, hint), h('div', { class: 'pi-row' }, flag, check), out);
}

function ownCode(ctx) {
  const out = h('div', { class: 'pi-out', 'aria-live': 'polite' });
  const preset = select([...Object.entries(PRESETS).map(([k, v]) => [k, tx(v.label)]), ['all', tx('Hepsi (karşılaştır)', 'All (compare)')]], 'medium');
  const test = h('button', { type: 'button', class: 'primary' }, tx('Girdiyi gizle ve PEEL ile test et', 'Obfuscate input and test with PEEL'));
  const only = h('button', { type: 'button', class: 'ghost' }, tx('Yalnızca gizle', 'Obfuscate only'));
  only.addEventListener('click', () => busy(only, out, async () => {
    if (preset.value === 'all') throw new Error(tx('Tek bir ön ayar seç', 'Pick a single preset'));
    ctx.setOutput(await obfuscate(ctx.getInput(), preset.value, { seed: 1 }));
    out.replaceChildren(h('p', {}, tx('Gizlenmiş kod çıktı paneline yazıldı.', 'Obfuscated code written to the output panel.')));
  }));
  test.addEventListener('click', () => busy(test, out, async () => {
    const code = ctx.getInput();
    const presets = preset.value === 'all' ? Object.keys(PRESETS) : [preset.value];
    const rows = [];
    for (const p of presets) rows.push(await testOwnCode(code, p, { deobfuscate: ctx.deobfuscate, sandbox: ctx.getSandbox(), seed: 1 }));
    out.replaceChildren(
      h('table', { class: 'pi-table' },
        h('thead', {}, h('tr', {}, ['', tx('Dayanıklılık', 'Resilience'), tx('Yapı', 'Structure'), 'String', tx('Davranış', 'Behaviour'), tx('Boyut', 'Size')].map((x) => h('th', {}, x)))),
        h('tbody', {}, rows.map((r) => h('tr', {},
          h('td', {}, tx(PRESETS[r.preset].label)),
          h('td', {}, r.resilience ? `${r.resilience.score}/100` : '-'),
          h('td', {}, r.resilience ? `${Math.round(r.resilience.structure * 100)}%` : '-'),
          h('td', {}, r.resilience ? `${Math.round(r.resilience.strings * 100)}%` : '-'),
          h('td', {}, r.behaviour?.compared ? (r.behaviour.same ? tx('aynı', 'same') : tx('FARKLI', 'DIFFERENT')) : '-'),
          h('td', {}, `${r.sizes.original} → ${r.sizes.obfuscated} → ${r.sizes.deobfuscated}`))))),
      h('p', { class: 'pi-muted' }, tx('Dayanıklılık: 0 = PEEL kodu tamamen geri getirdi, 100 = hiçbir şey geri gelmedi.', 'Resilience: 0 = PEEL fully recovered the code, 100 = nothing came back.')),
      ...(rows.length === 1 ? [h('p', {}, tx('PEEL çıktısı:', 'PEEL output:')), pre(rows[0].deobfuscated)] : []),
    );
  }));
  return h('div', {}, h('p', { class: 'pi-muted' }, tx('Girdi panelindeki KENDİ kodun gizlenir, PEEL ile çözülür ve ne kadarının geri geldiği ölçülür. Kod cihazdan çıkmaz.', 'Your OWN code from the input panel is obfuscated, deobfuscated by PEEL, and the recovery is measured. Code never leaves the device.')),
    h('div', { class: 'pi-row' }, field(tx('Ön ayar', 'Preset'), preset), test, only), out);
}

function why(ctx) {
  const l = ctx.last();
  const input = l?.input ?? ctx.getInput();
  if (!input.trim()) return h('p', { class: 'pi-muted' }, tx('Önce bir kod yükle.', 'Load some code first.'));
  const reasons = explainWhy({ input, report: l?.input === input ? l.report : null });
  const tech = detectTechniques(input);
  return h('div', {},
    h('p', {}, h('b', {}, tx('Teknikler: ', 'Techniques: ')), tech.map((x) => tx(x.nameTr, x.name)).join(', ') || '-'),
    !l?.report ? h('p', { class: 'pi-muted' }, tx('Davranış analizi için önce kodu çöz; şimdilik yalnızca statik çıkarım.', 'Deobfuscate first for behaviour analysis; static inference only for now.')) : null,
    reasons.length
      ? h('ul', { class: 'pi-reasons' }, reasons.map((r) => h('li', {}, h('b', {}, tx(r.title)), ` (${Math.round(r.confidence * 100)}%) `, tx(r.detail), h('br'), h('small', { class: 'pi-muted' }, r.evidence.join(' · ')))))
      : h('p', {}, tx('Belirgin bir neden çıkarılamadı.', 'No clear reason could be inferred.')),
    h('p', { class: 'pi-muted' }, tx('Sezgisel çıkarım: kanıtlarıyla birlikte değerlendirin, kesin hüküm değildir.', 'Heuristic inference: weigh it with the evidence; it is not a verdict.')));
}

function changelog() {
  const fresh = new Set(unseen(Number((() => { try { return localStorage.getItem(SEEN_KEY) ?? 0; } catch { return 0; } })())).map((e) => e.seq));
  markChangelogSeen();
  return h('div', {}, PATTERN_CHANGELOG.slice().reverse().map((e) => h('section', { class: 'pi-log' },
    h('h4', {}, `${e.date} · ${e.commit}`, fresh.has(e.seq) ? h('span', { class: 'pi-tag' }, tx('yeni', 'new')) : null),
    h('ul', {}, tx({ tr: e.tr, en: e.en }).map((x) => h('li', {}, x))),
    e.passes.length ? h('p', { class: 'pi-muted' }, `pass: ${e.passes.join(', ')}`) : null)));
}

export function renderLearn(root, ctx) {
  const sections = [
    ['why', tx('Neden gizlenmiş?', 'Why obfuscated?'), why],
    ['lessons', tx('Eğitim modu', 'Tutorial'), lessons],
    ['encyclopedia', tx('Ansiklopedi', 'Encyclopedia'), encyclopedia],
    ['ctf', 'CTF', ctf],
    ['own', tx('Kendi kodunu test et', 'Test your own code'), ownCode],
    ['changelog', tx('Yeni kalıplar', 'New patterns'), changelog],
  ];
  const body = h('div');
  const nav = h('div', { class: 'pi-subnav', role: 'tablist', 'aria-label': tx('Öğrenme', 'Learning') });
  const open = (id) => {
    for (const b of nav.children) b.setAttribute('aria-selected', String(b.dataset.id === id));
    const s = sections.find((x) => x[0] === id);
    body.replaceChildren(s[2](ctx));
  };
  for (const [id, label] of sections) {
    const b = h('button', { type: 'button', role: 'tab', class: 'tiny', 'data-id': id }, label, id === 'changelog' && changelogBadge() ? h('span', { class: 'pi-dot', 'aria-label': tx('yeni', 'new') }) : null);
    b.addEventListener('click', () => open(id));
    nav.append(b);
  }
  root.replaceChildren(nav, body);
  open('why');
}
