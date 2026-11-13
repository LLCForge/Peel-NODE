// Motor stratejileri (E32, E33, E34, E36): pass sırası arama, kademeli saldırı, bağımlı pass'leri kapsayan
// geri alma zinciri ve seçili bölgede artımlı çözme. Hepsi deobfuscate()'i farklı ayarlarla çağırır;
// sonuçlar gizlilik skoruyla (düşük = daha okunur) ve davranış doğrulamasıyla karşılaştırılır.
import * as t from '@babel/types';
import { deobfuscate } from './pipeline.js';
import { PASSES } from './registry.js';
import { parse } from './parse.js';
import { traverse, generate } from '../util/ast.js';
import { snapshot, same } from './behavior.js';
import { tokenize, align } from '../ui/srcmap.js';
import { createTrace } from '../analysis/trace.js';

// Gizlilik skoru: gizleme kalıntıları ağırlıklı; boyut küçük etkili (eşitlik bozucu)
export function obfuscationScore(code) {
  let ast;
  try { ast = parse(code); } catch { return Infinity; }
  let ids = 0;
  let hexCalls = 0;
  let dispatchers = 0;
  let escapes = 0;
  traverse(ast, {
    Identifier(p) { if (/^(_0x[0-9a-f]+|__p_\w+)$/i.test(p.node.name)) ids++; },
    CallExpression(p) {
      const a = p.node.arguments;
      if (t.isIdentifier(p.node.callee) && a.length && a.length <= 3 && t.isNumericLiteral(a[0])) hexCalls++;
    },
    SwitchStatement(p) { if (p.findParent((x) => x.isLoop())) dispatchers++; },
    StringLiteral(p) { if (/\\x|\\u/.test(p.node.extra?.raw ?? '')) escapes++; },
  });
  return ids * 2 + hexCalls * 5 + dispatchers * 20 + escapes + code.length / 2000;
}

const AST_IDS = PASSES.filter((p) => p.kind === 'ast').map((p) => p.id);
const move = (list, ids, front) => {
  const picked = list.filter((x) => ids.includes(x));
  const rest = list.filter((x) => !ids.includes(x));
  return front ? [...picked, ...rest] : [...rest, ...picked];
};

// Aday sıralar: kayıt sırası, decoder'lar önce, yapı önce, ters, ve tohumlu rastgele karıştırmalar
export function candidateOrders(extra = 2, seed = 7) {
  const out = [
    { name: 'varsayılan', order: AST_IDS },
    { name: 'decoder önce', order: move(AST_IDS, ['static-decode', 'string-array', 'runtime-decoders', 'wrappers', 'const-fold'], true) },
    { name: 'yapı önce', order: move(AST_IDS, ['dispatcher', 'unflatten', 'control-flow', 'state-var', 'dead-code', 'opaque', 'restructure'], true) },
    { name: 'ters', order: [...AST_IDS].reverse() },
  ];
  let s = seed;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 2 ** 32; };
  for (let k = 0; k < extra; k++) {
    const o = [...AST_IDS];
    for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
    out.push({ name: `karışık #${k + 1}`, order: o });
  }
  return out;
}

/** E32: aday sıraları dener, doğrulanmış ve skoru en düşük sonucu seçer */
export async function searchPassOrder(input, { sandbox = null, level = 4, extra = 2, signal = null, onLog = () => {} } = {}) {
  const tried = [];
  for (const cand of candidateOrders(extra)) {
    if (signal?.aborted) break;
    const r = await deobfuscate(input, { level, order: cand.order, sandbox, deep: Boolean(sandbox), signal });
    if (r.error) { tried.push({ name: cand.name, error: r.error }); continue; }
    const score = obfuscationScore(r.code);
    tried.push({ name: cand.name, order: cand.order, score: Number(score.toFixed(2)), verified: Boolean(r.verified), rollbacks: r.events.filter((e) => e.state === 'fail').length, code: r.code });
    onLog(`sıra arama: ${cand.name} → skor ${score.toFixed(1)}`, 'info');
  }
  const ok = tried.filter((x) => !x.error);
  // doğrulanmış sonuçlar doğrulanmamışlardan önce gelir; sonra skor, sonra geri alma sayısı
  ok.sort((a, b) => Number(b.verified) - Number(a.verified) || a.score - b.score || a.rollbacks - b.rollbacks);
  return { best: ok[0] ?? null, tried: tried.map(({ code, ...x }) => x) };
}

/** E33: kademeli saldırı — seviye 1'den 4'e, her aşamanın doğrulanmış çıktısı bir sonrakinin girdisi */
export async function cascade(input, { sandbox = null, signal = null, onLog = () => {} } = {}) {
  const stages = [];
  let code = input;
  let best = obfuscationScore(input);
  for (const level of [1, 2, 3, 4]) {
    if (signal?.aborted) break;
    const r = await deobfuscate(code, { level, sandbox, deep: Boolean(sandbox), signal });
    if (r.error) { stages.push({ level, error: r.error }); break; }
    const score = obfuscationScore(r.code);
    const improved = score < best - 0.01;
    stages.push({ level, score: Number(score.toFixed(2)), improved, verified: Boolean(r.verified), rollbacks: r.events.filter((e) => e.state === 'fail').length });
    onLog(`kademe ${level}: skor ${score.toFixed(1)}${improved ? '' : ' (iyileşme yok)'}`, 'info');
    // sandbox varken doğrulanamayan aşama kabul edilmez: bir önceki doğrulanmış kod korunur
    if (sandbox && !r.verified) continue;
    if (improved || level === 1) { code = r.code; best = Math.min(best, score); }
  }
  return { code, score: Number(best.toFixed(2)), stages };
}

