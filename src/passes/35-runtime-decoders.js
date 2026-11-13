import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { literalValue } from '../util/pure.js';
import { readDispatcher } from './37-confuser.js';
import { parse } from '../core/parse.js';

// Closure içinde tanımlı decoder'lar (ör. sarmalayıcı fonksiyonun içindeki M) statik olarak
// erişilemez. Program, her literal argümanlı çağrı __peelCall üzerinden geçecek şekilde
// sandbox'ta çalıştırılır; decoder fonksiyonu ilk çağrıldığı anda yakalanır ve sonra
// tüm çağrılar o fonksiyonla, iki kez çalıştırılıp aynı string'i veriyorsa çözülür.
//
// Argümanı değişkene bağlı çağrılar (M(T + 273), durum makinesi sayaçları) çalışma anında
// gözlenir: her çalıştırmada aynı string'i veren çağrı yeri o string'le değiştirilir.
// shortcut: gözlem tek çalıştırmaya dayanır, gözlenmeyen girdi için yanlış olabilir; bu yüzden yalnızca seviye 3+.

const MIN_CALLS = 3;
const MIN_STRING_RATIO = 0.8;
const MAX_ARGS = 3;
// js-confuser her fonksiyona kendi decoder kopyasını koyar (tek çağrılık). Eşiği yalnızca gövdesi
// string çözen fonksiyonlarda indir: aksi halde pad(5) gibi sıradan fonksiyonlar da sabitlenirdi.
const DECODER_BODY = /fromCharCode|fromCodePoint|charCodeAt|\batob\b|\.slice\(|\.substr(ing)?\(|decodeURIComponent/;
const DECODER_SRC = DECODER_BODY.source;
// obfuscator.io stringArrayIndexesType: 'hexadecimal-numeric-string' ve 0.18 sürümü indeksi "0x1f" string'i olarak verir
const isIndexLit = (v) => typeof v === 'number' || (typeof v === 'string' && /^-?0x[0-9a-f]+$/i.test(v));

const PRELUDE = `
var __peelFns = {};
var __peelSeen = {};
function __peelCall(id, fn, args) {
  if (typeof fn === "function" && !__peelFns[id]) __peelFns[id] = fn;
  return fn.apply(undefined, args);
}
function __peelObs(k, v) {
  var s = __peelSeen[k];
  if (s === undefined) __peelSeen[k] = typeof v === "string" ? v : null;
  else if (s !== v) __peelSeen[k] = null;
  return v;
}
// js-confuser global gizleme: getter("dZGlvoH") → console. Sonuç bir global nesneyse adını döndür.
function __peelGlobalName(v) {
  if (v === globalThis) return "\\u0000global:globalThis";
  if (v === null || (typeof v !== "object" && typeof v !== "function")) return null;
  var names = Object.getOwnPropertyNames(globalThis);
  for (var i = 0; i < names.length; i++) {
    var k = names[i];
    if (k.indexOf("__peel") === 0 || !/^[A-Za-z_$][\\w$]*$/.test(k)) continue;
    try { if (globalThis[k] === v) return "\\u0000global:" + k; } catch (e) {}
  }
  return null;
}
function __peelSrcOf(id) {
  var f = __peelFns[id];
  return typeof f === "function" ? Function.prototype.toString.call(f) : null;
}
function __peelSrcOk(id) {
  var f = __peelFns[id];
  return typeof f === "function" && /${DECODER_SRC}/.test(Function.prototype.toString.call(f));
}
// yan etki gözlenirse (console çıktısı, ağ isteği) decoder sayılmaz
var __peelImpure = {};
function __peelEval(id, args) {
  var f = __peelFns[id];
  if (!f) return null;
  var o = __out.length, n = __peelNet.length;
  var a = f.apply(undefined, args);
  if (__out.length !== o || __peelNet.length !== n) { __peelImpure[id] = true; return null; }
  var b = f.apply(undefined, args);
  if (a !== b) return null;
  return typeof a === "string" ? a : __peelGlobalName(a);
}
`;

// İç içe çağrılarda dıştaki çağrı önce değiştirildiyse içteki yol artık ağaçta değildir
function attached(p) {
  for (let q = p; q.parentPath; q = q.parentPath) {
    const owner = q.listKey ? q.parentPath.node?.[q.listKey] : q.parentPath.node;
    if (!q.node || q.container !== owner || q.container[q.key] !== q.node) return false;
  }
  return Boolean(p.node);
}

// kaynak metin: JSON NaN/Infinity/undefined'ı null yapardı
const argsKey = (call) => `[${call.node.arguments.map((a) => gen(a)).join(', ')}]`;

// obfuscator.io rotasyon döngüsü: decoder'ı checksum için çağırıp diziyi push(shift()) ile döndürür.
// Bu çağrıları son değerleriyle değiştirmek döngüyü erken bitirir ve diziyi döndürülmemiş bırakır.
const ROTATION = /\.push\([^;]*\.shift\(\)\)|\["push"\]\([^;]*\["shift"\]\(\)\)/;
// gövde metni fonksiyon başına bir kez üretilir: her çağrıda yeniden üretmek büyük dosyada O(çağrı × boyut)
const rotationCache = new WeakMap();
function isRotationFn(node) {
  // yalnızca değişken/fonksiyon (sarmalayıcı) bildirimleri + tek döngüden oluşan gövde: rotasyonu içeren bütün bir paket/modül
  // fonksiyonu (webpack-obfuscator loader'ı her modüle kendi tablosunu koyar) rotasyon sayılmaz
  const own = (b) => t.isBlockStatement(b) && b.body.filter((s) => !t.isFunctionDeclaration(s)).length <= 3 &&
    b.body.every((s) => t.isVariableDeclaration(s) || t.isLoop(s) || t.isFunctionDeclaration(s)) && b.body.some((s) => t.isLoop(s));
  if (!rotationCache.has(node)) rotationCache.set(node, own(node.body) && ROTATION.test(gen(node.body)));
  return rotationCache.get(node);
}
function isRotationStatement(s) {
  if (!t.isExpressionStatement(s)) return false;
  let e = s.expression;
  if (t.isUnaryExpression(e)) e = e.argument;
  return t.isCallExpression(e) && e.arguments.length > 0 && t.isFunction(e.callee) && isRotationFn(e.callee);
}
function inRotation(p) {
  return Boolean(p.findParent((x) => x.isFunction() && isRotationFn(x.node)));
}

// Üst seviyedeki decoder altyapısı (string tablosu getter'ı, rotasyon IIFE'si, decoder ve alias'ları):
// canlı koddan hiçbir referans kalmadıysa birlikte silinir. Sabit nokta: bir deyimin bildirdiği isim
// aday kümesi dışından okunuyorsa o deyim kalır; rotasyon deyimi ancak dokunduğu her isim siliniyorsa gider.
// block verilirse (decoder bir fonksiyon gövdesinde: webpack-obfuscator loader'ı) aynı işlem o gövdede yapılır.
function removeInfrastructure(ast, decoderNames, block = null) {
  let program = block;
  if (!program) traverse(ast, { Program(p) { program = p; p.stop(); } });
  if (!program.node) return 0;
  program.scope.crawl();
  const names = (s) => {
    if (s.isFunctionDeclaration() && s.node.id) return [s.node.id.name];
    if (s.isVariableDeclaration()) return s.node.declarations.flatMap((d) => Object.keys(t.getBindingIdentifiers(d.id)));
    return [];
  };
  const isRotation = (s) => s.isExpressionStatement() && (() => {
    let e = s.node.expression;
    if (t.isUnaryExpression(e)) e = e.argument;
    return t.isCallExpression(e) && t.isFunction(e.callee) && isRotationFn(e.callee);
  })();
  const candidate = (s) => s.isFunctionDeclaration() || isRotation(s) || (s.isVariableDeclaration() &&
    s.node.declarations.every((d) => !d.init || t.isIdentifier(d.init) || t.isFunction(d.init)));

  const set = new Set(program.get('body').filter(candidate));
  const atTop = (x) => x.parentPath?.node === program.node;
  const top = (p) => (atTop(p) ? p : p.findParent(atTop));
  const inSet = (p) => set.has(top(p));
  const owner = (p) => { const s = top(p); return set.has(s) ? s : undefined; };

  for (let changed = true; changed;) {
    changed = false;
    for (const s of [...set]) {
      const declared = names(s).map((n) => program.scope.getBinding(n)).filter(Boolean);
      const usedOutside = declared.some((b) => b.referencePaths.some((r) => !inSet(r)) ||
        b.constantViolations.some((v) => !inSet(v)));
      let rotationLeaks = false;
      if (isRotation(s)) {
        s.traverse({
          Identifier(p) {
            if (!p.isReferencedIdentifier()) return;
            const b = p.scope.getBinding(p.node.name);
            if (b?.scope === program.scope && !inSet(b.path)) rotationLeaks = true;
          },
        });
      }
      if (usedOutside || rotationLeaks) { set.delete(s); changed = true; }
    }
  }

  // yalnızca decoder'lara bağlı olan deyimler: decoder'dan başlayıp referanslar üzerinden yayıl
  // tohum: bilinen decoder'lar ve rotasyon deyimleri (rotasyon yalnızca decoder altyapısında bulunur)
  const connected = new Set(program.get('body').filter((s) => set.has(s) &&
    (isRotation(s) || names(s).some((n) => decoderNames.includes(n)))));
  if (!connected.size) return 0;
  for (let grew = true; grew;) {
    grew = false;
    for (const s of set) {
      if (connected.has(s)) continue;
      const touches = (a, b) => names(b).some((n) => program.scope.getBinding(n)?.referencePaths.some((r) => owner(r) === a));
      if ([...connected].some((c) => touches(c, s) || touches(s, c))) { connected.add(s); grew = true; }
    }
  }
  for (const s of connected) s.remove();
  return connected.size;
}

function pathOf(n) {
  if (t.isIdentifier(n)) return n.name;
  if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
    const base = pathOf(n.object);
    return base && `${base}.${n.property.name}`;
  }
  return null;
}

function collectGroups(ast) {
  const groups = new Map();
  const pathGroups = new Map();
  traverse(ast, {
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      if (args.length > MAX_ARGS) return;
      if (args.some((a) => t.isSpreadElement(a))) return;
      if (inRotation(p)) return;
      // sonucu kullanılmayan çağrı decoder değildir, yan etki için yapılıyordur
      if (p.parentPath.isExpressionStatement()) return;
      // js-confuser: decoder kapsam nesnesinde, this'siz çağrılır: (1, scope.X.decode)(1956, 9)
      if (t.isSequenceExpression(callee) && callee.expressions.length === 2 && literalValue(callee.expressions[0]).ok &&
          t.isMemberExpression(callee.expressions[1])) {
        if (!args.length) return;
        const path = pathOf(callee.expressions[1]);
        const root = path && p.scope.getBinding(path.split('.')[0]);
        if (!root) return;
        let byPath = pathGroups.get(root);
        if (!byPath) pathGroups.set(root, (byPath = new Map()));
        let g = byPath.get(path);
        if (!g) byPath.set(path, (g = { name: path, memberPath: true, calls: [], dynamic: [] }));
        (args.map(literalValue).every((l) => l.ok) ? g.calls : g.dynamic).push(p);
        return;
      }
      if (!t.isIdentifier(callee)) return;
      let b = p.scope.getBinding(callee.name);
      if (!b) return;
      // argümansız çağrı yalnızca parametresiz, gövdesi string çözen program fonksiyonuna (specialize sonrası decoder kopyası)
      if (!args.length && !(b.path.isFunctionDeclaration() && !b.path.node.params.length && b.scope.path.isProgram() && looksLikeDecoder(b))) return;
      // var v22 = v1; v22(154) → kök decoder'ın grubuna say (fonksiyon içi alias'lar tek tek eşiğe takılmasın)
      for (let hops = 0; hops < 8 && b.constant && b.path.isVariableDeclarator() && t.isIdentifier(b.path.node.init); hops++) {
        const next = b.path.scope.getBinding(b.path.node.init.name);
        if (!next) break;
        b = next;
      }
      let g = groups.get(b);
      if (!g) groups.set(b, (g = { id: groups.size, name: callee.name, binding: b, calls: [], dynamic: [] }));
      const lits = args.map(literalValue);
      if (lits.every((l) => l.ok)) {
        // sayı argümanlı çağrılar decoder adayı; yalnızca string argümanlılar (decode("ZOjM4E")) gövde decoder'a benziyorsa
        if (lits.some((l) => isIndexLit(l.value))) g.numeric = (g.numeric ?? 0) + 1;
        g.calls.push(p);
      } else {
        g.dynamic.push(p);
      }
    },
  });
  // js-confuser CFF: decoder anahtarı durum değişkenine bağlı, hiçbir çağrı literal değil (yalnızca dinamik)
  const byBinding = [...groups.values()].filter((g) => {
    // js-confuser dispatcher'ı (fns[name]() dağıtıcısı) gövdesinde string decoder'ları taşısa da decoder değildir:
    // çağrısını değerle değiştirmek gövdesindeki altyapının silinmesine yol açar (confuser pass'i açar)
    const fnPaths = [g.binding.path, ...g.binding.constantViolations.map((v) => (v.isAssignmentExpression() ? v.get('right') : v))];
    if (fnPaths.some((fp) => (fp.isFunctionDeclaration() || fp.isFunctionExpression()) && readDispatcher(fp))) return false;
    if ((g.calls.length > 0 || g.dynamic.length > 0) && looksLikeDecoder(g.binding)) return true;
    // js-confuser globalConcealing getGlobal("ad") (kapsam nesnesinden yerele bölünmüş): yalnızca tek string
    // argümanlı çağrılar, gövde dışarıya yazmıyor; sonuçların hepsi global nesne olmalı (aşağıda strict denetimi)
    if (g.calls.length && !g.dynamic.length && g.calls.every((c) => c.node.arguments.length === 1 && t.isStringLiteral(c.node.arguments[0])) &&
        fnPaths.some((fp) => fp.isFunction()) && fnPaths.every((fp) => !fp.isFunction() || !writesOutside(fp))) {
      g.strict = true;
      g.globalsOnly = true;
      return true;
    }
    if ((g.numeric ?? 0) < MIN_CALLS) return false;
    g.calls = g.calls.filter((c) => c.node.arguments.some((a) => isIndexLit(literalValue(a).value)));
    return true;
  });
  // yol gruplarının decoder olup olmadığı çalışma anında, yakalanan fonksiyonun kaynağından anlaşılır
  const byPath = [...pathGroups.values()].flatMap((m) => [...m.values()]);
  return [...byBinding, ...byPath].map((g, id) => Object.assign(g, { id }));
}

