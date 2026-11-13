import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { scan } from '../naming/scope.js';

// 82: sihirli sayıları adlandırma. Tanınan sabitler program başında const olarak bildirilir, kullanım yerleri adla değişir.
// Bağlama bağlı sayılar (13 → KEY_ENTER) yalnızca o bağlamda (keyCode karşılaştırması) adlandırılır.
// const programın ilk deyimi olduğu için her kullanımdan önce başlatılır; with/eval varken isim çözümü dinamik, atlanır.

const ANY = new Map([
  [86400000, 'MS_PER_DAY'], [3600000, 'MS_PER_HOUR'], [604800000, 'MS_PER_WEEK'], [86400, 'SECONDS_PER_DAY'],
  [4294967295, 'UINT32_MAX'], [2147483647, 'INT32_MAX'], [9007199254740991, 'MAX_SAFE_INTEGER'],
  [0x67452301, 'MD5_INIT_A'], [0xefcdab89, 'MD5_INIT_B'], [0x98badcfe, 'MD5_INIT_C'], [0x10325476, 'MD5_INIT_D'],
  [0xc3d2e1f0, 'SHA1_INIT_E'], [0x6a09e667, 'SHA256_INIT_H0'], [0xbb67ae85, 'SHA256_INIT_H1'], [0x9e3779b9, 'TEA_DELTA'],
  [0x5bd1e995, 'MURMUR2_M'], [0xcc9e2d51, 'MURMUR3_C1'], [0x1b873593, 'MURMUR3_C2'], [0x811c9dc5, 'FNV_OFFSET_BASIS'],
  [16777619, 'FNV_PRIME'], [0xedb88320, 'CRC32_POLY'], [0x04c11db7, 'CRC32_POLY_NORMAL'],
]);
const TIME = new Map([[1000, 'MS_PER_SECOND'], [60000, 'MS_PER_MINUTE'], [3600000, 'MS_PER_HOUR'], [86400000, 'MS_PER_DAY']]);
const KEYS = new Map([[8, 'KEY_BACKSPACE'], [9, 'KEY_TAB'], [13, 'KEY_ENTER'], [16, 'KEY_SHIFT'], [17, 'KEY_CTRL'], [18, 'KEY_ALT'],
  [27, 'KEY_ESCAPE'], [32, 'KEY_SPACE'], [37, 'KEY_LEFT'], [38, 'KEY_UP'], [39, 'KEY_RIGHT'], [40, 'KEY_DOWN'], [46, 'KEY_DELETE'],
  [67, 'KEY_C'], [73, 'KEY_I'], [74, 'KEY_J'], [83, 'KEY_S'], [85, 'KEY_U'], [123, 'KEY_F12']]);
const HTTP = new Map([[200, 'HTTP_OK'], [201, 'HTTP_CREATED'], [204, 'HTTP_NO_CONTENT'], [301, 'HTTP_MOVED_PERMANENTLY'],
  [302, 'HTTP_FOUND'], [304, 'HTTP_NOT_MODIFIED'], [400, 'HTTP_BAD_REQUEST'], [401, 'HTTP_UNAUTHORIZED'], [403, 'HTTP_FORBIDDEN'],
  [404, 'HTTP_NOT_FOUND'], [429, 'HTTP_TOO_MANY_REQUESTS'], [500, 'HTTP_SERVER_ERROR'], [503, 'HTTP_UNAVAILABLE']]);
const READY = new Map([[0, 'READY_STATE_UNSENT'], [1, 'READY_STATE_OPENED'], [2, 'READY_STATE_HEADERS_RECEIVED'], [3, 'READY_STATE_LOADING'], [4, 'READY_STATE_DONE']]);
const NODE_TYPES = new Map([[1, 'ELEMENT_NODE'], [3, 'TEXT_NODE'], [8, 'COMMENT_NODE'], [9, 'DOCUMENT_NODE'], [11, 'DOCUMENT_FRAGMENT_NODE']]);
const CHARS = new Map([[48, 'CHAR_0'], [57, 'CHAR_9'], [65, 'CHAR_UPPER_A'], [90, 'CHAR_UPPER_Z'], [97, 'CHAR_LOWER_A'], [122, 'CHAR_LOWER_Z']]);

const propKey = (m) => (!m.computed && t.isIdentifier(m.property) ? m.property.name
  : t.isStringLiteral(m.property) ? m.property.value : null);

