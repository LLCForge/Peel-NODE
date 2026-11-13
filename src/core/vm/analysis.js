import * as t from '@babel/types';
import { gen } from '../../util/ast.js';
import { fnv1a } from '../../util/hash.js';
import { vmSummary, walk } from './detect.js';
import { HOLE, Unsupported } from './interp.js';
import {
  makeLifter, initialState, explore, codegen, disassemble, formatDisasm, lowerIR, basicBlocks,
  handlerSemantics, instanceSemantics,
} from './lift.js';
import {
  nameFromSemantics, semanticsText, dynamicNames, agrees, shapeOf, clusterHandlers, signature,
  isaOf, toAssembly, hostCalls,
} from './semantics.js';

// Tek bir bytecode VM'in tam analizi: düzen, handler anlamları ve adları, disassembly, IR,
// segmentasyon, döngüler, çıkışlar ve (mümkünse) düz koda çevrilmiş hali.
// Sonuç serileştirilebilir (rapor) + lifted: AST deyimleri (pass için).

const caseLists = (vm) => {
  if (vm.style === 'switch') return vm.dispatch.cases.map((c, i) => vm.dispatch.cases.slice(i).flatMap((x) => x.consequent));
  if (vm.style === 'if-chain') return vm.handlers.map((h) => (t.isBlockStatement(h.node) ? h.node.body : [h.node]));
  return vm.handlers.map((h) => h.fn.body.body);
};

const show = (v) => (v === HOLE ? '‹nesne›' : v === undefined ? 'undefined' : JSON.stringify(v));

export function stateVarsFor(vm) {
  try {
    const L = makeLifter(vm, { arrays: new Map([[vm.roles.code, []]]), state: new Map() }, { mode: 'sem' });
    return { ok: true, stateVars: [...L.stateVars], L };
  } catch (e) {
    if (e instanceof Unsupported) return { ok: false, reason: e.message, stateVars: [vm.roles.pc] };
    throw e;
  }
}

