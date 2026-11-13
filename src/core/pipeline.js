import { parse } from './parse.js';
import { verify } from './verify.js';
import { raw, pretty } from './emit.js';
import { fnv1a } from '../util/hash.js';
import { PASSES } from './registry.js';
import { createVmSolver } from '../symbolic/vm-solver.js';
import { snapshot, same } from './behavior.js';
import { rationale } from '../verify/rationale.js';
import { getSettings } from '../sandbox/settings.js';
import { resolvePasses } from '../integrations/plugins.js';
import { validOrder } from '../analysis/passgraph.js';
import { restoreCheckpoint } from '../analysis/trace.js';
import { salvage } from '../analysis/salvage.js';

// js-confuser high (pack + iç içe CFF) katman katman açılır: büyük çekimler 25 turu aşabilir; değişiklik durunca biter
const MAX_ROUNDS = 40;
const MAX_FINISH_ROUNDS = 8;
const CONTEXT_MAX_LEN = 2_000_000;
const DEEP_MAX_LEN = 2_000_000; // QuickJS'te 1 MB'lık programı çalıştırmak saniyenin altında (js-confuser high çekimleri 1 MB'ı aşabilir)

/**
 * @param {string} input
 * @param {object} o
 * @param {object|null} o.sandbox  sandboxApi uyumlu nesne; null ise sandbox pass'leri atlanır
 * @param {object|null} o.trace    analysis/trace.js izleyicisi (yama günlüğü, köken, kontrol noktası, pass grafiği)
 * @param {object|null} o.resume   trace.checkpoint() çıktısı: o turdan devam edilir
 * @param {string[]|null} o.passOrder AST pass sırası (bağımlılıklara uymuyorsa yok sayılır)
 */
