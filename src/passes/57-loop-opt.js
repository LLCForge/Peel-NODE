import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { ssaFor, walkEval, versionAt } from '../opt/ssa.js';
import { sccp, absint, T, ALL } from '../opt/lattice.js';
import { isPureTyped, functionPaths, hasDynamicScope, nodeSize, hasSideEffectSyntax } from '../opt/util.js';

// Döngü optimizasyonları (SSA ve doğal döngüler üzerinde):
//   E668 döngü değişmezi taşıma, E669 güç indirgeme, E670 indüksiyon değişkeni sadeleştirme,
//   E671 tam açma (sabit tur sayısı), E672 ilk turu soyma, E673 döngü birleştirme / bölme.
// Her dönüşüm sonrası SSA yeniden kurulur; fonksiyon başına sınırlı sayıda dönüşüm uygulanır.

const SAFE = 2 ** 53;
const MAX_STEPS = 12;

export async function run(ast, { onLog, bump }) {
  if (hasDynamicScope(ast, traverse)) return;
  const st = { licm: 0, sr: 0, iv: 0, unroll: 0, peel: 0, fuse: 0, fission: 0 };
  for (const fn of functionPaths(ast, traverse)) {
    for (let step = 0; step < MAX_STEPS; step++) {
      const fx = ssaFor(fn);
      if (!fx || !fx.loops?.length) break;
      sccp(fx);
      absint(fx);
      const loops = fx.loops.map((l) => naturalLoop(fx, l)).filter(Boolean);
      let applied = null;
      for (const tr of [fuse, unroll, fission, peel, ivSimplify, strengthReduce, licm]) {
        for (const loop of loops) {
          if (tr(fx, fn, loop, loops)) { applied = tr.key; break; }
        }
        if (applied) break;
      }
      if (!applied) break;
      st[applied]++;
      fn.scope.crawl();
    }
  }
  const total = Object.values(st).reduce((a, b) => a + b, 0);
  if (total) onLog(`loop-opt: ${Object.entries(st).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}`, 'info');
  for (const [k, v] of Object.entries(st)) bump(`loop.${k}`, v);
}

// durum makinesi döngüsü (gövdede switch (s), s döngüde atanıyor): unflatten/VM pass'lerinin işi. Tur soyma ya da
// taşıma makineye ikinci bir giriş durumu ekler ve onu açılamaz kılar; döngü olduğu gibi kalır.
function dispatcher(node) {
  const stmts = t.isBlockStatement(node.body) ? node.body.body : [node.body];
  const sw = stmts.find((s) => t.isSwitchStatement(s) && t.isIdentifier(s.discriminant));
  if (!sw) return false;
  const name = sw.discriminant.name;
  let assigned = false;
  t.traverseFast(node, (n) => {
    if ((t.isAssignmentExpression(n) && t.isIdentifier(n.left, { name })) || (t.isUpdateExpression(n) && t.isIdentifier(n.argument, { name }))) assigned = true;
  });
  return assigned;
}

// ── doğal döngü ve indüksiyon değişkenleri ────────────
function naturalLoop(fx, l) {
  const H = l.header;
  if (!H || H.dead) return null;
  if (l.path?.node && dispatcher(l.path.node)) return null;
  const latches = H.pred.filter((p) => !p.dead && fx.dominates(H, p));
  const outside = H.pred.filter((p) => !p.dead && !fx.dominates(H, p));
  if (!latches.length || outside.length !== 1) return null;
  const blocks = new Set([H]);
  const stack = [...latches];
  while (stack.length) {
    const b = stack.pop();
    if (blocks.has(b)) continue;
    blocks.add(b);
    for (const p of b.pred) if (!p.dead) stack.push(p);
  }
  const loop = { ...l, latches, pre: outside[0], blocks, ivs: [] };
  for (const phi of H.phis.values()) {
    const init = phi.args.get(loop.pre);
    const back = [...new Set(latches.map((p) => phi.args.get(p)))];
    if (!init || back.length !== 1 || back[0].kind !== 'def') continue;
    const step = stepOf(fx, back[0], phi.version);
    if (step === null) continue;
    loop.ivs.push({ var: phi.var, phi: phi.version, init, step, def: back[0], name: fx.varOf.get(phi.var).name });
  }
  return loop;
}

