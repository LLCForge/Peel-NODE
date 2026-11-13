import * as t from '@babel/types';
import { traverse } from '../util/ast.js';

// 91: sekans diyagramı. Programın üst düzey akışı kaynak sırasıyla yürünür; yerel fonksiyon çağrıları içine girilir
// (derinlik ve tekrar sınırıyla), dış API çağrıları ilgili katılımcıya mesaj olur. Statik bir yaklaşımdır:
// koşullu dallar "alt" (opt) işaretiyle, döngüler "loop" işaretiyle gösterilir; olay işleyicileri kayıt mesajıdır.

const MAX_MESSAGES = 200;
const MAX_DEPTH = 4;

const memberPath = (n) => {
  if (t.isIdentifier(n)) return n.name;
  if (t.isThisExpression(n)) return 'this';
  if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
    const o = memberPath(n.object);
    return o ? `${o}.${n.property.name}` : null;
  }
  return null;
};

// Dış çağrının katılımcısı
function participantOf(path) {
  if (/^(fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)/.test(path) || /\.(open|send|setRequestHeader)$/.test(path)) return 'Ağ';
  if (/^(localStorage|sessionStorage|indexedDB)|document\.cookie/.test(path)) return 'Depolama';
  if (/^(document|window\.document)|\.(appendChild|append|setAttribute|insertBefore|removeChild|querySelector|querySelectorAll|getElementById|addEventListener|remove)$/.test(path)) return 'DOM';
  if (/^console\./.test(path)) return 'Konsol';
  if (/^(setTimeout|setInterval|requestAnimationFrame|queueMicrotask)$/.test(path)) return 'Zamanlayıcı';
  if (/^(crypto|Math|JSON|atob|btoa|String|Number|Object|Array|Date|Promise|parseInt|parseFloat|encodeURIComponent|decodeURIComponent)\b/.test(path)) return 'Çalışma zamanı';
  if (/^(window|self|globalThis|location|history|navigator|screen)\b/.test(path)) return 'Tarayıcı';
  return null;
}

export function sequence(ast) {
  const participants = ['Program'];
  const messages = [];
  const add = (p) => { if (!participants.includes(p)) participants.push(p); };
  const fns = new Map(); // binding → fonksiyon yolu
  let program = null;
  traverse(ast, {
    Program(p) { program = p; },
    FunctionDeclaration(p) {
      const b = p.parentPath.scope.getBinding(p.node.id.name);
      if (b) fns.set(b, p);
    },
    VariableDeclarator(p) {
      const init = p.get('init');
      if (t.isIdentifier(p.node.id) && (init.isFunctionExpression() || init.isArrowFunctionExpression())) {
        const b = p.scope.getBinding(p.node.id.name);
        if (b) fns.set(b, init);
      }
    },
  });
  const stack = [];
  const pending = new Map(); // çağrı düğümü → callback fonksiyon yolları

  function walk(path, from, depth) {
    path.traverse({
      Function(q) {
        // callback: çağrı mesajından sonra, çağıranın adına açılır
        const par = q.parentPath;
        if (par.isCallExpression() && par.node.arguments.includes(q.node)) {
          if (!pending.has(par.node)) pending.set(par.node, []);
          pending.get(par.node).push(q);
        }
        q.skip();
      },
      IfStatement: {
        enter() { messages.push({ from, to: from, label: 'opt', kind: 'open' }); },
        exit() { messages.push({ from, to: from, label: 'opt', kind: 'close' }); },
      },
      Loop: {
        enter() { messages.push({ from, to: from, label: 'loop', kind: 'open' }); },
        exit() { messages.push({ from, to: from, label: 'loop', kind: 'close' }); },
      },
      'CallExpression|NewExpression': {
        exit(q) {
          if (messages.length >= MAX_MESSAGES) return q.stop();
          const callee = q.node.callee;
          const name = memberPath(callee);
          const flush = () => {
            for (const cb of pending.get(q.node) ?? []) {
              if (depth >= MAX_DEPTH) break;
              const host = name ?? (t.isMemberExpression(callee) && t.isIdentifier(callee.property) ? `.${callee.property.name}` : 'çağrı');
              messages.push({ from, to: from, label: `↳ ${host} callback`, kind: 'note' });
              walk(cb.get('body'), from, depth + 1);
            }
            pending.delete(q.node);
          };
          if (t.isIdentifier(callee)) {
            const b = q.scope.getBinding(callee.name);
            const target = b ? fns.get(b) : null;
            if (target) {
              const to = callee.name;
              add(to);
              messages.push({ from, to, label: `${to}(${q.node.arguments.length ? '…' : ''})`, kind: 'call' });
              if (depth < MAX_DEPTH && !stack.includes(target.node)) {
                stack.push(target.node);
                walk(target.get('body'), to, depth + 1);
                stack.pop();
              }
              messages.push({ from: to, to: from, label: 'dönüş', kind: 'return' });
              flush();
              return;
            }
          }
          if (!name) return flush();
          const part = participantOf(name);
          if (!part) return flush();
          add(part);
          let label = q.isNewExpression() ? `new ${name}` : name.split('.').slice(-2).join('.');
          const a0 = q.node.arguments[0];
          if (t.isStringLiteral(a0)) label += `("${a0.value.slice(0, 30)}")`;
          messages.push({ from, to: part, label, kind: /^(setTimeout|setInterval|requestAnimationFrame)$|addEventListener$|\.then$/.test(name) ? 'async' : 'call' });
          flush();
        },
      },
    });
  }
  // üst düzey: fonksiyon bildirimleri hariç kaynak sırası
  for (const st of program.get('body')) {
    if (st.isFunctionDeclaration() || st.isClassDeclaration()) continue;
    // traverse düğümün kendisini ziyaret etmez: üst düzey if/döngü işaretleri burada
    const block = st.isIfStatement() ? 'opt' : st.isLoop() ? 'loop' : null;
    if (block) messages.push({ from: 'Program', to: 'Program', label: block, kind: 'open' });
    walk(st, 'Program', 0);
    if (block) messages.push({ from: 'Program', to: 'Program', label: block, kind: 'close' });
    if (messages.length >= MAX_MESSAGES) break;
  }
  // boş opt/loop çiftlerini at
  const cleaned = [];
  for (const m of messages) {
    const last = cleaned.at(-1);
    if (m.kind === 'close' && last?.kind === 'open' && last.label === m.label && last.from === m.from) { cleaned.pop(); continue; }
    cleaned.push(m);
  }
  return { participants, messages: cleaned, truncated: messages.length >= MAX_MESSAGES };
}
