import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { isPureExpr, literalValue } from '../util/pure.js';

const MIN_MAP = 3;

// window/self alias'ı üzerinden erişildiğinde güvenle çıplak isme indirgenebilecek global'ler
const KNOWN_GLOBALS = new Set([
  'document', 'navigator', 'location', 'console', 'localStorage', 'sessionStorage', 'history', 'screen',
  'performance', 'crypto', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
  'fetch', 'XMLHttpRequest', 'JSON', 'Math', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Date', 'RegExp',
  'Promise', 'parseInt', 'parseFloat', 'atob', 'btoa', 'encodeURIComponent', 'decodeURIComponent', 'alert',
  'Error', 'Symbol', 'Map', 'Set', 'WeakMap', 'Uint8Array', 'TextEncoder', 'TextDecoder', 'URL', 'Image',
]);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);

// Proxy değeri yalnızca identifier + statik üye zinciri olabilir; kullandığı isimleri döndürür.
function valueNames(node, out = new Set()) {
  if (t.isIdentifier(node)) { out.add(node.name); return out; }
  if (t.isMemberExpression(node)) {
    if (node.computed && !t.isStringLiteral(node.property) && !t.isNumericLiteral(node.property)) return null;
    return valueNames(node.object, out);
  }
  return null;
}

// Switch'in anahtar ifadesi: function V(k) { switch (k) ... }
// ya da js-confuser biçimi: function V(...O) { O.length = 1; switch (O[0]) ... }
function switchOfProxy(params, stmts) {
  const [first] = params;
  if (params.length !== 1) return null;
  if (t.isIdentifier(first) && stmts.length >= 1 && t.isSwitchStatement(stmts[0]) &&
      t.isIdentifier(stmts[0].discriminant, { name: first.name })) return { sw: stmts[0], index: 0 };
  if (!t.isRestElement(first) || !t.isIdentifier(first.argument) || stmts.length < 2) return null;
  const name = first.argument.name;
  const [len, sw] = stmts;
  const isLen = t.isExpressionStatement(len) && t.isAssignmentExpression(len.expression, { operator: '=' }) &&
    t.isMemberExpression(len.expression.left) && t.isIdentifier(len.expression.left.object, { name }) &&
    t.isIdentifier(len.expression.left.property, { name: 'length' }) && t.isNumericLiteral(len.expression.right) &&
    len.expression.right.value >= 1;
  const d = sw && t.isSwitchStatement(sw) && sw.discriminant;
  const isFirstArg = d && t.isMemberExpression(d) && d.computed && t.isIdentifier(d.object, { name }) &&
    t.isNumericLiteral(d.property, { value: 0 });
  return isLen && isFirstArg ? { sw, index: 1 } : null;
}

// E97: function W(k) { return T[k]; }  (T sabit nesne literali)  ya da  function W(k) { return { a: f, b: g }[k]; }
// W("a")(x) → f(x). Anahtar nesnenin kendi anahtarı değilse (toString gibi prototip adı) çağrı açılmaz.
function readLookupProxy(fnPath) {
  const { params, body } = fnPath.node;
  if (params.length !== 1 || !t.isIdentifier(params[0]) || !t.isBlockStatement(body) || body.body.length !== 1) return null;
  const ret = body.body[0];
  const m = t.isReturnStatement(ret) && ret.argument;
  if (!t.isMemberExpression(m) || !m.computed || !t.isIdentifier(m.property, { name: params[0].name })) return null;
  let obj = m.object;
  // ayrı tablo değerleri kurulum anında okunur: çağrı anında aynı kalmaları için yalnızca sabit bağlamalı adlar
  const snapshot = t.isIdentifier(obj);
  let tableStmt = null;
  if (t.isIdentifier(obj)) {
    const b = fnPath.scope.getBinding(obj.name);
    if (!b?.constant || !b.path.isVariableDeclarator() || !t.isObjectExpression(b.path.node.init)) return null;
    // tablo yalnızca bu proxy içinden okunmalı (başka yerde değiştirilemez)
    if (!b.referencePaths.every((r) => r.findParent((x) => x === fnPath))) return null;
    obj = b.path.node.init;
    tableStmt = b.path.parentPath;
  }
  if (!t.isObjectExpression(obj)) return null;
  const entries = [];
  const keys = new Set();
  for (const prop of obj.properties) {
    if (!t.isObjectProperty(prop) || prop.computed) return null;
    const key = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) || t.isNumericLiteral(prop.key) ? String(prop.key.value) : null;
    if (key === null || key === '__proto__' || keys.has(key)) return null;
    keys.add(key);
    const names = valueNames(prop.value);
    if (!names) return null;
    for (const n of names) if (fnPath.scope.getOwnBinding(n)) return null;
    if (snapshot && (!t.isIdentifier(prop.value) || !fnPath.scope.getBinding(prop.value.name)?.constant)) return null;
    entries.push({ key, value: prop.value, names });
  }
  if (!entries.length) return null;
  entries.tableStmt = tableStmt;
  return entries;
}

