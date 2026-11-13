import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { analyzeStringArray, evaluate, isThrown, splitRotatorSequences, Unsupported } from '../core/obfio.js';
import { analyzeStringTables } from '../core/vm/strtable.js';

// A-3 / A-5: obfuscator.io string dizisini sandbox olmadan çözer. Decoder ofseti (i = i - 0xd6) afin biçimden
// sembolik olarak çıkarılır, base64/RC4 kodlaması yeniden yazılmış algoritmalarla çözülür ve rotasyon
// checksum'ı statik olarak yürütülür. Checksum hedefi tutmadıkça hiçbir çağrı değiştirilmez: tutması,
// model (ofset + kodlama + rotasyon sayısı) doğru demektir.
// Yedek yol (E632, yalnızca sandbox yokken): obfio modelinin tanımadığı biçimler — program düzeyinde
// var T = [...] tablosu, sayaçlı rotasyon döngüsü (while (--n) push(shift())), indeks/base64/rc4 decoder —
// vm/strtable.js ile çözülür; sandbox varken bunları string-array/runtime-decoders pass'leri çözer.

const MAX_CALLS = 50_000;

function argsOf(call, env) {
  try {
    return call.arguments.map((a) => evaluate(a, env));
  } catch (e) {
    if (e instanceof Unsupported || isThrown(e)) return null;
    throw e;
  }
}

export async function run(ast, { onLog, bump, sandbox }) {
  splitRotatorSequences(ast);
  const sa = analyzeStringArray(ast);
  if (!sa) {
    if (!sandbox) await fallback(ast, { onLog, bump });
    return;
  }
  const { decoder, holder } = sa;

  // decoder'a giden adlar: kendisi ve sabit takma adları (var w = D)
  const sites = [];
  let programPath = null;
  traverse(ast, {
    Program(p) { programPath = p; },
  });
  const rootBinding = programPath.scope.getBinding(decoder.name);
  if (!rootBinding) return;
  const decoderPath = rootBinding.path.isVariableDeclarator() ? rootBinding.path.parentPath : rootBinding.path;
  const rotatorPath = sa.rotator ? programPath.get(`body.${sa.rotIndex}`) : null;
  const inside = (r) => r.findParent((x) => x === decoderPath || x === rotatorPath);

  const queue = [rootBinding];
  const seen = new Set();
  while (queue.length && sites.length < MAX_CALLS) {
    const b = queue.pop();
    if (seen.has(b)) continue;
    seen.add(b);
    if (b !== rootBinding && !b.constant) continue;
    for (const r of b.referencePaths) {
      if (inside(r)) continue;
      const par = r.parentPath;
      if (par.isCallExpression({ callee: r.node })) sites.push(par);
      else if (par.isVariableDeclarator({ init: r.node }) && t.isIdentifier(par.node.id)) {
        const alias = par.scope.getBinding(par.node.id.name);
        if (alias) queue.push(alias);
      }
    }
  }

  // indeks → kullanılan anahtarlar: önbellek indeks başına tutulduğu için farklı anahtarlı çağrıların
  // sonucu çağrı sırasına bağlıdır; önbellekte olmayan böyle indeksler çözülmez
  const jobs = [];
  const keysByIndex = new Map();
  for (const site of sites) {
    const args = argsOf(site.node, sa.env);
    if (!args || !args.length) continue;
    let index;
    try { index = evaluate(decoder.rhs, { vars: { [decoder.param]: args[0] } }); } catch (e) {
      if (e instanceof Unsupported) continue;
      throw e;
    }
    if (!keysByIndex.has(index)) keysByIndex.set(index, new Set());
    keysByIndex.get(index).add(args[1]);
    jobs.push({ site, args, index });
  }

  let n = 0;
  for (const j of jobs) {
    if (decoder.encoding !== 'none' && !sa.model.cacheHas(j.index) && keysByIndex.get(j.index).size > 1) continue;
    let v;
    try { v = sa.model.decode(j.args); } catch (e) {
      if (isThrown(e)) continue;
      throw e;
    }
    if (typeof v !== 'string' || !j.site.node) continue;
    j.site.replaceWith(t.stringLiteral(v));
    n++;
  }
  if (n) {
    onLog(`static-strings: ${holder.name}/${decoder.name} statik çözüldü (kodlama ${decoder.encoding}, ofset ${decoder.offset}, rotasyon ${sa.rotations}) — ${n}/${sites.length} çağrı`, 'info');
    bump('staticStrings', n);
  }

  // temizlik: kullanılmayan takma adlar, decoder, rotasyon ve dizi
  programPath.scope.crawl();
  traverse(ast, {
    VariableDeclarator(p) {
      if (!t.isIdentifier(p.node.id) || !t.isIdentifier(p.node.init, { name: decoder.name })) return;
      const b = p.scope.getBinding(p.node.id.name);
      if (b?.constant && !b.referenced) p.remove();
    },
  });
  programPath.scope.crawl();
  const db = programPath.scope.getBinding(decoder.name);
  const onlyInternal = (b, ...owners) => b && b.referencePaths.every((r) => r.findParent((x) => owners.includes(x)));
  const hb = () => programPath.scope.getBinding(holder.name);
  if (!onlyInternal(db, decoderPath, rotatorPath)) return;
  if (rotatorPath?.node) rotatorPath.remove();
  decoderPath.remove();
  programPath.scope.crawl();
  const holderBinding = hb();
  const holderPath = holderBinding?.path.isVariableDeclarator() ? holderBinding.path : holderBinding?.path;
  if (holderBinding && onlyInternal(holderBinding, holderPath)) holderPath.remove();
  onLog(`static-strings: decoder, rotasyon ve dizi kaldırıldı`, 'info');
}

