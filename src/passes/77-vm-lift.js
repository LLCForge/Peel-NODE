import * as t from '@babel/types';
import { gen } from '../util/ast.js';
import { keyPath, follow, placeAt } from '../util/keypath.js';
import { fnv1a } from '../util/hash.js';
import { findVms } from '../core/vm/detect.js';
import { isStaticDispatcher } from './70-control-flow.js';
import { HOLE } from '../core/vm/interp.js';
import { collectNames } from '../core/vm/lift.js';
import { staticValues, instrument, captureRun, decodeCapture } from '../core/vm/values.js';
import { analyzeVm, stateVarsFor } from '../core/vm/analysis.js';
import { readableInterpreter } from '../core/vm/readable.js';

// Bytecode VM'leri (jsvmp tarzı yorumlayıcılar) düz JavaScript'e çevirir (madde 31/32, E192, E649–E651).
//
// Her VM için bytecode, sabit havuzu ve giriş durumu önce statik olarak, bulunamazsa sandbox'ta döngü
// girişinde yakalanır (madde 38). Aynı çalıştırmada her komutun pc'si ve yığın tepesi kaydedilir
// (dinamik adlandırma, kapsam, adım adım iz). Ardından VM somut bytecode ile kısmen değerlendirilir.
// Fonksiyon VM'lerinde (function run(code, …)) her farklı bytecode için o bytecode'a özel bir kopya
// üretilir ve çağrı yerleri kopyaya bağlanır; program/yerel VM'ler yerinde değiştirilir.
// Çevrilemeyen VM'e okunur yorumlayıcı açıklamaları (case başına komut adı ve anlamı) eklenir (E652).

const LIFT = ' PEEL VM-LIFT';
// açıklamalarda dağıtım biçiminin Türkçe adı (kod sözcükleriyle karışmasın)
const STYLE = { switch: 'case dağıtımı', 'if-chain': 'if zinciri', table: 'handler tablosu' };
const NOTE = ' PEEL VM |';
const hasNote = (node) => (node.leadingComments ?? []).some((c) => c.value.startsWith(NOTE) || c.value.startsWith(LIFT));

// Kod üretilmiş bir bölgenin içinde mi (iç içe VM derinliği, E654)
function liftDepth(path) {
  let depth = 0;
  for (let p = path; p; p = p.parentPath) {
    for (const c of p.node?.leadingComments ?? []) {
      const m = c.value.match(/^ PEEL VM-LIFT .*derinlik=(\d+)/);
      if (m) depth = Math.max(depth, Number(m[1]));
    }
    if (p.isFunction() || p.isProgram()) {
      for (const st of p.node.body?.body ?? p.node.body ?? []) {
        for (const c of st?.leadingComments ?? []) {
          const m = c.value.match(/^ PEEL VM-LIFT .*derinlik=(\d+)/);
          if (m) depth = Math.max(depth, Number(m[1]));
        }
      }
    }
  }
  return depth;
}

function callSites(vm) {
  const fn = vm.fnPath;
  if (!fn.isFunctionDeclaration() || !fn.node.id) return null;
  const codeB = vm.loopPath.scope.getBinding(vm.roles.code);
  if (codeB?.kind !== 'param') return null;
  const b = fn.parentPath.scope.getBinding(fn.node.id.name);
  if (!b || b.constantViolations.length) return null;
  const sites = [];
  for (const [j, ref] of b.referencePaths.entries()) {
    const call = ref.parentPath;
    if (!call.isCallExpression({ callee: ref.node }) || call.node.arguments.some((a) => t.isSpreadElement(a))) return null;
    if (ref.findParent((x) => x === fn)) return null; // özyineleme: kopya kendini çağırırdı
    let unsafe = false;
    walk(call.node, (n) => { if (t.isAwaitExpression(n) || t.isYieldExpression(n)) unsafe = true; });
    if (unsafe) return null;
    sites.push({ id: `${vm.id}:${j}`, path: call });
  }
  return sites.length ? sites : null;
}

