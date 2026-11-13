// Arayüz saf modülleri öz-denetimi: node test/ui-intel.test.js
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  parseSafe, nodePath, pathString, resolveNodePath, symbolAt, renameEdits, symbols, queryAst, parseSelector, textSearch,
  entropy, stringTable, highEntropy, remnants, duplicates, similarFunctions, undefinedRefs, unusedBindings, longLines,
  deepNesting, magicNumbers, apiUsage, stringUsage, complexity, shadows, scopeColors, deadCode, trustMap, proxyMap, countNodes,
} from '../src/ui/code-intel.js';
import { callGraph, cfg, cfgTargets, dataFlow, specifiers, dependencyGraph, resolveSpecifier, stateMachines, opcodeFrequency } from '../src/ui/graph-model.js';
import { layout, visibleNodes } from '../src/ui/graph-layout.js';
import { buildMap, mapOffset, align } from '../src/ui/srcmap.js';
import { eventToKey, normalizeKey, fuzzyScore } from '../src/ui/keys.js';
import { readZip, crxToZip, harScripts, isZip } from '../src/ui/archive.js';
import { lineDiff, diffStats, compactDiff } from '../src/ui/diff.js';

const apply = (code, edits) => edits.slice().sort((a, b) => b.from - a.from).reduce((s, e) => s.slice(0, e.from) + e.insert + s.slice(e.to), code);

// ── bağlama ve yeniden adlandırma ──
{
  const code = 'function f(a) { var b = a + 1; return {b, a}; }\nvar a = f(2); console.log(a.b);';
  const { ast } = parseSafe(code);
  const at = code.indexOf('b = a');
  const sym = symbolAt(ast, at);
  assert.equal(sym.kind, 'binding');
  assert.equal(sym.refs.length, 2, 'b: tanım + kısayol');
  const r = renameEdits(ast, at, 'total');
  assert.equal(apply(code, r.edits), 'function f(a) { var total = a + 1; return {b: total, a}; }\nvar a = f(2); console.log(a.b);');
  assert.equal(renameEdits(ast, at, 'a').error, 'conflict', 'aynı kapsamdaki a ile çakışır');
  assert.deepEqual(renameEdits(ast, at, 'console').error, undefined, 'f içinde console kullanılmıyor');
  const g = 'function g(){ var v = 1; console.log(v); }';
  assert.equal(renameEdits(parseSafe(g).ast, g.indexOf('v ='), 'console').error, 'conflict', 'global console gölgelenmez');
  assert.equal(renameEdits(ast, at, '1x').error, 'invalid');
  const prop = symbolAt(ast, code.lastIndexOf('.b') + 1);
  assert.equal(prop.kind, 'property');
  assert.ok(prop.refs.length >= 2);
  const glob = symbolAt(ast, code.indexOf('console'));
  assert.equal(glob.kind, 'global');
}
{
  const code = 'const {x = 1} = o; export { x };';
  const { ast } = parseSafe(code);
  const r = renameEdits(ast, code.indexOf('x'), 'y');
  assert.equal(apply(code, r.edits), 'const {x: y = 1} = o; export { y as x };');
}

// ── yol, sembol, sorgu ──
{
  const code = 'var s = "https://evil.xyz/a"; function go(u) { return fetch(u, { method: "POST" }); } eval("1");';
  const { ast } = parseSafe(code);
  const chain = nodePath(ast, code.indexOf('fetch') + 1);
  assert.equal(chain[chain.length - 1].node.type, 'Identifier');
  const p = pathString(chain);
  assert.equal(resolveNodePath(ast, p)?.name, 'fetch');
  assert.deepEqual(symbols(ast).map((s) => s.name), ['s', 'go']);
  assert.equal(queryAst(ast, 'CallExpression[callee.name=eval]').length, 1);
  assert.equal(queryAst(ast, 'FunctionDeclaration > BlockStatement > ReturnStatement CallExpression').length, 1);
  assert.equal(queryAst(ast, 'StringLiteral[value~=/^https?:/i]').length, 1);
  assert.equal(queryAst(ast, '[arguments.length>=2]').length, 1);
  assert.equal(queryAst(ast, 'Function').length, 1, 'takma ad: Function');
  assert.throws(() => parseSelector('Call['));
  assert.equal(textSearch(code, 'post', { scope: 'strings', ast }).length, 1);
  assert.equal(textSearch(code, 'fetch', { scope: 'strings', ast }).length, 0);
  assert.equal(textSearch(code, 'f\\w+h', { regex: true, scope: 'calls', ast }).length, 1);
  assert.equal(textSearch(code, 'u', { wholeWord: true }).length, 2);
  assert.equal(apiUsage(ast, 'fetch').length, 1);
  assert.equal(stringUsage(ast, '/evil/').length, 1);
}

