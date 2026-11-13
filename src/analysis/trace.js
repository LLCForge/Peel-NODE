import * as t from '@babel/types';
import { parse } from '../core/parse.js';
import { raw } from '../core/emit.js';
import { fnv1a } from '../util/hash.js';
import { structuralHash, stableIds } from './nodehash.js';
import { matchTrees } from './match.js';
import { diffAst, applyPatch, invertPatch, patchSummary } from './patch.js';
import { serializeAst, deserializeAst } from './serialize.js';
import { SnapshotStore } from './store.js';
import { AnalysisSession } from './session.js';
import { passDag, passConflicts, interactionMatrix, costOrder } from './passgraph.js';

// Pipeline izleyicisi: her pass için kayıt, yama günlüğü (E559/E562), düğüm eşleme (E563), köken (E557),
// gerekçe (E558), not kanalı (E564), yorum koruma (E565), kontrol noktası (E547), yapısal paylaşım (E548),
// artımlı analiz (E549/E550/E553), pass grafiği (E541–E544).

export const CHECKPOINT_FORMAT = 'peel-checkpoint';
const MAX_RATIONALE = 200;
const MAX_PATCHES = 400;

const isUnit = (n) => t.isFunction(n) || t.isProgram(n);

function forEachNode(root, fn, parent = null) {
  const stack = [[root, parent]];
  while (stack.length) {
    const [n, p] = stack.pop();
    if (!n || typeof n.type !== 'string') continue;
    fn(n, p);
    const keys = t.VISITOR_KEYS[n.type] ?? [];
    for (let k = keys.length - 1; k >= 0; k--) {
      const v = n[keys[k]];
      if (Array.isArray(v)) for (let i = v.length - 1; i >= 0; i--) stack.push([v[i], n]); else if (v) stack.push([v, n]);
    }
  }
}

// yorum anahtarı boşluktan bağımsız: üretici çok satırlı yorumların girintisini değiştirir, yoksa yorum
// "kayboldu" sanılıp her turda bir kopya daha takılır
const commentKey = (value) => value.replace(/\s+/g, ' ').trim();

function commentsOf(root) {
  const out = new Map(); // normalize yorum metni → { comment, anchor, where }
  forEachNode(root, (n) => {
    for (const where of ['leadingComments', 'trailingComments', 'innerComments']) {
      for (const c of n[where] ?? []) if (!out.has(commentKey(c.value))) out.set(commentKey(c.value), { comment: c, anchor: n, where });
    }
  });
  return out;
}

function unitLabel(n, parent) {
  if (t.isProgram(n)) return 'program';
  if (n.id?.name) return n.id.name;
  if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) return parent.id.name;
  if ((t.isObjectMethod(n) || t.isClassMethod(n)) && t.isIdentifier(n.key)) return n.key.name;
  return '(anonim)';
}

export function restoreCheckpoint(cp) {
  const obj = typeof cp === 'string' ? JSON.parse(cp) : cp;
  if (!obj || obj.format !== CHECKPOINT_FORMAT) throw new Error('kontrol noktası: biçim tanınmadı');
  if (obj.version !== 1) throw new Error(`kontrol noktası: desteklenmeyen sürüm ${obj.version}`);
  if (typeof obj.code !== 'string' || fnv1a(obj.code) !== obj.codeHash) throw new Error('kontrol noktası: kod özeti tutmuyor');
  // kod parse edilebilmeli; ayrıca sürümlü AST (varsa) aynı kodu üretmeli
  const ast = parse(obj.code);
  if (obj.ast && structuralHash(deserializeAst(obj.ast)) !== structuralHash(ast.program)) throw new Error('kontrol noktası: AST ile kod uyuşmuyor');
  return { code: obj.code, text: obj.text ?? obj.code, round: obj.round, stats: { ...(obj.stats ?? {}) } };
}

/**
 * @param {object} o
 * @param {boolean} o.keepComments  pass'lerin kaybettiği yorumları eşlenen düğümlere geri tak
 * @param {number}  o.lightAbove    bu boyutun üstündeki kodda yalnızca hash/gerekçe tutulur (AST işlemleri atlanır)
 */
