import * as t from '@babel/types';
import { parse } from '../core/parse.js';

const isFunctionCtor = (n) =>
  (t.isCallExpression(n) || t.isNewExpression(n)) && t.isIdentifier(n.callee, { name: 'Function' });

// Program tamamen Function("a", "b", "gövde")(...) ise gövdeyi düz fonksiyon olarak açar.
// String değerlerini parser çözdüğü için tüm kaçış biçimleri (\x, \u, \u{}, satır devamı) doğru işlenir.
export async function run(code, { onLog }) {
  if (!/^[\s;]*(?:new\s+)?Function\s*\(/.test(code)) return code;
  let ast;
  try { ast = parse(code); } catch { return code; }

  const body = ast.program.body.filter((s) => !t.isEmptyStatement(s));
  if (body.length !== 1 || !t.isExpressionStatement(body[0])) return code;

  let expr = body[0].expression;
  let callArgs = null;
  if (t.isCallExpression(expr) && isFunctionCtor(expr.callee)) {
    callArgs = expr.arguments;
    expr = expr.callee;
  }
  if (!isFunctionCtor(expr)) return code;

  const args = expr.arguments;
  if (!args.length || !args.every((a) => t.isStringLiteral(a))) return code;
  if (callArgs?.some((a) => t.isSpreadElement(a))) return code;

  const params = args.slice(0, -1).map((a) => a.value).join(', ');
  const fnBody = args[args.length - 1].value;
  const wrapped = `(function (${params}) {\n${fnBody}\n})`;
  try { parse(wrapped); } catch { return code; }

  const call = callArgs ? `(${callArgs.map((a) => code.slice(a.start, a.end)).join(', ')})` : '';
  onLog(`Function() sarmalayıcı açıldı (${args.length - 1} parametre, ${fnBody.length} karakter)`, 'info');
  return `${wrapped}${call};\n`;
}