// Yakalanan fonksiyon metni js-confuser dispatcher'ı mı (yalnızca ayrıştırılır)?
function isDispatcherSource(src) {
  if (src.length > 2_000_000) return false;
  let ast;
  try { ast = parse(`(${src})`); } catch { return false; }
  let found = false;
  traverse(ast, { Function(p) { found = Boolean(readDispatcher(p)); p.stop(); } });
  return found;
}

// Fonksiyon metni (programdan yakalanan) dışarıya yazmıyor ve iç içe fonksiyon/çağrı içermiyor mu?
// Yalnızca ayrıştırılır; çağrı, new, iç fonksiyon, delete, yield/await varsa saf sayılmaz.
function pureSource(src) {
  let ast;
  try { ast = parse(`(${src})`); } catch { return false; }
  let fnPath = null;
  traverse(ast, { Function(p) { fnPath = p; p.stop(); } });
  if (!fnPath || fnPath.node.async || fnPath.node.generator || writesOutside(fnPath)) return false;
  let ok = true;
  fnPath.traverse({
    'CallExpression|NewExpression|Function|YieldExpression|AwaitExpression|TaggedTemplateExpression'(q) { ok = false; q.stop(); },
    UnaryExpression(q) { if (q.node.operator === 'delete') { ok = false; q.stop(); } },
  });
  return ok;
}

