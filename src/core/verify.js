import { parse } from './parse.js';
import { raw } from './emit.js';

// Pass sonrası ağaç koda dönüşüyor ve o kod yeniden parse ediliyor mu?
export function verify(ast) {
  let code;
  try { code = raw(ast); } catch (e) { return { ok: false, reason: `emit: ${e.message}` }; }
  try { parse(code); } catch (e) { return { ok: false, reason: `reparse: ${e.message}` }; }
  return { ok: true, code };
}
