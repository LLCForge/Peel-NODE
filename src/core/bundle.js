import * as t from '@babel/types';
import { parse } from './parse.js';
import { traverse, generate } from '../util/ast.js';
import { inlineSourceMap, decodeMappings, segmentAt } from '../util/sourcemap.js';

// A-24: paketlenmiş kodu modüllere ayırma.
//  webpack 4/5 (modül nesnesi/dizisi, webpackChunk push), browserify, AMD define(), esbuild (__commonJS/__esm ve "// yol.js"
//  işaretleri), kaynak haritalı kapsam birleştirmeli paketler (Rollup): her üst seviye deyim haritadaki kaynağına atanır.
// Dönüş: { kind, modules: [{ id, size, deps, code }] } ya da null (paket değil)

const MAX_MODULES = 2000;

const keyName = (k) => (t.isIdentifier(k) ? k.name : t.isStringLiteral(k) || t.isNumericLiteral(k) ? String(k.value) : null);
const codeOf = (stmts) => generate(t.program(stmts.map((s) => t.cloneNode(s, true)))).code;
const isFn = (n) => t.isFunctionExpression(n) || t.isArrowFunctionExpression(n);

function moduleFromFn(id, fn, requireIndex) {
  const body = t.isBlockStatement(fn.body) ? fn.body.body : [t.expressionStatement(fn.body)];
  const req = fn.params[requireIndex];
  const deps = new Set();
  if (t.isIdentifier(req)) {
    t.traverseFast(fn.body, (n) => {
      if (t.isCallExpression(n) && t.isIdentifier(n.callee, { name: req.name }) && n.arguments.length === 1) {
        const a = n.arguments[0];
        if (t.isStringLiteral(a) || t.isNumericLiteral(a)) deps.add(String(a.value));
      }
    });
  }
  const code = codeOf(body);
  return { id: String(id), size: code.length, deps: [...deps], code };
}

