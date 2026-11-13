import { traverse } from '../util/ast.js';

// E571: genel gölgeleme analizi. Her binding için aynı adı taşıyan dış binding'i ya da yerleşik global'i bulur.
// Yerleşik ad gölgelemesi katlama ve proxy dışındaki pass'ler için de tehlikelidir (ör. undefined/NaN literal sanılır).

export const BUILTINS = new Set([
  'undefined', 'NaN', 'Infinity', 'globalThis', 'eval', 'Object', 'Function', 'Array', 'String', 'Number', 'Boolean', 'Symbol',
  'BigInt', 'Math', 'JSON', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'Promise',
  'Proxy', 'Reflect', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'ArrayBuffer', 'DataView', 'Uint8Array', 'Int32Array',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURIComponent', 'encodeURIComponent', 'escape', 'unescape', 'atob', 'btoa',
  'window', 'self', 'document', 'navigator', 'location', 'console', 'setTimeout', 'setInterval', 'fetch', 'XMLHttpRequest',
  'arguments', 'require', 'module', 'exports', 'Intl', 'Atomics', 'SharedArrayBuffer', 'queueMicrotask', 'structuredClone',
]);

// Literal sanılan değer adları: gölgelenirse literal katlama yanlış olur
const VALUE_NAMES = new Set(['undefined', 'NaN', 'Infinity']);

/** Ad, yolun bulunduğu noktada hangi binding zincirine çözülür? İçten dışa [binding, gölgelenen binding'ler...]. */
export function shadowChain(path, name) {
  const chain = [];
  for (let s = path.scope; s; s = s.parent) {
    const b = s.getOwnBinding(name);
    if (b && !chain.includes(b)) chain.push(b);
  }
  return chain;
}

/** Ad bu noktada yerleşik global yerine program binding'ine mi çözülüyor? */
export const shadowsBuiltin = (path, name) => BUILTINS.has(name) && Boolean(path.scope.getBinding(name));

export function shadowReport(ast, { max = 60 } = {}) {
  const out = { total: 0, locals: 0, builtins: 0, valueNames: [], samples: [] };
  const seen = new Set();
  traverse(ast, {
    Scopable(p) {
      const scope = p.scope;
      if (seen.has(scope)) return;
      seen.add(scope);
      for (const [name, b] of Object.entries(scope.bindings)) {
        const outer = scope.parent?.getBinding(name);
        const builtin = !outer && BUILTINS.has(name);
        if (!outer && !builtin) continue;
        // var/fonksiyon yeniden bildirimi aynı binding'dir; Babel ayrı kapsamda tutmaz
        out.total++;
        if (outer) out.locals++; else out.builtins++;
        const item = {
          name, line: b.identifier.loc?.start.line ?? null, kind: b.kind,
          shadows: outer ? { line: outer.identifier.loc?.start.line ?? null, kind: outer.kind } : 'global',
          references: b.referencePaths.length,
        };
        if (VALUE_NAMES.has(name)) out.valueNames.push(item);
        if (out.samples.length < max) out.samples.push(item);
      }
    },
  });
  return out;
}
