import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { deobfuscate } from '../core/pipeline.js';
import { analyze } from '../core/analyze.js';
import { PASSES } from '../core/registry.js';
import { fnv1a } from '../util/hash.js';
import { semanticDiff, formatDiff, portNames } from '../integrations/compare.js';
import { createHistory } from '../integrations/history.js';
import { fileStore, defaultHistoryPath } from '../integrations/history-node.js';
import { readAsar, isScript } from '../integrations/asar.js';
import { symbolMap, renameAcross } from '../integrations/multifile.js';
import { encodeShare, decodeShare, isEncrypted, shareUrl } from '../integrations/share.js';
import { generateKeyPair, signPlugin, verifyPlugin, fingerprint } from '../integrations/signing.js';
import { TECHNIQUES, detectTechniques, techniqueById } from '../integrations/techniques.js';
import { explainWhy } from '../integrations/why.js';
import { LESSONS, playLesson } from '../integrations/tutorial.js';
import { CHALLENGES, buildChallenge, checkFlag, challengeById } from '../integrations/ctf.js';
import { obfuscate, testOwnCode, PRESETS } from '../integrations/obfuscate.js';
import { anonymize, buildFixture, issueUrl } from '../integrations/anonymize.js';
import { formatChangelog } from '../integrations/changelog.js';
import { startServer } from '../server/http.js';
import { startBotServer, registerDiscordCommand } from '../server/bots.js';
import { vmReport, isaFromFinding, encoderFor } from '../core/vm/report.js';
import { assemble, compareSignatures } from '../core/vm/semantics.js';
import { parseArgs, UsageError } from './args.js';
import { EXIT, getSandbox, makeLogger, readInput, fetchScript, isUrl } from './common.js';

// Kendi barındırdığın PEEL adresi --base ya da PEEL_APP_URL ile verilir; varsayılan yerel geliştirme sunucusu
const DEFAULT_APP = process.env.PEEL_APP_URL || 'http://localhost:5173/';
const pick = (o, lang) => (lang === 'en' ? o.en : o.tr);
const help = (text) => { console.log(text); return EXIT.OK; };

async function deob(input, log) {
  const sandbox = await getSandbox();
  const r = await deobfuscate(input, { level: 4, sandbox, deep: true, onLog: log });
  if (r.error) throw new Error(`Parse edilemedi: ${r.error}`);
  return r;
}

// G141/G142/G145/G147/G148
async function diffCmd(argv) {
  const { opts, positional } = parseArgs(argv, {
    deobfuscate: { alias: 'D', type: 'bool' }, json: { type: 'bool' }, 'port-names': { type: 'string' }, lang: { type: 'string' }, quiet: { alias: 'q', type: 'bool' }, help: { alias: 'h', type: 'bool' },
  });
  if (opts.help || positional.length !== 2) return help('peel diff <eski.js> <yeni.js> [-D|--deobfuscate] [--json] [--port-names çıktı.js] [--lang en]\n  -D: iki girdiyi önce çöz, sonra karşılaştır\n  --port-names: eski sürümdeki adları yeni sürüme taşıyıp yaz');
  const log = makeLogger(opts.quiet || opts.json);
  const [ia, ib] = await Promise.all(positional.map(readInput));
  let a = ia;
  let b = ib;
  if (opts.deobfuscate) {
    a = (await deob(ia, log)).code;
    b = (await deob(ib, log)).code;
  }
  const d = semanticDiff(a, b, { oldInput: ia, newInput: ib });
  if (opts['port-names']) {
    const p = await portNames(a, b);
    await writeFile(opts['port-names'], p.code);
    log(`${p.renamed.length} ad taşındı, ${p.skipped} atlandı -> ${opts['port-names']}`, 'ok');
  }
  if (opts.json) console.log(JSON.stringify(d, null, 2));
  else console.log(formatDiff(d, opts.lang === 'en' ? 'en' : 'tr'));
  return d.summary.equivalent ? EXIT.OK : EXIT.CHANGED;
}

