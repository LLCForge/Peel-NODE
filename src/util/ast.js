import _generate from '@babel/generator';
import _traverse from '@babel/traverse';

// Babel paketleri CJS: ortama göre fonksiyon ya doğrudan ya .default altında gelir
export const generate = _generate.default ?? _generate;
export const traverse = _traverse.default ?? _traverse;

export const gen = (node) => generate(node, { compact: true, jsescOption: { minimal: true } }).code;
