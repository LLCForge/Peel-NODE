import * as t from '@babel/types';
import { traverse } from '../util/ast.js';

// Kullanımdan, literal'lerden ve bilinen API'lerden TypeScript tipi çıkarımı (76).
// Tipler TS sözdiziminde string olarak tutulur; bilinmeyen 'unknown' olur (any kullanılmaz).

const MAX_UNION = 4;
const U = 'unknown';

export function union(...types) {
  const flat = new Set();
  for (const ty of types) {
    if (!ty) continue;
    for (const part of splitUnion(ty)) flat.add(part);
  }
  if (flat.has(U) || !flat.size) return U;
  // never yalnızca tek başına anlamlı
  flat.delete('never');
  if (!flat.size) return 'never';
  if (flat.size > MAX_UNION) return U;
  return [...flat].join(' | ');
}

function splitUnion(ty) {
  // üst düzey | ile böl (parantez/açılı ayraç içini bölme)
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of ty) {
    if ('<({['.includes(ch)) depth++;
    else if ('>)}]'.includes(ch)) depth--;
    if (ch === '|' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  parts.push(cur.trim());
  return parts.filter(Boolean);
}

const wrapArrayElem = (ty) => (splitUnion(ty).length > 1 || ty.includes('=>') ? `(${ty})[]` : `${ty}[]`);
export const arrayOf = (ty) => wrapArrayElem(ty);
export const elementOf = (ty) => {
  const m = /^\(?(.+?)\)?\[\]$/.exec(ty);
  if (m) return m[1];
  if (ty === 'string') return 'string';
  const n = /^(?:NodeListOf|HTMLCollectionOf|Array)<(.+)>$/.exec(ty);
  return n ? n[1] : U;
};
const unwrapPromise = (ty) => {
  const m = /^Promise<(.+)>$/.exec(ty);
  return m ? m[1] : ty;
};

const CTORS = {
  Date: 'Date', RegExp: 'RegExp', Map: 'Map<unknown, unknown>', Set: 'Set<unknown>', WeakMap: 'WeakMap<object, unknown>',
  Promise: 'Promise<unknown>', XMLHttpRequest: 'XMLHttpRequest', WebSocket: 'WebSocket', URL: 'URL', URLSearchParams: 'URLSearchParams',
  FormData: 'FormData', Image: 'HTMLImageElement', Audio: 'HTMLAudioElement', Uint8Array: 'Uint8Array', Uint16Array: 'Uint16Array',
  Uint32Array: 'Uint32Array', Int32Array: 'Int32Array', Float64Array: 'Float64Array', ArrayBuffer: 'ArrayBuffer', DataView: 'DataView',
  Error: 'Error', TypeError: 'TypeError', Blob: 'Blob', Worker: 'Worker', AudioContext: 'AudioContext', OfflineAudioContext: 'OfflineAudioContext',
  TextEncoder: 'TextEncoder', TextDecoder: 'TextDecoder', MutationObserver: 'MutationObserver', Headers: 'Headers', Request: 'Request',
  Response: 'Response', EventSource: 'EventSource', RTCPeerConnection: 'RTCPeerConnection', Array: 'unknown[]', Object: 'object',
  Function: 'Function', String: 'String', Number: 'Number', Boolean: 'Boolean',
};

const TAGS = { div: 'HTMLDivElement', span: 'HTMLSpanElement', a: 'HTMLAnchorElement', img: 'HTMLImageElement', input: 'HTMLInputElement',
  button: 'HTMLButtonElement', form: 'HTMLFormElement', script: 'HTMLScriptElement', iframe: 'HTMLIFrameElement', canvas: 'HTMLCanvasElement',
  style: 'HTMLStyleElement', link: 'HTMLLinkElement', p: 'HTMLParagraphElement', ul: 'HTMLUListElement', li: 'HTMLLIElement',
  table: 'HTMLTableElement', select: 'HTMLSelectElement', textarea: 'HTMLTextAreaElement', video: 'HTMLVideoElement', audio: 'HTMLAudioElement' };

// Global fonksiyon / statik metot dönüş tipleri
const GLOBAL_CALLS = {
  parseInt: 'number', parseFloat: 'number', Number: 'number', String: 'string', Boolean: 'boolean', isNaN: 'boolean', isFinite: 'boolean',
  atob: 'string', btoa: 'string', escape: 'string', unescape: 'string', encodeURIComponent: 'string', decodeURIComponent: 'string',
  encodeURI: 'string', decodeURI: 'string', fetch: 'Promise<Response>', setTimeout: 'number', setInterval: 'number',
  requestAnimationFrame: 'number', 'JSON.parse': U, 'JSON.stringify': 'string', 'Object.keys': 'string[]', 'Object.values': 'unknown[]',
  'Object.entries': '[string, unknown][]', 'Object.assign': 'object', 'Object.create': 'object', 'Array.isArray': 'boolean',
  'Array.from': 'unknown[]', 'Array.of': 'unknown[]', 'Date.now': 'number', 'performance.now': 'number', 'String.fromCharCode': 'string',
  'String.fromCodePoint': 'string', 'Number.isInteger': 'boolean', 'Number.parseInt': 'number', 'Number.parseFloat': 'number',
  'Promise.all': 'Promise<unknown[]>', 'Promise.resolve': 'Promise<unknown>', 'Promise.reject': 'Promise<never>', 'Promise.race': 'Promise<unknown>',
  'document.getElementById': 'HTMLElement | null', 'document.querySelector': 'Element | null',
  'document.querySelectorAll': 'NodeListOf<Element>', 'document.getElementsByTagName': 'HTMLCollectionOf<Element>',
  'document.getElementsByClassName': 'HTMLCollectionOf<Element>', 'document.createTextNode': 'Text',
  'localStorage.getItem': 'string | null', 'sessionStorage.getItem': 'string | null', 'navigator.sendBeacon': 'boolean',
  'crypto.getRandomValues': 'Uint8Array', 'crypto.randomUUID': 'string', 'Symbol': 'symbol', 'BigInt': 'bigint',
};

// Alıcının tipinden bağımsız iyi bilinen metot dönüşleri
const METHOD_RETURNS = {
  toString: 'string', toUpperCase: 'string', toLowerCase: 'string', trim: 'string', trimStart: 'string', trimEnd: 'string',
  padStart: 'string', padEnd: 'string', charAt: 'string', substring: 'string', substr: 'string', toFixed: 'string', repeat: 'string',
  replace: 'string', replaceAll: 'string', join: 'string', toISOString: 'string', toJSON: 'string', normalize: 'string',
  charCodeAt: 'number', codePointAt: 'number', indexOf: 'number', lastIndexOf: 'number', findIndex: 'number', push: 'number',
  unshift: 'number', getTime: 'number', valueOf: U, localeCompare: 'number',
  split: 'string[]', match: 'RegExpMatchArray | null', exec: 'RegExpExecArray | null', test: 'boolean', includes: 'boolean',
  startsWith: 'boolean', endsWith: 'boolean', some: 'boolean', every: 'boolean', hasOwnProperty: 'boolean', contains: 'boolean',
  hasAttribute: 'boolean', getAttribute: 'string | null', json: 'Promise<unknown>', text: 'Promise<string>', blob: 'Promise<Blob>',
  arrayBuffer: 'Promise<ArrayBuffer>', then: 'Promise<unknown>', catch: 'Promise<unknown>', finally: 'Promise<unknown>',
  querySelector: 'Element | null', querySelectorAll: 'NodeListOf<Element>', getElementById: 'HTMLElement | null',
  getContext: 'CanvasRenderingContext2D | null', toDataURL: 'string', getBoundingClientRect: 'DOMRect', cloneNode: 'Node',
  appendChild: 'Node', keys: 'IterableIterator<unknown>', getItem: 'string | null',
};
// Alıcı tipini koruyan dizi metotları
const SAME_ARRAY = new Set(['filter', 'slice', 'concat', 'sort', 'reverse', 'splice', 'fill', 'flat']);

const memberPath = (n) => {
  if (t.isIdentifier(n)) return n.name;
  if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
    const o = memberPath(n.object);
    return o ? `${o}.${n.property.name}` : null;
  }
  return null;
};
const propKey = (m) => (!m.computed && t.isIdentifier(m.property) ? m.property.name
  : t.isStringLiteral(m.property) ? m.property.value : null);