// v = v + c, v += c, v++ … (c sabit sayı) → c; değilse null
function stepOf(fx, def, phiVer) {
  const site = def.site;
  const cval = (n) => {
    if (t.isNumericLiteral(n)) return n.value;
    if (t.isUnaryExpression(n, { operator: '-' }) && t.isNumericLiteral(n.argument)) return -n.argument.value;
    if (t.isIdentifier(n) && fx.useVer.has(n)) { const v = fx.sccp.val.get(fx.useVer.get(n)); return v && typeof v.c === 'number' ? v.c : null; }
    return null;
  };
  const isPhi = (n) => t.isIdentifier(n) && fx.useVer.get(n) === phiVer;
  if (t.isUpdateExpression(site)) return fx.useVer.get(site.argument) === phiVer ? (site.operator === '++' ? 1 : -1) : null;
  if (t.isAssignmentExpression(site)) {
    if (site.operator === '+=' && fx.useVer.get(site.left) === phiVer) return cval(site.right);
    if (site.operator === '-=' && fx.useVer.get(site.left) === phiVer) { const c = cval(site.right); return c === null ? null : -c; }
    if (site.operator === '=' && t.isBinaryExpression(site.right)) {
      const { operator, left, right } = site.right;
      if (operator === '+' && isPhi(left)) return cval(right);
      if (operator === '+' && isPhi(right)) return cval(left);
      if (operator === '-' && isPhi(left)) { const c = cval(right); return c === null ? null : -c; }
    }
  }
  return null;
}

// sabit değer: { c } ya da null (undefined sabiti de { c: undefined } olarak döner)
const constBox = (fx, ver) => { const v = ver && fx.sccp.val.get(ver); return v && 'c' in v ? { c: v.c } : null; };
const constOf = (fx, ver) => constBox(fx, ver)?.c;
const typeOfFor = (fx) => (id) => (fx.useVer.has(id) ? (fx.abs.useAbs(id)?.ty || ALL) : null);
// dal olguları olmadan (yalnızca sürüm tipi): döngü dışına taşınan ifade için gerekli
const typeOfNoFacts = (fx) => (id) => (fx.useVer.has(id) ? (fx.abs.val.get(fx.useVer.get(id))?.ty || ALL) : null);
const inLoop = (loop, ver) => ver.block && loop.blocks.has(ver.block) && ver.kind !== 'param' && ver.kind !== 'undef' && ver.kind !== 'tdz';
// IV adımı her turda tam bir kez mi işleniyor? (tanım bloğu tüm geri kenar kaynaklarını baskılar)
const everyIteration = (fx, loop, def) => loop.latches.every((l) => fx.dominates(def.block, l));
// döngü deyimi bir deyim listesinde mi
const listed = (p) => Array.isArray(p.container) && !p.parentPath.isLabeledStatement();

// İfadedeki izlenen kimlikler döngü dışında tanımlı ve izlenmeyen yerel kimlik yok mu?
function invariant(fx, fn, loop, node) {
  let ok = true;
  const w = (x) => {
    if (!ok || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(w); return; }
    if (t.isFunction(x)) { ok = false; return; }
    if (t.isIdentifier(x)) {
      if (fx.useVer.has(x)) { if (inLoop(loop, fx.useVer.get(x))) ok = false; } else if (fn.scope.getBinding(x.name)) ok = false;
      return;
    }
    if (t.isMemberExpression(x) && !x.computed) { w(x.object); return; }
    for (const k of t.VISITOR_KEYS[x.type] ?? []) w(x[k]);
  };
  w(node);
  return ok;
}