// G143: dosya ya da URL izleme
async function trackCmd(argv) {
  const { opts, positional } = parseArgs(argv, {
    interval: { alias: 'i', type: 'number' }, once: { type: 'bool' }, label: { type: 'string' }, note: { type: 'string' }, json: { type: 'bool' }, quiet: { alias: 'q', type: 'bool' }, help: { alias: 'h', type: 'bool' },
  });
  if (opts.help || positional.length !== 1) return help('peel track <dosya|https://...> [--interval saniye] [--once] [--label v2] [--note "..."] [--json]\n  Değişiklik olunca çözer, geçmişe kaydeder ve önceki sürümle semantik farkı gösterir.\n  --once: bir kez kontrol et; değişiklik varsa çıkış kodu 3');
  const src = positional[0];
  const source = isUrl(src) ? src : resolve(src);
  const log = makeLogger(opts.quiet || opts.json);
  const history = createHistory(fileStore());
  const interval = Math.max(10, opts.interval ?? 300);
  const check = async () => {
    const input = isUrl(src) ? await fetchScript(src) : await readInput(src);
    const prev = (await history.versions(source)).at(-1);
    if (prev && prev.inputHash === fnv1a(input)) {
      log(`${src}: değişiklik yok`, 'info');
      return false;
    }
    const r = await deob(input, log);
    const t = await history.track({ source, name: basename(src), input, output: r.code, label: opts.label ?? '', note: opts.note ?? '', stats: r.stats });
    if (opts.json) console.log(JSON.stringify({ source, changed: true, entry: t.entry.id, diff: t.diff }, null, 2));
    else {
      console.log(`${new Date().toISOString()} ${src}: ${t.previous ? 'YENİ SÜRÜM' : 'ilk kayıt'} (${t.entry.id})`);
      if (t.diff) console.log(formatDiff(t.diff));
    }
    return Boolean(t.previous);
  };
  const changed = await check();
  if (opts.once) return changed ? EXIT.CHANGED : EXIT.OK;
  log(`${interval} sn aralıkla izleniyor (Ctrl+C ile çık)`, 'info');
  for (;;) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    try { await check(); } catch (e) { log(e.message, 'err'); }
  }
}

// G146/G155
async function historyCmd(argv) {
  const { opts, positional } = parseArgs(argv, { json: { type: 'bool' }, out: { alias: 'o', type: 'string' }, help: { alias: 'h', type: 'bool' } });
  const [sub = 'list', id, ...rest] = positional;
  if (opts.help) return help(`peel history [list|show <id>|label <id> <etiket>|note <id> <not>|rm <id>|clear|seen <dosya>|versions <kaynak>] [--json]\n  Dosya: ${defaultHistoryPath()} (PEEL_HOME ile değiştirilebilir)`);
  const h = createHistory(fileStore());
  const out = (x) => console.log(opts.json ? JSON.stringify(x, null, 2) : x);
  const date = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 16);
  switch (sub) {
    case 'list': {
      const list = await h.list();
      if (opts.json) out(list);
      else for (const e of list) console.log(`${e.id}  ${date(e.time)}  ${e.label ? `[${e.label}] ` : ''}${e.name}  ${e.inputSize}→${e.outputSize}${e.note ? `  # ${e.note}` : ''}`);
      return EXIT.OK;
    }
    case 'show': {
      const e = await h.get(id);
      if (!e) throw new UsageError(`Kayıt yok: ${id}`);
      if (opts.out && e.output) { await writeFile(opts.out, e.output); return EXIT.OK; }
      out(opts.json ? e : `${e.name} ${date(e.time)} ${e.label}\n${e.note}\n\n${e.output ?? '(çıktı saklanmadı: çok büyük)'}`);
      return EXIT.OK;
    }
    case 'label':
    case 'note': {
      const e = await h.update(id, { [sub]: rest.join(' ') });
      if (!e) throw new UsageError(`Kayıt yok: ${id}`);
      return EXIT.OK;
    }
    case 'rm': return (await h.remove(id)) ? EXIT.OK : EXIT.ERROR;
    case 'clear': await h.clear(); return EXIT.OK;
    case 'versions': out((await h.versions(isUrl(id) ? id : resolve(id))).map(({ input, output, fnHashes, ...m }) => m)); return EXIT.OK;
    case 'seen': {
      const input = await readInput(id);
      const r = await deob(input, makeLogger(true));
      const s = await h.seen(input, r.code);
      out(opts.json ? s : [
        `aynı girdi: ${s.exact.map((e) => `${e.name} (${date(e.time)})`).join(', ') || '-'}`,
        `aynı çözüm: ${s.sameOutput.map((e) => e.name).join(', ') || '-'}`,
        `benzer: ${s.similar.map((x) => `${x.entry.name} %${Math.round(x.score * 100)}`).join(', ') || '-'}`,
      ].join('\n'));
      return s.exact.length || s.sameOutput.length || s.similar.length ? EXIT.CHANGED : EXIT.OK;
    }
    default: throw new UsageError(`Bilinmeyen history komutu: ${sub}`);
  }
}

