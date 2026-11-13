import * as t from '@babel/types';
import { traverse, gen } from '../../util/ast.js';
import { walk } from './detect.js';

// String tablosu (obfuscator.io biçimleri) için statik araçlar:
//  - E632 rotasyon cebiri: rotasyon döngüsünün checksum ifadesi, decoder yerel olarak taklit edilerek her
//    rotasyon için hesaplanır; hedefe eşit olan rotasyon bulunur (sandbox gerekmez)
//  - E633 decoder tersi: tanınan biçim (indeks / base64 / rc4) için kodlayıcı üretilir ve gidiş-dönüşle doğrulanır
//  - E634 tekilleştirme, E635 kullanımlardan tablo kurma, E636 kısmi kurtarma (anahtarı bilinmeyen rc4 indeksleri)

const B64 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';

// obfuscator.io'nun base64 çözücüsünün birebir karşılığı (özel alfabe + yüzde kodlu UTF-8)
export function b64decode(s) {
  let out = '';
  for (let bc = 0, bs = 0, buffer, idx = 0; (buffer = s.charAt(idx++));) {
    buffer = B64.indexOf(buffer);
    if (~buffer && ((bs = bc % 4 ? bs * 64 + buffer : buffer), bc++ % 4)) out += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6)));
  }
  let pct = '';
  for (let i = 0; i < out.length; i++) pct += `%${`00${out.charCodeAt(i).toString(16)}`.slice(-2)}`;
  return decodeURIComponent(pct);
}

export function rc4(str, key) {
  const s = [];
  let j = 0;
  let x;
  let res = '';
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key.charCodeAt(i % key.length)) % 256;
    x = s[i]; s[i] = s[j]; s[j] = x;
  }
  let i = 0;
  j = 0;
  for (let y = 0; y < str.length; y++) {
    i = (i + 1) % 256;
    j = (j + s[i]) % 256;
    x = s[i]; s[i] = s[j]; s[j] = x;
    res += String.fromCharCode(str.charCodeAt(y) ^ s[(s[i] + s[j]) % 256]);
  }
  return res;
}

// Ters yön (E633): b64decode(b64encode(x)) === x olacak biçimde, dolgusuz
export function b64encode(str) {
  const bytes = unescape(encodeURIComponent(str));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes.charCodeAt(i) << 16) | ((bytes.charCodeAt(i + 1) || 0) << 8) | (bytes.charCodeAt(i + 2) || 0);
    const chars = i + 1 >= bytes.length ? 2 : i + 2 >= bytes.length ? 3 : 4;
    for (let k = 0; k < chars; k++) out += B64[(n >> (18 - 6 * k)) & 63];
  }
  return out;
}

export function decoderFn(shape) {
  if (shape === 'base64') return (raw) => b64decode(raw);
  if (shape === 'rc4') return (raw, key) => rc4(b64decode(raw), String(key));
  return (raw) => raw;
}

// Kaynak metni: tanınan biçim için kodlayıcı
export function inverseSource(shape, offset, table) {
  const off = `0x${offset.toString(16)}`;
  const lookup = `function indexOf(s) { var i = ${table}.indexOf(s); return i < 0 ? -1 : i + ${off}; }`;
  if (shape === 'index') return `// indeks kodlaması: değer → decoder argümanı\n${lookup}`;
  const enc = `function b64encode(str) {
  var A = "${B64}", bytes = unescape(encodeURIComponent(str)), out = "";
  for (var i = 0; i < bytes.length; i += 3) {
    var n = (bytes.charCodeAt(i) << 16) | ((bytes.charCodeAt(i + 1) || 0) << 8) | (bytes.charCodeAt(i + 2) || 0);
    var c = i + 1 >= bytes.length ? 2 : i + 2 >= bytes.length ? 3 : 4;
    for (var k = 0; k < c; k++) out += A[(n >> (18 - 6 * k)) & 63];
  }
  return out;
}`;
  if (shape === 'base64') return `${enc}\n// tablo girdisi = b64encode(değer), argüman = indeks + ${off}`;
  return `${enc}
function rc4(str, key) {
  var s = [], j = 0, x, res = "";
  for (var i = 0; i < 256; i++) s[i] = i;
  for (i = 0; i < 256; i++) { j = (j + s[i] + key.charCodeAt(i % key.length)) % 256; x = s[i]; s[i] = s[j]; s[j] = x; }
  i = 0; j = 0;
  for (var y = 0; y < str.length; y++) {
    i = (i + 1) % 256; j = (j + s[i]) % 256; x = s[i]; s[i] = s[j]; s[j] = x;
    res += String.fromCharCode(str.charCodeAt(y) ^ s[(s[i] + s[j]) % 256]);
  }
  return res;
}
// rc4 simetriktir: tablo girdisi = b64encode(rc4(değer, anahtar)), argüman = (indeks + ${off}, anahtar)`;
}

