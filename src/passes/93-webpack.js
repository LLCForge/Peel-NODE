import * as t from '@babel/types';
import { traverse } from '../util/ast.js';

// webpack 4/5 paketi: modül tablosu ({ 944(o) {...} } ya da [function (o, t, e) {...}]) ve
// require fonksiyonu (function e(n) { ... t[n] = { exports: {} } ... o[n](s, s.exports, e) ... }).
// Küçültülmüş paketlerde adlar tek harftir; webpack'in kendi adları geri verilir ve her modülün başına
// kimliği yorum olarak yazılır. Yalnızca yeniden adlandırma: davranış değişmez. Modülleri ayrı dosyalara bölme
// (webpack/browserify/esbuild/parcel) src/core/bundle.js'tedir; bu pass paketi yerinde okunur kılar.

const MODULE_PARAMS = ['module', 'exports', '__webpack_require__'];
// yalnızca küçültücü/obfuscator adları (e, t, _0x1a2b, a0_0x3f) değiştirilir; okunur adlara dokunulmaz
// (rename pass'inin ürettiği fn1/arg2/v3/c4 adları da sayılır)
const mangled = (name) => name.length <= 2 || /^(?:[a-z]\d*_)?_?0x[0-9a-f]+$/i.test(name) || /^(?:fn|arg|v|c)\d+$/.test(name);
const emptyObj = (n) => t.isObjectExpression(n) && !n.properties.length;

// R içinde: M[id](a, a.exports, R)  ya da  M[id].call(a.exports, a, a.exports, R)
function modulesTableName(fnNode, selfName) {
  const param = fnNode.params[0];
  if (fnNode.params.length !== 1 || !t.isIdentifier(param)) return null;
  let hasExports = false;
  let table = null;
  t.traverseFast(fnNode.body, (n) => {
    // { exports: {} }  ya da (transformObjectKeys sonrası)  m.exports = {}
    if (t.isObjectProperty(n) && t.isIdentifier(n.key, { name: 'exports' }) && emptyObj(n.value)) hasExports = true;
    if (t.isAssignmentExpression(n, { operator: '=' }) && t.isMemberExpression(n.left) && !n.left.computed &&
        t.isIdentifier(n.left.property, { name: 'exports' }) && emptyObj(n.right)) hasExports = true;
    if (!t.isCallExpression(n) || !n.arguments.some((a) => t.isIdentifier(a, { name: selfName }))) return;
    let c = n.callee;
    if (t.isMemberExpression(c) && !c.computed && t.isIdentifier(c.property, { name: 'call' })) c = c.object;
    if (t.isMemberExpression(c) && c.computed && t.isIdentifier(c.object) && t.isIdentifier(c.property, { name: param.name })) table = c.object.name;
  });
  return hasExports ? table : null;
}

function moduleFunctions(init) {
  const out = [];
  if (t.isObjectExpression(init)) {
    for (const p of init.properties) {
      const key = t.isIdentifier(p.key) ? p.key.name : p.key?.value;
      if (t.isObjectMethod(p)) out.push({ key, fn: p });
      else if (t.isObjectProperty(p) && t.isFunction(p.value)) out.push({ key, fn: p.value });
      else return null;
    }
  } else if (t.isArrayExpression(init)) {
    init.elements.forEach((e, i) => { if (t.isFunction(e)) out.push({ key: i, fn: e }); });
  } else {
    return null;
  }
  return out.length ? out : null;
}

// binding'i name olarak adlandırmak güvenli mi: bildirim kapsamında o ad bağlı değil, hiçbir referansın
// görüş alanında aynı adlı başka bağ yok ve kapsamda o adla serbest (global) bir okuma yok
function canRename(binding, name) {
  const home = binding.scope;
  if (home.hasOwnBinding(name)) return false;
  // bildirim kapsamının hemen dışında bu adın şu anki anlamı (yoksa global)
  const outer = home.parent?.getBinding(name);
  // referanslarla bağ arasında aynı adlı bir iç bağ varsa referans ona kayardı
  if (binding.referencePaths.some((r) => { const b = r.scope.getBinding(name); return b && b !== outer; })) return false;
  // kapsam içinde dıştaki/global adı okuyan bir yer varsa yeni bağ onu yakalardı
  let captured = false;
  home.path.traverse({
    Identifier(p) {
      if (p.node.name !== name || !p.isReferencedIdentifier()) return;
      const b = p.scope.getBinding(name);
      if (!b || b === outer) { captured = true; p.stop(); }
    },
  });
  return !captured;
}

export async function run(ast, { onLog, bump }) {
  let renamed = 0;
  let modules = 0;
  traverse(ast, {
    Function(fnPath) {
      let selfName = null;
      if (fnPath.isFunctionDeclaration() && fnPath.node.id) selfName = fnPath.node.id.name;
      else if (fnPath.parentPath.isVariableDeclarator() && t.isIdentifier(fnPath.parentPath.node.id)) selfName = fnPath.parentPath.node.id.name;
      if (!selfName) return;
      const tableName = modulesTableName(fnPath.node, selfName);
      if (!tableName) return;
      const tableBinding = fnPath.scope.getBinding(tableName);
      if (!tableBinding?.path.isVariableDeclarator() || !tableBinding.constant) return;
      const mods = moduleFunctions(tableBinding.path.node.init);
      if (!mods) return;

      for (const { key, fn } of mods) {
        if (!fn.leadingComments?.some((c) => c.value.includes('webpack modül'))) {
          t.addComment(fn, 'leading', ` webpack modül ${JSON.stringify(key)} `);
          modules++;
        }
      }
      const modPaths = [];
      tableBinding.path.get('init').traverse({
        Function(p) {
          if (mods.some((m) => m.fn === p.node)) modPaths.push(p);
          p.skip();
        },
      });
      for (const mp of modPaths) {
        mp.node.params.forEach((prm, i) => {
          const target = MODULE_PARAMS[i];
          if (!target || !t.isIdentifier(prm) || !mangled(prm.name)) return;
          const b = mp.scope.getBinding(prm.name);
          if (!b || b.kind !== 'param' || !canRename(b, target)) return;
          mp.scope.rename(prm.name, target);
          renamed++;
        });
      }
      const selfBinding = fnPath.parentPath.scope.getBinding(selfName);
      if (selfBinding && mangled(selfName) && canRename(selfBinding, '__webpack_require__')) {
        selfBinding.scope.rename(selfName, '__webpack_require__');
        renamed++;
      }
      if (mangled(tableName) && canRename(tableBinding, '__webpack_modules__')) {
        tableBinding.scope.rename(tableName, '__webpack_modules__');
        renamed++;
      }
      fnPath.skip();
    },
  });
  if (modules || renamed) onLog(`webpack: ${modules} modül işaretlendi, ${renamed} ad geri verildi`, 'info');
  bump('webpack', modules + renamed);
}
