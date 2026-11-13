import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { parse } from '../core/parse.js';

// E237: yorum geri yükleme. Girdideki (metin katmanları açılmış) yorumlardan, dönüşümler sırasında kaybolanlar
// bağlı oldukları bildirim hâlâ aynı adla duruyorsa onun önüne geri konur. Dosya başı yorumları (lisans) başa döner.
// Bağlandığı kod silinmiş ya da adı değişmiş yorum geri getirilmez: artık yanlış yeri anlatır.

let cache = { source: null, comments: null };

function anchorOf(p) {
  const n = p.node;
  if (t.isExportNamedDeclaration(n) || t.isExportDefaultDeclaration(n)) return n.declaration ? anchorOf(p.get('declaration')) : null;
  if ((t.isFunctionDeclaration(n) || t.isClassDeclaration(n)) && n.id) return `decl:${n.id.name}`;
  if (t.isVariableDeclaration(n) && t.isIdentifier(n.declarations[0]?.id)) return `decl:${n.declarations[0].id.name}`;
  if ((t.isClassMethod(n) || t.isObjectMethod(n) || t.isObjectProperty(n)) && !n.computed && t.isIdentifier(n.key)) {
    const owner = p.findParent((x) => x.isClassDeclaration() || x.isVariableDeclarator());
    const base = owner?.isClassDeclaration() ? owner.node.id?.name : t.isIdentifier(owner?.node.id) ? owner.node.id.name : '';
    return `member:${base}.${n.key.name}`;
  }
  if (t.isExpressionStatement(n) && t.isAssignmentExpression(n.expression) && t.isMemberExpression(n.expression.left)) {
    const parts = [];
    for (let m = n.expression.left; t.isMemberExpression(m); m = m.object) {
      if (m.computed) return null;
      parts.unshift(m.property.name);
      if (t.isIdentifier(m.object)) parts.unshift(m.object.name);
    }
    return `assign:${parts.join('.')}`;
  }
  return null;
}

const ANCHORED = 'Statement|ClassMethod|ObjectMethod|ObjectProperty';

function sourceComments(source) {
  if (cache.source === source) return cache.comments;
  let ast;
  try { ast = parse(source); } catch { return []; }
  const out = [];
  const firstStart = ast.program.body[0]?.start ?? Infinity;
  for (const c of ast.comments ?? []) {
    if (c.end <= firstStart) out.push({ anchor: 'top', comment: c });
  }
  const counts = new Map();
  traverse(ast, {
    [ANCHORED](p) {
      if (!p.node.leadingComments?.length) return;
      const a = anchorOf(p);
      if (!a) return;
      counts.set(a, (counts.get(a) ?? 0) + 1);
      for (const c of p.node.leadingComments) if (c.start >= firstStart) out.push({ anchor: a, comment: c });
    },
  });
  // aynı çapa iki kez geçiyorsa hangisine ait olduğu belirsiz
  const res = out.filter((x) => x.anchor === 'top' || counts.get(x.anchor) === 1);
  cache = { source, comments: res };
  return res;
}

const norm = (c) => `${c.type}:${c.value.trim()}`;

export async function run(ast, { onLog, bump, source, naming = {} }) {
  if (naming.comments === false || !source) return;
  const wanted = sourceComments(source);
  if (!wanted.length) return;
  const present = new Set();
  t.traverseFast(ast.program, (n) => {
    for (const k of ['leadingComments', 'trailingComments', 'innerComments']) for (const c of n[k] ?? []) present.add(norm(c));
  });
  for (const c of ast.comments ?? []) present.add(norm(c));
  const missing = wanted.filter((w) => !present.has(norm(w.comment)));
  if (!missing.length) return;

  const targets = new Map();
  const dup = new Set();
  traverse(ast, {
    [ANCHORED](p) {
      const a = anchorOf(p);
      if (!a) return;
      if (targets.has(a)) dup.add(a); else targets.set(a, p.node);
    },
  });
  let n = 0;
  const top = ast.program.body[0];
  const restored = new Set();
  const topGroup = [];
  for (const { anchor, comment } of missing) {
    const key = norm(comment);
    if (restored.has(key)) continue;
    const node = anchor === 'top' ? top : (dup.has(anchor) ? null : targets.get(anchor));
    if (!node) continue;
    const c = { type: comment.type, value: comment.value };
    // dosya başı yorumları özgün sırasıyla en öne, diğerleri düğümün kendi yorumlarının ardına
    if (anchor === 'top') topGroup.push(c);
    else node.leadingComments = [...(node.leadingComments ?? []), c];
    restored.add(key);
    n++;
  }
  if (topGroup.length && top) top.leadingComments = [...topGroup, ...(top.leadingComments ?? [])];
  if (n) onLog(`comments: ${n} kaybolan yorum geri yüklendi`, 'info');
  bump('comments', n);
}