// ── E668: döngü değişmezi taşıma ───────────────────────
function licm(fx, fn, loop) {
  if (!listed(loop.path)) return false;
  const typeOf = typeOfNoFacts(fx);
  for (const b of loop.blocks) {
    if (!fx.sccp.blocks.has(b)) continue;
    for (const ins of b.instrs) {
      if (!ins.path.node || ins.kind === 'forx' || ins.kind === 'opaque' || ins.kind === 'jump') continue;
      let target = null;
      ins.path.traverse({
        Function(p) { p.skip(); },
        'BinaryExpression|UnaryExpression|ConditionalExpression|LogicalExpression'(p) {
          if (target || nodeSize(p.node) < 4) return;
          if (p.parentPath.isAssignmentExpression({ left: p.node })) return;
          if (!invariant(fx, fn, loop, p.node) || !isPureTyped(p.node, typeOf, fn.scope)) return;
          target = p;
          p.skip();
        },
      });
      if (!target) continue;
      const tmp = fn.scope.generateUidIdentifier('inv');
      loop.path.insertBefore(t.variableDeclaration('var', [t.variableDeclarator(tmp, t.cloneNode(target.node, true))]));
      target.replaceWith(t.identifier(tmp.name));
      return true;
    }
  }
  return false;
}
licm.key = 'licm';

// IV'nin aralığı tamsayı ve sonlu mu (kullanım noktasındaki olgularla)?
function ivRange(fx, id) {
  const a = fx.abs.useAbs(id);
  return a && a.ty === T.number && a.int && Number.isFinite(a.lo) && Number.isFinite(a.hi) ? [a.lo, a.hi] : null;
}

// for-init'i döngüden önce ayırır (var ya da ifade): sonrasına ekleme yapılabilsin
function hoistForInit(loop) {
  const p = loop.path;
  if (!p.isForStatement() || !p.node.init) return true;
  if (t.isVariableDeclaration(p.node.init) && p.node.init.kind !== 'var') return false;
  const init = p.node.init;
  p.node.init = null;
  p.insertBefore(t.isVariableDeclaration(init) ? init : t.expressionStatement(init));
  return true;
}

// IV artışının hemen ardına deyim/ifade ekler
function appendAfterStep(fx, loop, iv, exprNode) {
  const p = loop.path;
  const site = iv.def.site;
  if (p.isForStatement() && p.node.update && containsNode(p.node.update, site)) {
    p.node.update = t.sequenceExpression([p.node.update, exprNode]);
    return true;
  }
  const sp = iv.def.instr.path;
  if (sp.isExpressionStatement() && sp.node.expression === site && listed(sp)) {
    sp.insertAfter(t.expressionStatement(exprNode));
    return true;
  }
  return false;
}
function containsNode(root, target) {
  let found = false;
  const w = (x) => {
    if (found || !x || typeof x !== 'object') return;
    if (x === target) { found = true; return; }
    if (Array.isArray(x)) { x.forEach(w); return; }
    for (const k of t.VISITOR_KEYS[x.type] ?? []) w(x[k]);
  };
  w(root);
  return found;
}

// ── E669: güç indirgeme (i * k → artımlı geçici) ───────
function strengthReduce(fx, fn, loop) {
  if (!listed(loop.path)) return false;
  for (const iv of loop.ivs) {
    if (!everyIteration(fx, loop, iv.def) || !Number.isInteger(iv.step)) continue;
    const muls = [];
    let k = null;
    for (const b of loop.blocks) for (const ins of b.instrs) {
      if (!ins.path.node || ins.kind === 'forx') continue;
      ins.path.traverse({
        Function(p) { p.skip(); },
        BinaryExpression(p) {
          if (p.node.operator !== '*') return;
          const [a, c] = t.isIdentifier(p.node.left) && fx.useVer.get(p.node.left) === iv.phi ? [p.node.left, p.node.right] : [p.node.right, p.node.left];
          if (!t.isIdentifier(a) || fx.useVer.get(a) !== iv.phi || !t.isNumericLiteral(c) || !Number.isInteger(c.value) || c.value === 0) return;
          if (k !== null && k !== c.value) return;
          const r = ivRange(fx, a);
          if (!r || Math.max(Math.abs(r[0]), Math.abs(r[1]), Math.abs(r[1] + iv.step)) * Math.abs(c.value) >= SAFE) return;
          k = c.value;
          muls.push(p);
        },
      });
    }
    if (!muls.length) continue;
    const init = constOf(fx, iv.init);
    if (typeof init !== 'number' || !Number.isInteger(init)) continue;
    if (!hoistForInit(loop)) continue;
    const tmp = fn.scope.generateUidIdentifier('sr');
    loop.path.insertBefore(t.variableDeclaration('var', [t.variableDeclarator(tmp, t.numericLiteral(init * k))]));
    if (!appendAfterStep(fx, loop, iv, t.assignmentExpression('+=', t.identifier(tmp.name), t.numericLiteral(iv.step * k)))) {
      throw new Error('güç indirgeme: artış konumu bulunamadı');
    }
    for (const p of muls) p.replaceWith(t.identifier(tmp.name));
    return true;
  }
  return false;
}
strengthReduce.key = 'sr';

