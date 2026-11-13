import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { ssaFor, versionAt, insertOnEdge, walkEval, destruct } from '../opt/ssa.js';
import { sccp, absint, ALL } from '../opt/lattice.js';
import { isPureTyped, literalFor, functionPaths, hasDynamicScope, exprType, nodeSize, stmtOf } from '../opt/util.js';
import { GENERATED } from '../naming/metrics.js';

// SSA tabanlı skaler optimizasyonlar (fonksiyon başına, içten dışa):
//   E664 fazla yükleme eleme (kaçmayan nesnelerin skaler değiştirilmesi), E680 SCCP + E661 koşullara sabit yayılımı,
//   E695 erişilemez dalların silinmesi, E662 kopya yayılımı, E665 GVN, E663 ölü atama eleme, E666 CSE, E667 PRE.
// Her dönüşüm yalnızca kanıtlanan durumda uygulanır: tipler (valueOf/getter/BigInt) ve SSA sürüm eşitliği denetlenir.

const PROTO = new Set(Object.getOwnPropertyNames(Object.prototype));
// anlamlı ad (kullanıcının seçtiği): adlandırılmış nesne yapay skalerlere bölünmez
const meaningful = (name) => name.length >= 3 && !GENERATED.test(name);

export async function run(ast, { onLog, bump }) {
  if (hasDynamicScope(ast, traverse)) return;
  const st = { sroa: 0, constant: 0, branch: 0, copy: 0, gvn: 0, dead: 0, cse: 0, pre: 0 };
  for (const fn of functionPaths(ast, traverse)) {
    if (!fn.node || fn.findParent((p) => !p.node)) continue;
    try {
      optimize(fn, st);
    } catch (e) {
      // analiz edilemeyen fonksiyon atlanır; ağaçta yarım değişiklik kalmasın diye pass hatası pipeline'da geri alınır
      throw new Error(`ssa-opt (${fn.node.id?.name ?? 'anonim'}): ${e.message}`);
    }
  }
  const total = Object.values(st).reduce((a, b) => a + b, 0);
  if (total) onLog(`ssa-opt: ${Object.entries(st).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}`, 'info');
  for (const [k, v] of Object.entries(st)) bump(`ssa.${k}`, v);
}

function optimize(fn, st) {
  if (sroa(fn)) { st.sroa++; fn.scope.crawl(); }
  const phases = [constants, copies, gvn, deadAssignments, cse, pre];
  let fx = null;
  for (const phase of phases) {
    // SSA yalnızca önceki aşama ağacı değiştirdiyse yeniden kurulur
    if (!fx) {
      fx = ssaFor(fn);
      if (!fx) return;
      // E683: dönüşümler özgün adlara geri yazılır (φ-ağları birleştirilir); bu ancak SSA girişimsizse geçerli.
      // Girişim varsa (kopya gerekecekse) fonksiyon atlanır.
      if (!destruct(fx, { allowCopies: false })) return;
      sccp(fx);
      absint(fx);
    }
    const n = phase(fx, fn);
    if (n) {
      st[phase.key] += n;
      fn.scope.crawl();
      fx = null;
    }
  }
}

const typeOfFor = (fx) => (id) => {
  if (!fx.useVer.has(id)) return null;
  const a = fx.abs.useAbs(id);
  return a ? a.ty || ALL : ALL;
};
const pure = (fx, fn, node) => isPureTyped(node, typeOfFor(fx), fn.scope);

