import * as t from '@babel/types';

// Kural tabanlı ad önerisi (72). Ağ yok, model yok: yalnızca kullanım kanıtı.
// E222 callback parametreleri, E223 tip tabanlı isimler, E224 fonksiyon fiilleri, E225 DOM elemanları, E226 olay işleyicileri.

const propKey = (m) => (!m.computed && t.isIdentifier(m.property) ? m.property.name
  : t.isStringLiteral(m.property) ? m.property.value : null);
const memberPath = (n) => {
  if (t.isIdentifier(n)) return n.name;
  if (t.isMemberExpression(n)) {
    const k = propKey(n);
    const o = memberPath(n.object);
    return o && k ? `${o}.${k}` : null;
  }
  return null;
};

/** "login-btn" / "user_name" / "#nav .menu" → loginBtn / userName / navMenu */
export function camel(text, max = 3) {
  const words = String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w && /^[A-Za-z]/.test(w))
    .slice(0, max);
  if (!words.length) return null;
  return words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
}
const pascal = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function singular(name) {
  if (!name) return 'item';
  if (/ies$/.test(name)) return name.replace(/ies$/, 'y');
  if (/(ss|sh|ch|x)es$/.test(name)) return name.replace(/es$/, '');
  if (/[^s]s$/.test(name) && name.length > 3) return name.slice(0, -1);
  if (/List$|Array$|Arr$/.test(name)) return name.replace(/List$|Array$|Arr$/, '') || 'item';
  return 'item';
}

// URL ya da yoldan anlamlı son parça: https://x.com/api/user/list?x → userList
function urlNoun(s) {
  try {
    const u = new URL(s, 'http://x.invalid');
    const segs = u.pathname.split('/').filter((x) => /^[A-Za-z][\w-]*$/.test(x) && !/^(api|v\d+|index|php|html?)$/i.test(x));
    return camel(segs.slice(-2).join(' '), 2);
  } catch {
    return null;
  }
}

