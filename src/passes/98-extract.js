import * as t from '@babel/types';
import { traverse, generate } from '../util/ast.js';
import { scan, scopeHasWith } from '../naming/scope.js';

// E234: fonksiyon çıkarma. Aynı fonksiyon içinde birebir tekrar eden ≥3 deyimlik dizi, o fonksiyonun başına
// bildirilen yardımcıya taşınır ve her kopya tek çağrıya iner.
// Kanıt: yardımcı aynı kapsamda bildirildiği için kapanış aynı değişkenlere yazar/okur; dizide return/break/continue/
// yield/await/this/arguments/var yok; dizinin kullandığı her dış isim fonksiyon kapsamından aynı binding'e çözülür;
// let/const bildirimleri yalnızca dizi içinde kullanılıyor.

const MIN_LEN = 3;
const MAX_LEN = 8;
const MIN_CHARS = 60;

export async function run(ast, { onLog, bump, naming = {} }) {
  if (naming.extract === false) return;
  const info = scan(ast);
  let counter = 0;
  const fresh = () => {
    let name;
    do { name = `extracted${++counter}`; } while (info.taken.has(name));
    info.taken.add(name);
    return name;
  };
  let n = 0;
  traverse(ast, {
    'Function|Program': {
      exit(fp) {
        if (fp.isArrowFunctionExpression() && !t.isBlockStatement(fp.node.body)) return;
        const scope = fp.scope;
        if (scopeHasWith(info, scope) || info.evalScopes.has(scope)) return;
        // bu fonksiyona ait (iç fonksiyonlarda olmayan) deyim listeleri
        const lists = [];
        fp.traverse({
          Function(q) { q.skip(); },
          BlockStatement(q) { lists.push(q); },
          SwitchCase(q) { if (q.node.consequent.length) lists.push(q); },
        });
        if (fp.isProgram()) lists.unshift(fp);
        else lists.unshift(fp.get('body'));
        const uniq = [...new Map(lists.map((l) => [l.node, l])).values()];
        const windows = new Map();
        for (const list of uniq) {
          const key = list.isSwitchCase() ? 'consequent' : 'body';
          const stmts = list.get(key);
          const codes = stmts.map((s) => generate(s.node, { compact: true, comments: false, jsescOption: { minimal: true } }).code);
          for (let len = MAX_LEN; len >= MIN_LEN; len--) {
            for (let i = 0; i + len <= stmts.length; i++) {
              const code = codes.slice(i, i + len).join('\n');
              if (code.length < MIN_CHARS) continue;
              if (!windows.has(code)) windows.set(code, []);
              windows.get(code).push({ list, key, i, len, stmts: stmts.slice(i, i + len) });
            }
          }
        }
        const used = new Set();
        const rootBody = fp.isProgram() ? fp : fp.get('body');
        const inserts = [];
        // uzun diziler önce
        const entries = [...windows.entries()].filter(([, w]) => w.length >= 2).sort((a, b) => b[1][0].len - a[1][0].len);
        for (const [, occ] of entries) {
          const free = occ.filter((w) => w.stmts.every((s) => !used.has(s.node)));
          // aynı listede çakışan pencereleri ele
          const picked = [];
          for (const w of free) {
            if (picked.some((x) => x.list.node === w.list.node && x.i + x.len > w.i && w.i + w.len > x.i)) continue;
            picked.push(w);
          }
          if (picked.length < 2 || !picked.every((w) => extractable(w, fp))) continue;
          const name = fresh();
          const body = picked[0].stmts.map((s) => t.cloneNode(s.node, true));
          inserts.push(t.functionDeclaration(t.identifier(name), [], t.blockStatement(body)));
          for (const w of picked) for (const s of w.stmts) used.add(s.node);
          for (const w of picked) w.replace = name;
          n++;
        }
        if (!inserts.length) return;
        // listeleri sondan başa yeniden kur
        const byList = new Map();
        for (const [, occ] of windows) for (const w of occ) if (w.replace) {
          if (!byList.has(w.list.node)) byList.set(w.list.node, { w: [], key: w.key, list: w.list });
          byList.get(w.list.node).w.push(w);
        }
        for (const { w, key, list } of byList.values()) {
          const arr = list.node[key];
          for (const x of [...new Set(w)].sort((a, b) => b.i - a.i)) {
            arr.splice(x.i, x.len, t.expressionStatement(t.callExpression(t.identifier(x.replace), [])));
          }
        }
        rootBody.node.body.unshift(...inserts);
      },
    },
  });
  if (n) onLog(`extract: ${n} tekrar eden deyim dizisi fonksiyona çıkarıldı`, 'info');
  bump('extract', n);
}

