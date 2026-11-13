import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { parse } from '../core/parse.js';
import { applyInputs } from '../symbolic/concolic.js';
import { exploreMachine, collectSumFns } from './76-unflatten.js';
import { caseSummaries, observedEdges, machineReport, debugSteps } from '../core/vm/sm.js';

// VM / state machine dedektörü: döngü içinde, case gövdelerinde durumu değişen switch.
// Kodu değiştirmez; makinenin üstüne geçiş tablosunu yorum olarak yazar ve rapora ayrıntı aktarır:
//  - statik keşif (durum değişkenlerinin başlangıcı literal ise): kenarlar dal koşullarıyla (madde 26), uçlar (E186),
//    default dalı (E187), ulaşılmayan case'ler (madde 36)
//  - tek çalıştırmada gözlenen geçişler (işaretleyici ile iz, E183)
//  - zorlanmış dallarla ek çalıştırmalar (madde 27) ve bunların birleşimi (E195)
//  - durum bir nesnede tutuluyorsa Proxy ile yazmaların gözlenmesi (E184)
// Tek çalıştırmadan çıkarılan akış diğer girdiler için yanlış olabilir: bu yüzden kod değiştirilmez.
//
// Çözücü kancası (madde 27/30): ek çalıştırmaların planı concolicPlan() ile yapılır. Varsayılan strateji her case
// içi dalın ilk görülen sonucunu tersine zorlar. ctx.solver verilirse onun planBranches({ log, branches }) metodu
// kullanılır: log = temel çalıştırmadaki [anahtar, sonuç] dizisi ("makine:dal" anahtarı), branches = her dalın
// { key, test (kaynak), machine } bilgisi; dönüş, her biri bir çalıştırma olan zorlama haritaları listesidir:
// [{ "0:2": [kaçıncı değerlendirme, değer] }, …]. Gerçek bir SMT çözücü yol koşulunu çözüp uygun girdiyi
// bulamadığı dalları da bu biçimde zorlayabilir; geri kalan akış (çalıştırma, birleştirme, rapor) değişmez.

const MARK = ' PEEL VM';
const MAX_EVENTS = 20000;
const MAX_LINES = 150;
const MAX_FORCED = 6;

function switchOf(loopNode) {
  let body = loopNode.body;
  const wrapper = (n) => t.isWithStatement(n) || t.isLabeledStatement(n) || t.isBlockStatement(n);
  for (;;) {
    if (t.isWithStatement(body) || t.isLabeledStatement(body)) body = body.body;
    else if (t.isBlockStatement(body) && body.body.length === 1 && wrapper(body.body[0])) body = body.body[0];
    else break;
  }
  if (t.isSwitchStatement(body)) return { sw: body, siblings: null };
  if (!t.isBlockStatement(body)) return null;
  const idx = body.body.findIndex((s) => t.isSwitchStatement(s));
  if (idx < 0) return null;
  // with gövdesi blok ise switch onun içinde olabilir
  return { sw: body.body[idx], siblings: body.body, idx };
}

const pathOf = (n) => {
  if (t.isIdentifier(n)) return n.name;
  if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
    const b = pathOf(n.object);
    return b && `${b}.${n.property.name}`;
  }
  return null;
};

function stateNames(found) {
  const d = found.sw.discriminant;
  const names = new Set();
  const members = new Set();
  const collect = (n) => {
    if (t.isIdentifier(n)) names.add(n.name);
    else if (t.isMemberExpression(n)) {
      const p = pathOf(n);
      if (p && t.isIdentifier(n.object)) members.add(p);
      collect(n.object);
      if (n.computed) collect(n.property);
    } else if (t.isBinaryExpression(n)) { collect(n.left); collect(n.right); }
    else if (t.isUpdateExpression(n)) collect(n.argument);
    else if (t.isUnaryExpression(n)) collect(n.argument);
  };
  collect(d);
  // state-var çıktısı: __peelS = P + Q; switch (__peelS)
  const prev = found.siblings?.[found.idx - 1];
  let pre = null;
  if (t.isIdentifier(d) && t.isExpressionStatement(prev) && t.isAssignmentExpression(prev.expression) &&
      t.isIdentifier(prev.expression.left, { name: d.name })) { collect(prev.expression.right); pre = d.name; }
  return { names, members, pre };
}

function mutatedInCases(sw, names) {
  let hit = false;
  const visit = (node) => {
    if (!node || typeof node !== 'object' || hit) return;
    if (t.isAssignmentExpression(node)) {
      const l = node.left;
      if ((t.isIdentifier(l) && names.has(l.name)) ||
          (t.isMemberExpression(l) && t.isIdentifier(l.object) && names.has(l.object.name))) { hit = true; return; }
    }
    if (t.isUpdateExpression(node) && t.isIdentifier(node.argument) && names.has(node.argument.name)) { hit = true; return; }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach(visit); else visit(v);
    }
  };
  sw.cases.forEach((c) => c.consequent.forEach(visit));
  return hit;
}