// ── E664: kaçmayan nesne → skaler değişkenler ──────────
function sroa(fn) {
  let changed = false;
  for (const b of Object.values(fn.scope.bindings)) {
    if (!['var', 'let', 'const'].includes(b.kind) || b.constantViolations.length) continue;
    const decl = b.path;
    if (!decl.isVariableDeclarator() || !t.isObjectExpression(decl.node.init) || !t.isIdentifier(decl.node.id)) continue;
    // { min, max } = config gibi adlandırılmış nesne yapay skalerlere (_config_min) bölünmez
    if (meaningful(b.identifier.name)) continue;
    const props = new Map();
    let ok = true;
    for (const p of decl.node.init.properties) {
      if (!t.isObjectProperty(p) || p.computed) { ok = false; break; }
      const name = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : t.isNumericLiteral(p.key) ? String(p.key.value) : null;
      if (name === null || PROTO.has(name) || props.has(name) || t.isFunction(p.value)) { ok = false; break; }
      props.set(name, p.value);
    }
    if (!ok || !b.referencePaths.length) continue;
    // durum makinesi deyimi (döngüde switch (o.p)): VM/unflatten pass'lerinin işi, nesne yerinde kalır (E184 Proxy izleme)
    if (b.referencePaths.some((r) => r.parentPath.parentPath?.isSwitchStatement() && r.parentPath.key === 'discriminant' && r.findParent((x) => x.isLoop()))) continue;
    const declStmt = decl.parentPath;
    if (!Array.isArray(declStmt.container) || declStmt.parentPath.isForStatement()) continue;
    const list = declStmt.container;
    const idx = declStmt.key;
    const uses = [];
    for (const r of b.referencePaths) {
      if (r.getFunctionParent() !== fn) { ok = false; break; }
      const m = r.parentPath;
      const name = m.isMemberExpression({ object: r.node }) ? (!m.node.computed ? m.node.property.name : t.isStringLiteral(m.node.property) ? m.node.property.value : null) : null;
      if (name === null || PROTO.has(name) || /^\d/.test(name) && !props.has(name)) { ok = false; break; }
      const mp = m.parentPath;
      if ((mp.isCallExpression() || mp.isOptionalCallExpression() || mp.isNewExpression()) && mp.node.callee === m.node) { ok = false; break; }
      if (mp.isUnaryExpression({ operator: 'delete' }) || mp.isForXStatement({ left: m.node })) { ok = false; break; }
      if (mp.isAssignmentExpression({ left: m.node }) && ['&&=', '||=', '??='].includes(mp.node.operator)) { ok = false; break; }
      // kullanım bildirimden sonra, aynı deyim listesinde ya da sonraki bir deyimin içinde olmalı
      let s = m;
      while (s && s.container !== list) s = s.parentPath;
      if (!s || s.key <= idx) { ok = false; break; }
      uses.push({ m, name });
    }
    if (!ok) continue;
    const names = new Map();
    const all = new Set([...props.keys(), ...uses.map((u) => u.name)]);
    for (const p of all) names.set(p, fn.scope.generateUidIdentifier(`${b.identifier.name}_${p}`).name);
    const assigned = uses.some(({ m }) => m.parentPath.isAssignmentExpression({ left: m.node }) || m.parentPath.isUpdateExpression());
    const kind = decl.parent.kind === 'const' && (assigned || all.size > props.size) ? 'let' : decl.parent.kind;
    const decls = [...all].map((p) => t.variableDeclarator(t.identifier(names.get(p)), props.get(p) ?? null));
    for (const { m, name } of uses) m.replaceWith(t.identifier(names.get(name)));
    const others = decl.parent.declarations.filter((d) => d !== decl.node);
    if (others.length) {
      decl.remove();
      declStmt.insertAfter(t.variableDeclaration(kind, decls));
    } else {
      declStmt.replaceWith(t.variableDeclaration(kind, decls));
    }
    changed = true;
  }
  return changed;
}

