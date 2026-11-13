import { parse } from '../core/parse.js';

// Yalnızca parse edilemeyen girdiye dokunur: geçerli koddaki string içeriklerini bozmamak için.
export async function run(code, { onLog }) {
  try {
    parse(code);
    return code;
  } catch {
    // aşağıdaki düzeltmeleri dene
  }
  let r = code;
  r = r.replace(/\b(get|set)(["'])/g, '$1 $2');
  r = r.replace(/\b(return|throw|typeof|delete|void|case|new|in|instanceof)(["'`\d{(\[!~+-])/g, '$1 $2');
  r = r.replace(/\breturn(true|false|null|undefined|this)\b/g, 'return $1');
  if (r === code) return code;
  try {
    parse(r);
    onLog('normalize: sözdizimi düzeltildi', 'info');
    return r;
  } catch {
    return code;
  }
}