export async function deobfuscate(input, {
  level = 2, only = null, sandbox = null, deep = false, signal = null, verifyLevel = null,
  onLog = () => {}, onProgress = () => {}, onPass = () => {}, onSnapshot = () => {},
  // order: pass kimliklerinin kullanıcı sırası; onLayer: değişen metin katmanı; onApprove: her kabulden önce onay (false → reddet)
  order = null, onLayer = () => {}, onApprove = null,
  plugins = [],
  trace = null, resume = null, passOrder = null,
  naming = {}, format = 'default',
} = {}) {
  // izleyici log satırlarını pass gerekçesi olarak toplar (E558)
  if (trace) { const base = onLog; onLog = (m, lv) => { trace.log(m, lv); base(m, lv); }; }
  const stats = {};
  const bump = (k, n = 1) => { if (n) stats[k] = (stats[k] || 0) + n; };
  const checkAbort = () => { if (signal?.aborted) throw new Error('İptal edildi'); };

  let enabled = resolvePasses(PASSES, plugins).filter((p) => (only ? only.includes(p.id) : p.level <= level));
  if (!sandbox) enabled = enabled.filter((p) => p.needs !== 'sandbox');
  if (order) {
    const rank = (id) => { const i = order.indexOf(id); return i < 0 ? order.length + PASSES.findIndex((p) => p.id === id) : i; };
    enabled = [...enabled].sort((a, b) => rank(a.id) - rank(b.id));
  }
  const textPasses = enabled.filter((p) => p.kind === 'text');
  let astPasses = enabled.filter((p) => p.kind === 'ast');
  if (passOrder) {
    if (validOrder(passOrder)) {
      const pos = new Map(passOrder.map((id, i) => [id, i]));
      astPasses = [...astPasses].sort((a, b) => (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity));
    } else {
      onLog('pass sırası bağımlılıklara uymuyor, kayıt sırası kullanıldı', 'warn');
    }
  }
  const resumed = resume ? restoreCheckpoint(resume) : null;
  if (resumed) Object.assign(stats, resumed.stats);

  const totalSteps = Math.max(1, textPasses.length + astPasses.length * 2);
  let step = 0;
  const tick = () => onProgress(Math.min(99, Math.round((++step / totalSteps) * 100)));

  // findings: pass'lerin rapora aktardığı analiz verileri (VM, durum makinesi, string tablosu)
  const findings = { vm: [], sm: [], strings: [] };
  // madde 27: VM pass'inin concolic çoklu yol keşfi için çözücü bağdaştırıcısı (çalıştırma başına bir kez)
  // naming: ad haritası/sözlük ve okunabilirlik seçenekleri; source: metin katmanları açılmış girdi (yorum geri yükleme)
  const ctx = { onLog, bump, level, sandbox, ctx: null, findings, naming, source: null, solver: sandbox ? createVmSolver(sandbox) : null };
  // E720: doğrulama seviyesi — parse her zaman; behaviour = console; effects ve üstü = console + gözlenebilir etkiler
  const vLevel = verifyLevel ?? (deep ? getSettings().verifyLevel : 'parse');
  const behaviourCheck = deep && !['none', 'parse'].includes(vLevel);
  const effectsCheck = behaviourCheck && vLevel !== 'behaviour';

  // Pass başına süre ve sonuç: rapor ve zaman çizelgesi için
  const events = [];
  let passStart = 0;
  let round = 0;
  const pass = (id, state, reason, extra = null) => {
    if (state === 'run') passStart = performance.now();
    else events.push({ id, round, state, ms: Math.round(performance.now() - passStart), reason, ...extra });
    onPass(id, state);
  };

  // 1) metin pass'leri: parse öncesi sarmalayıcı/kodlayıcı katmanları
  let text = resumed ? resumed.text : input;
  for (const p of resumed ? [] : textPasses) {
    checkAbort();
    pass(p.id, 'run');
    try {
      const next = await p.mod.run(text, ctx);
      checkAbort();
      if (typeof next === 'string' && next !== text) {
        text = next;
        pass(p.id, 'ok');
        onLayer({ id: p.id, code: text });
      } else {
        pass(p.id, 'skip');
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      onLog(`${p.id}: ${e.message}`, 'warn');
      pass(p.id, 'fail');
    }
    tick();
  }

  ctx.source = text;
  let code;
  try {
    code = resumed ? resumed.code : raw(parse(text));
  } catch (e) {
    return { code: text, stats, events, text, error: e.message, findings };
  }
  onSnapshot({ id: 'girdi', round: 0, code });
  trace?.start(code, astPasses);

  // davranış temeli alınamazsa (program sandbox'ta çalışmazsa) değişiklikler yalnızca parse ile doğrulanır
  let baseline = null;
  try {
    // 2) değerlendirme bağlamı: program bir kez yüklenir, decoder'lar o bağlamda çağrılır
    if (sandbox && text.length <= CONTEXT_MAX_LEN) {
      const r = await sandbox.open(text, { timeoutMs: 8000 });
      checkAbort();
      if (r.ok) {
        ctx.ctx = r.token;
        onLog(r.runError ? `bağlam açıldı, program hata verdi: ${r.runError}` : 'değerlendirme bağlamı açıldı', r.runError ? 'warn' : 'info');
      } else {
        onLog(`bağlam açılamadı: ${r.error}`, 'warn');
      }
    }

    if (behaviourCheck && sandbox) {
      if (text.length > DEEP_MAX_LEN) {
        onLog('derin doğrulama kapalı: kod çok büyük', 'warn');
      } else {
        const snap = await snapshot(sandbox, code, { effects: effectsCheck });
        checkAbort();
        if (snap.ok) {
          baseline = snap;
          onLog(`davranış temeli alındı (${snap.lines.length} satır)`, 'info');
        } else {
          onLog(`derin doğrulama kapalı: ${snap.reason}`, 'warn');
        }
      }
    }

    // 3) AST pass'leri: değişiklik durana kadar tur
    const seen = new Set([fnv1a(code)]);
    // finish: true olan okunabilirlik pass'leri, çözme pass'leri sabitlendikten sonra devreye girer
    // (ör. kısa metot sözdizimi proxy tanımayı engellemesin)
    let finishing = !astPasses.some((p) => !p.finish);
    let finishRounds = 0;
    for (round = resumed ? resumed.round + 1 : 1; round <= MAX_ROUNDS; round++) {
      let changed = false;
      for (const p of astPasses) {
        if (p.finish && !finishing) continue;
        checkAbort();
        pass(p.id, 'run');
        // her pass taze ağaçla başlar: Babel'in scope önbelleği önceki pass'in mutasyonlarından etkilenmez
        const ast = parse(code);
        try {
          await p.mod.run(ast, ctx);
          checkAbort();
        } catch (e) {
          if (signal?.aborted) throw e;
          onLog(`${p.id}: ${e.message}, geri alındı`, 'warn');
          pass(p.id, 'fail', `hata: ${e.message}`);
          trace?.record(p.id, round, 'fail', code, events.at(-1).ms, `hata: ${e.message}`);
          tick();
          continue;
        }
        const v = verify(ast);
        if (!v.ok) {
          onLog(`${p.id}: doğrulama başarısız (${v.reason}), geri alındı`, 'warn');
          pass(p.id, 'fail', `parse: ${v.reason}`);
          trace?.record(p.id, round, 'fail', code, events.at(-1).ms, `parse: ${v.reason}`);
          tick();
          continue;
        }
        if (v.code === code) {
          pass(p.id, 'skip');
          trace?.record(p.id, round, 'skip', code, events.at(-1).ms);
          tick();
          continue;
        }
        if (baseline) {
          const snap = await snapshot(sandbox, v.code, { effects: effectsCheck });
          checkAbort();
          if (!same(baseline, snap)) {
            onLog(`${p.id}: davranış değişti, geri alındı`, 'warn');
            pass(p.id, 'fail', 'davranış');
            trace?.record(p.id, round, 'fail', code, events.at(-1).ms, 'davranış');
            // E546: değişiklik başına geri alma — davranışı koruyan yama işlemleri tutulur
            const part = await salvage({ before: code, after: v.code, check: async (c) => same(baseline, await snapshot(sandbox, c, { effects: effectsCheck })) });
            checkAbort();
            if (part) {
              onLog(`${p.id}: değişiklik başına geri alma, ${part.kept}/${part.total} değişiklik davranışı koruyor ve tutuldu`, 'info');
              const prev = code;
              code = part.code;
              changed = true;
              if (trace) code = trace.commit(`${p.id}~kısmi`, round, prev, code, 0);
              onSnapshot({ id: `${p.id}~kısmi`, round, code });
            }
            tick();
            continue;
          }
        }
        if (onApprove && !(await onApprove({ id: p.id, round, before: code, after: v.code }))) {
          checkAbort();
          pass(p.id, 'skip', 'reddedildi');
          tick();
          continue;
        }
        const prev = code;
        code = v.code;
        changed = true;
        // E718: gerekçe kaydı (özetler, boyut farkı, doğrulama düzeyi, gözlemle çözülen değerler)
        pass(p.id, 'ok', undefined, rationale(p, prev, code, baseline ? (effectsCheck ? 'effects' : 'behaviour') : 'parse', ast));
        if (trace) code = trace.commit(p.id, round, prev, code, events.at(-1).ms);
        onSnapshot({ id: p.id, round, code });
        tick();
      }
      trace?.checkpoint({ round, code, text, stats });
      const h = fnv1a(code);
      // salınım (aynı kod yeniden) de sabitlenme sayılır: okunabilirlik aşaması yine de çalışır
      if ((!changed || seen.has(h)) && !finishing && astPasses.some((p) => p.finish)) { finishing = true; seen.add(h); continue; }
      if (!changed || seen.has(h)) break;
      // okunabilirlik aşaması yalnızca biçim değiştirir: sınırsız sürerse (salınım, büyüyen yorum) çıktıyı bekletmesin
      if (finishing && ++finishRounds >= MAX_FINISH_ROUNDS) { onLog(`okunabilirlik aşaması ${MAX_FINISH_ROUNDS} turda sabitlenmedi, durduruldu`, 'warn'); break; }
      seen.add(h);
    }
  } finally {
    // iptalde worker zaten öldürüldü: bağlamı kapatmak için yenisini başlatma
    if (ctx.ctx && !signal?.aborted) await sandbox.close(ctx.ctx);
  }

  const out = await pretty(code, format);
  onProgress(100);
  // text: metin katmanları açıldıktan sonraki program; rapor çalışma anı analizini bunun üzerinde yapar
  return { code: out, stats, events, text, verified: Boolean(baseline), verifyLevel: baseline ? (effectsCheck ? 'effects' : 'behaviour') : 'parse', findings };
}
