import { readFile, writeFile, mkdir, readdir, stat, access } from 'node:fs/promises';
import { watch } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deobfuscate } from '../core/pipeline.js';
import { splitBundle } from '../core/bundle.js';
import { createTrace } from '../analysis/trace.js';
import { analyze } from '../core/analyze.js';
import { rulesPlugin } from '../integrations/rules.js';
import { verifyPlugin } from '../integrations/signing.js';
import { importPluginSource } from '../integrations/plugins.js';
import { parseProject, serializeProject, createProject, upsertFile, applyRenames } from '../integrations/project.js';
import { findStyle } from '../integrations/style-node.js';
import { formatWithStyle } from '../integrations/style.js';
import { toSarif } from '../integrations/sarif.js';
import { runSemgrep } from '../integrations/semgrep.js';
import { buildReportHtml } from '../integrations/report-html.js';
import { detectTechniques } from '../integrations/techniques.js';
import { explainWhy } from '../integrations/why.js';
import { fastImportStream } from '../integrations/gitexport.js';
import { createHistory } from '../integrations/history.js';
import { fileStore } from '../integrations/history-node.js';
import { vmReport } from '../core/vm/report.js';
import { parseArgs, UsageError } from './args.js';
import { detectTools, autoProfile, PROFILES } from '../core/detect.js';
import { searchPassOrder, cascade } from '../core/search.js';
import { incidentReport } from '../security/incident.js';
import { generateSourceMap } from '../core/sourcemap.js';
import { parseNameMap } from '../naming/names.js';
import { toDts } from '../naming/types.js';
import { parse } from '../core/parse.js';
import { FORMAT_PROFILES } from '../core/emit.js';
import { EXIT, getSandbox, makeLogger, readInput, readJson } from './common.js';

export const RUN_SPEC = {
  out: { alias: 'o', type: 'string' },
  'out-dir': { alias: 'd', type: 'string' },
  report: { alias: 'r', type: 'string' },
  sarif: { type: 'string' },
  html: { type: 'string' },
  git: { type: 'string' },
  json: { type: 'bool' },
  quiet: { alias: 'q', type: 'bool' },
  level: { alias: 'l', type: 'number' },
  sandbox: { type: 'bool' },
  deep: { type: 'bool' },
  style: { type: 'string' },
  rules: { type: 'string' },
  plugin: { type: 'list' },
  trust: { type: 'list' },
  project: { type: 'string' },
  'save-project': { type: 'string' },
  semgrep: { type: 'bool' },
  'semgrep-config': { type: 'string' },
  history: { type: 'bool' },
  'fail-on': { type: 'string' },
  watch: { alias: 'w', type: 'bool' },
  config: { alias: 'c', type: 'string' },
  lang: { type: 'string' },
  'source-map': { alias: 'm', type: 'string' },
  split: { alias: 's', type: 'string' },
  profile: { alias: 'p', type: 'string' },
  'order-search': { type: 'bool' },
  cascade: { type: 'bool' },
  incident: { type: 'string' },
  'out-map': { type: 'string' },
  'vm-out': { type: 'string' },
  jsvmp: { type: 'bool' },
  names: { alias: 'n', type: 'string' },
  format: { alias: 'f', type: 'string' },
  dts: { type: 'string' },
  help: { alias: 'h', type: 'bool' },
};

// jsvmp modu (E198): yalnızca VM'e yönelik pass'ler; çıktı ve stderr'e VM özeti
export const JSVMP_PASSES = ['normalize', 'unpack', 'literals', 'const-arrays', 'const-objects', 'const-fold', 'state-var', 'vm-lift',
  'unflatten', 'vm', 'anti-timing', 'dead-code', 'simplify', 'unused'];