function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  for (const k of t.VISITOR_KEYS[node.type] ?? []) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn)); else walk(v, fn);
  }
}

function mergeValues(stat, cap, roles) {
  const arrays = new Map(stat.arrays);
  const state = new Map(stat.state);
  let captured = false;
  if (cap) {
    const arrNames = [roles.code, roles.consts].filter(Boolean);
    arrNames.forEach((n, i) => {
      if (!arrays.has(n) && cap.arrays[i] != null) { arrays.set(n, cap.arrays[i]); captured = true; }
    });
    for (const [n, v] of cap.state) if (!state.has(n)) { state.set(n, v); captured = true; }
  }
  let stackInit = stat.stackInit;
  if (stackInit === null && cap && Number.isInteger(cap.depth) && cap.depth >= 0) { stackInit = cap.depth; captured = true; }
  return { arrays, state, stackInit: stackInit ?? 0, captured, stackKnown: stackInit !== null };
}

// Register dizisini (R = [] ve yalnızca R[sabit] kullanımı) ayrı değişkenlere böl: R[2] → _r2
function scalarizeRegisters(fnNode, name, used) {
  const body = t.isProgram(fnNode) ? fnNode.body : fnNode.body?.body;
  if (!name || !Array.isArray(body)) return false;
  let declIndex = -1;
  let declarator = null;
  body.forEach((s, i) => {
    if (t.isVariableDeclaration(s)) for (const d of s.declarations) if (t.isIdentifier(d.id, { name })) { declIndex = i; declarator = d; }
  });
  if (!declarator || !t.isArrayExpression(declarator.init) || declarator.init.elements.some((e) => e && !t.isLiteral(e))) return false;
  let ok = true;
  const sites = [];
  const visit = (n, parent, key, idx, inner) => {
    if (!n || typeof n !== 'object' || !ok) return;
    if (inner && t.isFunction(n)) {
      const own = [...n.params.flatMap((p) => Object.keys(t.getBindingIdentifiers(p)))];
      if (own.includes(name)) return;
    }
    if (t.isIdentifier(n, { name }) && n !== declarator.id) {
      const isName = (t.isMemberExpression(parent) && key === 'property' && !parent.computed) || (t.isObjectProperty(parent) && key === 'key' && !parent.computed);
      if (!isName) {
        if (!(t.isMemberExpression(parent) && key === 'object' && parent.computed && t.isNumericLiteral(parent.property) && Number.isInteger(parent.property.value))) ok = false;
        else sites.push(parent);
      }
    }
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c, i) => visit(c, n, k, i, inner || t.isFunction(n))); else visit(v, n, k, null, inner || t.isFunction(n));
    }
  };
  body.forEach((s, i) => {
    if (i < declIndex) walk(s, (n) => { if (t.isIdentifier(n, { name })) ok = false; });
    else visit(s, null, null, null, false);
  });
  if (!ok || !sites.length) return false;
  const names = new Map();
  const nameFor = (i) => {
    if (!names.has(i)) {
      let k = 0;
      let nm;
      do { nm = `_r${i}${k ? `_${k}` : ''}`; k++; } while (used.has(nm));
      used.add(nm);
      names.set(i, nm);
    }
    return names.get(i);
  };
  const elems = declarator.init.elements;
  elems.forEach((_, i) => nameFor(i));
  for (const m of sites) {
    const id = t.identifier(nameFor(m.property.value));
    Object.keys(m).forEach((k) => { if (!['leadingComments', 'trailingComments'].includes(k)) delete m[k]; });
    Object.assign(m, id);
  }
  const decl = body[declIndex];
  const idx = decl.declarations.indexOf(declarator);
  const fresh = [...names].sort((a, b) => a[0] - b[0]).map(([i, nm]) => t.variableDeclarator(t.identifier(nm), elems[i] ? t.cloneNode(elems[i]) : null));
  decl.declarations.splice(idx, 1, ...fresh);
  return true;
}

