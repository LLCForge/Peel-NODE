import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { machineSwitch, decompile } from '../naming/regenerator.js';
import { scan, runsAfter, isStrict, strictSafe, callOnlyProperty } from '../naming/scope.js';
import { provablyPrimitive } from './97-modern-syntax.js';
import { reverseExtras } from '../naming/babel-extra.js';

// 79: Babel/regenerator kalıntılarını geri çevirme. İlk iki madde reverseRegenerator'dadır (79-regenerator pass'i
// level 2'de çağırır); bu pass okunabilirlik aşamasında yardımcı ve sınıf kalıntılarını çevirir.
//  - regenerator durum makinesi → function*  (try/catch/finally, döngü, if/else, yield*): klasik
//    regeneratorRuntime/_regeneratorRuntime().mark/wrap ve Babel 7.27+ kompakt _regenerator().m/w biçimi
//  - _asyncToGenerator(function* …) → async function (IIFE, "_foo.apply(this, arguments)" ikilisi, _ref sarmalayıcısı)
//  - _classCallCheck + _createClass (+ _inherits/_callSuper/_createSuper, _superPropGet/_get) → class … extends …
//  - _typeof → typeof, _toConsumableArray → [...x], _slicedToArray → [a, b] deseni, _objectSpread → {...a},
//    _extends → Object.assign, _defineProperty({}, k, v) → { [k]: v }
// Yardımcılar adlarıyla değil gövde biçimleriyle tanınır (küçültülmüş çıktıda da çalışır).

// Yardımcıların iç parçaları: gövdeleri jeneratör nesnesi/tanımlayıcı dizisi üzerinde çalışır, kullanıcı metotlarını okumaz
export const SUPPORT_NAME = /^_?(asyncGeneratorStep|defineProperties|toPropertyKey|toPrimitive|ownKeys|unsupportedIterableToArray|iterableToArray|iterableToArrayLimit|arrayWithoutHoles|arrayWithHoles|nonIterableSpread|nonIterableRest|regeneratorRuntime|regenerator|regeneratorDefine|regeneratorValues|setPrototypeOf|possibleConstructorReturn|isNativeReflectConstruct|superPropBase|taggedTemplateLiteral|interopRequireDefault|interopRequireWildcard)\d*$/;
const HELPER_NAME = /^_?(typeof|toConsumableArray|slicedToArray|objectSpread2?|extends|defineProperty|classCallCheck|createClass|asyncToGenerator|inherits|createSuper|callSuper|superPropGet|superPropSet|get|set|getPrototypeOf|assertThisInitialized|toArray|arrayLikeToArray|createForOfIteratorHelper|createForOfIteratorHelperLoose|objectWithoutProperties|objectWithoutPropertiesLoose|inheritsLoose)\d*$/;

/** Babel yardımcı fonksiyonları: biçimi doğrulanmış türler (binding → tür) ve gövdesi kanıt dışı tutulacak düğümler */
export function collectHelpers(ast) {
  const program = gen(ast.program);
  const helpers = new Map();
  const helperNodes = new Set();
  traverse(ast, {
    FunctionDeclaration(p) {
      if (!p.parentPath.isProgram() && !p.parentPath.parentPath?.isFunction()) return;
      const kind = helperKind(p.node.id.name, gen(p.node), program);
      if (!kind) {
        if (p.parentPath.isProgram() && SUPPORT_NAME.test(p.node.id.name)) helperNodes.add(p.node);
        return;
      }
      const b = p.scope.getBinding(p.node.id.name);
      // yardımcı kendini önbellekli sürümle değiştirebilir (_typeof = …); başka yerde yazılmamalı
      if (!b || !b.constantViolations.every((v) => v.findParent((x) => x.node === p.node))) return;
      // düğümle anahtarlanır: scope yeniden taranınca binding nesneleri değişir
      helpers.set(p.node, kind);
      helperNodes.add(p.node);
    },
  });
  return { helpers, helperNodes };
}