// ── E670: türetilmiş IV'yi temel IV cinsinden yazma ────
function ivSimplify(fx, fn, loop) {
  for (const base of loop.ivs) {
    if (Math.abs(base.step) !== 1 || !everyIteration(fx, loop, base.def)) continue;
    const i0 = constOf(fx, base.init);
    if (!Number.isInteger(i0)) continue;
    for (const d of loop.ivs) {
      // güç indirgemenin ürettiği geçiciler (_sr) geri çevrilmez: iki dönüşüm birbirini salınımla bozmasın
      if (d === base || /^_sr\d*$/.test(d.name) || !everyIteration(fx, loop, d.def) || !Number.isInteger(d.step)) continue;
      const j0 = constOf(fx, d.init);
      if (!Number.isInteger(j0)) continue;
      // j'nin φ sürümünün kullanımları yer değiştirir; o noktada i'nin sürümü de φ olmalı.
      // j'nin artış sonrası sürümü (d.def) yalnızca φ'yi beslemeli (açık kullanımı olmamalı).
      const uses = [];
      let ok = true;
      for (const [id, ver] of fx.useVer) {
        if (ver === d.phi) {
          if (fx.implicitUses.has(id)) { if (fx.defVer.get(id) !== d.def) ok = false; continue; }
          if (versionAt(fx, id, base.var) !== base.phi) { ok = false; break; }
          uses.push(id);
        } else if (ver === d.def) { ok = false; break; }
      }
      if (!ok || !uses.length) continue;
      // tam sayı aralığı: gövdedeki (test olgusuyla daraltılmış) i kullanımlarının birleşimi + bir adım
      let lo = Infinity;
      let hi = -Infinity;
      let bounded = true;
      for (const [id, ver] of fx.useVer) {
        if (ver !== base.phi || fx.useInstr.get(id)?.block === loop.header || !loop.blocks.has(fx.useInstr.get(id)?.block)) continue;
        const r = ivRange(fx, id);
        if (!r) { bounded = false; break; }
        lo = Math.min(lo, r[0]);
        hi = Math.max(hi, r[1]);
      }
      if (!bounded || lo > hi || Math.max(Math.abs(lo), Math.abs(hi) + 1) * Math.abs(d.step) + Math.abs(j0) >= SAFE) continue;
      // j artışını kaldırabilmek için yalnızca deyim ya da for-update içinde olmalı
      const site = d.def.site;
      const p = loop.path;
      let removeStep = null;
      if (p.isForStatement() && p.node.update && (p.node.update === site || (t.isSequenceExpression(p.node.update) && p.node.update.expressions.includes(site)))) {
        removeStep = () => {
          if (p.node.update === site) p.node.update = null;
          else { const rest = p.node.update.expressions.filter((x) => x !== site); p.node.update = rest.length === 1 ? rest[0] : t.sequenceExpression(rest); }
        };
      } else if (d.def.instr.path.isExpressionStatement() && d.def.instr.path.node.expression === site && listed(d.def.instr.path)) {
        removeStep = () => d.def.instr.path.remove();
      }
      if (!removeStep) continue;
      const iName = base.name;
      const coef = d.step * base.step; // i adımı ±1: (i - i0) * adımj / adımi
      const expr = () => {
        const diff = i0 === 0 ? t.identifier(iName) : t.binaryExpression('-', t.identifier(iName), t.numericLiteral(i0));
        const scaled = coef === 1 ? diff : t.binaryExpression('*', diff, coef < 0 ? t.unaryExpression('-', t.numericLiteral(-coef)) : t.numericLiteral(coef));
        return j0 === 0 ? scaled : t.binaryExpression('+', t.numericLiteral(j0), scaled);
      };
      for (const id of uses) {
        const path = findIdPath(fx, id);
        if (path) path.replaceWith(expr());
      }
      removeStep();
      return true;
    }
  }
  return false;
}
ivSimplify.key = 'iv';
function findIdPath(fx, id) {
  const ins = fx.useInstr.get(id);
  if (!ins) return null;
  if (ins.path.node === id) return ins.path;
  let found = null;
  ins.path.traverse({ Identifier(p) { if (p.node === id) { found = p; p.stop(); } }, Function(p) { p.skip(); } });
  return found;
}

