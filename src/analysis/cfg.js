// Fonksiyon (ya da program) gövdesi için deyim düzeyinde kontrol akış grafiği.
// Düğüm: bir ifadenin değerlendirildiği nokta (deyim, koşul, döngü başı...). İstisna kenarları ayrı tutulur:
// try içindeki her düğümden en yakın catch/finally girişine (ya da fonksiyonun throw çıkışına).
// Yaklaşım: finally çıkışı, finally'ye girilebilen tüm devam noktalarına bağlanır (olası olmayan yolları da kapsar).

let seq = 0;

class Graph {
  constructor(fnPath) {
    this.fn = fnPath;
    this.nodes = [];
    this.entry = this.node('entry', null);
    this.exit = this.node('exit', null);
    this.throwExit = this.node('throw', null);
  }

  node(kind, path) {
    const n = { id: this.nodes.length, uid: ++seq, kind, path, succ: [], pred: [], exc: [] };
    this.nodes.push(n);
    return n;
  }

  edge(a, b) {
    if (!a.succ.includes(b)) { a.succ.push(b); b.pred.push(a); }
  }
}

const isFunctionLike = (p) => p.isFunction() || p.isStaticBlock() || p.isProgram();

/**
 * @param {import('@babel/traverse').NodePath} fnPath Function, StaticBlock ya da Program yolu
 */
