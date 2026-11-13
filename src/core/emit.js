import * as prettier from 'prettier/standalone';
import * as babelPlugin from 'prettier/plugins/babel';
import * as estreePlugin from 'prettier/plugins/estree';
import { generate } from '../util/ast.js';

export const raw = (ast) => generate(ast, { comments: true, jsescOption: { minimal: true } }).code;

// E239: biçim profilleri (yalnızca yerleşim; anlam değişmez). Anahtarlar arayüz ayarlarıyla (ui/settings.js format) aynıdır.
const BASE = { printWidth: 100, tabWidth: 2, useTabs: false, semi: true, singleQuote: false, trailingComma: 'all', bracketSpacing: true, arrowParens: 'always' };
export const FORMAT_PROFILES = {
  default: { ...BASE },
  compact: { ...BASE, printWidth: 80, bracketSpacing: false, arrowParens: 'avoid' },
  wide: { ...BASE, printWidth: 140, tabWidth: 4 },
  standard: { ...BASE, printWidth: 80, semi: false, singleQuote: true, trailingComma: 'none', arrowParens: 'avoid' },
  airbnb: { ...BASE, singleQuote: true },
  tabs: { ...BASE, tabWidth: 4, useTabs: true },
};

/** Profil adı ya da ayar nesnesi → prettier seçenekleri (yalnızca bilinen anahtarlar) */
export function profileOptions(profile) {
  const src = typeof profile === 'string' ? (FORMAT_PROFILES[profile] ?? BASE) : { ...BASE, ...(profile ?? {}) };
  return Object.fromEntries(Object.keys(BASE).map((k) => [k, src[k]]));
}

export async function pretty(code, profile = 'default') {
  try {
    return await prettier.format(code, {
      parser: 'babel',
      plugins: [babelPlugin, estreePlugin],
      ...profileOptions(profile),
    });
  } catch {
    return code;
  }
}