// Tablo dağıtımlı VM çevrildikten sonra handler tablosu (yalnızca yorumlayıcı kullanıyordu) kaldırılır
function dropUnusedTable(fnNode, name) {
  const inert = (x) => t.isFunctionExpression(x) || (t.isArrayExpression(x) && x.elements.every((e) => !e || t.isFunctionExpression(e))) ||
    (t.isObjectExpression(x) && x.properties.every((p) => t.isObjectProperty(p) && !p.computed && t.isFunctionExpression(p.value)));
  dropUnusedDecl(fnNode, name, inert);
}

// Hiç okunmayan bildirimi, başlangıç değeri inert() ise kaldır (kaldırmak gözlenebilir bir şeyi değiştirmez)
function dropUnusedDecl(fnNode, name, inert) {
  const body = t.isProgram(fnNode) ? fnNode.body : fnNode.body?.body;
  if (!Array.isArray(body)) return;
  let refs = 0;
  let found = null;
  walk(fnNode, (n) => {
    if (t.isVariableDeclaration(n)) for (const d of n.declarations) if (t.isIdentifier(d.id, { name })) found = { decl: n, d };
    if (t.isIdentifier(n, { name })) refs++;
  });
  if (!found || refs !== 1) return;
  const { decl, d } = found;
  if (!d.init || !inert(d.init)) return;
  decl.declarations.splice(decl.declarations.indexOf(d), 1);
  if (!decl.declarations.length) {
    const visitList = (list) => { const i = list.indexOf(decl); if (i >= 0) list.splice(i, 1); };
    walk(fnNode, (n) => { for (const k of ['body', 'consequent']) if (Array.isArray(n[k])) visitList(n[k]); });
  }
}

// Çevrilemeyen VM: döngüye neden ve case'lere komut adı/anlam açıklaması
function annotate(vm, a) {
  const loopNode = vm.stmtPath.node;
  t.addComment(loopNode, 'leading', `${NOTE} bytecode VM #${vm.id} | ${STYLE[vm.style]} | ${vm.handlers.length} handler | düz koda çevrilemedi: ${a.reason ?? 'bilinmiyor'}`, false);
  const byKey = new Map(a.handlers.map((h) => [String(h.key), h]));
  vm.handlers.forEach((h) => {
    const info = byKey.get(String(h.key));
    if (!info) return;
    const text = ` ${info.staticName ?? `OP_${h.key}`}${info.dynName && info.dynName !== info.staticName ? ` (iz: ${info.dynName})` : ''} — ${info.semantics}`;
    const target = vm.style === 'switch' ? h.node : vm.style === 'table' ? h.fn : h.node;
    t.addComment(target, 'leading', text.slice(0, 300), false);
  });
}

function serializable(a, extra) {
  const { lifter, lifted, ...rest } = a;
  return { ...rest, ...extra };
}