// H163
async function serveCmd(argv) {
  const { opts } = parseArgs(argv, { port: { alias: 'p', type: 'number' }, host: { type: 'string' }, 'max-body': { type: 'number' }, timeout: { type: 'number' }, help: { alias: 'h', type: 'bool' } });
  if (opts.help) return help('peel serve [--port 8787] [--host 127.0.0.1] [--max-body bayt] [--timeout saniye]\n  Token PEEL_TOKEN ortam değişkeninden okunur; yoksa rastgele üretilip yazdırılır.\n  Uç noktalar: GET /health, GET /v1/passes, POST /v1/deobfuscate, POST /v1/diff, POST /v1/sarif');
  const s = await startServer({
    host: opts.host ?? '127.0.0.1', port: opts.port ?? 8787, token: process.env.PEEL_TOKEN || null,
    maxBody: opts['max-body'], timeoutMs: opts.timeout ? opts.timeout * 1000 : undefined, log: (m) => process.stderr.write(`${m}\n`),
  });
  console.log(`PEEL API: ${s.url}`);
  if (!process.env.PEEL_TOKEN) console.log(`Token: ${s.token}`);
  console.log('Yetkilendirme başlığı: Authorization: Bearer <token>');
  await new Promise(() => {});
  return EXIT.OK;
}

// H169
async function botCmd(argv) {
  const { opts } = parseArgs(argv, { port: { alias: 'p', type: 'number' }, 'register-discord': { type: 'bool' }, help: { alias: 'h', type: 'bool' } });
  if (opts.help) return help('peel bot [--port 8788] [--register-discord]\n  Ortam: SLACK_SIGNING_SECRET, DISCORD_PUBLIC_KEY, DISCORD_APP_ID, DISCORD_BOT_TOKEN (yalnızca --register-discord)\n  Slack: /slack/command  Discord: /discord/interactions (127.0.0.1; dışarıya tünel/ters vekil ile açın)');
  const env = process.env;
  if (opts['register-discord']) {
    if (!env.DISCORD_APP_ID || !env.DISCORD_BOT_TOKEN) throw new UsageError('DISCORD_APP_ID ve DISCORD_BOT_TOKEN gerekli');
    await registerDiscordCommand({ applicationId: env.DISCORD_APP_ID, botToken: env.DISCORD_BOT_TOKEN });
    console.log('Discord /peel komutu kaydedildi');
    return EXIT.OK;
  }
  const s = await startBotServer({
    port: opts.port ?? 8788,
    slack: env.SLACK_SIGNING_SECRET ? { signingSecret: env.SLACK_SIGNING_SECRET } : null,
    discord: env.DISCORD_PUBLIC_KEY ? { publicKey: env.DISCORD_PUBLIC_KEY, applicationId: env.DISCORD_APP_ID } : null,
    log: (m) => process.stderr.write(`${m}\n`),
  });
  console.log(`PEEL bot: http://127.0.0.1:${s.port}`);
  await new Promise(() => {});
  return EXIT.OK;
}

