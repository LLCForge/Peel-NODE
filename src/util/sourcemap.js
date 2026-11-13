// Kaynak haritası (v3) okuma: satır içi data: URL'si ve VLQ çözümü. Bağımlılıksız.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));
const INLINE = /\/\/[#@]\s*sourceMappingURL=data:application\/json(?:;charset=[\w-]+)?;base64,([A-Za-z0-9+/=]+)\s*$/;

function decodeBase64(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Koddaki satır içi kaynak haritası: { map, comment } ya da null
export function inlineSourceMap(code) {
  const m = code.match(INLINE);
  if (!m) return null;
  try {
    const map = JSON.parse(decodeBase64(m[1]));
    if (map?.version !== 3 || typeof map.mappings !== 'string') return null;
    return { map, comment: m[0] };
  } catch {
    return null;
  }
}

// mappings → satır başına [üretilenSütun, kaynak, kaynakSatır, kaynakSütun, ad?] dizileri (mutlak değerler)
export function decodeMappings(mappings) {
  const lines = [];
  let src = 0;
  let srcLine = 0;
  let srcCol = 0;
  let name = 0;
  for (const line of mappings.split(';')) {
    const segs = [];
    let col = 0;
    for (const seg of line.split(',')) {
      if (!seg) continue;
      const vals = [];
      let shift = 0;
      let value = 0;
      for (const ch of seg) {
        const digit = B64_INDEX.get(ch);
        if (digit === undefined) throw new Error('geçersiz VLQ');
        value += (digit & 31) << shift;
        if (digit & 32) { shift += 5; continue; }
        vals.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0;
        shift = 0;
      }
      col += vals[0];
      const out = [col];
      if (vals.length >= 4) {
        src += vals[1]; srcLine += vals[2]; srcCol += vals[3];
        out.push(src, srcLine, srcCol);
        if (vals.length >= 5) { name += vals[4]; out.push(name); }
      }
      segs.push(out);
    }
    lines.push(segs);
  }
  return lines;
}

// Üretilen konumu (0 tabanlı satır/sütun) kapsayan son segment
export function segmentAt(lines, line, col) {
  const segs = lines[line];
  if (!segs) return null;
  let best = null;
  for (const s of segs) {
    if (s[0] > col) break;
    best = s;
  }
  return best;
}