function helperKind(name, code, program) {
  const m = HELPER_NAME.exec(name);
  if (!m) return null;
  const kind = m[1];
  switch (kind) {
    case 'typeof': return code.includes('Symbol.iterator') && code.includes('typeof') ? 'typeof' : null;
    case 'toConsumableArray': return /return \w+\(\w+\)\|\|\w+\(\w+\)\|\|\w+\(\w+\)\|\|\w+\(\)/.test(code) && program.includes('spread non-iterable') ? kind : null;
    case 'slicedToArray': return /return \w+\(\w+\)\|\|\w+\(\w+,\w+\)\|\|\w+\(\w+,\w+\)\|\|\w+\(\)/.test(code) && program.includes('destructure non-iterable') ? kind : null;
    case 'objectSpread': case 'objectSpread2':
      if (!code.includes('arguments')) return null;
      return code.includes('%2') ? 'objectSpread2' : (code.includes('Object.keys') ? 'objectSpread' : null);
    case 'extends': return code.includes('Object.assign') ? kind : null;
    case 'defineProperty': return code.includes('Object.defineProperty') && /enumerable:(!0|true)/.test(code) && /writable:(!0|true)/.test(code) ? kind : null;
    case 'classCallCheck': return code.includes('Cannot call a class as a function') ? kind : null;
    case 'createClass': return code.includes('prototype') && code.includes('defineProperty') ? kind : null;
    case 'asyncToGenerator': return code.includes('Promise') && code.includes('apply') ? kind : null;
    case 'inherits': return code.includes('Super expression must either be null or a function') ? kind : null;
    case 'createSuper': return code.includes('Reflect.construct') || code.includes('possibleConstructorReturn') ? kind : null;
    case 'callSuper': return code.includes('possibleConstructorReturn') || code.includes('Reflect.construct') ? kind : null;
    case 'superPropGet': return code.includes('apply') && code.includes('prototype') ? kind : null;
    case 'superPropSet': return kind;
    case 'get': return code.includes('Reflect.get') || code.includes('superPropBase') ? kind : null;
    case 'set': return code.includes('Reflect.set') || code.includes('superPropBase') ? kind : null;
    case 'getPrototypeOf': return code.includes('getPrototypeOf') ? kind : null;
    case 'assertThisInitialized': return code.includes('initialised') ? kind : null;
    case 'toArray': return /return \w+\(\w+\)\|\|\w+\(\w+\)\|\|\w+\(\w+\)\|\|\w+\(\)/.test(code) && program.includes('destructure non-iterable') ? kind : null;
    case 'arrayLikeToArray': return /Array\(\w+\)/.test(code) && code.includes('.length') ? kind : null;
    case 'createForOfIteratorHelper': return code.includes('Symbol.iterator') && /[{,]s:/.test(code) && /[{,]n:/.test(code) && /[{,]f:/.test(code) ? kind : null;
    case 'createForOfIteratorHelperLoose': return code.includes('Symbol.iterator') && code.includes('.next.bind(') ? kind : null;
    case 'objectWithoutProperties': return code.includes('getOwnPropertySymbols') && code.includes('indexOf') ? kind : null;
    case 'objectWithoutPropertiesLoose': return code.includes('indexOf') && (code.includes('Object.keys') || code.includes('hasOwnProperty')) ? kind : null;
    case 'inheritsLoose': return code.includes('Object.create') && code.includes('.constructor=') ? kind : null;
    default: return null;
  }
}

export async function run(ast, { onLog, bump, naming = {} }) {
  if (naming.babel === false) return;
  // regenerator makineleri ve _asyncToGenerator: 79-regenerator (aynı yardımcılar, level 2)
  const stats = { classes: 0, helpers: 0 };

  const { helpers, helperNodes } = collectHelpers(ast);
  const helperOf = (p) => {
    if (!t.isIdentifier(p.node)) return null;
    const b = p.scope.getBinding(p.node.name);
    return b ? helpers.get(b.path.node) ?? null : null;
  };

  // ── 2) basit yardımcılar ve async ──
  traverse(ast, {
    CallExpression: {
      exit(p) {
        const kind = helperOf(p.get('callee'));
        if (!kind || p.findParent((x) => helperNodes.has(x.node))) return;
        const args = p.node.arguments;
        if (args.some((a) => t.isSpreadElement(a))) return;
        let rep = null;
        if (kind === 'typeof' && args.length === 1) {
          // _typeof(tanımsızIsim) ReferenceError atar, typeof atmaz: çıplak global'de çevirme
          if (t.isIdentifier(args[0]) && !p.scope.getBinding(args[0].name)) return;
          rep = t.unaryExpression('typeof', args[0]);
        } else if (kind === 'toConsumableArray' && args.length === 1) {
          rep = t.arrayExpression([t.spreadElement(args[0])]);
        } else if (kind === 'extends' && !p.scope.getBinding('Object') && !t.isObjectExpression(args[0])) {
          // ilk argüman literal değilse yayma kurulamaz (hedef nesne değişir): Object.assign ile aynı
          rep = t.callExpression(t.memberExpression(t.identifier('Object'), t.identifier('assign')), args);
        } else if (kind === 'defineProperty' && args.length === 3 && t.isObjectExpression(args[0]) &&
          (t.isStringLiteral(args[1]) || t.isNumericLiteral(args[1]) || provablyPrimitive(p.get('arguments.1'), new Set()))) {
          // sabit anahtar adı tanımlayıcıysa düz yazılır ({ plain: 2 }); __proto__ düz yazımda prototip ayarlar, hesaplanan kalır
          const lit = t.isStringLiteral(args[1]) && t.isValidIdentifier(args[1].value) && args[1].value !== '__proto__';
          rep = t.objectExpression([...args[0].properties, lit ? t.objectProperty(t.identifier(args[1].value), args[2]) : t.objectProperty(args[1], args[2], true)]);
        } else if ((kind === 'objectSpread' || kind === 'objectSpread2') && args.length && t.isObjectExpression(args[0]) && freshTarget(args[0])) {
          rep = spreadObject(args, kind);
        }
        if (!rep) return;
        p.replaceWith(rep);
        stats.helpers++;
      },
    },
    VariableDeclaration(p) {
      // var _ref = _slicedToArray(x, 2), a = _ref[0], b = _ref[1];  →  var [a, b] = x;
      const ds = p.node.declarations;
      for (let i = 0; i < ds.length; i++) {
        const d = ds[i];
        if (!t.isIdentifier(d.id) || !t.isCallExpression(d.init) || d.init.arguments.length !== 2) continue;
        const kind = helperOf(p.get(`declarations.${i}.init.callee`));
        if (kind !== 'slicedToArray' || !t.isNumericLiteral(d.init.arguments[1])) continue;
        const n = d.init.arguments[1].value;
        const b = p.scope.getBinding(d.id.name);
        // döngü içindeki var her turda yeniden bildirilir: tek atama yine bu bildirimdir
        if (!b || !b.constantViolations.every((v) => v.node === d)) continue;
        const elems = new Array(n).fill(null);
        let j = i + 1;
        for (; j < ds.length; j++) {
          const e = ds[j];
          if (!t.isIdentifier(e.id) || !t.isMemberExpression(e.init) || !t.isIdentifier(e.init.object, { name: d.id.name }) ||
            !e.init.computed || !t.isNumericLiteral(e.init.property)) break;
          const k = e.init.property.value;
          if (k >= n || elems[k] || elems.slice(k + 1).some(Boolean)) break;
          elems[k] = t.identifier(e.id.name);
        }
        const used = j - i - 1;
        if (!used || b.referencePaths.length !== used) continue;
        // [a, , c]: sondaki boşluklar yineleyiciden fazladan değer çekmesin diye n korunur
        while (elems.length < n) elems.push(null);
        const pattern = t.arrayPattern(elems);
        ds.splice(i, j - i, t.variableDeclarator(pattern, d.init.arguments[0]));
        stats.helpers++;
      }
    },
  });

  // ── 2b) diğer yardımcılar: for-of, dizi/nesne dinlenme deseni, gevşek mod nesne literali, concat/apply, _extends ──
  traverse(ast, { Program(p) { p.scope.crawl(); p.stop(); } });
  reverseExtras(ast, helperOf, stats);

  // ── 3) _classCallCheck + _createClass → class ──
  traverse(ast, {
    FunctionDeclaration(p) {
      if (p.parentPath.isProgram() && SUPPORT_NAME.test(p.node.id.name)) helperNodes.add(p.node);
    },
  });
  const info = scan(ast, { ignore: helperNodes });
  traverse(ast, {
    FunctionDeclaration(p) {
      const c = createClassFor(p, helperOf, info);
      if (!c) return;
      stats.classes++;
    },
  });

  const total = stats.classes + stats.helpers;
  if (total) onLog(`babel: ${stats.classes} sınıf, ${stats.helpers} yardımcı çağrısı geri çevrildi`, 'info');
  bump('babel', total);
}

/**
 * regenerator durum makineleri → function* ve _asyncToGenerator(function* …) → async function.
 * 79-regenerator pass'i çağırır; stats.generators / stats.asyncs artırılır.
 */
export function reverseRegenerator(ast, stats) {
  // yield* hedefi: programda tek tanımlı generator (ya da regenerator ile işaretli) fonksiyon çağrısı, dizi ya da string literali
  const declCount = new Map();
  const seenScopes = new WeakSet();
  const generatorNames = new Set();
  traverse(ast, {
    Scopable(p) {
      if (seenScopes.has(p.scope)) return;
      seenScopes.add(p.scope);
      for (const n of Object.keys(p.scope.bindings)) declCount.set(n, (declCount.get(n) ?? 0) + 1);
    },
    FunctionDeclaration(p) {
      const last = p.node.body.body.at(-1);
      if (p.node.generator || (t.isReturnStatement(last) && wrapDialect(last.argument))) generatorNames.add(p.node.id.name);
    },
  });
  const delegateOk = (n) => t.isArrayExpression(n) || t.isStringLiteral(n) ||
    (t.isCallExpression(n) && t.isIdentifier(n.callee) && generatorNames.has(n.callee.name) && declCount.get(n.callee.name) === 1);
  traverse(ast, {
    CallExpression(p) {
      const fn = markedFunction(p);
      if (!fn) return;
      const out = toGenerator(fn.node, fn.wrapCall, delegateOk);
      if (!out) return;
      p.replaceWith(out);
      stats.generators++;
    },
    FunctionDeclaration(p) {
      // var _marked = R.mark(gen); function gen() { return R.wrap(function gen$(ctx) {…}, _marked); }
      const last = p.node.body.body.at(-1);
      if (!t.isReturnStatement(last) || !wrapDialect(last.argument)) return;
      const marker = last.argument.arguments[1];
      if (!t.isIdentifier(marker)) return;
      const mb = p.scope.getBinding(marker.name);
      if (!mb || !mb.constant || !mb.path.isVariableDeclarator() || mb.referencePaths.length !== 1) return;
      const init = mb.path.node.init;
      if (markDialect(init) !== wrapDialect(last.argument) || !t.isIdentifier(init.arguments[0], { name: p.node.id.name })) return;
      const out = toGenerator(p.node, last.argument, delegateOk);
      if (!out) return;
      p.replaceWith(t.functionDeclaration(p.node.id, out.params, out.body, true, false));
      const decl = mb.path.parentPath;
      if (decl.node.declarations.length === 1) decl.remove(); else mb.path.remove();
      stats.generators++;
    },
  });

  // _asyncToGenerator(gen): yardımcı gövdesiyle tanınır (Promise + apply); ad tek başına kanıt değildir
  const { helpers, helperNodes } = collectHelpers(ast);
  traverse(ast, {
    CallExpression: {
      exit(p) {
        if (!t.isIdentifier(p.node.callee) || p.node.arguments.some((a) => t.isSpreadElement(a))) return;
        const b = p.scope.getBinding(p.node.callee.name);
        if (!b || helpers.get(b.path.node) !== 'asyncToGenerator' || p.findParent((x) => helperNodes.has(x.node))) return;
        asyncCall(p, stats);
      },
    },
  });
}

// ── regenerator ─────────────────────────────────────────

// Çalışma zamanı nesnesi: regeneratorRuntime / _regeneratorRuntime() (klasik) ya da _regenerator() (kompakt)
const runtimeKind = (obj) => {
  if (t.isIdentifier(obj) && /^_?regeneratorRuntime\d*$/.test(obj.name)) return 'classic';
  if (t.isMemberExpression(obj) && !obj.computed && t.isIdentifier(obj.property, { name: 'regeneratorRuntime' })) return 'classic';
  if (t.isCallExpression(obj) && !obj.arguments.length && t.isIdentifier(obj.callee)) {
    if (/^_?regeneratorRuntime\d*$/.test(obj.callee.name)) return 'classic';
    if (/^_?regenerator\d*$/.test(obj.callee.name)) return 'compact';
  }
  return null;
};
const PROPS = { classic: { mark: 'mark', wrap: 'wrap' }, compact: { mark: 'm', wrap: 'w' } };
// R.mark(f) → lehçe; değilse null
function markDialect(n) {
  if (!t.isCallExpression(n) || !t.isMemberExpression(n.callee) || n.callee.computed || n.arguments.length !== 1) return null;
  const d = runtimeKind(n.callee.object);
  return d && t.isIdentifier(n.callee.property, { name: PROPS[d].mark }) ? d : null;
}
function wrapDialect(n) {
  if (!t.isCallExpression(n) || !t.isMemberExpression(n.callee) || n.callee.computed || !t.isFunctionExpression(n.arguments[0])) return null;
  const d = runtimeKind(n.callee.object);
  return d && t.isIdentifier(n.callee.property, { name: PROPS[d].wrap }) ? d : null;
}

// R.mark(function f() { …; return R.wrap(function f$(ctx) {…}, f, this, tryLocs); })
function markedFunction(p) {
  const dialect = markDialect(p.node);
  if (!dialect) return null;
  const fn = p.node.arguments[0];
  if (!t.isFunctionExpression(fn) || fn.generator || fn.async) return null;
  const last = fn.body.body.at(-1);
  if (!t.isReturnStatement(last) || wrapDialect(last.argument) !== dialect) return null;
  if (gen(p.node.callee.object) !== gen(last.argument.callee.object)) return null;
  const marker = last.argument.arguments[1];
  if (marker && !(fn.id && t.isIdentifier(marker, { name: fn.id.name }))) return null;
  return { node: fn, wrapCall: last.argument };
}

function toGenerator(outer, wrapCall, delegateOk) {
  const dialect = wrapDialect(wrapCall);
  const [inner, , self, locs] = wrapCall.arguments;
  if (self && !t.isThisExpression(self) && !t.isNullLiteral(self)) return null;
  if (inner.params.length !== 1 || !t.isIdentifier(inner.params[0])) return null;
  const ctx = inner.params[0].name;
  const sw = machineSwitch(inner, ctx, dialect);
  if (!sw) return null;
  let tryLocs = [];
  if (locs) {
    if (!t.isArrayExpression(locs)) return null;
    tryLocs = locs.elements.map((e) => (t.isArrayExpression(e) ? [0, 1, 2, 3].map((k) => (t.isNumericLiteral(e.elements[k]) ? e.elements[k].value : null)) : null));
    if (tryLocs.some((x) => !x)) return null;
  }
  // iç fonksiyonda this: wrap(…, this) ile dış this'e bağlı; null/yoksa iç this kullanılmamalı
  if (!t.isThisExpression(self) && containsThis(inner.body)) return null;
  if (containsArguments(inner.body)) return null;
  const res = decompile(sw, ctx, tryLocs, { dialect, delegateOk });
  if (!res) return null;
  const pre = outer.body.body.slice(0, -1).map((s) => t.cloneNode(s, true));
  const decls = res.temps.length ? [t.variableDeclaration('var', res.temps.map((n) => t.variableDeclarator(t.identifier(n))))] : [];
  let body = t.blockStatement([...pre, ...decls, ...res.body]);
  // _sent ve yield* geçicileri (_t1 = yield* g; x = _t1;) tüketen atamaya katlanır
  for (const name of new Set(['_sent', ...res.temps])) body = foldSent(body, name);
  renameCatchTemps(body);
  return t.functionExpression(outer.id, outer.params, body, true, false);
}

// catch (_t0) { … } → catch (_err0) { … }: geçici yalnızca bu catch bloğunda geçiyorsa
function renameCatchTemps(block) {
  const count = new Map();
  t.traverseFast(block, (n) => { if (t.isIdentifier(n) && /^_t\d+$/.test(n.name)) count.set(n.name, (count.get(n.name) ?? 0) + 1); });
  t.traverseFast(block, (n) => {
    if (!t.isCatchClause(n) || !t.isIdentifier(n.param) || !/^_t\d+$/.test(n.param.name)) return;
    const name = n.param.name;
    const fresh = `_err${name.slice(2)}`;
    let inside = 0;
    let clash = false;
    t.traverseFast(n, (x) => { if (t.isIdentifier(x, { name })) inside++; });
    t.traverseFast(block, (x) => { if (t.isIdentifier(x, { name: fresh })) clash = true; });
    if (clash || inside !== count.get(name)) return;
    t.traverseFast(n, (x) => { if (t.isIdentifier(x, { name })) x.name = fresh; });
  });
}

function containsThis(node) {
  let found = false;
  t.traverseFast(node, (n) => { if (t.isThisExpression(n)) found = true; });
  return found;
}
function containsArguments(node) {
  let found = false;
  t.traverseFast(node, (n) => { if (t.isIdentifier(n, { name: 'arguments' })) found = true; });
  return found;
}

// _sent = yield X; a = _sent;  →  a = yield X;  (_sent başka yerde okunmuyorsa; aynısı yield* geçicileri için)
function foldSent(block, temp = '_sent') {
  let reads = 0;
  t.traverseFast(block, (n) => {
    if (t.isIdentifier(n, { name: temp })) reads++;
    if (t.isVariableDeclarator(n) && t.isIdentifier(n.id, { name: temp })) reads--;
  });
  const assigns = [];
  const pairs = [];
  const walk = (list) => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const e = t.isExpressionStatement(s) ? s.expression : null;
      if (e && t.isAssignmentExpression(e, { operator: '=' }) && t.isIdentifier(e.left, { name: temp })) {
        assigns.push(s);
        const next = list[i + 1];
        const ne = t.isExpressionStatement(next) ? next.expression : null;
        if (ne && t.isAssignmentExpression(ne, { operator: '=' }) && t.isIdentifier(ne.right, { name: temp }) && t.isIdentifier(ne.left)) {
          pairs.push([list, i]);
        }
      }
      for (const k of t.VISITOR_KEYS[s.type] ?? []) {
        const v = s[k];
        if (t.isBlockStatement(v)) walk(v.body);
        else if (t.isStatement(v) && !t.isFunction(v)) walk([v]);
        else if (Array.isArray(v) && v.every((x) => t.isSwitchCase(x))) v.forEach((c) => walk(c.consequent));
        else if (t.isCatchClause(v)) walk(v.body.body);
      }
    }
  };
  walk(block.body);
  // her atama bir okuma ile eşleşiyorsa ve tüm okumalar bu çiftlerdeyse katla
  if (pairs.length !== assigns.length || reads !== assigns.length * 2) return block;
  for (const [list, i] of pairs.reverse()) {
    const y = list[i].expression.right;
    list[i + 1].expression.right = y;
    list.splice(i, 1);
  }
  // var _sent bildirimini kaldır
  for (const s of block.body) {
    if (t.isVariableDeclaration(s)) s.declarations = s.declarations.filter((d) => !t.isIdentifier(d.id, { name: temp }));
  }
  block.body = block.body.filter((s) => !(t.isVariableDeclaration(s) && !s.declarations.length));
  return block;
}

// ── async ───────────────────────────────────────────────

// generator ifadesi → async (yield → await); yield* içeriyorsa null
function asyncFrom(genFn) {
  if (!t.isFunctionExpression(genFn) || !genFn.generator || genFn.async) return null;
  let ok = true;
  const body = t.cloneNode(genFn.body, true);
  const visit = (n) => {
    if (!n || typeof n !== 'object' || !ok) return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (!n.type || (t.isFunction(n))) return;
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (t.isYieldExpression(v)) {
        if (v.delegate) { ok = false; return; }
        n[k] = t.awaitExpression(v.argument ?? t.identifier('undefined'));
        visit(n[k]);
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => {
          if (t.isYieldExpression(x)) {
            if (x.delegate) { ok = false; return; }
            v[i] = t.awaitExpression(x.argument ?? t.identifier('undefined'));
            visit(v[i]);
          } else visit(x);
        });
      } else visit(v);
    }
  };
  visit(body);
  if (!ok) return null;
  return { params: genFn.params, body };
}

