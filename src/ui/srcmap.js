import { parse as babelParse } from '@babel/parser';

// Çıktıdan girdiye kaynak eşleme: iki kodun token dizileri "patience" hizalamasıyla eşleştirilir.
// Pass'ler kodu her turda yeniden ürettiği için gerçek source map yok; hizalama string, sayı,
// özellik adı ve korunan tanımlayıcı gibi çapalar üzerinden yapılır. Çapa yoksa bölge kabalaşır.

const PLUGINS = ['dynamicImport', 'classProperties', 'classPrivateProperties', 'classPrivateMethods',
  'optionalChaining', 'nullishCoalescingOperator', 'topLevelAwait', 'importMeta', 'numericSeparator', 'logicalAssignment'];

export function tokenize(code) {
  for (const sourceType of ['script', 'module']) {
    try {
      const ast = babelParse(code, { sourceType, tokens: true, errorRecovery: true, allowReturnOutsideFunction: true, plugins: PLUGINS });
      return keyed(ast.tokens);
    } catch { /* diğer kaynak türünü dene */ }
  }
  return null;
}

// Her token'a hizalama anahtarı: `a.b` ile `a["b"]` aynı çapayı üretir
function keyed(tokens) {
  const out = [];
  let prevDot = false;
  const labelOf = (tk) => (tk ? (typeof tk.type === 'object' ? tk.type.label : tk.type) : null);
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    const label = labelOf(tk);
    let key = null;
    if (label === 'string') key = `s:${tk.value}`;
    else if (label === 'num' || label === 'bigint') key = `n:${tk.value}`;
    else if (label === 'template') key = tk.value ? `t:${tk.value}` : null;
    else if (label === 'regexp') key = `r:${tk.value?.pattern}/${tk.value?.flags}`;
    // `a.b`, `a["b"]` ve `{ b: 1 }` / `{ "b": 1 }` aynı özellik çapasını üretir
    else if (label === 'name') key = prevDot || labelOf(tokens[i + 1]) === ':' ? `s:${tk.value}` : `i:${tk.value}`;
    else if (tk.type?.keyword) key = `k:${label}`;
    prevDot = label === '.' || label === '?.';
    if (key !== null) out.push({ key, start: tk.start, end: tk.end });
  }
  return out;
}

// En uzun artan alt dizi (j indekslerine göre); patience sıralaması O(n log n)
function lis(pairs) {
  const tails = [];
  const prev = new Array(pairs.length);
  for (let k = 0; k < pairs.length; k++) {
    const j = pairs[k][1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < j) lo = mid + 1;
      else hi = mid;
    }
    prev[k] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = k;
  }
  const res = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) res.push(pairs[k]);
  return res.reverse();
}

// A ve B token dizilerini hizalar; [i, j] eşleşme çiftleri (her iki indekste artan) döner
export function align(A, B) {
  const matches = [];
  const stack = [[0, A.length, 0, B.length]];
  while (stack.length) {
    let [a0, a1, b0, b1] = stack.pop();
    // ortak önek/sonek doğrudan eşleşir
    while (a0 < a1 && b0 < b1 && A[a0].key === B[b0].key) matches.push([a0++, b0++]);
    while (a0 < a1 && b0 < b1 && A[a1 - 1].key === B[b1 - 1].key) matches.push([--a1, --b1]);
    if (a0 >= a1 || b0 >= b1) continue;
    const ca = new Map();
    for (let i = a0; i < a1; i++) {
      const e = ca.get(A[i].key);
      if (e) e.n++;
      else ca.set(A[i].key, { n: 1, i });
    }
    const cb = new Map();
    for (let j = b0; j < b1; j++) {
      const e = cb.get(B[j].key);
      if (e) e.n++;
      else cb.set(B[j].key, { n: 1, j });
    }
    const pairs = [];
    for (const [k, ea] of ca) {
      const eb = cb.get(k);
      if (ea.n === 1 && eb?.n === 1) pairs.push([ea.i, eb.j]);
    }
    if (!pairs.length) continue;
    pairs.sort((x, y) => x[0] - y[0]);
    const anchors = lis(pairs);
    let pa = a0;
    let pb = b0;
    for (const [i, j] of anchors) {
      matches.push([i, j]);
      if (i > pa && j > pb) stack.push([pa, i, pb, j]);
      pa = i + 1;
      pb = j + 1;
    }
    if (a1 > pa && b1 > pb) stack.push([pa, a1, pb, b1]);
  }
  return matches.sort((x, y) => x[0] - y[0]);
}

/** Çıktı ile girdi arasında eşleme tablosu; tokenize edilemezse null */
export function buildMap(outCode, inCode) {
  const A = tokenize(outCode);
  const B = tokenize(inCode);
  if (!A || !B) return null;
  const m = align(A, B);
  return {
    out: m.map(([i]) => [A[i].start, A[i].end]),
    in: m.map(([, j]) => [B[j].start, B[j].end]),
    outLen: outCode.length,
    inLen: inCode.length,
  };
}

/**
 * Bir konumu karşı tarafa taşır. dir: 'out' (çıktıdan girdiye) ya da 'in' (girdiden çıktıya).
 * Konum bir çapanın üzerindeyse karşılığı tam döner (exact: true); değilse iki çapa arasındaki bölge.
 */
export function mapOffset(map, offset, dir = 'out') {
  if (!map || !map.out.length) return null;
  const src = dir === 'out' ? map.out : map.in;
  const dst = dir === 'out' ? map.in : map.out;
  const dstLen = dir === 'out' ? map.inLen : map.outLen;
  let lo = 0;
  let hi = src.length - 1;
  let k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (src[mid][0] <= offset) { k = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (k >= 0 && offset <= src[k][1]) return { from: dst[k][0], to: dst[k][1], exact: true, point: dst[k][0] };
  const from = k >= 0 ? dst[k][1] : 0;
  const to = k + 1 < dst.length ? dst[k + 1][0] : dstLen;
  // çapasız bölgede konum, iki çapa arasındaki oranla karşı bölgeye taşınır (yaklaşık nokta)
  const s0 = k >= 0 ? src[k][1] : 0;
  const s1 = k + 1 < src.length ? src[k + 1][0] : (dir === 'out' ? map.outLen : map.inLen);
  const f = s1 > s0 ? Math.max(0, Math.min(1, (offset - s0) / (s1 - s0))) : 0;
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  return { from: a, to: b, exact: false, point: Math.round(a + f * (b - a)) };
}