// case gövdelerindeki if'ler (iç fonksiyonlara girilmez): dal zorlama noktaları
function branchPoints(sw) {
  const out = [];
  const visit = (n) => {
    if (!n || typeof n !== 'object' || t.isFunction(n)) return;
    if (t.isIfStatement(n)) out.push(n);
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit); else visit(v);
    }
  };
  sw.cases.forEach((c) => c.consequent.forEach(visit));
  return out;
}

// Ek çalıştırma planı: çözücü varsa ondan, yoksa ilk sonucu tersine çeviren varsayılan strateji
// Plan öğesi iki biçimde olabilir: zorlama haritası { "m:j": [n, değer] } ya da çözücü planı
// { force, inputs?, status: 'feasible'|'infeasible'|'unknown', key, value, proof? } (src/symbolic/vm-solver.js)
export async function concolicPlan(log, branches, solver = null, max = MAX_FORCED, code = null) {
  if (solver?.planBranches) return (await solver.planBranches({ log, branches, code })).slice(0, max);
  const first = new Map();
  for (const [k, v] of log) if (!first.has(k)) first.set(k, v);
  return [...first].slice(0, max).map(([k, v]) => ({ [k]: [1, !v] }));
}

const PRELUDE = (force) => `var __peelN = 0, __peelBrLog = [], __peelBrCount = {}, __peelPw = [], __peelForce = ${JSON.stringify(force)};
function __peelMark(id, v) { if (__peelN++ < ${MAX_EVENTS} && (typeof v === "number" || typeof v === "string")) __res.push([id, v]); return v; }
function __peelBr(id, j, v) {
  var k = id + ":" + j;
  var n = __peelBrCount[k] = (__peelBrCount[k] || 0) + 1;
  var f = __peelForce[k];
  if (f && f[0] === n) v = f[1];
  if (__peelBrLog.length < 5000) __peelBrLog.push([k, !!v]);
  return v;
}
function __peelProxy(id, o, props) {
  if (!o || (typeof o !== "object" && typeof o !== "function") || typeof Proxy !== "function") return o;
  return new Proxy(o, { set: function (tg, k, v, r) {
    if (props.indexOf(k) >= 0 && __peelPw.length < 2000) __peelPw.push([id, String(k), typeof v === "number" || typeof v === "string" ? v : typeof v]);
    return Reflect.set(tg, k, v, r);
  } });
}`;

function transitions(events, id) {
  return events.filter(([vmId]) => vmId === id).map(([, v]) => v);
}

// Makine tespiti (saf AST işlevi): araçlama öncesi kod yeniden parse edilince aynı sıra ve dal konumları elde edilir
function detectVms(ast) {
  const vms = [];
  traverse(ast, {
    Loop(p) {
      if ((p.node.leadingComments ?? []).some((c) => c.value.startsWith(MARK))) return;
      const found = switchOf(p.node);
      if (!found || found.sw.cases.length < 3) return;
      const st = stateNames(found);
      if (!st.names.size || !mutatedInCases(found.sw, st.names)) return;
      const fn = p.getFunctionParent();
      vms.push({ path: p, sw: found.sw, st, fn: fn?.node.id?.name ?? (fn ? '(anonim)' : '(program)'), label: p.parentPath.isLabeledStatement() ? p.parentPath.node.label.name : null });
    },
  });
  return vms;
}