// Function.length: varsayılanlı/rest ilk parametreye kadar
const fnLength = (params) => {
  let n = 0;
  for (const p of params) { if (t.isAssignmentPattern(p) || t.isRestElement(p)) break; n++; }
  return n;
};

// Sonuç fonksiyon yalnızca çağrılıyor ya da yerleşik bir API'ye callback veriliyor mu? (new/prototype/length okunmaz)
function callOnlyBinding(b) {
  if (!b || !b.constant) return false;
  return callOnlyRefs(b.referencePaths);
}
function callOnlyRefs(refs) {
  return refs.every((r) => {
    const par = r.parentPath;
    if (par.isCallExpression({ callee: r.node })) return true;
    if (par.isMemberExpression({ object: r.node }) && !par.node.computed && ['call', 'apply'].includes(par.node.property.name) &&
      par.parentPath.isCallExpression({ callee: par.node })) return true;
    if (par.isCallExpression() && t.isMemberExpression(par.node.callee)) {
      const k = par.node.callee.property.name;
      if (k === 'addEventListener' && par.node.arguments[1] === r.node) return true;
      if ((k === 'then' || k === 'catch') && par.node.arguments.includes(r.node)) return true;
    }
    if (par.isCallExpression() && t.isIdentifier(par.node.callee) && ['setTimeout', 'setInterval'].includes(par.node.callee.name) &&
      par.node.arguments[0] === r.node && !par.scope.getBinding(par.node.callee.name)) return true;
    return false;
  });
}