// G154
async function asarCmd(argv) {
  const { opts, positional } = parseArgs(argv, { out: { alias: 'o', type: 'string' }, deobfuscate: { alias: 'D', type: 'bool' }, list: { type: 'bool' }, 'js-only': { type: 'bool' }, quiet: { alias: 'q', type: 'bool' }, help: { alias: 'h', type: 'bool' } });
  if (opts.help || positional.length !== 1 || (!opts.list && !opts.out)) return help('peel asar <app.asar> (--list | -o <dizin>) [--js-only] [-D|--deobfuscate]');
  const log = makeLogger(opts.quiet);
  const archive = readAsar(new Uint8Array(await readFile(positional[0])));
  if (opts.list) {
    for (const f of archive.files) console.log(`${f.unpacked ? 'U' : f.link ? 'L' : ' '} ${String(f.size).padStart(10)}  ${f.path}`);
    return EXIT.OK;
  }
  const root = resolve(opts.out);
  let n = 0;
  for (const f of archive.files) {
    if (f.unpacked || f.link) { log(`atlandı (${f.unpacked ? 'unpacked' : 'link'}): ${f.path}`, 'warn'); continue; }
    if (opts['js-only'] && !isScript(f.path)) continue;
    const target = resolve(root, f.path);
    if (!target.startsWith(root)) throw new Error(`Arşiv dışına yazma girişimi: ${f.path}`);
    await mkdir(dirname(target), { recursive: true });
    if (opts.deobfuscate && isScript(f.path)) {
      try {
        const r = await deob(archive.readText(f.path), () => {});
        await writeFile(target, r.code);
        log(`çözüldü: ${f.path}`, 'ok');
      } catch (e) {
        await writeFile(target, archive.read(f.path));
        log(`${f.path}: ${e.message}`, 'warn');
      }
    } else {
      await writeFile(target, archive.read(f.path));
    }
    n++;
  }
  log(`${n} dosya -> ${root}`, 'ok');
  return EXIT.OK;
}

// G153
async function symbolsCmd(argv) {
  const { opts, positional } = parseArgs(argv, { json: { type: 'bool' }, rename: { type: 'list' }, 'out-dir': { alias: 'd', type: 'string' }, deobfuscate: { alias: 'D', type: 'bool' }, help: { alias: 'h', type: 'bool' } });
  if (opts.help || positional.length < 1) return help('peel symbols <a.js> <b.js> ... [--json] [-D] [--rename eski=yeni ... --out-dir dizin]');
  const log = makeLogger(opts.json);
  const files = [];
  for (const p of positional) {
    const input = await readInput(p);
    files.push({ name: p, code: opts.deobfuscate ? (await deob(input, log)).code : input });
  }
  if (opts.rename.length) {
    if (!opts['out-dir']) throw new UsageError('--rename için --out-dir gerekli');
    const map = Object.fromEntries(opts.rename.map((r) => {
      const m = r.match(/^([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)$/);
      if (!m) throw new UsageError(`Geçersiz --rename: ${r}`);
      return [m[1], m[2]];
    }));
    for (const f of await renameAcross(files, map)) {
      const target = join(opts['out-dir'], basename(f.name));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.code);
      log(`${f.name}: ${f.renamed} değişiklik`, 'ok');
    }
    return EXIT.OK;
  }
  const m = symbolMap(files);
  if (opts.json) { console.log(JSON.stringify(m, null, 2)); return EXIT.OK; }
  console.log('Paylaşılan semboller:');
  for (const s of m.shared) console.log(`  ${s.name}: tanım ${[...new Set(s.definedIn.map((d) => `${d.file}:${d.line}`))].join(', ')} | kullanım ${[...new Set(s.usedIn.map((u) => u.file))].join(', ')}`);
  console.log('Bağımlılıklar:');
  for (const e of m.edges) console.log(`  ${e.from} -> ${e.to}: ${e.symbols.join(', ')}`);
  if (m.conflicts.length) console.log(`Çakışan tanımlar: ${m.conflicts.map((s) => s.name).join(', ')}`);
  for (const e of m.errors) console.log(`  ! ${e.file}: ${e.error}`);
  return EXIT.OK;
}

// J196 / G152
async function shareCmd(argv) {
  const { opts, positional } = parseArgs(argv, { 'password-env': { type: 'string' }, base: { type: 'string' }, 'with-output': { type: 'bool' }, help: { alias: 'h', type: 'bool' } });
  if (opts.help || positional.length !== 1) return help(`peel share <dosya> [--with-output] [--password-env DEGISKEN] [--base ${DEFAULT_APP}]\n  Bağlantı girdiyi # kısmında taşır; hiçbir yere yüklenmez. Parola, ortam değişkeninden okunur ve ayrı kanaldan iletilmelidir.`);
  const input = await readInput(positional[0]);
  const password = opts['password-env'] ? process.env[opts['password-env']] : undefined;
  if (opts['password-env'] && !password) throw new UsageError(`${opts['password-env']} ortam değişkeni boş`);
  const payload = { input, name: basename(positional[0]) };
  if (opts['with-output']) payload.output = (await deob(input, makeLogger(true))).code;
  console.log(shareUrl(opts.base ?? DEFAULT_APP, await encodeShare(payload, { password })));
  return EXIT.OK;
}