/**
 * E34: zaman çizelgesi anlık görüntülerinden davranışı ilk bozan pass'i bulur (ikili arama), o pass'i
 * ve ona dayanarak sonradan değişiklik yapan tüm pass'leri geri alır, ardından bozucu pass'i dışarıda
 * bırakarak yeniden çalıştırır (bağımlı pass'ler kendi doğrulamalarıyla yeniden uygulanır).
 */
export async function rollbackChain(input, snapshots, { sandbox, level = 4, signal = null } = {}) {
  if (!sandbox) throw new Error('geri alma zinciri sandbox gerektirir');
  const base = await snapshot(sandbox, input);
  if (!base.ok) return { culprit: null, reason: `girdi çalıştırılamadı: ${base.reason}` };
  const steps = snapshots.filter((s) => s.id !== 'girdi');
  const okAt = async (i) => same(base, await snapshot(sandbox, steps[i].code));
  if (!steps.length || await okAt(steps.length - 1)) return { culprit: null, reason: 'son çıktı girdiyle aynı davranıyor' };
  let lo = 0;
  let hi = steps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (await okAt(mid)) lo = mid + 1; else hi = mid;
  }
  const culprit = steps[lo];
  const dependents = [...new Set(steps.slice(lo + 1).map((s) => s.id))].filter((id) => id !== culprit.id);
  const only = PASSES.filter((p) => p.level <= level && p.id !== culprit.id).map((p) => p.id);
  const rerun = await deobfuscate(input, { only, sandbox, deep: true, signal });
  const fixed = !rerun.error && same(base, await snapshot(sandbox, rerun.code));
  return { culprit: { id: culprit.id, round: culprit.round }, dependents, excluded: [culprit.id], code: rerun.code, fixed };
}


/**
 * E36: seçili bölgede artımlı çözme. Bölge tüm programın bağlamıyla çözülür (decoder'lar, sabit tablolar seçim
 * dışında olabilir) ve yalnızca bölgenin çözülmüş karşılığı orijinal koda yerleştirilir; geri kalan kod değişmez.
 *  - Seçimi kapsayan bir fonksiyon varsa o fonksiyon bir yönerge ile işaretlenir, çıktıda bulunup yerine konur.
 *  - Program seviyesindeki seçimde seçimle kesişen üst seviye deyimler bölgedir; çıktının üst seviye deyimleri
 *    girdi/çıktı token hizalamasıyla (ui/srcmap.js) bu bölgeye atanır.
 * Bölge dışarıda olmayan adlara bağlıysa ya da birleşik program davranışı değişirse reddedilir.
 * Dönüş: { ok, code, region: { from, to } (orijinal koddaki değiştirilen aralık), before, after } ya da { ok: false, reason }
 */
const MARK = 'peel:region';
const ONLY = (level) => PASSES.filter((p) => p.level <= level && p.id !== 'rename').map((p) => p.id);

function freeNames(path) {
  const free = new Set();
  path.traverse({
    Identifier(q) {
      if (!q.isReferencedIdentifier()) return;
      const b = q.scope.getBinding(q.node.name);
      if (!b || !(b.path === path || b.path.findParent((x) => x === path))) free.add(q.node.name);
    },
  });
  return free;
}

async function finish(code, from, to, piece, free, sandbox) {
  const known = new Set();
  traverse(parse(code), { Identifier(q) { known.add(q.node.name); } });
  const unknown = [...free].filter((n) => !known.has(n) && !(n in globalThis));
  if (unknown.length) return { ok: false, reason: `bölge dışarıda olmayan adlara bağlı: ${unknown.slice(0, 5).join(', ')}` };
  const merged = code.slice(0, from) + piece + code.slice(to);
  try { parse(merged); } catch (e) { return { ok: false, reason: `birleştirilen kod parse edilemedi: ${e.message}` }; }
  if (sandbox) {
    const [a, b] = [await snapshot(sandbox, code), await snapshot(sandbox, merged)];
    if (a.ok && !same(a, b)) return { ok: false, reason: 'bölge değişikliği davranışı değiştirdi' };
  }
  return { ok: true, code: merged, region: { from, to, start: from, end: from + piece.length }, before: code.slice(from, to), after: piece };
}