// ── E680 / E661 / E695: sabitler ve erişilemez dallar ───
function constants(fx, fn) {
  let n = 0;
  const { val, edges } = fx.sccp;
  if (!fx.sccp.converged) return 0;
  for (const [id, ver] of fx.useVer) {
    if (fx.implicitUses.has(id)) continue;
    const ip = fx.useInstr.get(id)?.path;
    // delete x / x() konumunda sabit koymak anlamı ya da hata iletisini değiştirir
    const parent = ip && findParentNode(ip.node, id);
    if (parent && (t.isUnaryExpression(parent, { operator: 'delete' }) || ((t.isCallExpression(parent) || t.isNewExpression(parent)) && parent.callee === id))) continue;
    const v = val.get(ver);
    if (!v || !('c' in v)) continue;
    const ins = fx.useInstr.get(id);
    if (!ins || ins.block.dead || !fx.sccp.blocks.has(ins.block)) continue;
    const lit = literalFor(v.c, fn.scope);
    if (!lit) continue;
    const path = findPath(ins.path, id);
    if (!path) continue;
    path.replaceWith(lit);
    n++;
  }
  // tek yönü çalışabilen if/while (test yan etkisizse) — E695 erişilemezlik kanıtı: SCCP sabit kenarı
  for (const b of fx.blocks) {
    const test = b.instrs.find((i) => i.kind === 'test');
    if (!test || !fx.sccp.blocks.has(b)) continue;
    const live = b.succ.filter((e) => edges.has(e));
    if (live.length !== 1 || b.succ.length !== 2) continue;
    const stmt = test.path.parentPath;
    if (!test.path.node || !pure(fx, fn, test.path.node)) continue;
    const value = live[0].cond.value;
    if (stmt.isIfStatement()) {
      const keep = value ? stmt.node.consequent : stmt.node.alternate;
      if (!Array.isArray(stmt.container) && !keep) { test.path.replaceWith(t.booleanLiteral(value)); n++; continue; }
      if (!keep) { stmt.remove(); n++; continue; }
      if (t.isBlockStatement(keep) && Array.isArray(stmt.container) && !keep.body.some((s) => t.isVariableDeclaration(s) && s.kind !== 'var' || t.isFunctionDeclaration(s) || t.isClassDeclaration(s))) stmt.replaceWithMultiple(keep.body);
      else stmt.replaceWith(keep);
      n++;
    } else if ((stmt.isWhileStatement() || stmt.isForStatement()) && !value && Array.isArray(stmt.container)) {
      // döngü hiç çalışmaz: for başlatıcısı korunur
      if (stmt.isForStatement() && stmt.node.init) stmt.replaceWith(t.isVariableDeclaration(stmt.node.init) ? stmt.node.init : t.expressionStatement(stmt.node.init));
      else stmt.remove();
      n++;
    } else if (stmt.isWhileStatement() || stmt.isForStatement() || stmt.isDoWhileStatement()) {
      if (!t.isBooleanLiteral(test.path.node)) { test.path.replaceWith(t.booleanLiteral(value)); n++; }
    }
  }
  return n;
}
constants.key = 'constant';

function findParentNode(root, target) {
  let found = null;
  const w = (x, parent) => {
    if (found || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach((c) => w(c, parent)); return; }
    if (x === target) { found = parent; return; }
    for (const k of t.VISITOR_KEYS[x.type] ?? []) w(x[k], x);
  };
  w(root, null);
  return found;
}

// İfade içinde verilen Identifier düğümünün yolu
function findPath(root, node) {
  if (root.node === node) return root;
  let found = null;
  root.traverse({
    Identifier(p) { if (p.node === node) { found = p; p.stop(); } },
    Function(p) { p.skip(); },
  });
  return found;
}

const isTrackedId = (fx, n) => t.isIdentifier(n) && fx.useVer.has(n);
const nameOf = (fx, ver) => fx.varOf.get(ver.var).name;

// ── E662: kopya yayılımı ──────────────────────────────
function copies(fx, fn) {
  let n = 0;
  for (const ver of fx.versions) {
    if (ver.kind !== 'def') continue;
    const site = ver.site;
    const src = t.isVariableDeclarator(site) ? site.init : t.isAssignmentExpression(site, { operator: '=' }) ? site.right : null;
    if (!src || !isTrackedId(fx, src)) continue;
    const w = fx.useVer.get(src);
    if (!w || w.var === ver.var) continue;
    for (const u of ver.uses) {
      if (!u.node || u.implicit) continue;
      // u noktasında kaynağın güncel sürümü hâlâ w mi?
      if (versionAt(fx, u.node, w.var) !== w) continue;
      const p = findPath(u.instr.path, u.node);
      if (!p) continue;
      p.replaceWith(t.identifier(nameOf(fx, w)));
      n++;
    }
  }
  return n;
}
copies.key = 'copy';

