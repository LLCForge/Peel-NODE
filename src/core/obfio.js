import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';

// obfuscator.io string dizisi altyapısının statik modeli: dizi fonksiyonu, decoder (ofset + kodlama),
// rotasyon IIFE'si. Hem statik çözme pass'i (A-3/A-5) hem ayar çıkarımı (A-2) bunu kullanır.
// Kodlamalar burada yeniden yazılmıştır; programın kendi kodu host'ta asla çalıştırılmaz.

export class Unsupported extends Error {}
class Thrown extends Error {}
const unsupported = (why) => { throw new Unsupported(why); };

// ── kodlamalar (obfuscator.io'nun ürettiği algoritmalarla birebir) ─────────

export function base64Decode(str, alphabet, uri) {
  if (typeof str !== 'string') throw new Thrown('string değil');
  let out = '';
  for (let bc = 0, bs = 0, idx = 0, ch; (ch = str.charAt(idx++));) {
    const v = alphabet.indexOf(ch);
    if (v === -1) continue;
    bs = bc % 4 ? bs * 64 + v : v;
    if (bc++ % 4) out += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6)));
  }
  if (!uri) return out;
  let pct = '';
  for (let i = 0; i < out.length; i++) pct += `%${`00${out.charCodeAt(i).toString(16)}`.slice(-2)}`;
  try { return decodeURIComponent(pct); } catch (e) { throw new Thrown(e.message); }
}

export function rc4Decode(str, key, alphabet, uri) {
  if (typeof key !== 'string') throw new Thrown('anahtar string değil');
  const data = base64Decode(str, alphabet, uri);
  const s = [];
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0, x; i < 256; i++) {
    j = (j + s[i] + key.charCodeAt(i % key.length)) % 256;
    x = s[i]; s[i] = s[j]; s[j] = x;
  }
  let out = '';
  for (let k = 0, i = 0, j = 0, x; k < data.length; k++) {
    i = (i + 1) % 256;
    j = (j + s[i]) % 256;
    x = s[i]; s[i] = s[j]; s[j] = x;
    out += String.fromCharCode(data.charCodeAt(k) ^ s[(s[i] + s[j]) % 256]);
  }
  return out;
}

// ── yapı tanıma ─────────────────────────────────────────

const stringsOf = (arr) => (t.isArrayExpression(arr) && arr.elements.length && arr.elements.every((e) => t.isStringLiteral(e))
  ? arr.elements.map((e) => e.value) : null);

// function A() { var x = [...]; A = function () { return x; }; return A(); }   ya da   var A = [...]
function arrayHolders(ast) {
  const out = [];
  for (const [i, s] of ast.program.body.entries()) {
    if (t.isFunctionDeclaration(s) && s.body.body.length >= 2) {
      const first = s.body.body[0];
      const strings = t.isVariableDeclaration(first) && first.declarations.length === 1 && stringsOf(first.declarations[0].init);
      if (strings && gen(s.body).includes(`${s.id.name}=function`)) out.push({ name: s.id.name, kind: 'fn', strings, index: i });
    } else if (t.isVariableDeclaration(s)) {
      for (const d of s.declarations) {
        const strings = t.isIdentifier(d.id) && stringsOf(d.init);
        if (strings && strings.length >= 3) out.push({ name: d.id.name, kind: 'var', strings, index: i });
      }
    }
  }
  return out;
}

// İndeks ifadesinin param'a göre afin biçimi: a*param + b (yalnızca sayısal sabitler)
export function affine(node, name) {
  if (t.isIdentifier(node, { name })) return { a: 1, b: 0 };
  if (t.isNumericLiteral(node)) return { a: 0, b: node.value };
  if (t.isParenthesizedExpression(node)) return affine(node.expression, name);
  if (t.isUnaryExpression(node, { operator: '-' })) {
    const x = affine(node.argument, name);
    return x && { a: -x.a, b: -x.b };
  }
  if (t.isBinaryExpression(node) && ['+', '-', '*'].includes(node.operator)) {
    const l = affine(node.left, name);
    const r = affine(node.right, name);
    if (!l || !r) return null;
    if (node.operator === '+') return { a: l.a + r.a, b: l.b + r.b };
    if (node.operator === '-') return { a: l.a - r.a, b: l.b - r.b };
    if (l.a && r.a) return null;
    return { a: l.a * r.b + r.a * l.b, b: l.b * r.b };
  }
  return null;
}