// webpack: modül tablosu (nesne ya da dizi), bootstrap'a argüman, __webpack_modules__ ya da chunk push içinde
function webpack(ast, code) {
  if (!/__webpack_require__|webpackChunk|webpackJsonp|installedModules|__webpack_modules__/.test(code)) return null;
  let best = null;
  traverse(ast, {
    'ObjectExpression|ArrayExpression'(p) {
      const entries = p.isObjectExpression()
        ? p.node.properties.map((x) => (t.isObjectProperty(x) && !x.computed ? [keyName(x.key), x.value] : t.isObjectMethod(x) ? [keyName(x.key), x] : [null, null]))
        : p.node.elements.map((x, i) => [String(i), x]);
      const mods = entries.filter(([k, v]) => k !== null && v && (isFn(v) || t.isObjectMethod(v)) && v.params.length <= 3);
      if (mods.length < 1 || mods.length !== entries.filter(([, v]) => v).length) return;
      const par = p.parentPath;
      const inChunk = par.isArrayExpression() && par.parentPath.isCallExpression() &&
        /webpackChunk|webpackJsonp/.test(generate(par.parentPath.node.callee).code);
      const asArg = par.isCallExpression() && par.node.arguments.includes(p.node) && isFn(par.node.callee) &&
        /\.call\(/.test(generate(par.node.callee.body).code);
      const named = par.isVariableDeclarator() && t.isIdentifier(par.node.id) && /__webpack_modules__/.test(par.node.id.name);
      if (!inChunk && !asArg && !named) return;
      if (mods.length < 2 && !inChunk) return;
      if (!best || mods.length > best.length) best = mods;
    },
  });
  if (!best) return null;
  return { kind: 'webpack', modules: best.slice(0, MAX_MODULES).map(([id, fn]) => moduleFromFn(id, fn, 2)) };
}

// browserify: ({1: [function (require, module, exports) {…}, {"./x": 2}], …}, {}, [1])
function browserify(ast) {
  let found = null;
  traverse(ast, {
    CallExpression(p) {
      const [first] = p.node.arguments;
      if (!t.isObjectExpression(first) || p.node.arguments.length < 2) return;
      const mods = [];
      for (const prop of first.properties) {
        if (!t.isObjectProperty(prop) || !t.isArrayExpression(prop.value)) return;
        const [fn, deps] = prop.value.elements;
        if (!isFn(fn) || !t.isObjectExpression(deps)) return;
        const m = moduleFromFn(keyName(prop.key), fn, 0);
        m.deps = deps.properties.filter((d) => t.isObjectProperty(d)).map((d) => String(t.isLiteral(d.value) ? d.value.value : keyName(d.key)));
        mods.push(m);
      }
      if (mods.length && (!found || mods.length > found.length)) found = mods;
    },
  });
  return found ? { kind: 'browserify', modules: found.slice(0, MAX_MODULES) } : null;
}

// AMD (r.js/almond paketleri): define("ad", ["bağımlılık", …], function (…) {…}) çağrıları
function amd(ast) {
  const mods = [];
  for (const st of ast.program.body) {
    const call = t.isExpressionStatement(st) && t.isCallExpression(st.expression) ? st.expression : null;
    if (!call || !t.isIdentifier(call.callee, { name: 'define' }) || !t.isStringLiteral(call.arguments[0])) continue;
    const fn = call.arguments.at(-1);
    if (!isFn(fn)) continue;
    const m = moduleFromFn(call.arguments[0].value, fn, -1);
    const deps = call.arguments.length === 3 && t.isArrayExpression(call.arguments[1]) ? call.arguments[1].elements : [];
    m.deps = deps.filter((d) => t.isStringLiteral(d)).map((d) => d.value);
    mods.push(m);
  }
  return mods.length >= 2 ? { kind: 'amd', modules: mods.slice(0, MAX_MODULES) } : null;
}

// esbuild: var require_x = __commonJS({ "src/x.js"(exports, module) {…} });  var init_y = __esm({ "src/y.js"() {…} });
function esbuild(ast) {
  const mods = [];
  const byVar = new Map();
  traverse(ast, {
    CallExpression(p) {
      const c = p.node.callee;
      if (!t.isIdentifier(c) || !/^__(commonJS|esm)$/.test(c.name) || p.node.arguments.length !== 1) return;
      const obj = p.node.arguments[0];
      if (!t.isObjectExpression(obj) || obj.properties.length !== 1) return;
      const prop = obj.properties[0];
      const fn = t.isObjectMethod(prop) ? prop : t.isObjectProperty(prop) && isFn(prop.value) ? prop.value : null;
      const id = keyName(prop.key);
      if (!fn || id === null) return;
      const m = moduleFromFn(id, fn, -1);
      m.fn = fn;
      mods.push(m);
      if (p.parentPath.isVariableDeclarator() && t.isIdentifier(p.parent.id)) byVar.set(p.parent.id.name, m.id);
    },
  });
  if (!mods.length) return null;
  for (const m of mods) {
    const deps = new Set();
    t.traverseFast(m.fn.body, (n) => {
      if (t.isCallExpression(n) && t.isIdentifier(n.callee) && byVar.has(n.callee.name)) deps.add(byVar.get(n.callee.name));
    });
    m.deps = [...deps];
    delete m.fn;
  }
  return { kind: 'esbuild', modules: mods.slice(0, MAX_MODULES) };
}

// Kapsamı birleştirilmiş paketin gövdesi: program ya da tek IIFE/UMD sarmalayıcısının en büyük fonksiyonu
function hoistedBody(ast) {
  const body = ast.program.body;
  if (body.length !== 1 || !t.isExpressionStatement(body[0])) return body;
  let e = body[0].expression;
  if (t.isUnaryExpression(e)) e = e.argument;
  if (!t.isCallExpression(e)) return body;
  const fns = [e.callee, ...e.arguments].filter((x) => isFn(x) && t.isBlockStatement(x.body));
  if (!fns.length) return body;
  return fns.sort((a, b) => b.body.body.length - a.body.body.length)[0].body.body;
}

// Gruplar arasındaki bağımlılık: bir grupta bildirilip başka grupta kullanılan adlar
function crossDeps(groups) {
  const owner = new Map();
  groups.forEach((g) => {
    for (const s of g.stmts) {
      const ids = t.isFunctionDeclaration(s) || t.isClassDeclaration(s) ? [s.id?.name] : t.isVariableDeclaration(s)
        ? s.declarations.flatMap((d) => Object.keys(t.getBindingIdentifiers(d.id))) : [];
      for (const id of ids) if (id) owner.set(id, g.id);
    }
  });
  return groups.map((g) => {
    const deps = new Set();
    for (const s of g.stmts) t.traverseFast(s, (n) => { if (t.isIdentifier(n) && owner.has(n.name) && owner.get(n.name) !== g.id) deps.add(owner.get(n.name)); });
    const code = codeOf(g.stmts);
    return { id: g.id, size: code.length, deps: [...deps], code };
  });
}

const PATH_COMMENT = /^\s*((?:\.{0,2}\/)?[\w@.$-]+(?:\/[\w@.$-]+)*\.(?:m?[jt]sx?|cjs|vue|svelte))\s*$/;

// esbuild/rollup okunur çıktısı: modül başında "// src/util.js" yorumu
function commentMarkers(ast) {
  const body = hoistedBody(ast);
  const groups = [];
  for (const s of body) {
    const marker = (s.leadingComments ?? []).map((c) => (c.type === 'CommentLine' ? c.value.match(PATH_COMMENT) : null)).find(Boolean);
    if (marker) groups.push({ id: marker[1], stmts: [] });
    if (groups.length) groups[groups.length - 1].stmts.push(s);
  }
  if (groups.length < 2) return null;
  return { kind: 'scope-hoisted', modules: crossDeps(groups).slice(0, MAX_MODULES) };
}

// Kaynak haritalı paket (Rollup vb.): her üst seviye deyim başlangıcının haritadaki kaynağı
function sourceMapped(ast, code) {
  const found = inlineSourceMap(code);
  if (!found || !Array.isArray(found.map.sources) || found.map.sources.length < 2) return null;
  let lines;
  try { lines = decodeMappings(found.map.mappings); } catch { return null; }
  const groups = [];
  for (const s of hoistedBody(ast)) {
    const loc = s.loc?.start;
    const seg = loc && segmentAt(lines, loc.line - 1, loc.column);
    const src = seg && seg.length >= 4 ? found.map.sources[seg[1]] : null;
    const id = src ?? groups[groups.length - 1]?.id ?? '(haritasız)';
    if (!groups.length || groups[groups.length - 1].id !== id) groups.push({ id, stmts: [] });
    groups[groups.length - 1].stmts.push(s);
  }
  if (new Set(groups.map((g) => g.id)).size < 2) return null;
  // aynı kaynağın parçaları tek modülde toplanır
  const merged = new Map();
  for (const g of groups) {
    if (!merged.has(g.id)) merged.set(g.id, { id: g.id, stmts: [] });
    merged.get(g.id).stmts.push(...g.stmts);
  }
  return { kind: 'source-map', modules: crossDeps([...merged.values()]).slice(0, MAX_MODULES) };
}

// Parcel: parcelRequire.register("id", function (module, exports) {…}) / parcelRegister("id", …)
function parcel(ast) {
  const found = [];
  traverse(ast, {
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      const isRegister = (t.isMemberExpression(callee) && keyName(callee.property) === 'register' && /parcelRequire/.test(generate(callee.object).code)) ||
        t.isIdentifier(callee, { name: 'parcelRegister' });
      if (!isRegister || args.length !== 2 || !isFn(args[1])) return;
      const id = keyName(args[0]) ?? '?';
      const m = moduleFromFn(id, args[1], -1);
      // Parcel bağımlılıkları parcelRequire("id") çağrılarıdır
      t.traverseFast(args[1].body, (n) => {
        if (t.isCallExpression(n) && t.isIdentifier(n.callee) && /^(parcelRequire|require)$/.test(n.callee.name) && n.arguments.length === 1) {
          const a = n.arguments[0];
          if ((t.isStringLiteral(a) || t.isNumericLiteral(a)) && !m.deps.includes(String(a.value))) m.deps.push(String(a.value));
        }
      });
      found.push(m);
    },
  });
  return found.length ? { kind: 'parcel', modules: found.slice(0, MAX_MODULES) } : null;
}

