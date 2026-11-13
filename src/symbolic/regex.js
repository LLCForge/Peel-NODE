// Düzenli ifade alt kümesi: ayrıştırma → Thompson NFA (string çözücüsü için, E590) ve
// örneklerden regex sentezi (E591). Desteklenmeyen yapılar (geri başvuru, lookaround, \b, u/g/y bayrakları)
// null döndürür; çağıran taraf bunu "bilinmiyor" olarak ele alır.

const MAXC = 0xffff;
const RANGES = {
  d: [[48, 57]],
  w: [[48, 57], [65, 90], [95, 95], [97, 122]],
  s: [[9, 13], [32, 32], [160, 160], [5760, 5760], [8192, 8202], [8232, 8233], [8239, 8239], [8287, 8287], [12288, 12288], [65279, 65279]],
};
const DOT = [[0, 9], [11, 12], [14, 8231], [8234, MAXC]];

function normalize(ranges) {
  const r = ranges.map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const x of r) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1] + 1) last[1] = Math.max(last[1], x[1]);
    else out.push(x);
  }
  return out;
}
export function complement(ranges) {
  const out = [];
  let lo = 0;
  for (const [a, b] of normalize(ranges)) {
    if (a > lo) out.push([lo, a - 1]);
    lo = b + 1;
  }
  if (lo <= MAXC) out.push([lo, MAXC]);
  return out;
}
function foldCase(ranges) {
  const extra = [];
  for (const [a, b] of ranges) {
    for (let c = Math.max(a, 65); c <= Math.min(b, 90); c++) extra.push([c + 32, c + 32]);
    for (let c = Math.max(a, 97); c <= Math.min(b, 122); c++) extra.push([c - 32, c - 32]);
  }
  return normalize([...ranges, ...extra]);
}
// i bayrağında ASCII dışı harflerin büyük/küçük eşlemesi modellenmiyor
const hasNonAsciiLetter = (ranges) => ranges.some(([a, b]) => b > 127 && (a > 127 || b > 127) && !(a === 0 && b === MAXC));

class Unsupported extends Error {}

