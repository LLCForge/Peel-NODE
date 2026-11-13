import { PROFILES } from '../core/threat.js';
import { captureRun, analysisConfig } from './dynamic.js';
import { diffEffects, semanticHash } from '../verify/effects.js';

// C47: bot ve gerçek kullanıcı profili karşılaştırması — aynı program iki profille çalıştırılır; konsol, ağ,
// okunan özellikler, taint ve etkiler yan yana; farklar etki farkı motoruyla (E743) çıkarılır.

const summarize = (r) => ({
  ok: r.ok,
  error: r.error ?? r.runError ?? null,
  console: r.console ?? [],
  network: (r.network ?? []).map((n) => `${n.api} ${n.method} ${n.url}`.replace(/\s+/g, ' ').trim()),
  fingerprint: [...new Set((r.fingerprint ?? []).map((f) => f.api))],
  taint: (r.taint ?? []).map((t) => `${t.source} → ${t.sink} (${t.via})`),
  hash: semanticHash(r.effects ?? []),
});

export async function compareProfiles(sandbox, code, a = 'chrome-win', b = 'headless-bot') {
  for (const p of [a, b]) if (p !== 'default' && !Object.hasOwn(PROFILES, p)) throw new Error(`bilinmeyen profil: ${p}`);
  const cfg = (p) => analysisConfig(p === 'default' ? {} : { profile: PROFILES[p] });
  const ra = await captureRun(sandbox, code, cfg(a));
  const rb = await captureRun(sandbox, code, cfg(b));
  const sa = summarize(ra);
  const sb = summarize(rb);
  const only = (x, y) => x.filter((v) => !y.includes(v));
  return {
    profiles: [a, b],
    a: sa,
    b: sb,
    same: sa.hash === sb.hash,
    // profil bağımlı davranış: yalnızca bir tarafta görülen konsol satırı / ağ isteği
    onlyA: { console: only(sa.console, sb.console), network: only(sa.network, sb.network) },
    onlyB: { console: only(sb.console, sa.console), network: only(sb.network, sa.network) },
    diff: diffEffects(ra.effects ?? [], rb.effects ?? []),
  };
}