// function V(k) { switch (k) { case "a": return X.y; ... } }
function readProxy(fnPath) {
  const lookup = readLookupProxy(fnPath);
  if (lookup) return lookup;
  const { params, body } = fnPath.node;
  if (!t.isBlockStatement(body)) return null;
  const found = switchOfProxy(params, body.body);
  if (!found) return null;
  const { sw, index } = found;

  const entries = [];
  sw.cases.forEach((c, i) => {
    if (!c.test) return;
    // boş case bir sonrakine düşer: case A: case B: return X;
    let j = i;
    while (j < sw.cases.length && !sw.cases[j].consequent.length) j++;
    const cons = sw.cases[j]?.consequent;
    if (!cons || !t.isReturnStatement(cons[0])) return;
    const value = cons[0].argument;
    const names = value && valueNames(value);
    if (!names) return;
    // değer proxy'nin kendi parametresine/yereline bağlıysa çağrı yerine taşınamaz
    for (const n of names) if (fnPath.scope.getOwnBinding(n)) return;
    entries.push({ testPath: fnPath.get(`body.body.${index}.cases.${i}.test`), value, names, ret: cons[0], own: i === j, disc: sw.discriminant });
  });
  return entries.length >= MIN_MAP ? entries : null;
}

async function resolveKeys(paths, { sandbox, ctx }) {
  const keys = new Array(paths.length).fill(undefined);
  const dynamic = [];
  paths.forEach((p, i) => {
    const lit = literalValue(p.node);
    if (lit.ok && (typeof lit.value === 'string' || typeof lit.value === 'number')) keys[i] = String(lit.value);
    else if (ctx && isPureExpr(p, { programFns: true })) dynamic.push(i);
  });
  if (dynamic.length) {
    const r = await sandbox.batchIn(ctx, dynamic.map((i) => gen(paths[i].node)));
    if (r.ok) {
      dynamic.forEach((i, j) => {
        const v = r.results[j];
        if (v?.ok && (v.type === 'string' || v.type === 'number')) keys[i] = String(v.value);
      });
    }
  }
  return keys;
}

// E637: anahtarı statik çözülemeyen case'ler (closure değişkeni, hesaplanan sabit) programı bir kez çalıştırıp
// proxy'nin hangi anahtarla hangi case'ten döndüğü gözlenerek tamamlanır. Yalnızca case testi yan etkisiz
// (çağrı/atama içermeyen) ve düşmesiz case'ler; her anahtar tek case'e, her case tek anahtara eşlenmeli.
const sideEffectFree = (node) => {
  let ok = true;
  const visit = (n) => {
    if (!n || typeof n !== 'object' || !ok) return;
    if (t.isCallExpression(n) || t.isNewExpression(n) || t.isAssignmentExpression(n) || t.isUpdateExpression(n) ||
        t.isFunction(n) || t.isAwaitExpression(n) || t.isYieldExpression(n) || t.isTaggedTemplateExpression(n)) { ok = false; return; }
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit); else visit(v);
    }
  };
  visit(node);
  return ok;
};

async function observeKeys(ast, entries, idx, sandbox) {
  const undo = [];
  for (const i of idx) {
    const e = entries[i];
    const arg = e.ret.argument;
    e.ret.argument = t.callExpression(t.identifier('__peelPxR'), [t.numericLiteral(i), t.cloneNode(e.disc, true), arg]);
    undo.push(() => { e.ret.argument = arg; });
  }
  const code = gen(ast);
  undo.forEach((u) => u());
  const prelude = `var __peelPxSeen = {};
function __peelPxR(i, k, v) {
  var s = typeof k === "string" || typeof k === "number" ? String(k) : null;
  if (!(i in __peelPxSeen)) __peelPxSeen[i] = s; else if (__peelPxSeen[i] !== s) __peelPxSeen[i] = null;
  return v;
}`;
  const r = await sandbox.run(`${prelude}\ntry {\n${code}\n} catch (e) {}\n__res.push(__peelPxSeen);`, { timeoutMs: 6000 });
  return r.res?.[0] ?? {};
}