// ── E665: global değer numaralandırma ──────────────────
const COMMUTATIVE = new Set(['*', '&', '|', '^', '===', '!==']);
function gvn(fx, fn) {
  let n = 0;
  const vn = new Map();
  const vnOf = (ver) => {
    if (vn.has(ver)) return vn.get(ver);
    let r = `v${ver.id}`;
    const c = fx.sccp.val.get(ver);
    if (c && 'c' in c) r = `c${typeof c.c}:${String(c.c)}`;
    else if (ver.kind === 'def') {
      const src = t.isVariableDeclarator(ver.site) ? ver.site.init : t.isAssignmentExpression(ver.site, { operator: '=' }) ? ver.site.right : null;
      if (src && isTrackedId(fx, src)) { vn.set(ver, r); r = vnOf(fx.useVer.get(src)); }
    }
    vn.set(ver, r);
    return r;
  };
  const typeOf = typeOfFor(fx);
  const key = (e) => {
    const k = (x) => {
      switch (x.type) {
        case 'Identifier': return fx.useVer.has(x) && !fx.implicitUses.has(x) ? vnOf(fx.useVer.get(x)) : null;
        case 'NumericLiteral': return `n${x.value}`;
        case 'StringLiteral': return `s${JSON.stringify(x.value)}`;
        case 'BooleanLiteral': return `b${x.value}`;
        case 'NullLiteral': return 'null';
        case 'UnaryExpression': { const a = k(x.argument); return a && `(${x.operator}${a})`; }
        case 'BinaryExpression': {
          let a = k(x.left);
          let b = k(x.right);
          if (!a || !b) return null;
          const numeric = exprType(x.left, typeOf, fn.scope) === 8 && exprType(x.right, typeOf, fn.scope) === 8;
          if ((COMMUTATIVE.has(x.operator) || (x.operator === '+' && numeric)) && a > b) [a, b] = [b, a];
          return `(${a}${x.operator}${b})`;
        }
        case 'MemberExpression': { const a = k(x.object); return a && !x.computed && x.property.name === 'length' ? `${a}.length` : null; }
        default: return null;
      }
    };
    return k(e);
  };
  const table = [];
  const lookup = (kk) => { for (let i = table.length - 1; i >= 0; i--) if (table[i].has(kk)) return table[i].get(kk); return null; };
  const walk = (b) => {
    table.push(new Map());
    if (fx.sccp.blocks.has(b)) {
      for (const ins of b.instrs) {
        if (ins.kind !== 'decl' && ins.kind !== 'expr') continue;
        const defs = [];
        walkEval(ins.path.node, fx.keyOf, () => {}, (id, site) => defs.push([id, site]));
        for (const [id, site] of defs) {
          const rhs = t.isVariableDeclarator(site) ? site.init : t.isAssignmentExpression(site, { operator: '=' }) ? site.right : null;
          if (!rhs || t.isIdentifier(rhs) || t.isLiteral(rhs) || nodeSize(rhs) < 3 || !pure(fx, fn, rhs)) continue;
          const kk = key(rhs);
          if (!kk) continue;
          const holder = lookup(kk);
          const ver = fx.defVer.get(id);
          if (holder && holder.var !== ver.var && versionAt(fx, firstUseOrSelf(rhs, fx) ?? id, holder.var) === holder && ins.before.get(holder.var) === holder) {
            const p = rhsPath(ins.path, rhs);
            if (p) { p.replaceWith(t.identifier(nameOf(fx, holder))); n++; continue; }
          }
          if (!holder) table[table.length - 1].set(kk, ver);
        }
      }
    }
    for (const c of fx.domChildren.get(b) ?? []) walk(c);
    table.pop();
  };
  walk(fx.entry);
  return n;
}
gvn.key = 'gvn';
function firstUseOrSelf(rhs, fx) {
  let found = null;
  walkEval(rhs, fx.keyOf, (id) => { found ??= id; }, () => {});
  return found;
}
function rhsPath(root, node) {
  if (root.node === node) return root;
  let found = null;
  root.traverse({ enter(p) { if (p.node === node) { found = p; p.stop(); } }, Function(p) { if (p.node !== node) p.skip(); } });
  return found;
}