async function unshareCmd(argv) {
  const { opts, positional } = parseArgs(argv, { 'password-env': { type: 'string' }, out: { alias: 'o', type: 'string' }, help: { alias: 'h', type: 'bool' } });
  if (opts.help || positional.length !== 1) return help('peel unshare <bağlantı> [-o dosya] [--password-env DEGISKEN]');
  const frag = positional[0].includes('#') ? positional[0].slice(positional[0].indexOf('#')) : positional[0];
  if (isEncrypted(frag) && !opts['password-env']) throw new UsageError('Bağlantı şifreli: --password-env gerekli');
  const p = await decodeShare(frag, { password: opts['password-env'] ? process.env[opts['password-env']] : undefined });
  if (!p) throw new UsageError('PEEL paylaşım bağlantısı değil');
  if (opts.out) await writeFile(opts.out, p.input);
  else process.stdout.write(p.input);
  return EXIT.OK;
}

// H166
async function pluginCmd(argv) {
  const [sub, ...rest] = argv;
  const { opts, positional } = parseArgs(rest, { out: { alias: 'o', type: 'string' }, manifest: { type: 'string' }, key: { type: 'string' }, trust: { type: 'list' }, help: { alias: 'h', type: 'bool' } });
  const usage = 'peel plugin keygen -o anahtar.json\npeel plugin sign <eklenti.js> --manifest manifest.json --key anahtar.json -o eklenti.peelplugin\npeel plugin verify <eklenti.peelplugin> --trust <açık anahtar|dosya>\n  Çalıştırma: peel girdi.js --plugin eklenti.peelplugin --trust <açık anahtar>';
  if (opts.help || !sub) return help(usage);
  if (sub === 'keygen') {
    if (!opts.out) throw new UsageError('-o gerekli');
    const kp = await generateKeyPair();
    await writeFile(opts.out, `${JSON.stringify(kp, null, 2)}\n`, { mode: 0o600 });
    console.log(`Açık anahtar: ${kp.publicKey}\nParmak izi: ${await fingerprint(kp.publicKey)}\nÖzel anahtarı (${opts.out}) paylaşmayın.`);
    return EXIT.OK;
  }
  if (sub === 'sign') {
    if (positional.length !== 1 || !opts.manifest || !opts.key || !opts.out) throw new UsageError(usage);
    const key = JSON.parse(await readFile(opts.key, 'utf8'));
    const bundle = await signPlugin({ manifest: JSON.parse(await readFile(opts.manifest, 'utf8')), code: await readFile(positional[0], 'utf8'), privateKey: key.privateKey, publicKey: key.publicKey });
    await writeFile(opts.out, `${JSON.stringify(bundle, null, 2)}\n`);
    console.log(`İmzalandı: ${opts.out} (${bundle.manifest.id}@${bundle.manifest.version})`);
    return EXIT.OK;
  }
  if (sub === 'verify') {
    if (positional.length !== 1) throw new UsageError(usage);
    const keys = [];
    for (const k of opts.trust) keys.push(/^[A-Za-z0-9+/]{43}=$/.test(k) ? k : JSON.parse(await readFile(k, 'utf8')).publicKey);
    const v = await verifyPlugin(await readFile(positional[0], 'utf8'), keys);
    console.log(`Geçerli: ${v.manifest.id}@${v.manifest.version}, imzalayan ${await fingerprint(v.publicKey)}`);
    return EXIT.OK;
  }
  throw new UsageError(usage);
}

