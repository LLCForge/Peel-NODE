import { extractFunctions, similarity } from './compare.js';

// J195: dayanıklılık skoru. Kendi kodunu obfuscate edip PEEL'e çözdürdüğünde (J194) ne kadarının geri
// kazanıldığını ölçer: 0 = PEEL kodu tamamen geri getirdi, 100 = hiçbir şey geri gelmedi.
// Bileşenler: yapısal benzerlik (fonksiyon bazında, isimden bağımsız), string geri kazanımı ve
// çözülmüş çıktıda kalan gizleme izleri (_0x adları, onaltılık çağrılar).

function strings(fns) {
  const s = new Set();
  for (const f of fns) for (const x of f.strings) if (x.length >= 3) s.add(x);
  return s;
}

/**
 * @param {{original: string, deobfuscated: string}} o
 * @returns {{score: number, recovered: number, structure: number, strings: number, residue: number, details: object}}
 */
export function resilienceScore({ original, deobfuscated }) {
  const A = extractFunctions(original).fns;
  let B;
  try {
    B = extractFunctions(deobfuscated).fns;
  } catch {
    return { score: 100, recovered: 0, structure: 0, strings: 0, residue: 1, details: { error: 'çözülmüş çıktı parse edilemiyor' } };
  }
  // her orijinal fonksiyon için en iyi eş; ağırlık = fonksiyon boyu
  let wsum = 0;
  let acc = 0;
  const perFunction = [];
  for (const a of A.slice(1)) {
    let best = 0;
    for (const b of B.slice(1)) {
      if (best === 1) break;
      const s = similarity(a, b);
      if (s > best) best = s;
    }
    wsum += a.size;
    acc += a.size * best;
    perFunction.push({ name: a.name, line: a.line, similarity: Number(best.toFixed(3)) });
  }
  const structure = wsum ? acc / wsum : similarity(A[0], B[0]);
  const sa = strings(A);
  const sb = strings(B);
  const found = [...sa].filter((x) => sb.has(x)).length;
  const strRec = sa.size ? found / sa.size : 1;
  const obfIds = (deobfuscated.match(/\b_0x[0-9a-f]{3,}\b/gi) ?? []).length;
  const hexCalls = (deobfuscated.match(/\w\(\s*0x[0-9a-f]+\s*(,\s*0x[0-9a-f]+\s*)*\)/gi) ?? []).length;
  const tokens = Math.max(1, B.reduce((n, f) => n + f.size, 0) / 10);
  const residue = Math.min(1, (obfIds + hexCalls * 3) / tokens);
  const recovered = Math.max(0, 0.55 * structure + 0.35 * strRec + 0.1 * (1 - residue));
  return {
    score: Math.round((1 - recovered) * 100),
    recovered: Number(recovered.toFixed(3)),
    structure: Number(structure.toFixed(3)),
    strings: Number(strRec.toFixed(3)),
    residue: Number(residue.toFixed(3)),
    details: { perFunction, missingStrings: [...sa].filter((x) => !sb.has(x)).slice(0, 50), obfuscatedIds: obfIds, hexCalls },
  };
}