// ── E671: tam açma ─────────────────────────────────────
const MAX_TRIPS = 8;
const MAX_UNROLLED = 600;
function tripValues(fx, loop) {
  const p = loop.path;
  if (!p.isForStatement() || !p.node.test || !p.node.update) return null;
  const iv = loop.ivs.find((x) => everyIteration(fx, loop, x.def) && containsNode(p.node.update, x.def.site));
  if (!iv) return null;
  const i0 = constOf(fx, iv.init);
  if (typeof i0 !== 'number') return null;
  const test = p.node.test;
  if (!t.isBinaryExpression(test) || !['<', '<=', '>', '>=', '!=='].includes(test.operator) || !t.isIdentifier(test.left, { name: iv.name }) || fx.useVer.get(test.left) !== iv.phi) return null;
  const bound = t.isNumericLiteral(test.right) ? test.right.value : t.isIdentifier(test.right) && fx.useVer.has(test.right) ? constOf(fx, fx.useVer.get(test.right)) : undefined;
  if (typeof bound !== 'number') return null;
  const cmp = { '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b, '!==': (a, b) => a !== b }[test.operator];
  const vals = [];
  for (let v = i0; cmp(v, bound); v += iv.step) {
    vals.push(v);
    if (vals.length > MAX_TRIPS) return null;
  }
  return { iv, vals };
}
function ownJumps(node) {
  let found = false;
  const w = (x, depth) => {
    if (found || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach((c) => w(c, depth)); return; }
    if (t.isFunction(x)) return;
    if (t.isBreakStatement(x) || t.isContinueStatement(x)) { if (x.label || depth === 0) found = true; return; }
    if (t.isLabeledStatement(x)) { found = true; return; }
    const nested = t.isLoop(x) || t.isSwitchStatement(x);
    for (const k of t.VISITOR_KEYS[x.type] ?? []) w(x[k], nested ? depth + 1 : depth);
  };
  w(node, 0);
  return found;
}
const blockDecls = (body) => (t.isBlockStatement(body) ? body.body : [body]).some((s) => t.isFunctionDeclaration(s) || t.isClassDeclaration(s));
function unroll(fx, fn, loop) {
  const p = loop.path;
  if (!listed(p)) return false;
  const tv = tripValues(fx, loop);
  if (!tv) return false;
  const body = p.node.body;
  if (ownJumps(body) || blockDecls(body)) return false;
  // test ve update yan etkisiz; IV gövdede yazılmıyor
  if (hasSideEffectSyntax(p.node.test) || !t.isUpdateExpression(p.node.update) && !t.isAssignmentExpression(p.node.update)) return false;
  let writes = false;
  traverseNodes(body, (x) => { if ((t.isAssignmentExpression(x) && t.isIdentifier(x.left, { name: tv.iv.name })) || (t.isUpdateExpression(x) && t.isIdentifier(x.argument, { name: tv.iv.name }))) writes = true; });
  if (writes) return false;
  if (nodeSize(body) * Math.max(1, tv.vals.length) > MAX_UNROLLED) return false; // fission bunu dener
  if (p.node.init && t.isVariableDeclaration(p.node.init) && p.node.init.kind !== 'var') return false;
  const out = [];
  if (p.node.init) out.push(t.isVariableDeclaration(p.node.init) ? p.node.init : t.expressionStatement(p.node.init));
  for (let k = 0; k < tv.vals.length; k++) {
    out.push(t.blockStatement(t.isBlockStatement(body) ? t.cloneNode(body, true).body : [t.cloneNode(body, true)]));
    out.push(t.expressionStatement(t.cloneNode(p.node.update, true)));
  }
  p.replaceWithMultiple(out);
  return true;
}
unroll.key = 'unroll';
function traverseNodes(node, cb) {
  const w = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(w); return; }
    if (!x.type) return;
    cb(x);
    if (t.isFunction(x)) return;
    for (const k of t.VISITOR_KEYS[x.type] ?? []) w(x[k]);
  };
  w(node);
}