export async function run(ast, ctx) {
  const { onLog, bump, sandbox } = ctx;
  // obfuscator.io '2|0|1'.split('|') dağıtıcıları control-flow pass'inde birebir açılır
  const all = findVms(ast).filter((vm) => !hasNote(vm.stmtPath.node) && !hasNote(vm.loopPath.node) && !isStaticDispatcher(vm.loopPath));
  if (!all.length) return;
  // iç içe statik VM'lerde önce en içteki çevrilir; dıştaki bir sonraki turda yeniden analiz edilir
  const vms = all.filter((vm) => !all.some((o) => o !== vm && o.loopPath.findParent((x) => x === vm.loopPath)));
  vms.forEach((vm, i) => { vm.id = i; });

  for (const vm of vms) {
    const sv = stateVarsFor(vm);
    vm.stateVars = sv.stateVars;
    const scope = vm.loopPath.scope;
    const names = sv.stateVars.filter((n) => {
      const b = scope.getBinding(n);
      return b && (b.kind === 'var' || b.kind === 'param' || b.kind === 'hoisted') && !b.path.findParent((x) => x === vm.loopPath);
    });
    vm.capture = { names, arrays: [vm.roles.code, vm.roles.consts].filter(Boolean), sites: callSites(vm) };
  }

  let seen = {};
  let traces = {};
  if (sandbox) {
    const code = instrument(ast, vms);
    const r = await captureRun(sandbox, code);
    seen = r.seen;
    traces = r.trace;
  }

  const used = collectNames(ast);
  const program = ast.program;
  let lifted = 0;
  for (const vm of vms) {
    const depth = liftDepth(vm.loopPath) + 1;
    const sites = vm.capture.sites;
    const steps = traces[vm.id] ?? null;
    const plans = [];
    if (sites) {
      for (const site of sites) {
        const stat = staticValues(vm, vm.stateVars, site.path.node.arguments);
        const cap = decodeCapture(seen[`${vm.id}|${site.id}`]);
        plans.push({ site, values: mergeValues(stat, cap, vm.roles) });
      }
    } else {
      const stat = staticValues(vm, vm.stateVars, null);
      plans.push({ site: null, values: mergeValues(stat, decodeCapture(seen[`${vm.id}|*`]), vm.roles) });
    }

    // aynı bytecode'lu çağrı yerleri tek kopyayı paylaşır
    const groups = new Map();
    for (const p of plans) {
      const code = p.values.arrays.get(vm.roles.code);
      const key = code === undefined ? `?${groups.size}` : JSON.stringify([
        typeof code === 'string' ? code : code.map((x) => (x === HOLE ? '\u0000' : x)),
        [...p.values.state].map(([k, v]) => [k, v === undefined ? '\u0000u' : v]), p.values.stackInit,
        vm.roles.consts ? (p.values.arrays.get(vm.roles.consts) ?? []).map((x) => (x === HOLE ? '\u0000' : x)) : null,
      ]);
      if (!groups.has(key)) groups.set(key, { values: p.values, sites: [] });
      if (p.site) groups.get(key).sites.push(p.site);
    }

    const edits = [];
    const found = [];
    let firstAnalysis = null;
    for (const g of groups.values()) {
      const origin = {
        bytecode: g.values.arrays.has(vm.roles.code) ? (g.values.captured ? 'çalışma anında yakalandı' : 'statik') : 'bilinmiyor',
        source: sourceOf(vm, g.sites[0]),
        sites: g.sites.length,
        depth,
      };
      const a = analyzeVm(vm, g.values, { used, steps, origin });
      firstAnalysis = firstAnalysis ?? a;
      const rawSource = gen(vm.fnPath.isProgram() ? vm.stmtPath.node : vm.fnPath.node).slice(0, 20000);
      const finding = serializable(a, { lifted: false, verified: null, raw: rawHash(vm), rawSource, readable: readableInterpreter(rawSource, a.handlers) });
      found.push(finding);
      if (!a.ok) continue;
      t.addComment(a.lifted[0], 'leading', `${LIFT} | VM #${vm.id} | ${STYLE[vm.style]} | ${a.disasm.length} komut → ${a.blocksOut} blok | bytecode: ${origin.bytecode} | ham gövde: ${rawHash(vm)} | derinlik=${depth}`, false);
      edits.push({ a, sites: g.sites, origin, finding });
    }
    if (!edits.length) {
      ctx.findings?.vm?.push(...found);
      if (firstAnalysis) {
        annotate(vm, firstAnalysis);
        onLog(`vm-lift: VM #${vm.id} çevrilemedi (${firstAnalysis.reason}); handler'lar açıklandı`, 'warn');
      }
      continue;
    }
    const plan = makePlan(program, vm, edits, used, Boolean(sites));
    // E200/E659: VM'e özgü doğrulama — orijinal ve çevrilmiş program çalıştırılır, her VM çağrısının dönüş
    // değeri ve konsol çıktısı karşılaştırılır; fark varsa değişiklik uygulanmaz
    const verdict = sandbox ? await verifyPlan(sandbox, program, plan) : { ok: true, verified: null };
    for (const e of edits) e.finding.verified = verdict.verified;
    if (!verdict.ok) {
      for (const e of edits) e.finding.reason = `doğrulama başarısız: ${verdict.reason}`;
      ctx.findings?.vm?.push(...found);
      annotate(vm, { ...firstAnalysis, reason: `doğrulama başarısız: ${verdict.reason}` });
      onLog(`vm-lift: VM #${vm.id} çevrildi ama doğrulanamadı (${verdict.reason}), uygulanmadı`, 'warn');
      continue;
    }
    for (const e of edits) e.finding.lifted = true;
    ctx.findings?.vm?.push(...found);
    applyPlan(program, plan);
    lifted += edits.length;
    for (const e of edits) {
      onLog(`vm-lift: VM #${vm.id} (${STYLE[vm.style]}, ${e.a.disasm.length} komut, bytecode ${e.origin.bytecode}) düz koda çevrildi${verdict.verified ? ', çağrı dönüşleri doğrulandı' : ''}`, 'info');
    }
  }
  if (lifted) bump('vmLift', lifted);
}