const STRING_OPS = new Set(['toUpperCase', 'toLowerCase', 'trim', 'split', 'charCodeAt', 'charAt', 'substring', 'substr',
  'padStart', 'padEnd', 'startsWith', 'endsWith', 'codePointAt', 'normalize', 'localeCompare', 'replaceAll']);
const ARRAY_OPS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'forEach', 'map', 'filter', 'reduce', 'reduceRight',
  'some', 'every', 'find', 'findIndex', 'flatMap', 'sort', 'reverse', 'fill']);
const ELEMENT_OPS = new Set(['appendChild', 'removeChild', 'insertBefore', 'setAttribute', 'getAttribute', 'removeAttribute',
  'classList', 'style', 'innerHTML', 'outerHTML', 'textContent', 'innerText', 'querySelector', 'querySelectorAll', 'parentNode',
  'children', 'firstChild', 'append', 'prepend', 'remove', 'focus', 'click', 'getBoundingClientRect', 'dataset', 'tagName']);
const EVENT_OPS = new Set(['preventDefault', 'stopPropagation', 'target', 'currentTarget', 'keyCode', 'which', 'key',
  'clientX', 'clientY', 'pageX', 'pageY', 'button', 'detail', 'stopImmediatePropagation']);
const RESPONSE_OPS = new Set(['json', 'ok', 'status', 'statusText', 'headers', 'blob', 'arrayBuffer']);
const PROMISE_OPS = new Set(['then', 'catch', 'finally']);
const NUM_OPS = new Set(['-', '*', '/', '%', '**', '<<', '>>', '>>>', '&', '|', '^']);
const CMP_OPS = new Set(['<', '>', '<=', '>=']);

