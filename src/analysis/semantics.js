import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { ownerOf } from './defs.js';

// E502–E540 statik semantik modeli. Her bölüm: modelin kendisi (dışa aktarılan yardımcılar) + programdaki
// kullanım yerleri ve analize etkisi. Satır/sütun bilgisi rapor içindir.

const MAX = 40;
const at = (p, extra = {}) => ({ line: p.node.loc?.start.line ?? null, col: p.node.loc?.start.column ?? null, ...extra });
const push = (list, item) => { if (list.length < MAX) list.push(item); };
const memberName = (n) => {
  if (!t.isMemberExpression(n) && !t.isOptionalMemberExpression(n)) return null;
  if (!n.computed && t.isIdentifier(n.property)) return n.property.name;
  if (t.isStringLiteral(n.property)) return n.property.value;
  return null;
};
const fullName = (n) => {
  if (t.isIdentifier(n)) return n.name;
  if (t.isThisExpression(n)) return 'this';
  const m = memberName(n);
  if (m === null) return null;
  const o = fullName(n.object);
  return o ? `${o}.${m}` : null;
};
const isGlobalRef = (p, name) => t.isIdentifier(p.node, { name }) && !p.scope.getBinding(name);
const calleeName = (p) => fullName(p.node.callee);

// ---------------------------------------------------------------- E502 sıkı/gevşek mod
const hasUseStrict = (node) => (node.directives ?? []).some((d) => d.value.value === 'use strict');