// Fonksiyon kendi kapsamı dışındaki bir bağa (ya da onun özelliğine) yazıyor mu?
function writesOutside(fnPath) {
  let hit = false;
  const outside = (id, at) => {
    const b = at.scope.getBinding(id.name);
    return !b || !(b.scope === fnPath.scope || b.scope.path.findParent((x) => x === fnPath));
  };
  fnPath.traverse({
    'AssignmentExpression|UpdateExpression'(q) {
      let target = q.isAssignmentExpression() ? q.node.left : q.node.argument;
      while (t.isMemberExpression(target)) target = target.object;
      if (t.isIdentifier(target) && outside(target, q)) { hit = true; q.stop(); }
      else if (!t.isIdentifier(target) && !t.isMemberExpression(q.isAssignmentExpression() ? q.node.left : q.node.argument)) {
        t.traverseFast(target, (n) => { if (t.isIdentifier(n) && outside(n, q)) hit = true; });
        if (hit) q.stop();
      }
    },
  });
  return hit;
}

function looksLikeDecoder(b) {
  const fns = [];
  if (t.isFunction(b.path.node)) fns.push(b.path.node);
  if (b.path.isVariableDeclarator() && t.isFunction(b.path.node.init)) fns.push(b.path.node.init);
  for (const v of b.constantViolations) {
    if (v.isAssignmentExpression() && t.isFunction(v.node.right)) fns.push(v.node.right);
  }
  return fns.some((f) => DECODER_BODY.test(gen(f.body)) || isIndexDecoder(f));
}
// kodlamasız obfuscator.io indeks decoder'ı: function a(t, n) { return t -= 220, s()[t]; }
// (webpack-obfuscator loader'ı her modüle ayrı tablo koyar; tek modülde çağrı sayısı eşiğin altında kalabilir)
function isIndexDecoder(f) {
  const p = f.params[0];
  if (!t.isIdentifier(p)) return false;
  const src = gen(f.body);
  const x = p.name.replace(/\$/g, '\\$');
  return src.length < 300 && new RegExp(`${x}(?:-=|=${x}-)(?:0x[0-9a-f]+|\\d+)`, 'i').test(src) &&
    new RegExp(`\\(\\)\\[${x}\\]|[\\w$]+\\[${x}\\]`).test(src);
}

