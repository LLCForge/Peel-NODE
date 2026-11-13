import * as prettier from 'prettier/standalone';
import * as babelPlugin from 'prettier/plugins/babel';
import * as estreePlugin from 'prettier/plugins/estree';

// H171: çıktıyı projenin biçim kurallarına uydurma. Kaynaklar (öncelik sırasıyla):
// .prettierrc / .prettierrc.json / package.json#prettier > .eslintrc(.json) kuralları > .editorconfig.
// Yalnızca biçimle ilgili, bilinen seçenekler alınır; yapılandırma dosyasındaki kod çalıştırılmaz
// (.prettierrc.js / eslint.config.js gibi JS yapılandırmaları bu yüzden okunmaz).

export const DEFAULT_STYLE = { printWidth: 100, tabWidth: 2, useTabs: false, semi: true, singleQuote: false };

const PRETTIER_KEYS = {
  printWidth: 'number', tabWidth: 'number', useTabs: 'boolean', semi: 'boolean', singleQuote: 'boolean',
  quoteProps: ['as-needed', 'consistent', 'preserve'], trailingComma: ['all', 'es5', 'none'], bracketSpacing: 'boolean',
  bracketSameLine: 'boolean', arrowParens: ['always', 'avoid'], endOfLine: ['lf', 'crlf', 'cr', 'auto'],
};

function pick(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, kind] of Object.entries(PRETTIER_KEYS)) {
    const v = obj[k];
    if (v === undefined) continue;
    if (Array.isArray(kind) ? kind.includes(v) : typeof v === kind) out[k] = v;
  }
  if (out.printWidth !== undefined && (out.printWidth < 20 || out.printWidth > 400)) delete out.printWidth;
  if (out.tabWidth !== undefined && (out.tabWidth < 1 || out.tabWidth > 16)) delete out.tabWidth;
  return out;
}

// .prettierrc JSON ya da basit YAML (anahtar: değer) olabilir
export function parsePrettierrc(text) {
  const s = text.trim();
  if (!s) return {};
  if (s.startsWith('{')) return pick(JSON.parse(s));
  const obj = {};
  for (const line of s.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    let v = m[2].replace(/^["']|["']$/g, '');
    if (v === 'true' || v === 'false') v = v === 'true';
    else if (/^\d+$/.test(v)) v = Number(v);
    obj[m[1]] = v;
  }
  return pick(obj);
}

// ESLint kurallarından biçim seçenekleri (yalnızca JSON yapılandırma)
export function fromEslint(config) {
  const rules = { ...(config?.rules ?? {}) };
  const out = {};
  const opt = (r) => (Array.isArray(r) ? r : [r]);
  const on = (r) => r !== undefined && !['off', 0].includes(opt(r)[0]);
  for (const prefix of ['', '@stylistic/', '@stylistic/js/']) {
    const indent = rules[`${prefix}indent`];
    if (on(indent)) {
      const v = opt(indent)[1];
      if (v === 'tab') out.useTabs = true;
      else if (typeof v === 'number') { out.tabWidth = v; out.useTabs = false; }
    }
    const quotes = rules[`${prefix}quotes`];
    if (on(quotes) && typeof opt(quotes)[1] === 'string') out.singleQuote = opt(quotes)[1] === 'single';
    const semi = rules[`${prefix}semi`];
    if (on(semi)) out.semi = opt(semi)[1] !== 'never';
    const maxLen = rules[`${prefix}max-len`];
    if (on(maxLen)) {
      const v = opt(maxLen)[1];
      const n = typeof v === 'number' ? v : v?.code;
      if (typeof n === 'number') out.printWidth = n;
    }
    const comma = rules[`${prefix}comma-dangle`];
    if (on(comma)) {
      const v = opt(comma)[1];
      out.trailingComma = v === 'never' || v === undefined ? 'none' : v === 'always-multiline' || v === 'always' ? 'all' : 'es5';
    }
    const arrow = rules[`${prefix}arrow-parens`];
    if (on(arrow)) out.arrowParens = opt(arrow)[1] === 'as-needed' ? 'avoid' : 'always';
    const space = rules[`${prefix}object-curly-spacing`];
    if (on(space)) out.bracketSpacing = opt(space)[1] !== 'never';
  }
  return pick(out);
}

// .editorconfig: [*] ve JS dosyalarına uyan bölümler
export function fromEditorconfig(text) {
  const out = {};
  let applies = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      const g = sec[1];
      applies = g === '*' || /(^|[{,.*])js\b|\*\.\{[^}]*\bjs\b/.test(g);
      continue;
    }
    if (!applies) continue;
    const kv = line.match(/^([\w-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    const val = v.toLowerCase();
    if (k === 'indent_style') out.useTabs = val === 'tab';
    else if (k === 'indent_size' && /^\d+$/.test(val)) out.tabWidth = Number(val);
    else if (k === 'tab_width' && /^\d+$/.test(val) && out.tabWidth === undefined) out.tabWidth = Number(val);
    else if (k === 'max_line_length' && /^\d+$/.test(val)) out.printWidth = Number(val);
    else if (k === 'end_of_line' && ['lf', 'crlf', 'cr'].includes(val)) out.endOfLine = val;
    else if (k === 'quote_type' && ['single', 'double'].includes(val)) out.singleQuote = val === 'single';
  }
  return pick(out);
}

/**
 * Dosya içeriklerinden nihai stil. Her kaynak isteğe bağlıdır.
 * @param {{prettierrc?: string, packageJson?: string, eslintrc?: string, editorconfig?: string}} src
 */
export function resolveStyle(src = {}) {
  let style = { ...DEFAULT_STYLE };
  if (src.editorconfig) style = { ...style, ...fromEditorconfig(src.editorconfig) };
  if (src.eslintrc) {
    try { style = { ...style, ...fromEslint(JSON.parse(src.eslintrc)) }; } catch { /* JSON olmayan eslintrc atlanır */ }
  }
  if (src.packageJson) {
    try { style = { ...style, ...pick(JSON.parse(src.packageJson).prettier) }; } catch { /* bozuk package.json atlanır */ }
  }
  if (src.prettierrc) style = { ...style, ...parsePrettierrc(src.prettierrc) };
  return style;
}

export async function formatWithStyle(code, style = DEFAULT_STYLE) {
  return prettier.format(code, { parser: 'babel', plugins: [babelPlugin, estreePlugin], ...pick(style) });
}