// Bytecode VM'leri ayrı dosyalara çıkar (E193): bytecode/ISA (json), assembly, IR, çevrilmiş, ham ve okunur yorumlayıcı
export async function writeVmFiles(dir, vm) {
  await mkdir(dir, { recursive: true });
  for (const [i, f] of vm.bytecode.entries()) {
    const base = join(dir, `vm${i}`);
    await writeFile(`${base}.json`, JSON.stringify({
      kind: f.codeKind, bytecode: f.bytecode, consts: f.constPool?.map((c) => c.value) ?? [], isa: f.isa, opcodeMap: f.opcodeMap,
      disasm: f.disasm?.map((x) => ({ op: x.op, operands: x.operands })), signature: f.signature,
    }, null, 1));
    if (f.assembly) await writeFile(`${base}.asm`, f.assembly);
    if (f.ir) await writeFile(`${base}-ir.txt`, f.ir.map((x) => `${x.pc} ${x.mnemonic}\n${x.lines.map((l) => `  ${l}`).join('\n')}`).join('\n'));
    if (f.liftedCode) await writeFile(`${base}-lifted.js`, f.liftedCode);
    if (f.rawSource) await writeFile(`${base}-raw.js`, f.rawSource);
    if (f.readable) await writeFile(`${base}-readable.js`, f.readable);
  }
}

export function printVmSummary(vm) {
  for (const [i, f] of vm.bytecode.entries()) {
    console.error(`\n== VM #${i} (${f.style}, ${f.disasm?.length ?? '?'} komut, ${f.lifted ? 'çevrildi' : `çevrilemedi: ${f.reason}`})`);
    for (const h of f.handlers) console.error(`  ${String(h.key).padStart(4)}  ${(h.staticName ?? '?').padEnd(12)} ${h.semantics}`);
    if (f.listing) console.error(f.listing);
  }
}

const CONFIG_NAMES = ['peel.config.json', '.peelrc.json', '.peelrc'];
const CONFIG_KEYS = {
  level: 'number', sandbox: 'boolean', deep: 'boolean', style: 'string', rules: 'string', plugins: 'array', trust: 'array',
  sarif: 'string', html: 'string', failOn: 'string', history: 'boolean', semgrep: 'boolean', semgrepConfig: 'string', outDir: 'string', lang: 'string',
};
const RISK_ORDER = ['none', 'low', 'medium', 'high'];

// peel.config.json: yalnızca bilinen anahtarlar, tip denetimli; göreli yollar yapılandırma dosyasına göredir
export async function loadConfig(explicit) {
  let path = explicit;
  if (!path) {
    for (const n of CONFIG_NAMES) {
      try { await access(n); path = n; break; } catch { /* yok */ }
    }
  }
  if (!path) return {};
  const raw = await readJson(path);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UsageError(`${path}: yapılandırma nesne olmalı`);
  const base = dirname(resolve(path));
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const kind = CONFIG_KEYS[k];
    if (!kind) throw new UsageError(`${path}: bilinmeyen anahtar "${k}"`);
    if (kind === 'array' ? !Array.isArray(v) || !v.every((x) => typeof x === 'string') : typeof v !== kind) throw new UsageError(`${path}: "${k}" ${kind} olmalı`);
    out[k] = v;
  }
  for (const k of ['rules', 'sarif', 'html', 'semgrepConfig', 'outDir']) if (out[k]) out[k] = resolve(base, out[k]);
  if (out.style && out.style !== 'auto') out.style = resolve(base, out.style);
  if (out.plugins) out.plugins = out.plugins.map((p) => resolve(base, p));
  return out;
}

async function expandInputs(list) {
  const out = [];
  for (const p of list) {
    if (p === '-') { out.push({ path: '-', rel: 'stdin.js' }); continue; }
    const s = await stat(p).catch(() => null);
    if (!s) throw new UsageError(`Bulunamadı: ${p}`);
    if (s.isFile()) { out.push({ path: p, rel: basename(p) }); continue; }
    const walk = async (dir) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (/\.(c|m)?js$/i.test(e.name)) out.push({ path: full, rel: relative(p, full) });
      }
    };
    await walk(p);
  }
  return out;
}

async function trustedKeys(list) {
  const keys = [];
  for (const k of list) {
    if (/^[A-Za-z0-9+/]{43}=$/.test(k)) { keys.push(k); continue; }
    const text = (await readFile(k, 'utf8')).trim();
    try {
      const j = JSON.parse(text);
      if (typeof j.publicKey === 'string') keys.push(j.publicKey);
      else if (Array.isArray(j.trusted)) keys.push(...j.trusted.filter((x) => typeof x === 'string'));
    } catch {
      keys.push(...text.split(/\s+/).filter(Boolean));
    }
  }
  return keys;
}