export function analyzeVm(vm, values, { used = new Set(), steps = null, origin = {} } = {}) {
  const base = vmSummary(vm);
  const lists = caseLists(vm);
  const ctx = { consts: vm.roles.consts, regs: vm.roles.regs };
  const handlers = vm.handlers.map((h, i) => {
    const sem = handlerSemantics(vm, values, h);
    return { key: h.key, index: i, shape: shapeOf(lists[i], vm.roles), sem, source: lists[i].length ? gen(t.blockStatement(ownStmts(lists[i]))).slice(0, 600) : '' };
  });
  const result = {
    ...base,
    dispatch: { style: vm.style, loop: vm.kind, fetch: gen(vm.fetchExpr), test: vm.test ? gen(vm.test) : null },
    origin,
    ok: false,
    reason: null,
  };

  const code = values.arrays?.get(vm.roles.code);
  let L = null;
  let ex = null;
  if (code !== undefined) {
    try {
      L = makeLifter(vm, values, { used });
      ex = explore(L, initialState(L));
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      result.reason = e.message;
    }
  } else {
    result.reason = 'bytecode değeri bilinmiyor';
  }

  // adlar: genel anlamdan, olmazsa keşifteki ilk örnekten
  for (const h of handlers) {
    if (!h.sem.ok && ex) {
      const inst = ex.order.find((x) => x.op === h.key || String(x.op) === String(h.key));
      if (inst) h.sem = instanceSemantics(L, inst);
    }
    h.semText = semanticsText(h.sem);
    h.staticName = nameFromSemantics(h.sem, ctx);
  }
  const names = new Map(handlers.map((h) => [h.key, h.staticName ?? `OP_${h.key}`]));

  if (ex) {
    const dis = disassemble(L, ex, names);
    const consts = vm.roles.consts ? values.arrays.get(vm.roles.consts) : null;
    const isa = isaOf(dis, names);
    const rawAt = (i) => (typeof code === 'string' ? code.charCodeAt(i) : code[i]);
    // opcode bytecode'da kodlanmış olabilir (ör. XOR): ham değer ↔ çözülmüş opcode eşlemesi assembler için
    result.disasm = dis.list.map((x) => ({ ...x, raw: rawAt(x.reads[0]), mnemonic: isa.mnemonic.get(x.op) ?? x.mnemonic }));
    result.opcodeMap = [...new Map(result.disasm.map((x) => [x.op, x.raw]))].map(([op, raw]) => ({ op, raw }));
    result.gaps = dis.gaps;
    // sabit havuzu açıklaması yalnızca işlenenini sabit havuzunda kullanan handler'lar için
    const constOps = new Set(handlers.filter((h) => vm.roles.consts && h.semText.includes(`${vm.roles.consts}[#`)).map((h) => String(h.key)));
    result.listing = formatDisasm({ ...dis, list: result.disasm }, (x) => (constOps.has(String(x.op)) ? constComment(x, consts) : null));
    result.assembly = toAssembly(dis, code, isa);
    result.isa = [...isa.mnemonic].map(([op, mn]) => ({ op, mnemonic: mn, operands: isa.operands.get(op) ?? null }));
    result.alphabet = [...new Set(dis.list.map((x) => x.op))].sort((a, b) => (a > b ? 1 : -1));
    result.ir = lowerIR(L, ex, names).map((x) => ({ ...x, mnemonic: isa.mnemonic.get(x.op) ?? x.mnemonic }));
    result.blocks = basicBlocks(ex);
    result.loops = backEdges(ex);
    result.exits = exitsOf(ex, handlers);
    result.maxDepth = Math.max(0, ...ex.order.map((x) => x.depth));
    result.states = ex.order.length;
    // gözlenen/kapsanan pc'ler ve hiç çalışmayan handler'lar
    const reached = new Set(dis.list.map((x) => String(x.op)));
    result.unusedHandlers = handlers.filter((h) => h.key !== 'default' && !reached.has(String(h.key))).map((h) => h.key);
    try {
      const cg = codegen(L, ex);
      result.ok = true;
      result.blocksOut = cg.blocks.length;
      result.single = cg.single;
      result.lifted = cg.stmts;
      result.liftedCode = cg.stmts.map((s) => gen(s)).join('\n');
      const params = vm.fnPath.isProgram() ? [] : vm.fnPath.node.params.filter((p) => t.isIdentifier(p)).map((p) => p.name);
      result.hostCalls = hostCalls(cg.stmts, { globals: new Set(params), programFns: programFunctions(vm), constArrays: new Map(consts ? [[vm.roles.consts, consts]] : []) });
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      result.reason = e.message;
    }
    result.registers = L.regsSeen.size ? { count: Math.max(...[...L.regsSeen].map(Number).filter(Number.isFinite)) + 1, used: [...L.regsSeen].sort((a, b) => a - b) } : { count: 0, used: [] };
    result.constPool = consts ? (typeof consts === 'string' ? [...consts] : consts).map((v, i) => ({ i, value: show(v) })) : [];
    result.codeLength = code.length;
    result.codeKind = typeof code === 'string' ? 'string' : 'array';
    result.bytecode = typeof code === 'string' ? code : code.map((v) => (v === HOLE ? null : v));
  }

  // dinamik ad ve iz (sandbox)
  if (steps?.length && result.disasm) {
    const dyn = dynamicNames(steps, { list: result.disasm });
    for (const h of handlers) {
      const d = dyn.get(h.key) ?? dyn.get(Number(h.key));
      if (!d) continue;
      h.dynName = d.name;
      h.dynCount = d.count;
      h.dynDeltas = d.deltas;
      h.agree = agrees(h.staticName, d.name);
    }
    const byPc = new Map(result.disasm.map((x) => [x.pc, x]));
    result.trace = steps.slice(0, 5000).map(([pc, depth, top, regs]) => ({ pc, depth, top, regs, mnemonic: byPc.get(pc)?.mnemonic ?? '?' }));
    result.coverage = { executed: new Set(steps.map((s) => s[0])).size, total: result.disasm.length };
  }

  result.handlers = handlers.map((h) => ({
    key: h.key, staticName: h.staticName, dynName: h.dynName ?? null, agree: h.agree ?? null, dynCount: h.dynCount ?? 0,
    semantics: h.semText, generic: h.sem.generic ?? null, shapeHash: fnv1a(h.shape), source: h.source,
  }));
  result.clusters = clusterHandlers(handlers);
  result.signature = signature(handlers);
  result.layout = layoutOf(vm, result, values);
  result.lifter = L;
  return result;
}