const isApplyThisArguments = (n, name) => t.isCallExpression(n) && t.isMemberExpression(n.callee) &&
  t.isIdentifier(n.callee.object, { name }) && t.isIdentifier(n.callee.property, { name: 'apply' }) &&
  n.arguments.length === 2 && t.isThisExpression(n.arguments[0]) && t.isIdentifier(n.arguments[1], { name: 'arguments' });
const returnsApply = (fn, name) => fn.body.body.length === 1 && t.isReturnStatement(fn.body.body[0]) &&
  isApplyThisArguments(fn.body.body[0].argument, name);

// _asyncToGenerator(gen) çağrısının kalıpları; dönüştürdüyse true
function asyncCall(p, stats) {
  const conv = asyncFrom(p.node.arguments[0]);
  if (!conv || p.node.arguments.length !== 1) return false;
  const makeFn = (id) => t.functionExpression(id, conv.params, conv.body, false, true);
  const par = p.parentPath;

  // (a) hemen çağrılıyor: _asyncToGenerator(gen)() / .call(this) / .apply(this, arguments)
  if (par.isCallExpression({ callee: p.node }) ||
    (par.isMemberExpression({ object: p.node }) && !par.node.computed && ['call', 'apply'].includes(par.node.property.name) &&
      par.parentPath.isCallExpression({ callee: par.node }))) {
    p.replaceWith(makeFn(null));
    stats.asyncs++;
    return true;
  }

  // (b) function _foo() { _foo = H(gen); return _foo.apply(this, arguments); }  +  function foo(_x) { return _foo.apply(this, arguments); }
  b: if (par.isAssignmentExpression({ right: p.node }) && t.isIdentifier(par.node.left) && par.parentPath.isExpressionStatement()) {
    const inner = par.parentPath.parentPath.parentPath; // BlockStatement → FunctionDeclaration
    const name = par.node.left.name;
    if (!inner?.isFunctionDeclaration() || inner.node.id.name !== name || inner.node.body.body.length !== 2 ||
      !isApplyThisArguments(inner.node.body.body[1].argument, name)) break b;
    const b = inner.scope.parent.getBinding(name);
    if (!b) break b;
    const outside = b.referencePaths.filter((r) => !r.findParent((x) => x.node === inner.node));
    if (outside.length !== 1) break b;
    const pub = outside[0].findParent((x) => x.isFunctionDeclaration());
    if (!pub || !returnsApply(pub.node, name) || pub.parentPath.node !== inner.parentPath.node) break b;
    if (pub.node.params.length !== fnLength(conv.params) || pub.node.async || pub.node.generator) break b;
    if (!callOnlyBinding(pub.scope.parent.getBinding(pub.node.id.name))) break b;
    if (refersTo(conv.body, name)) break b;
    pub.replaceWith(t.functionDeclaration(pub.node.id, conv.params, conv.body, false, true));
    inner.remove();
    stats.asyncs++;
    return true;
  }

  // (c) function () { var _ref = H(gen); return function NAME(_x) { return _ref.apply(this, arguments); }; }()
  c: if (par.isVariableDeclarator({ init: p.node }) && t.isIdentifier(par.node.id)) {
    const decl = par.parentPath;
    const wrapper = decl.parentPath.parentPath; // BlockStatement → FunctionExpression
    if (!wrapper?.isFunctionExpression() || wrapper.node.params.length || decl.node.declarations.length !== 1) break c;
    const stmts = wrapper.node.body.body;
    const ref = par.node.id.name;
    let pub = null;
    if (stmts.length === 2 && stmts[0] === decl.node && t.isReturnStatement(stmts[1]) && t.isFunctionExpression(stmts[1].argument)) pub = stmts[1].argument;
    else if (stmts.length === 3 && stmts[0] === decl.node && t.isFunctionDeclaration(stmts[1]) && t.isReturnStatement(stmts[2]) &&
      t.isIdentifier(stmts[2].argument, { name: stmts[1].id.name })) pub = stmts[1];
    if (!pub || !returnsApply(pub, ref) || pub.async || pub.generator || pub.params.length !== fnLength(conv.params)) break c;
    const call = wrapper.parentPath;
    if (!call.isCallExpression({ callee: wrapper.node }) || call.node.arguments.length) break c;
    // sonuç sabit bir değişkene gidiyor ve yalnızca çağrılıyor olmalı
    const target = call.parentPath;
    if (!target.isVariableDeclarator({ init: call.node }) || !t.isIdentifier(target.node.id)) break c;
    if (!callOnlyBinding(target.scope.getBinding(target.node.id.name))) break c;
    const pubName = pub.id?.name ?? null;
    if (pubName && refersTo(conv.body, pubName) && pubName !== target.node.id.name) break c;
    if (refersTo(conv.body, ref)) break c;
    call.replaceWith(t.functionExpression(pubName ? t.identifier(pubName) : null, conv.params, conv.body, false, true));
    stats.asyncs++;
    return true;
  }

  // (d) X = H(gen) / var X = H(gen): X yalnızca çağrılıyor (call/apply) → yalnızca H(gen) async function olur.
  //     new/prototype/length okunmadığından sarmalayıcı ile async fonksiyon ayırt edilemez; dış (yayımlanan) fonksiyona dokunulmaz.
  const target = par.isAssignmentExpression({ operator: '=', right: p.node }) && t.isIdentifier(par.node.left) && par.parentPath.isExpressionStatement() ? par.node.left.name
    : par.isVariableDeclarator({ init: p.node }) && t.isIdentifier(par.node.id) ? par.node.id.name : null;
  if (!target) return false;
  const b = p.scope.getBinding(target);
  if (!b || !callOnlyRefs(b.referencePaths)) return false;
  // tek yazım bu atama (ya da bildirimin kendisi / aynı adlı fonksiyon bildirimi)
  if (!b.constantViolations.every((v) => v === par || v.isFunctionDeclaration())) return false;
  if (b.path.isVariableDeclarator() && b.path !== par && b.path.node.init) return false;
  const id = p.node.arguments[0].id;
  // gövde kendi adını çağırıyorsa: önce generator, sonra async fonksiyon olurdu
  if (id && refersTo(conv.body, id.name)) return false;
  p.replaceWith(makeFn(id ? t.identifier(id.name) : null));
  stats.asyncs++;
  return true;
}