/** Desen → AST: {t:'chr', r:ranges} | {t:'cat', a:[]} | {t:'alt', a:[]} | {t:'rep', e, min, max} */
export function parseRegex(src, flags = '') {
  if (/[gyu]/.test(flags)) return null;
  const icase = flags.includes('i');
  const dotAll = flags.includes('s');
  let i = 0;
  const peek = () => src[i];
  const eat = (c) => { if (src[i] === c) { i++; return true; } return false; };

  const escapeRanges = (c, inClass) => {
    if (RANGES[c]) return RANGES[c];
    if (RANGES[c.toLowerCase()] && c !== c.toLowerCase()) return complement(RANGES[c.toLowerCase()]);
    const simple = { n: 10, r: 13, t: 9, v: 11, f: 12, 0: 0 };
    if (c in simple) return [[simple[c], simple[c]]];
    if (c === 'x') { const h = src.slice(i, i + 2); if (!/^[0-9a-f]{2}$/i.test(h)) throw new Unsupported(); i += 2; const v = parseInt(h, 16); return [[v, v]]; }
    if (c === 'u') { const h = src.slice(i, i + 4); if (!/^[0-9a-f]{4}$/i.test(h)) throw new Unsupported(); i += 4; const v = parseInt(h, 16); return [[v, v]]; }
    if (c === 'b' && inClass) return [[8, 8]];
    if (/[1-9bBkpPc]/.test(c)) throw new Unsupported();
    const v = c.charCodeAt(0);
    return [[v, v]];
  };

  const parseClass = () => {
    const neg = eat('^');
    const ranges = [];
    // JS'te [] boş sınıftır; ilk ']' sınıfı kapatır
    while (i < src.length && peek() !== ']') {
      let lo;
      let c = src[i++];
      if (c === '\\') {
        const r = escapeRanges(src[i++], true);
        if (r.length !== 1 || r[0][0] !== r[0][1]) { ranges.push(...r); continue; }
        lo = r[0][0];
      } else lo = c.charCodeAt(0);
      if (peek() === '-' && src[i + 1] !== ']' && i + 1 < src.length) {
        i++;
        c = src[i++];
        let hi;
        if (c === '\\') {
          const r = escapeRanges(src[i++], true);
          if (r.length !== 1 || r[0][0] !== r[0][1]) throw new Unsupported();
          hi = r[0][0];
        } else hi = c.charCodeAt(0);
        if (hi < lo) throw new Unsupported();
        ranges.push([lo, hi]);
      } else ranges.push([lo, lo]);
    }
    if (!eat(']')) throw new Unsupported();
    let r = normalize(ranges);
    if (icase) { if (hasNonAsciiLetter(r)) throw new Unsupported(); r = foldCase(r); }
    return neg ? complement(r) : r;
  };

  const atom = () => {
    const c = src[i++];
    if (c === '(') {
      if (src[i] === '?') {
        if (src[i + 1] === ':') i += 2;
        else if (src[i + 1] === '<' && src[i + 2] !== '=' && src[i + 2] !== '!') { const e = src.indexOf('>', i); if (e < 0) throw new Unsupported(); i = e + 1; }
        else throw new Unsupported(); // lookaround
      }
      const e = alt();
      if (!eat(')')) throw new Unsupported();
      return e;
    }
    if (c === '[') return { t: 'chr', r: parseClass() };
    if (c === '.') return { t: 'chr', r: dotAll ? [[0, MAXC]] : DOT };
    if (c === '\\') {
      let r = normalize(escapeRanges(src[i++], false));
      if (icase) { if (hasNonAsciiLetter(r)) throw new Unsupported(); r = foldCase(r); }
      return { t: 'chr', r };
    }
    if (c === '^' || c === '$') throw new Unsupported(); // yalnızca baş/son çapası destekleniyor (aşağıda ayıklanır)
    if (c === ')' || c === '|' || c === '*' || c === '+' || c === '?') throw new Unsupported();
    const v = c.charCodeAt(0);
    let r = [[v, v]];
    if (icase) { if (v > 127 && c.toLowerCase() !== c.toUpperCase()) throw new Unsupported(); r = foldCase(r); }
    return { t: 'chr', r };
  };

  const quant = (e) => {
    for (;;) {
      let min;
      let max;
      if (eat('*')) { min = 0; max = Infinity; }
      else if (eat('+')) { min = 1; max = Infinity; }
      else if (eat('?')) { min = 0; max = 1; }
      else if (peek() === '{' && /^\{\d+(,\d*)?\}/.test(src.slice(i))) {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
        i += m[0].length;
        min = Number(m[1]);
        max = m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : min;
        if (max < min || min > 50 || (max !== Infinity && max > 50)) throw new Unsupported();
      } else return e;
      eat('?'); // tembel niceleyici: test() için aynı dil
      e = { t: 'rep', e, min, max };
    }
  };

  const seq = () => {
    const a = [];
    while (i < src.length && peek() !== '|' && peek() !== ')') a.push(quant(atom()));
    return a.length === 1 ? a[0] : { t: 'cat', a };
  };
  const alt = () => {
    const a = [seq()];
    while (eat('|')) a.push(seq());
    return a.length === 1 ? a[0] : { t: 'alt', a };
  };

  try {
    let body = src;
    const start = body.startsWith('^');
    // sondaki $ kaçışlı değilse çapa
    const end = body.endsWith('$') && !/(^|[^\\])(\\\\)*\\\$$/.test(body);
    if (flags.includes('m') && (start || end)) return null;
    if (start) body = body.slice(1);
    if (end) body = body.slice(0, -1);
    if (/(^|[^\\])(\\\\)*[$^]/.test(body.replace(/\[(\\.|[^\]])*\]/g, ''))) return null; // içeride çapa
    src = body;
    i = 0;
    const ast = src.length ? alt() : { t: 'cat', a: [] };
    if (i !== src.length) return null;
    return { ast, start, end };
  } catch (e) {
    if (e instanceof Unsupported) return null;
    throw e;
  }
}

