import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { literalValue } from '../util/pure.js';

// js-confuser "duplicateLiteralsRemoval": const L = [0, 1, "length", ...]; ... L[4] ...
// Hiç değiştirilmeyen ve yalnızca sabit indeksle okunan literal dizisinin elemanlarını yerine yazar.
const MIN_LENGTH = 3;

function declaredFirst(declPath, refs) {
  const stmt = declPath.parentPath;
  const owner = stmt.parentPath;
  if (!(owner.isProgram() || (owner.isBlockStatement() && owner.parentPath.isFunction()))) return false;
  return refs.every((r) => r.node.start > stmt.node.end);
}

// L[i] okuması mı? (yazma, silme, çağırma, for-in hedefi değil)
const isRead = (m, obj) => m.isMemberExpression({ object: obj }) && m.node.computed &&
  !m.parentPath.isAssignmentExpression({ left: m.node }) && !m.parentPath.isUpdateExpression() &&
  !m.parentPath.isUnaryExpression({ operator: 'delete' }) && !m.parentPath.isCallExpression({ callee: m.node }) &&
  !m.parentPath.isForXStatement({ left: m.node });

const isFixed = (m, len) => t.isNumericLiteral(m.node.property) && Number.isInteger(m.node.property.value) &&
  m.node.property.value >= 0 && m.node.property.value < len;

function pathOf(n) {
  if (t.isIdentifier(n)) return n.name;
  if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
    const base = pathOf(n.object);
    return base && `${base}.${n.property.name}`;
  }
  return null;
}

// *.name[sabit] okumaları (kök fark etmez); ad atama hedefi dışında okuma olmayan bir biçimde kullanılıyorsa
// (eleman yazma, push, fonksiyona verme) dizi değişebilir: hiçbiri alınmaz
function aliasReads(ast, name, len) {
  const out = [];
  let ok = true;
  traverse(ast, {
    MemberExpression(q) {
      if (!ok || q.node.computed || !t.isIdentifier(q.node.property, { name })) return;
      if (q.parentPath.isAssignmentExpression({ left: q.node, operator: '=' }) && t.isArrayExpression(q.parent.right)) return;
      if (!isRead(q.parentPath, q.node)) { ok = false; q.stop(); return; }
      if (isFixed(q.parentPath, len)) out.push(q.parentPath);
    },
    // { name: [...] } ya da sınıf alanı: aynı ad başka bir diziye bağlanabilir
    'ObjectProperty|ObjectMethod|ClassProperty|ClassMethod'(q) {
      const k = q.node.key;
      if (!q.node.computed && (t.isIdentifier(k, { name }) || t.isStringLiteral(k, { value: name }))) { ok = false; q.stop(); }
    },
  });
  return ok ? out : [];
}

function propertyUsed(ast, name, except) {
  let used = false;
  traverse(ast, {
    MemberExpression(q) {
      if (q.node !== except && !q.node.computed && t.isIdentifier(q.node.property, { name })) { used = true; q.stop(); }
    },
  });
  return used;
}

