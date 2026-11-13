import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { ssaFor } from '../opt/ssa.js';
import { sccp, absint, ALL } from '../opt/lattice.js';
import { isPureTyped, functionPaths, hasDynamicScope } from '../opt/util.js';
import { toIR, varForVersion, decide, proofText } from '../opt/irbridge.js';
import { vars, onlyType, mk, show } from '../symbolic/ir.js';
import { solveAsync } from '../symbolic/solver.js';
import { z3Available } from '../symbolic/z3/z3.js';

// E592: opaque predicate çözümü. Fonksiyon içindeki dal koşulları, SSA sürümleri tip/aralık kafesinden gelen
// sembolik değişkenlere çevrilir; koşulun değilinin tatmin edilemezliği bit-vektör çözücüyle kanıtlanırsa
// (E594: kanıt yöntemi kaydedilir, DRUP kanıtları bağımsız denetlenir) koşul sabitle değiştirilir.
// Madde 30: z3 kullanılabiliyorsa (Node'da her zaman, tarayıcıda cross-origin isolated ise) önce z3 sorulur; katlama
// yine yalnızca yerleşik çözücünün bağımsız, denetlenmiş kanıtıyla yapılır. Raporda her yüklemi kanıtlayan arka uç yazar.

// Adaylar: yan etkisiz, IR'a çevrilebilen, değişkenli koşullar (karar verilmeden)
export function opaqueCandidates(fn) {
  const fx = ssaFor(fn);
  if (!fx) return [];
  sccp(fx);
  absint(fx);
  const typeOf = (id) => (fx.useVer.has(id) ? (fx.abs.useAbs(id)?.ty || ALL) : null);
  // sürümün tanımı yan etkisiz ve çevrilebilirse tanım terimi kullanılır (z = x*x % 4 ilişkisi korunur)
  const termOf = (ver, depth) => {
    if (ver.kind === 'def' && depth < 4) {
      const site = ver.site;
      const rhs = t.isVariableDeclarator(site) ? site.init : t.isAssignmentExpression(site, { operator: '=' }) ? site.right : null;
      if (rhs && isPureTyped(rhs, typeOf, fn.scope)) {
        const ir = toIR(rhs, (id) => (fx.useVer.has(id) ? termOf(fx.useVer.get(id), depth + 1) : null), fn.scope);
        if (ir) return ir;
      }
    }
    return varForVersion(fx, ver);
  };
  const varFor = (id) => (fx.useVer.has(id) ? termOf(fx.useVer.get(id), 0) : null);
  const found = [];
  const seen = new Set();
  // boolValue: değerin kendisi kullanılıyor (a && b'nin sol tarafı): yalnızca boolean tipli koşul sabitlenebilir
  const consider = (p, boolValue = false) => {
    if (!p.node || seen.has(p.node)) return;
    seen.add(p.node);
    if (!isPureTyped(p.node, typeOf, fn.scope)) return;
    const ir = toIR(p.node, varFor, fn.scope);
    if (!ir || ir.k === 'c' || !vars(ir).size) return;
    if (boolValue && !onlyType(ir, 'boolean')) return;
    found.push({ path: p, ir, line: p.node.loc?.start.line ?? 0 });
  };
  for (const b of fx.blocks) {
    if (!fx.sccp.blocks.has(b)) continue;
    for (const ins of b.instrs) {
      if (!ins.path.node) continue;
      if (ins.kind === 'test') consider(ins.path);
      ins.path.traverse({
        Function(p) { p.skip(); },
        ConditionalExpression(p) { consider(p.get('test')); },
        LogicalExpression(p) { if (p.node.operator !== '??') consider(p.get('left'), true); },
      });
    }
  }
  return found;
}

/** Eşzamanlı, yalnızca yerleşik çözücüyle karar (DRUP denetimli) */
export function findOpaque(fn) {
  const out = [];
  for (const c of opaqueCandidates(fn)) {
    const r = decide(c.ir);
    if (r) out.push({ ...c, value: r.value, cond: r.text, proof: r.proof, proofText: proofText(r.proof), backend: 'yerleşik', fold: true });
  }
  return out;
}

// z3 kararı: koşul hep doğru/yanlış mı? (denetlenmemiş: yalnızca aday ve bütçe ipucu)
async function z3Decide(ir) {
  const o = { backend: 'z3', mode: 'prove', timeMs: 2000 };
  if ((await solveAsync([mk('!', ir)], o)).status === 'unsat') return true;
  if ((await solveAsync([ir], o)).status === 'unsat') return false;
  return null;
}

/**
 * Madde 30: z3 + yerleşik çözücü. z3 bir sonuç bildirirse yerleşik çözücü daha geniş bütçeyle bağımsız kanıt arar;
 * katlama (fold) yalnızca yerleşik denetlenmiş kanıt varsa ve iki arka uç çelişmiyorsa yapılır.
 */
export async function proveOpaque(fn, { useZ3 = true } = {}) {
  const cands = opaqueCandidates(fn);
  if (!cands.length) return [];
  const z3 = useZ3 && (await z3Available());
  const out = [];
  for (const c of cands) {
    const zv = z3 ? await z3Decide(c.ir) : null;
    const b = decide(c.ir, [], zv === null ? 600 : 4000);
    const base = { ...c, cond: show(c.ir) };
    if (b && (zv === null || zv === b.value)) {
      out.push({ ...base, value: b.value, proof: b.proof, proofText: proofText(b.proof), backend: zv === null ? 'yerleşik' : 'z3 + yerleşik', fold: true });
    } else if (zv !== null) {
      out.push({ ...base, value: zv, proof: { method: 'z3', checked: false }, proofText: b ? 'arka uçlar çelişti, katlanmadı' : 'z3 kanıtladı, yerleşik çözücü bağımsız kanıtlayamadı: katlanmadı', backend: 'z3', fold: false });
    }
  }
  return out;
}
export async function run(ast, { onLog, bump }) {
  if (hasDynamicScope(ast, traverse)) return;
  let n = 0;
  for (const fn of functionPaths(ast, traverse)) {
    if (!fn.node) continue;
    const items = await proveOpaque(fn);
    for (const it of items) {
      if (!it.path.node) continue;
      if (!it.fold) { onLog(`opaque-smt: satır ${it.line}: ${it.cond} ≡ ${it.value} [${it.backend}] (${it.proofText})`, 'warn'); continue; }
      it.path.replaceWith(t.booleanLiteral(it.value));
      onLog(`opaque-smt: satır ${it.line}: ${it.cond} ≡ ${it.value} [${it.backend}] (${it.proofText})`, 'info');
      n++;
    }
    if (items.length) fn.scope.crawl();
  }
  bump('opaqueSmt', n);
}