// J199
async function explainCmd(argv) {
  const { opts, positional } = parseArgs(argv, { lang: { type: 'string' }, json: { type: 'bool' }, help: { alias: 'h', type: 'bool' } });
  if (opts.help || positional.length !== 1) return help('peel explain <girdi.js> [--lang en] [--json]: kullanılan teknikler ve olası gizleme nedenleri');
  const lang = opts.lang === 'en' ? 'en' : 'tr';
  const input = await readInput(positional[0]);
  const sandbox = await getSandbox();
  const r = await deob(input, makeLogger(true));
  const report = await analyze({ input, text: r.text, output: r.code, events: r.events, sandbox });
  const reasons = explainWhy({ input, report });
  const tech = detectTechniques(input);
  if (opts.json) { console.log(JSON.stringify({ techniques: tech, reasons, risk: report.threat.risk }, null, 2)); return EXIT.OK; }
  console.log(`${lang === 'tr' ? 'Teknikler' : 'Techniques'}: ${tech.map((x) => (lang === 'tr' ? x.nameTr : x.name)).join(', ') || '-'}`);
  console.log(`Risk: ${report.threat.risk.score}/100 (${report.threat.risk.level})\n`);
  for (const x of reasons) console.log(`* ${pick(x.title, lang)} (%${Math.round(x.confidence * 100)})\n  ${pick(x.detail, lang)}\n  ${x.evidence.join('; ')}\n`);
  if (!reasons.length) console.log(lang === 'tr' ? 'Belirgin bir neden çıkarılamadı.' : 'No clear reason could be inferred.');
  return EXIT.OK;
}

// J193
async function techniquesCmd(argv) {
  const { opts, positional } = parseArgs(argv, { lang: { type: 'string' }, help: { alias: 'h', type: 'bool' } });
  if (opts.help) return help('peel techniques [kimlik] [--lang en]: gizleme teknikleri ansiklopedisi');
  const lang = opts.lang === 'en' ? 'en' : 'tr';
  if (!positional.length) {
    for (const x of TECHNIQUES) console.log(`${x.id.padEnd(28)} ${pick(x.name, lang)}`);
    return EXIT.OK;
  }
  const x = techniqueById(positional[0]);
  if (!x) throw new UsageError(`Bilinmeyen teknik: ${positional[0]}`);
  console.log(`${pick(x.name, lang)}\n\n${pick(x.summary, lang)}\n\n${lang === 'tr' ? 'Neden' : 'Why'}: ${pick(x.why, lang)}\n${lang === 'tr' ? 'Çözen pass' : 'Solved by'}: ${x.passes.join(', ')}`);
  if (x.example) {
    const r = await deob(x.example, () => {});
    console.log(`\n--- ${lang === 'tr' ? 'örnek' : 'example'} ---\n${x.example}\n\n--- PEEL ---\n${r.code}`);
  }
  return EXIT.OK;
}

// J191
async function learnCmd(argv) {
  const { opts, positional } = parseArgs(argv, { lang: { type: 'string' }, help: { alias: 'h', type: 'bool' } });
  if (opts.help) return help('peel learn [ders] [--lang en]: dersi gerçek motorla adım adım oynatır');
  const lang = opts.lang === 'en' ? 'en' : 'tr';
  if (!positional.length) {
    LESSONS.forEach((l, i) => console.log(`${String(i + 1).padStart(2)}. ${l.id.padEnd(28)} ${pick(l.name, lang)}`));
    console.log(`\npeel learn <${lang === 'tr' ? 'ders' : 'lesson'}>`);
    return EXIT.OK;
  }
  const sandbox = await getSandbox();
  const r = await playLesson(positional[0], deobfuscate, { sandbox });
  console.log(`# ${pick(r.lesson.name, lang)}\n${pick(r.lesson.summary, lang)}\n\n## ${lang === 'tr' ? 'Girdi' : 'Input'}\n${r.lesson.example}\n`);
  r.steps.forEach((s, i) => console.log(`## ${i + 1}. ${s.pass}${s.round ? ` (${lang === 'tr' ? 'tur' : 'round'} ${s.round})` : ''}\n${pick(s.doc, lang)}\n\n${s.code}\n`));
  console.log(`## ${lang === 'tr' ? 'Sonuç' : 'Result'}\n${r.result}`);
  return EXIT.OK;
}