const ownerFn = (q) => q.getFunctionParent()?.node ?? q.scope.getProgramParent().path.node;

function extractable(w, fp) {
  const nodes = new Set(w.stmts.map((s) => s.node));
  const inside = (p) => p.findParent((x) => nodes.has(x.node)) || nodes.has(p.node);
  let ok = true;
  const no = (p) => { ok = false; p.stop(); };
  for (const s of w.stmts) {
    if (s.isFunctionDeclaration() || s.isClassDeclaration() || s.isLabeledStatement()) return false;
    if (s.isVariableDeclaration({ kind: 'var' })) return false;
    if (s.isReturnStatement() || s.isBreakStatement() || s.isContinueStatement()) return false;
    // fonksiyon tanımlayan atama (x = function …): tanımı yardımcının içine saklamak okunurluğu düşürür ve henüz
    // açılmamış yapıları (js-confuser kapsam deposu, decoder kurulumu) sonraki çözme turlarından gizler
    if (s.isExpressionStatement() && t.isAssignmentExpression(s.node.expression) &&
        (t.isFunction(s.node.expression.right) || t.isAssignmentExpression(s.node.expression.right))) return false;
    s.traverse({
      Function(q) { if (!q.isArrowFunctionExpression()) q.skip(); },
      // ok fonksiyonu kendi return/await'ine sahiptir ama this/arguments/super'i dış fonksiyondan alır
      'ReturnStatement|YieldExpression|AwaitExpression'(q) {
        const owner = q.getFunctionParent();
        if (!(owner?.isArrowFunctionExpression() && inside(owner))) no(q);
      },
      'ThisExpression|Super|MetaProperty|LabeledStatement'(q) { no(q); },
      'BreakStatement|ContinueStatement'(q) {
        // dizinin içindeki döngü/switch'e ait etiketsiz atlamalar güvenli
        if (q.node.label) return no(q);
        const target = q.findParent((x) => x.isLoop() || (q.isBreakStatement() && x.isSwitchStatement()) || x.isFunction());
        if (!target || target.isFunction() || !inside(target)) no(q);
      },
      VariableDeclaration(q) { if (q.node.kind === 'var' && ownerFn(q) === fp.node) no(q); },
      FunctionDeclaration(q) { if (ownerFn(q.parentPath) === fp.node) no(q); },
      Identifier(q) {
        if (q.node.name === 'arguments' && !q.scope.getBinding('arguments')) return no(q);
        if (!q.isReferencedIdentifier() && !q.parentPath.isAssignmentExpression({ left: q.node }) && !q.parentPath.isUpdateExpression()) return;
        const b = q.scope.getBinding(q.node.name);
        const top = fp.scope.getBinding(q.node.name);
        if (b && inside(b.path)) {
          // dizinin kendi let/const'u: dışarıda kullanılmamalı
          if (![...b.referencePaths, ...b.constantViolations].every((r) => inside(r))) no(q);
          return;
        }
        if (b !== top) no(q); // fonksiyon başından farklı binding'e çözülür (iç blok değişkeni ya da gölge)
      },
    });
    if (!ok) return false;
  }
  return ok;
}
