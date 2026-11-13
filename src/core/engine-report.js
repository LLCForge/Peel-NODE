import * as t from '@babel/types';
import { parse } from './parse.js';
import { traverse, gen } from '../util/ast.js';
import { analyzeStringArray } from './obfio.js';
import { findIntegrityChecks } from '../passes/24-integrity.js';
import { splitBundle } from './bundle.js';

// Çözme motorunun analiz çıktıları (rapor):
//  A-2  obfuscator.io ayarlarını girdiden geri çıkarma       A-24 paket → modüller
//  E173 yineleme (özyineleme) tanıma   E174 çözülemeyen durum makineleri için Mermaid/DOT   E175 akış raporu
//  E204 console tespiti   E205/E207 bütünlük kontrolü tespiti ve raporu   E220 ölü kod türleri

const safeParse = (code) => { try { return parse(code); } catch { return null; } };

// ── A-2: obfuscator.io ayarları ─────────────────────────

const CONSOLE_METHODS = ['log', 'warn', 'info', 'error', 'exception', 'table', 'trace'];
const GUARD_STRINGS = ['(((.+)+)+)+$', 'function *\\( *\\)', '\\+\\+ *(?:[a-zA-Z_$][0-9a-zA-Z_$]*)'];

export function obfuscatorSettings(text, output) {
  const ast = safeParse(text);
  if (!ast) return null;
  const sa = analyzeStringArray(ast);
  const settings = {};
  const evidence = [];
  let hexIds = 0;
  let shortIds = 0;
  let ids = 0;
  let numberExprs = 0;
  let splitStrings = 0;
  let splitChunk = 0;
  let deadBranches = 0;
  let dispatchers = 0;
  let objectKeyBuilders = 0;
  let decoderCalls = 0;
  let plainStrings = 0;
  const wrappers = { function: 0, variable: 0 };
  const numericLeaves = (n) => (t.isNumericLiteral(n) ? 1 : t.isUnaryExpression(n, { operator: '-' }) ? numericLeaves(n.argument)
    : t.isBinaryExpression(n) && ['+', '-', '*'].includes(n.operator) ? (numericLeaves(n.left) && numericLeaves(n.right) ? numericLeaves(n.left) + numericLeaves(n.right) : 0) : 0);
  const decoder = sa?.decoder.name;
  // dizi/decoder/rotasyon düzeneğinin kendi string'leri ve çağrıları eşik oranına girmez (rotasyon ifadesindeki
  // decoder çağrısı sayısı rastgele: oran her obfuscate çalıştırmasında oynuyordu)
  const machinery = (p) => Boolean(sa) && Boolean(p.findParent((x) => (sa.rotator && x.node === sa.rotator.stmt) ||
    (x.isFunctionDeclaration() && x.node.id && [sa.decoder.name, sa.holder.name].includes(x.node.id.name))));
  traverse(ast, {
    Identifier(p) {
      if (!p.isBindingIdentifier()) return;
      ids++;
      if (/^_0x[0-9a-f]{4,6}$/i.test(p.node.name)) hexIds++;
      else if (/^[a-zA-Z_$][a-zA-Z0-9_$]?$/.test(p.node.name)) shortIds++;
    },
    BinaryExpression(p) {
      if (!p.parentPath.isBinaryExpression() && numericLeaves(p.node) >= 3) numberExprs++;
      // parçalar literal ya da (base64/rc4 kodlamada diziye taşınmış) literal argümanlı decoder çağrısı olabilir
      const part = (x) => (t.isStringLiteral(x) && x.value.length <= 10) ||
        (t.isCallExpression(x) && t.isIdentifier(x.callee) && x.arguments.length > 0 && x.arguments.every((a) => t.isLiteral(a)));
      if (p.node.operator === '+' && part(p.node.left) && part(p.node.right) &&
          (t.isStringLiteral(p.node.left) || t.isStringLiteral(p.node.right) || decoder)) {
        splitStrings++;
        for (const x of [p.node.left, p.node.right]) if (t.isStringLiteral(x)) splitChunk = Math.max(splitChunk, x.value.length);
      }
    },
    IfStatement(p) {
      const test = p.node.test;
      // iki sabit (literal ya da literal argümanlı decoder/sarmalayıcı çağrısı) karşılaştırması; operatör proxy'si üzerinden de olabilir
      const lit = (x) => t.isStringLiteral(x) || (t.isCallExpression(x) && x.arguments.length > 0 && x.arguments.every((a) => t.isLiteral(a)));
      const viaProxy = t.isCallExpression(test) && t.isMemberExpression(test.callee) && test.arguments.length === 2 && test.arguments.every(lit);
      if ((t.isBinaryExpression(test) && ['===', '!=='].includes(test.operator) && lit(test.left) && lit(test.right)) || viaProxy) deadBranches++;
    },
    SwitchStatement(p) {
      // while (!![]) { switch (o[i++]) { … } }: obfuscator.io kontrol akışı düzleştirme
      const d = p.node.discriminant;
      if (t.isMemberExpression(d) && d.computed && t.isUpdateExpression(d.property, { operator: '++' }) && p.findParent((x) => x.isLoop())) dispatchers++;
    },
    CallExpression(p) {
      const c = p.node.callee;
      if (decoder && t.isIdentifier(c) && !machinery(p)) {
        const b = p.scope.getBinding(c.name);
        if (c.name === decoder || (b?.path.isVariableDeclarator() && t.isIdentifier(b.path.node.init, { name: decoder }))) decoderCalls++;
      }
    },
    StringLiteral(p) {
      if (p.parentPath.isObjectProperty({ key: p.node }) || p.parentPath.isArrayExpression() || p.parentPath.isMemberExpression({ property: p.node })) return;
      if (p.parentPath.isCallExpression() && decoder) return;
      if (machinery(p)) return;
      plainStrings++;
    },
    VariableDeclarator(p) {
      if (decoder && t.isIdentifier(p.node.init, { name: decoder }) && t.isIdentifier(p.node.id)) wrappers.variable++;
      if (t.isObjectExpression(p.node.init) && !p.node.init.properties.length && Array.isArray(p.parentPath.container)) {
        const next = p.parentPath.container[p.parentPath.key + 1];
        if (t.isExpressionStatement(next) && t.isAssignmentExpression(next.expression) && t.isMemberExpression(next.expression.left) &&
            t.isIdentifier(next.expression.left.object, { name: p.node.id.name })) objectKeyBuilders++;
      }
    },
    FunctionDeclaration(p) {
      const body = p.node.body.body;
      if (decoder && body.length === 1 && t.isReturnStatement(body[0]) && t.isCallExpression(body[0].argument) &&
          t.isIdentifier(body[0].argument.callee, { name: decoder })) wrappers.function++;
    },
  });
  const all = `${text}\n${output ?? ''}`;
  if (sa) {
    settings.stringArray = true;
    settings.stringArrayEncoding = sa.decoder.encoding;
    settings.rotateStringArray = Boolean(sa.rotator);
    settings.stringArrayIndexShift = sa.decoder.offset !== 0;
    settings.stringArrayIndexOffset = sa.decoder.offset;
    if (sa.rotator) settings.stringArrayRotations = sa.rotations;
    settings.stringArrayThreshold = Math.round((decoderCalls / Math.max(1, decoderCalls + plainStrings)) * 20) / 20;
    settings.stringArrayWrappersCount = wrappers.function + wrappers.variable;
    settings.stringArrayWrappersType = wrappers.function > wrappers.variable ? 'function' : 'variable';
    evidence.push(`dizi ${sa.holder.name} (${sa.holder.strings.length} öğe), decoder ${sa.decoder.name}`);
  }
  settings.identifierNamesGenerator = hexIds > ids / 4 ? 'hexadecimal' : shortIds > ids / 2 ? 'mangled' : 'unknown';
  settings.controlFlowFlattening = dispatchers > 0;
  if (dispatchers) evidence.push(`${dispatchers} sıra dizili switch dispatcher`);
  settings.deadCodeInjection = deadBranches > 0;
  if (deadBranches) evidence.push(`${deadBranches} sabit karşılaştırmalı ölü dal`);
  settings.numbersToExpressions = numberExprs >= 3;
  settings.splitStrings = splitStrings >= 3;
  if (settings.splitStrings && splitChunk) settings.splitStringsChunkLength = splitChunk;
  settings.transformObjectKeys = objectKeyBuilders > 0;
  // koruma regex'i diziye taşınıp kodlanmış olabilir: tek seferlik çağrı denetleyicisi (h=!![] … return h=![],k)
  // ve toString().search('\n') denetimi de selfDefending kalıbıdır
  settings.selfDefending = GUARD_STRINGS.some((g) => all.includes(g)) ||
    (/return\s+\w+\s*=\s*!\[\]\s*,\s*\w+;?\s*\}/.test(text) && /'\\x0a'\)\s*!==\s*-0x1/.test(text));
  settings.debugProtection = /debugger|["']debu["']\s*\+\s*["']gger["']/.test(all) && /constructor/.test(all);
  settings.debugProtectionInterval = settings.debugProtection && /setInterval/.test(all);
  settings.disableConsoleOutput = CONSOLE_METHODS.every((m) => new RegExp(`["']${m}["']`).test(all));
  const escapes = (text.match(/\\x[0-9a-f]{2}/gi) ?? []).length;
  settings.unicodeEscapeSequence = escapes > 50 && escapes > text.length / 40;
  settings.compact = text.split('\n').length <= 3 && text.length > 300;
  const detected = Boolean(sa) || hexIds > 10 || dispatchers > 0;
  return detected ? { settings, evidence } : null;
}