// J192
async function ctfCmd(argv) {
  const { opts, positional } = parseArgs(argv, { check: { type: 'string' }, out: { alias: 'o', type: 'string' }, lang: { type: 'string' }, hint: { type: 'bool' }, help: { alias: 'h', type: 'bool' } });
  if (opts.help) return help('peel ctf                     görevleri listele\npeel ctf <görev> -o gorev.js  gizlenmiş kodu üret\npeel ctf <görev> --hint       ipucu\npeel ctf <görev> --check "PEEL{...}"  bayrağı denetle');
  const lang = opts.lang === 'en' ? 'en' : 'tr';
  if (!positional.length) {
    for (const c of CHALLENGES) console.log(`${'*'.repeat(c.difficulty).padEnd(6)} ${c.id.padEnd(10)} ${pick(c.title, lang)}`);
    return EXIT.OK;
  }
  const c = challengeById(positional[0]);
  if (!c) throw new UsageError(`Görev yok: ${positional[0]}`);
  if (opts.check !== undefined) {
    const ok = await checkFlag(c.id, opts.check);
    console.log(ok ? (lang === 'tr' ? 'Doğru! Bayrak kabul edildi.' : 'Correct! Flag accepted.') : (lang === 'tr' ? 'Yanlış bayrak.' : 'Wrong flag.'));
    return ok ? EXIT.OK : EXIT.ERROR;
  }
  if (opts.hint) { console.log(pick(c.hint, lang)); return EXIT.OK; }
  const code = await buildChallenge(c.id);
  if (opts.out) await writeFile(opts.out, code);
  else process.stdout.write(`${code}\n`);
  return EXIT.OK;
}

// J194/J195
async function obfuscateCmd(argv) {
  const { opts, positional } = parseArgs(argv, { preset: { alias: 'p', type: 'string' }, out: { alias: 'o', type: 'string' }, test: { alias: 't', type: 'bool' }, seed: { type: 'number' }, json: { type: 'bool' }, help: { alias: 'h', type: 'bool' } });
  if (opts.help || positional.length !== 1) return help(`peel obfuscate <kendi-kodun.js> [-p ${Object.keys(PRESETS).join('|')}] [-o çıktı.js] [-t|--test] [--seed N] [--json]\n  --test: gizle, PEEL ile çöz, davranışı karşılaştır ve dayanıklılık skorunu ver (0 = tamamen geri geldi, 100 = hiç gelmedi)`);
  const code = await readInput(positional[0]);
  const preset = opts.preset ?? 'medium';
  if (!opts.test) {
    const out = await obfuscate(code, preset, { seed: opts.seed ?? 0 });
    if (opts.out) await writeFile(opts.out, out); else process.stdout.write(`${out}\n`);
    return EXIT.OK;
  }
  const presets = preset === 'all' ? Object.keys(PRESETS) : [preset];
  const rows = [];
  for (const p of presets) {
    const r = await testOwnCode(code, p, { deobfuscate, sandbox: await getSandbox(), seed: opts.seed ?? 0 });
    rows.push(r);
    if (opts.out && presets.length === 1) await writeFile(opts.out, r.obfuscated);
  }
  if (opts.json) { console.log(JSON.stringify(rows.map(({ obfuscated, deobfuscated, ...x }) => x), null, 2)); return EXIT.OK; }
  for (const r of rows) {
    console.log(`${r.preset.padEnd(7)} dayanıklılık ${String(r.resilience?.score ?? '-').padStart(3)}/100  yapı %${Math.round((r.resilience?.structure ?? 0) * 100)}  string %${Math.round((r.resilience?.strings ?? 0) * 100)}  davranış ${r.behaviour?.compared ? (r.behaviour.same ? 'aynı' : 'FARKLI') : '-'}`);
  }
  return EXIT.OK;
}