function countRefs(root, name, skip) {
  let n = 0;
  const visit = (node) => {
    if (!node || typeof node !== 'object' || node === skip) return;
    if (t.isIdentifier(node, { name })) n++;
    for (const k of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(visit); else visit(v);
    }
  };
  visit(root);
  return n;
}

async function fallback(ast, { onLog, bump }) {
  const report = analyzeStringTables(ast);
  let total = 0;
  for (const r of report) {
    if (r.rotation.rotation === null) continue;
    let n = 0;
    for (const c of r.calls_) {
      const v = r.values.get(JSON.stringify(c.args));
      if (c.inRotator || !v || typeof v.value !== 'string' || !c.path.node) continue;
      c.path.replaceWith(t.stringLiteral(v.value));
      n++;
    }
    if (!n) continue;
    total += n;
    onLog(`static-strings (yedek): ${r.table} tablosundan ${n} çağrı statik olarak çözüldü (rotasyon ${r.rotation.rotation})`, 'info');
    // artık çağrılmayan decoder'lar (rotasyon deyimindeki checksum çağrıları sayılmaz), rotasyon deyimi ve tablo
    const body = ast.program.body;
    const decNames = r.decoder.split(', ');
    const isRot = (s) => t.isExpressionStatement(s) && countRefs(s, r.table) > 0 && /push/.test(JSON.stringify(s)) && /shift/.test(JSON.stringify(s));
    const rot = body.find(isRot) ?? null;
    const live = decNames.filter((name) => {
      const fn = body.find((s) => t.isFunctionDeclaration(s) && s.id?.name === name);
      const outside = countRefs(ast.program, name, fn) - (rot ? countRefs(rot, name) : 0);
      return outside > 0;
    });
    if (live.length) continue;
    for (const name of decNames) {
      const fn = body.find((s) => t.isFunctionDeclaration(s) && s.id?.name === name);
      if (fn) body.splice(body.indexOf(fn), 1);
    }
    if (rot) body.splice(body.indexOf(rot), 1);
    const tableStmt = body.find((s) => (t.isFunctionDeclaration(s) && s.id?.name === r.table) ||
      (t.isVariableDeclaration(s) && s.declarations.some((d) => t.isIdentifier(d.id, { name: r.table }))));
    if (tableStmt && countRefs(ast.program, r.table, tableStmt) === 0) body.splice(body.indexOf(tableStmt), 1);
  }
  bump('staticStrings', total);
}
