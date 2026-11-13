import * as t from '@babel/types';
import { parse as babelParse } from '@babel/parser';
import { traverse, gen } from '../util/ast.js';

// Node katmanları: çalışma anında üretilip çalıştırılan kod deyim olarak yerine yazılır.
//   eval(X)                                     → X'in deyimleri (doğrudan eval: yerel kapsam aynı)
//   vm.runInThisContext(X), (0, eval)(X), new vm.Script(X).runInThisContext(), vm.runInNewContext(X)
//                                               → X'in deyimleri (yalnızca program düzeyinde: global kapsam)
//   Function(X)(), new Function("a", X)(b)      → (function (a) { X })(b)
//   M._compile(X, F)                            → (function (exports, require, module, __filename, __dirname) { X })
//                                                  .call(M.exports, M.exports, require, M, F, __dirname)
//   require("./yazılmış.js")                    → modül sarmalayıcısı içinde dosya içeriği (fs ile önceden yazılmışsa)
// X'in değeri programın enstrümante çalıştırmasından alınır. Güvenlik: aynı program dış girdiler (env, argv, dosya,
// ağ yanıtı, taklit modül dönüşleri, saat, rastgelelik) farklı verilerek ikinci kez çalıştırılır; değer iki çalıştırmada
// birebir aynı değilse ya da yer hiç/farklı değerlerle çalıştıysa dokunulmaz. Böylece dışarıya bağlı kod silinmez.
// Kapsam: yük, yer değiştirdiği noktada bağlı bir ada başvuruyorsa ya da program düzeyindeki bir adı yeniden
// bildiriyorsa (global kapsamda çalışan türler için) açılmaz. Değişiklik ayrıca pipeline'ın davranış denetiminden geçer.

const MAX_CODE = 1_000_000;
const MAX_SITES = 64;
const PARSE_OPTS = { sourceType: 'script', allowReturnOutsideFunction: false, plugins: ['classProperties', 'classPrivateProperties', 'classPrivateMethods', 'optionalChaining', 'nullishCoalescingOperator'] };

const PRELUDE = `globalThis.__peelLayers = {};
globalThis.__peelLayer = function (i, x) {
  var s = typeof x === "string" ? x : x instanceof Uint8Array ? String(x) : null;
  var r = __peelLayers[i];
  if (!r) __peelLayers[i] = { n: 1, code: s };
  else { r.n++; if (r.code !== s) r.code = null; }
  return x;
};
globalThis.__peelReq = function (i, f) {
  var start = __peelDyn.length;
  try { return f(); } finally {
    var d = __peelDyn.slice(start).filter(function (x) { return x.via === "require"; })[0];
    var s = d && d.length === d.code.length ? d.code : null;
    var r = __peelLayers[i];
    if (!r) __peelLayers[i] = { n: 1, code: s };
    else { r.n++; if (r.code !== s) r.code = null; }
  }
};`;
const POST = '__res.push(JSON.stringify(__peelLayers));';
// dış girdi farklılaştırması: Node taklitleri alt kipte farklı değer döner, saat ve rastgelelik tohumu değişir
const ALT_CONFIG = { node: { alt: true }, now: 1600000000000, seed: 4242 };

const propName = (m) => (t.isMemberExpression(m) ? (!m.computed && t.isIdentifier(m.property) ? m.property.name : t.isStringLiteral(m.property) ? m.property.value : null) : null);
const isGlobalName = (p, node, name) => t.isIdentifier(node, { name }) && !p.scope.getBinding(name);