// ── E663: ölü atama eleme ─────────────────────────────
function deadAssignments(fx, fn) {
  let n = 0;
  // kaldırılabilir tanım: yan etkisiz sağ taraf ve deyim düzeyinde
  const removable = new Map(); // sürüm → { kind, path }
  for (const ver of fx.versions) {
    if (ver.kind !== 'def' || !fx.sccp.blocks.has(ver.block)) continue;
    const site = ver.site;
    const sp = rhsPath(ver.instr.path, site);
    if (!sp) continue;
    if (t.isVariableDeclarator(site)) {
      if (site.init && sp.parent.kind !== 'const' && pure(fx, fn, site.init) && !sp.parentPath.parentPath.isForXStatement()) removable.set(ver, { kind: 'init', path: sp });
      continue;
    }
    const stmtLevel = sp.parentPath.isExpressionStatement();
    if (t.isAssignmentExpression(site)) {
      if (site.operator === '=') removable.set(ver, { kind: stmtLevel && pure(fx, fn, site.right) ? 'stmt' : 'strip', path: sp });
      else if (stmtLevel && pure(fx, fn, t.binaryExpression(site.operator.slice(0, -1), site.left, site.right))) removable.set(ver, { kind: 'stmt', path: sp });
    } else if (t.isUpdateExpression(site) && stmtLevel) {
      const ty = typeOfFor(fx)(site.argument);
      if (ty === 8) removable.set(ver, { kind: 'stmt', path: sp });
    }
  }
  // canlılık: kaldırılacak tanımların sağ tarafındaki kullanımlar canlılık sağlamaz
  const enclosing = new Map(); // kullanım düğümü → onu içeren kaldırılabilir tanım sürümü
  for (const [ver, r] of removable) {
    if (r.kind === 'strip') continue;
    const root = r.kind === 'init' ? r.path.node.init : r.path.node;
    walkEval(root, fx.keyOf, (id) => enclosing.set(id, ver), () => {});
  }
  const live = new Set();
  const work = [];
  const mark = (v) => { if (v && !live.has(v)) { live.add(v); work.push(v); } };
  for (const [id, ver] of fx.useVer) {
    const enc = enclosing.get(id);
    if (!enc || enc === ver) { if (!enc) mark(ver); }
  }
  for (const ver of fx.versions) if (ver.kind === 'def' && !removable.has(ver)) live.add(ver);
  const usesByDef = new Map();
  for (const [id, ver] of fx.useVer) {
    const enc = enclosing.get(id);
    if (enc) { if (!usesByDef.has(enc)) usesByDef.set(enc, []); usesByDef.get(enc).push(ver); }
  }
  while (work.length) {
    const v = work.pop();
    if (v.kind === 'phi') for (const a of v.phi.args.values()) mark(a);
    for (const u of usesByDef.get(v) ?? []) mark(u);
  }
  // canlı (kaldırılamaz) tanımların sağındaki kullanımlar zaten işaretli; kaldırılabilirler canlı değilse silinir
  for (const [ver, r] of removable) {
    if (live.has(ver)) continue;
    const p = r.path;
    if (!p.node) continue;
    if (r.kind === 'init') {
      // var/let başlatıcısız kalır (bu sürüm hiç okunmuyor; let döngüde her turda undefined ile yeniden bağlanır)
      p.node.init = null;
    } else if (r.kind === 'stmt') {
      if (p.parentPath.isExpressionStatement() && Array.isArray(p.parentPath.container)) p.parentPath.remove();
      else continue;
    } else {
      p.replaceWith(p.node.right);
    }
    n++;
  }
  return n;
}
deadAssignments.key = 'dead';

