import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { remnants, lineOf } from '../ui/code-intel.js';

// 94: çözülemeyenler. Temel kalıntılar (_0x adları, hex argümanlı decoder çağrıları, eval/Function, fromCharCode)
// editör aramasıyla aynı tanımdan gelir (ui/code-intel.js remnants); burada rapor için satır/nedenle gruplanır ve
// tablo erişimi, kodlanmış/kaçışlı string, string zamanlayıcı, debugger, with ve VM işaretleri eklenir.

const MAX_ITEMS = 300;
const short = (n) => {
  const s = gen(n).replace(/\s+/g, ' ');
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
};
const REMNANT_KIND = {
  _0x: ['identifier', 'üretilmiş isim kaldı (yeniden adlandırma engellendi ya da dinamik kapsam)'],
  decoder: ['decoder', 'hex argümanlı çağrı çözülemedi'],
  eval: ['dynamic-code', 'çalışma anında kod çalıştırma (statik çözülemez)'],
  Function: ['dynamic-code', 'Function ile kod üretimi'],
  fromCharCode: ['encoded', 'karakter kodlarından çalışma anında string üretimi'],
};

/**
 * @param {object} ast
 * @param {string} code  ast'in kaynağı (satır numaraları için)
 */
export function unresolved(ast, code) {
  const items = [];
  const add = (line, kind, reason, text) => {
    if (items.length < MAX_ITEMS) items.push({ line, kind, reason, code: text });
  };
  const seenIds = new Set();
  for (const r of remnants(ast)) {
    const [kind, reason] = REMNANT_KIND[r.note] ?? ['other', r.note];
    if (kind === 'identifier') {
      if (seenIds.has(r.text)) continue;
      seenIds.add(r.text);
    }
    add(lineOf(code, r.start), kind, reason, r.text);
  }
  const at = (n) => n.loc?.start.line ?? null;
  traverse(ast, {
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      if (t.isIdentifier(callee) && /^(setTimeout|setInterval)$/.test(callee.name) && args[0] && !t.isFunction(args[0]) && !t.isIdentifier(args[0])) {
        add(at(p.node), 'dynamic-code', 'string ile zamanlayıcı', short(p.node));
      }
    },
    MemberExpression(p) {
      // string tablosu kalıntısı: tabloya hex indeksle erişim
      if (p.node.computed && t.isNumericLiteral(p.node.property) && /^0x/i.test(p.node.property.extra?.raw ?? '') && t.isIdentifier(p.node.object)) {
        add(at(p.node), 'table', 'string tablosuna indeksle erişim kaldı', short(p.node));
      }
    },
    StringLiteral(p) {
      const v = p.node.value;
      if (v.length >= 40 && /^[A-Za-z0-9+/]+={0,2}$/.test(v) && v.length % 4 === 0) add(at(p.node), 'encoded', 'base64 görünümlü uzun string', short(p.node));
      else if (/\\x[0-9a-f]{2}/i.test(p.node.extra?.raw ?? '') && v.length > 3) add(at(p.node), 'escaped', 'kaçışlı string literal', short(p.node));
    },
    DebuggerStatement(p) { add(at(p.node), 'anti-debug', 'debugger deyimi kaldı', 'debugger'); },
    WithStatement(p) { add(at(p.node), 'with', 'with bloğu: isimler dinamik çözülür', short(p.node.object)); },
  });
  for (const c of ast.comments ?? []) {
    if (/PEEL VM/.test(c.value)) add(c.loc?.start.line ?? null, 'vm', 'yorumlanan durum makinesi (VM) açılamadı', c.value.trim().slice(0, 80));
  }
  const counts = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  return { items: items.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)), counts };
}