// ── mercekler ──
{
  assert.ok(entropy('aaaa') === 0 && entropy('abcd') === 2);
  const code = `var _0x1a2b = ["a"]; function _0xdec(i) { return _0x1a2b[i]; } _0xdec(0x1);
var k = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRg=="; var unused = 1; var big = 86400;
function a1(x) { if (x) { return x * 2 + 3; } return 0; }
function a2(y) { if (y) { return y * 2 + 3; } return 0; }
function deep(){ if(1){ if(2){ if(3){ if(4){ if(5){ q(); } } } } } }
function inner(){ var a1 = 2; return a1; return 3; }
if (false) { dead(); }`;
  const { ast } = parseSafe(code);
  assert.ok(stringTable(ast).some((s) => s.value === 'a'));
  assert.equal(highEntropy(ast, { min: 4 }).length, 1);
  const rem = remnants(ast);
  assert.ok(rem.some((r) => r.note === 'decoder') && rem.some((r) => r.note === '_0x'));
  assert.equal(duplicates(ast, { minSize: 10 }).length, 1, 'a1 ve a2 yapısal kopya');
  assert.ok(similarFunctions(ast, code, code.indexOf('a1(x)')).some((s) => s.text === 'a2'));
  assert.ok(undefinedRefs(ast).some((r) => r.text === 'q') && !undefinedRefs(ast).some((r) => r.text === 'fetch'));
  assert.ok(unusedBindings(ast).some((r) => r.text === 'unused'));
  assert.equal(longLines('a\n' + 'x'.repeat(200), 160).length, 1);
  assert.equal(deepNesting(ast, 5).length, 1);
  assert.ok(magicNumbers(ast).some((r) => r.text === '86400'));
  assert.ok(complexity(ast).find((c) => c.name === 'deep').complexity === 6);
  assert.ok(shadows(ast).some((s) => s.text === 'a1'));
  assert.ok(scopeColors(ast).length > 5);
  const dead = deadCode(ast);
  assert.ok(dead.some((d) => d.note === 'unreachable') && dead.some((d) => d.note === 'constant-false'));
  const trust = trustMap(code, ast);
  assert.ok(trust[0] < 1 && trust[2] === 1);
  assert.ok(countNodes(ast) > 50);
}
{
  const code = 'var _0xab = { abcde: function (a, b) { return a + b; }, fghij: "log", klmno: function (f, x) { return f(x); } }; _0xab.abcde(1, 2);';
  const { ast } = parseSafe(code);
  const pm = proxyMap(ast);
  assert.deepEqual(pm.map((p) => [p.owner, p.kind, p.shape]), [['_0xab.abcde', 'binary', '$0 + $1'], ['_0xab.fghij', 'string', '"log"'], ['_0xab.klmno', 'call', '$0($1)']]);
}