// IIFE'nin sonucunun bağlandığı değişkenin her kullanımı uygun mu?
function outerUsesOk(inner, ok) {
  const fn = inner.getFunctionParent();
  const call = fn?.parentPath;
  if (!fn?.isFunctionExpression() || !call?.isCallExpression({ callee: fn.node })) return false;
  const decl = call.parentPath;
  if (!decl.isVariableDeclarator({ init: call.node }) || !t.isIdentifier(decl.node.id)) return false;
  const b = decl.scope.getBinding(decl.node.id.name);
  return Boolean(b?.constant) && b.referencePaths.every(ok);
}

function refersTo(node, name) {
  let found = false;
  t.traverseFast(node, (n) => { if (t.isIdentifier(n, { name })) found = true; });
  return found;
}

// ── nesne yayma ─────────────────────────────────────────

// Hedef nesne taze literal: düz özellikler ve yaymalar (getter/metot/__proto__ yok)
const freshTarget = (o) => o.properties.every((p) => t.isSpreadElement(p) || (t.isObjectProperty(p) &&
  !(t.isIdentifier(p.key, { name: '__proto__' }) || t.isStringLiteral(p.key, { value: '__proto__' })) && !(p.computed && !t.isLiteral(p.key) && !t.isIdentifier(p.key))));