export async function run(ast, { onLog, bump, sandbox, findings, solver = null }) {
  const vms = detectVms(ast);
  if (!vms.length) return;
  // çözücü için araçlanmamış kod ve dal test konumları (concolic dal kimlikleri bu kodun konumlarıdır)
  const plain = gen(ast);
  const starts = new Map();
  try {
    detectVms(parse(plain)).forEach((v, i) => branchPoints(v.sw).forEach((ifs, j) => starts.set(`${i}:${j}`, ifs.test.start)));
  } catch { /* konum yoksa çözücü dalları eşleyemez: zorlama planı */ }

  // araçlama: discriminant işaretleyici, case içi if'lerde dal kancası, nesnede tutulan durum için Proxy
  const undo = [];
  vms.forEach((v, i) => {
    const d = v.sw.discriminant;
    v.sw.discriminant = t.callExpression(t.identifier('__peelMark'), [t.numericLiteral(i), d]);
    undo.push(() => { v.sw.discriminant = d; });
    v.branches = branchPoints(v.sw);
    v.branches.forEach((ifs, j) => {
      const test = ifs.test;
      ifs.test = t.callExpression(t.identifier('__peelBr'), [t.numericLiteral(i), t.numericLiteral(j), test]);
      undo.push(() => { ifs.test = test; });
    });
    const byObj = new Map();
    for (const m of v.st.members) {
      const [obj, prop] = m.split('.');
      const b = v.path.scope.getBinding(obj);
      if (!b || b.kind === 'const' || b.kind === 'module') continue;
      if (!byObj.has(obj)) byObj.set(obj, []);
      byObj.get(obj).push(prop);
    }
    const stmt = v.label ? v.path.parentPath : v.path;
    if (byObj.size && Array.isArray(stmt.container)) {
      for (const [obj, props] of byObj) {
        const wrap = t.expressionStatement(t.assignmentExpression('=', t.identifier(obj), t.callExpression(t.identifier('__peelProxy'),
          [t.numericLiteral(i), t.identifier(obj), t.arrayExpression(props.map((x) => t.stringLiteral(x)))])));
        const c = stmt.container;
        c.splice(c.indexOf(stmt.node), 0, wrap);
        undo.push(() => c.splice(c.indexOf(wrap), 1));
      }
      v.proxied = [...byObj.keys()];
    }
  });
  const instrumented = gen(ast);
  undo.reverse().forEach((u) => u());

  const runOnce = async (force, timeoutMs, inputs = null) => {
    // çözücü girdisi: ortam okumaları bulunan değerlerle değiştirilmiş araçlı kod
    const code = inputs ? applyInputs(instrumented, inputs) : instrumented;
    const r = await sandbox.run(`${PRELUDE(force)}\ntry {\n${code}\n} catch (e) {}\n__res.push({ __peelSm: 1, br: __peelBrLog, pw: __peelPw });`, { timeoutMs });
    const res = r.res ?? [];
    const tail = res.find((x) => x && x.__peelSm) ?? { br: [], pw: [] };
    return { events: res.filter((x) => Array.isArray(x)), br: tail.br, pw: tail.pw };
  };
  const base = await runOnce({}, 6000);

  // Madde 27: her case içi dalın ilk görülen sonucunu tersine çevirerek ek çalıştırmalar (dal zorlama)
  const branches = vms.flatMap((v, i) => v.branches.map((ifs, j) => ({ key: `${i}:${j}`, machine: i, test: gen(ifs.test).slice(0, 200), start: starts.get(`${i}:${j}`) ?? null })));
  const forcedRuns = [];
  const feasibility = []; // çözücü kararları: { key, value, status, inputs?, proof? }
  for (const item of await concolicPlan(base.br, branches, solver, MAX_FORCED, plain)) {
    const plan = item.force && item.status ? item : { force: item, status: 'unknown' };
    if (plan.status !== 'unknown' || plan.inputs) feasibility.push({ key: plan.key, value: plan.value, status: plan.status, inputs: plan.inputs ?? null, proof: plan.proof?.method ?? null });
    if (plan.status === 'infeasible') continue;
    const r = await runOnce(plan.force, 2000, plan.inputs ?? null);
    if (plan.inputs) forcedRuns.push({ key: plan.key, value: plan.value, events: r.events, status: 'feasible', inputs: plan.inputs });
    else for (const [k, [, value]] of Object.entries(plan.force)) forcedRuns.push({ key: k, value, events: r.events, status: 'unknown' });
  }

  const sumFns = collectSumFns(ast);
  vms.forEach((v, i) => {
    const seq = transitions(base.events, i);
    const observed = observedEdges(seq);
    const baseKeys = new Set(observed.map((e) => `${e.from}→${e.to}`));
    // E195: tüm çalıştırmaların birleşimi; yalnızca zorlanmış çalıştırmada görülen kenarlar ayrıca işaretlenir
    const forced = [];
    for (const fr of forcedRuns) {
      if (!fr.key.startsWith(`${i}:`)) continue;
      for (const e of observedEdges(transitions(fr.events, i))) {
        if (baseKeys.has(`${e.from}→${e.to}`) || forced.some((x) => x.from === e.from && x.to === e.to)) continue;
        const how = fr.status === 'feasible' ? `çözülmüş girdi: ${Object.entries(fr.inputs).map(([k, x]) => `${k}=${JSON.stringify(x)}`).join(', ')}` : `zorla ${fr.key.split(':')[1]}. dal = ${fr.value}, doğrulanmamış`;
        forced.push({ ...e, status: fr.status, cond: how });
      }
    }
    // statik keşif: tüm durum adları sabit başlangıçlı yerel değişkense
    let staticGraph = null;
    const vars = new Map();
    const loopStmt = v.path.node;
    const discNames = [...v.st.names].filter((n) => n !== v.st.pre);
    const allLiteral = discNames.every((n) => {
      const b = v.path.scope.getBinding(n);
      const init = b?.path.isVariableDeclarator() ? b.path.node.init : null;
      const val = t.isNumericLiteral(init) ? init.value : t.isUnaryExpression(init, { operator: '-' }) && t.isNumericLiteral(init.argument) ? -init.argument.value : null;
      if (val === null) return false;
      vars.set(n, val);
      return true;
    });
    if (allLiteral && discNames.length && !v.st.members.size && !v.path.findParent((x) => x.isWithStatement()) && t.isWhileStatement(loopStmt)) {
      staticGraph = exploreMachine(loopStmt, v.label, vars, sumFns);
    }
    const cases = caseSummaries(v.sw, [...v.st.names]);
    const pw = base.pw.filter(([id]) => id === i).map(([, k, val]) => ({ prop: k, value: val }));
    const report = machineReport({
      id: i, fn: v.fn, line: loopStmt.loc?.start.line ?? null, discriminant: gen(v.sw.discriminant), stateNames: [...v.st.names],
      cases, staticGraph, observed, forced, runs: forcedRuns.length, proxyWrites: pw, entries: seq.length ? [seq[0]] : [],
    });
    report.kind = 'switch makinesi';
    report.steps = debugSteps(seq, cases);
    report.proxied = v.proxied ?? [];
    // madde 27: alınmayan dalların çözücü kararları (yalnızca bu makine)
    report.branchFeasibility = feasibility.filter((x) => x.key?.startsWith(`${i}:`));
    findings?.sm?.push(report);

    const lines = [`${MARK} | ${v.sw.cases.length} durum | switch (${gen(v.sw.discriminant)})`];
    const fmt = (e) => `  ${e.from} -> ${e.to}${e.cond ? ` [${e.cond}]` : ''}`;
    if (staticGraph?.edges.length) {
      lines.push(`  geçiş tablosu (statik${staticGraph.complete ? '' : `, kısmi: ${staticGraph.reason}`}):`);
      for (const e of staticGraph.edges.slice(0, MAX_LINES)) lines.push(fmt(e));
    }
    const edges = new Map();
    for (const e of observed) {
      if (!edges.has(e.from)) edges.set(e.from, new Set());
      edges.get(e.from).add(e.to);
    }
    if (edges.size) {
      lines.push('  gözlenen geçişler (tek çalıştırma):');
      for (const [from, to] of [...edges].slice(0, MAX_LINES)) lines.push(`  ${from} -> ${[...to].join(' | ')}`);
      if (edges.size > MAX_LINES) lines.push(`  ... ${edges.size - MAX_LINES} geçiş daha`);
    } else if (!staticGraph?.edges.length) {
      lines.push('  çalıştırmada bu makineye girilmedi');
    }
    const solved = forced.filter((e) => e.status === 'feasible');
    const pushed = forced.filter((e) => e.status !== 'feasible');
    if (solved.length) {
      lines.push('  çözücüyle bulunan girdilerle ek geçişler (doğrulandı):');
      for (const e of solved.slice(0, 40)) lines.push(fmt(e));
    }
    if (pushed.length) {
      lines.push('  zorlanmış dallarla bulunan ek geçişler:');
      for (const e of pushed.slice(0, 40)) lines.push(fmt(e));
    }
    for (const fz of report.branchFeasibility) {
      lines.push(`  dal ${fz.key.split(':')[1]} = ${fz.value}: ${fz.status === 'feasible' ? `ulaşılabilir (girdi: ${JSON.stringify(fz.inputs)})` : fz.status === 'infeasible' ? `olanaksız (kanıt: ${fz.proof}, gözlenen yol öneklerinde)` : 'bilinmiyor'}`);
    }
    if (report.unreachable.length) lines.push(`  ulaşılmayan case'ler (${report.complete ? 'kanıtlandı' : 'gözlenmedi'}): ${report.unreachable.map((u) => u.label).join(', ')}`);
    if (report.terminators.length) lines.push(`  uçlar: ${[...new Set(report.terminators.map((x) => `${x.from}: ${x.kind}`))].slice(0, 20).join('; ')}`);
    if (pw.length) lines.push(`  Proxy ile gözlenen durum yazmaları: ${pw.slice(0, 20).map((x) => `${x.prop}=${x.value}`).join(', ')}`);
    t.addComment(v.path.node, 'leading', `${lines.join('\n')}\n`, false);
    onLog(`vm: ${v.sw.cases.length} durumlu makine işaretlendi (${observed.length} geçiş${forced.length ? `, ${forced.length} zorlanmış` : ''})`, 'info');
  });
  bump('vm', vms.length);
}
