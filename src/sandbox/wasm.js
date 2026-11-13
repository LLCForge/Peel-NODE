// C64: WebAssembly ikili modül ayrıştırıcı — import/export, imzalar, bellek, tablo, global, start, özel bölümler.
// Kendi kendine yeten tek fonksiyon: stub'lara toString() ile gömülüp sandbox içinde de çalışır (kapanım yok).
export function parseWasm(input) {
  var b = input instanceof Uint8Array ? input : new Uint8Array(input && input.buffer ? input.buffer : input || []);
  var p = 0;
  var KIND = ['func', 'table', 'memory', 'global', 'tag'];
  var VT = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64', 0x7b: 'v128', 0x70: 'funcref', 0x6f: 'externref' };
  function fail(m) { throw new Error('wasm: ' + m + ' @' + p); }
  function byte() { if (p >= b.length) fail('beklenmeyen son'); return b[p++]; }
  function u32() {
    var r = 0, s = 0, x;
    do { x = byte(); r += (x & 0x7f) * Math.pow(2, s); s += 7; if (s > 35) fail('leb128'); } while (x & 0x80);
    return r;
  }
  function sleb() {
    var r = 0, s = 0, x;
    do { x = byte(); r += (x & 0x7f) * Math.pow(2, s); s += 7; } while (x & 0x80 && s < 70);
    if (s < 64 && x & 0x40) r -= Math.pow(2, s);
    return r;
  }
  function name() {
    var n = u32(), end = p + n, s = '';
    if (end > b.length) fail('isim taşması');
    for (; p < end; p++) s += String.fromCharCode(b[p]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }
  function vt() { var x = byte(); return VT[x] || '0x' + x.toString(16); }
  function limits() { var f = byte(), min = u32(), max = f & 1 ? u32() : null; return { min: min, max: max, shared: !!(f & 2) }; }
  function skipExpr() {
    // sabit ifade: i32/i64/f32/f64.const, global.get, ref.null, ref.func ... end
    for (;;) {
      var op = byte();
      if (op === 0x0b) return;
      if (op === 0x41 || op === 0x42) sleb();
      else if (op === 0x43) p += 4;
      else if (op === 0x44) p += 8;
      else if (op === 0x23 || op === 0xd2) u32();
      else if (op === 0xd0) byte();
      else if (op === 0x6a || op === 0x6b || op === 0x6c || op === 0x7c || op === 0x7d || op === 0x7e) { /* genişletilmiş sabit aritmetik */ }
      else fail('sabit ifade 0x' + op.toString(16));
    }
  }
  if (b.length < 8 || b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) fail('\\0asm imzası yok');
  p = 4;
  var version = b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24);
  p = 8;
  var out = { version: version, types: [], imports: [], exports: [], functions: [], memories: [], tables: [], globals: [],
    start: null, custom: [], dataSegments: 0, codeBodies: 0, size: b.length };
  var importedFuncs = 0;
  while (p < b.length) {
    var id = byte(), size = u32(), end = p + size;
    if (end > b.length) fail('bölüm taşması');
    if (id === 0) out.custom.push({ name: name(), size: end - p });
    else if (id === 1) {
      for (var n = u32(), i = 0; i < n; i++) {
        if (byte() !== 0x60) fail('fonksiyon tipi');
        var params = [], results = [];
        for (var k = u32(); k > 0; k--) params.push(vt());
        for (var k2 = u32(); k2 > 0; k2--) results.push(vt());
        out.types.push({ params: params, results: results });
      }
    } else if (id === 2) {
      for (var n2 = u32(), j = 0; j < n2; j++) {
        var imp = { module: name(), name: name(), kind: '' }, kind = byte();
        imp.kind = KIND[kind] || 'kind' + kind;
        if (kind === 0) { imp.type = u32(); importedFuncs++; }
        else if (kind === 1) { imp.elem = vt(); imp.limits = limits(); }
        else if (kind === 2) imp.limits = limits();
        else if (kind === 3) { imp.valType = vt(); imp.mutable = byte() === 1; }
        else if (kind === 4) { byte(); imp.type = u32(); }
        out.imports.push(imp);
      }
    } else if (id === 3) { for (var n3 = u32(); n3 > 0; n3--) out.functions.push(u32()); }
    else if (id === 4) { for (var n4 = u32(); n4 > 0; n4--) out.tables.push({ elem: vt(), limits: limits() }); }
    else if (id === 5) { for (var n5 = u32(); n5 > 0; n5--) out.memories.push(limits()); }
    else if (id === 6) { for (var n6 = u32(); n6 > 0; n6--) { var g = { valType: vt(), mutable: byte() === 1 }; skipExpr(); out.globals.push(g); } }
    else if (id === 7) {
      for (var n7 = u32(); n7 > 0; n7--) {
        var e = { name: name(), kind: '', index: 0 }, ek = byte();
        e.kind = KIND[ek] || 'kind' + ek;
        e.index = u32();
        out.exports.push(e);
      }
    } else if (id === 8) out.start = u32();
    else if (id === 10) out.codeBodies = u32();
    else if (id === 11) out.dataSegments = u32();
    p = end;
  }
  // imza ekle: içe/dışa aktarılan fonksiyonların tip açıklaması "(i32, i32) -> i32"
  function sig(t) { var ty = out.types[t]; return ty ? '(' + ty.params.join(', ') + ') -> ' + (ty.results.join(', ') || 'void') : '?'; }
  out.imports.forEach(function (x) { if (x.kind === 'func') x.signature = sig(x.type); });
  out.exports.forEach(function (x) {
    if (x.kind !== 'func') return;
    var t = x.index < importedFuncs ? out.imports.filter(function (y) { return y.kind === 'func'; })[x.index].type : out.functions[x.index - importedFuncs];
    x.signature = sig(t);
  });
  return out;
}

// Kaynak koddaki gömülü modüller (statik): "AGFzbQ" ile başlayan base64 ya da 0,97,115,109 ile başlayan sayı dizileri
export function findEmbeddedWasm(code) {
  const found = [];
  for (const m of code.matchAll(/["'`](AGFzbQ[A-Za-z0-9+/=]{8,})["'`]/g)) {
    try { found.push({ source: 'base64', bytes: Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)) }); } catch { /* geçersiz base64 */ }
  }
  for (const m of code.matchAll(/\[\s*0\s*,\s*97\s*,\s*115\s*,\s*109\s*,[\d\s,]+\]/g)) {
    found.push({ source: 'array', bytes: Uint8Array.from(JSON.parse(m[0])) });
  }
  return found.slice(0, 20).map((f) => {
    try { return { source: f.source, ...parseWasm(f.bytes) }; } catch (e) { return { source: f.source, error: e.message, size: f.bytes.length }; }
  });
}
