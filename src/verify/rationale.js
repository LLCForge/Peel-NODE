import * as t from '@babel/types';
import { parse } from '../core/parse.js';
import { traverse } from '../util/ast.js';
import { fnv1a } from '../util/hash.js';

// E718: dönüşüm gerekçesi kaydı — her kabul edilen değişiklik için ne değişti, nasıl doğrulandı, hangi gözlemle.
// C177: gözlemle (sandbox çalıştırmasıyla) üretilen literal değerler; çıktıda ayrı renkle gösterilir.

const MAX_VALUES = 500;

// literal değer → geçiş sayısı (çoklu küme): dizide zaten duran string'in çağrı yerlerine çözülmesi de sayılır
export function literalValues(ast) {
  const out = new Map();
  const add = (k) => out.set(k, (out.get(k) ?? 0) + 1);
  traverse(ast, {
    StringLiteral(p) { if (p.node.value.length <= 200) add(`s:${p.node.value}`); },
    NumericLiteral(p) { add(`n:${p.node.value}`); },
    TemplateElement(p) { if (p.node.value.cooked != null && p.node.value.cooked.length <= 200) add(`s:${p.node.value.cooked}`); },
  });
  return out;
}

// pass sonrası geçiş sayısı artan literal'ler (gözlemle çözülen değerler)
export function observedValues(beforeCode, afterAst) {
  let before;
  try { before = literalValues(parse(beforeCode)); } catch { return []; }
  const added = [];
  for (const [v, n] of literalValues(afterAst)) {
    if (n > (before.get(v) ?? 0)) added.push(v);
    if (added.length >= MAX_VALUES) break;
  }
  return added;
}

export function rationale(pass, beforeCode, afterCode, verifiedBy, afterAst = null) {
  const r = {
    before: fnv1a(beforeCode),
    after: fnv1a(afterCode),
    delta: afterCode.length - beforeCode.length,
    verifiedBy,
    observation: pass.needs === 'sandbox',
  };
  if (pass.needs === 'sandbox' && afterAst) r.observed = observedValues(beforeCode, afterAst);
  return r;
}

const LEVEL_TEXT = {
  parse: 'yeniden parse edildi',
  behaviour: 'console çıktısı temel çalıştırmayla aynı',
  effects: 'console çıktısı ve gözlenebilir etkiler temel çalıştırmayla aynı',
};

// Olay listesinden okunabilir gerekçe kaydı
export function rationaleLog(events = []) {
  return events.filter((e) => e.state === 'ok' || e.state === 'fail').map((e) => ({
    pass: e.id,
    round: e.round,
    accepted: e.state === 'ok',
    why: e.state === 'ok'
      ? [`kod değişti (${e.delta > 0 ? '+' : ''}${e.delta ?? 0} bayt, ${e.before ?? '?'} → ${e.after ?? '?'})`,
        LEVEL_TEXT[e.verifiedBy] ?? 'yalnızca metin katmanı', e.observation ? `sandbox gözlemi (${e.observed?.length ?? 0} değer)` : 'statik dönüşüm'].join('; ')
      : `geri alındı: ${e.reason ?? 'bilinmiyor'}`,
    observed: e.observed ?? [],
  }));
}

// literal anahtarını ("s:değer" / "n:42") çözer
export const decodeLiteral = (k) => (k.startsWith('n:') ? { type: 'number', value: Number(k.slice(2)) } : { type: 'string', value: k.slice(2) });

export const isLiteralNode = (n) => t.isStringLiteral(n) || t.isNumericLiteral(n);