function ownStmts(list) {
  const own = [];
  for (const s of list) {
    own.push(s);
    if (t.isBreakStatement(s) || t.isReturnStatement(s) || t.isThrowStatement(s) || t.isContinueStatement(s)) break;
  }
  return own;
}

function constComment(x, consts) {
  if (!consts || !x.operands.length) return null;
  const vals = x.operands.filter((o) => Number.isInteger(o) && o >= 0 && o < consts.length).map((o) => show(consts[o]));
  return vals.length ? `K → ${vals.join(', ')}` : null;
}

function programFunctions(vm) {
  const names = new Set();
  const prog = vm.loopPath.findParent((p) => p.isProgram());
  walk(prog.node, (n) => {
    if (t.isFunctionDeclaration(n) && n.id) names.add(n.id.name);
    if (t.isVariableDeclarator(n) && t.isIdentifier(n.id) && t.isFunction(n.init)) names.add(n.id.name);
  });
  return names;
}

// E645: bytecode düzeyinde geri kenarlar (hedef pc ≤ kaynak pc) = döngü başları
function backEdges(ex) {
  const pcOf = new Map(ex.order.map((i) => [i.key, i.pc]));
  const loops = [];
  for (const info of ex.order) {
    for (const k of info.succ) {
      const to = pcOf.get(k);
      if (typeof to === 'number' && typeof info.pc === 'number' && to <= info.pc) loops.push({ head: to, latch: info.pc });
    }
  }
  return loops;
}

// E646: VM döngüsünden çıkış yolları
function exitsOf(ex, handlers) {
  const out = [];
  for (const info of ex.order) {
    for (const end of new Set(info.ends)) {
      if (end === 'exit') out.push({ pc: info.pc, kind: info.pc === undefined ? 'koşul' : 'döngü koşulu / halt' });
      if (end === 'ret') out.push({ pc: info.pc, kind: 'return/throw' });
    }
  }
  const halts = handlers.filter((h) => ['HALT', 'RET', 'RET_VOID', 'RET_EXPR', 'THROW'].includes(h.staticName)).map((h) => `${h.key}:${h.staticName}`);
  return { paths: out.slice(0, 100), handlers: halts };
}

// E641/E642/E643/E648: bellek düzeni
function layoutOf(vm, r, values) {
  const roles = vm.roles;
  const parts = [];
  if (roles.code) parts.push({ role: 'bytecode', name: roles.code, detail: r.codeLength !== undefined ? `${r.codeKind}, ${r.codeLength} öğe` : 'bilinmiyor' });
  if (roles.pc) parts.push({ role: 'pc', name: roles.pc, detail: `başlangıç ${values.state?.get(roles.pc) ?? '?'}` });
  if (roles.op) parts.push({ role: 'opcode', name: roles.op, detail: '' });
  if (roles.stack) parts.push({ role: 'yığın', name: roles.stack, detail: `en fazla ${r.maxDepth ?? '?'} derinlik${roles.sp ? `, işaretçi ${roles.sp}` : ''}` });
  if (roles.regs) parts.push({ role: 'register', name: roles.regs, detail: `${r.registers?.count ?? '?'} register` });
  if (roles.consts) parts.push({ role: 'sabit havuzu', name: roles.consts, detail: `${r.constPool?.length ?? '?'} sabit` });
  return parts;
}
