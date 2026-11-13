import * as t from '@babel/types';
import { traverse } from '../util/ast.js';

// Okunabilirlik: 0x1f → 31, "\x48" → "H", a["b"] → a.b, {"k": v} → {k: v}, Function("return this")() → globalThis
export async function run(ast, { bump }) {
  let n = 0;
  traverse(ast, {
    NumericLiteral(p) {
      const raw = p.node.extra?.raw;
      if (raw !== undefined && raw !== String(p.node.value)) { delete p.node.extra; n++; }
    },
    StringLiteral(p) {
      const raw = p.node.extra?.raw;
      if (raw !== undefined && raw.includes('\\')) { delete p.node.extra; n++; }
    },
    'MemberExpression|OptionalMemberExpression'(p) {
      const { property } = p.node;
      if (p.node.computed && t.isStringLiteral(property) && t.isValidIdentifier(property.value, false)) {
        p.node.property = t.identifier(property.value);
        p.node.computed = false;
        n++;
      }
    },
    'ObjectProperty|ObjectMethod|ClassProperty|ClassMethod'(p) {
      const { key } = p.node;
      if (!p.node.computed && t.isStringLiteral(key) && t.isValidIdentifier(key.value, false)) {
        p.node.key = t.identifier(key.value);
        n++;
        return;
      }
      // ["inc"]() → inc(): hesaplanmış string anahtar. "constructor" (sınıfta gerçek kurucu olurdu) ve "__proto__"
      // (nesnede prototip ataması olurdu) hesaplanmış kalır.
      if (p.node.computed && t.isStringLiteral(key) && t.isValidIdentifier(key.value, false) &&
          !['constructor', '__proto__', 'prototype'].includes(key.value)) {
        p.node.key = t.identifier(key.value);
        p.node.computed = false;
        n++;
      }
    },
    CallExpression(p) {
      const c = p.node.callee;
      if (p.node.arguments.length === 0 && t.isCallExpression(c) && t.isIdentifier(c.callee, { name: 'Function' }) &&
          c.arguments.length === 1 && t.isStringLiteral(c.arguments[0]) && c.arguments[0].value.trim() === 'return this' &&
          !p.scope.getBinding('Function') && !p.scope.getBinding('globalThis')) {
        p.replaceWith(t.identifier('globalThis'));
        n++;
      }
    },
  });
  bump('literal', n);
}
