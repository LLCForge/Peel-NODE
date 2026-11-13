import * as t from '@babel/types';
import { traverse } from '../util/ast.js';

// İsimlendirme ve sözdizimi dönüşümlerinin ortak güvenlik analizi: hangi binding'e dokunmak davranışı korur?

export const GLOBAL_OBJECTS = new Set(['window', 'self', 'globalThis', 'top', 'parent', 'frames']);

const RESERVED = new Set(('break case catch class const continue debugger default delete do else enum export extends false finally ' +
  'for function if import in instanceof new null return super switch this throw true try typeof var void while with yield ' +
  'let static implements interface package private protected public await arguments eval undefined NaN Infinity').split(' '));

// Kod içinde hiç geçmese de yerel isim olarak seçilmemesi gereken tarayıcı/JS global'leri (okuyanı yanıltır)
const AVOID = new Set(('window document navigator location console Math JSON Object Array String Number Boolean Symbol Date ' +
  'RegExp Error Promise Map Set WeakMap fetch self top parent frames history screen localStorage sessionStorage ' +
  'setTimeout setInterval require module exports process global globalThis name length constructor prototype').split(' '));

export const isValidName = (s) => typeof s === 'string' && s.length > 0 && s.length <= 64 &&
  /^[A-Za-z_$][\w$]*$/.test(s) && !RESERVED.has(s);
export const isAvoided = (s) => AVOID.has(s);

const memberKey = (m) => (!m.computed && t.isIdentifier(m.property) ? m.property.name
  : t.isStringLiteral(m.property) ? m.property.value : t.isNumericLiteral(m.property) ? String(m.property.value) : null);

// Hesaplanan anahtar kesin sayı ya da Symbol mü? (dizi indeksi bir metot adını okuyamaz)
function harmlessKey(p, depth = 0) {
  const n = p.node;
  if (depth > 4) return false;
  if (t.isNumericLiteral(n) || t.isUpdateExpression(n)) return true;
  if (t.isUnaryExpression(n) && ['-', '+', '~'].includes(n.operator)) return true;
  if (t.isBinaryExpression(n)) {
    if (n.operator !== '+') return ['-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>'].includes(n.operator);
    return harmlessKey(p.get('left'), depth + 1) && harmlessKey(p.get('right'), depth + 1);
  }
  if (t.isMemberExpression(n) && t.isIdentifier(n.object, { name: 'Symbol' }) && !p.scope.getBinding('Symbol')) return true;
  if (t.isIdentifier(n)) {
    const b = p.scope.getBinding(n.name);
    if (!b || !b.path.isVariableDeclarator()) return false;
    // başlangıçsız bildirim: her atama sayısal olmalı (okumadan önce atanmasa bile undefined bir metot adı değildir)
    if (b.path.node.init ? !harmlessKey(b.path.get('init'), depth + 1) : !b.constantViolations.length) return false;
    return b.constantViolations.every((v) => v.isUpdateExpression() ||
      (v.isAssignmentExpression() && v.node.operator !== '+=' && (v.node.operator !== '=' || harmlessKey(v.get('right'), depth + 1))));
  }
  return false;
}

// Fonksiyon dışı (program) bağlamındaki this: script modunda global nesne
function topLevelThis(p) {
  return !p.findParent((x) => x.isFunction() && !x.isArrowFunctionExpression());
}

/**
 * Programı bir kez tarar.
 * - taken: programda geçen tüm tanımlayıcılar (yeni isim çakışmasın)
 * - withStatements: with blokları (E227)
 * - evalScopes: doğrudan eval çağrısının görebildiği kapsamlar (E230)
 * - globalCode: eval dışı dinamik kod (Function, dolaylı eval, string setTimeout): global binding'leri görür
 * - globalNames / dynamicGlobal: window.x biçiminde erişilen global'ler (E228)
 * - dynamicMember: anahtarı hesaplanan üye erişimi var mı (özellik adı kanıtlarını geçersiz kılar)
 * - nonCallProps: çağrı dışında okunan özellik adları; callProps: çağrılan özellik adları
 */