/**
 * Program için tip çıkarıcı. inferer.expr(path), inferer.binding(binding), inferer.fn(fnPath) döner.
 */
export function createInferer() {
  const bindingCache = new Map();
  const fnCache = new Map();
  const visiting = new Set();

  function expr(path) {
    if (!path?.node) return U;
    const n = path.node;
    switch (n.type) {
      case 'StringLiteral': case 'TemplateLiteral': return 'string';
      case 'NumericLiteral': return 'number';
      case 'BigIntLiteral': return 'bigint';
      case 'BooleanLiteral': return 'boolean';
      case 'NullLiteral': return 'null';
      case 'RegExpLiteral': return 'RegExp';
      case 'ArrayExpression': {
        const els = path.get('elements').filter((e) => e.node && !e.isSpreadElement());
        if (!els.length) return 'unknown[]';
        return arrayOf(union(...els.map(expr)));
      }
      case 'ObjectExpression': return objectShape(path);
      case 'FunctionExpression': case 'ArrowFunctionExpression': return fnSignature(path);
      case 'ClassExpression': return n.id ? `typeof ${n.id.name}` : 'Function';
      case 'UnaryExpression':
        if (n.operator === '!' || n.operator === 'delete') return 'boolean';
        if (n.operator === 'typeof') return 'string';
        if (n.operator === 'void') return 'undefined';
        return 'number';
      case 'UpdateExpression': return 'number';
      case 'BinaryExpression': {
        if (n.operator === '+') {
          const l = expr(path.get('left'));
          const r = expr(path.get('right'));
          if (l === 'string' || r === 'string') return 'string';
          if (l === 'number' && r === 'number') return 'number';
          return 'string | number';
        }
        if (NUM_OPS.has(n.operator)) return 'number';
        return 'boolean';
      }
      case 'LogicalExpression': {
        const l = expr(path.get('left'));
        const r = expr(path.get('right'));
        if (n.operator === '??') return union(splitUnion(l).filter((x) => x !== 'null' && x !== 'undefined').join(' | ') || 'never', r);
        return union(l, r);
      }
      case 'ConditionalExpression': return union(expr(path.get('consequent')), expr(path.get('alternate')));
      case 'SequenceExpression': return expr(path.get('expressions').at(-1));
      case 'AssignmentExpression': return n.operator === '=' ? expr(path.get('right')) : (n.operator === '+=' ? union(expr(path.get('left')), expr(path.get('right'))) : 'number');
      case 'AwaitExpression': return unwrapPromise(expr(path.get('argument')));
      case 'ParenthesizedExpression': return expr(path.get('expression'));
      case 'NewExpression': {
        if (t.isIdentifier(n.callee)) {
          const b = path.scope.getBinding(n.callee.name);
          if (b && (b.path.isClassDeclaration() || b.path.isFunctionDeclaration())) return n.callee.name;
          if (!b && Object.hasOwn(CTORS, n.callee.name)) return CTORS[n.callee.name];
        }
        return 'object';
      }
      case 'Identifier': {
        if (n.name === 'undefined' && !path.scope.getBinding('undefined')) return 'undefined';
        if ((n.name === 'NaN' || n.name === 'Infinity') && !path.scope.getBinding(n.name)) return 'number';
        const b = path.scope.getBinding(n.name);
        if (b) return binding(b);
        if (n.name === 'document') return 'Document';
        if (n.name === 'window' || n.name === 'self' || n.name === 'globalThis') return 'Window';
        if (n.name === 'navigator') return 'Navigator';
        if (n.name === 'location') return 'Location';
        return U;
      }
      case 'MemberExpression': case 'OptionalMemberExpression': {
        const key = propKey(n);
        if (key === 'length') return 'number';
        const objTy = expr(path.get('object'));
        if (n.computed && !t.isStringLiteral(n.property)) {
          const el = elementOf(objTy);
          if (el !== U) return el;
        }
        const shape = /^\{ (.*) \}$/.exec(objTy);
        if (shape && key) {
          const field = shapeField(objTy, key);
          if (field) return field;
        }
        const full = memberPath(n);
        if (full === 'location.href' || full === 'document.cookie' || full === 'navigator.userAgent' || full === 'document.title' ||
          full === 'document.referrer' || full === 'document.domain' || full === 'location.hostname') return 'string';
        if (full === 'document.body') return 'HTMLElement';
        if (key === 'innerHTML' || key === 'textContent' || key === 'value' || key === 'id' || key === 'className' || key === 'src' || key === 'href') {
          if (/Element|Document/.test(objTy)) return 'string';
        }
        return U;
      }
      case 'CallExpression': case 'OptionalCallExpression': return callType(path);
      case 'ThisExpression': {
        const cls = path.findParent((x) => x.isClass());
        return cls?.node.id ? cls.node.id.name : U;
      }
      default: return U;
    }
  }

  function shapeField(shape, key) {
    for (const part of splitTop(shape.slice(2, -2), ';')) {
      const i = part.indexOf(':');
      if (i > 0 && part.slice(0, i).trim().replace(/\?$/, '') === key) return part.slice(i + 1).trim();
    }
    return null;
  }

  function objectShape(path) {
    const fields = [];
    for (const p of path.get('properties')) {
      if (p.isSpreadElement() || p.node.computed) return 'Record<string, unknown>';
      const k = p.node.key;
      const name = t.isIdentifier(k) ? k.name : t.isStringLiteral(k) ? JSON.stringify(k.value) : t.isNumericLiteral(k) ? String(k.value) : null;
      if (!name) return 'Record<string, unknown>';
      const ty = p.isObjectMethod() ? fnSignature(p) : expr(p.get('value'));
      fields.push(`${name}: ${ty}`);
      if (fields.length > 12) return 'Record<string, unknown>';
    }
    return fields.length ? `{ ${fields.join('; ')} }` : 'Record<string, unknown>';
  }

  function callType(path) {
    const n = path.node;
    const callee = n.callee;
    const full = memberPath(callee);
    if (full && Object.hasOwn(GLOBAL_CALLS, full) && !path.scope.getBinding(full.split('.')[0])) return GLOBAL_CALLS[full];
    if (full === 'document.createElement' && t.isStringLiteral(n.arguments[0])) {
      return TAGS[n.arguments[0].value.toLowerCase()] ?? 'HTMLElement';
    }
    if (t.isMemberExpression(callee) && full?.startsWith('Math.')) return 'number';
    if (t.isIdentifier(callee)) {
      const b = path.scope.getBinding(callee.name);
      const fnPath = b ? functionOf(b) : null;
      if (fnPath) return fn(fnPath).returns;
      return U;
    }
    if (t.isFunctionExpression(callee) || t.isArrowFunctionExpression(callee)) return fn(path.get('callee')).returns;
    if (t.isMemberExpression(callee)) {
      const key = propKey(callee);
      if (!key) return U;
      const objTy = expr(path.get('callee.object'));
      if (SAME_ARRAY.has(key) && /\[\]$/.test(objTy)) return objTy;
      if (key === 'map' || key === 'flatMap') {
        const cb = path.get('arguments.0');
        if (cb?.isFunction()) return arrayOf(fn(cb).returns);
        return 'unknown[]';
      }
      if (key === 'find') return union(elementOf(objTy), 'undefined');
      if ((key === 'pop' || key === 'shift') && /\[\]$/.test(objTy)) return union(elementOf(objTy), 'undefined');
      if (key === 'slice' && objTy === 'string') return 'string';
      if (key === 'concat' && objTy === 'string') return 'string';
      if (key === 'reduce' && path.node.arguments.length > 1) return expr(path.get('arguments.1'));
      if (key === 'createElement' && t.isStringLiteral(n.arguments[0])) return TAGS[n.arguments[0].value.toLowerCase()] ?? 'HTMLElement';
      if (Object.hasOwn(METHOD_RETURNS, key)) return METHOD_RETURNS[key];
      // yerel nesne literalindeki metot
      const field = /^\{ /.test(objTy) ? shapeField(objTy, key) : null;
      const ret = field ? /=> (.+)$/.exec(field) : null;
      if (ret) return ret[1];
      // sınıf örneğinde metot
      if (/^[A-Z][\w$]*$/.test(objTy)) {
        const b = path.scope.getBinding(objTy);
        const cls = b?.path.isClassDeclaration() ? b.path : null;
        const m = cls?.get('body.body').find((x) => x.isClassMethod() && !x.node.computed && t.isIdentifier(x.node.key, { name: key }));
        if (m) return fn(m).returns;
      }
    }
    return U;
  }

  function functionOf(b) {
    const p = b.path;
    if (p.isFunctionDeclaration()) return p;
    if (p.isVariableDeclarator() && b.constant) {
      const init = p.get('init');
      if (init.isFunctionExpression() || init.isArrowFunctionExpression()) return init;
    }
    return null;
  }

  // Parametre ve dönüş tipleriyle fonksiyon imzası
  function fn(fnPath) {
    if (fnCache.has(fnPath.node)) return fnCache.get(fnPath.node);
    if (visiting.has(fnPath.node)) return { params: [], returns: U };
    visiting.add(fnPath.node);
    const params = fnPath.get('params').map((p) => {
      if (p.isIdentifier()) {
        const b = fnPath.scope.getBinding(p.node.name);
        return { name: p.node.name, type: b ? binding(b) : U, optional: false };
      }
      if (p.isAssignmentPattern() && t.isIdentifier(p.node.left)) {
        const b = fnPath.scope.getBinding(p.node.left.name);
        return { name: p.node.left.name, type: union(b ? binding(b) : U), optional: true };
      }
      if (p.isRestElement() && t.isIdentifier(p.node.argument)) return { name: `...${p.node.argument.name}`, type: 'unknown[]', optional: false };
      return { name: 'arg', type: U, optional: false };
    });
    let returns;
    if (fnPath.isArrowFunctionExpression() && !t.isBlockStatement(fnPath.node.body)) {
      returns = expr(fnPath.get('body'));
    } else {
      const types = [];
      let bare = false;
      fnPath.traverse({
        Function(p) { p.skip(); },
        ReturnStatement(p) {
          if (p.node.argument) types.push(expr(p.get('argument')));
          else bare = true;
        },
      });
      returns = types.length ? union(...types, bare ? 'undefined' : null) : 'void';
    }
    if (fnPath.node.async) returns = `Promise<${returns === 'void' ? 'void' : unwrapPromise(returns)}>`;
    if (fnPath.node.generator) returns = 'Generator<unknown, unknown, unknown>';
    const res = { params, returns };
    visiting.delete(fnPath.node);
    fnCache.set(fnPath.node, res);
    return res;
  }

  function fnSignature(fnPath) {
    const s = fn(fnPath);
    return `(${s.params.map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ')}) => ${s.returns}`;
  }

  // Binding tipi: başlangıç değeri + atamalar; bilinmiyorsa kullanım ipuçları ve çağrı yeri argümanları
  function binding(b) {
    const key = b.identifier;
    if (bindingCache.has(key)) return bindingCache.get(key);
    if (visiting.has(key)) return U;
    visiting.add(key);
    let ty = U;
    const p = b.path;
    const fnp = functionOf(b);
    if (p.isFunctionDeclaration() || fnp) ty = fnSignature(fnp ?? p);
    else if (p.isClassDeclaration()) ty = `typeof ${b.identifier.name}`;
    else {
      const sources = [];
      if (p.isVariableDeclarator() && t.isIdentifier(p.node.id) && p.node.init) sources.push(expr(p.get('init')));
      for (const v of b.constantViolations) {
        if (v.isAssignmentExpression() && t.isIdentifier(v.node.left, { name: b.identifier.name })) {
          sources.push(v.node.operator === '=' ? expr(v.get('right')) : (v.node.operator === '+=' ? null : 'number'));
        } else if (v.isUpdateExpression()) sources.push('number');
      }
      const known = sources.filter(Boolean);
      if (b.kind === 'param') {
        const fromCalls = callSiteTypes(b);
        if (fromCalls) known.push(fromCalls);
      }
      const usage = usageType(b);
      ty = known.length ? union(...known) : U;
      if (ty === U || (p.isVariableDeclarator() && !p.node.init && !known.length)) ty = usage ?? U;
      if (ty === 'null' && usage) ty = union(usage, 'null');
    }
    visiting.delete(key);
    bindingCache.set(key, ty);
    return ty;
  }

  // Yerel fonksiyonun parametresi: tüm çağrı yerlerinde aynı konumdaki argümanların tipi
  function callSiteTypes(b) {
    const fnPath = b.scope.path;
    if (!fnPath.isFunction()) return null;
    const idx = fnPath.node.params.findIndex((x) => t.isIdentifier(x, { name: b.identifier.name }));
    if (idx < 0) return null;
    let refs = null;
    let viaNew = false;
    if (fnPath.isClassMethod({ kind: 'constructor' })) {
      // sınıf kurucusu: new Sınıf(…) çağrıları
      const cls = fnPath.parentPath.parentPath;
      if (cls.isClassDeclaration() && cls.node.id) { refs = cls.parentPath.scope.getBinding(cls.node.id.name)?.referencePaths.filter((r) => r.parentPath.isNewExpression({ callee: r.node })); viaNew = true; }
    } else if (fnPath.isFunctionDeclaration()) refs = fnPath.parentPath.scope.getBinding(fnPath.node.id.name)?.referencePaths;
    else if (fnPath.parentPath.isVariableDeclarator() && t.isIdentifier(fnPath.parent.id)) refs = fnPath.parentPath.scope.getBinding(fnPath.parent.id.name)?.referencePaths;
    if (!refs?.length) return null;
    const types = [];
    for (const r of refs) {
      const call = r.parentPath;
      if (viaNew ? !call.isNewExpression({ callee: r.node }) : !call.isCallExpression({ callee: r.node })) return null;
      const arg = call.get(`arguments.${idx}`);
      if (!arg?.node) { types.push('undefined'); continue; }
      if (arg.isSpreadElement()) return null;
      types.push(expr(arg));
    }
    const ty = union(...types);
    return ty === U ? null : ty;
  }

  // Kullanım ipuçları: x.length + x[i] → dizi, x.preventDefault() → Event, x() → Function...
  function usageType(b) {
    const hints = new Set();
    for (const r of b.referencePaths) {
      const par = r.parentPath;
      if (par.isMemberExpression({ object: r.node })) {
        const key = propKey(par.node);
        const called = par.parentPath.isCallExpression({ callee: par.node });
        if (key === null) hints.add(par.node.computed ? 'indexed' : 'object');
        else if (EVENT_OPS.has(key)) hints.add('event');
        else if (RESPONSE_OPS.has(key) && key !== 'headers') hints.add('response');
        else if (PROMISE_OPS.has(key) && called) hints.add('promise');
        else if (ELEMENT_OPS.has(key)) hints.add('element');
        else if (key === 'addEventListener' || key === 'removeEventListener') hints.add('target');
        else if (STRING_OPS.has(key)) hints.add('string');
        else if (ARRAY_OPS.has(key)) hints.add('array');
        else if (key === 'length') hints.add('length');
        else if (key === 'send' || key === 'open' || key === 'readyState' || key === 'responseText') hints.add(key === 'send' ? 'sendable' : 'xhr');
        else hints.add('object');
        if (par.parentPath.isAssignmentExpression({ left: par.node })) hints.add('object');
      } else if (par.isCallExpression({ callee: r.node }) || par.isNewExpression({ callee: r.node })) {
        hints.add('function');
      } else if (par.isBinaryExpression() && (NUM_OPS.has(par.node.operator) || CMP_OPS.has(par.node.operator))) {
        hints.add('number');
      } else if (par.isUpdateExpression()) {
        hints.add('number');
      } else if (par.isMemberExpression({ property: r.node }) && par.node.computed) {
        hints.add('index');
      } else if (par.isUnaryExpression({ operator: '-' })) {
        hints.add('number');
      } else if (par.isBinaryExpression({ operator: '===' }) || par.isBinaryExpression({ operator: '==' })) {
        const other = par.node.left === r.node ? par.node.right : par.node.left;
        if (t.isStringLiteral(other)) hints.add('string');
        else if (t.isNumericLiteral(other)) hints.add('number');
      } else if (par.isCallExpression()) {
        const full = memberPath(par.node.callee);
        if (full === 'JSON.parse' || full === 'atob' || full === 'decodeURIComponent' || full === 'parseInt') hints.add('string');
        if (full === 'fetch' || full === 'document.getElementById' || full === 'document.querySelector') hints.add('string');
      }
    }
    if (hints.has('event')) return 'Event';
    if (hints.has('response')) return 'Response';
    if (hints.has('promise')) return 'Promise<unknown>';
    if (hints.has('element')) return 'HTMLElement';
    if (hints.has('xhr') || hints.has('sendable')) return hints.has('xhr') ? 'XMLHttpRequest' : U;
    if (hints.has('target')) return 'EventTarget';
    if (hints.has('array')) return 'unknown[]';
    if (hints.has('string')) return 'string';
    if (hints.has('length') && hints.has('indexed')) return 'unknown[] | string';
    if (hints.has('function') && hints.size === 1) return 'Function';
    if (hints.has('number') || hints.has('index')) return hints.size === 1 || (hints.size === 2 && hints.has('index')) ? 'number' : U;
    if (hints.has('object') && hints.size === 1) return 'Record<string, unknown>';
    return null;
  }

  return { expr, fn, binding, fnSignature };
}

function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if ('<({['.includes(ch)) depth++;
    else if ('>)}]'.includes(ch)) depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// ── .d.ts üretimi ────────────────────────────────────────

const sig = (s) => `(${s.params.map((p) => `${p.name.replace(/^\.\.\./, '...')}${p.optional ? '?' : ''}: ${p.type}`).join(', ')})`;

/** Programın üst düzey bildirimleri için .d.ts metni */
export function toDts(ast) {
  const inf = createInferer();
  const lines = ['// PEEL tarafından kullanımdan çıkarılan tipler', ''];
  const isModule = ast.program.sourceType === 'module';
  traverse(ast, {
    Program(p) {
      for (const st of p.get('body')) {
        const exported = st.isExportNamedDeclaration() || st.isExportDefaultDeclaration();
        const decl = exported ? st.get('declaration') : st;
        if (!decl?.node) continue;
        const prefix = isModule ? (exported ? 'export declare' : 'declare') : 'declare';
        if (decl.isFunctionDeclaration() && decl.node.id) {
          const s = inf.fn(decl);
          lines.push(`${prefix} function ${decl.node.id.name}${sig(s)}: ${s.returns};`);
        } else if (decl.isVariableDeclaration()) {
          for (const d of decl.get('declarations')) {
            if (!d.get('id').isIdentifier()) continue;
            const b = d.scope.getBinding(d.node.id.name);
            const ty = b ? inf.binding(b) : U;
            lines.push(`${prefix} ${decl.node.kind} ${d.node.id.name}: ${ty};`);
          }
        } else if (decl.isClassDeclaration() && decl.node.id) {
          lines.push(...classDts(decl, inf, prefix));
        }
      }
      p.stop();
    },
  });
  return `${lines.join('\n')}\n`;
}

function classDts(cls, inf, prefix) {
  const out = [`${prefix} class ${cls.node.id.name} {`];
  const fields = new Map();
  for (const m of cls.get('body.body')) {
    if (m.isClassMethod() && m.node.kind === 'constructor') {
      m.traverse({
        Function(q) { if (!q.isArrowFunctionExpression()) q.skip(); },
        AssignmentExpression(q) {
          const l = q.node.left;
          if (t.isMemberExpression(l) && t.isThisExpression(l.object) && !l.computed && t.isIdentifier(l.property) && !fields.has(l.property.name)) {
            fields.set(l.property.name, inf.expr(q.get('right')));
          }
        },
      });
    }
  }
  for (const [k, ty] of fields) out.push(`  ${k}: ${ty};`);
  for (const m of cls.get('body.body')) {
    if (!m.isClassMethod() || m.node.computed || !t.isIdentifier(m.node.key)) continue;
    const s = inf.fn(m);
    const st = m.node.static ? 'static ' : '';
    if (m.node.kind === 'constructor') out.push(`  constructor${sig(s)};`);
    else if (m.node.kind === 'get') out.push(`  ${st}get ${m.node.key.name}(): ${s.returns};`);
    else if (m.node.kind === 'set') out.push(`  ${st}set ${m.node.key.name}${sig(s)};`);
    else out.push(`  ${st}${m.node.key.name}${sig(s)}: ${s.returns};`);
  }
  out.push('}');
  return out;
}
