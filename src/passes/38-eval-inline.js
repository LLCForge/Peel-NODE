import * as t from '@babel/types';
import { parse as babelParse } from '@babel/parser';
import { traverse } from '../util/ast.js';

// Fonksiyonun tek deyimi olan sabit string'li doğrudan eval: function (m, e, r) { "use strict"; eval("{...}"); }
// webpack "eval" devtool'u her modülü böyle saklar; obfuscator.io/webpack-obfuscator string dizisi çözülünce
// aynı biçim ortaya çıkar. Kod fonksiyon gövdesine yerleştirilir.
// Eşdeğerlik: fonksiyonda başka deyim yok, eval'in dönüş değeri kullanılmıyor; this/arguments/new.target aynı.
// Atlanır: eval kodu kendi "use strict"i ile sloppy fonksiyonda (kip değişirdi), return/yield/await içeriyorsa
// (eval'de sözdizimi hatası), var/fonksiyon adı bir parametreyle ya da arguments ile çakışıyorsa
// (katı eval'de ayrı değişken olurdu).

const MAX_CODE = 2_000_000;

function parseEvalCode(code) {
  try {
    return babelParse(code, { sourceType: 'script', allowReturnOutsideFunction: false, plugins: ['classProperties', 'classPrivateProperties', 'classPrivateMethods'] });
  } catch {
    return null;
  }
}

// eval kodunun fonksiyon kapsamına çıkacak adları: üst seviye var ve fonksiyon bildirimleri, bloklardaki var'lar
function varNames(program) {
  const names = new Set();
  const visit = (node, top) => {
    if (!node || typeof node.type !== 'string') return;
    if (t.isFunction(node) && !top) return;
    if (t.isVariableDeclaration(node, { kind: 'var' })) {
      for (const d of node.declarations) for (const n of Object.keys(t.getBindingIdentifiers(d.id))) names.add(n);
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach((c) => visit(c, false)); else visit(v, false);
    }
  };
  for (const s of program.body) {
    // üst seviye let/const/class da sayılır: parametreyle aynı adda olursa gövdede yeniden bildirim hatası olur
    if ((t.isFunctionDeclaration(s) || t.isClassDeclaration(s)) && s.id) names.add(s.id.name);
    else if (t.isVariableDeclaration(s)) for (const d of s.declarations) for (const k of Object.keys(t.getBindingIdentifiers(d.id))) names.add(k);
    else visit(s, false);
  }
  return names;
}

export async function run(ast, { onLog, bump }) {
  let n = 0;
  traverse(ast, {
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      if (!t.isIdentifier(callee, { name: 'eval' }) || p.scope.getBinding('eval')) return;
      if (args.length !== 1 || !t.isStringLiteral(args[0]) || args[0].value.length > MAX_CODE) return;
      const stmt = p.parentPath;
      if (!stmt.isExpressionStatement()) return;
      const body = stmt.parentPath;
      const fn = body.parentPath;
      if (!body.isBlockStatement() || !fn?.isFunction() || body.node.body.length !== 1) return;
      if (fn.node.async || fn.node.generator) return;

      const program = parseEvalCode(args[0].value);
      if (!program) return;
      const strictFn = body.isInStrictMode();
      const strictCode = program.program.directives.some((d) => d.value.value === 'use strict');
      if (strictCode && !strictFn) return;

      const params = new Set(['arguments']);
      for (const prm of fn.node.params) for (const k of Object.keys(t.getBindingIdentifiers(prm))) params.add(k);
      if ([...varNames(program.program)].some((x) => params.has(x))) return;

      // fonksiyonun kendi "use strict"i kalır; eval kodunun direktifleri (kip zaten aynı) atılır
      body.node.body = program.program.body;
      n++;
    },
  });
  if (n) onLog(`eval-inline: ${n} sabit eval gövdesi fonksiyonuna yerleştirildi`, 'info');
  bump('evalInline', n);
}