export function scan(ast, { ignore = null } = {}) {
  const info = {
    taken: new Set(),
    withStatements: [],
    evalScopes: new Set(),
    globalCode: false,
    globalNames: new Set(),
    dynamicGlobal: false,
    dynamicMember: false,
    nonCallProps: new Map(),
    forIn: false,
    module: ast.program.sourceType === 'module',
    strict: ast.program.sourceType === 'module' || ast.program.directives.some((d) => d.value.value === 'use strict'),
    reflective: false,
  };
  const addProp = (k, node) => {
    if (!info.nonCallProps.has(k)) info.nonCallProps.set(k, []);
    info.nonCallProps.get(k).push(node);
  };
  // ignore: bilinen yardımcı gövdeleri; isimleri yine alınır ama özellik/yansıma kanıtlarını etkilemezler
  if (ignore?.size) {
    traverse(ast, {
      Function(p) {
        if (!ignore.has(p.node)) return;
        p.traverse({ Identifier(q) { info.taken.add(q.node.name); } });
        p.skip();
      },
      Identifier(p) { info.taken.add(p.node.name); },
    });
  }
  // global nesnenin kendisi değer olarak kullanılıyor mu (window geçiriliyor, "x" in window, Object.keys(window))
  const bareGlobal = (p) => {
    const par = p.parentPath;
    if (par.isMemberExpression({ object: p.node }) && memberKey(par.node) !== null) return false;
    // typeof window, window === x: özelliklere dokunmaz
    if (par.isUnaryExpression({ operator: 'typeof' })) return false;
    return !(par.isBinaryExpression() && ['===', '!==', '==', '!='].includes(par.node.operator));
  };
  traverse(ast, {
    Function(p) { if (ignore?.has(p.node)) p.skip(); },
    Identifier(p) {
      info.taken.add(p.node.name);
      if (GLOBAL_OBJECTS.has(p.node.name) && p.isReferencedIdentifier() && !p.scope.getBinding(p.node.name) && bareGlobal(p)) info.dynamicGlobal = true;
    },
    ThisExpression(p) { if (topLevelThis(p) && bareGlobal(p)) info.dynamicGlobal = true; },
    WithStatement(p) { info.withStatements.push(p); },
    ForInStatement() { info.forIn = true; },
    CallExpression(p) {
      const c = p.node.callee;
      if (t.isIdentifier(c, { name: 'eval' }) && !p.scope.getBinding('eval')) {
        for (let s = p.scope; s; s = s.parent) info.evalScopes.add(s);
        info.globalCode = true;
      } else if (t.isIdentifier(c) && !p.scope.getBinding(c.name) &&
        (c.name === 'Function' || ((c.name === 'setTimeout' || c.name === 'setInterval') && p.node.arguments.length &&
          !t.isFunction(p.node.arguments[0]) && !t.isIdentifier(p.node.arguments[0])))) {
        info.globalCode = true;
      } else if (t.isMemberExpression(c) && memberKey(c) === 'eval') {
        info.globalCode = true;
      } else if (t.isSequenceExpression(c) && t.isIdentifier(c.expressions.at(-1), { name: 'eval' })) {
        info.globalCode = true;
      }
    },
    NewExpression(p) {
      if (t.isIdentifier(p.node.callee, { name: 'Function' }) && !p.scope.getBinding('Function')) info.globalCode = true;
    },
    MemberExpression(p) {
      const n = p.node;
      const key = memberKey(n);
      if (key === null && !harmlessKey(p.get('property'))) info.dynamicMember = true;
      // salt yazma (x.m = …) metodu okumaz; çağrı dışı her okuma metodun değerini sızdırabilir
      else if (!(p.parentPath.isCallExpression({ callee: n }) || p.parentPath.isOptionalCallExpression({ callee: n }) ||
        p.parentPath.isAssignmentExpression({ left: n, operator: '=' }))) addProp(key, n);
      if (key === 'defineProperty' || key === 'getOwnPropertyNames' || key === 'getOwnPropertyDescriptor' ||
        key === 'freeze' || key === 'seal' || key === 'preventExtensions' || key === 'keys' || key === 'entries' ||
        key === 'values' || key === 'getPrototypeOf' || key === 'setPrototypeOf' || key === 'ownKeys') info.reflective = true;
      const obj = n.object;
      const isGlobalObj = (t.isIdentifier(obj) && GLOBAL_OBJECTS.has(obj.name) && !p.scope.getBinding(obj.name)) ||
        (t.isThisExpression(obj) && topLevelThis(p));
      if (!isGlobalObj) return;
      if (key === null) info.dynamicGlobal = true;
      else info.globalNames.add(key);
    },
    OptionalMemberExpression(p) {
      const key = memberKey(p.node);
      if (key === null && !harmlessKey(p.get('property'))) info.dynamicMember = true;
      else addProp(key, p.node);
    },
    ObjectPattern(p) {
      // const { m } = obj: özellik çağrı dışında okunuyor
      for (const prop of p.node.properties) {
        if (t.isObjectProperty(prop) && !prop.computed && t.isIdentifier(prop.key)) addProp(prop.key.name, prop);
        else if (t.isObjectProperty(prop) && prop.computed) info.dynamicMember = true;
      }
    },
  });
  return info;
}