// ── E666: ortak alt ifade eleme (blok içi, geçici değişkenle) ──
function cse(fx, fn) {
  let n = 0;
  const typeOf = typeOfFor(fx);
  for (const b of fx.blocks) {
    if (!fx.sccp.blocks.has(b)) continue;
    const occ = new Map(); // anahtar → [{ path, ins }]
    for (const ins of b.instrs) {
      if (!['expr', 'decl', 'return', 'test'].includes(ins.kind)) continue;
      const stmt = stmtOf(ins.path);
      if (!stmt || !(stmt.isExpressionStatement() || stmt.isVariableDeclaration() || stmt.isReturnStatement() || stmt.isIfStatement())) continue;
      if (stmt.isVariableDeclaration() && stmt.parentPath.isForStatement()) continue;
      if (ins.kind === 'test' && !stmt.isIfStatement()) continue;
      ins.path.traverse({
        Function(p) { p.skip(); },
        'BinaryExpression|UnaryExpression|ConditionalExpression|LogicalExpression'(p) {
          if (nodeSize(p.node) < 4 || !isPureTyped(p.node, typeOf, fn.scope)) return;
          // izlenmeyen kimlik içeren ifade sürümle anahtarlanamaz
          let tracked = true;
          let consistent = true;
          p.traverse({ Identifier(q) {
            if (!q.isReferencedIdentifier()) return;
            if (!fx.useVer.has(q.node)) { if (fn.scope.getBinding(q.node.name)) tracked = false; return; }
            if (fx.useVer.get(q.node) !== ins.before.get(fx.keyOf.get(q.node))) consistent = false;
          } });
          if (!tracked || !consistent) return;
          const k = key(fx, p.node);
          if (!k) return;
          if (!occ.has(k)) occ.set(k, []);
          occ.get(k).push({ path: p, ins, stmt });
        },
      });
    }
    // büyük ifadeler önce; değiştirilen alt ağaçların içindeki eşleşmeler artık ağaçta değil
    const consumed = new Set();
    const markConsumed = (node) => { traverseIds(node, () => {}); const w = (x) => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) { x.forEach(w); return; } if (x.type) consumed.add(x); for (const kk of t.VISITOR_KEYS[x.type] ?? []) w(x[kk]); }; w(node); };
    for (const [, list] of [...occ].sort((a, b) => b[0].length - a[0].length)) {
      const live = list.filter((o) => o.path.node && !consumed.has(o.path.node));
      if (live.length < 2) continue;
      const first = live[0];
      if (!first.stmt.node || !Array.isArray(first.stmt.container)) continue;
      // var: aynı temel blok iç içe bloklara yayılabilir, geçici değişken fonksiyon kapsamında olmalı
      const tmp = fn.scope.generateUidIdentifier('cse');
      first.stmt.insertBefore(t.variableDeclaration('var', [t.variableDeclarator(tmp, t.cloneNode(first.path.node, true))]));
      for (const o of live) { markConsumed(o.path.node); o.path.replaceWith(t.identifier(tmp.name)); }
      n++;
    }
  }
  return n;
}
cse.key = 'cse';
function key(fx, node) {
  const k = (x) => {
    switch (x.type) {
      case 'Identifier': return fx.useVer.has(x) ? `v${fx.useVer.get(x).id}` : (x.name === 'undefined' || x.name === 'NaN' || x.name === 'Infinity' ? x.name : null);
      case 'NumericLiteral': return `n${x.value}`;
      case 'StringLiteral': return `s${JSON.stringify(x.value)}`;
      case 'BooleanLiteral': return `b${x.value}`;
      case 'NullLiteral': return 'null';
      case 'UnaryExpression': { const a = k(x.argument); return a && `(${x.operator} ${a})`; }
      case 'BinaryExpression': case 'LogicalExpression': { const a = k(x.left); const b = k(x.right); return a && b && `(${a}${x.operator}${b})`; }
      case 'ConditionalExpression': { const a = k(x.test); const b = k(x.consequent); const c = k(x.alternate); return a && b && c && `(${a}?${b}:${c})`; }
      case 'MemberExpression': { const a = k(x.object); return a && !x.computed && x.property.name === 'length' ? `${a}.length` : null; }
      default: return null;
    }
  };
  return k(node);
}

