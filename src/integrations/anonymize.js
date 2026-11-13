import * as t from '@babel/types';
import { parse } from '../core/parse.js';
import { raw } from '../core/emit.js';
import { traverse } from '../util/ast.js';

// J197: anonimleştirilmiş fixture katkısı. Girdideki açık metin göstergeler (URL, alan adı, e-posta, IP,
// anahtar/token) belgelenmiş örnek değerlerle değiştirilir (RFC 2606 / RFC 5737), yorumlar silinir.
// Kodlanmış (base64, RC4...) string'lerin içi statik olarak görülemez: bunun için çözülmüş çıktı da
// taranır ve orada kalan göstergeler "sızıntı" olarak raporlanır; o durumda katkı gönderilmemelidir.
// Hiçbir şey otomatik gönderilmez: sonuç dosya olarak indirilir ya da kullanıcı isterse issue sayfası açılır.

const REPO_ISSUES = 'https://github.com/LLCForge/Peel-JS/issues/new';
const MAX_ISSUE_URL = 7000;

const PATTERNS = [
  ['jwt', /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, () => 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJwZWVsIn0.c2ln'],
  ['secret', /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAIza[\w-]{30,}\b/g, (_, i) => `PEEL_SECRET_${i}`],
  ['url', /\b(?:https?|wss?):\/\/[^\s"'`<>\\]+/gi, (m, i) => `${m.split(':')[0].toLowerCase()}://example.com/path${i}`],
  ['email', /\b[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+\b/g, (_, i) => `user${i}@example.com`],
  ['ipv4', /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, (_, i) => `192.0.2.${(i % 254) + 1}`],
  ['domain', /\b(?:[a-z0-9-]{1,63}\.)+(?:com|net|org|io|dev|app|co|ru|cn|xyz|top|info|biz|tr|de|uk|me|ai|cloud|site|online|store)\b/gi, (_, i) => `host${i}.example`],
  ['wallet', /\b(?:bc1[ac-hj-np-z02-9]{25,59}|0x[a-fA-F0-9]{40})\b/g, () => '0x0000000000000000000000000000000000000000'],
];

/** Bir metindeki göstergeleri tutarlı biçimde (aynı değer -> aynı yer tutucu) değiştirir. */
function scrubText(text, maps, counts) {
  let s = text;
  for (const [kind, re, make] of PATTERNS) {
    const map = (maps[kind] ??= new Map());
    s = s.replace(re, (m) => {
      if (/example\.(com|org|net)|\.example\b|^192\.0\.2\./i.test(m)) return m; // zaten anonim
      if (!map.has(m)) map.set(m, make(m, map.size + 1));
      counts[kind] = (counts[kind] ?? 0) + 1;
      return map.get(m);
    });
  }
  return s;
}

export function findIndicators(text) {
  const out = [];
  for (const [kind, re] of PATTERNS) {
    for (const m of text.match(re) ?? []) {
      if (/example\.(com|org|net)|\.example\b|^192\.0\.2\./i.test(m)) continue;
      out.push({ kind, value: m });
    }
  }
  return out;
}

/**
 * @param {string} input   katkı yapılacak obfuscated kod
 * @param {{output?: string}} [o]  aynı girdinin çözülmüş hali (kodlanmış göstergeleri yakalamak için)
 * @returns {{code: string, replaced: Record<string, number>, leaks: Array<{kind: string, value: string}>}}
 */
export function anonymize(input, { output = '' } = {}) {
  const maps = {};
  const counts = {};
  let code;
  try {
    const ast = parse(input);
    traverse(ast, {
      StringLiteral(p) {
        const v = scrubText(p.node.value, maps, counts);
        if (v !== p.node.value) p.replaceWith(t.stringLiteral(v));
        p.skip();
      },
      TemplateElement(p) {
        const v = scrubText(p.node.value.raw, maps, counts);
        if (v !== p.node.value.raw) p.node.value = { raw: v, cooked: v };
      },
    });
    t.removeComments(ast);
    traverse(ast, { enter(p) { t.removeComments(p.node); } });
    code = raw(ast);
  } catch {
    // parse edilemeyen girdi (ör. JSFuck parçası): düz metin üzerinde değiştir
    code = scrubText(input, maps, counts);
  }
  const leaks = output ? findIndicators(output).filter((x) => !input.includes(x.value)) : [];
  return { code, replaced: counts, leaks };
}

/** test/fixtures biçiminde dosya metni (bkz. test/run.js yönergeleri). */
export function buildFixture({ code, expect = [], gone = [], level = 4, note = '' }) {
  const head = [];
  if (note) head.push(`// ${note.replace(/\n/g, ' ')}`);
  for (const e of expect) head.push(`// EXPECT: ${e}`);
  for (const g of gone) head.push(`// GONE: ${g}`);
  if (level !== 4) head.push(`// LEVEL: ${level}`);
  if (!expect.length && !gone.length) head.push('// SKIP: katkı: beklenti henüz yazılmadı');
  return `${head.join('\n')}\n${code}\n`;
}

/** Kullanıcı tıklarsa açılacak, önceden doldurulmuş issue adresi. Uzunsa null: dosya elle eklenmeli. */
export function issueUrl({ title, fixture, summary = '' }) {
  const body = `${summary}\n\n<details><summary>fixture</summary>\n\n\`\`\`js\n${fixture}\n\`\`\`\n</details>\n\n_PEEL anonimleştirme ile hazırlandı._`;
  const u = `${REPO_ISSUES}?labels=fixture&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  return u.length <= MAX_ISSUE_URL ? u : null;
}