// Kapalı decoder: gövdesi yalnızca kendi yerellerine, güvenli global'lere ve hiç değişmeyen literal başlangıçlı
// bağlara (string tablosu, sayı dizisi) bakan fonksiyon bildirimi (js-confuser CFF string şifresi: xor(key, start, len)).
// Çağrıları hiç çalışmayan daldaysa (decoder çalışma anında yakalanamaz) bile bağımsız bir sandbox'ta, yalnızca
// fonksiyon ve bağımlılıklarıyla çalıştırılarak çözülür: sonuç yalnız argümanlara ve sabitlere bağlıdır.
const CLOSED_GLOBALS = new Set(['String', 'Math', 'Number', 'parseInt', 'parseFloat', 'Array', 'Object', 'JSON', 'undefined', 'NaN', 'Infinity', 'isNaN']);
const MAX_CLOSED_CALLS = 20000;

function closedDecoder(fnPath) {
  const fn = fnPath.node;
  if (!fn.id || fn.async || fn.generator || !fn.params.every((x) => t.isIdentifier(x)) || !DECODER_BODY.test(gen(fn.body))) return null;
  const deps = new Map();
  let ok = true;
  fnPath.traverse({
    ThisExpression(q) { if (q.getFunctionParent() === fnPath) { ok = false; q.stop(); } },
    Identifier(q) {
      if (!q.isReferencedIdentifier() || q.node.name === 'arguments') { if (q.node.name === 'arguments' && q.isReferencedIdentifier()) ok = false; return; }
      const b = q.scope.getBinding(q.node.name);
      if (!b) { if (!CLOSED_GLOBALS.has(q.node.name)) { ok = false; q.stop(); } return; }
      if (b.path === fnPath || b.path.findParent((x) => x === fnPath)) return;
      const init = b.path.isVariableDeclarator() ? b.path.node.init : null;
      if (!b.constant || !init || !(t.isStringLiteral(init) || t.isNumericLiteral(init) || isLiteralArray(init))) { ok = false; q.stop(); return; }
      // bağımlılık yalnızca okunmalı (yazma ya da değiştiren yöntem çağrısı çağrı sırasını anlamlı kılardı)
      const par = q.parentPath;
      const mutating = par.isMemberExpression({ object: q.node }) && (
        par.parentPath.isAssignmentExpression({ left: par.node }) || par.parentPath.isUpdateExpression() ||
        (par.parentPath.isCallExpression({ callee: par.node }) && ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']
          .includes(par.node.computed ? par.node.property.value : par.node.property.name)));
      if (mutating) { ok = false; q.stop(); return; }
      deps.set(q.node.name, init);
    },
  });
  // fonksiyon kendi bağını yeniden atamamalı
  const self = fnPath.parentPath.scope.getBinding(fn.id.name);
  if (!ok || !self?.constant) return null;
  return { deps, self };
}
const isLiteralArray = (n) => t.isArrayExpression(n) && n.elements.every((e) => e && (t.isNumericLiteral(e) || t.isStringLiteral(e) ||
  (t.isUnaryExpression(e, { operator: '-' }) && t.isNumericLiteral(e.argument))));