// ── E672: ilk turu soyma ───────────────────────────────
function peel(fx, fn, loop) {
  const p = loop.path;
  if (!listed(p) || !(p.isWhileStatement() || p.isForStatement())) return false;
  if (ownJumps(p.node.body) || blockDecls(p.node.body)) return false;
  if (p.isForStatement() && p.node.init && t.isVariableDeclaration(p.node.init) && p.node.init.kind !== 'var') return false;
  if (nodeSize(p.node.body) > 300) return false;
  // ilk turda bir değer, sonraki turlarda başka bir sabit alan bayrak; gövdede bir dal koşulunda kullanılıyor
  const H = loop.header;
  let flag = null;
  for (const phi of H.phis.values()) {
    const init = constBox(fx, phi.args.get(loop.pre));
    const backs = loop.latches.map((l) => constBox(fx, phi.args.get(l)));
    if (!init || backs.some((b) => !b) || backs.some((b) => !Object.is(b.c, backs[0].c)) || Object.is(init.c, backs[0].c)) continue;
    const used = fx.versions.find((v) => v === phi.version)?.uses.some((u) => u.instr && (u.instr.kind === 'test') && loop.blocks.has(u.instr.block) && u.instr.block !== H);
    if (used) { flag = phi; break; }
  }
  if (!flag) return false;
  const cloneBody = t.cloneNode(p.node.body, true);
  const test = p.node.test ? t.cloneNode(p.node.test, true) : t.booleanLiteral(true);
  const inner = [cloneBody];
  if (p.isForStatement() && p.node.update) inner.push(t.expressionStatement(t.cloneNode(p.node.update, true)));
  const loopCopy = p.isForStatement() ? t.forStatement(null, p.node.test, p.node.update, p.node.body) : p.node;
  inner.push(loopCopy);
  const out = [];
  if (p.isForStatement() && p.node.init) out.push(t.isVariableDeclaration(p.node.init) ? p.node.init : t.expressionStatement(p.node.init));
  out.push(t.ifStatement(test, t.blockStatement(inner)));
  p.replaceWithMultiple(out);
  return true;
}
peel.key = 'peel';

