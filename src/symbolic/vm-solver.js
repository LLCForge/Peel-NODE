// API: createVmSolver(sandbox) → { planBranches({ log, branches, code }) → Promise<plan[]> }
// Pipeline her çalıştırmada bir kez oluşturup pass bağlamına ctx.solver olarak koyar (75-vm.js madde 27).
//
// Concolic çoklu yol keşfi: program concolic sürücüyle (concolic.js) çalıştırılır; dal kararları yeniden oynatılıp yol
// koşulları çıkarılır, alınmayan dallar için koşul olumsuzlanıp çözülür ve bulunan girdilerle program yeniden çalışır.
// VM pass'inin dal anahtarları ("makine:dal") kaynak konumlarıyla (branches[].start, code içinde) eşlenir.
// Her alınmayan dal yönü için sonuç:
//   feasible        — çözücü girdi buldu ve somut çalıştırma dalı gerçekten o yöne götürdü (inputs ile)
//   infeasible      — gözlenen her yol önekinde olumsuzlanmış koşul tatmin edilemez (kanıtlı, somutlaştırmasız)
//   unknown         — çözücü karar veremedi ya da girdi bulunamadı: eski davranış, dal zorlanır (doğrulanmamış)
// Plan öğesi: { force: { "m:j": [kaçıncı değerlendirme, değer] }, inputs?, status, key, value, proof? }
import { concolic } from './concolic.js';

const MAX_PLANS = 8;

export function createVmSolver(sandbox, { maxRuns = 14, timeMs = 8000 } = {}) {
  return {
    async planBranches({ log, branches, code }) {
      // temel çalıştırmada görülen yönler; her dal anahtarı için ilk değer
      const seen = new Map();
      for (const [k, v] of log) {
        if (!seen.has(k)) seen.set(k, new Set());
        seen.get(k).add(Boolean(v));
      }
      const wanted = [];
      for (const b of branches) {
        const dirs = seen.get(b.key);
        if (!dirs) continue; // hiç değerlendirilmemiş dal: önce ona götüren durum gerekir
        for (const v of [true, false]) if (!dirs.has(v)) wanted.push({ ...b, value: v });
      }
      if (!wanted.length) return [];
      let res = null;
      if (code && sandbox) {
        try { res = await concolic(sandbox, code, { maxRuns, timeMs }); } catch { res = null; }
      }
      const plans = [];
      for (const w of wanted) {
        const goal = `${w.start}:${w.value}`;
        if (res?.ok && w.start != null) {
          // somut koşu bu yöne gitti mi? (çözücü girdisiyle)
          const idx = res.runEvents.findIndex((evs) => evs.some(([id, v]) => id === w.start && v === w.value));
          if (idx >= 0) {
            const run = res.runs[idx];
            plans.push({ key: w.key, value: w.value, status: 'feasible', inputs: run.minimized ?? run.inputs, force: {} });
            continue;
          }
          const g = res.goals[goal];
          if (g && g.unsat > 0 && !g.sat && !g.unknown) {
            plans.push({ key: w.key, value: w.value, status: 'infeasible', proof: g.proof, force: {} });
            continue;
          }
        }
        // çözülemedi: dal zorlanır, sonuç doğrulanmamış sayılır
        plans.push({ key: w.key, value: w.value, status: 'unknown', force: { [w.key]: [1, w.value] } });
      }
      return plans.slice(0, MAX_PLANS);
    },
  };
}
