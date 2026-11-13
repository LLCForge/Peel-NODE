// temel ≤ 1 MB girdide alınır; pass'ler (unflatten kopyaları) çıktıyı büyütebilir, karşılaştırma için daha geniş sınır
const MAX_LEN = 4_000_000;
const MAX_LINES = 2000;

import { observable } from '../verify/effects.js';

// Kodu sandbox'ta çalıştırıp console çıktısını (ve E706: gözlenebilir etkileri) davranış parmak izi olarak alır.
export async function snapshot(sandbox, code, { effects = false } = {}) {
  if (code.length > MAX_LEN) return { ok: false, reason: 'kod çok büyük' };
  const r = await sandbox.run(`try {\n${code}\n} catch (e) { __out.push("!THROW " + (e && e.message)); }`, { timeoutMs: 6000 });
  if (!r.ok) return { ok: false, reason: r.error ?? 'çalıştırılamadı' };
  if (r.out.length > MAX_LINES) return { ok: false, reason: 'çıktı çok uzun' };
  return { ok: true, lines: r.out, effects: effects ? observable(r.effects).map((e) => `${e.kind}|${e.target}|${e.detail}`) : null };
}

export function same(a, b) {
  if (!b.ok) return false;
  if (a.lines.length !== b.lines.length || !a.lines.every((l, i) => l === b.lines[i])) return false;
  if (!a.effects) return true;
  return Boolean(b.effects) && a.effects.length === b.effects.length && a.effects.every((x, i) => x === b.effects[i]);
}