// ── E673: birleştirme (bitişik eş başlıklı döngüler) ───
function readsWrites(node, fx) {
  const reads = new Set();
  const writes = new Set();
  const arrays = { reads: [], writes: [] };
  let bad = false;
  traverseNodes(node, (x) => {
    if (t.isCallExpression(x) || t.isNewExpression(x) || t.isFunction(x) || t.isUnaryExpression(x, { operator: 'delete' }) || t.isYieldExpression(x) || t.isAwaitExpression(x) || t.isTaggedTemplateExpression(x)) bad = true;
    if (t.isAssignmentExpression(x) || t.isUpdateExpression(x)) {
      const target = x.left ?? x.argument;
      if (t.isIdentifier(target)) writes.add(target.name);
      else if (t.isMemberExpression(target) && t.isIdentifier(target.object) && target.computed) arrays.writes.push(target);
      else bad = true;
    }
    if (t.isMemberExpression(x)) {
      if (t.isIdentifier(x.object) && x.computed) arrays.reads.push(x);
      else bad = true;
    }
    if (t.isIdentifier(x)) reads.add(x.name);
  });
  void fx;
  return { reads, writes, arrays, bad };
}
// yalnızca yerel, dizi literaliyle başlatılmış ve yeniden atanmayan diziler (getter yok)
// Diğer kullanımlar: indeksli erişim ya da yerleşik okuma yöntemleri (dizi başka yere geçmez, özellik tanımlanamaz)
const SAFE_ARRAY_READS = new Set(['length', 'join', 'slice', 'indexOf', 'includes', 'concat', 'toString']);
function plainArray(fn, name) {
  const b = fn.scope.getBinding(name);
  return b && b.constantViolations.length === 0 && t.isVariableDeclarator(b.path.node) && t.isArrayExpression(b.path.node.init) &&
    b.path.node.init.elements.every((e) => e && !t.isSpreadElement(e)) &&
    b.referencePaths.every((r) => {
      const m = r.parentPath;
      if (!m.isMemberExpression({ object: r.node })) return false;
      if (m.node.computed) return true;
      if (!SAFE_ARRAY_READS.has(m.node.property.name)) return false;
      return !m.parentPath.isAssignmentExpression({ left: m.node }) && !m.parentPath.isUpdateExpression() && !m.parentPath.isUnaryExpression({ operator: 'delete' });
    });
}
function fuse(fx, fn, loop) {
  const p = loop.path;
  if (!p.isForStatement() || !listed(p)) return false;
  const next = p.getSibling(p.key + 1);
  if (!next?.node || !next.isForStatement()) return false;
  const a = p.node;
  const b = next.node;
  const same = (x, y) => (x === null && y === null) || (x && y && gen(x) === gen(y));
  if (!same(a.test, b.test) || !same(a.update, b.update) || !a.test || !a.update) return false;
  if (hasSideEffectSyntax(a.test) || ownJumps(a.body) || ownJumps(b.body)) return false;
  const iv = loop.ivs.find((x) => containsNode(a.update, x.def.site));
  if (!iv) return false;
  // test/update yalnızca kimlik ve literal okumalı; gövdeler bu kimlikleri yazmamalı
  const headerVars = new Set();
  let simple = true;
  traverseNodes([a.test, a.update], (x) => { if (t.isMemberExpression(x) || t.isCallExpression(x)) simple = false; if (t.isIdentifier(x)) headerVars.add(x.name); });
  if (!simple) return false;
  // b'nin başlatıcısı i'yi a'nınkiyle aynı değere getirmeli
  const initVal = (init) => (t.isVariableDeclaration(init) && init.declarations.length === 1 && t.isIdentifier(init.declarations[0].id, { name: iv.name }) ? init.declarations[0].init
    : t.isAssignmentExpression(init, { operator: '=' }) && t.isIdentifier(init.left, { name: iv.name }) ? init.right : null);
  const ia = initVal(a.init);
  const ib = initVal(b.init);
  if (!ia || !ib || !t.isNumericLiteral(ia) || !t.isNumericLiteral(ib) || ia.value !== ib.value) return false;
  if (t.isVariableDeclaration(a.init) && a.init.kind !== 'var' || t.isVariableDeclaration(b.init) && b.init.kind !== 'var') return false;
  const A = readsWrites(a.body, fx);
  const B = readsWrites(b.body, fx);
  if (A.bad || B.bad || A.writes.has(iv.name) || B.writes.has(iv.name)) return false;
  for (const w of [...A.writes, ...B.writes]) if (headerVars.has(w)) return false;
  for (const w of A.writes) if (B.reads.has(w) || B.writes.has(w)) return false;
  for (const w of B.writes) if (A.reads.has(w)) return false;
  // dizi erişimleri yalnızca [i] indeksiyle ve yerel düz dizilerde
  const idx = (m) => t.isIdentifier(m.property, { name: iv.name });
  for (const m of [...A.arrays.reads, ...A.arrays.writes, ...B.arrays.reads, ...B.arrays.writes]) {
    if (!plainArray(fn, m.object.name)) return false;
  }
  const writtenA = new Set(A.arrays.writes.map((m) => m.object.name));
  const writtenB = new Set(B.arrays.writes.map((m) => m.object.name));
  for (const m of B.arrays.reads) if (writtenA.has(m.object.name) && !idx(m)) return false;
  for (const m of [...B.arrays.writes]) if (!idx(m) && (A.arrays.reads.some((r) => r.object.name === m.object.name) || writtenA.has(m.object.name))) return false;
  for (const m of A.arrays.reads) if (writtenB.has(m.object.name) && !idx(m)) return false;
  for (const m of A.arrays.writes) if (!idx(m) && (writtenB.has(m.object.name) || B.arrays.reads.some((r) => r.object.name === m.object.name))) return false;
  const body = [...(t.isBlockStatement(a.body) ? a.body.body : [a.body]), ...(t.isBlockStatement(b.body) ? b.body.body : [b.body])];
  if (body.some((s) => t.isVariableDeclaration(s) && s.kind !== 'var' || t.isFunctionDeclaration(s) || t.isClassDeclaration(s))) return false;
  // açılabilecek döngüler birleştirilmez (bölme + açma ile salınım olmasın)
  const tv = tripValues(fx, loop);
  if (tv && [a.body, b.body].some((x) => nodeSize(x) * Math.max(1, tv.vals.length) <= MAX_UNROLLED)) return false;
  a.body = t.blockStatement(body);
  // ikinci döngünün başlatıcısı i'yi yeniden aynı değere getiriyordu; birleşik döngü sonrası i aynı son değerde
  next.remove();
  return true;
}
fuse.key = 'fuse';