export function buildCFG(fnPath) {
  const g = new Graph(fnPath);
  // jump hedefleri: { label, breakTo: handler(node), continueTo }
  const ctx = { targets: [], handler: g.throwExit, finals: [] };

  const link = (preds, n) => { for (const p of preds) g.edge(p, n); };

  // Yeni değerlendirme düğümü: önceki sınırdan gelir, try içindeyse istisna kenarı alır
  const add = (kind, path, preds) => {
    const n = g.node(kind, path);
    link(preds, n);
    n.exc.push(ctx.handler);
    return n;
  };

  // break/continue/return/throw: finally çerçevelerinden geçerek hedefe ulaşır
  const jump = (from, target, frames = ctx.finals.slice()) => {
    // hedefin içinde bulunduğu çerçevelerin dışındaki finally'ler sırayla çalışır
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i];
      if (target.depth !== undefined && f.depth < target.depth) break;
      g.edge(from, f.entry);
      f.exits.push({ target, frames: frames.slice(0, i) });
      return;
    }
    g.edge(from, target.node);
  };

  function stmts(list, preds) {
    let cur = preds;
    for (const s of list) cur = stmt(s, cur);
    return cur;
  }

  function loopTargets(p, labelSet) {
    return { labels: labelSet, depth: ctx.finals.length, breakNode: g.node('join', null), continueNode: null, isLoop: true, path: p };
  }

  function takeLabels(p) {
    const labels = [];
    let q = p.parentPath;
    while (q && q.isLabeledStatement()) { labels.push(q.node.label.name); q = q.parentPath; }
    return labels;
  }

  function stmt(p, preds) {
    const n = p.node;
    switch (n.type) {
      case 'EmptyStatement':
      case 'FunctionDeclaration':
      case 'TSInterfaceDeclaration': case 'TSTypeAliasDeclaration':
        return preds;
      case 'ImportDeclaration':
        return preds;
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        if (n.declaration) {
          const d = p.get('declaration');
          if (d.isStatement() || d.isDeclaration()) return stmt(d, preds);
          return [add('stmt', d, preds)];
        }
        return preds;
      case 'ExportAllDeclaration':
        return preds;
      case 'BlockStatement':
        return stmts(p.get('body'), preds);
      case 'StaticBlock':
        return stmts(p.get('body'), preds);
      case 'ExpressionStatement':
      case 'VariableDeclaration':
      case 'ClassDeclaration':
      case 'DebuggerStatement':
        return [add('stmt', p, preds)];
      case 'ReturnStatement': {
        const r = add('stmt', p, preds);
        jump(r, { node: g.exit, depth: 0 });
        return [];
      }
      case 'ThrowStatement':
        add('stmt', p, preds);
        return [];
      case 'IfStatement': {
        const test = add('test', p.get('test'), preds);
        const cons = stmt(p.get('consequent'), [test]);
        const alt = n.alternate ? stmt(p.get('alternate'), [test]) : [test];
        return [...cons, ...alt];
      }
      case 'WithStatement': {
        const obj = add('test', p.get('object'), preds);
        return stmt(p.get('body'), [obj]);
      }
      case 'LabeledStatement': {
        const body = p.get('body');
        if (body.isLoop() || body.isSwitchStatement()) return stmt(body, preds);
        const tgt = { labels: [n.label.name], depth: ctx.finals.length, breakNode: g.node('join', null), isLoop: false };
        ctx.targets.push(tgt);
        const out = stmt(body, preds);
        ctx.targets.pop();
        link(out, tgt.breakNode);
        return [tgt.breakNode];
      }
      case 'WhileStatement': {
        const tgt = loopTargets(p, takeLabels(p));
        const head = add('test', p.get('test'), preds);
        tgt.continueNode = head;
        ctx.targets.push(tgt);
        const body = stmt(p.get('body'), [head]);
        ctx.targets.pop();
        link(body, head);
        g.edge(head, tgt.breakNode);
        return [tgt.breakNode];
      }
      case 'DoWhileStatement': {
        const tgt = loopTargets(p, takeLabels(p));
        const top = g.node('join', null);
        link(preds, top);
        const test = g.node('test', p.get('test'));
        test.exc.push(ctx.handler);
        tgt.continueNode = test;
        ctx.targets.push(tgt);
        const body = stmt(p.get('body'), [top]);
        ctx.targets.pop();
        link(body, test);
        g.edge(test, top);
        g.edge(test, tgt.breakNode);
        return [tgt.breakNode];
      }
      case 'ForStatement': {
        const tgt = loopTargets(p, takeLabels(p));
        let cur = preds;
        if (n.init) cur = [add('stmt', p.get('init'), cur)];
        const head = n.test ? add('test', p.get('test'), cur) : (() => { const j = g.node('join', null); link(cur, j); return j; })();
        const update = n.update ? g.node('stmt', p.get('update')) : null;
        if (update) update.exc.push(ctx.handler);
        tgt.continueNode = update ?? head;
        ctx.targets.push(tgt);
        const body = stmt(p.get('body'), [head]);
        ctx.targets.pop();
        if (update) { link(body, update); g.edge(update, head); } else link(body, head);
        if (n.test) g.edge(head, tgt.breakNode);
        return [tgt.breakNode];
      }
      case 'ForInStatement':
      case 'ForOfStatement': {
        const tgt = loopTargets(p, takeLabels(p));
        const right = add('test', p.get('right'), preds);
        const head = g.node('head', p.get('left'));
        head.exc.push(ctx.handler);
        g.edge(right, head);
        tgt.continueNode = head;
        ctx.targets.push(tgt);
        const body = stmt(p.get('body'), [head]);
        ctx.targets.pop();
        link(body, head);
        g.edge(head, tgt.breakNode);
        g.edge(right, tgt.breakNode); // boş yineleme
        return [tgt.breakNode];
      }
      case 'SwitchStatement': {
        const tgt = { labels: takeLabels(p), depth: ctx.finals.length, breakNode: g.node('join', null), isLoop: false, isSwitch: true };
        const disc = add('test', p.get('discriminant'), preds);
        let testPreds = [disc];
        let fall = [];
        let defaultEntry = null;
        ctx.targets.push(tgt);
        for (const c of p.get('cases')) {
          const entry = g.node('join', null);
          if (c.node.test) {
            const test = add('test', c.get('test'), testPreds);
            g.edge(test, entry);
            testPreds = [test];
          } else {
            defaultEntry = entry;
          }
          link(fall, entry);
          fall = stmts(c.get('consequent'), [entry]);
        }
        ctx.targets.pop();
        link(testPreds, defaultEntry ?? tgt.breakNode);
        link(fall, tgt.breakNode);
        return [tgt.breakNode];
      }
      case 'BreakStatement':
      case 'ContinueStatement': {
        const isBreak = n.type === 'BreakStatement';
        const label = n.label?.name;
        const j = add('stmt', p, preds);
        for (let i = ctx.targets.length - 1; i >= 0; i--) {
          const tg = ctx.targets[i];
          const match = label ? tg.labels.includes(label) : isBreak ? (tg.isLoop || tg.isSwitch) : tg.isLoop;
          if (!match || (!isBreak && !tg.isLoop)) continue;
          jump(j, { node: isBreak ? tg.breakNode : tg.continueNode, depth: tg.depth });
          return [];
        }
        return [];
      }
      case 'TryStatement': {
        const after = g.node('join', null);
        const outerHandler = ctx.handler;
        let frame = null;
        if (n.finalizer) {
          frame = { entry: g.node('join', null), exits: [], depth: ctx.finals.length };
          frame.entry.exc.push(outerHandler);
          ctx.finals.push(frame);
        }
        let catchEntry = null;
        if (n.handler) {
          catchEntry = g.node('catch', n.handler.param ? p.get('handler.param') : null);
          catchEntry.exc.push(frame ? frame.entry : outerHandler);
        }
        ctx.handler = catchEntry ?? frame.entry;
        const tryOut = stmts(p.get('block.body'), preds);
        ctx.handler = frame ? frame.entry : outerHandler;
        let catchOut = [];
        if (catchEntry) catchOut = stmts(p.get('handler.body.body'), [catchEntry]);
        ctx.handler = outerHandler;
        if (frame) {
          ctx.finals.pop();
          link([...tryOut, ...catchOut], frame.entry);
          const finOut = stmts(p.get('finalizer.body'), [frame.entry]);
          link(finOut, after);
          // finally sonrası: istisnayı yeniden fırlatma ve bekleyen break/continue/return'ler
          for (const o of finOut) g.edge(o, outerHandler);
          const exitNode = g.node('join', null);
          link(finOut, exitNode);
          for (const e of frame.exits) jump(exitNode, e.target, e.frames);
        } else {
          link([...tryOut, ...catchOut], after);
        }
        return [after];
      }
      default:
        return [add('stmt', p, preds)];
    }
  }

  let bodyOut;
  if (fnPath.isProgram() || fnPath.isStaticBlock()) bodyOut = stmts(fnPath.get('body'), [g.entry]);
  else {
    const body = fnPath.get('body');
    if (body.isBlockStatement()) bodyOut = stmts(body.get('body'), [g.entry]);
    else { const e = add('stmt', body, [g.entry]); bodyOut = [e]; } // ok fonksiyon ifade gövdesi
  }
  link(bodyOut, g.exit);
  g.edge(g.throwExit, g.exit);
  for (const nd of g.nodes) nd.exc = [...new Set(nd.exc)].filter((h) => h !== nd);
  return g;
}

// Ters son sıra (reverse post-order): ileri analizlerde deterministik ve hızlı yakınsama sırası
export function reversePostOrder(g, { backward = false } = {}) {
  const seen = new Uint8Array(g.nodes.length);
  const order = [];
  const start = backward ? g.exit : g.entry;
  const excPred = new Map();
  if (backward) for (const m of g.nodes) for (const h of m.exc) { if (!excPred.has(h)) excPred.set(h, []); excPred.get(h).push(m); }
  const next = (n) => backward ? [...n.pred, ...(excPred.get(n) ?? [])] : [...n.succ, ...n.exc];
  // özyinelemesiz DFS
  const stack = [[start, 0, next(start)]];
  seen[start.id] = 1;
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top[1] < top[2].length) {
      const m = top[2][top[1]++];
      if (!seen[m.id]) { seen[m.id] = 1; stack.push([m, 0, next(m)]); }
    } else {
      order.push(top[0]);
      stack.pop();
    }
  }
  order.reverse();
  // ulaşılamayan düğümler sona, id sırasıyla
  for (const n of g.nodes) if (!seen[n.id]) order.push(n);
  return order;
}

export { isFunctionLike };