const plainObject = (o) => o.properties.every((p) => t.isObjectProperty(p) && !p.computed &&
  !(t.isIdentifier(p.key, { name: '__proto__' }) || t.isStringLiteral(p.key, { value: '__proto__' })));

function spreadObject(args, kind) {
  const props = [...args[0].properties];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    // objectSpread2: çift sıradaki argümanlar tanımlayıcı kopyası (getter korunur) → literal özellikleri olduğu gibi
    if (kind === 'objectSpread2' && i % 2 === 0) {
      if (!t.isObjectExpression(a) || a.properties.some((p) => t.isSpreadElement(p) || (t.isObjectProperty(p) && p.computed) ||
        t.isIdentifier(p.key, { name: '__proto__' }) || t.isStringLiteral(p.key, { value: '__proto__' }))) return null;
      props.push(...a.properties);
    } else if (t.isObjectExpression(a) && plainObject(a)) {
      props.push(...a.properties);
    } else {
      props.push(t.spreadElement(a));
    }
  }
  return t.objectExpression(props);
}

// ── sınıflar ────────────────────────────────────────────
//
// Taban:   function C(…) { _classCallCheck(this, C); … }  _createClass(C, [...], [...])
// Türetme: _inherits(C, S) + _callSuper(this, C, [args]) (7.23+) ya da var _super = _createSuper(C); _super.call(this, …) (eski)
//          super.m(): _superPropGet(C, "m", this, 3)([args]) (7.24+) ya da _get(_getPrototypeOf(C.prototype), "m", this).call(this, …)
// Eşdeğerlik: _callSuper Reflect.construct(S, args, new.target) + _possibleConstructorReturn = yerel super(); _this ondan sonra
// this'in kendisi. super()'dan önce this okunuyorsa, super set ediliyorsa ya da süper erişimi iç normal fonksiyondaysa çevrilmez.

const exprStmtCall = (st) => (t.isExpressionStatement(st) && t.isCallExpression(st.expression) ? st.expression : null);

// Kardeş deyimler arasında C'ye ait Babel parçaları
function classParts(p, helperOf, name) {
  const list = p.parentPath.get(p.listKey);
  const parts = { inherits: null, superVar: null, createSuperDecl: null, create: null, createStmt: null };
  for (const st of list) {
    const call = exprStmtCall(st.node);
    if (call && t.isIdentifier(call.arguments[0], { name }) && helperOf(st.get('expression.callee')) === 'inherits') {
      if (parts.inherits || call.arguments.length !== 2) return null;
      parts.inherits = st;
      continue;
    }
    if (st.isVariableDeclaration() && st.node.declarations.length === 1) {
      const d = st.node.declarations[0];
      if (t.isIdentifier(d.id) && t.isCallExpression(d.init) && t.isIdentifier(d.init.arguments[0], { name }) &&
        helperOf(st.get('declarations.0.init.callee')) === 'createSuper') {
        if (parts.superVar) return null;
        parts.superVar = d.id.name;
        parts.createSuperDecl = st;
        continue;
      }
    }
    const ret = st.isReturnStatement() && t.isCallExpression(st.node.argument) ? st.get('argument') : null;
    const ex = call ? st.get('expression') : ret;
    if (ex && t.isIdentifier(ex.node.arguments[0], { name }) && helperOf(ex.get('callee')) === 'createClass') {
      if (parts.create) return null;
      parts.create = ex;
      parts.createStmt = st;
    }
  }
  if (!parts.create || parts.createStmt.key < p.key) return null;
  // parçalar fonksiyonla birlikte kesintisiz bir blok oluşturmalı (arada başka kod çalışmasın)
  const keys = [p.key, parts.createStmt.key, parts.inherits?.key, parts.createSuperDecl?.key].filter((k) => k !== undefined);
  const lo = Math.min(...keys);
  const hi = Math.max(...keys);
  if (hi - lo + 1 !== keys.length) return null;
  return parts;
}

// super(...) argümanları: [a, b] dizisi ya da arguments
function superArgs(node) {
  if (t.isArrayExpression(node)) return node.elements.every(Boolean) ? node.elements : null;
  if (t.isIdentifier(node, { name: 'arguments' })) return [t.spreadElement(t.identifier('arguments'))];
  return null;
}

// Kurucu gövdesinde super çağrısını bulur: { index, args, returns }
function findSuperCall(body, start, name, thisVar, superVar, helperOf, fnPath) {
  for (let i = start; i < body.length; i++) {
    const st = body[i];
    let call = null;
    let returns = false;
    if (t.isReturnStatement(st) && t.isCallExpression(st.argument)) { call = st.argument; returns = true; }
    else if (thisVar && t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression, { operator: '=' }) &&
      t.isIdentifier(st.expression.left, { name: thisVar }) && t.isCallExpression(st.expression.right)) call = st.expression.right;
    if (call) {
      const path = returns ? fnPath.get(`body.body.${i}.argument`) : fnPath.get(`body.body.${i}.expression.right`);
      let args = null;
      if (helperOf(path.get('callee')) === 'callSuper' && t.isThisExpression(call.arguments[0]) && t.isIdentifier(call.arguments[1], { name })) {
        args = call.arguments.length === 2 ? [] : call.arguments.length === 3 ? superArgs(call.arguments[2]) : null;
      } else if (superVar && t.isMemberExpression(call.callee) && t.isIdentifier(call.callee.object, { name: superVar }) && !call.callee.computed &&
        t.isThisExpression(call.arguments[0])) {
        const m = call.callee.property.name;
        if (m === 'call') args = call.arguments.slice(1);
        else if (m === 'apply' && call.arguments.length === 2) args = superArgs(call.arguments[1]);
      }
      if (args) return { index: i, args, returns };
    }
    // super'den önceki deyimler this'e dokunmamalı
    let touches = false;
    t.traverseFast(st, (n) => { if (t.isThisExpression(n) || (thisVar && t.isIdentifier(n, { name: thisVar }))) touches = true; });
    if (touches) return null;
  }
  return null;
}

