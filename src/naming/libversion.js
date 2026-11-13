import * as t from '@babel/types';
import { traverse } from '../util/ast.js';

// 75: kütüphane sürümü tespiti. İmza tablosunun bulduğu kütüphaneler için sürüm;
// banner yorumları (/*! jQuery v3.7.1 */, @version), sürüm sabitleri (X.VERSION = "…", fn.jquery = "…",
// { version: "…" }) ve kütüphane adını taşıyan nesnelerin sürüm alanlarından okunur.

const SEMVER = /^v?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)$/;
const VERSION_KEYS = new Set(['VERSION', 'version', 'Version', 'jquery', 'fn_version']);

const pathOf = (n) => {
  if (t.isIdentifier(n)) return n.name;
  if (t.isThisExpression(n)) return 'this';
  if (t.isMemberExpression(n)) {
    const k = !n.computed && t.isIdentifier(n.property) ? n.property.name : t.isStringLiteral(n.property) ? n.property.value : null;
    const o = pathOf(n.object);
    return o && k ? `${o}.${k}` : (k ?? null);
  }
  return null;
};
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * @param {object} ast
 * @param {string[]} names  imza tablosunca bulunan kütüphane adları
 * @returns {{ name: string, version: string, source: string, line: number|null }[]}
 */
export function libraryVersions(ast, names) {
  const wanted = names.map((n) => ({ name: n, key: norm(n.split(/[\s/]/)[0]) }));
  const out = new Map();
  const put = (lib, version, source, line) => { if (!out.has(lib)) out.set(lib, { name: lib, version, source, line }); };
  const match = (text) => wanted.find((w) => w.key.length >= 2 && norm(text).includes(w.key));

  for (const c of ast.comments ?? []) {
    const m = /([A-Za-z][\w.-]{1,40})\s+v?(\d+\.\d+(?:\.\d+)?)\b/.exec(c.value) ?? null;
    const lib = match(c.value);
    if (m && lib && norm(c.value).includes(lib.key)) put(lib.name, m[2], 'yorum', c.loc?.start.line ?? null);
    const v = /@version\s+v?(\d+\.\d+(?:\.\d+)?)/.exec(c.value);
    if (v && lib) put(lib.name, v[1], 'yorum', c.loc?.start.line ?? null);
  }

  // bağlam: sürüm değerinin bulunduğu nesnenin/atamanın yolu ve en yakın kütüphane adı geçen bağlam
  const consider = (key, valueNode, contextText, line) => {
    if (!VERSION_KEYS.has(key) || !t.isStringLiteral(valueNode)) return;
    const m = SEMVER.exec(valueNode.value.trim());
    if (!m) return;
    const lib = (key === 'jquery' ? wanted.find((w) => w.key === 'jquery') : null) ?? match(contextText);
    if (lib) put(lib.name, m[1], 'sabit', line);
  };
  traverse(ast, {
    AssignmentExpression(p) {
      const l = p.node.left;
      if (!t.isMemberExpression(l)) return;
      const full = pathOf(l) ?? '';
      const key = full.split('.').pop();
      // bağlam metni: atanan yol + çevreleyen fonksiyon/değişken adları
      const ctx = [full, ...enclosingNames(p)].join(' ');
      consider(key, p.node.right, ctx, p.node.loc?.start.line ?? null);
    },
    ObjectProperty(p) {
      if (p.node.computed) return;
      const key = t.isIdentifier(p.node.key) ? p.node.key.name : t.isStringLiteral(p.node.key) ? p.node.key.value : null;
      if (!key) return;
      const ctx = enclosingNames(p).join(' ');
      consider(key, p.node.value, ctx, p.node.loc?.start.line ?? null);
    },
  });
  return [...out.values()];
}

// Düğümü kuşatan değişken/fonksiyon/özellik adları (kütüphane adını yakalamak için)
function enclosingNames(p) {
  const names = [];
  for (let x = p.parentPath; x && names.length < 8; x = x.parentPath) {
    const n = x.node;
    if (t.isVariableDeclarator(n) && t.isIdentifier(n.id)) names.push(n.id.name);
    else if ((t.isFunctionDeclaration(n) || t.isFunctionExpression(n) || t.isClassDeclaration(n)) && n.id) names.push(n.id.name);
    else if (t.isAssignmentExpression(n)) names.push(pathOf(n.left) ?? '');
    else if (t.isObjectProperty(n) && t.isIdentifier(n.key)) names.push(n.key.name);
    else if (t.isCallExpression(n) && t.isStringLiteral(n.arguments[0])) names.push(n.arguments[0].value);
  }
  return names;
}