async function closedDecoders(ast, { sandbox, onLog, bump }) {
  const jobs = [];
  traverse(ast, {
    FunctionDeclaration(fp) {
      const info = closedDecoder(fp);
      if (!info) return;
      const calls = info.self.referencePaths.map((r) => r.parentPath).filter((c, i) => c.isCallExpression({ callee: info.self.referencePaths[i].node }) &&
        c.node.arguments.length && c.node.arguments.every((a) => literalValue(a).ok) && !c.parentPath.isExpressionStatement());
      if (!calls.length || calls.length > MAX_CLOSED_CALLS) return;
      jobs.push({ fp, info, calls });
    },
  });
  let total = 0;
  for (const j of jobs) {
    const decl = [...j.info.deps].map(([k, v]) => `var ${k} = ${gen(v)};`).join('\n');
    const keys = [...new Set(j.calls.map((c) => argsKey(c)))];
    const code = `${decl}\n${gen(j.fp.node)}\nvar __o = {};\n${keys.map((k, i) => `try { __o[${i}] = ${j.fp.node.id.name}.apply(undefined, ${k}); } catch (e) {}`).join('\n')}\n__res.push(JSON.stringify(__o));`;
    const r = await sandbox.run(code, { timeoutMs: 6000 });
    let out = null;
    try { out = JSON.parse(r.res?.[0] ?? 'null'); } catch { out = null; }
    if (!out) continue;
    let n = 0;
    for (const c of j.calls) {
      const v = out[keys.indexOf(argsKey(c))];
      if (typeof v !== 'string' || !attached(c)) continue;
      c.replaceWith(t.stringLiteral(v));
      n++;
    }
    if (n) onLog(`runtime-decoders: kapalı decoder ${j.fp.node.id.name} ile ${n} çağrı bağımsız çalıştırılarak çözüldü`, 'info');
    total += n;
  }
  bump('runtimeDecoder', total);
  return total;
}

