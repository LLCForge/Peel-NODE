import { parse as babelParse } from '@babel/parser';

const PLUGINS = [
  'dynamicImport', 'classProperties', 'classPrivateProperties', 'classPrivateMethods',
  'optionalChaining', 'nullishCoalescingOperator', 'topLevelAwait', 'importMeta',
  'numericSeparator', 'logicalAssignment', 'decorators',
];

// Önce script, olmazsa module olarak dene. Hata kurtarmalı AST'yi kabul etmiyoruz:
// kısmen bozuk ağaçtan üretilen kod sessizce yanlış olur.
export function parse(code) {
  let lastError;
  for (const sourceType of ['script', 'module']) {
    try {
      return babelParse(code, {
        sourceType,
        allowReturnOutsideFunction: sourceType === 'script',
        plugins: PLUGINS,
      });
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`Parse edilemedi: ${lastError?.message ?? 'bilinmeyen hata'}`);
}