const ALPHABET = /^[A-Za-z0-9+/=]{65}$/;

// Decoder: function D(i, k) { i = i - C; var a = A(); var s = a[i]; ... }
function readDecoder(fnNode, name, holder) {
  const [ip, kp] = fnNode.params;
  if (!t.isIdentifier(ip) || (kp && !t.isIdentifier(kp)) || fnNode.params.length > 2) return null;
  const first = fnNode.body.body[0];
  const as = t.isExpressionStatement(first) && first.expression;
  if (!t.isAssignmentExpression(as) || !t.isIdentifier(as.left, { name: ip.name })) return null;
  const rhs = as.operator === '=' ? as.right
    : as.operator === '-=' ? t.binaryExpression('-', t.identifier(ip.name), as.right)
      : as.operator === '+=' ? t.binaryExpression('+', t.identifier(ip.name), as.right) : null;
  const aff = rhs && affine(rhs, ip.name);
  if (!aff || aff.a !== 1) return null;
  const src = gen(fnNode.body);
  // diziye erişim: A() çağrısı ya da dizi değişkeni
  if (!new RegExp(`\\b${holder.name.replace(/\$/g, '\\$')}\\b`).test(src)) return null;
  let alphabet = null;
  t.traverseFast(fnNode.body, (n) => {
    if (t.isStringLiteral(n) && ALPHABET.test(n.value) && new Set(n.value).size === 65) alphabet = n.value;
  });
  // RC4 adımı XOR kullanır; yalnız base64 çözücüsünde ^ yoktur (sayılar ifadeye çevrilmiş olabilir: 0x100 aranmaz)
  const rc4 = Boolean(alphabet) && /\^/.test(src) && /charCodeAt/.test(src) && Boolean(kp);
  const encoding = !alphabet ? 'none' : rc4 ? 'rc4' : 'base64';
  if (encoding === 'none' && fnNode.body.body.length > 4) return null; // tanınmayan gövde
  return {
    name, param: ip.name, rhs, offset: aff.b, encoding, alphabet, uri: /decodeURIComponent/.test(src),
  };
}