// String içeriğinden ad (72: string contents)
export function nameFromString(s) {
  if (/^(?:https?|wss?):\/\//i.test(s)) return 'url';
  if (/^\/[\w-]+(\/[\w.-]+)*\/?(\?.*)?$/.test(s) && s.length > 1) return 'endpoint';
  if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(s)) return 'email';
  if (/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(s)) return 'method';
  if (/^(application|text|image|audio|video|multipart)\/[\w.+-]+/.test(s)) return 'contentType';
  if (/^(click|dblclick|keydown|keyup|keypress|mousedown|mouseup|mousemove|submit|change|input|load|unload|beforeunload|scroll|resize|focus|blur|message|touchstart|touchend)$/.test(s)) return 'eventName';
  if (/^[#.][\w-]+([\s>+~]*[#.]?[\w-]+)*$/.test(s)) return 'selector';
  if (/^[A-Za-z0-9+/]{24,}={0,2}$/.test(s)) return 'encoded';
  if (/^[0-9a-f]{16,}$/i.test(s)) return 'hexKey';
  if (/^\d+(\.\d+)*$/.test(s)) return 'version';
  if (/^[A-Za-z][A-Za-z ]{1,24}$/.test(s)) {
    const c = camel(s, 3);
    return c && c.length >= 3 ? `${c}Text` : null;
  }
  return null;
}

// Bilinen çağrıların sonuç adları
const CALL_NAMES = {
  fetch: 'response', 'JSON.parse': 'data', 'JSON.stringify': 'json', atob: 'decoded', btoa: 'encoded',
  encodeURIComponent: 'encoded', decodeURIComponent: 'decoded', escape: 'escaped', unescape: 'unescaped',
  parseInt: 'num', parseFloat: 'num', Number: 'num', String: 'str', 'Math.random': 'rand', 'Math.floor': 'floored',
  'Math.round': 'rounded', 'Math.max': 'max', 'Math.min': 'min', 'Math.abs': 'abs', 'Date.now': 'now', 'performance.now': 'now',
  setTimeout: 'timer', setInterval: 'interval', requestAnimationFrame: 'frameId', 'Object.keys': 'keys',
  'Object.values': 'values', 'Object.entries': 'entries', 'Object.assign': 'merged', 'Object.create': 'obj',
  'String.fromCharCode': 'char', 'Array.from': 'list', 'Array.isArray': 'isArray', 'Promise.all': 'results',
  'navigator.sendBeacon': 'sent', 'crypto.getRandomValues': 'randomBytes', 'crypto.randomUUID': 'uuid',
  'document.createTextNode': 'textNode', 'window.open': 'popup', 'document.cookie': 'cookie',
};
const METHOD_NAMES = {
  split: 'parts', join: 'joined', map: 'mapped', filter: 'filtered', reduce: 'total', slice: 'part', substring: 'part',
  substr: 'part', indexOf: 'index', lastIndexOf: 'index', findIndex: 'index', charCodeAt: 'code', codePointAt: 'code',
  charAt: 'char', toString: 'str', toLowerCase: 'lower', toUpperCase: 'upper', trim: 'trimmed', replace: 'replaced',
  match: 'match', exec: 'match', test: 'matches', includes: 'found', find: 'found', some: 'hasAny', every: 'all',
  concat: 'combined', json: 'data', text: 'text', getContext: 'ctx', getBoundingClientRect: 'rect', toDataURL: 'dataUrl',
  cloneNode: 'clone', pop: 'last', shift: 'first', keys: 'keys', values: 'values', entries: 'entries', then: 'promise',
  toFixed: 'fixed', getAttribute: 'attr', getTime: 'time', toISOString: 'isoDate', push: 'length', sort: 'sorted',
  reverse: 'reversed', flat: 'flat', fill: 'filled', padStart: 'padded', padEnd: 'padded', repeat: 'repeated',
  getItem: 'stored', createElement: 'el', querySelectorAll: 'nodes', querySelector: 'el', getElementById: 'el',
  getElementsByTagName: 'nodes', getElementsByClassName: 'nodes', open: 'opened', getRandomValues: 'randomBytes',
};
const CTOR_NAMES = {
  XMLHttpRequest: 'xhr', WebSocket: 'socket', Date: 'date', RegExp: 'regex', Image: 'img', Audio: 'audio', Map: 'map', Set: 'set',
  WeakMap: 'weakMap', Promise: 'promise', URL: 'url', URLSearchParams: 'params', FormData: 'formData', Uint8Array: 'bytes',
  Uint16Array: 'words', Uint32Array: 'words', Int32Array: 'ints', Float64Array: 'floats', ArrayBuffer: 'buffer', DataView: 'view',
  Blob: 'blob', Worker: 'worker', AudioContext: 'audioCtx', OfflineAudioContext: 'audioCtx', TextEncoder: 'encoder',
  TextDecoder: 'decoder', MutationObserver: 'observer', Headers: 'headers', Error: 'error', TypeError: 'error',
  EventSource: 'eventSource', RTCPeerConnection: 'peer', Array: 'list', Object: 'obj', Function: 'fn',
};
const TYPE_NAMES = {
  number: 'num', string: 'str', boolean: 'flag', 'unknown[]': 'list', 'Record<string, unknown>': 'obj', Function: 'callback',
  HTMLElement: 'el', Element: 'el', Event: 'event', 'Promise<unknown>': 'promise', Response: 'response', RegExp: 'regex',
  Date: 'date', XMLHttpRequest: 'xhr', EventTarget: 'target', 'Promise<Response>': 'responsePromise', Document: 'doc',
  'string[]': 'strings', 'number[]': 'numbers', 'HTMLElement | null': 'el', 'Element | null': 'el', 'NodeListOf<Element>': 'nodes',
  'unknown[] | string': 'seq', WebSocket: 'socket', Window: 'win', Map: 'map', 'Map<unknown, unknown>': 'map', 'Set<unknown>': 'set',
  'string | null': 'value', Uint8Array: 'bytes', ArrayBuffer: 'buffer',
};

// Callback parametre adları (E222): alıcının metoduna göre
const CALLBACK_PARAMS = {
  forEach: ['$item', 'index', 'array'], map: ['$item', 'index', 'array'], filter: ['$item', 'index', 'array'],
  some: ['$item', 'index', 'array'], every: ['$item', 'index', 'array'], find: ['$item', 'index', 'array'],
  findIndex: ['$item', 'index', 'array'], flatMap: ['$item', 'index', 'array'],
  reduce: ['acc', '$item', 'index', 'array'], reduceRight: ['acc', '$item', 'index', 'array'], sort: ['a', 'b'],
  then: ['result'], catch: ['error'], finally: [], addEventListener: ['event'], removeEventListener: ['event'], on: ['event'],
  once: ['event'], replace: ['match', 'group1', 'group2', 'group3'], replaceAll: ['match', 'group1', 'group2', 'group3'],
};

const EVENT_PROPS = { onclick: 'click', onload: 'load', onerror: 'error', onsubmit: 'submit', onchange: 'change',
  oninput: 'input', onkeydown: 'keydown', onkeyup: 'keyup', onmessage: 'message', onreadystatechange: 'readyStateChange',
  onmousemove: 'mouseMove', onmousedown: 'mouseDown', onmouseup: 'mouseUp', onscroll: 'scroll', onresize: 'resize',
  onopen: 'open', onclose: 'close', onbeforeunload: 'beforeUnload', onfocus: 'focus', onblur: 'blur' };

// Alıcı ifadeden çoğul isim: users.forEach → users
function receiverName(node) {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node)) return propKey(node);
  if (t.isCallExpression(node) && t.isMemberExpression(node.callee)) {
    const k = propKey(node.callee);
    if (k === 'querySelectorAll' || k === 'getElementsByTagName' || k === 'getElementsByClassName') {
      const sel = node.arguments[0];
      if (t.isStringLiteral(sel)) {
        const c = camel(sel.value.replace(/^[#.]/, ''), 2);
        return c ? `${c}s` : 'nodes';
      }
      return 'nodes';
    }
    if (k === 'keys' || k === 'values' || k === 'entries') return k;
    if (k === 'split') return 'parts';
  }
  return null;
}

// fetch/çağrı argümanındaki ilk string: fetch("/api/user") → user
function firstString(fnPath) {
  let found = null;
  fnPath.traverse({
    Function(p) { p.skip(); },
    StringLiteral(p) { if (!found && (/^(https?:)?\//.test(p.node.value))) { found = p.node.value; p.stop(); } },
  });
  return found;
}

// DOM elemanı adı (E225): getElementById("login-btn") → loginBtn; querySelector(".nav-menu") → navMenu
function domName(call) {
  const k = t.isMemberExpression(call.callee) ? propKey(call.callee) : null;
  const arg = call.arguments[0];
  if (!k || !t.isStringLiteral(arg)) return null;
  const v = arg.value;
  if (k === 'getElementById') return camel(v, 3);
  if (k === 'querySelector') {
    const last = v.trim().split(/[\s>+~]+/).pop() ?? '';
    const idm = /#([\w-]+)/.exec(last);
    if (idm) return camel(idm[1], 3);
    const cls = /\.([\w-]+)/.exec(last);
    if (cls) return camel(cls[1], 3);
    const attr = /\[name=["']?([\w-]+)/.exec(last);
    if (attr) return `${camel(attr[1], 2)}Input`;
    const tag = /^([a-z]+\d?)/i.exec(last);
    return tag ? `${tag[1].toLowerCase()}El` : null;
  }
  if (k === 'querySelectorAll' || k === 'getElementsByClassName' || k === 'getElementsByTagName') {
    const c = camel(v.replace(/^[#.]/, '').split(/[\s>+~]+/).pop() ?? '', 2);
    return c ? `${c}${/s$/.test(c) ? 'List' : 's'}` : null;
  }
  if (k === 'createElement') return `${v.toLowerCase()}El`;
  if (k === 'getElementsByName') return `${camel(v, 2)}Inputs`;
  return null;
}

// Fonksiyon adı (E224 fiil + isim, E226 olay)
function functionName(fnPath, binding, inf) {
  // E226: olay işleyicisi olarak kaydedilen fonksiyon
  for (const r of binding?.referencePaths ?? []) {
    const par = r.parentPath;
    if (par.isCallExpression() && par.node.arguments[1] === r.node && t.isMemberExpression(par.node.callee) &&
      propKey(par.node.callee) === 'addEventListener' && t.isStringLiteral(par.node.arguments[0])) {
      return { name: `on${pascal(camel(par.node.arguments[0].value, 2) ?? 'Event')}`, reason: `"${par.node.arguments[0].value}" olayı işleyicisi` };
    }
    if (par.isAssignmentExpression({ right: r.node }) && t.isMemberExpression(par.node.left)) {
      const k = propKey(par.node.left);
      if (k && Object.hasOwn(EVENT_PROPS, k.toLowerCase())) return { name: `on${pascal(EVENT_PROPS[k.toLowerCase()])}`, reason: `${k} işleyicisi` };
    }
    if (par.isNewExpression({ callee: r.node })) {
      const cls = classNoun(fnPath);
      return { name: cls, reason: 'new ile çağrılıyor (kurucu)' };
    }
  }

  const facts = { calls: new Set(), members: new Set(), thisWrites: 0, returnsBool: true, returns: 0, strings: [], throws: false, dom: 0 };
  fnPath.traverse({
    Function(p) { if (!p.isArrowFunctionExpression()) p.skip(); },
    CallExpression(p) {
      const full = memberPath(p.node.callee);
      if (full) facts.calls.add(full);
      if (t.isMemberExpression(p.node.callee)) { const k = propKey(p.node.callee); if (k) facts.members.add(k); }
    },
    NewExpression(p) { if (t.isIdentifier(p.node.callee)) facts.calls.add(`new ${p.node.callee.name}`); },
    AssignmentExpression(p) {
      const l = p.node.left;
      if (t.isMemberExpression(l) && t.isThisExpression(l.object)) facts.thisWrites++;
      if (t.isMemberExpression(l)) {
        const k = propKey(l);
        if (k === 'innerHTML' || k === 'textContent' || k === 'innerText' || k === 'src' || k === 'href') facts.dom++;
        if (k === 'cookie') facts.calls.add('document.cookie=');
        if (k) facts.members.add(`${k}=`);
      }
    },
    ReturnStatement(p) {
      if (p.getFunctionParent() !== fnPath) return;
      facts.returns++;
      const ty = p.node.argument ? inf.expr(p.get('argument')) : 'undefined';
      if (ty !== 'boolean') facts.returnsBool = false;
    },
    ThrowStatement() { facts.throws = true; },
  });
  const calls = [...facts.calls];
  const has = (re) => calls.some((c) => re.test(c));
  const mem = (k) => facts.members.has(k);
  const url = firstString(fnPath);
  const noun = url ? urlNoun(url) : null;
  const N = noun ? pascal(noun) : '';
  const sigInfo = inf.fn(fnPath);

  if (has(/^fetch$|^new XMLHttpRequest$|\.ajax$|^axios/)) {
    return { name: mem('send') && !mem('json') && !mem('responseText') ? `send${N || 'Data'}` : `fetch${N || 'Data'}`, reason: 'ağ isteği yapıyor' };
  }
  if (has(/sendBeacon$/) || (mem('send') && has(/^new WebSocket$/))) return { name: `send${N || 'Data'}`, reason: 'veri gönderiyor' };
  if (has(/^new WebSocket$/)) return { name: 'connectSocket', reason: 'WebSocket açıyor' };
  if (has(/(local|session)Storage\.setItem$/) || has(/^document\.cookie=$/)) return { name: 'saveState', reason: 'kalıcı depolamaya yazıyor' };
  if (has(/(local|session)Storage\.getItem$/)) return { name: 'loadState', reason: 'kalıcı depolamadan okuyor' };
  if (has(/addEventListener$/)) return { name: 'bindEvents', reason: 'olay dinleyicisi ekliyor' };
  if (has(/createElement$/) && (mem('appendChild') || mem('append') || mem('insertBefore'))) return { name: 'renderElement', reason: 'DOM elemanı oluşturup ekliyor' };
  if (facts.dom) return { name: 'render', reason: 'DOM içeriğini güncelliyor' };
  if (has(/^(atob|decodeURIComponent|unescape)$/) || (mem('charCodeAt') && has(/String\.fromCharCode$/))) return { name: 'decode', reason: 'string çözüyor' };
  if (has(/^(btoa|encodeURIComponent|escape)$/)) return { name: 'encode', reason: 'string kodluyor' };
  if (has(/^JSON\.parse$/)) return { name: 'parse', reason: 'JSON ayrıştırıyor' };
  if (has(/^JSON\.stringify$/)) return { name: 'serialize', reason: 'JSON üretiyor' };
  if (facts.returns && facts.returnsBool) {
    const p0 = sigInfo.params[0];
    return { name: p0 && /^[a-z]+$/i.test(p0.name) && p0.name.length > 2 ? `is${pascal(p0.name)}Valid` : 'check', reason: 'boolean döndürüyor' };
  }
  if (facts.throws && !facts.returns) return { name: 'assert', reason: 'yalnızca hata fırlatıyor' };
  if (facts.thisWrites >= 2 && !facts.returns) return { name: classNoun(fnPath), reason: 'this alanlarını kuruyor' };
  const ret = sigInfo.returns;
  if (/^\{ /.test(ret)) return { name: 'create', reason: 'nesne döndürüyor' };
  if (ret === 'string') return { name: has(/\.join$/) || mem('join') ? 'buildString' : 'format', reason: 'string döndürüyor' };
  if (ret === 'number' && (has(/^Math\./) || fnPath.node.params.length)) return { name: 'compute', reason: 'sayı hesaplıyor' };
  if (/\[\]$/.test(ret)) return { name: 'collect', reason: 'dizi döndürüyor' };
  if (/^Promise</.test(ret)) return { name: 'load', reason: 'Promise döndürüyor' };
  if (has(/setTimeout$|setInterval$/)) return { name: 'schedule', reason: 'zamanlayıcı kuruyor' };
  if (has(/console\./) && calls.length === 1) return { name: 'log', reason: 'yalnızca konsola yazıyor' };
  if (fnPath.node.params.length === 0 && ret === 'void' && calls.length) return { name: 'init', reason: 'parametresiz, yan etkili' };
  return null;
}

function classNoun(fnPath) {
  let n = null;
  fnPath.traverse({
    AssignmentExpression(p) {
      if (n) return;
      const l = p.node.left;
      if (t.isMemberExpression(l) && t.isThisExpression(l.object) && /^(name|type|kind)$/.test(propKey(l) ?? '') && t.isStringLiteral(p.node.right)) n = camel(p.node.right.value, 2);
    },
  });
  return n ? pascal(n) : 'Model';
}

// Fiil kaldırılmış isim: getUser → user, fetchItems → items
function nounOfCallee(name) {
  const m = /^(get|fetch|load|read|create|build|make|parse|compute|calc|find|select|query|new|init)([A-Z][\w$]*)$/.exec(name);
  if (m) return m[2][0].toLowerCase() + m[2].slice(1);
  return null;
}

// Başlangıç değerinden ad
function nameFromInit(init, initPath, inf) {
  if (!init) return null;
  if (t.isAwaitExpression(init)) return nameFromInit(init.argument, initPath.get('argument'), inf);
  if (t.isStringLiteral(init)) { const n = nameFromString(init.value); return n ? { name: n, reason: 'string içeriği' } : null; }
  if (t.isTemplateLiteral(init)) return { name: 'text', reason: 'şablon string' };
  if (t.isRegExpLiteral(init)) return { name: 'regex', reason: 'düzenli ifade' };
  if (t.isArrayExpression(init)) return init.elements.every((e) => t.isStringLiteral(e)) && init.elements.length > 1
    ? { name: 'strings', reason: 'string dizisi' } : null;
  if (t.isNewExpression(init) && t.isIdentifier(init.callee)) {
    const c = init.callee.name;
    if (Object.hasOwn(CTOR_NAMES, c) && !initPath.scope.getBinding(c)) return { name: CTOR_NAMES[c], reason: `new ${c}` };
    if (/^[A-Z]/.test(c)) return { name: c[0].toLowerCase() + c.slice(1), reason: `${c} örneği` };
  }
  if (t.isCallExpression(init)) {
    const dom = domName(init);
    if (dom) return { name: dom, reason: 'DOM seçicisi' };
    const full = memberPath(init.callee);
    if (full && Object.hasOwn(CALL_NAMES, full)) return { name: CALL_NAMES[full], reason: `${full}() sonucu` };
    if (t.isMemberExpression(init.callee)) {
      const k = propKey(init.callee);
      if ((k === 'getItem') && t.isStringLiteral(init.arguments[0])) {
        const c = camel(init.arguments[0].value, 3);
        if (c) return { name: c, reason: 'depolama anahtarı' };
      }
      if (k === 'getAttribute' && t.isStringLiteral(init.arguments[0])) {
        const c = camel(init.arguments[0].value.replace(/^data-/, ''), 3);
        if (c) return { name: c, reason: 'öznitelik adı' };
      }
      if (k === 'getContext') return { name: t.isStringLiteral(init.arguments[0], { value: '2d' }) ? 'ctx' : 'gl', reason: 'canvas bağlamı' };
      if (k && Object.hasOwn(METHOD_NAMES, k)) return { name: METHOD_NAMES[k], reason: `.${k}() sonucu` };
    }
    if (t.isIdentifier(init.callee)) {
      const noun = nounOfCallee(init.callee.name);
      if (noun) return { name: noun, reason: `${init.callee.name}() sonucu` };
    }
  }
  if (t.isMemberExpression(init)) {
    const k = propKey(init);
    if (k === 'length') return { name: 'count', reason: '.length' };
    if (k && /^[A-Za-z][A-Za-z0-9]{2,}$/.test(k)) return { name: k, reason: `.${k} değeri` };
  }
  if (t.isBinaryExpression(init) || t.isUnaryExpression(init) || t.isLogicalExpression(init) || t.isConditionalExpression(init)) {
    const ty = inf.expr(initPath);
    if (ty === 'boolean') return { name: 'isMatch', reason: 'karşılaştırma sonucu' };
  }
  return null;
}

/**
 * Binding için ad önerisi: { name, reason } ya da null.
 * inf: createInferer() sonucu.
 */
export function suggestName(binding, inf) {
  const p = binding.path;
  // Fonksiyonlar
  if (p.isFunctionDeclaration()) return functionName(p, binding, inf);
  if (p.isVariableDeclarator() && (t.isFunctionExpression(p.node.init) || t.isArrowFunctionExpression(p.node.init))) {
    return functionName(p.get('init'), binding, inf);
  }
  if (p.isClassDeclaration()) return null;

  // E222: callback parametresi
  if (binding.kind === 'param') {
    const fn = binding.scope.path;
    const idx = fn.node.params.findIndex((x) => t.isIdentifier(x, { name: binding.identifier.name }));
    const call = fn.parentPath;
    if (idx >= 0 && call?.isCallExpression() && call.node.arguments.includes(fn.node) && t.isMemberExpression(call.node.callee)) {
      const k = propKey(call.node.callee);
      const names = k && CALLBACK_PARAMS[k];
      if (names && idx < names.length) {
        let name = names[idx];
        if (name === '$item') name = singular(receiverName(call.node.callee.object));
        if (name === 'result' && t.isCallExpression(call.node.callee.object) && memberPath(call.node.callee.object.callee) === 'fetch') name = 'response';
        if (name === 'event' && t.isStringLiteral(call.node.arguments[0])) {
          const ev = call.node.arguments[0].value;
          if (/^key/.test(ev)) name = 'keyEvent';
          else if (/^(mouse|click|dblclick)/.test(ev)) name = 'mouseEvent';
          else if (ev === 'message') name = 'messageEvent';
        }
        return { name, reason: `.${k}() callback parametresi` };
      }
    }
    if (idx >= 0 && call?.isNewExpression() && t.isIdentifier(call.node.callee, { name: 'Promise' }) && idx < 2) {
      return { name: idx ? 'reject' : 'resolve', reason: 'Promise yürütücüsü' };
    }
    if (idx >= 0 && call?.isCallExpression() && t.isIdentifier(call.node.callee) &&
      /^(setTimeout|setInterval|requestAnimationFrame)$/.test(call.node.callee.name) && idx === 0 && call.node.callee.name === 'requestAnimationFrame') {
      return { name: 'timestamp', reason: 'requestAnimationFrame callback' };
    }
  }

  // for (var i = 0; …; i++) sayaçları
  if (p.isVariableDeclarator() && p.parentPath.parentPath?.isForStatement({ init: p.parent })) {
    const depth = p.findParent((x) => x.isFunction() || x.isProgram()) ? countForAncestors(p) : 0;
    return { name: ['i', 'j', 'k'][Math.min(depth, 2)], reason: 'döngü sayacı' };
  }

  // Başlangıç değeri
  if (p.isVariableDeclarator() && p.node.init) {
    const r = nameFromInit(p.node.init, p.get('init'), inf);
    if (r) return r;
  }
  // İlk atama
  const assign = binding.constantViolations.find((v) => v.isAssignmentExpression({ operator: '=' }) && t.isIdentifier(v.node.left));
  if (assign) {
    const r = nameFromInit(assign.node.right, assign.get('right'), inf);
    if (r) return r;
  }

  // E223: tip tabanlı ad
  const ty = inf.binding(binding);
  if (Object.hasOwn(TYPE_NAMES, ty)) {
    let name = TYPE_NAMES[ty];
    if (ty === 'number' && binding.referencePaths.some((r) => r.parentPath.isMemberExpression({ property: r.node }) && r.parent.computed)) name = 'index';
    else if (ty === 'number' && binding.constantViolations.some((v) => v.isUpdateExpression())) name = 'count';
    return { name, reason: `tip: ${ty}` };
  }
  if (/^[A-Z][\w$]*$/.test(ty)) return { name: ty[0].toLowerCase() + ty.slice(1), reason: `tip: ${ty}` };
  if (/^HTML\w*Element$/.test(ty)) return { name: 'el', reason: `tip: ${ty}` };
  if (/\[\]$/.test(ty)) return { name: 'list', reason: `tip: ${ty}` };
  if (/^\{ /.test(ty)) return { name: 'options', reason: 'nesne' };
  if (/=>/.test(ty)) return { name: 'callback', reason: 'fonksiyon' };
  return null;
}

function countForAncestors(p) {
  let n = 0;
  for (let x = p.parentPath.parentPath.parentPath; x && !x.isFunction() && !x.isProgram(); x = x.parentPath) {
    if (x.isForStatement()) n++;
  }
  return n;
}