/** Thompson NFA: states[i] = { eps: [j], edges: [{ r, to }] }, start, accept */
export function toNfa(parsed, maxStates = 2000) {
  const states = [];
  const ns = () => { states.push({ eps: [], edges: [] }); if (states.length > maxStates) throw new Unsupported(); return states.length - 1; };
  const build = (e) => {
    if (e.t === 'chr') { const s = ns(); const f = ns(); states[s].edges.push({ r: e.r, to: f }); return [s, f]; }
    if (e.t === 'cat') {
      const s = ns();
      let cur = s;
      for (const x of e.a) { const [a, b] = build(x); states[cur].eps.push(a); cur = b; }
      return [s, cur];
    }
    if (e.t === 'alt') {
      const s = ns(); const f = ns();
      for (const x of e.a) { const [a, b] = build(x); states[s].eps.push(a); states[b].eps.push(f); }
      return [s, f];
    }
    // rep
    const s = ns();
    let cur = s;
    for (let k = 0; k < e.min; k++) { const [a, b] = build(e.e); states[cur].eps.push(a); cur = b; }
    if (e.max === Infinity) {
      const [a, b] = build(e.e);
      states[cur].eps.push(a);
      states[b].eps.push(a);
      const f = ns();
      states[cur].eps.push(f);
      states[b].eps.push(f);
      return [s, f];
    }
    const f = ns();
    for (let k = e.min; k < e.max; k++) {
      states[cur].eps.push(f);
      const [a, b] = build(e.e);
      states[cur].eps.push(a);
      cur = b;
    }
    states[cur].eps.push(f);
    return [s, f];
  };
  try {
    const [start, accept] = build(parsed.ast);
    // ε-kapanışları önceden hesapla
    for (const st of states) st.closure = null;
    const closure = (q) => {
      if (states[q].closure) return states[q].closure;
      const seen = new Set([q]);
      const stack = [q];
      while (stack.length) for (const x of states[stack.pop()].eps) if (!seen.has(x)) { seen.add(x); stack.push(x); }
      return (states[q].closure = [...seen]);
    };
    states.forEach((_, q) => closure(q));
    return { states, start, accept, anchoredStart: parsed.start, anchoredEnd: parsed.end };
  } catch (e) {
    if (e instanceof Unsupported) return null;
    throw e;
  }
}

/** Somut NFA eşlemesi (yalnızca NFA kurgusunu RegExp'e karşı sınamak için) */
export function nfaTest(nfa, s) {
  const { states, start, accept } = nfa;
  const inR = (r, c) => r.some(([a, b]) => c >= a && c <= b);
  let cur = new Set(states[start].closure);
  if (cur.has(accept) && !nfa.anchoredEnd) return true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const next = new Set();
    for (const q of cur) for (const e of states[q].edges) if (inR(e.r, c)) for (const x of states[e.to].closure) next.add(x);
    if (!nfa.anchoredStart) for (const x of states[start].closure) next.add(x);
    cur = next;
    if (cur.has(accept) && (!nfa.anchoredEnd || i === s.length - 1)) return true;
  }
  return cur.has(accept) && s.length === 0;
}