// ── yapı tanıma ─────────────────────────────────────────

const strArray = (n) => t.isArrayExpression(n) && n.elements.length >= 2 && n.elements.every((e) => t.isStringLiteral(e));

// function T() { var a = [...]; T = function () { return a; }; return T(); }  ya da  var T = [...]
function tables(ast) {
  const out = [];
  traverse(ast, {
    FunctionDeclaration(p) {
      const body = p.node.body.body;
      const decl = body.find((s) => t.isVariableDeclaration(s) && s.declarations.length === 1 && strArray(s.declarations[0].init));
      if (!decl || !p.node.id || p.parentPath.isProgram() === false) return;
      out.push({ kind: 'fn', name: p.node.id.name, values: decl.declarations[0].init.elements.map((e) => e.value) });
    },
    VariableDeclarator(p) {
      if (t.isIdentifier(p.node.id) && strArray(p.node.init) && p.parentPath.parentPath.isProgram()) {
        out.push({ kind: 'var', name: p.node.id.name, values: p.node.init.elements.map((e) => e.value) });
      }
    },
  });
  return out;
}

function refersTo(node, name) {
  let hit = false;
  walk(node, (n) => { if (t.isIdentifier(n, { name })) hit = true; });
  return hit;
}

// Decoder: tabloya dokunan üst seviye fonksiyon; ofset ve biçim
function decoders(ast, table) {
  const out = [];
  for (const s of ast.program.body) {
    if (!t.isFunctionDeclaration(s) || !s.id || s.id.name === table.name || !refersTo(s.body, table.name)) continue;
    const p0 = s.params[0];
    if (!t.isIdentifier(p0)) continue;
    let offset = null;
    walk(s.body, (n) => {
      if (offset !== null) return false;
      if (t.isAssignmentExpression(n) && t.isIdentifier(n.left, { name: p0.name })) {
        const r = n.right;
        if (n.operator === '-=' && t.isNumericLiteral(r)) offset = r.value;
        if (n.operator === '=' && t.isBinaryExpression(r, { operator: '-' }) && t.isIdentifier(r.left, { name: p0.name }) && t.isNumericLiteral(r.right)) offset = r.right.value;
      }
      if (t.isMemberExpression(n) && n.computed && t.isBinaryExpression(n.property, { operator: '-' }) && t.isIdentifier(n.property.left, { name: p0.name }) && t.isNumericLiteral(n.property.right)) offset = n.property.right.value;
      return undefined;
    });
    if (offset === null) continue;
    const src = gen(s.body);
    const shape = src.includes(B64) ? (/%\s*(0x100|256)\b/.test(src) && s.params.length > 1 ? 'rc4' : 'base64') : 'index';
    out.push({ name: s.id.name, offset, shape, keyed: shape === 'rc4' });
  }
  return out;
}

// Rotasyon IIFE'si: (function (getT, target) { … push(shift()) … }(T, 0x5b279))  ya da  (function (a, n) { while (--n) … }(T, 4))
function rotator(ast, table) {
  for (const s of ast.program.body) {
    let e = t.isExpressionStatement(s) ? s.expression : null;
    if (t.isUnaryExpression(e)) e = e.argument;
    if (!t.isCallExpression(e) || !t.isFunctionExpression(e.callee) || !e.arguments.some((a) => t.isIdentifier(a, { name: table.name }))) continue;
    const src = gen(e.callee.body);
    if (!/push/.test(src) || !/shift/.test(src)) continue;
    const num = e.arguments.find((a) => t.isNumericLiteral(a));
    if (!num) continue;
    let expr = null;
    walk(e.callee.body, (n) => {
      if (expr) return false;
      if (t.isVariableDeclarator(n) && n.init && /parseInt/.test(gen(n.init))) expr = n.init;
      return undefined;
    });
    const countLoop = /^\{while\(--\w+\)\{?\w+(\.push|\["push"\])\(\w+(\.shift|\["shift"\])\(\)\);?\}?\}$/.test(src.replace(/\s+/g, ''));
    return { target: num.value, expr, countLoop, node: s, aliases: localAliases(e.callee) };
  }
  return null;
}

function localAliases(fn) {
  const m = new Map();
  walk(fn.body, (n) => {
    if (t.isVariableDeclarator(n) && t.isIdentifier(n.id) && t.isIdentifier(n.init)) m.set(n.id.name, n.init.name);
    return !t.isFunction(n) || n === fn;
  });
  return m;
}

