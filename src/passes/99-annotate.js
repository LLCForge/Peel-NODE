import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { createInferer } from '../naming/types.js';
import { summarizeFunction, facts } from '../naming/summary.js';

// 73: fonksiyon açıklama yorumları, 76: JSDoc tip açıklamaları, E238: bölüm başlıkları.
// Yalnızca yorum ekler (davranış değişmez). Kendi yorumları etiket biçimi / "── " ile tanınır ve her turda
// yeniden üretilir: çıktı tur sayısından bağımsız ve kararlıdır.
// Çıktıyı gereksiz büyütmez: gövdeden bilgi çıkmayan fonksiyona kalıp özet yazılmaz (yalnızca bilinen tipler),
// hiç bilgi yoksa açıklama hiç eklenmez; bölüm başlıkları boş deyimleri saymaz.

// kendi JSDoc'umuz yalnızca bizim ürettiğimiz etiket satırlarından oluşur (özetsiz biçim dahil)
const OWN_DOC = /^\*\s*\n(\s*\* @(summary|constructor|param|returns)\b[^\n]*\n)+\s*$/;
const OWN_HEADER = /^ ── .+ ──$/;
const isOwn = (c) => (c.type === 'CommentBlock' && OWN_DOC.test(c.value)) || (c.type === 'CommentLine' && OWN_HEADER.test(c.value));
const MIN_SECTION_STATEMENTS = 6;

