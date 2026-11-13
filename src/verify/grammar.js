// E740: gramer tabanlı fuzz üreteci — tohumlu PRNG ile yapılandırılmış değerler (sayı, string, JSON, URL, çerez,
// depolama, HTTP yanıt gövdesi) ve fonksiyon argümanları. Aynı tohum aynı diziyi üretir (yeniden üretilebilir hata).

export function rng(seed = 1) {
  let a = seed >>> 0 || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  };
}

// Gramer: kural → alternatifler; alternatif string ise sabit, fonksiyon ise üretici. "<kural>" başka kurala başvurur.
export const GRAMMAR = {
  int: [() => 0, () => 1, () => -1, (r) => r.int(-1000, 1000), () => 2147483647, () => -2147483648, () => 4294967295, (r) => r.int(0, 255)],
  number: ['<int>', () => 0.5, () => -0, () => NaN, () => Infinity, () => 1e21, () => Number.MAX_SAFE_INTEGER, (r) => r.next() * 1e6],
  char: [(r) => String.fromCharCode(r.int(97, 122)), (r) => String.fromCharCode(r.int(48, 57)), () => ' ', () => '"', () => '\\', () => 'ğ', () => '\u{1F600}', () => '\u0000', () => '<', () => '%'],
  string: [() => '', (r) => Array.from({ length: r.int(1, 12) }, () => expand('<char>', r)).join(''), () => 'admin', () => 'null', () => '0', () => '__proto__', () => 'constructor', '<url>', '<json>'],
  url: [(r) => `https://${r.pick(['example.com', 'evil.test', 'cdn.test', 'localhost'])}/${expand('<path>', r)}`, () => '/relative/path', () => 'javascript:void(0)', () => 'data:text/plain,hi'],
  path: [(r) => `${r.pick(['api', 'collect', 'p', ''])}${r.chance(0.5) ? `?q=${r.int(0, 99)}` : ''}`],
  json: [(r) => JSON.stringify(expand('<jvalue>', r))],
  jvalue: ['<int>', '<string>', () => null, () => true, () => false, (r) => (r.depth < 3 ? Array.from({ length: r.int(0, 3) }, () => expand('<jvalue>', r)) : []),
    (r) => (r.depth < 3 ? Object.fromEntries(Array.from({ length: r.int(0, 3) }, () => [expand('<key>', r), expand('<jvalue>', r)])) : {})],
  key: [() => 'id', () => 'token', () => 'data', () => 'cmd', () => 'url', (r) => `k${r.int(0, 9)}`],
  value: ['<int>', '<number>', '<string>', () => null, () => undefined, () => true, '<array>', '<object>'],
  array: [(r) => (r.depth < 3 ? Array.from({ length: r.int(0, 4) }, () => expand('<value>', r)) : [])],
  object: [(r) => (r.depth < 3 ? Object.fromEntries(Array.from({ length: r.int(0, 3) }, () => [expand('<key>', r), expand('<value>', r)])) : {})],
  cookie: [() => '', (r) => Array.from({ length: r.int(1, 3) }, () => `${expand('<key>', r)}=${encodeURIComponent(expand('<string>', r))}`).join('; ')],
  body: ['<json>', () => '', () => '<html><body>ok</body></html>', () => 'console.log("yük")', () => '{"cmd":"run","url":"https://evil.test/x"}', '<string>'],
};

export function expand(sym, r) {
  const name = sym.slice(1, -1);
  const alts = GRAMMAR[name];
  if (!alts) throw new Error(`gramer kuralı yok: ${name}`);
  r.depth = (r.depth ?? 0) + 1;
  try {
    const alt = r.pick(alts);
    if (typeof alt === 'function') return alt(r);
    return alt.startsWith('<') ? expand(alt, r) : alt;
  } finally {
    r.depth--;
  }
}

// fonksiyon argüman vektörleri (arity kadar)
export function argVectors(arity, count, seed = 1, rule = '<value>') {
  const r = rng(seed);
  return Array.from({ length: count }, () => Array.from({ length: arity }, () => expand(rule, r)));
}

// sandbox ortamı: zaman, tohum, profil, çerez, depolama, sahte yanıtlar
export function environment(r, profiles = ['default', 'chrome-win', 'firefox-linux', 'safari-iphone', 'headless-bot']) {
  return {
    now: r.pick([1700000000000, 0, 946684800000, 4102444800000, r.int(0, 2e12)]),
    seed: r.int(1, 0x7fffffff),
    profile: r.pick(profiles),
    cookie: expand('<cookie>', r),
    storage: Object.fromEntries(Array.from({ length: r.int(0, 3) }, () => [expand('<key>', r), String(expand('<string>', r))])),
    responses: r.chance(0.6) ? [{ match: r.pick(['/', 'api', 'collect', 'http']), status: r.pick([200, 200, 404, 500]), body: String(expand('<body>', r)) }] : [],
  };
}

// argümanı sandbox ifadesine çevirir (JSON'un ifade edemediği değerler dahil)
export function toSource(v) {
  if (v === undefined) return 'undefined';
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : Number.isNaN(v) ? 'NaN' : v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : String(v);
  if (Array.isArray(v)) return `[${v.map(toSource).join(', ')}]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `[${JSON.stringify(k)}]: ${toSource(x)}`).join(', ')} }`;
  return JSON.stringify(v);
}