// Süper özellik erişimleri: yerinde super.m / super.m(...) ile değiştirilecek düğümler; desteklenmeyen biçim → null
function superAccesses(fnPath, name, isStatic, thisVar, helperOf) {
  const edits = [];
  let ok = true;
  const recvOk = (n) => t.isThisExpression(n) || (thisVar && t.isIdentifier(n, { name: thisVar }));
  fnPath.traverse({
    CallExpression(q) {
      const kind = helperOf(q.get('callee'));
      if (!kind) return;
      if (kind === 'superPropGet' || kind === 'get') {
        // süper erişim yalnızca metodun kendisinde ya da ok fonksiyonlarında geçerlidir
        const owner = q.getFunctionParent();
        if (owner.node !== fnPath.node && !owner.isArrowFunctionExpression()) { ok = false; return q.stop(); }
      }
      if (kind === 'superPropGet') {
        const [c, key, recv, flags] = q.node.arguments;
        if (!t.isIdentifier(c, { name }) || !t.isStringLiteral(key) || !recvOk(recv) || !t.isNumericLiteral(flags)) { ok = false; return q.stop(); }
        if (Boolean(flags.value & 1) === isStatic) { ok = false; return q.stop(); }
        const member = superMember(key.value);
        if (flags.value & 2) {
          const call = q.parentPath;
          if (!call.isCallExpression({ callee: q.node }) || call.node.arguments.length !== 1) { ok = false; return q.stop(); }
          const args = superArgs(call.node.arguments[0]);
          if (!args) { ok = false; return q.stop(); }
          edits.push([call, t.callExpression(member, args)]);
        } else edits.push([q, member]);
      } else if (kind === 'get') {
        const [base, key, recv] = q.node.arguments;
        if (q.node.arguments.length !== 3 || !t.isStringLiteral(key) || !recvOk(recv) || !t.isCallExpression(base) ||
          helperOf(q.get('arguments.0.callee')) !== 'getPrototypeOf' || base.arguments.length !== 1) { ok = false; return q.stop(); }
        const target = base.arguments[0];
        const proto = t.isMemberExpression(target) && t.isIdentifier(target.object, { name }) && t.isIdentifier(target.property, { name: 'prototype' }) && !target.computed;
        const stat = t.isIdentifier(target, { name });
        if (!(proto || stat) || proto === isStatic) { ok = false; return q.stop(); }
        const member = superMember(key.value);
        const par = q.parentPath;
        if (par.isMemberExpression({ object: q.node }) && !par.node.computed && t.isIdentifier(par.node.property, { name: 'call' }) &&
          par.parentPath.isCallExpression({ callee: par.node }) && recvOk(par.parent.arguments[0])) {
          edits.push([par.parentPath, t.callExpression(member, par.parent.arguments.slice(1))]);
        } else edits.push([q, member]);
      } else if (kind === 'superPropSet' || kind === 'set') {
        ok = false;
        q.stop();
      }
    },
  });
  return ok ? edits : null;
}
export const superMember = (key) => (t.isValidIdentifier(key) ? t.memberExpression(t.super(), t.identifier(key)) : t.memberExpression(t.super(), t.stringLiteral(key), true));

