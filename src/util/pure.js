import * as t from '@babel/types';

// Programın gölgelemediği (binding yoksa) ve deterministik global'ler
const SAFE_GLOBALS = new Set([
  'undefined', 'NaN', 'Infinity', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'JSON',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'atob', 'btoa', 'escape', 'unescape',
  'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent',
]);
const BANNED_TYPES = new Set([
  'AssignmentExpression', 'UpdateExpression', 'NewExpression', 'ThisExpression', 'FunctionExpression',
  'ArrowFunctionExpression', 'AwaitExpression', 'YieldExpression', 'ClassExpression', 'Super',
  'TaggedTemplateExpression', 'MetaProperty', 'Import',
]);
// Yan etki ya da deterministik olmayan sonuç üreten erişimler
const BANNED_PROPS = new Set([
  'random', 'now', 'constructor', 'prototype', '__proto__', 'defineProperty', 'defineProperties',
  'setPrototypeOf', 'assign', 'freeze', '__defineGetter__', '__defineSetter__', 'push', 'pop',
  'shift', 'unshift', 'splice', 'sort', 'fill', 'copyWithin',
]);

function propName(node) {
  if (!node.computed) return node.property.name;
  if (t.isStringLiteral(node.property)) return node.property.value;
  if (t.isNumericLiteral(node.property)) return null;
  return undefined; // dinamik anahtar: değerlendirme dışı
}

const inside = (p, ancestor) => p === ancestor || Boolean(p.findParent((x) => x === ancestor));

// Program seviyesinde fonksiyon bildirimi; yeniden atanıyorsa yalnızca kendi gövdesinde
// (obfuscator.io decoder'ları ilk çağrıda kendini önbellekli sürümle değiştirir).
function isProgramFunction(b) {
  return b.kind === 'hoisted' && b.scope.path.isProgram() &&
    b.constantViolations.every((v) => inside(v, b.path));
}

const fnVerdict = new WeakMap();

// Fonksiyonun sonucu yalnızca argümanlarına ve programın sabit tablolarına mı bağlı?
// DOM/zaman/rastgelelik okuyan ya da dışarıda değişen duruma bakan fonksiyon tek değere sabitlenemez.
function deterministicFn(binding, visiting = new Set()) {
  const node = binding.path.node;
  if (fnVerdict.has(node)) return fnVerdict.get(node);
  if (visiting.has(node)) return true; // özyineleme: diğer kontroller sonucu belirler
  visiting.add(node);
  let ok = true;
  const fail = (p) => { ok = false; p.stop(); };
  binding.path.traverse({
    ThisExpression: fail,
    MemberExpression(p) {
      const name = propName(p.node);
      if (name === 'random' || name === 'now') fail(p);
    },
    Identifier(p) {
      if (!p.isReferencedIdentifier()) return;
      const name = p.node.name;
      const b = p.scope.getBinding(name);
      if (!b) {
        if (!SAFE_GLOBALS.has(name) && name !== 'RegExp' && name !== 'arguments') fail(p);
        return;
      }
      if (inside(b.path, binding.path)) return;
      if (!b.scope.path.isProgram()) return fail(p);
      if (isProgramFunction(b)) {
        if (!deterministicFn(b, visiting)) fail(p);
        return;
      }
      // program değişkeni: yalnızca bu fonksiyon içinde değiştiriliyorsa (tablo, önbellek)
      if (!b.constantViolations.every((v) => inside(v, binding.path))) fail(p);
    },
  });
  visiting.delete(node);
  fnVerdict.set(node, ok);
  return ok;
}

/**
 * İfade sandbox'ta değerlendirilip sonucu yerine yazılabilir mi?
 * programFns: true ise program kapsamındaki sabit fonksiyon bildirimlerine çağrıya izin verir
 * (yalnızca program bir değerlendirme bağlamına yüklüyken anlamlı).
 */
export function isPureExpr(path, { programFns = false } = {}) {
  // with yalnızca isim çözümlemesini etkiler: saf literal ifadeler (\"a\" + \"b\") içinde de katlanabilir
  const inWith = Boolean(path.findParent((p) => p.isWithStatement()));
  const check = (p) => {
    if (inWith && p.isIdentifier() && p.isReferencedIdentifier()) return false;
    const n = p.node;
    if (BANNED_TYPES.has(n.type)) return false;
    if (p.isUnaryExpression({ operator: 'delete' })) return false;
    if (p.isMemberExpression() || p.isOptionalMemberExpression()) {
      const name = propName(n);
      if (name === undefined) return false;
      if (name !== null && BANNED_PROPS.has(name)) return false;
    }
    if (p.isIdentifier() && p.isReferencedIdentifier()) {
      const b = p.scope.getBinding(n.name);
      if (!b) return SAFE_GLOBALS.has(n.name);
      // Program fonksiyonu yalnızca decoder biçiminde çağrılabilir: M(0x2). Özelliğini okumak (M.cache)
      // değişken durumu sabitler; greet("x") gibi normal fonksiyonları katlamak program mantığını siler.
      const call = p.parentPath;
      const decoderCall = call.isCallExpression({ callee: n }) && call.node.arguments.length > 0 &&
        call.node.arguments.every((a) => literalValue(a).ok) &&
        call.node.arguments.some((a) => typeof literalValue(a).value === 'number');
      return programFns && decoderCall && isProgramFunction(b) && deterministicFn(b);
    }
    return true;
  };
  if (!check(path)) return false;
  let ok = true;
  path.traverse({
    enter(p) {
      if (!check(p)) { ok = false; p.stop(); }
    },
  });
  return ok;
}

// İfade programın kendi binding'lerinden birine dokunuyor mu?
export function usesProgramBindings(path) {
  let found = false;
  path.traverse({
    Identifier(p) {
      if (p.isReferencedIdentifier() && p.scope.getBinding(p.node.name)) { found = true; p.stop(); }
    },
  });
  return found;
}

// Yan etkisiz literal ağacı mı (dizi/obje içindekiler dahil)?
export function isLiteralTree(node) {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node) || t.isNullLiteral(node)) return true;
  if (t.isUnaryExpression(node, { operator: '-' })) return t.isNumericLiteral(node.argument);
  if (t.isArrayExpression(node)) return node.elements.every((e) => e === null || isLiteralTree(e));
  if (t.isObjectExpression(node)) {
    return node.properties.every((p) => t.isObjectProperty(p) && !p.computed && isLiteralTree(p.value));
  }
  if (t.isTemplateLiteral(node)) return node.expressions.length === 0;
  return false;
}

// Literal düğümün JS değeri (yoksa undefined + ok:false)
const GLOBAL_CONSTANTS = { NaN: NaN, Infinity: Infinity, undefined: undefined };

export function literalValue(node) {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return { ok: true, value: node.value };
  if (t.isNullLiteral(node)) return { ok: true, value: null };
  if (t.isUnaryExpression(node, { operator: '-' }) && t.isNumericLiteral(node.argument)) return { ok: true, value: -node.argument.value };
  if (t.isUnaryExpression(node, { operator: 'void' }) && t.isNumericLiteral(node.argument)) return { ok: true, value: undefined };
  // const-fold NaN/Infinity'yi ad olarak üretir. shortcut: bu adların gölgelendiği kod varsayılmıyor
  if (t.isIdentifier(node) && Object.hasOwn(GLOBAL_CONSTANTS, node.name)) return { ok: true, value: GLOBAL_CONSTANTS[node.name] };
  if (t.isUnaryExpression(node, { operator: '-' }) && t.isIdentifier(node.argument, { name: 'Infinity' })) return { ok: true, value: -Infinity };
  return { ok: false };
}