// Checksum ifadesini yerel olarak hesapla
function evalChecksum(expr, call) {
  const ev = (n) => {
    if (t.isNumericLiteral(n)) return n.value;
    if (t.isStringLiteral(n)) return n.value;
    if (t.isParenthesizedExpression(n)) return ev(n.expression);
    if (t.isUnaryExpression(n)) {
      const v = ev(n.argument);
      if (n.operator === '-') return -v;
      if (n.operator === '+') return +v;
      if (n.operator === '!') return !v;
      throw new Error('işleç');
    }
    if (t.isBinaryExpression(n)) {
      const a = ev(n.left);
      const b = ev(n.right);
      switch (n.operator) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '%': return a % b;
        default: throw new Error('işleç');
      }
    }
    if (t.isCallExpression(n) && t.isIdentifier(n.callee, { name: 'parseInt' })) return parseInt(ev(n.arguments[0]), n.arguments[1] ? ev(n.arguments[1]) : undefined);
    if (t.isCallExpression(n) && t.isIdentifier(n.callee)) return call(n.callee.name, n.arguments.map(ev));
    throw new Error('ifade');
  };
  return ev(expr);
}

const rotate = (arr, r) => arr.slice(r).concat(arr.slice(0, r));

// E632: hedefe ulaşan rotasyonu yerel olarak bul
export function solveRotation(table, decs, rot) {
  const len = table.values.length;
  if (rot.countLoop) return { rotation: (rot.target - 1) % len, method: 'sayaç döngüsü' };
  if (!rot.expr) return null;
  for (let r = 0; r < len; r++) {
    const arr = rotate(table.values, r);
    try {
      const v = evalChecksum(rot.expr, (name, args) => {
        const real = rot.aliases.get(name) ?? name;
        const d = decs.find((x) => x.name === real);
        if (!d) throw new Error('bilinmeyen çağrı');
        const raw = arr[args[0] - d.offset];
        if (raw === undefined) throw new Error('aralık dışı');
        return decoderFn(d.shape)(raw, args[1]);
      });
      if (v === rot.target) return { rotation: r, method: 'checksum' };
    } catch { /* bu rotasyonda decoder hata verdi: orijinal döngü de bir sonrakine geçer */ }
  }
  return null;
}

// Programdaki tüm literal argümanlı decoder çağrıları
function decoderCalls(ast, decs, rotNode = null) {
  const out = [];
  traverse(ast, {
    CallExpression(p) {
      if (!t.isIdentifier(p.node.callee)) return;
      const d = decs.find((x) => x.name === p.node.callee.name);
      if (!d) return;
      const args = p.node.arguments;
      if (!args.length || !args.every((a) => t.isNumericLiteral(a) || t.isStringLiteral(a))) return;
      if (p.findParent((x) => x.isFunctionDeclaration() && x.node.id?.name === d.name)) return;
      // rotasyon döngüsünün checksum çağrıları: değiştirilirse döngü hiç bitmez
      const inRotator = Boolean(rotNode && p.findParent((x) => x.node === rotNode));
      out.push({ path: p, decoder: d, args: args.map((a) => a.value), inRotator });
    },
  });
  return out;
}

