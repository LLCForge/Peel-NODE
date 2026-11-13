import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { literalOf } from '../util/literal.js';
import { isPureExpr } from '../util/pure.js';

const ROOTS = 'BinaryExpression|UnaryExpression|LogicalExpression|ConditionalExpression|CallExpression|MemberExpression|TemplateLiteral|SequenceExpression';
const MAX_SRC = 1000;
const MAX_STRING = 2000;
const MAX_JOBS = 6000;

function skipPosition(p) {
  const parent = p.parentPath;
  if (p.isMemberExpression()) {
    if (parent.isAssignmentExpression({ left: p.node }) || parent.isUpdateExpression() ||
        parent.isUnaryExpression({ operator: 'delete' }) || parent.isCallExpression({ callee: p.node }) ||
        parent.isForXStatement({ left: p.node })) return true;
  }
  // sonucu kullanılmayan çağrı: yan etki için yapılıyor olabilir
  if (p.isCallExpression() && parent.isExpressionStatement()) return true;
  if (p.isTemplateLiteral() && parent.isTaggedTemplateExpression()) return true;
  return false;
}

const memberName = (m) => (t.isMemberExpression(m) ? (!m.computed && t.isIdentifier(m.property) ? m.property.name : t.isStringLiteral(m.property) ? m.property.value : null) : null);
// A.push(A.shift()): string dizisi rotasyonu. Döngünün içindeki decoder çağrılarının değeri dizinin o anki
// (yarı döndürülmüş) durumuna bağlıdır; bağlamdaki son durumla katlamak rotasyon checksum'ını bozar.
const rotationSeen = new WeakMap();
function rotationLoop(loop) {
  if (rotationSeen.has(loop.node)) return rotationSeen.get(loop.node);
  let hit = false;
  t.traverseFast(loop.node, (n) => {
    if (hit || !t.isCallExpression(n) || memberName(n.callee) !== 'push' || n.arguments.length !== 1) return;
    const a = n.arguments[0];
    hit = t.isCallExpression(a) && memberName(a.callee) === 'shift' && gen(a.callee.object) === gen(n.callee.object);
  });
  rotationSeen.set(loop.node, hit);
  return hit;
}

export async function run(ast, { onLog, bump, sandbox, ctx }) {
  const jobs = [];
  traverse(ast, {
    [ROOTS](p) {
      if (jobs.length >= MAX_JOBS) return;
      if (t.isUnaryExpression(p.node, { operator: '-' }) && t.isNumericLiteral(p.node.argument)) return;
      if (t.isUnaryExpression(p.node, { operator: 'void' }) && t.isNumericLiteral(p.node.argument)) return;
      if (skipPosition(p)) return;
      const src = gen(p.node);
      if (src.length > MAX_SRC) return;
      if (isPureExpr(p)) jobs.push({ path: p, src, inCtx: false });
      else if (ctx && isPureExpr(p, { programFns: true }) && !p.findParent((x) => x.isLoop() && rotationLoop(x))) jobs.push({ path: p, src, inCtx: true });
    },
  });
  if (!jobs.length) return;

  const plain = jobs.filter((j) => !j.inCtx);
  const contextual = jobs.filter((j) => j.inCtx);
  const [r1, r2] = await Promise.all([
    plain.length ? sandbox.batch(plain.map((j) => j.src)) : { ok: true, results: [] },
    contextual.length ? sandbox.batchIn(ctx, contextual.map((j) => j.src)) : { ok: true, results: [] },
  ]);
  if (r1.ok) plain.forEach((j, i) => { j.result = r1.results[i]; });
  if (r2.ok) contextual.forEach((j, i) => { j.result = r2.results[i]; });

  const folded = new WeakSet();
  let n = 0;
  for (const j of jobs) {
    const r = j.result;
    if (!r?.ok || r.opaque || r.type === 'undefined') continue;
    // Bağlamdaki program fonksiyonları yalnızca decoder gibi string üretiyorsa katlanır:
    // sayı/boolean döndüren fonksiyonlar çoğunlukla değişken duruma bağlıdır, tek değerle sabitlemek yanlış olur.
    if (j.inCtx && r.type !== 'string') continue;
    if (r.type === 'string' && r.value.length > MAX_STRING) continue;
    if (!j.path.node || j.path.findParent((pp) => folded.has(pp.node))) continue;
    const lit = literalOf(t, r.value);
    if (!lit || gen(lit) === j.src) continue;
    j.path.replaceWith(lit);
    folded.add(j.path.node);
    n++;
  }
  if (n) onLog(`const-fold: ${n} ifade katlandı`, 'info');
  bump('constFold', n);
}