// ── E173 / E174 / E175: akış raporu ─────────────────────

const BRANCHES = new Set(['IfStatement', 'ConditionalExpression', 'ForStatement', 'ForInStatement', 'ForOfStatement',
  'WhileStatement', 'DoWhileStatement', 'CatchClause']);

function fnName(p) {
  if (p.node.id) return p.node.id.name;
  if (p.parentPath.isVariableDeclarator() && t.isIdentifier(p.parent.id)) return p.parent.id.name;
  if ((p.parentPath.isObjectProperty() || p.isObjectMethod() || p.isClassMethod()) && t.isIdentifier((p.isObjectMethod() || p.isClassMethod() ? p.node : p.parent).key)) {
    return (p.isObjectMethod() || p.isClassMethod() ? p.node : p.parent).key.name;
  }
  return null;
}

// Tarjan: güçlü bağlı bileşenler
function sccs(graph) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const stack = [];
  const on = new Set();
  const out = [];
  const visit = (v) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
      out.push(comp);
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return out;
}

// Döngü + switch biçimli, açılamamış durum makinesinin geçiş grafiği
function machineGraph(p) {
  const loop = p.node;
  const body = t.isBlockStatement(loop.body) ? loop.body.body : [loop.body];
  const sw = body.find((s) => t.isSwitchStatement(s));
  if (!sw || sw.cases.length < 3) return null;
  const d = sw.discriminant;
  const names = new Set();
  t.traverseFast(d, (n) => { if (t.isIdentifier(n)) names.add(n.name); });
  if (t.isMemberExpression(d) && t.isIdentifier(d.object)) names.clear();
  const single = t.isIdentifier(d) ? d.name : null;
  // durum en az bir case içinde yazılmalı (aksi halde sıradan bir switch)
  const writes = (n) => t.isAssignmentExpression(n) && t.isIdentifier(n.left) && names.has(n.left.name) ||
    t.isUpdateExpression(n) && t.isIdentifier(n.argument) && names.has(n.argument.name);
  let any = false;
  for (const c of sw.cases) for (const s of c.consequent) t.traverseFast(s, (n) => { if (writes(n)) any = true; });
  if (!any && !t.isMemberExpression(d)) return null;
  const label = (c) => (c.test ? gen(c.test) : 'default');
  const nodes = sw.cases.map(label);
  const edges = [];
  for (const c of sw.cases) {
    const from = label(c);
    const targets = new Set();
    let exits = false;
    for (const s of c.consequent) {
      t.traverseFast(s, (n) => {
        if (t.isReturnStatement(n) || t.isThrowStatement(n)) exits = true;
        if (!writes(n)) return;
        if (t.isUpdateExpression(n)) {
          if (single && t.isNumericLiteral(c.test)) targets.add(String(c.test.value + (n.operator === '++' ? 1 : -1))); else targets.add('?');
          return;
        }
        const rhs = n.right;
        const lits = t.isConditionalExpression(rhs) ? [rhs.consequent, rhs.alternate] : [rhs];
        for (const r of lits) {
          if (n.operator === '=' && (t.isNumericLiteral(r) || t.isStringLiteral(r))) targets.add(gen(r));
          else if (single && t.isNumericLiteral(c.test) && t.isNumericLiteral(r) && ['+=', '-='].includes(n.operator)) {
            targets.add(String(n.operator === '+=' ? c.test.value + r.value : c.test.value - r.value));
          } else targets.add('?');
        }
      });
    }
    for (const to of targets) edges.push([from, to]);
    if (exits) edges.push([from, 'çıkış']);
  }
  const id = (s) => `s_${s.replace(/[^\w]/g, (ch) => `_${ch.charCodeAt(0).toString(16)}`)}`;
  const all = [...new Set([...nodes, ...edges.flat()])];
  const mermaid = ['flowchart TD', ...all.map((s) => `  ${id(s)}["${s.replace(/"/g, '#quot;')}"]`), ...edges.map(([a, b]) => `  ${id(a)} --> ${id(b)}`)].join('\n');
  const dot = ['digraph peel {', ...all.map((s) => `  ${JSON.stringify(s)};`), ...edges.map(([a, b]) => `  ${JSON.stringify(a)} -> ${JSON.stringify(b)};`), '}'].join('\n');
  const fn = p.getFunctionParent();
  return { function: fn ? fnName(fn) ?? '(anonim)' : '(program)', discriminant: gen(d).slice(0, 80), states: nodes.length, edges: edges.length, mermaid, dot };
}