// ── grafikler ──
{
  const code = 'function a(){ b(); fetch("x"); } function b(){ a(); } a();';
  const { ast } = parseSafe(code);
  const g = callGraph(ast, code);
  const label = (id) => g.nodes.find((n) => n.id === id).label;
  const pairs = g.edges.map((e) => `${label(e.from)}>${label(e.to)}`).sort();
  assert.deepEqual(pairs, ['(program)>a', 'a>b', 'a>fetch', 'b>a']);
}
{
  const code = 'function f(x){ for (let i = 0; i < x; i++) { if (i === 3) continue; if (i > 5) break; g(i); } switch (x) { case 1: h(); case 2: return 1; default: k(); } try { m(); } catch (e) { n(); } finally { o(); } return 0; }';
  const { ast } = parseSafe(code);
  const fn = cfgTargets(ast, code)[1].node;
  const c = cfg(fn);
  const kinds = c.nodes.map((n) => n.kind);
  assert.ok(kinds.includes('entry') && kinds.includes('exit') && kinds.filter((k) => k === 'cond').length === 4 && kinds.includes('catch'));
  assert.ok(c.edges.some((e) => e.label === 'continue') && c.edges.some((e) => e.label === 'fall') && c.edges.some((e) => e.label === 'throw'));
  const ids = new Set(c.nodes.map((n) => n.id));
  assert.ok(c.edges.every((e) => ids.has(e.from) && ids.has(e.to)));
  // her düğüme girişten ulaşılabilir
  const reach = new Set(['b0']);
  for (let changed = true; changed;) { changed = false; for (const e of c.edges) if (reach.has(e.from) && !reach.has(e.to)) { reach.add(e.to); changed = true; } }
  assert.ok(reach.has('b1'), 'çıkışa ulaşılır');
}
{
  const code = 'var a = 1; var b = a + 2; function f(p) { var q = p; return q; } var r = f(b);';
  const { ast } = parseSafe(code);
  const g = dataFlow(ast, code);
  const name = (id) => g.nodes.find((n) => n.id === id).label.split(' ')[0];
  const flows = g.edges.map((e) => `${name(e.from)}>${name(e.to)}`).sort();
  assert.deepEqual(flows, ['a>b', 'b>p', 'b>r', 'f>r', 'p>q']);
}
{
  const { ast } = parseSafe('import x from "./lib/util"; const y = require("lodash"); importScripts("w.js"); s.src = "https://cdn/x.js";');
  assert.deepEqual(specifiers(ast).sort(), ['./lib/util', 'https://cdn/x.js', 'lodash', 'w.js']);
  assert.equal(resolveSpecifier('src/main.js', './lib/util', new Set(['src/lib/util.js'])), 'src/lib/util.js');
  assert.equal(resolveSpecifier('src/a/b.js', '../c', new Set(['src/c/index.js'])), 'src/c/index.js');
  const dg = dependencyGraph([{ id: 'd1', path: 'src/main.js', specifiers: ['./lib/util', 'lodash'] }, { id: 'd2', path: 'src/lib/util.js', specifiers: [] }]);
  assert.deepEqual(dg.edges.map((e) => `${e.from}>${e.to}`), ['d1>d2', 'd1>m:lodash']);
}
{
  const code = 'var s = 1; while (true) { switch (s) { case 1: a(); s = 3; break; case 3: s = c ? 1 : 4; break; case 4: return; } }\nvar o = "2|0|1".split("|"), i = 0; while (!![]) { switch (o[i++]) { case "0": x(); continue; case "1": y(); continue; case "2": z(); continue; } break; }';
  const { ast } = parseSafe(code);
  const ms = stateMachines(ast, code);
  assert.equal(ms.length, 2);
  const e1 = ms[0].graph.edges.map((e) => `${e.from}>${e.to}`).sort();
  assert.deepEqual(e1, ['s:1>s:3', 's:3>s:1', 's:3>s:4', 's:4>exit']);
  assert.deepEqual(ms[1].graph.edges.map((e) => `${e.from}>${e.to}`), ['s:2>s:0', 's:0>s:1', 's:1>exit']);
}
{
  const code = 'var code = [1, 2, 1, 1, 3, 9, 2, 1]; var pc = 0; while (pc < code.length) { switch (code[pc++]) { case 1: break; case 2: break; case 3: break; } }';
  const { ast } = parseSafe(code);
  const [f] = opcodeFrequency(ast);
  assert.equal(f.array, 'code');
  assert.deepEqual(f.ops[0], { op: 1, count: 4, handled: true });
  assert.ok(f.ops.some((o) => o.op === 9 && !o.handled));
}

// ── yerleşim ──
{
  const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id, w: 40, h: 20 }));
  const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }, { from: 'a', to: 'd' }];
  for (const kind of ['layered', 'force', 'circle', 'grid']) {
    const pos = layout(nodes, edges, kind);
    assert.equal(pos.size, 4, kind);
    for (const p of pos.values()) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), kind);
  }
  const lay = layout(nodes, edges, 'layered');
  assert.ok(lay.get('a').y < lay.get('b').y && lay.get('b').y < lay.get('c').y, 'döngü kırılıp katmanlandı');
  assert.equal(visibleNodes(nodes, lay, { x0: -1e9, y0: -1e9, x1: 1e9, y1: lay.get('a').y + 1 }).length, 1);
}

// ── kaynak eşleme ──
{
  const input = 'var _0x1=["\\x68\\x69"];function _0x2(a){return _0x1[a]}console["log"](_0x2(0),42);';
  const output = 'var _0x1 = ["hi"];\nfunction _0x2(a) {\n  return _0x1[a];\n}\nconsole.log(_0x2(0), 42);';
  const map = buildMap(output, input);
  const m = mapOffset(map, output.indexOf('42'), 'out');
  assert.equal(input.slice(m.from, m.to), '42');
  const back = mapOffset(map, input.indexOf('"log"'), 'in');
  assert.equal(output.slice(back.from, back.to), 'log');
  assert.ok(align([{ key: 'a' }, { key: 'b' }], [{ key: 'b' }, { key: 'a' }]).length === 1);
}