export function createTrace({ keepComments = false, lightAbove = 250_000 } = {}) {
  const records = [];
  const rationale = [];
  const patches = [];
  const checkpoints = [];
  const dirtyLog = [];
  const matchLog = [];
  const store = new SnapshotStore();
  const session = new AnalysisSession();
  let passes = [];
  let logs = [];
  let prevAst = null;
  let origin = new Map(); // geçerli AST düğümü → girdi konumu
  let notes = new Map(); // geçerli AST düğümü → [not]
  let initialIds = 0;
  const commentStats = { kept: 0, dropped: 0 };
  let light = false;

  const trace = {
    keepComments,

    start(code, enabled = []) {
      passes = enabled.map((p) => ({ id: p.id }));
      light = code.length > lightAbove;
      if (light) return;
      prevAst = parse(code);
      session.update(prevAst);
      try { session.analyzeAll(prevAst); } catch { /* analiz edilemeyen birim: rapor yine üretilir */ }
      forEachNode(prevAst.program, (n) => { if (n.loc) origin.set(n, { line: n.loc.start.line, col: n.loc.start.column }); });
      initialIds = stableIds(prevAst).size;
      store.add(prevAst, { id: 'girdi', round: 0 });
    },

    log(message, level) { logs.push({ message, level }); },

    // başarısız/atlanan pass
    record(id, round, state, code, ms = 0, reason = null) {
      const h = fnv1a(code);
      records.push({ id, round, state, before: h, after: h, ms });
      if ((state === 'fail' || logs.length) && rationale.length < MAX_RATIONALE) rationale.push({ id, round, state, reason, logs: logs.map((l) => l.message), changes: null });
      logs = [];
    },

    /** Başarılı pass: kayıt, yama, eşleme, köken/not taşıma, yorum koruma. Döndürür: (yorumlarla) son kod. */
    commit(id, round, before, after, ms = 0) {
      let out = after;
      const entry = { id, round, state: 'ok', reason: null, logs: logs.map((l) => l.message), changes: null };
      logs = [];
      if (!light && prevAst) {
        let nextAst;
        try { nextAst = parse(after); } catch { nextAst = null; }
        if (nextAst) {
          const patch = diffAst(prevAst.program, nextAst.program);
          entry.changes = patchSummary(patch);
          if (patches.length < MAX_PATCHES) patches.push({ id, round, patch });
          const m = matchTrees(prevAst, nextAst);
          matchLog.push({ id, round, ...m.stats });
          // köken ve notlar: eşlenen düğümden; eşlenmeyen yeni düğüm en yakın eşlenmiş atadan alır
          const nextOrigin = new Map();
          const nextNotes = new Map();
          const changedStatements = new Set();
          forEachNode(nextAst.program, (n, parent) => {
            const src = m.reverse.get(n);
            if (src) {
              if (origin.has(src)) nextOrigin.set(n, origin.get(src));
              if (notes.has(src)) nextNotes.set(n, [...notes.get(src)]);
            } else {
              if (parent && nextOrigin.has(parent)) nextOrigin.set(n, nextOrigin.get(parent));
              let s = n;
              let q = parent;
              const parents = m.parentB;
              while (s && !t.isStatement(s) && !isUnit(s)) { s = q; q = s ? parents?.get(s) : null; }
              if (s) changedStatements.add(s);
            }
          });
          for (const s of changedStatements) {
            const list = nextNotes.get(s) ?? [];
            if (!list.includes(`${id}#${round}`)) list.push(`${id}#${round}`);
            nextNotes.set(s, list);
          }
          // E565: kaybolan yorumlar eşlenen düğümlere geri takılır
          if (keepComments) {
            const was = commentsOf(prevAst.program);
            const now = commentsOf(nextAst.program);
            let reattached = 0;
            for (const [text, info] of was) {
              if (now.has(text)) continue;
              let anchor = info.anchor;
              let target = m.map.get(anchor);
              // düğüm kaybolduysa yorum yalnızca eşlenmiş bir deyim atasına taşınır; o da yoksa düşer
              while (!target && anchor && !t.isStatement(anchor)) { anchor = m.parentA.get(anchor); target = anchor ? m.map.get(anchor) : null; }
              if (!target || t.isProgram(target)) { commentStats.dropped++; continue; }
              const where = info.where === 'innerComments' ? 'leadingComments' : info.where;
              if ((target[where] ?? []).some((c) => commentKey(c.value) === text)) continue;
              target[where] = [...(target[where] ?? []), { type: info.comment.type, value: info.comment.value }];
              reattached++;
            }
            if (reattached) {
              const code = raw(nextAst);
              try { parse(code); out = code; commentStats.kept += reattached; } catch { commentStats.dropped += reattached; }
            }
          }
          origin = nextOrigin;
          notes = nextNotes;
          store.add(nextAst, { id, round });
          const d = session.update(nextAst);
          // E549: yalnızca hash'i değişen birimler yeniden analiz edilir, diğerleri önbellekten
          const hitsBefore = session.stats.hits;
          let analyzed = 0;
          try { analyzed = session.analyzeAll(nextAst).analyzed; } catch { analyzed = -1; }
          dirtyLog.push({ id, round, changed: d.changed.length, added: d.added.length, removed: d.removed.length, clean: d.clean.length, analyzed, reused: session.stats.hits - hitsBefore });
          prevAst = nextAst;
        }
      }
      records.push({ id, round, state: 'ok', before: fnv1a(before), after: fnv1a(out), ms });
      if (rationale.length < MAX_RATIONALE) rationale.push(entry);
      return out;
    },

    /** E564: geçerli ağaçtaki bir düğüme not ekler (yorumlardan ayrı, pass'ler boyunca taşınır). */
    note(node, text) {
      const list = notes.get(node) ?? [];
      list.push(text);
      notes.set(node, list);
    },

    checkpoint({ round, code, text, stats }) {
      const cp = { format: CHECKPOINT_FORMAT, version: 1, round, code, codeHash: fnv1a(code), text, stats: { ...stats }, ast: light ? null : serializeAst(parse(code).program) };
      checkpoints.push(cp);
      if (checkpoints.length > 3) checkpoints.shift();
      return cp;
    },

    lastCheckpoint: () => checkpoints[checkpoints.length - 1] ?? null,

    /** E559: k. yamaya kadar geri al (k=0: girdiye dön). Kod döner. */
    undoTo(k) {
      if (light || !prevAst) return null;
      let ast = parse(raw(prevAst)).program;
      for (let i = patches.length - 1; i >= k; i--) ast = applyPatch(ast, invertPatch(patches[i].patch));
      return raw(t.file(ast));
    },

    report() {
      const dag = passDag(passes);
      const conflicts = passConflicts(records);
      const matrix = interactionMatrix(records);
      const cost = costOrder(passes, records);
      const out = {
        light,
        dag: { order: dag.order, edges: dag.edges.length, cycles: dag.cycles, violations: dag.violations, undeclared: dag.undeclared },
        conflicts,
        matrix: { ids: matrix.ids, cells: matrix.ids.flatMap((a) => matrix.ids.filter((b) => matrix.enables[a][b] || matrix.breaks[a][b]).map((b) => ({ a, b, enables: matrix.enables[a][b], breaks: matrix.breaks[a][b] }))) },
        cost: { order: cost.order, scores: cost.scores.filter((s) => s.runs) },
        rationale: rationale.slice(0, MAX_RATIONALE),
        checkpoints: checkpoints.map((c) => ({ round: c.round, bytes: c.code.length })),
        store: store.stats(),
        incremental: { perPass: dirtyLog, session: { ...session.stats } },
        matching: matchLog,
        comments: { enabled: keepComments, ...commentStats },
        patches: { count: patches.length, ops: patches.reduce((a, p) => a + p.patch.ops.length, 0), undoVerified: null },
        ids: { initial: initialIds, final: 0, sample: [] },
        provenance: [],
        notes: [],
      };
      if (!light && prevAst) {
        // E559: son yamanın tersi bir önceki görüntüyü birebir üretmeli
        if (patches.length && patches.length === store.roots.length - 1) {
          const last = patches[patches.length - 1];
          try {
            const restored = applyPatch(parse(raw(prevAst)).program, invertPatch(last.patch));
            const before = store.materialize(store.roots.length - 2);
            out.patches.undoVerified = structuralHash(restored) === structuralHash(before);
          } catch {
            out.patches.undoVerified = false;
          }
        }
        const ids = stableIds(prevAst);
        out.ids.final = ids.size;
        out.ids.sample = [...ids.values()].slice(0, 8);
        // E557: son ağaçtaki fonksiyonların girdideki kökeni
        forEachNode(prevAst.program, (n, parent) => {
          if (out.provenance.length >= 60 || !t.isFunction(n)) return;
          const o = origin.get(n);
          out.provenance.push({ name: unitLabel(n, parent), id: ids.get(n) ?? null, origin: o ? o.line : null });
        });
        for (const [n, list] of notes) {
          if (out.notes.length >= 80) break;
          out.notes.push({ id: ids.get(n) ?? n.type, origin: origin.get(n)?.line ?? null, notes: list });
        }
      }
      return out;
    },

    // test ve hata ayıklama için
    _state: () => ({ records, patches, store, session, prevAst, origin, notes }),
  };
  return trace;
}