export async function run(ast, ctx) {
  // önce kapalı decoder'lar: hiç çalışmayan dallardaki çağrılar da çözülür
  if (await closedDecoders(ast, ctx)) return;
  await resolveCalls(ast, ctx);
  let removed = removeInfrastructure(ast, ctx.decoderNames ?? []);
  // fonksiyon gövdelerindeki altyapı: bu turda çözülen decoder'ların gövdeleri ve doğrudan bir rotasyon
  // deyimi içeren gövdeler (decoder'ın çağrıları önceki turda bitmiş olabilir)
  const blocks = new Set(ctx.decoderBlocks ?? []);
  traverse(ast, {
    BlockStatement(p) {
      if (p.parentPath.isFunction() && p.node.body.some((s) => isRotationStatement(s))) blocks.add(p);
    },
  });
  for (const block of blocks) {
    if (attached(block)) removed += removeInfrastructure(ast, ctx.decoderNames ?? [], block);
  }
  ctx.decoderBlocks = null;
  if (removed) ctx.onLog(`runtime-decoders: decoder altyapısı kaldırıldı (${removed} deyim)`, 'info');
  ctx.bump('runtimeDecoder', removed);
}

async function resolveCalls(ast, ctx) {
  const { onLog, bump, sandbox, level } = ctx;
  const groups = collectGroups(ast);
  if (!groups.length) return;
  const observe = level >= 3;

  // Çağrıları geçici olarak sarıp kodu üret, sonra ağacı geri al
  const saved = [];
  const sites = [];
  for (const g of groups) {
    for (const c of g.calls) {
      const { node } = c;
      saved.push([node, node.callee, node.arguments]);
      node.arguments = [t.numericLiteral(g.id), node.callee, t.arrayExpression(node.arguments)];
      node.callee = t.identifier('__peelCall');
    }
    if (!observe) continue;
    for (const c of g.dynamic) {
      const { node } = c;
      // decoder ilkel değerlerle çağrılır; dizi/nesne argümanlı çağrı (js-confuser makine kopyası: M([durumlar], {…}))
      // fonksiyonun asıl işini yapar, sonucu gözlenen değerle değiştirmek yan etkilerini silerdi
      if (node.arguments.some((a) => t.isArrayExpression(a) || t.isObjectExpression(a) || t.isFunction(a))) continue;
      const copy = t.callExpression(node.callee, node.arguments);
      saved.push([node, node.callee, node.arguments]);
      node.arguments = [t.numericLiteral(sites.length), copy];
      node.callee = t.identifier('__peelObs');
      sites.push({ group: g, call: c });
    }
  }
  const instrumented = gen(ast);
  for (const [node, callee, args] of saved) {
    node.callee = callee;
    node.arguments = args;
  }

  const opened = await sandbox.open(`${PRELUDE}\ntry {\n${instrumented}\n} catch (e) {}`, { timeoutMs: 10000 });
  if (!opened.ok) {
    onLog(`runtime-decoders: sandbox açılamadı (${opened.error})`, 'warn');
    return;
  }
  try {
    // Program düzeyi decoder hiç çalışmayan bir daldan çağrılıyorsa (selfDefending geri çağrısı) yakalanmamıştır:
    // global adıyla doğrudan bağla. Program global kapsamda çalıştığı için ad o fonksiyondur.
    const unseen = groups.filter((g) => !g.memberPath && g.binding.kind === 'hoisted' && g.binding.scope.path.isProgram() &&
      g.binding.constantViolations.every((v) => v.findParent((x) => x === g.binding.path)));
    if (unseen.length) {
      await sandbox.batchIn(opened.token, unseen.map((g) =>
        `(typeof ${g.binding.identifier.name} === "function" && !__peelFns[${g.id}] && (__peelFns[${g.id}] = ${g.binding.identifier.name}), 0)`));
    }
    let total = 0;
    const decoders = new Set();
    for (const g of groups) {
      // yol grubu: gövdesi string çözüyorsa ya da sayısal literal argümanla en az MIN_CALLS kez çağrılıyorsa
      // (js-confuser decoder'ı CFF sarmalayıcısının arkasında olabilir, kaynağı ipucu vermez)
      if (g.memberPath) {
        // kapsam yolundaki dispatcher (yakalanan metni ayrıştırılıp tanınır) decoder değildir
        const ds = await sandbox.batchIn(opened.token, [`__peelSrcOf(${g.id})`]);
        const dsrc = ds.ok && ds.results[0]?.type === 'string' ? ds.results[0].value : null;
        if (dsrc !== null && isDispatcherSource(dsrc)) continue;
        const numeric = g.calls.filter((c) => c.node.arguments.some((a) => isIndexLit(literalValue(a).value))).length;
        // eşik altındaki gruplar: her çağrı string vermeli ve değerlendirmede yan etki gözlenmemeli (aşağıda)
        g.strict = numeric < MIN_CALLS && (await sandbox.batchIn(opened.token, [`__peelSrcOk(${g.id})`])).results?.[0]?.value !== true;
        // kaynağı decoder'a benzemeyen az çağrılı yol: decoder biçimi şart — her çağrıda sayısal (indeks) argüman
        // (js-confuser decoder'ı (1, s.K.d)(1956, 9)) ya da her sonuç bir global nesne (globalConcealing
        // getGlobal("ad")); kapsam nesnesindeki string→string fonksiyon decoder değildir
        g.globalsOnly = g.strict && g.calls.some((c) => !c.node.arguments.some((a) => isIndexLit(literalValue(a).value)));
        // kaynağı dışarıya yazmayan (yakalanan fonksiyonun metni ayrıştırılır, çalıştırılmaz) saf fonksiyonun
        // string sonuçları da katlanabilir: function (x) { return "<" + x + ">"; }
        if (g.globalsOnly) {
          const sr = await sandbox.batchIn(opened.token, [`__peelSrcOf(${g.id})`]);
          const src = sr.ok && sr.results[0]?.type === 'string' ? sr.results[0].value : null;
          if (src !== null && pureSource(src)) g.globalsOnly = false;
        }
      }
      const unique = [...new Set(g.calls.map(argsKey))];
      const r = await sandbox.batchIn(opened.token, unique.map((args) => `__peelEval(${g.id}, ${args})`));
      if (!r.ok) continue;
      const values = new Map();
      unique.forEach((args, i) => {
        const v = r.results[i];
        if (v?.ok && v.type === 'string') values.set(args, v.value);
      });
      if (!g.globalsOnly && values.size < unique.length * MIN_STRING_RATIO) continue;
      if (g.strict) {
        const imp = await sandbox.batchIn(opened.token, [`__peelImpure[${g.id}] === true`]);
        // (global getter'ında çözülemeyen adlar yerinde kalır; diğer gruplarda her çağrı çözülmeli)
        if ((!g.globalsOnly && values.size < unique.length) || !imp.ok || imp.results[0]?.value !== false) continue;
        // global getter'ı: yalnızca global nesneye çözülen çağrılar değiştirilir
        if (g.globalsOnly) {
          for (const [k, v] of values) if (!v.startsWith('\u0000global:')) values.delete(k);
          if (!values.size) continue;
        }
      }
      decoders.add(g);

      let n = 0;
      for (const c of g.calls) {
        const v = values.get(argsKey(c));
        if (v === undefined || !attached(c)) continue;
        const global = v.startsWith('\u0000global:') ? v.slice(8) : null;
        if (global) {
          // çağrı yerinde aynı ad başka bir şeye bağlıysa global'e işaret etmez
          if (c.scope.getBinding(global)) continue;
          c.replaceWith(t.identifier(global));
        } else {
          c.replaceWith(t.stringLiteral(v));
        }
        n++;
      }
      total += n;
      if (n) onLog(`runtime-decoders: ${g.name} ile ${n}/${g.calls.length} çağrı çözüldü`, 'info');
    }

    if (sites.length) {
      const r = await sandbox.batchIn(opened.token, ['JSON.stringify(__peelSeen)']);
      const seen = r.ok && r.results[0]?.type === 'string' ? JSON.parse(r.results[0].value) : {};
      let n = 0;
      sites.forEach(({ group, call }, k) => {
        const v = seen[k];
        if (typeof v !== 'string' || !decoders.has(group) || !attached(call)) return;
        call.replaceWith(t.stringLiteral(v));
        n++;
      });
      total += n;
      if (n) onLog(`runtime-decoders: ${n}/${sites.length} dinamik çağrı çalışma anı gözlemiyle çözüldü`, 'info');
    }
    ctx.decoderNames = [...decoders].filter((g) => !g.memberPath).map((g) => g.binding.identifier.name);
    // fonksiyon gövdesindeki decoder'ların gövdeleri (aynı gövde bir kez)
    const blocks = new Map();
    for (const g of decoders) {
      const sp = g.memberPath ? null : g.binding.scope.path;
      if (!sp?.isFunction() || !sp.get('body').isBlockStatement()) continue;
      blocks.set(sp.node, sp.get('body'));
    }
    ctx.decoderBlocks = [...blocks.values()];
    bump('runtimeDecoder', total);
  } finally {
    await sandbox.close(opened.token);
  }
}