// Çağrı bir katman yürütücüsü mü? { kind, code: kod argümanının yolu, params?, args? }
function sinkOf(p) {
  const { callee, arguments: args } = p.node;
  if (isGlobalName(p, callee, 'eval') && args.length === 1) return { kind: 'eval', code: p.get('arguments.0') };
  if (t.isSequenceExpression(callee) && callee.expressions.length === 2 && t.isNumericLiteral(callee.expressions[0]) &&
      isGlobalName(p, callee.expressions[1], 'eval') && args.length === 1) return { kind: 'global', code: p.get('arguments.0') };
  const name = propName(callee);
  if ((name === 'runInThisContext' || name === 'runInNewContext') && args.length >= 1 && !t.isNewExpression(callee.object)) {
    // runInNewContext(X, bağlam): bağlam nesnesi global gibi davranır, düz deyimlere çevrilemez
    if (name === 'runInNewContext' && args.length > 1) return null;
    return { kind: 'global', code: p.get('arguments.0') };
  }
  if (name === 'runInThisContext' && t.isNewExpression(callee.object) && callee.object.arguments.length >= 1 &&
      (t.isIdentifier(callee.object.callee, { name: 'Script' }) || propName(callee.object.callee) === 'Script')) {
    return { kind: 'global', code: p.get('callee.object.arguments.0') };
  }
  if (name === '_compile' && args.length >= 1 && t.isIdentifier(callee.object)) return { kind: 'module', code: p.get('arguments.0'), mod: callee.object.name, file: args[1] ?? null };
  if ((t.isCallExpression(callee) || t.isNewExpression(callee)) && isGlobalName(p, callee.callee, 'Function') && callee.arguments.length >= 1) {
    const ctor = callee.arguments;
    if (!ctor.slice(0, -1).every((a) => t.isStringLiteral(a)) || args.some((a) => t.isSpreadElement(a))) return null;
    return { kind: 'function', code: p.get(`callee.arguments.${ctor.length - 1}`), params: ctor.slice(0, -1).map((a) => a.value), args };
  }
  if (isGlobalName(p, callee, 'require') && args.length === 1 && t.isStringLiteral(args[0]) && /^\.{0,2}[\\/]/.test(args[0].value)) return { kind: 'require', file: args[0].value };
  return null;
}

// Yük: { body, strict, globals (bağsız başvurular), declared (üst düzey adlar), lexical, usesThis }
function parsePayload(code, kind) {
  const fnLike = kind === 'function' || kind === 'module' || kind === 'require';
  let ast;
  try {
    ast = babelParse(fnLike ? `(function () {\n${code}\n})` : code, PARSE_OPTS);
  } catch {
    return null;
  }
  const body = fnLike ? ast.program.body[0].expression.body : ast.program;
  const info = { body: body.body, directives: body.directives, strict: body.directives.some((d) => d.value.value === 'use strict'), globals: [], declared: [], lexical: false, usesThis: false };
  traverse(ast, {
    Program(p) { info.globals = Object.keys(p.scope.globals); },
    // üst düzey this (ok fonksiyonları kendi this'ini taşımaz)
    ThisExpression(p) {
      const f = p.findParent((x) => x.isFunction() && !x.isArrowFunctionExpression());
      if (!f || (fnLike && f.node === ast.program.body[0].expression)) info.usesThis = true;
    },
  });
  for (const s of info.body) {
    if (t.isVariableDeclaration(s)) {
      if (s.kind !== 'var') info.lexical = true;
      for (const d of s.declarations) info.declared.push(...Object.keys(t.getBindingIdentifiers(d.id)));
    } else if ((t.isFunctionDeclaration(s) || t.isClassDeclaration(s)) && s.id) {
      if (t.isClassDeclaration(s)) info.lexical = true;
      info.declared.push(s.id.name);
    }
  }
  return info;
}

const WRAP_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname'];

// Yer değiştirme deyimleri (null: güvenle yapılamaz)
function replacement(site, payload, stmt) {
  const scope = stmt.scope;
  const bound = (n) => scope.hasBinding(n, true);
  const block = (stmts) => t.blockStatement(stmts);
  const strictIife = (stmts) => t.expressionStatement(t.callExpression(t.functionExpression(null, [], t.blockStatement(stmts, [t.directive(t.directiveLiteral('use strict'))])), []));
  switch (site.kind) {
    case 'eval': {
      // doğrudan eval yerel kapsamı görür: yalnızca let/const/class (eval'e özel) ve katı kip yalıtılmalı
      if (payload.strict) return payload.usesThis ? null : [strictIife(payload.body)];
      return payload.lexical ? [block(payload.body)] : payload.body;
    }
    case 'global': {
      if (!stmt.parentPath.isProgram()) return null;
      if (payload.globals.some(bound) || payload.declared.some(bound)) return null;
      if (payload.strict) return payload.usesThis ? null : [strictIife(payload.body)];
      return payload.lexical ? [block(payload.body)] : payload.body;
    }
    case 'function': {
      if (payload.globals.some((n) => !site.params.includes(n) && bound(n))) return null;
      const fn = t.functionExpression(null, site.params.map((n) => t.identifier(n)), t.blockStatement(payload.body, payload.directives));
      return [t.expressionStatement(t.callExpression(fn, site.args))];
    }
    case 'module':
    case 'require': {
      if (!stmt.parentPath.isProgram()) return null;
      if (payload.globals.some((n) => !WRAP_PARAMS.includes(n) && bound(n))) return null;
      const fn = t.functionExpression(null, WRAP_PARAMS.map((n) => t.identifier(n)), t.blockStatement(payload.body, payload.directives));
      if (site.kind === 'module') {
        const m = () => t.identifier(site.mod);
        const exp = () => t.memberExpression(m(), t.identifier('exports'));
        const file = site.file ? t.cloneNode(site.file) : t.memberExpression(m(), t.identifier('filename'));
        return [t.expressionStatement(t.callExpression(t.memberExpression(fn, t.identifier('call')), [exp(), exp(), t.identifier('require'), m(), file, t.identifier('__dirname')]))];
      }
      // require("./x.js") (dönüş değeri kullanılmıyor): yeni modül nesnesiyle bir kez çalıştırılır
      if (['require', 'module', '__dirname', '__filename'].some(bound)) return null;
      const mod = t.objectExpression([t.objectProperty(t.identifier('exports'), t.objectExpression([]))]);
      const inner = t.callExpression(t.memberExpression(fn, t.identifier('call')), [
        t.memberExpression(t.identifier('module'), t.identifier('exports')), t.memberExpression(t.identifier('module'), t.identifier('exports')),
        t.identifier('require'), t.identifier('module'), t.stringLiteral(site.file), t.identifier('__dirname')]);
      const outer = t.functionExpression(null, [t.identifier('module')], t.blockStatement([t.expressionStatement(inner)]));
      return [t.expressionStatement(t.callExpression(outer, [mod]))];
    }
    default:
      return null;
  }
}