// E673 bölme: bütünü açılamayacak kadar büyük, ama bağımsız küçük bir grubu açılabilecek döngü ikiye bölünür;
// küçük grup ayrı (açılabilir) döngü olur, büyük grup kalan döngüde i yeniden başlatılarak çalışır.
function fission(fx, fn, loop) {
  const p = loop.path;
  if (!listed(p) || !p.isForStatement()) return false;
  const tv = tripValues(fx, loop);
  if (!tv || ownJumps(p.node.body) || blockDecls(p.node.body)) return false;
  if (nodeSize(p.node.body) * Math.max(1, tv.vals.length) <= MAX_UNROLLED) return false;
  if (!p.node.init || (t.isVariableDeclaration(p.node.init) && p.node.init.kind !== 'var')) return false;
  if (hasSideEffectSyntax(p.node.test)) return false;
  const groups = fissionLoop(fn, p, tv.iv.name);
  if (!groups) return false;
  const sizes = groups.map((g) => nodeSize(t.blockStatement(g)));
  const small = sizes[0] <= sizes[1] ? 0 : 1;
  if (sizes[small] * tv.vals.length > MAX_UNROLLED) return false;
  const i0 = constOf(fx, tv.iv.init);
  const mk = (stmts, withInit) => t.forStatement(withInit ? p.node.init : t.assignmentExpression('=', t.identifier(tv.iv.name), t.numericLiteral(i0)),
    t.cloneNode(p.node.test, true), t.cloneNode(p.node.update, true), t.blockStatement(stmts));
  // gövde sırası korunur: önce ilk grubun tüm turları, sonra ikinci grubun (bağımsızlık bunu eşdeğer kılar)
  p.replaceWithMultiple([mk(groups[0], true), mk(groups[1], false)]);
  return true;
}
fission.key = 'fission';

/**
 * E673 bölme: gövde iki bağımsız gruba ayrılabiliyorsa (skaler bağımlılık yok, diziler yalnızca [i]) döngü ikiye bölünür.
 * Birleştirme bunu geri almasın diye yalnızca küçük grubun açılmasını sağlayacak durumda kullanılır (unroll içinden).
 */
export function fissionLoop(fn, p, ivName) {
  const stmts = t.isBlockStatement(p.node.body) ? p.node.body.body : null;
  if (!stmts || stmts.length < 2 || ownJumps(p.node.body)) return null;
  for (let m = 1; m < stmts.length; m++) {
    const A = readsWrites(t.blockStatement(stmts.slice(0, m)));
    const B = readsWrites(t.blockStatement(stmts.slice(m)));
    if (A.bad || B.bad || A.writes.has(ivName) || B.writes.has(ivName)) continue;
    if ([...A.writes].some((w) => B.reads.has(w) || B.writes.has(w)) || [...B.writes].some((w) => A.reads.has(w))) continue;
    const arr = [...A.arrays.reads, ...A.arrays.writes, ...B.arrays.reads, ...B.arrays.writes];
    if (arr.some((x) => !plainArray(fn, x.object.name) || !t.isIdentifier(x.property, { name: ivName }))) continue;
    // gruplar (IV dışında) tamamen ayrık değişkenlere dokunmalı: aynı diziyi paylaşan zincirler bölünmez
    const touched = (G) => new Set([...G.reads, ...G.writes].filter((x) => x !== ivName));
    const ta = touched(A);
    if ([...touched(B)].some((x) => ta.has(x))) continue;
    return [stmts.slice(0, m), stmts.slice(m)];
  }
  return null;
}