export async function run(ast, { onLog, bump, sandbox, ctx, level = 2, findings }) {
  const proxies = [];
  traverse(ast, {
    FunctionDeclaration(p) {
      const entries = readProxy(p);
      if (entries) proxies.push({ name: p.node.id.name, fnPath: p, declScope: p.parentPath.scope, entries });
    },
    VariableDeclarator(p) {
      if (!t.isIdentifier(p.node.id) || !t.isFunctionExpression(p.node.init)) return;
      const entries = readProxy(p.get('init'));
      if (entries) proxies.push({ name: p.node.id.name, fnPath: p.get('init'), declScope: p.scope, entries, declarator: p });
    },
  });

  const globalRoots = sandbox && proxies.length ? await probeGlobalRoots(ast, proxies, sandbox) : new Set();

  let total = 0;
  for (const [pi, px] of proxies.entries()) {
    const binding = px.declScope.getBinding(px.name);
    if (!binding?.constant) continue;

    const lookup = px.entries[0].key !== undefined;
    const keys = lookup ? px.entries.map((e) => e.key) : await resolveKeys(px.entries.map((e) => e.testPath), { sandbox, ctx });
    const open = lookup ? [] : keys.map((k, i) => i).filter((i) => keys[i] === undefined && px.entries[i].own && sideEffectFree(px.entries[i].testPath.node));
    let tried = 0;
    if (open.length && sandbox && level >= 3) {
      const seen = await observeKeys(ast, px.entries, open, sandbox);
      const used = new Set(keys.filter((k) => k !== undefined));
      const counts = new Map();
      for (const i of open) if (typeof seen[i] === 'string') counts.set(seen[i], (counts.get(seen[i]) ?? 0) + 1);
      for (const i of open) {
        const k = seen[i];
        if (typeof k !== 'string' || used.has(k) || counts.get(k) !== 1) continue;
        keys[i] = k;
        tried++;
      }
      if (tried) onLog(`proxy ${px.name}: ${tried} anahtar çalıştırılarak bulundu (tablo denemeyle tamamlandı)`, 'info');
    }
    if (findings) (findings.proxy ??= []).push({ name: px.name, entries: px.entries.length, resolved: keys.filter((k) => k !== undefined).length, byTrial: tried });
    const map = new Map();
    px.entries.forEach((e, i) => { if (keys[i] !== undefined && !map.has(keys[i])) map.set(keys[i], e); });
    if (map.size < (lookup ? 1 : MIN_MAP)) continue;

    const calls = binding.referencePaths
      .map((ref) => ref.parentPath)
      .filter((c) => c.isCallExpression() && c.node.arguments.length === 1 && !c.findParent((x) => x === px.fnPath));
    const callKeys = await resolveKeys(calls.map((c) => c.get('arguments.0')), { sandbox, ctx });

    let n = 0;
    calls.forEach((call, i) => {
      const entry = callKeys[i] !== undefined && map.get(callKeys[i]);
      if (!entry || !call.node) return;
      // tablo, aynı fonksiyondaki çağrıdan önce kurulmuş olmalı (öncesinde orijinal TypeError verirdi)
      const ts = px.entries.tableStmt;
      if (ts && call.getFunctionParent() === ts.getFunctionParent() && call.node.start < ts.node.end) return;
      // Çalışma anında global nesne olduğu doğrulanan kökler (N = U() → globalThis) globalThis'e yazılır;
      // diğer her isim çağrı yerinde de aynı binding'e çözülmeli
      const roots = new Set([...entry.names].filter((name) => globalRoots.has(`${pi}:${name}`)));
      if (roots.size && call.scope.getBinding('globalThis')) return;
      for (const name of entry.names) {
        if (!roots.has(name) && call.scope.getBinding(name) !== px.fnPath.scope.getBinding(name)) return;
      }
      const value = roots.size ? globalize(t.cloneNode(entry.value, true), roots, call.scope) : t.cloneNode(entry.value, true);
      // W("a")(x): proxy'nin döndürdüğü fonksiyon this'siz çağrılıyordu; üye ifadesi (0, X.y) ile yazılır
      const asCallee = call.parentPath.isCallExpression({ callee: call.node }) || call.parentPath.isTaggedTemplateExpression({ tag: call.node });
      call.replaceWith(asCallee && t.isMemberExpression(value) ? t.sequenceExpression([t.numericLiteral(0), value]) : value);
      n++;
    });
    if (!n) continue;
    total += n;
    onLog(`proxy ${px.name}: ${n}/${calls.length} çağrı çözüldü (${map.size} eşleme)`, 'info');

    px.declScope.crawl();
    const after = px.declScope.getBinding(px.name);
    if (after && after.referencePaths.every((r) => r.findParent((x) => x === px.fnPath))) {
      (px.declarator ?? px.fnPath).remove();
    }
  }

  total += simplifyGlobalAliases(ast, onLog);
  bump('proxy', total);
}