// Kapsamın alt ağacında with var mı?
export function scopeHasWith(info, scope) {
  return info.withStatements.some((w) => w.scope === scope || w.findParent((x) => x.node === scope.path.node));
}

/**
 * Binding'in adını değiştirmek davranışı koruyor mu? Değilse nedeni döner.
 * E227: with gövdesinden görülebilen binding'ler; E230: eval'in görebildiği kapsamlar;
 * E228: window.x ile erişilen ya da dinamik global erişimi olan programlarda global binding'ler.
 */
export function renameBlocker(info, binding) {
  const scope = binding.scope;
  if (scopeHasWith(info, scope)) return 'with';
  if (info.evalScopes.has(scope)) return 'eval';
  const programLevel = scope.path.isProgram();
  if (programLevel && !info.module) {
    if (info.globalCode) return 'eval';
    if (info.dynamicGlobal) return 'window[...]';
    if (info.globalNames.has(binding.identifier.name)) return 'window.x';
  }
  return null;
}

const enclosingFn = (p, stopAt) => {
  for (let x = p.parentPath; x && x.node !== stopAt?.node; x = x.parentPath) {
    if (x.isFunction() || x.isClassMethod() || x.isObjectMethod()) return x;
  }
  return null;
};

/**
 * ref, kaynak konumu pos'tan sonra (pos'a kadarki kod çalıştıktan sonra) mı çalışır?
 * Aynı fonksiyonda metin sırası yeterli; iç fonksiyonda ise fonksiyonun oluşturulma ya da çağrılma anına bakılır.
 */
export function runsAfter(ref, pos, root, info = null, depth = 0) {
  if (ref.node.start == null || ref.node.start < pos) return false;
  const fn = enclosingFn(ref, root);
  if (!fn) return true;
  if (fn.node.start == null) return false;
  if (fn.node.start >= pos) return true; // ifade olarak pos'tan sonra oluşturuluyor
  if (!fn.isFunctionDeclaration() || depth > 4) return false;
  const b = fn.parentPath.scope.getBinding(fn.node.id.name);
  if (!b || b.path.node !== fn.node || !b.constant) return false;
  // hoist edilen bildirim: her çağrısı pos'tan sonra olmalı ve başka yolla (global özellik) erişilmemeli
  if (b.scope.path.isProgram() && !info?.module &&
    (!info || info.globalCode || info.dynamicGlobal || info.globalNames.has(fn.node.id.name))) return false;
  return b.referencePaths.every((r) => runsAfter(r, pos, root, info, depth + 1));
}

// Fonksiyon gövdesinde (iç normal fonksiyonlar hariç, ok fonksiyonları dahil) this/arguments/super/new.target var mı?
export function usesOwnContext(fnPath) {
  let found = false;
  fnPath.traverse({
    Function(p) { if (!p.isArrowFunctionExpression()) p.skip(); },
    ThisExpression(p) { found = true; p.stop(); },
    Super(p) { found = true; p.stop(); },
    MetaProperty(p) { found = true; p.stop(); },
    Identifier(p) {
      if (p.node.name === 'arguments' && p.isReferencedIdentifier() && !p.scope.getBinding('arguments')) { found = true; p.stop(); }
    },
  });
  return found;
}