// ── E667: kısmi fazlalık eleme (if/else elmasında) ─────
function pre(fx, fn) {
  let n = 0;
  const typeOf = typeOfFor(fx);
  for (const J of fx.blocks) {
    if (J.pred.length !== 2 || !fx.sccp.blocks.has(J)) continue;
    const edges = J.pred.map((p) => p.succ.find((e) => e.to === J));
    if (!edges.every((e) => e?.at?.kind === 'branchEnd') || edges[0].at.ifPath !== edges[1].at.ifPath) continue;
    const ifPath = edges[0].at.ifPath;
    for (const ins of J.instrs) {
      if (ins.kind !== 'decl' && ins.kind !== 'expr') continue;
      let done = false;
      walkEval(ins.path.node, fx.keyOf, () => {}, (id, site) => {
        if (done) return;
        const rhs = t.isVariableDeclarator(site) ? site.init : t.isAssignmentExpression(site, { operator: '=' }) ? site.right : null;
        if (!rhs || t.isIdentifier(rhs) || t.isLiteral(rhs) || nodeSize(rhs) < 3 || !isPureTyped(rhs, typeOf, fn.scope)) return;
        const k = key(fx, rhs);
        if (!k) return;
        // işlenenler her iki öncül sonunda da aynı sürümde olmalı (dallarda yeniden tanım yok)
        const operands = [];
        let tracked = true;
        walkEval(rhs, fx.keyOf, (u) => operands.push(fx.useVer.get(u)), () => {});
        traverseIds(rhs, (x) => { if (!fx.useVer.has(x) && fn.scope.getBinding(x.name)) tracked = false; });
        if (!tracked || !operands.length) return;
        if (!J.pred.every((p) => operands.every((v) => p.out?.get(v.var) === v))) return;
        // her öncülde aynı ifadeyi tutan ve sonuna kadar güncel kalan değişken var mı?
        const holders = J.pred.map((p) => holderIn(fx, p, k, rhs));
        if (!holders.some(Boolean)) return;
        const tmp = fn.scope.generateUidIdentifier('pre');
        fn.get('body').unshiftContainer('body', t.variableDeclaration('var', [t.variableDeclarator(tmp)]));
        edges.forEach((e, i) => {
          const val = holders[i] ? t.identifier(nameOf(fx, holders[i])) : t.cloneNode(rhs, true);
          insertOnEdge(e, t.expressionStatement(t.assignmentExpression('=', t.identifier(tmp.name), val)));
        });
        const p = rhsPath(ins.path, rhs);
        if (p) p.replaceWith(t.identifier(tmp.name));
        void ifPath;
        n++;
        done = true;
      });
      if (done) break;
    }
    if (n) break; // CFG değişti: kalan elmaslar sonraki turda
  }
  return n;
}
pre.key = 'pre';
function traverseIds(node, cb) {
  const w = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(w); return; }
    if (t.isIdentifier(x)) { cb(x); return; }
    if (t.isFunction(x)) return;
    if (t.isMemberExpression(x) && !x.computed) { w(x.object); return; }
    for (const k of t.VISITOR_KEYS[x.type] ?? []) w(x[k]);
  };
  w(node);
}
// p bloğunun (ya da onu baskılayan dal içi blokların) sonunda k ifadesini tutan sürüm
function holderIn(fx, p, k, rhs) {
  for (let b = p; b && b !== fx.entry; b = fx.idom.get(b)) {
    for (const ins of [...b.instrs].reverse()) {
      let found = null;
      walkEval(ins.path.node, fx.keyOf, () => {}, (id, site) => {
        const r = t.isVariableDeclarator(site) ? site.init : t.isAssignmentExpression(site, { operator: '=' }) ? site.right : null;
        if (r && r !== rhs && key(fx, r) === k) found = fx.defVer.get(id);
      });
      if (found && p.out?.get(found.var) === found) return found;
    }
    if (b.pred.length !== 1) break; // dalın başına kadar
  }
  return null;
}