// Proxy değerlerinin kök isimleri (N.window → N) programı çalıştırırken global nesneye mi eşit?
// Proxy gövdesinin başına geçici bir kayıt çağrısı ekleyip program sandbox'ta bir kez çalıştırılır.
async function probeGlobalRoots(ast, proxies, sandbox) {
  const inserted = [];
  proxies.forEach((px, pi) => {
    const names = new Set(px.entries.flatMap((e) => [...e.names]));
    const stmts = [...names].map((name) => t.expressionStatement(
      t.callExpression(t.identifier('__peelRoot'), [t.stringLiteral(`${pi}:${name}`), t.identifier(name)])));
    px.fnPath.node.body.body.unshift(...stmts);
    inserted.push([px.fnPath.node.body.body, stmts.length]);
  });
  const code = gen(ast);
  for (const [body, count] of inserted) body.splice(0, count);

  const prelude = 'var __peelRoots = {}; function __peelRoot(k, v) { if (__peelRoots[k] !== false) __peelRoots[k] = v === globalThis; }';
  const r = await sandbox.run(`${prelude}\ntry {\n${code}\n} catch (e) {}\n__res.push(__peelRoots);`, { timeoutMs: 10000 });
  const seen = r?.res?.[0] ?? {};
  return new Set(Object.keys(seen).filter((k) => seen[k] === true));
}

// N.window → window, N.kyIZ5A → globalThis.kyIZ5A (bilinmeyen isim çıplak yazılırsa ReferenceError fırlatabilir)
function globalize(node, roots, scope) {
  if (t.isIdentifier(node) && roots.has(node.name)) return t.identifier('globalThis');
  if (!t.isMemberExpression(node)) return node;
  node.object = globalize(node.object, roots, scope);
  const prop = !node.computed && t.isIdentifier(node.property) ? node.property.name
    : node.computed && t.isStringLiteral(node.property) ? node.property.value : null;
  if (t.isIdentifier(node.object, { name: 'globalThis' }) && prop &&
      (KNOWN_GLOBALS.has(prop) || GLOBAL_OBJECTS.has(prop)) && !scope.getBinding(prop)) {
    return t.identifier(prop);
  }
  return node;
}

// var A = window; ... A.document → document
function simplifyGlobalAliases(ast, onLog) {
  let total = 0;
  traverse(ast, {
    VariableDeclarator(p) {
      const { id, init } = p.node;
      if (!t.isIdentifier(id) || !t.isIdentifier(init) || !GLOBAL_OBJECTS.has(init.name)) return;
      if (p.scope.getBinding(init.name)) return;
      const b = p.scope.getBinding(id.name);
      if (!b?.constant) return;
      let n = 0;
      for (const ref of b.referencePaths) {
        const m = ref.parentPath;
        if (!m.isMemberExpression({ object: ref.node }) || m.node.computed) continue;
        const prop = m.node.property.name;
        if (!KNOWN_GLOBALS.has(prop) || m.scope.getBinding(prop)) continue;
        const parent = m.parentPath;
        if (parent.isAssignmentExpression({ left: m.node }) || parent.isUpdateExpression() ||
            parent.isUnaryExpression({ operator: 'delete' })) continue;
        // çağrıda this değişmesin diye A.setTimeout(...) gibi doğrudan çağrılar da güvenli: global fonksiyonlar this'e bakmaz
        m.replaceWith(t.identifier(prop));
        n++;
      }
      if (!n) return;
      total += n;
      p.scope.crawl();
      const after = p.scope.getBinding(id.name);
      if (after && !after.referenced) p.remove();
      onLog(`global alias ${id.name} sadeleştirildi (${n})`, 'info');
    },
  });
  return total;
}