// Tam analiz: rotasyon, çağrıların değerleri, tekil tablo, kısmi kurtarma, ters kodlayıcı
export function analyzeStringTables(ast) {
  const out = [];
  for (const table of tables(ast)) {
    const decs = decoders(ast, table);
    if (!decs.length) continue;
    const rot = rotator(ast, table);
    const solved = rot ? solveRotation(table, decs, rot) : { rotation: 0, method: 'rotasyon yok' };
    const arr = solved ? rotate(table.values, solved.rotation) : null;
    const calls = decoderCalls(ast, decs, rot?.node);
    const values = new Map();
    const missing = [];
    for (const c of calls) {
      const key = JSON.stringify(c.args);
      if (values.has(key) || !arr) continue;
      try {
        const raw = arr[c.args[0] - c.decoder.offset];
        if (raw === undefined) throw new Error('aralık');
        values.set(key, { value: decoderFn(c.decoder.shape)(raw, c.args[1]), index: c.args[0] - c.decoder.offset, args: c.args, decoder: c.decoder });
      } catch { missing.push(key); }
    }
    // E636: anahtar gerektirmeyen biçimde kullanılmayan indeksler de çözülür; rc4'te anahtarsız indeks kurtarılamaz
    const keyed = decs.every((d) => d.keyed);
    const usedIdx = new Set([...values.values()].map((v) => v.index));
    const unrecovered = [];
    if (arr) {
      for (let i = 0; i < arr.length; i++) {
        if (usedIdx.has(i)) continue;
        if (keyed) { unrecovered.push(i); continue; }
        try {
          const v = decoderFn(decs[0].shape)(arr[i]);
          values.set(`[${i + decs[0].offset}]`, { value: v, index: i, args: [i + decs[0].offset], decoder: decs[0], unused: true });
        } catch { unrecovered.push(i); }
      }
    }
    // E634/E635: değere göre tekilleştirilmiş, kullanım anahtarlarıyla tablo
    const byValue = new Map();
    for (const [k, v] of values) {
      if (!byValue.has(v.value)) byValue.set(v.value, { value: v.value, keys: [], unused: true });
      const e = byValue.get(v.value);
      e.keys.push(k);
      e.unused = e.unused && Boolean(v.unused);
    }
    // E633: kodlayıcının doğrulanması — her kurtarılan değer yeniden kodlanınca tablodaki ham değeri vermeli
    let verified = 0;
    for (const v of values.values()) {
      const raw = arr[v.index];
      const back = v.decoder.shape === 'index' ? raw === v.value
        : v.decoder.shape === 'base64' ? b64decode(b64encode(v.value)) === v.value && decoderFn('base64')(raw) === v.value
          : decoderFn('rc4')(b64encode(rc4(v.value, String(v.args[1]))), v.args[1]) === v.value;
      if (back) verified++;
    }
    out.push({
      table: table.name,
      original: table.values,
      decoder: decs.map((d) => d.name).join(', '),
      shape: decs.map((d) => `${d.name}: ${d.shape}, ofset 0x${d.offset.toString(16)}`).join('; '),
      rotation: solved ? { ...solved, text: `${solved.rotation} (${solved.method}, statik)` } : { rotation: null, text: 'statik olarak bulunamadı' },
      total: table.values.length,
      recovered: values.size ? [...new Set([...values.values()].map((v) => v.index))].length : 0,
      calls: calls.length,
      missing: [...missing, ...unrecovered.map((i) => `#${i}`)],
      duplicates: [...byValue.values()].filter((e) => e.keys.length > 1).length,
      entries: [...byValue.values()],
      inverse: inverseSource(decs[0].shape, decs[0].offset, table.name),
      inverseVerified: `${verified} / ${values.size}`,
      calls_: calls,
      values,
    });
  }
  return out;
}

// Sandbox ile çapraz denetim: dinamik rotasyon ve örnek değerler statik sonuçla aynı mı
export async function crossCheck(sandbox, ast, report) {
  if (!sandbox) return;
  const helpers = ast.program.body.filter((s) => t.isFunctionDeclaration(s) || (t.isExpressionStatement(s) && /push/.test(gen(s)) && /shift/.test(gen(s))) ||
    (t.isVariableDeclaration(s) && s.declarations.every((d) => !d.init || t.isArrayExpression(d.init) || t.isLiteral(d.init))));
  const code = helpers.map((s) => gen(s)).join('\n');
  for (const r of report) {
    const sample = [...r.values.entries()].filter(([, v]) => !v.unused).slice(0, 40);
    const probes = sample.map(([, v]) => `__res.push((function(){ try { return ${v.decoder.name}(${v.args.map((a) => JSON.stringify(a)).join(', ')}); } catch (e) { return null; } })());`).join('\n');
    const tableExpr = r.table;
    const res = await sandbox.run(`${code}\n__res.push(JSON.stringify(typeof ${tableExpr} === "function" ? ${tableExpr}() : ${tableExpr}));\n${probes}`, { timeoutMs: 6000 });
    if (!res.ok || !res.res?.length) { r.crossCheck = 'sandbox çalıştırılamadı'; continue; }
    let dynRot = null;
    try {
      const after = JSON.stringify(JSON.parse(res.res[0]));
      for (let k = 0; k < r.original.length && dynRot === null; k++) if (JSON.stringify(rotate(r.original, k)) === after) dynRot = k;
    } catch { /* tablo okunamadı */ }
    const same = sample.filter(([, v], i) => res.res[i + 1] === v.value).length;
    r.rotation.dynamic = dynRot;
    r.crossCheck = `${same} / ${sample.length} değer sandbox ile aynı; rotasyon sandbox'ta ${dynRot ?? '?'}${dynRot === null ? '' : dynRot === r.rotation.rotation ? ' (statikle aynı)' : ' (statikten farklı)'}`;
  }
}

// Rapora girecek serileştirilebilir biçim
export function serializeTables(report) {
  return report.map(({ calls_, values, original, ...rest }) => ({ ...rest, entries: rest.entries.map((e) => ({ value: e.value, keys: e.keys, unused: e.unused })) }));
}
