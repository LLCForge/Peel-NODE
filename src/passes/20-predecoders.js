import * as t from '@babel/types';
import { parse } from '../core/parse.js';

const MAX_DEPTH = 4;
const MAX_SRC = 3_000_000;
const MIN_PAYLOAD = 12;

// eval ve Function kurucusunu yakalayan kancalar. jsfuck/aaencode/jjencode Function'a
// [].filter.constructor zinciriyle ulaştığı için Function.prototype.constructor da değiştirilir.
// Kurulan fonksiyon gerçekten üretilir: aaencode/jjencode Function('return "\\143..."')() ile önce kaynağı
// çözen ara fonksiyonu çalıştırır, jsfuck Function("return eval")() ile eval'e ulaşır. Ara gövdeler de
// yakalanır; tek bir return deyiminden ibaret olanlar aday sayılmaz (aşağıda).
// Yakalananlar doğrudan __res'e yazılır: yük zaman aşımına uğrasa da kaybolmaz.
const HOOKS = `
var __captured = __res;
var __RealFunction = Function;
var __fake = function () {
  var a = Array.prototype.slice.call(arguments);
  __captured.push(String(a.length ? a[a.length - 1] : ""));
  try { return __RealFunction.apply(null, a); } catch (e) { return function () {}; }
};
try { Object.defineProperty(Function.prototype, "constructor", { value: __fake, configurable: true, writable: true }); } catch (e) {}
globalThis.Function = __fake;
globalThis.eval = function (s) { __captured.push(String(s)); };
`;

const JSFUCK = /^[\s[\]()!+]+;?\s*$/;
const AAENCODE = /ﾟДﾟ|ﾟΘﾟ|ﾟｰﾟ/;
const JJENCODE = /\$=~\[\];/;
// jjencode global değişken adı seçilebilir: _peel=~[];_peel={___:++_peel,...
const JJENCODE_GV = /([A-Za-z_$][\w$]*)=~\[\];\1=\{___:\+\+\1/;
// yorum satırları (lisans başlığı vb.) jsfuck alfabesinin dışında kalsın
const isJsfuck = (code) => JSFUCK.test(code.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''));
// Function("return eval") ya da Function('return"\\143..."') gibi tek return'lük ara gövdeler program değildir
const isThunk = (ast) => ast.program.body.length === 1 && t.isReturnStatement(ast.program.body[0]);

// Program yalnızca bir kod çözücü sarmalayıcı mı? (packer, eval(atob(..)), jsfuck, aaencode, jjencode ...)
function isWrapperProgram(ast, code) {
  if (JJENCODE.test(code) || JJENCODE_GV.test(code) || AAENCODE.test(code)) return true;
  const body = ast.program.body.filter((s) => !t.isEmptyStatement(s));
  if (body.length !== 1 || !t.isExpressionStatement(body[0])) return false;
  if (isJsfuck(code)) return true;
  let e = body[0].expression;
  while (t.isCallExpression(e) || t.isNewExpression(e)) {
    if (t.isIdentifier(e.callee, { name: 'eval' }) || t.isIdentifier(e.callee, { name: 'Function' })) return true;
    e = e.callee;
  }
  return /\[\s*["']constructor["']\s*\]|\.constructor\b/.test(code);
}

async function decodeOnce(code, sandbox) {
  if (code.length > MAX_SRC) return null;
  let ast;
  try { ast = parse(code); } catch { return null; }
  if (!isWrapperProgram(ast, code)) return null;

  const r = await sandbox.run(`${HOOKS}\ntry {\n${code}\n} catch (e) {}`, { timeoutMs: 4000 });
  for (const candidate of r.res ?? []) {
    if (typeof candidate !== 'string' || candidate.trim().length < MIN_PAYLOAD || candidate === code) continue;
    try {
      if (!isThunk(parse(candidate))) return candidate;
    } catch {
      // sonraki aday
    }
  }
  return isJsfuck(code) ? jsfuckString(code, sandbox) : null;
}

// Çalıştırılmayan jsfuck ifadesi (JSFuck.encode(s, false)) yalnızca bir string üretir: değeri literal olarak yaz
async function jsfuckString(code, sandbox) {
  const expr = code.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim().replace(/;$/, '');
  const r = await sandbox.batch([expr], { timeoutMs: 4000 });
  const v = r.ok ? r.results[0] : null;
  if (!v?.ok || v.type !== 'string') return null;
  return `${JSON.stringify(v.value)};\n`;
}

export async function run(code, { onLog, sandbox }) {
  let current = code;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const next = await decodeOnce(current, sandbox);
    if (!next) break;
    onLog(`predecoder: katman ${depth + 1} çözüldü (${next.length} karakter)`, 'info');
    current = next;
  }
  return current;
}