// J197
async function anonymizeCmd(argv) {
  const { opts, positional } = parseArgs(argv, { out: { alias: 'o', type: 'string' }, expect: { type: 'list' }, gone: { type: 'list' }, issue: { type: 'bool' }, help: { alias: 'h', type: 'bool' } });
  if (opts.help || positional.length !== 1) return help('peel anonymize <girdi.js> [-o fixture.js] [--expect "..."] [--gone "_0x"] [--issue]\n  Açık göstergeleri örnek değerlerle değiştirir, yorumları siler; çözülmüş çıktıda kalan göstergeleri uyarır.\n  --issue: GitHub issue taslağı adresini yazdırır (hiçbir şey otomatik gönderilmez)');
  const input = await readInput(positional[0]);
  const r = await deob(input, makeLogger(true));
  const a = anonymize(input, { output: r.code });
  const fixture = buildFixture({ code: a.code, expect: opts.expect, gone: opts.gone, note: `katkı: ${basename(positional[0])}` });
  if (opts.out) await writeFile(opts.out, fixture); else process.stdout.write(fixture);
  process.stderr.write(`değiştirilen: ${Object.entries(a.replaced).map(([k, v]) => `${k}×${v}`).join(', ') || '-'}\n`);
  if (a.leaks.length) {
    process.stderr.write(`UYARI: çözülmüş çıktıda kodlanmış göstergeler var, paylaşmadan önce kaynağı elle temizleyin:\n${a.leaks.slice(0, 20).map((l) => `  ${l.kind}: ${l.value}`).join('\n')}\n`);
    return EXIT.CHANGED;
  }
  if (opts.issue) {
    const u = issueUrl({ title: `Fixture: ${basename(positional[0])}`, fixture });
    console.error(u ?? 'Fixture issue adresine sığmıyor: dosyayı issue\'ya elle ekleyin.');
  }
  return EXIT.OK;
}

// E194/E658: assembly → bytecode; ISA, --vm-out ile yazılan vmN.json'dan
async function asmCmd(argv) {
  const { opts, positional } = parseArgs(argv, { isa: { type: 'string' }, out: { alias: 'o', type: 'string' }, help: { alias: 'h', type: 'bool' } });
  if (opts.help || positional.length !== 1 || !opts.isa) return help('peel asm <program.asm> --isa <vmN.json> [-o bytecode.json]\n  vmN.json: peel <girdi> --vm-out <dizin> çıktısı');
  const vm = JSON.parse(await readFile(opts.isa, 'utf8'));
  const r = assemble(await readInput(positional[0]), isaFromFinding(vm), encoderFor(vm));
  if (r.errors.length) { console.error(r.errors.join('\n')); return EXIT.ERROR; }
  const text = JSON.stringify({ kind: typeof r.code === 'string' ? 'string' : 'array', bytecode: r.code });
  if (opts.out) await writeFile(opts.out, text); else console.log(text);
  return EXIT.OK;
}

// Madde 37 / E656: iki dosyadaki bytecode VM'lerin imza karşılaştırması (aynı motor, karışık opcode, sürüm farkı)
async function vmCompareCmd(argv) {
  const { opts, positional } = parseArgs(argv, { quiet: { alias: 'q', type: 'bool' }, help: { alias: 'h', type: 'bool' } });
  if (opts.help || positional.length !== 2) return help('peel vm-compare <a.js> <b.js>');
  const log = makeLogger(opts.quiet ?? true);
  const reps = [];
  for (const f of positional) reps.push(vmReport((await deob(await readInput(f), log)).findings));
  if (!reps[0]?.bytecode.length || !reps[1]?.bytecode.length) { console.error('Bytecode VM bulunamadı'); return EXIT.ERROR; }
  const out = [];
  for (const [i, x] of reps[0].bytecode.entries()) for (const [j, y] of reps[1].bytecode.entries()) out.push({ a: i, b: j, ...compareSignatures(x.signature, y.signature) });
  console.log(JSON.stringify(out, null, 2));
  return EXIT.OK;
}

const COMMANDS = {
  asm: asmCmd, 'vm-compare': vmCompareCmd,
  diff: diffCmd, track: trackCmd, history: historyCmd, serve: serveCmd, bot: botCmd, asar: asarCmd, symbols: symbolsCmd,
  share: shareCmd, unshare: unshareCmd, plugin: pluginCmd, explain: explainCmd, techniques: techniquesCmd, learn: learnCmd,
  ctf: ctfCmd, obfuscate: obfuscateCmd, anonymize: anonymizeCmd,
  changelog: async (argv) => { console.log(formatChangelog(argv.includes('--lang=en') || argv.includes('en') ? 'en' : 'tr')); return EXIT.OK; },
  passes: async () => { for (const p of PASSES) console.log(`${p.id.padEnd(18)} seviye ${p.level}  ${p.kind}${p.needs ? '  sandbox' : ''}`); return EXIT.OK; },
};

export const findCommand = (name) => (Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null);
