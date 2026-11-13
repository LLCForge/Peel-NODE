import { parse } from '../core/parse.js';
import { verify } from '../core/verify.js';
import { diffAst, applyPatch } from './patch.js';

// E546: değişiklik başına geri alma. Davranışı değiştiren bir pass tümüyle geri alınmadan önce çıktısı
// AST yamasına bölünür; her işlem sırayla (öncekilerin üstüne) denenir ve yalnızca davranış temelini
// koruyanlar tutulur. Yama işlemleri ayrık bölgelere dokunduğundan her alt küme özgün sırayla uygulanabilir.

export const SALVAGE_MAX_OPS = 16;

/**
 * @param {{ before: string, after: string, check: (code: string) => Promise<boolean>, maxOps?: number }} o
 * @returns {Promise<null | { code: string, kept: number, total: number }>}
 */
export async function salvage({ before, after, check, maxOps = SALVAGE_MAX_OPS }) {
  let patch;
  try { patch = diffAst(parse(before).program, parse(after).program); } catch { return null; }
  const total = patch.ops.length;
  if (total < 2 || total > maxOps) return null;
  const kept = [];
  let code = null;
  for (let i = 0; i < total; i++) {
    const trial = [...kept, i];
    let ast;
    try {
      ast = parse(before);
      ast.program = applyPatch(ast.program, patch, trial);
    } catch {
      continue;
    }
    const v = verify(ast);
    if (!v.ok || v.code === before) continue;
    if (await check(v.code)) { kept.push(i); code = v.code; }
  }
  return kept.length ? { code, kept: kept.length, total } : null;
}