// Karşılaştırmanın diğer tarafı hangi bağlamı gösteriyor?
function contextOf(other, p) {
  if (t.isMemberExpression(other)) {
    const k = propKey(other);
    if (k === 'keyCode' || k === 'which' || k === 'charCode') return KEYS;
    if (k === 'status') return HTTP;
    if (k === 'readyState') return READY;
    if (k === 'nodeType') return NODE_TYPES;
  }
  if (t.isCallExpression(other) && t.isMemberExpression(other.callee) && propKey(other.callee) === 'charCodeAt') return CHARS;
  if (t.isIdentifier(other)) {
    const b = p.scope.getBinding(other.name);
    const init = b?.constant && b.path.isVariableDeclarator() ? b.path.node.init : null;
    if (init && t.isCallExpression(init) && t.isMemberExpression(init.callee) && propKey(init.callee) === 'charCodeAt') return CHARS;
    if (init && t.isMemberExpression(init)) {
      const k = propKey(init);
      if (k === 'keyCode' || k === 'which') return KEYS;
      if (k === 'status') return HTTP;
    }
  }
  return null;
}

const isTimeCall = (call, p) => t.isCallExpression(call) && t.isIdentifier(call.callee) &&
  ['setTimeout', 'setInterval'].includes(call.callee.name) && !p.scope.getBinding(call.callee.name);
const isNow = (n) => t.isCallExpression(n) && t.isMemberExpression(n.callee) &&
  ((t.isIdentifier(n.callee.object, { name: 'Date' }) && propKey(n.callee) === 'now') ||
   (t.isIdentifier(n.callee.object, { name: 'performance' }) && propKey(n.callee) === 'now'));

export function magicName(p) {
  const v = p.node.value;
  const par = p.parentPath;
  if (ANY.has(v)) return ANY.get(v);
  if (par.isBinaryExpression() && ['==', '===', '!=', '!==', '<', '>', '<=', '>='].includes(par.node.operator)) {
    const other = par.node.left === p.node ? par.node.right : par.node.left;
    const table = contextOf(other, p);
    if (table?.has(v)) return table.get(v);
  }
  if (par.isSwitchCase({ test: p.node })) {
    const table = contextOf(par.parent.discriminant, p);
    if (table?.has(v)) return table.get(v);
  }
  if (TIME.has(v)) {
    if (par.isCallExpression() && isTimeCall(par.node, p) && par.node.arguments[1] === p.node) return TIME.get(v);
    if (par.isBinaryExpression() && ['*', '/'].includes(par.node.operator)) {
      // 5 * 60000, x / 1000 gibi birim dönüşümleri: diğer taraf Date.now() ya da başka bir zaman sabiti
      const other = par.node.left === p.node ? par.node.right : par.node.left;
      if (isNow(other) || (t.isNumericLiteral(other) && TIME.has(other.value))) return TIME.get(v);
      const gp = par.parentPath;
      if (gp.isCallExpression() && isTimeCall(gp.node, p) && gp.node.arguments[1] === par.node) return TIME.get(v);
    }
    if (par.isBinaryExpression() && ['+', '-'].includes(par.node.operator)) {
      const other = par.node.left === p.node ? par.node.right : par.node.left;
      if (isNow(other)) return TIME.get(v);
    }
  }
  return null;
}

export async function run(ast, { onLog, bump, naming = {} }) {
  if (naming.magic === false) return;
  const info = scan(ast);
  if (info.withStatements.length || info.globalCode) return;
  const chosen = new Map(); // value|name → identifier adı
  const sites = [];
  let programPath = null;
  traverse(ast, {
    Program(p) { programPath = p; },
    NumericLiteral(p) {
      if (p.parentPath.isObjectProperty({ key: p.node }) && !p.parent.computed) return;
      if (p.parentPath.isObjectMethod() || p.parentPath.isClassMethod() || p.parentPath.isClassProperty()) return;
      // zaten adlandırılmış: const KEY_ENTER = 13
      if (p.parentPath.isVariableDeclarator({ init: p.node }) && t.isIdentifier(p.parent.id) && /^[A-Z][A-Z0-9_]+$/.test(p.parent.id.name)) return;
      const name = magicName(p);
      if (!name) return;
      sites.push({ p, name, value: p.node.value });
    },
  });
  if (!sites.length) return;
  for (const s of sites) {
    const key = `${s.name}|${s.value}`;
    if (!chosen.has(key)) {
      let id = s.name;
      for (let i = 2; info.taken.has(id); i++) id = `${s.name}_${i}`;
      info.taken.add(id);
      chosen.set(key, id);
    }
    s.p.replaceWith(t.identifier(chosen.get(key)));
  }
  const decls = [...chosen].map(([key, id]) => t.variableDeclaration('const', [
    t.variableDeclarator(t.identifier(id), t.numericLiteral(Number(key.split('|')[1]))),
  ]));
  const body = programPath.node.body;
  let at = 0;
  while (at < body.length && t.isImportDeclaration(body[at])) at++;
  body.splice(at, 0, ...decls);
  onLog(`magic: ${sites.length} sihirli sayı ${chosen.size} adlandırılmış sabite bağlandı`, 'info');
  bump('magic', sites.length);
}
