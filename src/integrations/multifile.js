import * as t from '@babel/types';
import { parse } from '../core/parse.js';
import { raw, pretty } from '../core/emit.js';
import { traverse } from '../util/ast.js';

// G153: çoklu dosya sembol eşleme. Aynı sayfaya yüklenen script'ler global kapsamı paylaşır:
// bir dosyada tanımlanan (üst seviye var/function/class, window.X = ...) sembol başka dosyada kullanılır.
// Sonuç: sembol -> tanımlandığı/kullanıldığı dosyalar, dosyalar arası bağımlılık kenarları ve
// tüm dosyalarda tutarlı yeniden adlandırma.

const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self', 'top', 'parent', 'frames']);

function globalMember(node) {
  return t.isMemberExpression(node) && t.isIdentifier(node.object) && GLOBAL_OBJECTS.has(node.object.name) &&
    (!node.computed ? t.isIdentifier(node.property) : t.isStringLiteral(node.property));
}
const memberKey = (node) => (node.computed ? node.property.value : node.property.name);

function scanFile(name, code) {
  const ast = parse(code);
  const defs = [];
  const uses = [];
  const imports = [];
  const add = (arr, sym, node, kind) => arr.push({ name: sym, file: name, line: node.loc?.start.line ?? 0, kind });
  traverse(ast, {
    Program(p) {
      for (const [sym, b] of Object.entries(p.scope.bindings)) {
        if (b.kind === 'module') continue;
        add(defs, sym, b.identifier, b.kind);
      }
    },
    ExportNamedDeclaration(p) {
      for (const s of p.node.specifiers) if (t.isIdentifier(s.exported)) add(defs, s.exported.name, s, 'export');
    },
    ImportDeclaration(p) {
      imports.push({ from: p.node.source.value, names: p.node.specifiers.map((s) => (t.isImportSpecifier(s) ? (t.isIdentifier(s.imported) ? s.imported.name : s.imported.value) : 'default')) });
    },
    AssignmentExpression(p) {
      if (globalMember(p.node.left)) add(defs, memberKey(p.node.left), p.node.left, 'global-assign');
    },
    MemberExpression(p) {
      if (globalMember(p.node) && !(t.isAssignmentExpression(p.parent) && p.parent.left === p.node)) add(uses, memberKey(p.node), p.node, 'global-read');
    },
    ReferencedIdentifier(p) {
      const n = p.node.name;
      if (GLOBAL_OBJECTS.has(n) || p.scope.getBinding(n)) return;
      add(uses, n, p.node, 'free');
    },
  });
  return { ast, defs, uses, imports };
}

/**
 * @param {Array<{name: string, code: string}>} files
 */
export function symbolMap(files) {
  const scans = new Map();
  const errors = [];
  for (const f of files) {
    try {
      scans.set(f.name, scanFile(f.name, f.code));
    } catch (e) {
      errors.push({ file: f.name, error: e.message });
    }
  }
  const symbols = new Map();
  const sym = (n) => symbols.get(n) ?? symbols.set(n, { name: n, definedIn: [], usedIn: [] }).get(n);
  for (const s of scans.values()) {
    for (const d of s.defs) sym(d.name).definedIn.push({ file: d.file, line: d.line, kind: d.kind });
    for (const u of s.uses) sym(u.name).usedIn.push({ file: u.file, line: u.line });
  }
  // ES modül importları: göreli yolun dosya adı ile eşlenir
  const base = (p) => p.split(/[\\/]/).pop().replace(/\.(m|c)?js$/, '');
  for (const [file, s] of scans) {
    for (const im of s.imports) {
      const target = [...scans.keys()].find((k) => base(k) === base(im.from));
      if (!target) continue;
      for (const n of im.names) sym(n).usedIn.push({ file, line: 0, via: target });
    }
  }
  const edges = new Map();
  for (const s of symbols.values()) {
    const definers = new Set(s.definedIn.map((d) => d.file));
    for (const u of s.usedIn) {
      for (const d of definers) {
        if (d === u.file) continue;
        const key = `${u.file}\u0000${d}`;
        const e = edges.get(key) ?? edges.set(key, { from: u.file, to: d, symbols: new Set() }).get(key);
        e.symbols.add(s.name);
      }
    }
  }
  const list = [...symbols.values()];
  return {
    shared: list.filter((s) => new Set([...s.definedIn.map((d) => d.file), ...s.usedIn.map((u) => u.file)]).size > 1 && s.definedIn.length)
      .sort((a, b) => a.name.localeCompare(b.name)),
    conflicts: list.filter((s) => new Set(s.definedIn.map((d) => d.file)).size > 1),
    external: list.filter((s) => !s.definedIn.length).map((s) => s.name).sort(),
    edges: [...edges.values()].map((e) => ({ ...e, symbols: [...e.symbols].sort() })),
    errors,
  };
}

/**
 * Paylaşılan sembolleri tüm dosyalarda aynı şekilde yeniden adlandırır.
 * @param {Array<{name: string, code: string}>} files
 * @param {Record<string, string>} renames  eski -> yeni
 * @returns {Promise<Array<{name: string, code: string, renamed: number}>>}
 */
export async function renameAcross(files, renames) {
  const valid = /^[A-Za-z_$][\w$]*$/;
  for (const [a, b] of Object.entries(renames)) if (!valid.test(a) || !valid.test(b)) throw new Error(`Geçersiz ad: ${a} -> ${b}`);
  const out = [];
  for (const f of files) {
    const ast = parse(f.code);
    let renamed = 0;
    traverse(ast, {
      Program(p) {
        for (const [from, to] of Object.entries(renames)) {
          if (p.scope.bindings[from] && !p.scope.hasBinding(to)) { p.scope.rename(from, to); renamed++; }
        }
      },
      ReferencedIdentifier(p) {
        const to = renames[p.node.name];
        if (to && !p.scope.getBinding(p.node.name) && !p.scope.getBinding(to)) { p.node.name = to; renamed++; }
      },
      MemberExpression(p) {
        if (!globalMember(p.node)) return;
        const to = renames[memberKey(p.node)];
        if (!to) return;
        if (p.node.computed) p.node.property = t.stringLiteral(to);
        else p.node.property = t.identifier(to);
        renamed++;
      },
    });
    out.push({ name: f.name, code: renamed ? await pretty(raw(ast)) : f.code, renamed });
  }
  return out;
}