// generic: özet kalıp cümle (gövdeden bilgi çıkmadı) → @summary yazılmaz; tip bilgisi de yoksa null (açıklama yok)
function jsdoc(summary, sig, kind, generic = false) {
  const lines = generic ? [] : [`@summary ${summary}`];
  if (kind) lines.push(kind);
  for (const p of sig.params) {
    const ty = p.type === 'unknown' ? '*' : p.type;
    lines.push(`@param {${p.optional ? `${ty}=` : ty}} ${p.name.replace(/^\.\.\./, '')}`);
  }
  if (sig.returns !== 'void' && kind !== '@constructor') lines.push(`@returns {${sig.returns === 'unknown' ? '*' : sig.returns}}`);
  if (generic && lines.every((l) => /^@(param|returns) \{\*=?\}/.test(l))) return null;
  // */ yorum içinde kapanışa dönüşmesin
  return `*\n${lines.map((l) => ` * ${l.replace(/\*\//g, '*\\/')}`).join('\n')}\n `;
}

const stripOwn = (node) => {
  if (node.leadingComments) node.leadingComments = node.leadingComments.filter((c) => !isOwn(c));
};

function attach(node, value) {
  stripOwn(node);
  if (value === null) return false;
  node.leadingComments = [...(node.leadingComments ?? []), { type: 'CommentBlock', value }];
  return true;
}

const CATS = {
  tr: { main: 'Ana akış', imports: 'İçe aktarmalar', classes: 'Sınıflar', consts: 'Sabitler ve durum', net: 'Ağ işlemleri', dom: 'Sayfa (DOM) işlemleri', storage: 'Depolama', codec: 'Kodlama ve şifreleme', helpers: 'Yardımcı fonksiyonlar', ctor: 'Kurucu fonksiyon', ctorM: 'Kurucu', cls: 'Sınıf; metotları' },
  en: { main: 'Main flow', imports: 'Imports', classes: 'Classes', consts: 'Constants and state', net: 'Network', dom: 'Page (DOM)', storage: 'Storage', codec: 'Encoding and crypto', helpers: 'Helper functions', ctor: 'Constructor function', ctorM: 'Constructor', cls: 'Class; methods' },
};
let C = CATS.tr;

// Üst düzey deyimin bölüm kategorisi
function category(st) {
  const s = t.isExportNamedDeclaration(st.node) || t.isExportDefaultDeclaration(st.node) ? st.get('declaration') : st;
  if (!s?.node) return C.main;
  if (s.isImportDeclaration()) return C.imports;
  if (s.isClassDeclaration()) return C.classes;
  if (s.isVariableDeclaration()) {
    const inits = s.node.declarations.map((d) => d.init);
    if (inits.every((i) => !i || t.isLiteral(i) || t.isArrayExpression(i) || t.isObjectExpression(i) || t.isUnaryExpression(i))) return C.consts;
    if (inits.some((i) => t.isFunction(i))) return fnCategory(s.get('declarations').find((d) => t.isFunction(d.node.init)).get('init'));
    // hesaplanan başlangıç değeri çalışan koddur: ayrı başlık ana akışı tek deyimlik bölümlere bölerdi
    return C.main;
  }
  if (s.isFunctionDeclaration()) return fnCategory(s);
  return C.main;
}

function fnCategory(fn) {
  const f = facts(fn);
  if (f.network.size) return C.net;
  if (f.domWrite || f.domRead || f.events.size) return C.dom;
  if (f.storage) return C.storage;
  if (f.decode || f.crypto) return C.codec;
  return C.helpers;
}

// Bölümler: [{ cat, start }] — boş deyimler (yazdırılmaz) sayılmaz ve bölümü bölmez: başlığı boş deyime
// konup bir sonraki başlıkla art arda basılmaz
export function sections(cats) {
  const runs = [];
  for (const [i, c] of cats.entries()) {
    if (c === null) continue;
    if (!runs.length || runs.at(-1).cat !== c) runs.push({ cat: c, start: i });
  }
  return runs;
}

export async function run(ast, { onLog, bump, naming = {} }) {
  if (naming.annotate === false) return;
  const lang = naming.lang === 'en' ? 'en' : 'tr';
  C = CATS[lang];
  const inf = createInferer();
  // önceki turların yorumları (silinen düğümlerden kardeşlere taşınmış olanlar dahil) temizlenir
  t.traverseFast(ast.program, (n) => {
    for (const k of ['leadingComments', 'trailingComments', 'innerComments']) {
      if (n[k]?.length) n[k] = n[k].filter((c) => !isOwn(c));
    }
  });
  let docs = 0;
  traverse(ast, {
    FunctionDeclaration(p) {
      const { text, sig, generic } = summarizeFunction(p, inf, lang);
      const ctor = isConstructor(p);
      if (attach(p.node, jsdoc(ctor ? `${C.ctor}: ${text}` : text, sig, ctor ? '@constructor' : null, generic && !ctor))) docs++;
    },
    VariableDeclaration(p) {
      if (p.node.declarations.length !== 1) return;
      const d = p.get('declarations.0');
      const init = d.get('init');
      if (!t.isIdentifier(d.node.id) || !(init.isFunctionExpression() || init.isArrowFunctionExpression())) return;
      if (!(p.parentPath.isProgram() || p.parentPath.isBlockStatement() || p.parentPath.isExportNamedDeclaration())) return;
      const { text, sig, generic } = summarizeFunction(init, inf, lang);
      if (attach(p.parentPath.isExportNamedDeclaration() ? p.parent : p.node, jsdoc(text, sig, null, generic))) docs++;
    },
    ClassMethod(p) {
      if (p.node.computed) return;
      const { text, sig, generic } = summarizeFunction(p, inf, lang);
      if (attach(p.node, jsdoc(p.node.kind === 'constructor' ? `${C.ctorM}: ${text}` : text, sig, null, generic))) docs++;
    },
    ClassDeclaration(p) {
      const methods = p.node.body.body.filter((m) => t.isClassMethod(m) && m.kind === 'method' && t.isIdentifier(m.key)).map((m) => m.key.name);
      // metotsuz sınıfın özeti yalnızca "Sınıf" olurdu: yazılmaz
      if (attach(p.node, methods.length ? `*\n * @summary ${C.cls}: ${methods.slice(0, 6).join(', ')}\n ` : null)) docs++;
    },
  });

  // E238: bölüm başlıkları (yeterince uzun programlarda, kategori değiştikçe)
  let headers = 0;
  traverse(ast, {
    Program(p) {
      const body = p.get('body');
      for (const st of body) {
        if (st.node.leadingComments) st.node.leadingComments = st.node.leadingComments.filter((c) => !(c.type === 'CommentLine' && OWN_HEADER.test(c.value)));
      }
      const cats = body.map((st) => (st.isEmptyStatement() ? null : category(st)));
      if (naming.sections === false || cats.filter(Boolean).length < MIN_SECTION_STATEMENTS) return p.stop();
      const secs = sections(cats);
      if (secs.length < 2) return p.stop();
      for (const s of secs) {
        const node = body[s.start].node;
        node.leadingComments = [{ type: 'CommentLine', value: ` ── ${s.cat} ──` }, ...(node.leadingComments ?? [])];
        headers++;
      }
      p.stop();
    },
  });
  if (docs || headers) onLog(`annotate: ${docs} açıklama, ${headers} bölüm başlığı`, 'info');
  bump('annotate', docs);
}

// this alanları kurup new ile çağrılan fonksiyon
function isConstructor(p) {
  const b = p.parentPath.scope.getBinding(p.node.id.name);
  return Boolean(b?.referencePaths.some((r) => r.parentPath.isNewExpression({ callee: r.node })));
}