function countMachines(ast) {
  let n = 0;
  traverse(ast, {
    'WhileStatement|DoWhileStatement|ForStatement'(p) { if (machineGraph(p)) n++; },
  });
  return n;
}

export function flowReport(text, output) {
  const ast = safeParse(output);
  if (!ast) return null;
  const before = safeParse(text);
  const functions = [];
  const graph = new Map();
  const nameOf = new Map();
  let loops = 0;
  let maxDepth = 0;
  const unresolved = [];
  traverse(ast, {
    Function(p) {
      const name = fnName(p) ?? `(anonim@${p.node.loc?.start.line ?? '?'})`;
      let cyclomatic = 1;
      p.traverse({
        Function(q) { q.skip(); },
        enter(q) {
          if (BRANCHES.has(q.node.type)) cyclomatic++;
          if (q.isSwitchCase() && q.node.test) cyclomatic++;
          if (q.isLogicalExpression() && q.node.operator !== '??') cyclomatic++;
        },
      });
      functions.push({ name, cyclomatic, line: p.node.loc?.start.line ?? null });
      // çağrı grafiği yalnızca bağlamaya çözülen adlandırılmış fonksiyonlar için
      const binding = p.isFunctionDeclaration() && p.node.id ? p.parentPath.scope.getBinding(p.node.id.name)
        : p.parentPath.isVariableDeclarator() && t.isIdentifier(p.parent.id) ? p.parentPath.scope.getBinding(p.parent.id.name) : null;
      if (binding) nameOf.set(binding, name);
    },
    Loop(p) {
      loops++;
      let depth = 0;
      for (let q = p; q; q = q.parentPath) { if (q.isFunction()) break; if (q.isLoop() || q.isIfStatement() || q.isSwitchStatement() || q.isTryStatement()) depth++; }
      maxDepth = Math.max(maxDepth, depth);
      if ((p.isWhileStatement() || p.isDoWhileStatement() || p.isForStatement()) && unresolved.length < 20) {
        const g = machineGraph(p);
        if (g) unresolved.push(g);
      }
    },
  });
  // E173: çağrı kenarları (fonksiyon gövdesi → çağrılan adlandırılmış fonksiyon)
  traverse(ast, {
    CallExpression(p) {
      if (!t.isIdentifier(p.node.callee)) return;
      const callee = p.scope.getBinding(p.node.callee.name);
      if (!callee || !nameOf.has(callee)) return;
      let fn = p.getFunctionParent();
      while (fn) {
        const b = fn.isFunctionDeclaration() && fn.node.id ? fn.parentPath.scope.getBinding(fn.node.id.name)
          : fn.parentPath.isVariableDeclarator() && t.isIdentifier(fn.parent.id) ? fn.parentPath.scope.getBinding(fn.parent.id.name) : null;
        if (b && nameOf.has(b)) {
          if (!graph.has(b)) graph.set(b, new Set());
          graph.get(b).add(callee);
          break;
        }
        fn = fn.getFunctionParent();
      }
    },
  });
  for (const b of nameOf.keys()) if (!graph.has(b)) graph.set(b, new Set());
  const recursion = sccs(graph)
    .filter((c) => c.length > 1 || graph.get(c[0])?.has(c[0]))
    .map((c) => ({ kind: c.length > 1 ? 'mutual' : 'direct', functions: c.map((b) => nameOf.get(b)) }));
  const complexity = functions.reduce((a, f) => a + f.cyclomatic, 0);
  return {
    functions: functions.length,
    loops,
    maxDepth,
    complexity,
    mostComplex: [...functions].sort((a, b) => b.cyclomatic - a.cyclomatic).slice(0, 10),
    dispatchersBefore: before ? countMachines(before) : null,
    dispatchersAfter: unresolved.length,
    recursion,
    unresolved,
  };
}

