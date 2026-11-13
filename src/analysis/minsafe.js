import * as t from '@babel/types';
import { traverse } from '../util/ast.js';

// E570: çıktının bir minifier'dan (terser/esbuild) davranışı değişmeden geçip geçemeyeceği.
// Kodun kendi metnine, adlarına ya da parametre sayısına bakan yapılar ad kısaltma/parametre atma ile bozulur.
// Sonuç: tehlike listesi ve bu tehlikeleri etkisizleştiren minifier seçenekleri (terser adlarıyla).

const MAX = 50;
const memberName = (n) => (!n.computed && t.isIdentifier(n.property) ? n.property.name : t.isStringLiteral(n.property) ? n.property.value : null);

function isFunctionValue(path, node) {
  if (t.isFunction(node) || t.isClass(node)) return true;
  if (!t.isIdentifier(node)) return false;
  const b = path.scope.getBinding(node.name);
  if (!b) return false;
  const n = b.path.node;
  return t.isFunctionDeclaration(n) || t.isClassDeclaration(n) || (t.isVariableDeclarator(n) && (t.isFunction(n.init) || t.isClass(n.init)));
}

export function minifierSafety(ast) {
  const hazards = [];
  const add = (kind, p, detail) => { if (hazards.length < MAX) hazards.push({ kind, line: p.node.loc?.start.line ?? null, detail }); };
  const options = {};
  const dotProps = new Map();
  const stringProps = new Map();
  const isScript = ast.program.sourceType !== 'module';
  const topNames = new Set();

  traverse(ast, {
    Program(p) {
      if (!isScript) return;
      for (const [name, b] of Object.entries(p.scope.bindings)) if (b.kind === 'var' || b.kind === 'hoisted') topNames.add(name);
    },
    CallExpression(p) {
      const c = p.node.callee;
      if (t.isMemberExpression(c) && memberName(c) === 'toString' && isFunctionValue(p, c.object)) {
        add('fn-source', p, 'fonksiyon kaynağı okunuyor (toString)');
        options.compress = false;
      }
      if (t.isMemberExpression(c) && memberName(c) === 'call' && t.isMemberExpression(c.object) && memberName(c.object) === 'toString' &&
        t.isMemberExpression(c.object.object) && memberName(c.object.object) === 'prototype' && t.isIdentifier(c.object.object.object, { name: 'Function' })) {
        add('fn-source', p, 'Function.prototype.toString.call');
        options.compress = false;
      }
      if (t.isIdentifier(c, { name: 'String' }) && p.node.arguments[0] && isFunctionValue(p, p.node.arguments[0])) {
        add('fn-source', p, 'String(fonksiyon)');
        options.compress = false;
      }
      if (t.isIdentifier(c, { name: 'eval' }) && !p.scope.getBinding('eval')) {
        add('dynamic-scope', p, 'direct eval: yerel adlar kısaltılamaz');
        options.mangle = false;
      }
      if (t.isIdentifier(c, { name: 'Function' }) && !p.scope.getBinding('Function')) add('function-ctor', p, 'new Function gövdesi yalnızca global adları görür');
    },
    NewExpression(p) {
      if (t.isIdentifier(p.node.callee, { name: 'Function' }) && !p.scope.getBinding('Function')) add('function-ctor', p, 'new Function gövdesi yalnızca global adları görür');
    },
    WithStatement(p) {
      add('dynamic-scope', p, 'with: ad çözümü çalışma anında');
      options.mangle = false;
    },
    BinaryExpression(p) {
      if (p.node.operator === '+' && [p.node.left, p.node.right].some((x) => isFunctionValue(p, x)) && [p.node.left, p.node.right].some((x) => t.isStringLiteral(x))) {
        add('fn-source', p, 'fonksiyon string\'e çevriliyor');
        options.compress = false;
      }
      if (p.node.operator === 'in' && t.isStringLiteral(p.node.left)) stringProps.set(p.node.left.value, p.node.loc?.start.line ?? null);
    },
    MemberExpression(p) {
      const name = memberName(p.node);
      if (name === null) return;
      if (name === 'name' && (isFunctionValue(p, p.node.object) || (t.isMemberExpression(p.node.object) && memberName(p.node.object) === 'constructor'))) {
        add('fn-name', p, 'fonksiyon/sınıf adı okunuyor');
        options.keep_fnames = true;
        options.keep_classnames = true;
      }
      if (name === 'length' && isFunctionValue(p, p.node.object)) {
        add('fn-length', p, 'parametre sayısı okunuyor (kullanılmayan parametreler atılmamalı)');
        options.keep_fargs = true;
      }
      if (p.node.computed && t.isStringLiteral(p.node.property)) stringProps.set(name, p.node.loc?.start.line ?? null);
      else if (!p.node.computed) dotProps.set(name, p.node.loc?.start.line ?? null);
      if (isScript && (t.isIdentifier(p.node.object, { name: 'window' }) || t.isIdentifier(p.node.object, { name: 'globalThis' }) || t.isIdentifier(p.node.object, { name: 'self' })) &&
        !p.scope.getBinding(p.node.object.name) && topNames.has(name)) {
        add('global-alias', p, `üst seviye "${name}" global nesne üzerinden okunuyor`);
        options.toplevel = false;
      }
    },
    ObjectProperty(p) { if (t.isStringLiteral(p.node.key)) stringProps.set(p.node.key.value, p.node.loc?.start.line ?? null); },
  });
  // özellik kısaltma (mangle.properties): aynı ad hem noktayla hem string ile kullanılıyorsa güvensiz
  const mixed = [...dotProps.keys()].filter((k) => stringProps.has(k));
  if (mixed.length) {
    options.mangleProperties = false;
    for (const k of mixed.slice(0, 10)) if (hazards.length < MAX) hazards.push({ kind: 'property-mix', line: stringProps.get(k), detail: `"${k}" hem .${k} hem ["${k}"] ile erişiliyor` });
  }
  const kinds = [...new Set(hazards.map((h) => h.kind))];
  return { safe: hazards.length === 0, kinds, hazards, options };
}