async function capture(sandbox, code, config) {
  const r = await sandbox.run(`${PRELUDE}\ntry {\n${code}\n} catch (e) {}`, { timeoutMs: 6000, post: POST, config });
  for (const x of r.res ?? []) {
    if (typeof x !== 'string') continue;
    try { return JSON.parse(x); } catch { /* sonraki */ }
  }
  return null;
}

export async function run(ast, { onLog, bump, sandbox, env }) {
  if (env !== 'node' || !sandbox) return;
  const sites = [];
  traverse(ast, {
    CallExpression(p) {
      if (sites.length >= MAX_SITES) return;
      const stmt = p.parentPath;
      if (!stmt.isExpressionStatement() || !(stmt.parentPath.isProgram() || stmt.parentPath.isBlockStatement())) return;
      const s = sinkOf(p);
      if (!s) return;
      if (s.code && t.isStringLiteral(s.code.node) && s.kind === 'eval') return; // sabit eval: eval-inline'ın işi
      sites.push({ ...s, path: p, stmt, id: sites.length });
    },
  });
  if (!sites.length) return;

  // enstrümantasyon: kod argümanı __peelLayer(i, X) ile, require çağrısı __peelReq(i, () => require(...)) ile sarılır
  const originals = sites.map((s) => (s.kind === 'require' ? s.path.node : s.code.node));
  sites.forEach((s, i) => {
    const hook = s.kind === 'require'
      ? t.callExpression(t.identifier('__peelReq'), [t.numericLiteral(i), t.arrowFunctionExpression([], originals[i])])
      : t.callExpression(t.identifier('__peelLayer'), [t.numericLiteral(i), originals[i]]);
    (s.kind === 'require' ? s.path : s.code).replaceWith(hook);
  });
  const instrumented = gen(ast.program);
  sites.forEach((s, i) => (s.kind === 'require' ? s.path : s.code).replaceWith(originals[i]));

  const [base, alt] = [await capture(sandbox, instrumented, {}), await capture(sandbox, instrumented, ALT_CONFIG)];
  if (!base) return;
  let n = 0;
  let unsafe = 0;
  for (const s of sites) {
    const a = base[s.id];
    const b = alt?.[s.id];
    if (!a || typeof a.code !== 'string' || a.code.length > MAX_CODE) continue;
    if (!b || b.code !== a.code || b.n !== a.n) { unsafe++; continue; }
    const payload = parsePayload(a.code, s.kind);
    if (!payload) continue;
    // stmt yolu enstrümantasyon sırasında değişmedi; yine de düğüm hâlâ ağaçta mı
    if (!s.stmt.node || s.stmt.node.expression !== s.path.node) continue;
    const nodes = replacement(s, payload, s.stmt);
    if (!nodes) continue;
    if (nodes.length) s.stmt.replaceWithMultiple(nodes); else s.stmt.remove();
    n++;
  }
  if (unsafe) onLog(`node-layers: ${unsafe} katman dış girdiye bağlı ya da tutarsız, yerinde bırakıldı`, 'info');
  if (n) onLog(`node-layers: ${n} çalışma anı katmanı açıldı`, 'info');
  bump('nodeLayers', n);
}