// js-confuser iç fonksiyonları: scope.X.L = [0, 1, …]; … scope.X.L[12] …  (dizi kapsam nesnesinde)
async function scopeArrays(ast, { onLog, sandbox, level }) {
  let n = 0;
  const cands = [];
  traverse(ast, {
    AssignmentExpression(p) {
      const { left, right, operator } = p.node;
      if (operator !== '=' || !p.parentPath.isExpressionStatement() || !t.isMemberExpression(left) || left.computed) return;
      if (!t.isArrayExpression(right) || right.elements.length < MIN_LENGTH) return;
      if (!right.elements.every((e) => e !== null && literalValue(e).ok)) return;
      const path = pathOf(left);
      if (!path) return;
      const root = path.split('.')[0];
      const binding = p.scope.getBinding(root);
      if (!binding || binding.constantViolations.length) return;
      // atama fonksiyon gövdesinin doğrudan deyimi olmalı: switch/döngü içinde metin sırası çalışma sırası değildir
      const owner = p.parentPath.parentPath;
      if (!(owner.isProgram() || (owner.isBlockStatement() && owner.parentPath.isFunction()))) return;
      cands.push({ p, path, root, binding, elements: right.elements });
    },
  });
  // alt nesneler başka kapsam nesnelerine kopyalanır ({ X: scope.X }); aynı özellik adı herhangi bir kökten
  // birden çok kez yazılıyorsa (atama, destructuring, ++) hangi dizinin okunduğu belli değildir
  const writes = new Map();
  const arrayWrites = new Map(); // ad → X.ad = [...] atamaları (gözlem için)
  traverse(ast, {
    MemberExpression(q) {
      if (q.node.computed || !t.isIdentifier(q.node.property)) return;
      const par = q.parentPath;
      const lval = par.isAssignmentExpression({ left: q.node }) || par.isUpdateExpression() || par.isForXStatement({ left: q.node }) ||
        par.isArrayPattern() || par.isRestElement() || par.isAssignmentPattern({ left: q.node }) || par.isObjectProperty({ value: q.node }) && par.parentPath.isObjectPattern() ||
        par.isUnaryExpression({ operator: 'delete' });
      if (!lval) return;
      // birebir aynı literal dizinin kopyaları (klonlanmış fonksiyonlar) tek yazma sayılır
      const sig = par.isAssignmentExpression({ operator: '=' }) && t.isArrayExpression(par.node.right) ? gen(par.node.right) : Symbol();
      const name = q.node.property.name;
      if (!writes.has(name)) writes.set(name, new Set());
      writes.get(name).add(sig);
      if (typeof sig === 'string') {
        if (!arrayWrites.has(name)) arrayWrites.set(name, []);
        arrayWrites.get(name).push(par.node);
      }
    },
  });
  const accepted = await observeWrites(ast, cands, writes, arrayWrites, { sandbox, level });
  for (const c of cands.filter((c) => accepted.has(c.path.split('.').pop()))) {
    if (!c.p.node) continue;
    const stmt = c.p.parentPath;
    const fn = c.p.getFunctionParent();
    const prefixes = c.path.split('.').map((_, i, a) => a.slice(0, i + 1).join('.'));
    const reads = [];
    let ok = true;
    traverse(ast, {
      MemberExpression(q) {
        if (!ok || q.node === c.p.node.left) return;
        const qp = pathOf(q.node);
        if (!qp || !prefixes.includes(qp) || q.scope.getBinding(c.root) !== c.binding) return;
        const parent = q.parentPath;
        // dizinin ya da bir üst nesnesinin yeniden atanması modeli bozar
        if (parent.isAssignmentExpression({ left: q.node }) || parent.isUpdateExpression()) { ok = false; return; }
        if (qp !== c.path) return;
        if (!isRead(parent, q.node)) { ok = false; return; }
        // aynı fonksiyondaki okumalar atamadan sonra olmalı; iç fonksiyonlar sonradan çalışır
        if (q.getFunctionParent() === fn && q.node.start < stmt.node.end) { ok = false; return; }
        reads.push(parent);
      },
    });
    if (!ok) continue;
    const fixed = reads.filter((m) => isFixed(m, c.elements.length));
    // ad hep aynı içerikle yazılıyor: başka köklerden ({ X: scope.X } ile geçen) okumalar da aynı diziyi görür
    const alias = aliasReads(ast, c.path.split('.').pop(), c.elements.length).filter((m) => !fixed.includes(m));
    fixed.push(...alias);
    if (!fixed.length) continue;
    for (const m of fixed) m.replaceWith(t.cloneNode(c.elements[m.node.property.value], true));
    n += fixed.length;
    // dizi başka kapsam nesnelerine de geçer ({ X: scope.X }) ve orada başka kökle okunur: ad hiçbir yerde kalmadıysa sil
    if (!propertyUsed(ast, c.path.split('.').pop(), c.p.node.left)) stmt.remove();
    onLog(`const-arrays: ${c.path} (${c.elements.length} literal) ${fixed.length} okuma yerine yazıldı (${alias.length} başka kökten)`, 'info');
  }
  return n;
}