// Program ya da fonksiyon zinciri sıkı modda mı?
export function isStrict(p) {
  if (p.isProgram?.() && (p.node.sourceType === 'module' || p.node.directives.some((d) => d.value.value === 'use strict'))) return true;
  for (let x = p; x; x = x.parentPath) {
    if (x.isClass()) return true;
    if (x.isProgram()) return x.node.sourceType === 'module' || x.node.directives.some((d) => d.value.value === 'use strict');
    if (x.isFunction() && t.isBlockStatement(x.node.body) && x.node.body.directives.some((d) => d.value.value === 'use strict')) return true;
  }
  return false;
}

/**
 * Sloppy kodun sıkı moda (class gövdesi) taşınması davranışı değiştirir mi? Kanıtlanabilir güvenli alt küme:
 * with/eval/arguments/delete x/oktal yok, tanımsız isme atama yok, iç normal fonksiyonlarda this yok,
 * üye ataması yalnızca this.x biçiminde (primitive'e yazma sıkı modda hata verir).
 */
export function strictSafe(fnPath) {
  let ok = true;
  const no = (p) => { ok = false; p.stop(); };
  fnPath.traverse({
    WithStatement: no,
    FunctionDeclaration(p) { if (!p.parentPath.isBlockStatement() || !p.parentPath.parentPath.isFunction()) no(p); },
    Function(p) {
      const names = p.node.params.filter((x) => t.isIdentifier(x)).map((x) => x.name);
      if (new Set(names).size !== names.length) no(p);
      if (!p.isArrowFunctionExpression()) {
        p.traverse({
          Function(q) { if (!q.isArrowFunctionExpression()) q.skip(); },
          ThisExpression(q) { ok = false; q.stop(); },
        });
        if (!ok) p.stop();
      }
    },
    Identifier(p) {
      const n = p.node.name;
      if ((n === 'arguments' || n === 'eval') && p.isReferencedIdentifier() && !p.scope.getBinding(n)) no(p);
    },
    UnaryExpression(p) { if (p.node.operator === 'delete' && t.isIdentifier(p.node.argument)) no(p); },
    NumericLiteral(p) { if (/^0\d/.test(p.node.extra?.raw ?? '')) no(p); },
    StringLiteral(p) { if (/\\(0\d|[1-7])/.test(p.node.extra?.raw ?? '')) no(p); },
    AssignmentExpression(p) { if (!assignTargetSafe(p, p.node.left)) no(p); },
    UpdateExpression(p) { if (!assignTargetSafe(p, p.node.argument)) no(p); },
  });
  return ok;
}

function assignTargetSafe(p, left) {
  if (t.isIdentifier(left)) return Boolean(p.scope.getBinding(left.name));
  if (t.isMemberExpression(left)) {
    if (t.isThisExpression(left.object)) return true;
    // yerelde nesne/dizi literali ya da new ile oluşturulup hiç yeniden atanmayan değişken
    if (t.isIdentifier(left.object)) {
      const b = p.scope.getBinding(left.object.name);
      const init = b?.path.isVariableDeclarator() ? b.path.node.init : null;
      return Boolean(b?.constant && init && (t.isObjectExpression(init) || t.isArrayExpression(init) || t.isNewExpression(init)));
    }
    return false;
  }
  return false; // desen ataması: elemanlarının hedefleri ayrıca kanıtlanmalı
}

/**
 * Bir özellik adının program genelinde yalnızca çağrı olarak kullanıldığı kanıtlanabiliyor mu?
 * (metot → sınıf metodu / kısa metot dönüşümleri: yöntem değeri dışarı sızmıyorsa new ile çağrılamaz, prototype okunamaz)
 */
export function callOnlyProperty(info, name, allowed = new Set()) {
  if (info.dynamicMember || info.forIn || info.reflective) return false;
  return (info.nonCallProps.get(name) ?? []).every((n) => allowed.has(n));
}