/** Yolun çalıştığı kodun sıkı modda olup olmadığı (modül, sınıf gövdesi, "use strict" yönergesi). */
export function isStrict(path) {
  for (let p = path; p; p = p.parentPath) {
    if (p.isProgram()) return p.node.sourceType === 'module' || hasUseStrict(p.node);
    if (p.isClass()) return true;
    if (p.isFunction() && t.isBlockStatement(p.node.body) && hasUseStrict(p.node.body)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- E506 özellik anahtarı sırası
/**
 * OrdinaryOwnPropertyKeys modeli: önce dizi indeksleri (artan), sonra string anahtarlar (ekleme sırası),
 * en son symbol anahtarlar. Literal nesne için; hesaplanmış anahtar bilinmiyorsa null.
 */
export function ownKeysOrder(objectNode) {
  const keys = [];
  const add = (k) => { if (!keys.some((x) => x.key === k.key && x.symbol === k.symbol)) keys.push(k); };
  for (const p of objectNode.properties) {
    if (t.isSpreadElement(p)) return null;
    if (!p.computed) {
      const k = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : t.isNumericLiteral(p.key) ? String(p.key.value) : null;
      if (k === null) return null;
      if (k === '__proto__' && t.isObjectProperty(p) && !p.shorthand) continue; // prototype atar, anahtar değil
      add({ key: k, symbol: false });
    } else if (t.isMemberExpression(p.key) && t.isIdentifier(p.key.object, { name: 'Symbol' }) && !p.key.computed) {
      add({ key: `Symbol.${p.key.property.name}`, symbol: true });
    } else if (t.isStringLiteral(p.key)) {
      add({ key: p.key.value, symbol: false });
    } else if (t.isNumericLiteral(p.key)) {
      add({ key: String(p.key.value), symbol: false });
    } else return null;
  }
  const isIndex = (k) => !k.symbol && /^(0|[1-9]\d*)$/.test(k.key) && Number(k.key) < 2 ** 32 - 1;
  return [
    ...keys.filter(isIndex).sort((a, b) => Number(a.key) - Number(b.key)),
    ...keys.filter((k) => !k.symbol && !isIndex(k)),
    ...keys.filter((k) => k.symbol),
  ].map((k) => k.key);
}

const WELL_KNOWN = {
  iterator: 'for-of/yayma/destructuring yineleyicisi', asyncIterator: 'for await yineleyicisi',
  toPrimitive: 'ToPrimitive dönüşümü (E501 modelini devre dışı bırakır)', hasInstance: 'instanceof davranışı',
  toStringTag: 'Object.prototype.toString etiketi', species: 'türetilmiş nesne kurucusu', unscopables: 'with kapsamından gizleme',
  isConcatSpreadable: 'concat yayma', match: 'String#match/startsWith davranışı', matchAll: 'String#matchAll',
  replace: 'String#replace', search: 'String#search', split: 'String#split',
};

// ---------------------------------------------------------------- E508 with kapsamı
/**
 * with gövdesindeki tanımlayıcının çözümü: 'property' (nesnenin kesin bilinen özelliği),
 * 'binding' (nesnede kesin yok → normal kapsam), 'dynamic' (çalışma anına bağlı).
 * Literal nesne başka yerde tutulmuyorsa anahtarları sabittir; Object.prototype adları da özelliğe çözülür.
 */
export function resolveInWith(identPath) {
  const w = identPath.findParent((p) => p.isWithStatement() || p.isFunction());
  if (!w || !w.isWithStatement() || !identPath.findParent((p) => p === w.get('body'))) return 'binding';
  // iç içe with: içten dışa
  const obj = w.node.object;
  const name = identPath.node.name;
  let own = 'dynamic';
  if (t.isObjectExpression(obj)) {
    const keys = ownKeysOrder(obj);
    const hasProto = obj.properties.some((p) => t.isObjectProperty(p) && !p.computed && t.isIdentifier(p.key, { name: '__proto__' }));
    const unscopables = keys?.includes('Symbol.unscopables');
    if (keys && !hasProto && !unscopables) {
      if (keys.includes(name) || Object.hasOwn(Object.prototype, name)) return 'property';
      own = 'binding';
    }
  }
  if (own === 'dynamic') return 'dynamic';
  const outer = resolveInWith(w);
  return outer === 'binding' ? 'binding' : outer;
}

// ---------------------------------------------------------------- E511 modül ad alanı
/** Modül ad alanı nesnesinin anahtarları: dışa aktarılan adlar kod birimi sırasıyla (spec: SortCompare yok, code unit). */
export function namespaceKeys(names) {
  return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------- E512 top-level await
/** Sandbox (betik modu) için üst seviye await'li programı async IIFE'ye sarar; import/export içeriyorsa null. */
export function wrapTopLevelAwait(code, ast) {
  if (ast.program.body.some((s) => t.isImportDeclaration(s) || t.isExportDeclaration(s))) return null;
  return `(async () => {\n${code}\n})().catch((e) => { __out.push("!THROW " + (e && e.message)); });`;
}

// ---------------------------------------------------------------- E521 function.length
/** Fonksiyonun .length değeri: ilk varsayılanlı ya da rest parametreye kadarki parametre sayısı. */
export function functionLength(fnNode) {
  let n = 0;
  for (const p of fnNode.params) {
    if (t.isAssignmentPattern(p) || t.isRestElement(p)) break;
    if (t.isTSParameterProperty?.(p) && t.isAssignmentPattern(p.parameter)) break;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- E523/E524 sınıf başlatma sırası
const keyLabel = (m) => {
  if (t.isPrivateName(m.key)) return `#${m.key.id.name}`;
  if (m.computed) return '[hesaplanmış]';
  if (t.isIdentifier(m.key)) return m.key.name;
  if (t.isStringLiteral(m.key) || t.isNumericLiteral(m.key)) return String(m.key.value);
  return '?';
};

/**
 * Sınıf değerlendirme modeli (ES2022):
 *  tanım anı: extends → hesaplanmış anahtarlar (kaynak sırası) → yöntemler kurulur → statik alanlar ve statik bloklar (kaynak sırası)
 *  örnek: (türetilmişte super() döndükten hemen sonra, temelde kurucunun başında) özel yöntemler → alanlar (kaynak sırası) → kurucu gövdesi
 */
export function classInitOrder(classNode) {
  const members = classNode.body.body;
  const definition = [];
  const instance = [];
  if (classNode.superClass) definition.push('extends');
  for (const m of members) if (m.computed) definition.push(`hesaplanmış anahtar ${keyLabel(m)}`);
  for (const m of members) {
    if ((t.isClassMethod(m) || t.isClassPrivateMethod(m)) && m.kind !== 'constructor') definition.push(`${m.static ? 'statik ' : ''}yöntem ${keyLabel(m)}`);
  }
  let block = 0;
  for (const m of members) {
    if (t.isStaticBlock(m)) definition.push(`statik blok #${++block}`);
    else if ((t.isClassProperty(m) || t.isClassPrivateProperty(m) || t.isClassAccessorProperty(m)) && m.static) definition.push(`statik alan ${keyLabel(m)}`);
  }
  for (const m of members) if (t.isClassPrivateMethod(m) && !m.static) instance.push(`özel yöntem ${keyLabel(m)}`);
  const fields = members.filter((m) => (t.isClassProperty(m) || t.isClassPrivateProperty(m) || t.isClassAccessorProperty(m)) && !m.static);
  for (const f of fields) instance.push(`alan ${keyLabel(f)}`);
  instance.push(classNode.superClass ? 'kurucu gövdesi (super() sonrası kalan)' : 'kurucu gövdesi');
  // tehlike: alan başlatıcısı kendinden sonra tanımlanan alanı this.x ile okuyor → undefined
  const hazards = [];
  fields.forEach((f, i) => {
    if (!f.value) return;
    const later = new Set(fields.slice(i + 1).map(keyLabel));
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (t.isFunction(n)) return;
      if (t.isMemberExpression(n) && t.isThisExpression(n.object) && !n.computed) {
        const k = t.isPrivateName(n.property) ? `#${n.property.id.name}` : n.property.name;
        if (later.has(k)) hazards.push(`${keyLabel(f)} → this.${k} henüz tanımsız`);
      }
      for (const key of t.VISITOR_KEYS[n.type] ?? []) {
        const c = n[key];
        if (Array.isArray(c)) c.forEach(visit); else visit(c);
      }
    };
    visit(f.value);
  });
  return { definition, instance, hazards };
}

// ---------------------------------------------------------------- E525 dekoratörler
/**
 * 2023-05 dekoratör modeli: tüm dekoratör ifadeleri tanımda yukarıdan aşağı değerlendirilir; her öğede
 * dekoratörler alttan üste (içten dışa) uygulanır; önce statik olmayan/statik öğeler (kaynak sırası), en son sınıf dekoratörleri.
 */
export function decoratorOrder(classNode) {
  const evaluate = [];
  const apply = [];
  const label = (d) => fullName(t.isCallExpression(d.expression) ? d.expression.callee : d.expression) ?? 'ifade';
  for (const d of classNode.decorators ?? []) evaluate.push(`sınıf: @${label(d)}`);
  const members = classNode.body.body.filter((m) => m.decorators?.length);
  for (const m of members) for (const d of m.decorators) evaluate.push(`${keyLabel(m)}: @${label(d)}`);
  const order = [...members.filter((m) => !m.static), ...members.filter((m) => m.static)];
  for (const m of order) for (const d of [...m.decorators].reverse()) apply.push(`${m.static ? 'statik ' : ''}${keyLabel(m)}: @${label(d)}`);
  for (const d of [...(classNode.decorators ?? [])].reverse()) apply.push(`sınıf: @${label(d)}`);
  return { evaluate, apply };
}

// ---------------------------------------------------------------- E526–E528 düzenli ifadeler
const REDOS = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]|\((?:\.\*|\.\+)\)[+*]/;

/** Desenin motorlar arası farka açık özellikleri (V8 tarayıcı ↔ QuickJS sandbox). */
export function regexFeatures(source, flags) {
  const f = [];
  if (/\(\?<[=!]/.test(source)) f.push('lookbehind');
  const names = [...source.matchAll(/\(\?<([A-Za-z_$][\w$]*)>/g)].map((m) => m[1]);
  if (names.length) f.push('adlı grup');
  if (new Set(names).size !== names.length) f.push('yinelenen adlı grup');
  if (/\\[pP]\{/.test(source)) f.push(flags.includes('u') || flags.includes('v') ? 'unicode özellik kaçışı' : '\\p bayraksız (literal "p{")');
  if (flags.includes('v')) f.push('v bayrağı (küme notasyonu)');
  if (flags.includes('d')) f.push('d bayrağı (indeksler)');
  if (/\(\?[ims-]+:/.test(source)) f.push('satır içi değiştirici');
  if (!flags.includes('u') && !flags.includes('v') && (/(^|[^\\])\\[89]/.test(source) || /(^|[^\\[])\]/.test(source.replace(/\[(?:[^\]\\]|\\.)*\]/g, '')) || /(^|[^\\])\{(?!\d)/.test(source))) f.push('Annex B eski sözdizimi');
  if (REDOS.test(source)) f.push('iç içe niceleyici (geri izleme patlaması riski)');
  return f;
}

const PROPERTY_ESCAPE = /\\([pP])\{([^}]*)\}/g;

/** E527: \p{…} kaçışlarının listesi ve host motorundaki geçerliliği. */
export function unicodePropertyEscapes(source, flags) {
  const out = [];
  const unicode = flags.includes('u') || flags.includes('v');
  for (const m of source.matchAll(PROPERTY_ESCAPE)) {
    let valid = null;
    if (unicode) {
      try { new RegExp(`\\${m[1]}{${m[2]}}`, 'u'); valid = true; } catch { valid = false; }
    }
    const [name, value] = m[2].includes('=') ? m[2].split('=') : [m[2], null];
    out.push({ escape: m[0], negated: m[1] === 'P', name, value, unicode, valid, meaning: unicode ? 'özellik kümesi' : `literal "${m[1]}{${m[2]}}"` });
  }
  return out;
}

// ---------------------------------------------------------------- ana tarama
const TYPED = new Set(['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'DataView']);
const MICRO = new Set(['then', 'catch', 'finally', 'queueMicrotask']);
const MACRO = new Set(['setTimeout', 'setInterval', 'setImmediate', 'requestAnimationFrame', 'requestIdleCallback', 'MessageChannel', 'postMessage']);
const LOCAL_DATE = new Set(['getHours', 'getMinutes', 'getDate', 'getDay', 'getMonth', 'getFullYear', 'getYear', 'getTimezoneOffset',
  'setHours', 'setDate', 'setMonth', 'setFullYear', 'toDateString', 'toTimeString']);
const PROXY_TRAPS = new Set(['get', 'set', 'has', 'deleteProperty', 'apply', 'construct', 'ownKeys', 'getOwnPropertyDescriptor',
  'defineProperty', 'getPrototypeOf', 'setPrototypeOf', 'isExtensible', 'preventExtensions']);
const REALM_SOURCES = new Set(['contentWindow', 'contentDocument', 'ShadowRealm', 'frames', 'opener']);
const REALM_CHECKED = new Set(['Array', 'Object', 'Function', 'RegExp', 'Date', 'Error', 'Promise', 'Map', 'Set', 'ArrayBuffer']);

function effectful(fnPath) {
  let fx = false;
  fnPath.traverse({
    Function(p) { p.skip(); },
    'CallExpression|NewExpression|UpdateExpression|AssignmentExpression|AwaitExpression|YieldExpression'(p) {
      if (p.isAssignmentExpression() || p.isUpdateExpression()) {
        const target = p.isAssignmentExpression() ? p.node.left : p.node.argument;
        if (t.isIdentifier(target)) {
          const b = p.scope.getBinding(target.name);
          if (b && ownerOf(b.scope.path) === fnPath) return;
        }
      }
      fx = true;
      p.stop();
    },
  });
  return fx;
}

export function semanticsReport(ast) {
  const isModule = ast.program.sourceType === 'module';
  const r = {
    strict: { module: isModule, strictFunctions: 0, sloppyFunctions: 0, differences: [] },
    tdz: { sites: [] },
    accessors: { definitions: [], effectfulReads: [], names: [] },
    proxies: { sites: [] },
    symbols: { wellKnown: [], created: 0, keyed: 0, keyOrders: [] },
    privateFields: { classes: [], brandChecks: 0 },
    with: { statements: 0, resolution: { property: 0, binding: 0, dynamic: 0 }, samples: [] },
    eval: { direct: [], indirect: [], functionCtor: [], stringTimers: [] },
    realm: { sources: [], checks: [], freshNatives: [] },
    moduleNamespace: { imports: [], writes: [], ownExports: [], dynamicImports: 0 },
    topLevelAwait: { sites: [] },
    iterators: { sites: [], userIterators: [], earlyExits: [] },
    asyncIterators: { forAwait: [], asyncGenerators: 0, definitions: [] },
    thenables: { definitions: [], adoptions: [] },
    microtasks: { micro: 0, macro: 0, sources: [] },
    rejections: { candidates: [] },
    stackTraces: { reads: [], capture: [], prepare: [], limit: [], inspected: [] },
    callee: { sites: [] },
    functionProps: { lengths: [], callers: [], spoofed: [] },
    newTarget: { functions: [] },
    classes: { orders: [], staticBlocks: 0 },
    decorators: { classes: [] },
    regex: { patterns: [], stateful: [], lastIndex: [] },
    unicodeEscapes: { escapes: [] },
    time: { localDate: [], timezone: [], performance: [] },
    locale: { toLocale: [], intl: [] },
    typedArrays: { groups: [] },
    detached: { transfers: [], usesAfter: [] },
    shared: { sab: [], atomics: [] },
    weak: { weakRefs: [], registries: [] },
  };

  const strictCache = new WeakMap();
  const strictOf = (p) => {
    const fn = p.getFunctionParent() ?? p.scope.getProgramParent().path;
    if (!strictCache.has(fn.node)) strictCache.set(fn.node, isStrict(fn));
    return strictCache.get(fn.node);
  };
  const thenableNames = new Set();
  const regexVars = new Map(); // binding → { flags, line, uses }
  const bufferViews = new Map(); // tampon adı → [{ view, line, writes }]
  const viewOwner = new Map(); // görünüm binding → tampon adı
  const transferred = new Map(); // binding → transfer düğümü

  traverse(ast, {
    // ---------------- E502
    Function(p) {
      if (isStrict(p)) r.strict.strictFunctions++; else r.strict.sloppyFunctions++;
      const names = p.node.params.filter((x) => t.isIdentifier(x)).map((x) => x.name);
      if (new Set(names).size !== names.length) push(r.strict.differences, at(p, { construct: 'yinelenen parametre', strict: false }));
      // E522
      let usesNewTarget = false;
      p.traverse({
        Function(q) { if (!q.isArrowFunctionExpression()) q.skip(); },
        MetaProperty(q) { if (q.node.meta.name === 'new' && q.node.property.name === 'target') usesNewTarget = true; },
      });
      if (usesNewTarget && !p.isArrowFunctionExpression()) {
        const name = p.node.id?.name ?? (p.parentPath.isVariableDeclarator() ? p.parent.id.name : null);
        let withNew = 0;
        let withoutNew = 0;
        const b = name ? (p.isFunctionDeclaration() ? p.parentPath.scope.getBinding(name) : p.parentPath.scope.getBinding(name)) : null;
        for (const ref of b?.referencePaths ?? []) {
          if (ref.parentPath.isNewExpression({ callee: ref.node })) withNew++;
          else if (ref.parentPath.isCallExpression({ callee: ref.node })) withoutNew++;
        }
        push(r.newTarget.functions, at(p, { name: name ?? '(anonim)', withNew, withoutNew, isClassCtor: p.isClassMethod({ kind: 'constructor' }) }));
      }
      if (p.node.async && p.node.generator) r.asyncIterators.asyncGenerators++;
    },
    WithStatement(p) {
      push(r.strict.differences, at(p, { construct: 'with', strict: strictOf(p) }));
      r.with.statements++;
      p.get('body').traverse({
        Function(q) { q.skip(); },
        Identifier(q) {
          if (!q.isReferencedIdentifier() && !(q.parentPath.isAssignmentExpression({ left: q.node }))) return;
          const res = resolveInWith(q);
          r.with.resolution[res]++;
          push(r.with.samples, at(q, { name: q.node.name, resolution: res }));
        },
      });
    },
    NumericLiteral(p) {
      if (/^0\d/.test(p.node.extra?.raw ?? '')) push(r.strict.differences, at(p, { construct: 'eski sekizlik literal', strict: strictOf(p) }));
    },
    StringLiteral(p) {
      if (/\\(?:[1-7]|0\d)/.test(p.node.extra?.raw ?? '')) push(r.strict.differences, at(p, { construct: 'sekizlik kaçış', strict: strictOf(p) }));
    },
    UnaryExpression(p) {
      if (p.node.operator === 'delete' && t.isIdentifier(p.node.argument)) push(r.strict.differences, at(p, { construct: 'delete tanımlayıcı', strict: strictOf(p) }));
      if (p.node.operator === 'delete' && t.isMemberExpression(p.node.argument) && t.isIdentifier(p.node.argument.object)) {
        const b = p.scope.getBinding(p.node.argument.object.name);
        if (b?.kind === 'module' && t.isImportNamespaceSpecifier(b.path.node)) push(r.moduleNamespace.writes, at(p, { op: 'delete', note: 'TypeError (ad alanı silinemez)' }));
      }
    },
    AssignmentExpression(p) {
      const left = p.node.left;
      if (t.isIdentifier(left) && !p.scope.getBinding(left.name) && !strictOf(p)) {
        // gevşek modda bildirilmemiş ada atama global oluşturur; sıkı modda ReferenceError
        push(r.strict.differences, at(p, { construct: `bildirilmemiş "${left.name}" ataması`, strict: false }));
      }
      if (t.isMemberExpression(left) && t.isIdentifier(left.object)) {
        const b = p.scope.getBinding(left.object.name);
        if (b?.kind === 'module' && t.isImportNamespaceSpecifier(b.path.node)) push(r.moduleNamespace.writes, at(p, { op: 'atama', note: 'TypeError (ad alanı salt okunur)' }));
      }
      const name = memberName(left);
      if (name === 'then' && t.isFunction(p.node.right)) push(r.thenables.definitions, at(p, { kind: 'atama' }));
      if (name === 'lastIndex') push(r.regex.lastIndex, at(p, { op: 'yazma' }));
      if (fullName(left) === 'Error.prepareStackTrace') push(r.stackTraces.prepare, at(p));
      if (fullName(left) === 'Error.stackTraceLimit') push(r.stackTraces.limit, at(p));
      if (t.isMemberExpression(left) && t.isIdentifier(left.object) && viewOwner.has(left.object.name)) {
        const g = bufferViews.get(viewOwner.get(left.object.name));
        g.find((v) => v.view === left.object.name).writes++;
      }
    },
    ThisExpression(p) {
      const fn = p.getFunctionParent();
      if (fn && !fn.isArrowFunctionExpression() && !fn.isClassMethod() && !fn.isObjectMethod() && !fn.isClassPrivateMethod() &&
        !strictOf(p) && fn.isFunctionDeclaration()) {
        if (!r.strict.differences.some((d) => d.construct === 'this (gevşek: global nesne)' && d.fnLine === fn.node.loc?.start.line)) {
          push(r.strict.differences, at(p, { construct: 'this (gevşek: global nesne)', strict: false, fnLine: fn.node.loc?.start.line }));
        }
      }
    },
    // ---------------- E503 TDZ (statik): bildirimden önce aynı birimde okunan let/const/class
    VariableDeclaration(p) {
      if (p.node.kind === 'var') return;
      for (const d of p.get('declarations')) {
        for (const id of Object.values(d.getBindingIdentifiers())) {
          const b = d.scope.getBinding(id.name);
          if (b) tdzCheck(b, d.node.end, p);
        }
      }
    },
    ClassDeclaration(p) {
      const b = p.node.id && p.parentPath.scope.getBinding(p.node.id.name);
      if (b) tdzCheck(b, p.node.end, p);
    },
    Class(p) {
      const order = classInitOrder(p.node);
      const interesting = p.node.body.body.some((m) => t.isStaticBlock(m) || t.isClassProperty(m) || t.isClassPrivateProperty(m) || t.isClassAccessorProperty(m));
      r.classes.staticBlocks += p.node.body.body.filter((m) => t.isStaticBlock(m)).length;
      if (interesting) push(r.classes.orders, at(p, { name: p.node.id?.name ?? '(anonim)', ...order }));
      const hasDecorators = p.node.decorators?.length || p.node.body.body.some((m) => m.decorators?.length);
      if (hasDecorators) push(r.decorators.classes, at(p, { name: p.node.id?.name ?? '(anonim)', ...decoratorOrder(p.node) }));
      // E507
      const priv = p.node.body.body.filter((m) => t.isClassPrivateProperty(m) || t.isClassPrivateMethod(m) ||
        (t.isClassAccessorProperty(m) && t.isPrivateName(m.key)));
      if (priv.length) {
        let uses = 0;
        p.get('body').traverse({ PrivateName(q) { if (!q.parentPath.isClassPrivateProperty() && !q.parentPath.isClassPrivateMethod()) uses++; } });
        push(r.privateFields.classes, at(p, {
          name: p.node.id?.name ?? '(anonim)',
          members: priv.map((m) => `${m.static ? 'statik ' : ''}${t.isClassPrivateMethod(m) ? (m.kind === 'method' ? 'yöntem' : m.kind) : 'alan'} #${m.key.id.name}`),
          uses,
        }));
      }
      // E504 sınıf erişimcileri
      for (const m of p.get('body.body')) {
        if ((m.isClassMethod() || m.isClassPrivateMethod()) && (m.node.kind === 'get' || m.node.kind === 'set')) {
          push(r.accessors.definitions, at(m, { name: keyLabel(m.node), kind: m.node.kind, via: 'sınıf', effectful: effectful(m) }));
        }
      }
    },
    BinaryExpression(p) {
      if (t.isPrivateName(p.node.left) && p.node.operator === 'in') r.privateFields.brandChecks++;
      if (p.node.operator === 'instanceof' && t.isIdentifier(p.node.right) && REALM_CHECKED.has(p.node.right.name) && isGlobalRef(p.get('right'), p.node.right.name)) {
        push(r.realm.checks, at(p, { check: `instanceof ${p.node.right.name}` }));
      }
      if ((p.node.operator === '===' || p.node.operator === '==') && [p.node.left, p.node.right].some((x) => fullName(x)?.endsWith('.constructor')) &&
        [p.node.left, p.node.right].some((x) => t.isIdentifier(x) && REALM_CHECKED.has(x.name))) {
        push(r.realm.checks, at(p, { check: 'constructor karşılaştırması' }));
      }
    },
    Import(p) { if (p.parentPath.isCallExpression()) r.moduleNamespace.dynamicImports++; },
    ImportExpression() { r.moduleNamespace.dynamicImports++; },
    ImportNamespaceSpecifier(p) {
      const b = p.scope.getBinding(p.node.local.name);
      const used = new Set();
      let dynamic = 0;
      for (const ref of b?.referencePaths ?? []) {
        const m = ref.parentPath;
        if (m.isMemberExpression({ object: ref.node })) {
          const k = memberName(m.node);
          if (k === null) dynamic++; else used.add(k);
        } else dynamic++;
      }
      push(r.moduleNamespace.imports, at(p, { name: p.node.local.name, from: p.parent.source.value, members: namespaceKeys([...used]), dynamicUses: dynamic }));
    },
    ExportNamedDeclaration(p) {
      if (p.node.declaration) for (const id of Object.values(t.getBindingIdentifiers(p.node.declaration))) r.moduleNamespace.ownExports.push(id.name);
      for (const s of p.node.specifiers) r.moduleNamespace.ownExports.push(t.isIdentifier(s.exported) ? s.exported.name : s.exported.value);
    },
    ExportDefaultDeclaration() { r.moduleNamespace.ownExports.push('default'); },
    AwaitExpression(p) {
      if (ownerOf(p)?.isProgram()) push(r.topLevelAwait.sites, at(p, { kind: 'await' }));
      r.microtasks.micro++;
      const arg = p.node.argument;
      if (t.isIdentifier(arg) && thenableNames.has(arg.name)) push(r.thenables.adoptions, at(p, { via: 'await', name: arg.name }));
      if (t.isObjectExpression(arg) && arg.properties.some((x) => !x.computed && t.isIdentifier(x.key, { name: 'then' }))) push(r.thenables.adoptions, at(p, { via: 'await', name: '(literal)' }));
    },
    ForOfStatement(p) {
      if (p.node.await) {
        if (ownerOf(p)?.isProgram()) push(r.topLevelAwait.sites, at(p, { kind: 'for await' }));
        push(r.asyncIterators.forAwait, at(p, { overSync: t.isArrayExpression(p.node.right), note: t.isArrayExpression(p.node.right) ? 'senkron yineleyici: her değer await edilir' : 'Symbol.asyncIterator' }));
        return;
      }
      iterSite(p, p.get('right'), 'for-of');
      // erken çıkış: break/return/throw → IteratorClose return() çağırır
      let exits = 0;
      p.get('body').traverse({
        Function(q) { q.skip(); },
        'BreakStatement|ReturnStatement|ThrowStatement'(q) {
          if (q.isBreakStatement() && !q.node.label && q.findParent((x) => x.isLoop() || x.isSwitchStatement()) !== p) return;
          exits++;
        },
      });
      if (exits) push(r.iterators.earlyExits, at(p, { exits }));
    },
    SpreadElement(p) { if (p.parentPath.isArrayExpression() || p.parentPath.isCallExpression() || p.parentPath.isNewExpression()) iterSite(p, p.get('argument'), 'yayma'); },
    ArrayPattern(p) {
      const decl = p.parentPath;
      if (decl.isVariableDeclarator({ id: p.node }) && decl.node.init) iterSite(p, decl.get('init'), 'dizi destructuring');
      else if (decl.isAssignmentExpression({ left: p.node })) iterSite(p, decl.get('right'), 'dizi destructuring');
    },
    YieldExpression(p) { if (p.node.delegate) iterSite(p, p.get('argument'), 'yield*'); },
    ObjectExpression(p) {
      const keys = ownKeysOrder(p.node);
      const declared = p.node.properties.filter((x) => !t.isSpreadElement(x)).map((x) => x.computed ? null : (t.isIdentifier(x.key) ? x.key.name : String(x.key.value)));
      if (keys && keys.some((k, i) => declared.filter((x) => x !== null)[i] !== k)) push(r.symbols.keyOrders, at(p, { source: declared.filter((x) => x !== null), order: keys }));
      let isThenable = false;
      for (const prop of p.get('properties')) {
        const n = prop.node;
        if (t.isObjectMethod(n) && (n.kind === 'get' || n.kind === 'set')) {
          push(r.accessors.definitions, at(prop, { name: keyLabel(n), kind: n.kind, via: 'nesne literal', effectful: effectful(prop) }));
        }
        if (!n.computed && t.isIdentifier(n.key, { name: 'then' }) && (t.isObjectMethod(n) || t.isFunction(n.value))) isThenable = true;
        if (n.computed && t.isMemberExpression(n.key) && t.isIdentifier(n.key.object, { name: 'Symbol' })) {
          const wk = n.key.property.name;
          if (wk === 'iterator' || wk === 'asyncIterator') {
            (wk === 'iterator' ? r.iterators.userIterators : r.asyncIterators.definitions).push(at(prop, { via: 'nesne literal' }));
          }
        }
      }
      if (isThenable) {
        push(r.thenables.definitions, at(p, { kind: 'nesne literal' }));
        if (p.parentPath.isVariableDeclarator()) thenableNames.add(p.parent.id.name);
      }
    },
    'ClassMethod|ObjectMethod'(p) {
      const n = p.node;
      if (n.computed && t.isMemberExpression(n.key) && t.isIdentifier(n.key.object, { name: 'Symbol' }) && p.isClassMethod()) {
        const wk = n.key.property.name;
        if (wk === 'iterator') push(r.iterators.userIterators, at(p, { via: 'sınıf' }));
        if (wk === 'asyncIterator') push(r.asyncIterators.definitions, at(p, { via: 'sınıf' }));
      }
      if (p.isClassMethod() && !n.computed && t.isIdentifier(n.key, { name: 'then' })) push(r.thenables.definitions, at(p, { kind: 'sınıf yöntemi' }));
    },
    MemberExpression(p) {
      const n = p.node;
      const name = memberName(n);
      // E506
      if (n.computed && t.isMemberExpression(n.property) && t.isIdentifier(n.property.object, { name: 'Symbol' }) && !n.property.computed) {
        r.symbols.keyed++;
        const wk = n.property.property.name;
        if (Object.hasOwn(WELL_KNOWN, wk)) push(r.symbols.wellKnown, at(p, { symbol: `Symbol.${wk}`, meaning: WELL_KNOWN[wk] }));
      }
      if (t.isIdentifier(n.object, { name: 'Symbol' }) && !n.computed && Object.hasOwn(WELL_KNOWN, n.property.name) && p.key === 'key' && p.parent.computed) {
        push(r.symbols.wellKnown, at(p, { symbol: `Symbol.${n.property.name}`, meaning: WELL_KNOWN[n.property.name], defined: true }));
      }
      if (name === null) return;
      // E518
      if (name === 'stack' && !p.parentPath.isAssignmentExpression({ left: n })) {
        push(r.stackTraces.reads, at(p));
        const INSPECT = ['indexOf', 'includes', 'match', 'split', 'search', 'test', 'replace', 'lastIndexOf', 'startsWith', 'endsWith'];
        const inspected = (q) => (q.parentPath.isMemberExpression({ object: q.node }) && INSPECT.includes(memberName(q.parentPath.node))) ||
          (q.parentPath.isCallExpression() && q.parentPath.node.arguments.includes(q.node));
        // yığın metni değişkene alınıp sonra inceleniyor olabilir
        const holder = p.parentPath.isVariableDeclarator({ init: n }) && t.isIdentifier(p.parent.id) ? p.parentPath.scope.getBinding(p.parent.id.name) : null;
        if (inspected(p) || holder?.referencePaths.some(inspected)) push(r.stackTraces.inspected, at(p, { note: 'yığın metni inceleniyor: ortam/değişiklik tespiti' }));
      }
      if (fullName(n) === 'Error.stackTraceLimit' && !p.parentPath.isAssignmentExpression({ left: n })) push(r.stackTraces.limit, at(p, { op: 'okuma' }));
      // E520
      if (t.isIdentifier(n.object, { name: 'arguments' }) && (name === 'callee' || name === 'caller')) {
        const strict = strictOf(p);
        push(r.callee.sites, at(p, { prop: name, strict, effect: strict ? 'TypeError (sıkı mod)' : 'çağrılan fonksiyonun kendisi' }));
      }
      // E521
      if ((name === 'length' || name === 'caller' || name === 'arguments') && t.isIdentifier(n.object) && n.object.name !== 'arguments') {
        const b = p.scope.getBinding(n.object.name);
        const fnNode = b && (t.isFunctionDeclaration(b.path.node) ? b.path.node :
          b.path.isVariableDeclarator() && t.isFunction(b.path.node.init) && b.constantViolations.length === 0 ? b.path.node.init : null);
        if (fnNode && !p.parentPath.isAssignmentExpression({ left: n })) {
          if (name === 'length') {
            const spoof = spoofedLength(b);
            push(r.functionProps.lengths, at(p, { fn: n.object.name, value: spoof ? null : functionLength(fnNode), spoofed: spoof }));
          } else if (name === 'caller' || name === 'arguments') {
            const strict = isStrict(b.path.isVariableDeclarator() ? b.path.get('init') : b.path);
            push(r.functionProps.callers, at(p, { fn: n.object.name, prop: name, effect: strict ? 'TypeError (sıkı fonksiyon)' : 'çağıran/argümanlar ya da null' }));
          }
        }
      }
      // E510
      if (REALM_SOURCES.has(name)) push(r.realm.sources, at(p, { via: name }));
      if (t.isMemberExpression(n.object) && ['contentWindow', 'frames', 'opener'].includes(memberName(n.object)) &&
        ['Function', 'eval', 'Object', 'Array', 'fetch', 'XMLHttpRequest', 'setTimeout', 'console', 'Proxy', 'Reflect'].includes(name)) {
        push(r.realm.freshNatives, at(p, { native: name, note: 'başka realm\'den temiz yerleşik: kanca atlatma' }));
      }
      // E528
      if (name === 'lastIndex' && !p.parentPath.isAssignmentExpression({ left: n })) push(r.regex.lastIndex, at(p, { op: 'okuma' }));
      if ((name === 'test' || name === 'exec') && t.isIdentifier(n.object) && p.parentPath.isCallExpression({ callee: n })) {
        const b = p.scope.getBinding(n.object.name);
        const info = b && regexVars.get(b);
        if (info) { info.uses++; if (p.findParent((x) => x.isLoop())) info.inLoop = true; }
      }
      // E529 / E530 / E534
      if (LOCAL_DATE.has(name) && p.parentPath.isCallExpression({ callee: n })) push(r.time.localDate, at(p, { method: name }));
      if (name === 'getTimezoneOffset' || fullName(n) === 'Intl.DateTimeFormat') push(r.time.timezone, at(p, { api: fullName(n) ?? name }));
      if (name === 'toLocaleString' || name === 'toLocaleDateString' || name === 'toLocaleTimeString' || name === 'localeCompare' || name === 'toLocaleUpperCase' || name === 'toLocaleLowerCase') {
        push(r.locale.toLocale, at(p, { method: name }));
      }
      if (t.isIdentifier(n.object, { name: 'Intl' }) && isGlobalRef(p.get('object'), 'Intl')) push(r.locale.intl, at(p, { api: `Intl.${name}` }));
      if (fullName(n) === 'performance.now' || fullName(n) === 'performance.timeOrigin') push(r.time.performance, at(p, { api: fullName(n) }));
      // E538
      if (name === 'detached') push(r.detached.transfers, at(p, { op: 'detached okuma' }));
      // E539
      if (t.isIdentifier(n.object, { name: 'Atomics' }) && isGlobalRef(p.get('object'), 'Atomics')) push(r.shared.atomics, at(p, { op: name }));
    },
    CallExpression(p) {
      const name = calleeName(p);
      const callee = p.node.callee;
      // E509
      if (t.isIdentifier(callee, { name: 'eval' }) && !p.scope.getBinding('eval')) {
        if (p.node.optional) push(r.eval.indirect, at(p, { form: 'eval?.()' }));
        else {
          const strict = strictOf(p);
          push(r.eval.direct, at(p, { strict, effect: strict ? 'kendi değişken ortamı' : 'var bildirimleri çağıran fonksiyona sızar' }));
        }
      } else if (t.isSequenceExpression(callee) && t.isIdentifier(callee.expressions.at(-1), { name: 'eval' })) push(r.eval.indirect, at(p, { form: '(0, eval)()' }));
      else if (name && /(^|\.)(window|globalThis|self)\.eval$/.test(name)) push(r.eval.indirect, at(p, { form: name }));
      else if (t.isIdentifier(callee)) {
        const b = p.scope.getBinding(callee.name);
        if (b?.path.isVariableDeclarator() && t.isIdentifier(b.path.node.init, { name: 'eval' })) push(r.eval.indirect, at(p, { form: `${callee.name} = eval` }));
      }
      if (name === 'Function' || name === 'window.Function' || name === 'globalThis.Function') push(r.eval.functionCtor, at(p));
      if ((name === 'setTimeout' || name === 'setInterval') && p.node.arguments[0] && (t.isStringLiteral(p.node.arguments[0]) || t.isTemplateLiteral(p.node.arguments[0]) || t.isBinaryExpression(p.node.arguments[0]))) {
        push(r.eval.stringTimers, at(p, { api: name }));
      }
      // E504 defineProperty erişimcileri
      if (name === 'Object.defineProperty' || name === 'Reflect.defineProperty' || name === 'Object.defineProperties') {
        const desc = p.node.arguments[name === 'Object.defineProperties' ? 1 : 2];
        const key = p.node.arguments[1];
        const descs = name === 'Object.defineProperties' && t.isObjectExpression(desc)
          ? desc.properties.filter((x) => t.isObjectProperty(x) && t.isObjectExpression(x.value)).map((x) => [x.key, x.value])
          : t.isObjectExpression(desc) ? [[key, desc]] : [];
        for (const [k, d] of descs) {
          const acc = d.properties.filter((x) => (t.isObjectProperty(x) || t.isObjectMethod(x)) && !x.computed && t.isIdentifier(x.key) && (x.key.name === 'get' || x.key.name === 'set'));
          for (const a of acc) {
            const kName = t.isStringLiteral(k) ? k.value : t.isIdentifier(k) && name === 'Object.defineProperties' ? k.name : '?';
            const fnPath = findPathFor(p, t.isObjectMethod(a) ? a : a.value);
            push(r.accessors.definitions, at(p, { name: kName, kind: a.key.name, via: name, effectful: fnPath ? effectful(fnPath) : true }));
          }
        }
        if (t.isStringLiteral(key, { value: 'length' }) && t.isIdentifier(p.node.arguments[0])) push(r.functionProps.spoofed, at(p, { fn: p.node.arguments[0].name }));
      }
      if (name && /__define[GS]etter__$/.test(name)) push(r.accessors.definitions, at(p, { name: t.isStringLiteral(p.node.arguments[0]) ? p.node.arguments[0].value : '?', kind: name.includes('Getter') ? 'get' : 'set', via: '__defineGetter__', effectful: true }));
      // E506
      if (name === 'Symbol' || name === 'Symbol.for') r.symbols.created++;
      // E513
      if (['Array.from', 'Promise.all', 'Promise.allSettled', 'Promise.race', 'Promise.any', 'Object.fromEntries'].includes(name) && p.node.arguments[0]) iterSite(p, p.get('arguments.0'), name);
      // E515
      if ((name === 'Promise.resolve' || name === 'resolve') && p.node.arguments[0]) {
        const a = p.node.arguments[0];
        if (t.isIdentifier(a) && thenableNames.has(a.name)) push(r.thenables.adoptions, at(p, { via: name, name: a.name }));
      }
      // E516
      const last = t.isMemberExpression(callee) ? memberName(callee) : t.isIdentifier(callee) ? callee.name : null;
      if (last && MICRO.has(last)) { r.microtasks.micro++; push(r.microtasks.sources, at(p, { kind: 'mikro', api: last })); }
      if (last && MACRO.has(last) && (t.isIdentifier(callee) || ['window', 'globalThis', 'self'].includes(callee.object?.name))) {
        r.microtasks.macro++;
        push(r.microtasks.sources, at(p, { kind: 'makro', api: last }));
      }
      // E517: sonucu kullanılmayan reddedilebilir söz
      if (p.parentPath.isExpressionStatement()) {
        if (name === 'Promise.reject') push(r.rejections.candidates, at(p, { why: 'Promise.reject sonucu işlenmiyor' }));
        if (t.isMemberExpression(callee) && memberName(callee) === 'then' && p.node.arguments.length < 2) {
          push(r.rejections.candidates, at(p, { why: '.then zinciri catch olmadan bitiyor' }));
        }
        if (t.isIdentifier(callee)) {
          const b = p.scope.getBinding(callee.name);
          if (b && t.isFunction(b.path.node) && b.path.node.async) push(r.rejections.candidates, at(p, { why: `async ${callee.name}() sonucu beklenmiyor` }));
        }
      }
      // E519
      if (name === 'Error.captureStackTrace') push(r.stackTraces.capture, at(p, { ctorArg: Boolean(p.node.arguments[1]) }));
      if (name === 'console.trace') push(r.stackTraces.capture, at(p, { api: 'console.trace' }));
      // E538
      if (t.isMemberExpression(callee) && ['transfer', 'transferToFixedLength'].includes(memberName(callee)) && t.isIdentifier(callee.object)) {
        markTransfer(p, callee.object.name, memberName(callee));
      }
      if (name === 'structuredClone' || (last === 'postMessage')) {
        const opt = p.node.arguments[1];
        const list = t.isArrayExpression(opt) ? opt.elements : t.isObjectExpression(opt)
          ? opt.properties.find((x) => t.isObjectProperty(x) && t.isIdentifier(x.key, { name: 'transfer' }) && t.isArrayExpression(x.value))?.value.elements ?? [] : [];
        for (const e of list) if (t.isIdentifier(e)) markTransfer(p, e.name, `${last} transfer`);
      }
      // E537 görünüm yöntemleri
      if (t.isMemberExpression(callee) && t.isIdentifier(callee.object) && viewOwner.has(callee.object.name) &&
        (['set', 'fill', 'copyWithin', 'reverse', 'sort'].includes(memberName(callee)) || /^set(Int|Uint|Float|Big)/.test(memberName(callee) ?? ''))) {
        bufferViews.get(viewOwner.get(callee.object.name)).find((v) => v.view === callee.object.name).writes++;
      }
      if (t.isMemberExpression(callee) && memberName(callee) === 'subarray' && t.isIdentifier(callee.object) && viewOwner.has(callee.object.name) && p.parentPath.isVariableDeclarator()) {
        addView(viewOwner.get(callee.object.name), p.parent.id.name, p, 'subarray');
      }
    },
    NewExpression(p) {
      const name = calleeName(p);
      if (name === 'Proxy') {
        const h = p.node.arguments[1];
        const traps = t.isObjectExpression(h) ? h.properties.map((x) => (!x.computed && t.isIdentifier(x.key) ? x.key.name : null)) : null;
        push(r.proxies.sites, at(p, {
          traps: traps ? traps.filter(Boolean) : null,
          unknownTraps: traps ? traps.filter((x) => x && !PROXY_TRAPS.has(x)) : [],
          bound: p.parentPath.isVariableDeclarator() ? p.parent.id.name : null,
          note: traps ? 'her işlem tuzak üzerinden: okuma/yazma/çağrı yan etkili' : 'tuzak tablosu dinamik',
        }));
      }
      if (name === 'Function') push(r.eval.functionCtor, at(p));
      if (name === 'ShadowRealm' || name === 'Worker') push(r.realm.sources, at(p, { via: `new ${name}` }));
      if (name === 'SharedArrayBuffer') push(r.shared.sab, at(p));
      if (name === 'WeakRef') push(r.weak.weakRefs, at(p, { note: 'deref() GC zamanlamasına bağlı; sandbox hiç toplamaz' }));
      if (name === 'FinalizationRegistry') push(r.weak.registries, at(p, { note: 'geri çağrı zamanı belirsiz; sandbox çağırmaz' }));
      if (name === 'MutationObserver') { r.microtasks.micro++; push(r.microtasks.sources, at(p, { kind: 'mikro', api: 'MutationObserver' })); }
      if (['Map', 'Set', 'WeakMap', 'WeakSet'].includes(name) && p.node.arguments[0]) iterSite(p, p.get('arguments.0'), `new ${name}`);
      // E537
      if (TYPED.has(name) && p.parentPath.isVariableDeclarator() && t.isIdentifier(p.parent.id)) {
        const a = p.node.arguments[0];
        if (t.isIdentifier(a)) {
          const ab = p.scope.getBinding(a.name);
          const root = viewOwner.get(a.name) ?? (ab && ab.path.isVariableDeclarator() && t.isNewExpression(ab.path.node.init) &&
            ['ArrayBuffer', 'SharedArrayBuffer'].includes(calleeNameNode(ab.path.node.init)) ? a.name : null);
          if (root) addView(root, p.parent.id.name, p, name);
        } else if (t.isMemberExpression(a) && memberName(a) === 'buffer' && t.isIdentifier(a.object) && viewOwner.has(a.object.name)) {
          addView(viewOwner.get(a.object.name), p.parent.id.name, p, name);
        }
      }
      if (name === 'Promise' && p.parentPath.isExpressionStatement()) push(r.rejections.candidates, at(p, { why: 'new Promise sonucu tutulmuyor' }));
    },
    RegExpLiteral(p) { regexSite(p, p.node.pattern, p.node.flags); },
    Identifier(p) {
      if (p.node.name === 'SharedArrayBuffer' && p.isReferencedIdentifier() && !p.parentPath.isNewExpression({ callee: p.node }) && !p.scope.getBinding('SharedArrayBuffer')) push(r.shared.sab, at(p, { op: 'referans' }));
      if (p.node.name === 'crossOriginIsolated' && p.isReferencedIdentifier() && !p.scope.getBinding(p.node.name)) push(r.shared.sab, at(p, { op: 'crossOriginIsolated' }));
    },
  });

  // NewExpression/CallExpression RegExp('...', 'g') — sabit argümanlı kurucu
  traverse(ast, {
    'NewExpression|CallExpression'(p) {
      if (calleeName(p) !== 'RegExp') return;
      const [src, fl] = p.node.arguments;
      if (t.isStringLiteral(src) && (!fl || t.isStringLiteral(fl))) regexSite(p, src.value, fl?.value ?? '');
    },
  });

  for (const [, info] of regexVars) {
    if (info.uses > 1 || info.inLoop) push(r.regex.stateful, { line: info.line, name: info.name, flags: info.flags, uses: info.uses, note: 'lastIndex çağrılar arasında taşınır: test/exec sonuçları sıraya bağlı' });
  }
  for (const [buffer, views] of bufferViews) {
    if (views.length >= 2) push(r.typedArrays.groups, { buffer, views, writes: views.reduce((a, v) => a + v.writes, 0), note: 'aynı belleğe takma ad: bir görünüme yazma diğerinden okunur' });
  }
  for (const [b, tr] of transferred) {
    for (const ref of b.referencePaths) {
      if (ref.node.start > tr.end && ownerOf(ref) === ownerOf(b.path)) push(r.detached.usesAfter, at(ref, { name: b.identifier.name, effect: 'byteLength 0; görünüm erişimi undefined, yöntemler TypeError' }));
    }
  }
  r.moduleNamespace.ownExports = namespaceKeys(r.moduleNamespace.ownExports);
  r.accessors.names = [...new Set(r.accessors.definitions.map((d) => d.name))];
  // erişimci adlı özellik okumaları: yan etkili okuma olabilir
  if (r.accessors.names.length) {
    const names = new Set(r.accessors.names.filter((n) => n !== '?'));
    traverse(ast, {
      MemberExpression(p) {
        const n = memberName(p.node);
        if (n && names.has(n) && !p.parentPath.isAssignmentExpression({ left: p.node })) {
          const d = r.accessors.definitions.find((x) => x.name === n && x.kind === 'get');
          if (d?.effectful) push(r.accessors.effectfulReads, at(p, { name: n }));
        }
      },
    });
  }
  return r;

  // --- yardımcılar (kapanış içinde r'ye yazar)
  function tdzCheck(b, declEnd, declPath) {
    const declOwner = ownerOf(declPath);
    for (const ref of b.referencePaths) {
      const refOwner = ownerOf(ref);
      if (refOwner === declOwner) {
        if (ref.node.start >= declEnd) continue;
        // döngü gövdesinde de bildirimden önceki okuma her yinelemede TDZ'dedir
        push(r.tdz.sites, at(ref, { name: b.identifier.name, kind: 'kesin', note: 'bildirimden önce okuma: ReferenceError' }));
        continue;
      }
      // iç fonksiyon bildirimden önce çağrılıyorsa
      const fn = refOwner;
      const fnName = fn?.node.id?.name;
      if (!fnName || !fn.isFunctionDeclaration()) continue;
      const fb = fn.parentPath.scope.getBinding(fnName);
      const early = fb?.referencePaths.filter((c) => c.parentPath.isCallExpression({ callee: c.node }) && c.node.start < declEnd && ownerOf(c) === declOwner);
      if (early?.length) push(r.tdz.sites, at(early[0], { name: b.identifier.name, kind: 'olası', note: `${fnName}() bildirimden önce çağrılıyor` }));
    }
  }

  function iterSite(p, argPath, form) {
    const a = argPath.node;
    let kind = 'kullanıcı/bilinmeyen';
    if (t.isArrayExpression(a) || t.isStringLiteral(a) || t.isTemplateLiteral(a)) kind = 'yerleşik (dizi/string)';
    else if (t.isIdentifier(a)) {
      const b = argPath.scope.getBinding(a.name);
      if (b && b.constantViolations.length === 0 && b.path.isVariableDeclarator() && t.isArrayExpression(b.path.node.init)) kind = 'yerleşik (dizi)';
      else if (b && b.path.isVariableDeclarator() && t.isCallExpression(b.path.node.init)) {
        const fb = t.isIdentifier(b.path.node.init.callee) && argPath.scope.getBinding(b.path.node.init.callee.name);
        if (fb && fb.path.node.generator) kind = 'üreteç';
      }
    } else if (t.isCallExpression(a) && t.isIdentifier(a.callee)) {
      const fb = argPath.scope.getBinding(a.callee.name);
      if (fb && fb.path.node.generator) kind = 'üreteç';
    }
    push(r.iterators.sites, at(p, { form, kind, effect: kind.startsWith('yerleşik') ? 'yan etkisiz (prototype değişmemişse)' : 'next()/return() çağrıları yan etkili olabilir' }));
  }

  function regexSite(p, source, flags) {
    const features = regexFeatures(source, flags);
    push(r.regex.patterns, at(p, { source: source.length > 120 ? `${source.slice(0, 117)}...` : source, flags, features }));
    for (const e of unicodePropertyEscapes(source, flags)) push(r.unicodeEscapes.escapes, at(p, e));
    if ((flags.includes('g') || flags.includes('y')) && p.parentPath.isVariableDeclarator() && t.isIdentifier(p.parent.id)) {
      const b = p.parentPath.scope.getBinding(p.parent.id.name);
      if (b) regexVars.set(b, { name: p.parent.id.name, flags, line: p.node.loc?.start.line ?? null, uses: 0, inLoop: false });
    }
  }

  function addView(buffer, view, p, ctor) {
    if (!bufferViews.has(buffer)) bufferViews.set(buffer, []);
    bufferViews.get(buffer).push({ view, ctor, line: p.node.loc?.start.line ?? null, writes: 0 });
    viewOwner.set(view, buffer);
  }

  function markTransfer(p, name, op) {
    const b = p.scope.getBinding(name);
    push(r.detached.transfers, at(p, { name, op }));
    if (b && !transferred.has(b)) transferred.set(b, p.node);
  }

  function spoofedLength(b) {
    return b.referencePaths.some((ref) => {
      const c = ref.parentPath;
      return c.isCallExpression() && ['Object.defineProperty', 'Reflect.defineProperty'].includes(calleeName(c)) &&
        c.node.arguments[0] === ref.node && t.isStringLiteral(c.node.arguments[1], { value: 'length' });
    });
  }
}

function calleeNameNode(n) { return fullName(n.callee); }

function findPathFor(parentPath, node) {
  let found = null;
  parentPath.traverse({
    enter(p) { if (p.node === node) { found = p; p.stop(); } },
  });
  return found;
}
