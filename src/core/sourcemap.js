// E60: çıktı için Source Map v3 üretme. Girdi ve çıktı token dizileri arayüzün eşleme modülündeki
// "patience" hizalamasıyla (ui/srcmap.js) eşlenir; eşleşen her token için çıktı → girdi konumu yazılır.
// İsim kurtarma (E59) 05-sourcemap pass'indedir.
import { tokenize, align } from '../ui/srcmap.js';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function vlqEncode(v) {
  let n = v < 0 ? (-v << 1) | 1 : v << 1;
  let out = '';
  do {
    let digit = n & 31;
    n >>>= 5;
    if (n) digit |= 32;
    out += B64[digit];
  } while (n);
  return out;
}

// karakter konumu → { line, col } (0 tabanlı)
function locator(code) {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return { line: lo, col: offset - starts[lo] };
  };
}

/** çıktı (output) → girdi (input) Source Map v3 */
export function generateSourceMap(input, output, { file = 'peeled.js', source = 'input.js' } = {}) {
  const A = tokenize(output);
  const B = tokenize(input);
  if (!A || !B) throw new Error('kod token dizisine ayrılamadı');
  const pairs = align(A, B);
  const outLoc = locator(output);
  const inLoc = locator(input);
  const names = [];
  const nameIdx = new Map();
  const byLine = [];
  for (const [i, j] of pairs) {
    const o = outLoc(A[i].start);
    const s = inLoc(B[j].start);
    const name = B[j].key.startsWith('i:') ? B[j].key.slice(2) : null;
    (byLine[o.line] ??= []).push([o.col, s.line, s.col, name]);
  }
  let prevSrcLine = 0;
  let prevSrcCol = 0;
  let prevName = 0;
  const lines = [];
  const total = Math.max(byLine.length, output.split('\n').length);
  for (let line = 0; line < total; line++) {
    const segs = (byLine[line] ?? []).sort((x, y) => x[0] - y[0]);
    let prevCol = 0;
    const enc = [];
    for (const [col, sl, sc, nm] of segs) {
      let s = vlqEncode(col - prevCol) + vlqEncode(0) + vlqEncode(sl - prevSrcLine) + vlqEncode(sc - prevSrcCol);
      if (nm) {
        if (!nameIdx.has(nm)) { nameIdx.set(nm, names.length); names.push(nm); }
        const ni = nameIdx.get(nm);
        s += vlqEncode(ni - prevName);
        prevName = ni;
      }
      enc.push(s);
      prevCol = col;
      prevSrcLine = sl;
      prevSrcCol = sc;
    }
    lines.push(enc.join(','));
  }
  return {
    map: { version: 3, file, sources: [source], sourcesContent: [input], names, mappings: lines.join(';') },
    matched: pairs.length,
    coverage: A.length ? Number((pairs.length / A.length).toFixed(3)) : 1,
  };
}

// E59 için yardımcı: harici .map dosyasını girdinin sonuna satır içi harita olarak ekler (05-sourcemap okur)
export function attachInlineMap(code, mapText) {
  const map = JSON.parse(mapText);
  if (map?.version !== 3 || typeof map.mappings !== 'string') throw new Error('Source Map v3 değil');
  const b64 = typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(mapText))) : Buffer.from(mapText).toString('base64');
  return `${code.replace(/\n\/\/[#@]\s*sourceMappingURL=.*\s*$/, '')}\n//# sourceMappingURL=data:application/json;base64,${b64}\n`;
}