function makePlan(program, vm, edits, used, siteMode) {
  const fnNode = vm.fnPath.isProgram() ? null : vm.fnPath.node;
  const fnKp = fnNode ? keyPath(program, fnNode) : null;
  const plan = { siteMode, regs: vm.roles.regs, table: vm.table, code: vm.roles.code, fnKp, fnName: fnNode?.id?.name ?? null, used };
  if (!siteMode) {
    plan.kp = keyPath(program, vm.stmtPath.node);
    plan.stmts = edits[0].a.lifted;
    return plan;
  }
  plan.clones = edits.map((e, gi) => {
    let name;
    let k = gi;
    do { name = `${fnNode.id.name}_vm${k++}`; } while (used.has(name));
    used.add(name);
    const clone = t.cloneNode(fnNode, true);
    clone.id = t.identifier(name);
    clone.leadingComments = null;
    clone.trailingComments = null;
    placeAt(clone, keyPath(fnNode, vm.stmtPath.node), e.a.lifted);
    return { name, node: clone, siteKps: e.sites.map((s) => keyPath(program, s.path.node)) };
  });
  return plan;
}

// root: gerçek program ya da doğrulama için kopyası
function applyPlan(root, plan) {
  const cleanup = (fn) => {
    if (plan.table) dropUnusedTable(fn, plan.table);
    scalarizeRegisters(fn, plan.regs, plan.used);
  };
  if (!plan.siteMode) {
    placeAt(root, plan.kp, plan.stmts.map((x) => t.cloneNode(x, true)));
    const fn = plan.fnKp ? follow(root, plan.fnKp) : root;
    cleanup(fn);
    // yerel bytecode bildirimi artık okunmuyorsa ve başlangıcı yan etkisizse kaldırılır
    dropUnusedDecl(fn, plan.code, (x) => t.isStringLiteral(x) || (t.isArrayExpression(x) && x.elements.every((e) => !e || t.isLiteral(e) ||
      (t.isUnaryExpression(e, { operator: '-' }) && t.isNumericLiteral(e.argument)))) ||
      (t.isCallExpression(x) && t.isMemberExpression(x.callee) && t.isStringLiteral(x.callee.object) &&
        t.isIdentifier(x.callee.property, { name: 'split' }) && !x.callee.computed && x.arguments.length === 1 && t.isStringLiteral(x.arguments[0])));
    return;
  }
  for (const c of plan.clones) for (const kp of c.siteKps) follow(root, kp).callee = t.identifier(c.name);
  const [k, i] = plan.fnKp[plan.fnKp.length - 1];
  const owner = follow(root, plan.fnKp.slice(0, -1));
  const clones = plan.clones.map((c) => t.cloneNode(c.node, true));
  owner[k].splice(i + 1, 0, ...clones);
  clones.forEach(cleanup);
  // orijinal yorumlayıcıya başka başvuru kalmadıysa kaldır
  const fnNode = owner[k][i];
  let refs = 0;
  walk(root, (n) => { if (t.isIdentifier(n, { name: plan.fnName }) && n !== fnNode.id) refs++; });
  let inner = 0;
  walk(fnNode.body, (n) => { if (t.isIdentifier(n, { name: plan.fnName })) inner++; });
  if (refs === inner) owner[k].splice(i, 1);
}