// Aynı ada farklı ifadelerle yazılıyorsa (açılamamış makinedeki özgün kopya: [E[53] + -905, …]) yazmalar
// sandbox'ta gözlenir: çalışan her yazma adayla aynı içeriği üretiyorsa ad kabul edilir.
// shortcut: gözlem tek çalıştırmaya dayanır; yalnızca seviye 3+ ve derin doğrulama yanlışı geri alır.
async function observeWrites(ast, cands, writes, arrayWrites, { sandbox, level }) {
  const accepted = new Set();
  const watch = new Map();
  for (const c of cands) {
    const name = c.path.split('.').pop();
    const sigs = writes.get(name);
    if (sigs?.size === 1) { accepted.add(name); continue; }
    // destructuring, ++ gibi yazmalar ya da gözlem yapılamıyorsa: kabul yok
    if (!sandbox || level < 3 || !sigs || [...sigs].some((x) => typeof x !== 'string')) continue;
    const values = c.elements.map((e) => literalValue(e).value);
    // undefined/null JSON'da iki tarafta da null olur
    if (!values.every((v) => v == null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean')) continue;
    const json = JSON.stringify(values);
    if (watch.has(name) && watch.get(name) !== json) watch.set(name, null); else if (!watch.has(name)) watch.set(name, json);
  }
  const names = [...watch].filter(([, j]) => j !== null).map(([k]) => k);
  if (!names.length) return accepted;
  const saved = [];
  for (const name of names) {
    for (const node of arrayWrites.get(name)) {
      saved.push([node, node.right]);
      node.right = t.callExpression(t.identifier('__peelArr'), [t.stringLiteral(name), node.right]);
    }
  }
  const code = gen(ast);
  for (const [node, right] of saved) node.right = right;
  const prelude = `var __peelArrs = {};
function __peelArr(k, v) {
  var s; try { s = JSON.stringify(v); } catch (e) { s = null; }
  if (!(k in __peelArrs)) __peelArrs[k] = s; else if (__peelArrs[k] !== s) __peelArrs[k] = null;
  return v;
}`;
  const r = await sandbox.run(`${prelude}
try {
${code}
} catch (e) {}
__res.push(__peelArrs);`, { timeoutMs: 8000 });
  const seen = r.res?.[0] ?? {};
  for (const name of names) if (seen[name] === watch.get(name)) accepted.add(name);
  return accepted;
}

export async function run(ast, { onLog, bump, sandbox, level }) {
  let n = await scopeArrays(ast, { onLog, sandbox, level });
  traverse(ast, {
    VariableDeclarator(p) {
      const { id, init } = p.node;
      if (!t.isIdentifier(id) || !t.isArrayExpression(init) || init.elements.length < MIN_LENGTH) return;
      const values = init.elements.map((e) => (e === null ? { ok: false } : literalValue(e)));
      if (!values.every((v) => v.ok)) return;
      const b = p.scope.getBinding(id.name);
      if (!b || b.constantViolations.length || !b.referencePaths.length) return;
      // her kullanım L[...] okuması olmalı: yazma, silme, çağırma, push ya da başka fonksiyona verme yok
      const members = b.referencePaths.map((r) => r.parentPath);
      const readOnly = members.every((m, i) => m.isMemberExpression({ object: b.referencePaths[i].node }) && m.node.computed &&
        !m.parentPath.isAssignmentExpression({ left: m.node }) && !m.parentPath.isUpdateExpression() &&
        !m.parentPath.isUnaryExpression({ operator: 'delete' }) && !m.parentPath.isCallExpression({ callee: m.node }) &&
        !m.parentPath.isForXStatement({ left: m.node }));
      if (!readOnly || !declaredFirst(p, b.referencePaths)) return;
      // sabit indeksli okumalar yazılır; dinamik indeks (L[state + 191]) varsa dizi yerinde kalır
      const fixed = members.filter((m) => t.isNumericLiteral(m.node.property) && Number.isInteger(m.node.property.value) &&
        m.node.property.value >= 0 && m.node.property.value < init.elements.length);
      if (!fixed.length) return;
      for (const m of fixed) m.replaceWith(t.cloneNode(init.elements[m.node.property.value], true));
      n += fixed.length;
      if (fixed.length === members.length) p.remove();
      onLog(`const-arrays: ${id.name} (${init.elements.length} literal) ${fixed.length}/${members.length} okuma yerine yazıldı`, 'info');
    },
  });
  bump('constArray', n);
}