function createClassFor(p, helperOf, info) {
  const fn = p.node;
  if (fn.async || fn.generator || !fn.id || !p.inList) return null;
  const name = fn.id.name;
  const body = fn.body.body;
  // var _this; (türetilmiş kurucu)
  let thisVar = null;
  let k = 0;
  if (t.isVariableDeclaration(body[0]) && body[0].declarations.length === 1 && t.isIdentifier(body[0].declarations[0].id) && !body[0].declarations[0].init) {
    thisVar = body[0].declarations[0].id.name;
    k = 1;
  }
  const chk = exprStmtCall(body[k]);
  if (!chk || helperOf(p.get(`body.body.${k}.expression.callee`)) !== 'classCallCheck') return null;
  if (chk.arguments.length !== 2 || !t.isThisExpression(chk.arguments[0]) || !t.isIdentifier(chk.arguments[1], { name })) return null;
  const parts = classParts(p, helperOf, name);
  if (!parts) return null;
  const derived = Boolean(parts.inherits);
  const superClass = derived ? parts.inherits.node.expression.arguments[1] : null;
  if (derived && !(t.isIdentifier(superClass) || (t.isMemberExpression(superClass) && !superClass.computed && t.isIdentifier(superClass.object)))) return null;
  if (!derived && (thisVar || parts.superVar)) return null;
  const b = p.scope.getBinding(name);
  if (!b || !b.constant) return null;
  const nextExpr = parts.create;
  const [ctorArg] = nextExpr.node.arguments;

  // kurucu gövdesi
  let ctorStmts = body.slice(k + 1);
  let superInfo = null;
  if (derived) {
    superInfo = findSuperCall(body, k + 1, name, thisVar, parts.superVar, helperOf, p);
    if (!superInfo) return null;
  }
  // sıkı mod: Babel sınıf çıktısı genelde "use strict" altında; değilse gövdeler sıkı moda uygun olmalı
  if (!isStrict(p)) {
    if (!strictSafe(p)) return null;
    let ok = true;
    for (const a of nextExpr.get('arguments')) a.traverse({ FunctionExpression(q) { if (!strictSafe(q)) ok = false; q.skip(); } });
    if (!ok) return null;
  }

  // metotlar
  const members = [];
  const methodPaths = [];
  const addProps = (arrPath, isStatic) => {
    const arr = arrPath?.node;
    if (!arr || t.isNullLiteral(arr) || t.isIdentifier(arr, { name: 'undefined' })) return true;
    if (!t.isArrayExpression(arr)) return false;
    for (let i = 0; i < arr.elements.length; i++) {
      const e = arr.elements[i];
      if (!t.isObjectExpression(e)) return false;
      const parts2 = {};
      e.properties.forEach((prop, j) => {
        if (t.isObjectProperty(prop) && !prop.computed && t.isIdentifier(prop.key)) parts2[prop.key.name] = { node: prop.value, path: arrPath.get(`elements.${i}.properties.${j}.value`) };
        else parts2.__bad = true;
      });
      if (parts2.__bad || !t.isStringLiteral(parts2.key?.node)) return false;
      const key = parts2.key.node.value;
      if (key === 'constructor' || !t.isValidIdentifier(key)) return false;
      for (const kind of ['value', 'get', 'set']) {
        const f = parts2[kind];
        if (!f) continue;
        if (!t.isFunctionExpression(f.node)) return false;
        if (f.node.id && refersTo(f.node.body, f.node.id.name)) return false;
        methodPaths.push({ path: f.path, isStatic, kind, key });
      }
      if (parts2.value && !callOnlyProperty(info, key)) return false;
    }
    return true;
  };
  if (!addProps(nextExpr.get('arguments.1'), false) || !addProps(nextExpr.get('arguments.2'), true)) return null;

  // süper erişimleri (önce hepsi doğrulanır, sonra uygulanır)
  const edits = [];
  for (const m of methodPaths) {
    const e = superAccesses(m.path, name, m.isStatic, null, helperOf);
    if (!e) return null;
    if (e.length && !derived) return null;
    edits.push(...e);
  }
  const ctorEdits = superAccesses(p, name, false, thisVar, helperOf);
  if (!ctorEdits || (ctorEdits.length && !derived)) return null;
  edits.push(...ctorEdits);

  // referanslar
  const consumed = new Set([ctorArg, chk.arguments[1]]);
  if (parts.inherits) consumed.add(parts.inherits.node.expression.arguments[0]);
  if (parts.createSuperDecl) consumed.add(parts.createSuperDecl.node.declarations[0].init.arguments[0]);
  const classUse = (r) => {
    const par = r.parentPath;
    if (par.isNewExpression({ callee: r.node })) return true;
    if (par.isBinaryExpression({ operator: 'instanceof', right: r.node })) return true;
    if (par.isClassDeclaration({ superClass: r.node }) || par.isClassExpression({ superClass: r.node })) return true;
    // başka bir Babel sınıfının IIFE argümanı: parametre yalnızca _inherits(…, param) ya da extends
    if (par.isCallExpression() && t.isFunctionExpression(par.node.callee) && par.node.arguments.includes(r.node)) {
      const param = par.node.callee.params[par.node.arguments.indexOf(r.node)];
      const pb = t.isIdentifier(param) ? par.get('callee').scope.getBinding(param.name) : null;
      return Boolean(pb?.constant) && pb.referencePaths.every((x) => (x.parentPath.isCallExpression() && x.parent.arguments[1] === x.node &&
        helperOf(x.parentPath.get('callee')) === 'inherits') || x.parentPath.isClass({ superClass: x.node }));
    }
    return par.isMemberExpression({ object: r.node }) && !par.node.computed && !['prototype', 'call', 'apply', 'bind'].includes(par.node.property.name);
  };
  const editedNodes = new Set(edits.map(([path]) => path.node));
  const insideEdit = (r) => Boolean(r.findParent((x) => editedNodes.has(x.node)));
  const end = parts.createStmt.node.end;
  for (const r of b.referencePaths) {
    if (consumed.has(r.node) || insideEdit(r)) continue;
    // _callSuper(this, C, …) ikinci argümanı
    if (r.parentPath.isCallExpression() && r.parent.arguments[1] === r.node && helperOf(r.parentPath.get('callee')) === 'callSuper') continue;
    if (!runsAfter(r, end, p.parentPath, info)) return null;
    if (classUse(r)) continue;
    if (r.parentPath.isReturnStatement()) {
      if (!outerUsesOk(r, classUse)) return null;
      continue;
    }
    return null;
  }
  if (parts.createStmt.isReturnStatement() && !outerUsesOk(parts.createStmt, classUse)) return null;

  // ── uygula ──
  for (const [path, rep] of edits) path.replaceWith(rep);
  let ctorBody = null;
  if (derived) {
    const { index, args, returns } = superInfo;
    const before = body.slice(k + 1, index);
    const after = body.slice(index + 1);
    // iç normal fonksiyonlar _this'i kapanışla okuyorsa değişken korunur, yoksa this olur
    let captured = false;
    const out = [...before, t.expressionStatement(t.callExpression(t.super(), args)), ...after];
    if (thisVar) {
      for (const st of after) {
        traverseOwn(st, (n, inNested) => { if (inNested && t.isIdentifier(n, { name: thisVar })) captured = true; });
      }
    }
    if (thisVar && !captured) {
      for (const st of after) replaceThisVar(st, thisVar);
      const last = out.at(-1);
      if (t.isReturnStatement(last) && t.isThisExpression(last.argument)) out.pop();
    } else if (thisVar) {
      out.splice(before.length + 1, 0, t.expressionStatement(t.assignmentExpression('=', t.identifier(thisVar), t.thisExpression())));
      out.unshift(t.variableDeclaration('var', [t.variableDeclarator(t.identifier(thisVar))]));
      const last = out.at(-1);
      if (t.isReturnStatement(last) && t.isIdentifier(last.argument, { name: thisVar })) out.pop();
    }
    // return _callSuper(this, C, arguments) tek başına: varsayılan türetilmiş kurucu
    const isDefault = returns && !before.length && fn.params.length === 0 && args.length === 1 && t.isSpreadElement(args[0]) &&
      t.isIdentifier(args[0].argument, { name: 'arguments' });
    ctorBody = isDefault ? null : t.blockStatement(out, fn.body.directives);
  } else {
    ctorStmts = body.slice(k + 1);
    ctorBody = (ctorStmts.length || fn.params.length) ? t.blockStatement(ctorStmts, fn.body.directives) : null;
  }
  for (const m of methodPaths) {
    const f = m.path.node;
    members.push(t.classMethod(m.kind === 'value' ? 'method' : m.kind, t.identifier(m.key), f.params, f.body, false, m.isStatic, f.generator, f.async));
  }
  const ctor = ctorBody ? [t.classMethod('constructor', t.identifier('constructor'), fn.params, ctorBody)] : [];
  const cls = t.classDeclaration(fn.id, superClass, t.classBody([...ctor, ...members]));
  t.inheritsComments(cls, fn);
  if (parts.createStmt.isReturnStatement()) parts.createStmt.node.argument = t.identifier(name);
  else parts.createStmt.remove();
  parts.inherits?.remove();
  parts.createSuperDecl?.remove();
  b.scope.removeOwnBinding(name);
  if (parts.superVar) p.scope.parent.removeOwnBinding(parts.superVar);
  p.replaceWith(cls);
  return cls;
}

// İç normal fonksiyonlara girerken işaretleyerek gezinme
export function traverseOwn(node, cb, inNested = false) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((x) => traverseOwn(x, cb, inNested)); return; }
  if (!node.type) return;
  cb(node, inNested);
  const nested = inNested || (t.isFunction(node) && !t.isArrowFunctionExpression(node));
  for (const key of t.VISITOR_KEYS[node.type] ?? []) traverseOwn(node[key], cb, nested);
}

// _this → this, _assertThisInitialized(_this) → this (yalnızca kurucunun kendi kodunda)
export function replaceThisVar(node, thisVar) {
  const visit = (n, parent, key) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach((x, i) => visit(x, n, i)); return; }
    if (!n.type || (t.isFunction(n) && !t.isArrowFunctionExpression(n))) return;
    if (t.isIdentifier(n, { name: thisVar }) && !(t.isMemberExpression(parent) && key === 'property' && !parent.computed) &&
      !(t.isObjectProperty(parent) && key === 'key' && !parent.computed)) {
      parent[key] = t.thisExpression();
      return;
    }
    if (t.isCallExpression(n) && t.isIdentifier(n.callee) && /^_?assertThisInitialized\d*$/.test(n.callee.name) &&
      n.arguments.length === 1 && t.isIdentifier(n.arguments[0], { name: thisVar })) {
      parent[key] = t.thisExpression();
      return;
    }
    for (const k of t.VISITOR_KEYS[n.type] ?? []) visit(n[k], n, k);
  };
  const holder = { n: node };
  visit(node, holder, 'n');
}