const RV_PRELUDE = `var __peelRvLog = [];
function __peelRv(i, v) {
  var s;
  try {
    s = v === null || (typeof v !== "object" && typeof v !== "function") ? typeof v + ":" + String(v)
      : typeof v === "function" ? "function" : Array.isArray(v) ? "array:" + JSON.stringify(v) : "object:" + JSON.stringify(v);
  } catch (e) { s = typeof v; }
  __peelRvLog.push(i + "=" + s);
  return v;
}`;

// VM fonksiyonunun (ya da kopyalarının) doğrudan çağrılarını __peelRv ile sar
function wrapCalls(root, names) {
  let i = 0;
  const done = new WeakSet();
  walk(root, (n) => {
    if (!t.isCallExpression(n) || done.has(n) || !t.isIdentifier(n.callee) || !names.has(n.callee.name)) return;
    const inner = t.callExpression(n.callee, n.arguments);
    done.add(inner);
    n.callee = t.identifier('__peelRv');
    n.arguments = [t.numericLiteral(i++), inner];
  });
}

async function verifyPlan(sandbox, program, plan) {
  const orig = t.cloneNode(program, true);
  const cand = t.cloneNode(program, true);
  applyPlan(cand, { ...plan, used: new Set(plan.used) });
  if (plan.fnName) {
    wrapCalls(orig, new Set([plan.fnName]));
    wrapCalls(cand, new Set([plan.fnName, ...(plan.clones ?? []).map((c) => c.name)]));
  }
  const runOne = async (prog) => {
    const r = await sandbox.run(`${RV_PRELUDE}\ntry {\n${gen(prog)}\n} catch (e) { __out.push("!THROW " + (e && e.message)); }\n__res.push(__peelRvLog);`, { timeoutMs: 6000 });
    return { ok: r.ok, out: r.out ?? [], rv: r.res?.[0] ?? [] };
  };
  const a = await runOne(orig);
  const b = await runOne(cand);
  // orijinal tamamlanmıyorsa karşılaştırma yapılamaz: genel derin doğrulamaya bırakılır
  if (!a.ok) return { ok: true, verified: null, reason: 'orijinal program sandbox\'ta tamamlanmadı' };
  if (!b.ok) return { ok: false, verified: false, reason: 'çevrilmiş program tamamlanmadı' };
  if (JSON.stringify(a.out) !== JSON.stringify(b.out)) return { ok: false, verified: false, reason: 'konsol çıktısı farklı' };
  if (JSON.stringify(a.rv) !== JSON.stringify(b.rv)) return { ok: false, verified: false, reason: 'VM dönüş değerleri farklı' };
  return { ok: true, verified: true, calls: a.rv.length };
}

function sourceOf(vm, site) {
  const b = vm.loopPath.scope.getBinding(vm.roles.code);
  if (site && b?.kind === 'param') {
    const i = vm.fnPath.node.params.findIndex((p) => t.isIdentifier(p, { name: vm.roles.code }));
    const arg = site.path.node.arguments[i];
    return arg ? gen(arg).slice(0, 200) : null;
  }
  if (b?.path.isVariableDeclarator() && b.path.node.init) return gen(b.path.node.init).slice(0, 200);
  return null;
}

// Ham yorumlayıcının (döngü + handler'lar) özeti: rapordaki ham gövdeyle eşleştirme (E182)
function rawHash(vm) {
  return fnv1a(gen(vm.loopPath.node));
}