async function functionRegion(code, ast, target, { sandbox, level, signal }) {
  const { start: from, end: to } = target.node;
  target.node.body.directives.unshift(t.directive(t.directiveLiteral(MARK)));
  const marked = generate(ast, { jsescOption: { minimal: true } }).code;
  const r = await deobfuscate(marked, { only: ONLY(level), sandbox, deep: Boolean(sandbox), signal });
  if (r.error) return { ok: false, reason: r.error };
  let piece = null;
  let free = null;
  traverse(parse(r.code), {
    Function(p) {
      const dirs = p.node.body?.directives ?? [];
      const i = dirs.findIndex((d) => d.value.value === MARK);
      if (i < 0 || piece) return;
      dirs.splice(i, 1);
      free = freeNames(p);
      piece = generate(p.node, { jsescOption: { minimal: true } }).code;
    },
  });
  if (!piece) return { ok: false, reason: 'çözülmüş kodda bölge bulunamadı (fonksiyon kaldırıldı ya da satır içine alındı)' };
  return finish(code, from, to, piece, free, sandbox);
}

async function programRegion(code, ast, start, end, { sandbox, level, signal }) {
  const body = ast.program.body;
  const hit = body.filter((s) => s.end > start && s.start < Math.max(end, start + 1));
  if (!hit.length) return { ok: false, reason: 'seçim bir deyimle kesişmiyor' };
  const from = hit[0].start;
  const to = hit[hit.length - 1].end;
  // bölge sınırları yorum işaretleriyle taşınır; izleyici (keepComments) pass'lerin kaybettiği yorumları
  // eşlenen düğümlere geri takar. İşaretler çıktıda sırasıyla bulunursa aradaki metin bölgedir.
  hit[0].leadingComments = [...(hit[0].leadingComments ?? []), { type: 'CommentBlock', value: `${MARK}:start` }];
  const last = hit[hit.length - 1];
  last.trailingComments = [...(last.trailingComments ?? []), { type: 'CommentBlock', value: `${MARK}:end` }];
  const marked = generate(ast, { comments: true, jsescOption: { minimal: true } }).code;
  const r = await deobfuscate(marked, { only: ONLY(level), sandbox, deep: Boolean(sandbox), signal, trace: createTrace({ keepComments: true }) });
  if (r.error) return { ok: false, reason: r.error };
  const out = r.code;
  const s0 = out.indexOf(`/*${MARK}:start*/`);
  const s1 = out.indexOf(`/*${MARK}:end*/`);
  if (s0 >= 0 && s1 > s0) {
    const piece = out.slice(s0 + `/*${MARK}:start*/`.length, s1).trim();
    let pieceAst;
    try { pieceAst = parse(piece); } catch { pieceAst = null; }
    if (pieceAst) {
      let free = new Set();
      traverse(pieceAst, { Program(p) { free = freeNames(p); p.stop(); } });
      if (piece) return finish(code, from, to, piece, free, sandbox);
    }
  }
  // işaretler kaybolduysa: çıktının üst seviye deyimleri token hizalamasıyla bölgeye atanır
  const clean = (x) => x.split(`/*${MARK}:start*/`).join('').split(`/*${MARK}:end*/`).join('');
  return alignedRegion(code, clean(out), from, to, sandbox);
}

async function alignedRegion(code, out, from, to, sandbox) {
  const A = tokenize(out);
  const B = tokenize(code);
  if (!A || !B) return { ok: false, reason: 'kod token dizisine ayrılamadı' };
  const pairs = align(A, B);
  const outAst = parse(out);
  const picked = [];
  traverse(outAst, {
    Program(prog) {
      // eşleşmesi olmayan deyim sıradaki konumunu bir önceki deyimden devralır
      let prevInside = false;
      for (const sp of prog.get('body')) {
        let inside = 0;
        let outside = 0;
        for (const [i, j] of pairs) {
          if (A[i].start < sp.node.start || A[i].start >= sp.node.end) continue;
          if (B[j].start >= from && B[j].start < to) inside++; else outside++;
        }
        const isIn = inside || outside ? inside > outside : prevInside;
        if (isIn) picked.push(sp);
        prevInside = isIn;
      }
      prog.stop();
    },
  });
  if (!picked.length) return { ok: false, reason: 'bölgenin çözülmüş karşılığı yok (tamamen sadeleşti ya da başka deyimlere taşındı)' };
  const free = new Set();
  for (const sp of picked) for (const n of freeNames(sp)) free.add(n);
  // bölgedeki deyimlerin bildirdiği adlar dışarıdan kullanılabilir: orijinalde de bildirilmiş olmalı
  const piece = picked.map((sp) => out.slice(sp.node.start, sp.node.end)).join('\n');
  return finish(code, from, to, piece, free, sandbox);
}

export async function deobfuscateRegion(code, start, end, { sandbox = null, level = 4, signal = null } = {}) {
  let ast;
  try { ast = parse(code); } catch (e) { return { ok: false, reason: e.message }; }
  let target = null;
  traverse(ast, {
    Function(p) {
      const n = p.node;
      if (n.start <= start && n.end >= end && t.isBlockStatement(n.body)) {
        if (!target || n.end - n.start < target.node.end - target.node.start) target = p;
      }
    },
  });
  if (target) {
    const r = await functionRegion(code, ast, target, { sandbox, level, signal });
    if (r.ok) return r;
  }
  return programRegion(code, parse(code), start, end, { sandbox, level, signal });
}