// Rotasyon IIFE'si (yeni biçim: checksum döngüsü; eski biçim: sabit sayıda push(shift))
function readRotator(stmt, holder, decoder) {
  if (!t.isExpressionStatement(stmt)) return null;
  let e = stmt.expression;
  if (t.isUnaryExpression(e)) e = e.argument;
  if (!t.isCallExpression(e) || !t.isFunctionExpression(e.callee)) return null;
  const argIdx = e.arguments.findIndex((a) => t.isIdentifier(a, { name: holder.name }));
  if (argIdx < 0) return null;
  const fn = e.callee;
  const src = gen(fn.body);
  if (!/push/.test(src) || !/shift/.test(src)) return null;
  // yeni biçim: var v = <checksum>; if (v === target) break;
  let checksum = null;
  let targetParam = null;
  t.traverseFast(fn.body, (n) => {
    if (t.isIfStatement(n) && t.isBinaryExpression(n.test) && ['===', '=='].includes(n.test.operator) &&
        t.isIdentifier(n.test.left) && t.isIdentifier(n.test.right)) {
      targetParam = n.test.right.name;
      checksum = n.test.left.name;
    }
  });
  if (checksum) {
    let expr = null;
    t.traverseFast(fn.body, (n) => {
      if (t.isVariableDeclarator(n) && t.isIdentifier(n.id, { name: checksum })) expr = n.init;
    });
    const ti = fn.params.findIndex((p) => t.isIdentifier(p, { name: targetParam }));
    const target = ti >= 0 && e.arguments[ti];
    if (!expr || !target || !decoder) return null;
    let value;
    try { value = evaluate(target, {}); } catch (err) { if (err instanceof Unsupported) return null; throw err; }
    if (typeof value !== 'number') return null;
    return { kind: 'checksum', expr, target: value, stmt };
  }
  // eski biçim: f(++n) ve while (--k) arr.push(arr.shift())
  if (!/while\(--/.test(src.replace(/\s+/g, ''))) return null;
  const countIdx = e.arguments.findIndex((a) => t.isNumericLiteral(a));
  if (countIdx < 0) return null;
  return { kind: 'count', count: e.arguments[countIdx].value, stmt };
}

// ── değerlendirici ──────────────────────────────────────

function makeModel(info) {
  const arr = info.holder.strings.slice();
  let cache = new Map();
  let first;
  const decode = (args) => {
    const [i, k] = args;
    const index = evalIndex(info.decoder, i);
    if (info.decoder.encoding === 'none') return arr[index];
    if (arr[0] !== first) { cache = new Map(); first = arr[0]; }
    if (cache.has(index)) return cache.get(index);
    const raw = arr[index];
    if (typeof raw !== 'string') throw new Thrown('dizi dışı indeks');
    const v = info.decoder.encoding === 'rc4' ? rc4Decode(raw, k, info.decoder.alphabet, info.decoder.uri)
      : base64Decode(raw, info.decoder.alphabet, info.decoder.uri);
    cache.set(index, v);
    return v;
  };
  return { arr, decode, rotate: () => arr.push(arr.shift()), cacheHas: (index) => cache.has(index) };
}

function evalIndex(decoder, v) {
  return evaluate(decoder.rhs, { vars: { [decoder.param]: v } });
}

// Sabit ifade değerlendirici: sayı/string literalleri, aritmetik, parseInt ve decoder çağrıları
export function evaluate(n, env) {
  if (t.isNumericLiteral(n) || t.isStringLiteral(n) || t.isBooleanLiteral(n)) return n.value;
  if (t.isParenthesizedExpression(n)) return evaluate(n.expression, env);
  if (t.isIdentifier(n) && env.vars && Object.hasOwn(env.vars, n.name)) return env.vars[n.name];
  if (t.isUnaryExpression(n)) {
    const v = evaluate(n.argument, env);
    switch (n.operator) {
      case '-': return -v;
      case '+': return +v;
      case '!': return !v;
      case '~': return ~v;
      default: return unsupported('tekli işleç');
    }
  }
  if (t.isBinaryExpression(n)) {
    const a = evaluate(n.left, env);
    const b = evaluate(n.right, env);
    switch (n.operator) {
      case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b;
      case '%': return a % b; case '|': return a | b; case '&': return a & b; case '^': return a ^ b;
      case '<<': return a << b; case '>>': return a >> b; case '>>>': return a >>> b;
      default: return unsupported('ikili işleç');
    }
  }
  if (t.isCallExpression(n) && t.isIdentifier(n.callee)) {
    const args = n.arguments.map((a) => (t.isSpreadElement(a) ? unsupported('spread') : evaluate(a, env)));
    if (n.callee.name === 'parseInt' && env.parseIntFree) return parseInt(args[0], args[1]);
    if (env.decoders?.has(n.callee.name)) return env.decoders.get(n.callee.name)(args);
  }
  return unsupported(`değerlendirilemeyen: ${n.type}`);
}

// Gövdesi tek `return D(...)` olan ve argümanları parametre/literal aritmetiğinden oluşan fonksiyonlar.
// Aynı adla farklı gövdeli birden çok fonksiyon varsa ad belirsizdir: alınmaz.
function wrapperFns(ast, decoders) {
  const found = new Map();
  const ambiguous = new Set();
  const pureArg = (n, params) => (t.isIdentifier(n) ? params.has(n.name) : t.isNumericLiteral(n) || t.isStringLiteral(n) ||
    (t.isUnaryExpression(n) && ['-', '+'].includes(n.operator) && pureArg(n.argument, params)) ||
    (t.isBinaryExpression(n) && ['+', '-', '*'].includes(n.operator) && pureArg(n.left, params) && pureArg(n.right, params)));
  t.traverseFast(ast, (n) => {
    const fn = t.isFunctionDeclaration(n) ? n : null;
    if (!fn || !fn.id || fn.body.body.length !== 1 || !t.isReturnStatement(fn.body.body[0])) return;
    const call = fn.body.body[0].argument;
    if (!t.isCallExpression(call) || !t.isIdentifier(call.callee) || !decoders.has(call.callee.name)) return;
    if (!fn.params.every((x) => t.isIdentifier(x))) return;
    const params = new Set(fn.params.map((x) => x.name));
    if (!call.arguments.every((a) => pureArg(a, params))) return;
    const key = fn.id.name;
    if (found.has(key) && gen(found.get(key)) !== gen(fn)) ambiguous.add(key);
    found.set(key, fn);
  });
  const out = new Map();
  for (const [name, fn] of found) {
    if (ambiguous.has(name) || decoders.has(name)) continue;
    const call = fn.body.body[0].argument;
    out.set(name, (env) => (args) => evaluate(call, { ...env, vars: Object.fromEntries(fn.params.map((x, i) => [x.name, args[i]])) }));
  }
  return out;
}

// ── giriş noktası ───────────────────────────────────────

/**
 * Programdaki obfuscator.io string dizisini bulur ve rotasyonu statik olarak çözer.
 * Dönüş: { holder, decoder, rotator, model, env } ya da null (desen yok / doğrulanamadı).
 */
// webpack-obfuscator: rotasyon IIFE'si paketin geri kalanıyla tek virgül ifadesindedir
// ((function (T, n) {…push…shift…})(T, 0x57f15), (() => {…})()). Program düzeyinde ilk ifade ayrı deyime
// bölünür (sıra ve değerler aynı); rotasyon böylece tanınır ve tek başına silinebilir.
const isShuffleIife = (e) => t.isCallExpression(e) && t.isFunctionExpression(e.callee) && e.arguments.some((a) => t.isIdentifier(a)) &&
  /push/.test(gen(e.callee.body)) && /shift/.test(gen(e.callee.body));
export function splitRotatorSequences(ast) {
  const body = ast.program.body;
  let n = 0;
  for (let i = 0; i < body.length; i++) {
    const s = body[i];
    if (!t.isExpressionStatement(s) || !t.isSequenceExpression(s.expression) || !isShuffleIife(s.expression.expressions[0])) continue;
    const [first, ...rest] = s.expression.expressions;
    body.splice(i, 1, t.expressionStatement(first), t.expressionStatement(rest.length === 1 ? rest[0] : t.sequenceExpression(rest)));
    n++;
  }
  return n;
}

export function analyzeStringArray(ast) {
  const holders = arrayHolders(ast);
  if (!holders.length) return null;
  const body = ast.program.body;
  for (const holder of holders) {
    // decoder: program düzeyinde, holder'a dokunan fonksiyon
    let decoder = null;
    let decoderIndex = -1;
    body.forEach((s, i) => {
      if (decoder) return;
      if (t.isFunctionDeclaration(s) && s.id.name !== holder.name) {
        decoder = readDecoder(s, s.id.name, holder); decoderIndex = i;
      } else if (t.isVariableDeclaration(s) && s.declarations.length === 1 && t.isIdentifier(s.declarations[0].id) &&
          t.isFunctionExpression(s.declarations[0].init)) {
        decoder = readDecoder(s.declarations[0].init, s.declarations[0].id.name, holder); decoderIndex = i;
      }
    });
    if (!decoder) continue;
    const rotIndex = body.findIndex((s) => readRotator(s, holder, decoder));
    const rotator = rotIndex >= 0 ? readRotator(body[rotIndex], holder, decoder) : null;
    // rotasyondan önce yalnızca bildirimler çalışmalı: decoder çağrıları rotasyondan sonra görülür
    const isAlias = (d) => t.isIdentifier(d.id) && t.isIdentifier(d.init, { name: decoder.name });
    if (rotator && !body.slice(0, rotIndex).every((s) => t.isFunctionDeclaration(s) ||
        (t.isVariableDeclaration(s) && s.declarations.every((d) => !d.init || stringsOf(d.init) || t.isFunctionExpression(d.init) || isAlias(d))))) continue;
    // değişken biçimli dizi ya da decoder rotasyondan sonra tanımlanıyorsa (var hoisting) çağrılar undefined görür
    if (rotator && ((holder.kind === 'var' && holder.index > rotIndex) ||
        (!t.isFunctionDeclaration(body[decoderIndex]) && decoderIndex > rotIndex))) continue;
    // kodlamasız decoder sabit anahtarlı değil; yine de rotasyonsuz tanınmamış gövde olabilir
    if (!rotator && decoder.encoding !== 'none' && !decoder.alphabet) continue;
    // rotasyon deyim olarak tanınmadıysa ama dizi bir yerde karıştırılıyorsa model rotasyonsuz yanlış olur
    if (!rotator) {
      let shuffled = false;
      t.traverseFast(ast.program, (n) => { if (!shuffled && isShuffleIife(n) && n.arguments.some((a) => t.isIdentifier(a, { name: holder.name }))) shuffled = true; });
      if (shuffled) continue;
    }

    const info = { holder, decoder };
    const model = makeModel(info);
    const env = { decoders: new Map([[decoder.name, model.decode]]), parseIntFree: true };
    // checksum içinde decoder takma adlarla çağrılabilir (stringArrayWrappersType: 'variable')
    const aliasScan = (node) => t.traverseFast(node, (n) => { if (t.isVariableDeclarator(n) && isAlias(n)) env.decoders.set(n.id.name, model.decode); });
    if (rotator) aliasScan(rotator.stmt);
    // fonksiyon sarmalayıcıları (rotasyon içindekiler dahil): function w(a, b) { return D(b - 0x1f0, a); }
    for (const [name, w] of wrapperFns(ast, env.decoders)) env.decoders.set(name, w(env));
    for (const s of body.slice(0, Math.max(0, rotIndex))) if (t.isVariableDeclaration(s)) aliasScan(s);
    let rotations = 0;
    if (rotator?.kind === 'count') {
      for (let i = 0; i < rotator.count; i++) model.rotate();
      rotations = rotator.count;
    } else if (rotator) {
      let ok = false;
      try {
        for (; rotations <= model.arr.length; rotations++) {
          let v;
          try { v = evaluate(rotator.expr, env); } catch (e) {
            if (!(e instanceof Thrown)) throw e;
            model.rotate();
            continue;
          }
          if (v === rotator.target) { ok = true; break; }
          model.rotate();
        }
      } catch (e) {
        if (e instanceof Unsupported) continue;
        throw e;
      }
      if (!ok) continue; // checksum hiç tutmadı: orijinal sonsuz döngüde kalırdı, model yanlış
    }
    return { holder, decoder, rotator, rotations, model, env, decoderIndex, rotIndex };
  }
  return null;
}

// Decoder çağrısının değeri; çözülemezse { ok: false }
export function decodeCall(sa, callNode) {
  try {
    const v = evaluate(callNode, sa.env);
    return typeof v === 'string' ? { ok: true, value: v } : { ok: false };
  } catch (e) {
    if (e instanceof Unsupported || e instanceof Thrown) return { ok: false };
    throw e;
  }
}

export const isThrown = (e) => e instanceof Thrown;

// Programdaki decoder çağrılarının sayısı ve string literal sayısı (ayar çıkarımı için)
export function countDecoderCalls(ast, decoderName) {
  let calls = 0;
  traverse(ast, {
    CallExpression(p) { if (t.isIdentifier(p.node.callee, { name: decoderName })) calls++; },
  });
  return calls;
}