// ── E204 / E205 / E207: bütünlük ve konsol ──────────────

export function integrityReport(text, output, stats = {}) {
  const ast = safeParse(text);
  const out = safeParse(output);
  const checks = ast ? findIntegrityChecks(ast).map((c) => ({
    kind: 'hash', function: c.inFunction, hasher: c.hasher, protects: c.protects, expected: c.expected,
  })) : [];
  const all = `${text}\n${output}`;
  if (GUARD_STRINGS.some((g) => all.includes(g))) checks.push({ kind: 'selfDefending', function: null, hasher: 'RegExp', protects: 'kaynak biçimi', expected: null });
  const remaining = out ? findIntegrityChecks(out).length : 0;
  const consoleFindings = [];
  const scan = (tree, where) => {
    if (!tree) return;
    traverse(tree, {
      ArrayExpression(p) {
        const vals = p.node.elements.filter((e) => t.isStringLiteral(e)).map((e) => e.value);
        if (CONSOLE_METHODS.filter((m) => vals.includes(m)).length >= 5) consoleFindings.push({ kind: 'disableConsoleOutput', where, detail: 'console metotları dizisi' });
      },
      AssignmentExpression(p) {
        const l = p.node.left;
        if (t.isMemberExpression(l) && t.isIdentifier(l.object, { name: 'console' }) && !p.scope.getBinding('console')) {
          consoleFindings.push({ kind: 'consoleOverride', where, detail: gen(l).slice(0, 60) });
        }
      },
      CallExpression(p) {
        const c = p.node.callee;
        if (!t.isMemberExpression(c) || !t.isIdentifier(c.object, { name: 'console' }) || p.scope.getBinding('console')) return;
        const m = c.computed ? (t.isStringLiteral(c.property) ? c.property.value : null) : c.property.name;
        if (m === 'clear' && p.findParent((x) => x.isLoop() || (x.isCallExpression() && /setInterval|setTimeout/.test(gen(x.node.callee))))) {
          consoleFindings.push({ kind: 'consoleClearLoop', where, detail: 'döngü/zamanlayıcıda console.clear' });
        }
        // devtools tespiti: getter tanımlı nesneyi (ya da toString'i değiştirilmiş nesneyi) loglamak
        if (['log', 'dir', 'debug', 'table'].includes(m) && p.node.arguments.some((a) => t.isIdentifier(a))) {
          const fnPath = p.getFunctionParent() ?? p.scope.getProgramParent().path;
          const src = gen(fnPath.node);
          if (/defineProperty\([^)]*["']id["']\s*,\s*\{\s*get/.test(src) || /\.toString\s*=\s*function/.test(src)) {
            consoleFindings.push({ kind: 'devtoolsProbe', where, detail: 'getter/toString tuzaklı nesne loglanıyor' });
          }
        }
        if (['profile', 'profileEnd'].includes(m)) consoleFindings.push({ kind: 'consoleProfile', where, detail: `console.${m}` });
      },
    });
  };
  scan(ast, 'girdi');
  scan(out, 'çıktı');
  const seen = new Set();
  return {
    checks,
    neutralized: stats.integrity ?? 0,
    remaining,
    console: consoleFindings.filter((f) => { const k = `${f.kind}|${f.where}|${f.detail}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 50),
  };
}

// ── E220: ölü kod türleri ───────────────────────────────

export function deadCodeReport(stats = {}) {
  return Object.entries(stats)
    .filter(([k, v]) => k.startsWith('dead.') && v > 0)
    .map(([k, count]) => ({ type: k.slice(5), count }))
    .sort((a, b) => b.count - a.count);
}

// ── giriş ───────────────────────────────────────────────

export function engineReport({ input, text, output, stats = null }) {
  const src = text ?? input;
  // çözülmüş çıktı daha okunur; harita konumları ise yalnızca orijinal metinde geçerli
  const bundle = splitBundle(output, { map: false }) ?? splitBundle(src);
  return {
    obfuscator: obfuscatorSettings(src, output),
    flow: flowReport(src, output),
    integrity: integrityReport(src, output, stats ?? {}),
    deadCode: stats ? deadCodeReport(stats) : null,
    bundle: bundle && { kind: bundle.kind, modules: bundle.modules },
  };
}
