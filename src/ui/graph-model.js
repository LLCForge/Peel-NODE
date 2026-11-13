import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { functionLabel, lineOf } from './code-intel.js';

// Görselleştirme modelleri: çağrı, kontrol akışı, veri akışı, bağımlılık ve durum makinesi grafikleri.
// Grafik biçimi: { nodes: [{id, label, kind, start?, end?, docId?}], edges: [{from, to, label?}] }

const MAX_NODES = 20_000;
const short = (s, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const calleeName = (c) => {
  if (t.isIdentifier(c)) return c.name;
  if (t.isMemberExpression(c) || t.isOptionalMemberExpression(c)) {
    const obj = calleeName(c.object) ?? (t.isThisExpression(c.object) ? 'this' : '…');
    const prop = c.computed ? (t.isStringLiteral(c.property) ? c.property.value : '[]') : c.property.name;
    return `${obj}.${prop}`;
  }
  return null;
};

/** Çağrı grafiği: fonksiyonlar ve dış API'ler; kenar = çağıran → çağrılan */
export function callGraph(ast, code) {
  const nodes = new Map([['(program)', { id: '(program)', label: '(program)', kind: 'entry', start: 0, end: code.length }]]);
  const edges = new Map();
  const fnId = new Map();
  traverse(ast, {
    Function(p) {
      if (nodes.size >= MAX_NODES) return;
      const id = `f${p.node.start}`;
      fnId.set(p.node, id);
      nodes.set(id, { id, label: functionLabel(p, code), kind: 'function', start: p.node.start, end: p.node.end });
    },
  });
  const owner = (p) => {
    const f = p.getFunctionParent();
    return f ? fnId.get(f.node) ?? '(program)' : '(program)';
  };
  const resolve = (p, callee) => {
    if (t.isIdentifier(callee)) {
      const b = p.scope.getBinding(callee.name);
      const n = b?.path.node;
      if (n && t.isFunction(n) && fnId.has(n)) return fnId.get(n);
      if (n && t.isVariableDeclarator(n) && t.isFunction(n.init) && fnId.has(n.init)) return fnId.get(n.init);
      if (b) return null; // yerel ama fonksiyon değil (parametre vb.)
    }
    if (t.isFunction(callee) && fnId.has(callee)) return fnId.get(callee);
    const name = calleeName(callee);
    if (!name) return null;
    const id = `x:${name}`;
    if (!nodes.has(id) && nodes.size < MAX_NODES) nodes.set(id, { id, label: short(name), kind: 'external' });
    return nodes.has(id) ? id : null;
  };
  traverse(ast, {
    'CallExpression|NewExpression|OptionalCallExpression'(p) {
      const to = resolve(p, p.node.callee);
      if (!to) return;
      const from = owner(p);
      const k = `${from}→${to}`;
      const e = edges.get(k);
      if (e) e.count++;
      else edges.set(k, { from, to, count: 1 });
    },
  });
  return { nodes: [...nodes.values()], edges: [...edges.values()].map((e) => ({ ...e, label: e.count > 1 ? `×${e.count}` : '' })) };
}

/** Kontrol akış grafiği için fonksiyon listesi (program dahil) */
export function cfgTargets(ast, code) {
  const out = [{ id: 'program', label: '(program)', node: ast.program }];
  traverse(ast, { Function(p) { if (out.length < 2000) out.push({ id: `f${p.node.start}`, label: `${functionLabel(p, code)} · L${lineOf(code, p.node.start)}`, node: p.node }); } });
  return out;
}

/**
 * Kontrol akış grafiği: temel bloklar (ardışık basit deyimler) ve koşul düğümleri.
 * if/döngü/switch/try/return/throw/break/continue (etiketli dahil) desteklenir.
 */
export function cfg(fnNode) {
  const nodes = [];
  const edges = [];
  const add = (kind, label, n) => { const id = `b${nodes.length}`; nodes.push({ id, kind, label, start: n?.start, end: n?.end }); return id; };
  const link = (from, to, label = '') => { for (const f of from) edges.push({ from: f, to, label }); };
  const entry = add('entry', 'entry');
  const exit = add('exit', 'exit');
  const text = (n) => short(gen(n).replace(/\s+/g, ' '), 60);

  // ctx: { breakTo: [exitIds], continueTo: id, labels: Map }; dönüş: açık çıkışlar (sonraki deyime akan)
  const seq = (stmts, preds, ctx) => {
    let open = preds;
    let block = null;
    let blockStmts = [];
    const flush = () => {
      if (!blockStmts.length) return;
      block = add('block', blockStmts.map(text).slice(0, 4).join('\n') + (blockStmts.length > 4 ? `\n… +${blockStmts.length - 4}` : ''), { start: blockStmts[0].start, end: blockStmts[blockStmts.length - 1].end });
      link(open, block);
      open = [block];
      blockStmts = [];
    };
    for (const s of stmts) {
      if (!open.length) {
        // ulaşılamaz kod: yine de göster
        flush();
        open = [];
      }
      if (isSimple(s)) { blockStmts.push(s); continue; }
      flush();
      open = stmt(s, open, ctx);
    }
    flush();
    return open;
  };

  const isSimple = (s) => !(t.isIfStatement(s) || t.isLoop(s) || t.isSwitchStatement(s) || t.isTryStatement(s) || t.isReturnStatement(s)
    || t.isThrowStatement(s) || t.isBreakStatement(s) || t.isContinueStatement(s) || t.isLabeledStatement(s) || t.isBlockStatement(s));

  const stmt = (s, preds, ctx, label = null) => {
    if (t.isBlockStatement(s)) return seq(s.body, preds, ctx);
    if (t.isLabeledStatement(s)) {
      if (t.isLoop(s.body)) return stmt(s.body, preds, ctx, s.label.name);
      const after = [];
      const labels = new Map(ctx.labels).set(s.label.name, { breakTo: after, continueTo: null });
      return [...stmt(s.body, preds, { ...ctx, labels }), ...after];
    }
    if (t.isReturnStatement(s) || t.isThrowStatement(s)) {
      const id = add(t.isReturnStatement(s) ? 'return' : 'throw', text(s), s);
      link(preds, id);
      edges.push({ from: id, to: exit, label: '' });
      return [];
    }
    if (t.isBreakStatement(s) || t.isContinueStatement(s)) {
      const id = add('jump', text(s), s);
      link(preds, id);
      const target = s.label ? ctx.labels.get(s.label.name) : ctx;
      if (t.isBreakStatement(s)) target?.breakTo?.push(id);
      else if (target?.continueTo) edges.push({ from: id, to: target.continueTo, label: 'continue' });
      return [];
    }
    if (t.isIfStatement(s)) {
      const c = add('cond', `if (${text(s.test)})`, s.test);
      link(preds, c);
      const yes = stmt(s.consequent, [c], ctx);
      relabelLast(c, 'true');
      const no = s.alternate ? stmt(s.alternate, [c], ctx) : [c];
      if (s.alternate) relabelLast(c, 'false');
      return [...yes, ...no];
    }
    if (t.isLoop(s)) {
      const after = [];
      let head;
      if (t.isForStatement(s) && s.init) {
        const init = add('block', text(s.init), s.init);
        link(preds, init);
        preds = [init];
      }
      if (t.isDoWhileStatement(s)) {
        const bodyStart = add('block', 'do', s);
        link(preds, bodyStart);
        head = add('cond', `while (${text(s.test)})`, s.test);
        const inner = { ...ctx, breakTo: after, continueTo: head, labels: label ? new Map(ctx.labels).set(label, { breakTo: after, continueTo: head }) : ctx.labels };
        link(stmt(s.body, [bodyStart], inner), head);
        edges.push({ from: head, to: bodyStart, label: 'true' });
        return [head, ...after];
      }
      const testText = t.isForStatement(s) ? `for (; ${s.test ? text(s.test) : ''}; ${s.update ? text(s.update) : ''})`
        : t.isWhileStatement(s) ? `while (${text(s.test)})` : `for (${text(s.left)} ${t.isForInStatement(s) ? 'in' : 'of'} ${text(s.right)})`;
      head = add('cond', testText, s);
      link(preds, head);
      const inner = { ...ctx, breakTo: after, continueTo: head, labels: label ? new Map(ctx.labels).set(label, { breakTo: after, continueTo: head }) : ctx.labels };
      const bodyOut = stmt(s.body, [head], inner);
      relabelLast(head, 'true');
      link(bodyOut, head, 'loop');
      const infinite = (t.isWhileStatement(s) || t.isForStatement(s)) && (!s.test || (t.isBooleanLiteral(s.test) && s.test.value) || (t.isUnaryExpression(s.test, { operator: '!' }) && t.isUnaryExpression(s.test.argument, { operator: '!' })));
      return infinite ? after : [head, ...after];
    }
    if (t.isSwitchStatement(s)) {
      const d = add('cond', `switch (${text(s.discriminant)})`, s.discriminant);
      link(preds, d);
      const after = [];
      const inner = { ...ctx, breakTo: after };
      let fall = [];
      let hasDefault = false;
      for (const c of s.cases) {
        const caseNode = add('case', c.test ? `case ${text(c.test)}` : 'default', c);
        if (!c.test) hasDefault = true;
        edges.push({ from: d, to: caseNode, label: '' });
        link(fall, caseNode, 'fall');
        fall = seq(c.consequent, [caseNode], inner);
      }
      return [...fall, ...after, ...(hasDefault ? [] : [d])];
    }
    if (t.isTryStatement(s)) {
      const tryStart = add('block', 'try', s.block);
      link(preds, tryStart);
      let out = seq(s.block.body, [tryStart], ctx);
      if (s.handler) {
        const h = add('catch', `catch (${s.handler.param ? text(s.handler.param) : ''})`, s.handler);
        edges.push({ from: tryStart, to: h, label: 'throw' });
        out = [...out, ...seq(s.handler.body.body, [h], ctx)];
      }
      if (s.finalizer) {
        const f = add('block', 'finally', s.finalizer);
        link(out, f);
        out = seq(s.finalizer.body, [f], ctx);
      }
      return out;
    }
    const id = add('block', text(s), s);
    link(preds, id);
    return [id];
  };
  // son eklenen kenarlardan bu koşuldan çıkan ilk etiketsizi etiketle
  const relabelLast = (from, label) => {
    for (let i = edges.length - 1; i >= 0; i--) {
      if (edges[i].from === from && !edges[i].label && !edges[i].labelled) { edges[i].label = label; edges[i].labelled = true; return; }
    }
  };

  const body = t.isProgram(fnNode) ? fnNode.body : t.isBlockStatement(fnNode.body) ? fnNode.body.body : [t.returnStatement(fnNode.body)];
  if (t.isArrowFunctionExpression(fnNode) && !t.isBlockStatement(fnNode.body)) { body[0].start = fnNode.body.start; body[0].end = fnNode.body.end; }
  const open = seq(body, [entry], { breakTo: [], continueTo: null, labels: new Map() });
  link(open, exit);
  return { nodes, edges: edges.map(({ from, to, label }) => ({ from, to, label })) };
}

/** Veri akışı: bir bağlamanın değeri başka bir bağlamanın başlangıç değerine ya da atamasına akıyorsa kenar */
export function dataFlow(ast, code) {
  const nodes = new Map();
  const edges = new Map();
  const nodeFor = (b) => {
    const id = `v${b.identifier.start}`;
    if (!nodes.has(id) && nodes.size < MAX_NODES) nodes.set(id, { id, label: `${b.identifier.name} · L${lineOf(code, b.identifier.start)}`, kind: b.kind, start: b.identifier.start, end: b.identifier.end });
    return nodes.has(id) ? id : null;
  };
  const sources = (p) => {
    const out = new Set();
    const visit = (q) => {
      if (q.isIdentifier() && q.isReferencedIdentifier()) { const b = q.scope.getBinding(q.node.name); if (b) out.add(b); }
    };
    if (p.node) { visit(p); p.traverse({ Function(q) { q.skip(); }, Identifier: visit }); }
    return out;
  };
  const flow = (fromSet, toBinding, label) => {
    const to = nodeFor(toBinding);
    if (!to) return;
    for (const b of fromSet) {
      if (b === toBinding) continue;
      const from = nodeFor(b);
      if (!from) continue;
      const k = `${from}→${to}`;
      if (!edges.has(k)) edges.set(k, { from, to, label });
    }
  };
  traverse(ast, {
    VariableDeclarator(p) {
      if (!t.isIdentifier(p.node.id) || !p.node.init) return;
      const b = p.scope.getBinding(p.node.id.name);
      if (b) flow(sources(p.get('init')), b, 'init');
    },
    AssignmentExpression(p) {
      if (!t.isIdentifier(p.node.left)) return;
      const b = p.scope.getBinding(p.node.left.name);
      if (b) flow(sources(p.get('right')), b, p.node.operator);
    },
    CallExpression(p) {
      if (!t.isIdentifier(p.node.callee)) return;
      const fb = p.scope.getBinding(p.node.callee.name);
      const fn = fb?.path.isFunction() ? fb.path : fb?.path.isVariableDeclarator() && fb.path.get('init').isFunction() ? fb.path.get('init') : null;
      if (!fn) return;
      p.get('arguments').forEach((a, i) => {
        const param = fn.node.params[i];
        if (!t.isIdentifier(param)) return;
        const pb = fn.scope.getBinding(param.name);
        if (pb) flow(sources(a), pb, 'arg');
      });
    },
  });
  // yalnızca bir akışa katılan bağlamaları göster
  const used = new Set();
  for (const e of edges.values()) { used.add(e.from); used.add(e.to); }
  return { nodes: [...nodes.values()].filter((n) => used.has(n.id)), edges: [...edges.values()] };
}

const SPECIFIER_CALLS = new Set(['require', 'importScripts', 'Worker', 'SharedWorker']);

/** Bir koddaki modül/betik bağımlılık belirteçleri */
export function specifiers(ast) {
  const out = new Set();
  const lit = (n) => (t.isStringLiteral(n) ? n.value : t.isTemplateLiteral(n) && !n.expressions.length ? n.quasis[0].value.cooked : null);
  traverse(ast, {
    'ImportDeclaration|ExportAllDeclaration|ExportNamedDeclaration'(p) { if (p.node.source) out.add(p.node.source.value); },
    'CallExpression|NewExpression'(p) {
      const c = p.node.callee;
      const name = t.isIdentifier(c) ? c.name : t.isImport(c) ? 'import' : null;
      if ((name === 'import' || SPECIFIER_CALLS.has(name)) && p.node.arguments.length) {
        const v = lit(p.node.arguments[0]);
        if (v) out.add(v);
      }
    },
    ImportExpression(p) { const v = lit(p.node.source); if (v) out.add(v); },
    AssignmentExpression(p) {
      const l = p.node.left;
      const v = lit(p.node.right);
      if (t.isMemberExpression(l) && !l.computed && l.property.name === 'src' && v && /\.m?js(\?|#|$)/.test(v)) out.add(v);
    },
  });
  return [...out];
}

// Göreli belirteci proje içindeki dosya yoluna çözer
export function resolveSpecifier(fromPath, spec, paths) {
  if (!/^\.{1,2}\//.test(spec) && !spec.startsWith('/')) return null;
  const base = spec.startsWith('/') ? [] : fromPath.split('/').slice(0, -1);
  for (const part of spec.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') base.pop();
    else base.push(part);
  }
  const p = base.join('/').replace(/[?#].*$/, '');
  for (const cand of [p, `${p}.js`, `${p}.mjs`, `${p}.cjs`, `${p}/index.js`]) if (paths.has(cand)) return cand;
  return null;
}

/** Bağımlılık grafiği: belgeler (dosyalar) ve dış modüller */
export function dependencyGraph(docs) {
  const nodes = new Map();
  const edges = [];
  const paths = new Map(docs.map((d) => [d.path, d]));
  for (const d of docs) nodes.set(d.id, { id: d.id, label: short(d.path, 40), kind: 'file', docId: d.id });
  for (const d of docs) {
    for (const spec of d.specifiers) {
      const target = resolveSpecifier(d.path, spec, paths);
      let to;
      if (target) to = paths.get(target).id;
      else {
        to = `m:${spec}`;
        if (!nodes.has(to)) nodes.set(to, { id: to, label: short(spec, 40), kind: 'external' });
      }
      edges.push({ from: d.id, to, label: '' });
    }
  }
  return { nodes: [...nodes.values()], edges };
}

const litVal = (n) => (t.isNumericLiteral(n) || t.isStringLiteral(n) ? n.value : t.isUnaryExpression(n, { operator: '-' }) && t.isNumericLiteral(n.argument) ? -n.argument.value : undefined);

/**
 * Durum makinesi grafikleri: döngü içindeki switch dağıtıcıları. Durum değişkenine atanan literaller
 * ve "2|0|1".split("|") sıra dizileri geçiş olarak çıkarılır.
 */
export function stateMachines(ast, code) {
  const machines = [];
  traverse(ast, {
    SwitchStatement(p) {
      const loop = p.findParent((q) => q.isLoop());
      if (!loop || machines.length >= 50) return;
      const disc = p.node.discriminant;
      const cases = p.node.cases;
      if (cases.length < 2) return;
      const nodes = [];
      const edges = [];
      const idOf = (v) => `s:${String(v)}`;
      for (const c of cases) nodes.push({ id: c.test ? idOf(litVal(c.test)) : 's:default', label: c.test ? `case ${gen(c.test)}` : 'default', kind: 'state', start: c.start, end: c.end });
      nodes.push({ id: 'exit', label: 'exit', kind: 'exit' });
      let kind = null;
      // 1) durum değişkeni: switch(s) { case 1: ...; s = 3; }
      if (t.isIdentifier(disc)) {
        const name = disc.name;
        cases.forEach((c, i) => {
          const from = nodes[i].id;
          let exits = false;
          const visit = (n) => {
            if (!n || typeof n.type !== 'string') return;
            if (t.isFunction(n)) return;
            if (t.isAssignmentExpression(n) && t.isIdentifier(n.left, { name })) {
              const v = litVal(n.right);
              if (v !== undefined) edges.push({ from, to: idOf(v), label: '' });
              else if (t.isConditionalExpression(n.right)) {
                for (const br of [n.right.consequent, n.right.alternate]) { const bv = litVal(br); if (bv !== undefined) edges.push({ from, to: idOf(bv), label: gen(n.right.test).slice(0, 24) }); }
              }
            }
            if (t.isReturnStatement(n) || t.isThrowStatement(n)) exits = true;
            for (const key of t.VISITOR_KEYS[n.type] ?? []) { const v = n[key]; for (const ch of Array.isArray(v) ? v : [v]) visit(ch); }
          };
          c.consequent.forEach(visit);
          if (exits) edges.push({ from, to: 'exit', label: '' });
        });
        if (edges.some((e) => e.to !== 'exit')) kind = 'state-var';
      }
      // 2) sıra dizisi: var o = "2|0|1".split("|"), i = 0; switch (o[i++])
      if (!kind && t.isMemberExpression(disc) && disc.computed && t.isIdentifier(disc.object)) {
        const b = p.scope.getBinding(disc.object.name);
        const init = b?.path.node.init;
        if (init && t.isCallExpression(init) && t.isMemberExpression(init.callee) && t.isStringLiteral(init.callee.object) && t.isIdentifier(init.callee.property, { name: 'split' }) && t.isStringLiteral(init.arguments[0])) {
          const order = init.callee.object.value.split(init.arguments[0].value);
          for (let i = 0; i + 1 < order.length; i++) edges.push({ from: idOf(order[i]), to: idOf(order[i + 1]), label: String(i + 1) });
          if (order.length) edges.push({ from: idOf(order[order.length - 1]), to: 'exit', label: '' });
          kind = 'sequence';
        }
      }
      if (!kind) return;
      const known = new Set(nodes.map((n) => n.id));
      for (const e of edges) if (!known.has(e.to)) { known.add(e.to); nodes.push({ id: e.to, label: `→ ${e.to.slice(2)}`, kind: 'missing' }); }
      const seen = new Set();
      machines.push({
        id: `m${p.node.start}`,
        label: `${kind === 'sequence' ? 'split' : gen(disc).slice(0, 20)} · L${lineOf(code, p.node.start)} · ${cases.length}`,
        start: p.node.start,
        end: p.node.end,
        graph: { nodes, edges: edges.filter((e) => { const k = `${e.from}→${e.to}→${e.label}`; return !seen.has(k) && seen.add(k); }) },
      });
    },
  });
  return machines;
}

/**
 * Opcode frekansı: `switch (code[pc++])` biçimli VM dağıtıcısının okuduğu sayısal bytecode dizisinde
 * her opcode'un kaç kez geçtiği. handled: dağıtıcıda bu değer için case var mı.
 */
export function opcodeFrequency(ast) {
  const results = [];
  traverse(ast, {
    SwitchStatement(p) {
      if (results.length >= 10 || !p.findParent((q) => q.isLoop())) return;
      let d = p.node.discriminant;
      // switch (op) { ... } ve op = code[pc++] ise diziye in
      if (t.isIdentifier(d)) {
        const b = p.scope.getBinding(d.name);
        const sources = [b?.path.node.init, ...(b?.constantViolations ?? []).map((c) => c.node.right)].filter(Boolean);
        d = sources.find((s) => t.isMemberExpression(s) && s.computed) ?? d;
      }
      if (!t.isMemberExpression(d) || !d.computed || !t.isIdentifier(d.object)) return;
      const arrBinding = p.scope.getBinding(d.object.name);
      const arr = arrBinding?.path.node.init;
      if (!t.isArrayExpression(arr) || arr.elements.length < 8) return;
      const values = arr.elements.map(litVal);
      if (values.some((v) => typeof v !== 'number')) return;
      const handled = new Set(p.node.cases.filter((c) => c.test).map((c) => litVal(c.test)));
      const freq = new Map();
      for (const v of values) freq.set(v, (freq.get(v) ?? 0) + 1);
      results.push({
        array: d.object.name,
        start: p.node.start,
        end: p.node.end,
        length: values.length,
        ops: [...freq].map(([op, count]) => ({ op, count, handled: handled.has(op) })).sort((a, b) => b.count - a.count),
      });
    },
  });
  return results;
}