// ── regex sentezi (E591) ───────────────────────────────
// Olumlu örneklerin hepsini kabul eden, olumsuzların hiçbirini kabul etmeyen en özgül deseni arar.
// Aday aileleri özgülden genele sıralanır; her aday gerçek RegExp ile doğrulanır.
const esc = (s) => s.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
const CLASSES = [
  ['\\d', /^[0-9]$/], ['[a-z]', /^[a-z]$/], ['[A-Z]', /^[A-Z]$/], ['[a-f0-9]', /^[a-f0-9]$/],
  ['[A-Za-z]', /^[A-Za-z]$/], ['[A-Za-z0-9]', /^[A-Za-z0-9]$/], ['\\w', /^\w$/], ['[^\\s]', /^\S$/], ['.', /^.$/],
];
const classOf = (chars) => {
  const set = [...new Set(chars)];
  if (set.length === 1) return esc(set[0]);
  if (set.length <= 3) return `[${set.map(esc).join('')}]`;
  return CLASSES.find(([, re]) => set.every((c) => re.test(c)))?.[0] ?? '[\\s\\S]';
};
// karakter sınıfı ailesi (aynı uzunluk koşulu olmadan)
const familyOf = (c) => CLASSES.find(([, re]) => re.test(c))?.[0] ?? '[\\s\\S]';

function runs(s) {
  // ardışık aynı aileden karakterleri grupla: "ab12" → [[a-z],2],[\d,2]
  const out = [];
  for (const ch of s) {
    const f = familyOf(ch);
    const last = out[out.length - 1];
    if (last && last.f === f) { last.n++; last.chars.push(ch); } else out.push({ f, n: 1, chars: [ch] });
  }
  return out;
}

export function synthesizeRegex(pos, neg = []) {
  if (!pos.length) return null;
  const ok = (src) => {
    let re;
    try { re = new RegExp(`^(?:${src})$`); } catch { return false; }
    return pos.every((s) => re.test(s)) && !neg.some((s) => re.test(s));
  };
  const candidates = [];
  const uniq = [...new Set(pos)];
  // 1) ortak önek/sonek + orta kısım
  const prefix = uniq.reduce((p, s) => { let k = 0; while (k < p.length && p[k] === s[k]) k++; return p.slice(0, k); });
  const suffix = uniq.map((s) => s.slice(prefix.length)).reduce((p, s) => { let k = 0; while (k < p.length && k < s.length && p[p.length - 1 - k] === s[s.length - 1 - k]) k++; return p.slice(p.length - k); });
  const mids = uniq.map((s) => s.slice(prefix.length, s.length - suffix.length));
  // 2) konum başına sınıf (eşit uzunluk)
  if (uniq.every((s) => s.length === uniq[0].length)) {
    let src = '';
    for (let k = 0; k < uniq[0].length; k++) src += classOf(uniq.map((s) => s[k]));
    candidates.push(src.replace(/(\\d|\[[^\]]+\]|\\w|\.)\1+/g, (m, c) => `${c}{${m.length / c.length}}`));
  }
  // 3) aile koşuları: her örnek aynı aile dizisine sahipse uzunluk aralıklı niceleyici
  const shapes = uniq.map(runs);
  if (shapes.every((r) => r.length === shapes[0].length && r.every((x, k) => x.f === shapes[0][k].f))) {
    candidates.push(shapes[0].map((x, k) => {
      const ns = shapes.map((r) => r[k].n);
      const lo = Math.min(...ns);
      const hi = Math.max(...ns);
      const cls = classOf(shapes.flatMap((r) => r[k].chars));
      return `${cls}${lo === hi ? (lo === 1 ? '' : `{${lo}}`) : `{${lo},${hi}}`}`;
    }).join(''));
  }
  // 4) önek/sonek + orta aile
  const midFam = classOf(mids.join('').split(''));
  const ml = mids.map((m) => m.length);
  if (mids.some((m) => m.length)) candidates.push(`${esc(prefix)}${midFam}{${Math.min(...ml)},${Math.max(...ml)}}${esc(suffix)}`);
  candidates.push(`${esc(prefix)}${midFam}*${esc(suffix)}`);
  // 5) son çare: sonlu birleşim (her zaman doğru, en özgül)
  const alternation = uniq.map(esc).join('|');
  const pick = candidates.find(ok);
  if (pick) return { source: `^${pick}$`, exact: false };
  return ok(alternation) ? { source: `^(?:${alternation})$`, exact: true } : null;
}