// ── kısayollar ──
{
  assert.equal(eventToKey({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+P');
  assert.equal(eventToKey({ key: '?', code: 'Slash', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+/');
  assert.equal(eventToKey({ key: 'p', code: 'KeyP', metaKey: true }, true), 'Ctrl+P');
  assert.equal(eventToKey({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), null);
  assert.equal(normalizeKey('shift+ctrl+p'), 'Ctrl+Shift+P');
  assert.equal(normalizeKey('Ctrl+A+B'), null);
  assert.ok(fuzzyScore('opfo', 'Open folder') > 0 && fuzzyScore('xyz', 'Open folder') === -1);
}

// ── fark ──
{
  const rows = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd');
  assert.deepEqual(diffStats(rows), { add: 1, del: 1 });
  assert.equal(compactDiff(rows, 0).filter((r) => r[0] === 'gap').length, 2);
}

// ── arşivler ──
{
  const enc = new TextEncoder();
  const files = [['a.js', 'var a = 1;', 8], ['dir/b.mjs', 'export const b = 2;', 0], ['c.txt', 'x', 0]];
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text, method] of files) {
    const raw = enc.encode(text);
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const n = enc.encode(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data);
    central.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  const zip = new Uint8Array(Buffer.concat([...locals, cd, eocd]));
  assert.ok(isZip(zip));
  const got = await readZip(zip, (n) => /\.m?js$/.test(n));
  assert.deepEqual(got.map((f) => [f.name, new TextDecoder().decode(f.data)]), [['a.js', 'var a = 1;'], ['dir/b.mjs', 'export const b = 2;']]);
  const crx = Buffer.alloc(12);
  crx.write('Cr24', 0); crx.writeUInt32LE(3, 4); crx.writeUInt32LE(4, 8);
  const unwrapped = crxToZip(new Uint8Array(Buffer.concat([crx, Buffer.alloc(4), zip])));
  assert.equal((await readZip(unwrapped)).length, 3);
  const har = { log: { entries: [
    { request: { url: 'https://x.com/app.js?v=1' }, response: { content: { mimeType: 'application/javascript', text: 'a()' } } },
    { request: { url: 'https://x.com/i.png' }, response: { content: { mimeType: 'image/png', text: 'AAAA', encoding: 'base64' } } },
    { request: { url: 'https://x.com/b' }, response: { content: { mimeType: 'text/javascript', text: Buffer.from('b()').toString('base64'), encoding: 'base64' } } },
  ] } };
  assert.deepEqual(harScripts(har).map((s) => [s.name, s.text]), [['app.js', 'a()'], ['b', 'b()']]);
  assert.throws(() => harScripts({}));
}

// ── ayar ve oturum doğrulaması (güvenilmez JSON) ──
{
  const { sanitize, DEFAULTS } = await import('../src/ui/settings.js');
  const { sanitizeSession } = await import('../src/ui/store.js');
  const s = sanitize({ theme: 'evil', fontSize: 999, layout: 4, format: { printWidth: 'x', trailingComma: 'es5' }, keymap: { run: 'Ctrl+R', bad: { x: 1 } }, approvedHosts: ['cdn.test', 'bad host/'] });
  assert.equal(s.theme, DEFAULTS.theme);
  assert.equal(s.fontSize, 32);
  assert.equal(s.layout, 4);
  assert.equal(s.format.printWidth, DEFAULTS.format.printWidth);
  assert.equal(s.format.trailingComma, 'es5');
  assert.deepEqual(s.keymap, { run: 'Ctrl+R' });
  assert.deepEqual(s.approvedHosts, ['cdn.test']);
  const sess = sanitizeSession({ active: 'x', groups: [{ id: 'g1', name: 'G', color: 'red' }], docs: [{ id: 'd1', name: 'a.js', input: 'a()', group: 'g1', marks: { in: { bookmarks: [3, -1, 'x'], notes: [{ line: 2, text: 'n' }, { line: 0, text: 'bad' }] } } }, { name: 'no-id' }] });
  assert.equal(sess.docs.length, 1);
  assert.equal(sess.active, 'd1');
  assert.equal(sess.groups[0].color, '#f7df1e');
  assert.deepEqual(sess.docs[0].marks.in, { bookmarks: [3], notes: [{ line: 2, text: 'n' }] });
  assert.throws(() => sanitizeSession({ docs: 'x' }));
}

console.log('ui-intel: ok');