// map: false iken kaynak haritası kullanılmaz (konumları haritayla uyuşmayan, yeniden üretilmiş kod için)
export function splitBundle(code, { map = true } = {}) {
  let ast;
  try { ast = parse(code); } catch { return null; }
  return webpack(ast, code) ?? browserify(ast) ?? esbuild(ast) ?? parcel(ast) ?? amd(ast) ?? commentMarkers(ast) ?? (map ? sourceMapped(ast, code) : null);
}

// Modülleri indirilebilir dosyalara çevirir (ZIP için): güvenli ad, çakışmada kimlik eki
export function moduleFiles(split) {
  const used = new Set();
  return (split?.modules ?? []).map((m) => {
    const base = String(m.id).replace(/^(\.\.?\/)+/, '').replace(/[^\w./-]/g, '_').replace(/\.\.+/g, '.').replace(/^\/+/, '') || 'module';
    let name = /\.(m?js|cjs|ts|jsx|tsx)$/.test(base) ? base : `${/^\d+$/.test(base) ? `module-${base}` : base}.js`;
    if (used.has(name)) name = name.replace(/(\.\w+)$/, `.${used.size}$1`);
    used.add(name);
    const header = `// PEEL modül ${m.id}${m.deps.length ? ` — bağımlılıklar: ${m.deps.join(', ')}` : ''}\n`;
    return { name, text: `${header}${m.code}\n` };
  });
}