export async function loadPlugins({ plugins = [], trust = [], rules = null }, log) {
  const out = [];
  const keys = await trustedKeys(trust);
  for (const p of plugins) {
    if (extname(p) === '.peelplugin') {
      const v = await verifyPlugin(await readFile(p, 'utf8'), keys);
      log(`eklenti doğrulandı: ${v.manifest.id}@${v.manifest.version}`, 'ok');
      out.push(await importPluginSource(v.code));
    } else {
      // yerel, imzasız eklenti: kullanıcının kendi diskindeki dosya
      const m = await import(pathToFileURL(resolve(p)).href);
      out.push(m.default ?? m.plugin);
    }
  }
  if (rules) out.push(rulesPlugin(await readFile(rules, 'utf8')));
  return out;
}

function gitImport(dir, stream) {
  return new Promise((res, rej) => {
    execFileSync('git', ['init', '-q', dir]);
    const p = spawn('git', ['-C', dir, 'fast-import', '--quiet'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', rej);
    p.on('close', (code) => {
      if (code !== 0) return rej(new Error(`git fast-import başarısız: ${err.slice(0, 300)}`));
      execFileSync('git', ['-C', dir, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
      execFileSync('git', ['-C', dir, 'reset', '-q', '--hard']);
      res();
    });
    p.stdin.end(stream);
  });
}

/** Tek dosyayı işler; sonuç nesnesi --json çıktısının bir elemanıdır. */
async function processOne(item, o, ctx) {
  const { log } = ctx;
  const t0 = performance.now();
  let input = item.input ?? await readInput(item.path);
  // A-25: harita dosyası satır içi haritaya çevrilir; sourcemap pass'i aynı yoldan okur
  if (o.sourceMap) {
    const map = await readFile(o.sourceMap, 'utf8');
    input = `${input.replace(/\n\/\/[#@]\s*sourceMappingURL=.*\s*$/, '')}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString('base64')}\n`;
  }
  const sandbox = o.sandbox === false ? null : await getSandbox();
  const snapshots = [];
  // pass kayıtları ve yama günlüğü yalnızca rapor istenirken tutulur (çalıştırmayı yavaşlatır)
  const trace = o.report || o.html || o.json ? createTrace({ keepComments: true }) : null;
  // E26: pass profili — auto: eşiği aşan araç tespitine göre, aksi halde tüm pass'ler (bilinmeyen araç modu)
  let only = null;
  if (o.profile === 'auto') {
    const prof = autoProfile(detectTools(input));
    only = prof.passes;
    log(`profil: ${prof.profile} (${prof.reason})`, 'info');
  } else if (o.profile && o.profile !== 'all') {
    only = PROFILES[o.profile];
  }
  let r = await deobfuscate(input, {
    trace,
    only,
    level: o.level ?? 4,
    sandbox,
    deep: o.deep ?? Boolean(sandbox),
    onLog: log,
    only: o.jsvmp ? JSVMP_PASSES : null,
    plugins: ctx.plugins,
    onSnapshot: o.git ? (s) => snapshots.push(s) : undefined,
    // ad haritası (88) önce sözlük gibi uygulanır; proje dosyasının adları (renames) ayrıca aşağıda
    naming: { names: ctx.names ?? {}, lang: o.lang === 'en' ? 'en' : 'tr' },
    format: o.format ?? 'default',
  });
  // E32 / E33: daha iyi doğrulanmış sonuç bulunursa çıktı onunla değişir (rapor ilk çalıştırmanın metin katmanını kullanır)
  if (!r.error && o.orderSearch) {
    const best = (await searchPassOrder(input, { sandbox, onLog: log })).best;
    if (best) { log(`sıra arama: ${best.name} (skor ${best.score})`, 'ok'); r = { ...r, code: best.code, verified: best.verified }; }
  }
  if (!r.error && o.cascade) {
    const c = await cascade(input, { sandbox, onLog: log });
    log(`kademeli saldırı: skor ${c.score}`, 'ok');
    r = { ...r, code: c.code };
  }
  const result = { file: item.path, ok: !r.error, verified: r.verified ?? false, stats: r.stats };
  if (r.error) {
    result.error = r.error;
    log(`${item.path}: parse hatası: ${r.error}`, 'err');
    return result;
  }
  if (sandbox && !r.verified) log(`${item.path}: davranış sandbox'ta doğrulanamadı; çıktıyı gözden geçir`, 'warn');
  let code = r.code;
  if (item.renames && Object.keys(item.renames).length) {
    const a = await applyRenames(code, item.renames);
    code = a.code;
    log(`${a.applied} kullanıcı adı uygulandı${a.skipped.length ? `, atlanan: ${a.skipped.join(', ')}` : ''}`, 'info');
  }
  if (o.style) {
    const style = await findStyle(o.style === 'auto' ? (item.path === '-' ? process.cwd() : dirname(resolve(item.path))) : o.style);
    code = await formatWithStyle(code, style);
  }
  result.code = code;

  const needReport = o.report || o.sarif || o.html || o.failOn || o.json || o.semgrep || o.incident;
  let report = null;
  if (needReport) {
    report = await analyze({ input, text: r.text, output: code, events: r.events, sandbox, trace, stats: r.stats, verified: r.verified, findings: r.findings });
    report.stats = r.stats;
    // sembolik rapor pahalı: yalnızca JSON rapor istendiğinde hesaplanır
    report.symbolic = o.report || o.json ? await report.symbolic() : undefined;
    result.risk = report.threat.risk;
    result.techniques = detectTechniques(input).map((x) => x.id);
    result.why = explainWhy({ input, report }).map((x) => x.id);
  }
  let semgrep = [];
  if (o.semgrep) {
    semgrep = await runSemgrep(code, o.semgrepConfig ? { config: o.semgrepConfig } : {});
    result.semgrep = semgrep;
    if (report) report.semgrep = semgrep;
    log(`semgrep: ${semgrep.length} bulgu`, semgrep.length ? 'warn' : 'ok');
  }

  if (o.vmOut || o.jsvmp) {
    const vm = vmReport(r.findings);
    if (vm && o.vmOut) {
      const dir = ctx.batch ? join(o.vmOut, item.rel.replace(/[\\/]/g, '_')) : o.vmOut;
      await writeVmFiles(dir, vm);
      log(`${vm.bytecode.length} VM ${dir} klasörüne yazıldı`, 'ok');
    }
    if (vm && o.jsvmp) printVmSummary(vm);
  }
  const target = ctx.outFor(item);
  if (target) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, code);
    result.out = target;
  } else if (!o.json) {
    process.stdout.write(code);
  }
  const sideFile = (opt, ext) => (ctx.batch ? `${target ?? item.rel}${ext}` : opt);
  // 76: kullanımdan çıkarılan TypeScript bildirimleri
  if (o.dts) await writeFile(sideFile(o.dts, '.d.ts'), toDts(parse(code)));
  if (o.report) await writeFile(sideFile(o.report, '.report.json'), JSON.stringify(report, null, 2));
  // E114: olay müdahale raporu (Markdown + yanında JSON)
  if (o.incident) {
    const inc = await incidentReport({ report, input, output: code, meta: { title: basename(item.rel), source: basename(item.rel) } });
    const mdPath = sideFile(o.incident, '.incident.md');
    await writeFile(mdPath, inc.markdown);
    await writeFile(`${mdPath.replace(/\.md$/i, '')}.json`, inc.json);
  }
  // E60: çıktıdan girdiye Source Map v3
  if (o.outMap) {
    const sm = generateSourceMap(r.text ?? input, code, { file: target ? basename(target) : 'peeled.js', source: basename(item.rel) });
    await writeFile(sideFile(o.outMap, '.map'), JSON.stringify(sm.map));
    log(`çıktı haritası: ${sm.matched} token, kapsam %${Math.round(sm.coverage * 100)}`, 'info');
  }
  if (o.sarif) await writeFile(sideFile(o.sarif, '.sarif'), JSON.stringify(toSarif(report, { output: code, uri: target ? relative(process.cwd(), target).replace(/\\/g, '/') : item.rel, semgrep }), null, 2));
  if (o.html) {
    await writeFile(sideFile(o.html, '.report.html'), buildReportHtml({
      input, output: code, report, techniques: detectTechniques(input), reasons: explainWhy({ input, report }), name: item.rel, lang: o.lang === 'en' ? 'en' : 'tr',
    }));
  }
  if (o.git) {
    const dir = ctx.batch ? join(o.git, item.rel.replace(/[\\/]/g, '_')) : o.git;
    await mkdir(dir, { recursive: true });
    await gitImport(dir, fastImportStream({ input, snapshots, output: code, file: basename(item.rel) }));
    log(`git geçmişi: ${dir}`, 'ok');
  }
  // A-24: paket modüllerini ayrı dosyalara yaz (önce çözülmüş çıktı, olmazsa haritalı girdi)
  if (o.split) {
    const bundle = splitBundle(code, { map: false }) ?? splitBundle(r.text ?? input);
    if (!bundle) {
      log('paket yapısı bulunamadı; bölünecek modül yok', 'warn');
    } else {
      const dir = ctx.batch ? join(o.split, item.rel.replace(/[\\/]/g, '_')) : o.split;
      await mkdir(dir, { recursive: true });
      const used = new Set();
      for (const m of bundle.modules) {
        let name = m.id.replace(/^[./\\]+/, '').replace(/[^\w.@-]+/g, '_').slice(0, 120) || 'module';
        if (!/\.[cm]?[jt]sx?$/.test(name)) name += '.js';
        while (used.has(name)) name = `_${name}`;
        used.add(name);
        await writeFile(join(dir, name), `// ${bundle.kind} module ${m.id}${m.deps.length ? ` — deps: ${m.deps.join(', ')}` : ''}\n${m.code}\n`);
      }
      log(`${bundle.modules.length} ${bundle.kind} modülü yazıldı: ${dir}`, 'info');
    }
  }
  if (ctx.history) {
    const seen = await ctx.history.seen(input, code);
    if (seen.exact.length) log(`bu girdi daha önce görüldü: ${seen.exact.map((e) => `${e.name} (${new Date(e.time).toISOString().slice(0, 10)})`).join(', ')}`, 'warn');
    else if (seen.sameOutput.length) log(`farklı girdi, aynı çözüm: ${seen.sameOutput.map((e) => e.name).join(', ')}`, 'warn');
    else if (seen.similar.length) log(`benzer çözüm görüldü: ${seen.similar.slice(0, 3).map((x) => `${x.entry.name} (%${Math.round(x.score * 100)})`).join(', ')}`, 'warn');
    result.seen = { exact: seen.exact.length, sameOutput: seen.sameOutput.length, similar: seen.similar.length };
    await ctx.history.add({ name: item.rel, source: item.path === '-' ? '' : resolve(item.path), input, output: code, stats: r.stats });
  }
  log(`${item.rel}: ${((performance.now() - t0) / 1000).toFixed(2)}s`, 'ok');
  if (!o.json || target) delete result.code;
  return result;
}

export const RUN_HELP = `Kullanım / Usage:
  peel <girdi.js|dizin|-> [...] [seçenekler]

Seçenekler / Options:
  -o, --out <dosya>          çıktı dosyası (tek girdi; varsayılan stdout)
  -d, --out-dir <dizin>      toplu işte çıktı dizini (girdi yapısı korunur)
  -r, --report <dosya>       analiz raporu (JSON)
      --sarif <dosya>        SARIF 2.1.0 (GitHub code scanning)
      --html <dosya>         önce/sonra raporu (bağımsız HTML)
      --git <dizin>          her pass bir commit olacak şekilde git deposu
  -n, --names <dosya>        paylaşılan ad haritası (JSON: {"eski": "yeni"} ya da PEEL ad haritası)
  -f, --format <profil>      biçim profili: default, compact, wide, standard, airbnb, tabs
      --dts <dosya>          kullanımdan çıkarılan TypeScript bildirimleri (.d.ts)
  -m, --source-map <dosya>   kaynak haritasından isim kurtar (kısmi harita da olur)
  -s, --split <dizin>        webpack/esbuild/browserify/Parcel/haritalı paket modüllerini dizine yaz
      --out-map <dosya>      çıktıdan girdiye kaynak haritası (Source Map v3) yaz
  -p, --profile <ad>         pass profili: all (varsayılan), auto (tanınan araca göre) ya da profil adı
      --order-search         birden çok pass sırası dene, en iyi doğrulanmış sonucu tut
      --cascade              seviye 1→4 kademeli çöz (her aşama öncekinin doğrulanmış çıktısı üzerinde)
      --incident <dosya>     olay müdahale raporu (Markdown; yanında JSON)
      --json                 sonuçları JSON olarak stdout'a yaz
      --vm-out <dizin>       bytecode VM'lerin bytecode/ISA, assembly, IR ve çevrilmiş kodunu yaz
      --jsvmp                jsvmp modu: yalnızca VM pass'leri, stderr'e handler ve disassembly özeti
  -l, --level <1-4>          pass seviyesi (varsayılan 4)
      --no-sandbox           sandbox kullanma (yalnızca statik pass'ler)
      --no-deep              pass başına davranış doğrulamasını kapat
      --style <auto|dizin>   .prettierrc/.editorconfig/.eslintrc kurallarına uy
      --rules <dosya>        dönüşüm kuralları (kural dili)
      --plugin <dosya>       eklenti (.js ya da imzalı .peelplugin), tekrarlanabilir
      --trust <anahtar|dosya> güvenilen eklenti imza anahtarı, tekrarlanabilir
      --project <a.peel>     proje dosyasından girdi, seçenek, kural ve adlar
      --save-project <a.peel> sonuçları proje dosyasına yaz
      --semgrep              çıktıyı yerel Semgrep ile tara (--semgrep-config <yml>)
      --history              çözümü geçmişe kaydet, daha önce görüldüyse uyar
      --fail-on <low|medium|high> risk bu düzeye ulaşırsa çıkış kodu 4
  -w, --watch                dosya değiştikçe yeniden çöz
  -c, --config <dosya>       yapılandırma (varsayılan: peel.config.json)
      --lang <tr|en>         kod içi açıklamaların ve HTML raporun dili (varsayılan tr)
  -q, --quiet                stderr'e log yazma
  -h, --help                 yardım

Alt komutlar / Subcommands:
  diff, track, history, serve, bot, asar, symbols, share, unshare, plugin,
  explain, techniques, learn, ctf, obfuscate, anonymize, changelog, passes, asm, vm-compare
  (peel <komut> --help)

Çıkış kodları / Exit codes: 0 tamam, 1 hata, 2 kullanım, 3 değişiklik (track --once), 4 risk eşiği`;

export async function runCommand(argv) {
  const { opts, positional } = parseArgs(argv, RUN_SPEC);
  if (opts.help) { console.log(RUN_HELP); return EXIT.OK; }
  const cfg = await loadConfig(opts.config);
  const o = {
    level: opts.level ?? cfg.level,
    sandbox: opts.sandbox ?? cfg.sandbox,
    deep: opts.deep ?? cfg.deep,
    style: opts.style ?? cfg.style,
    rules: opts.rules ?? cfg.rules,
    plugins: [...(cfg.plugins ?? []), ...opts.plugin],
    trust: [...(cfg.trust ?? []), ...opts.trust],
    sarif: opts.sarif ?? cfg.sarif,
    html: opts.html ?? cfg.html,
    report: opts.report,
    git: opts.git,
    sourceMap: opts['source-map'],
    split: opts.split,
    profile: opts.profile,
    orderSearch: opts['order-search'],
    cascade: opts.cascade,
    incident: opts.incident,
    outMap: opts['out-map'],
    json: opts.json,
    failOn: opts['fail-on'] ?? cfg.failOn,
    semgrep: opts.semgrep ?? cfg.semgrep,
    semgrepConfig: opts['semgrep-config'] ?? cfg.semgrepConfig,
    outDir: opts['out-dir'] ?? cfg.outDir,
    vmOut: opts['vm-out'],
    jsvmp: opts.jsvmp,
    lang: opts.lang ?? cfg.lang,
    names: opts.names,
    format: opts.format,
    dts: opts.dts,
  };
  if (o.format && !Object.hasOwn(FORMAT_PROFILES, o.format)) throw new UsageError(`--format: ${Object.keys(FORMAT_PROFILES).join('|')}`);
  if (o.level !== undefined && ![1, 2, 3, 4].includes(o.level)) throw new UsageError('--level 1-4 olmalı');
  if (o.failOn && !RISK_ORDER.slice(1).includes(o.failOn)) throw new UsageError('--fail-on low|medium|high olmalı');
  if (o.profile && o.profile !== 'auto' && !Object.hasOwn(PROFILES, o.profile)) throw new UsageError(`--profile: ${Object.keys(PROFILES).join(', ')}, auto`);
  const log = makeLogger(opts.quiet);

  // proje dosyası: girdiler ve seçenekler oradan gelir (komut satırı bayrakları önceliklidir)
  let project = null;
  let items;
  if (opts.project) {
    project = parseProject(await readFile(opts.project, 'utf8'));
    o.level ??= project.options.level;
    o.sandbox ??= project.options.sandbox;
    o.deep ??= project.options.deep;
    items = project.files.map((f) => ({ path: f.name, rel: f.name, input: f.input, renames: f.renames }));
  }
  if (positional.length) items = await expandInputs(positional);
  if (!items?.length) { console.error(RUN_HELP); return EXIT.USAGE; }

  const batch = items.length > 1;
  if (batch && opts.out) throw new UsageError('Birden çok girdide -o yerine --out-dir kullanın');
  if (batch && !o.outDir && !o.json) throw new UsageError('Birden çok girdi için --out-dir ya da --json gerekli');
  if (opts.watch && items.some((i) => i.path === '-' || i.input !== undefined)) throw new UsageError('--watch yalnızca dosya girdileriyle çalışır');

  const plugins = await loadPlugins({ plugins: o.plugins, trust: o.trust, rules: o.rules }, log);
  if (project?.rules && !o.rules) plugins.push(rulesPlugin(project.rules, { id: 'project-rules' }));
  let names = {};
  if (o.names) {
    const r = parseNameMap(await readFile(o.names, 'utf8'));
    if (!r.ok) throw new UsageError(`--names: ${r.error}`);
    names = r.names;
  }
  const ctx = {
    names,
    log,
    plugins,
    batch,
    history: (opts.history ?? cfg.history) ? createHistory(fileStore()) : null,
    outFor: (item) => (o.outDir ? join(o.outDir, item.rel) : batch ? null : opts.out ?? null),
  };

  const runAll = async (list) => {
    const results = [];
    for (const item of list) {
      try {
        results.push(await processOne(item, o, ctx));
      } catch (e) {
        if (e instanceof UsageError) throw e;
        log(`${item.path}: ${e.message}`, 'err');
        results.push({ file: item.path, ok: false, error: e.message });
      }
    }
    return results;
  };

  const results = await runAll(items);
  if (o.json) process.stdout.write(`${JSON.stringify(batch ? results : results[0], null, 2)}\n`);

  if (opts['save-project']) {
    let p = project ?? createProject({ name: basename(opts['save-project'], '.peel'), options: { level: o.level ?? 4, sandbox: o.sandbox !== false, deep: o.deep !== false } });
    for (const [i, item] of items.entries()) {
      const res = results[i];
      const input = item.input ?? (item.path === '-' ? '' : await readFile(item.path, 'utf8'));
      const output = res.out ? await readFile(res.out, 'utf8') : (res.code ?? '');
      p = upsertFile(p, { name: item.rel, input, output });
    }
    await writeFile(opts['save-project'], serializeProject(p));
    log(`proje kaydedildi: ${opts['save-project']}`, 'ok');
  }

  if (opts.watch) {
    log('izleniyor (Ctrl+C ile çık)', 'info');
    const timers = new Map();
    for (const item of items) {
      watch(item.path, () => {
        clearTimeout(timers.get(item.path));
        timers.set(item.path, setTimeout(() => { runAll([item]).catch((e) => log(e.message, 'err')); }, 200));
      });
    }
    await new Promise(() => {});
  }

  if (results.some((r) => !r.ok)) return EXIT.ERROR;
  if (o.failOn) {
    const min = RISK_ORDER.indexOf(o.failOn);
    const hit = results.filter((r) => r.risk && RISK_ORDER.indexOf(r.risk.level) >= min);
    if (hit.length) {
      log(`risk eşiği aşıldı (${o.failOn}): ${hit.map((r) => `${r.file} ${r.risk.score}`).join(', ')}`, 'err');
      return EXIT.RISK;
    }
  }
  return EXIT.OK;
}
