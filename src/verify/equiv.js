import * as t from '@babel/types';
import { parse } from '../core/parse.js';
import { gen } from '../util/ast.js';
import { proveEquivalent, synthesizeInputs } from '../symbolic/verify.js';
import { argVectors, toSource } from './grammar.js';

// I179: fonksiyon bazında eşdeğerlik testi. Girdi ve çıktıdaki üst seviye fonksiyonlar eşleştirilir; her çift
// iki ayrı sandbox bağlamında aynı argümanlarla çağrılıp sonuçlar karşılaştırılır. Argümanlar: sembolik motorun
// her yol için ürettiği girdiler (E739) + gramer üreteci (E740). Motorun desteklediği fonksiyonlar için SMT ile
// tüm int32 girdilerde denklik kanıtı (E701) denenir; ayrışmada karşı örnek küçültülür (E705).

const ENC = `globalThis.__peelEnc = function (v) {
  var t = typeof v;
  if (t === "number") return "n:" + (Object.is(v, -0) ? "-0" : String(v));
  if (t === "string" || t === "boolean" || t === "bigint" || t === "undefined") return t[0] + ":" + String(v);
  if (t === "symbol") return "y:" + String(v.description);
  if (t === "function") return "f:" + v.length;
  if (v === null) return "null";
  var seen = [];
  try {
    return "o:" + JSON.stringify(v, function (k, x) {
      if (typeof x === "object" && x !== null) { if (seen.indexOf(x) >= 0) return "[döngü]"; seen.push(x); }
      if (typeof x === "function") return "[fn " + x.length + "]";
      if (typeof x === "number" && x !== x) return "[NaN]";
      return x;
    });
  } catch (e) { return "o:?"; }
};
globalThis.__peelEq = function (fn, args) {
  try { return __peelEnc(fn.apply(null, args)); } catch (e) { return "throw:" + (e && e.name); }
};`;

// Üst seviye fonksiyonlar: bildirimler ve `var f = function/arrow`
export function topFunctions(code) {
  let ast;
  try { ast = parse(code); } catch { return []; }
  const out = [];
  for (const s of ast.program.body) {
    if (t.isFunctionDeclaration(s) && s.id && !s.async && !s.generator) out.push({ name: s.id.name, arity: s.params.length, src: gen(s) });
    if (t.isVariableDeclaration(s)) {
      for (const d of s.declarations) {
        if (t.isIdentifier(d.id) && (t.isFunctionExpression(d.init) || t.isArrowFunctionExpression(d.init)) && !d.init.async && !d.init.generator) {
          out.push({ name: d.id.name, arity: d.init.params.length, src: `${s.kind} ${d.id.name} = ${gen(d.init)};` });
        }
      }
    }
  }
  return out.slice(0, 200);
}

// Önce aynı isim, sonra aynı arity'de sıra (rename sonrası isimler değişir)
export function matchFunctions(a, b) {
  const pairs = [];
  const usedB = new Set();
  const byName = new Map(b.map((f) => [f.name, f]));
  const restA = [];
  for (const f of a) {
    const g = byName.get(f.name);
    if (g && g.arity === f.arity) { pairs.push([f, g, 'isim']); usedB.add(g.name); } else restA.push(f);
  }
  const restB = b.filter((f) => !usedB.has(f.name));
  for (const f of restA) {
    const i = restB.findIndex((g) => g.arity === f.arity);
    if (i >= 0) pairs.push([f, restB.splice(i, 1)[0], 'sıra']);
  }
  return pairs;
}

async function callBoth(sandbox, ta, tb, fa, fb, args) {
  const ex = (f) => `__peelEq(${f.name}, ${toSource(args)})`;
  const [ra, rb] = [await sandbox.batchIn(ta, [ex(fa)]), await sandbox.batchIn(tb, [ex(fb)])];
  return [ra.results?.[0]?.value ?? `hata:${ra.error}`, rb.results?.[0]?.value ?? `hata:${rb.error}`];
}

// E705 (test tabanlı): ayrışan argümanları basitleştir — her konumda daha basit adayları dene
const SIMPLER = (v) => {
  if (typeof v === 'number') return [0, 1, -1, Math.trunc(v / 2)].filter((x) => x !== v);
  if (typeof v === 'string') return ['', v.slice(0, Math.floor(v.length / 2))].filter((x) => x !== v);
  if (Array.isArray(v)) return [[], v.slice(0, Math.floor(v.length / 2))].filter((x) => x.length < v.length);
  if (v && typeof v === 'object') return [{}];
  return v === undefined ? [] : [undefined];
};

async function shrink(sandbox, ta, tb, fa, fb, args) {
  let cur = args;
  for (let round = 0; round < 4; round++) {
    let progressed = false;
    for (let i = 0; i < cur.length; i++) {
      for (const c of SIMPLER(cur[i])) {
        const trial = cur.map((x, j) => (j === i ? c : x));
        const [x, y] = await callBoth(sandbox, ta, tb, fa, fb, trial);
        if (x !== y) { cur = trial; progressed = true; break; }
      }
    }
    if (!progressed) break;
  }
  return cur;
}

export async function functionEquivalence(sandbox, codeA, codeB, { samples = 12, seed = 5, smt = true, budget = null, timeoutMs = 3000 } = {}) {
  const pairs = matchFunctions(topFunctions(codeA), topFunctions(codeB));
  if (!pairs.length) return { pairs: [], tested: 0, proved: 0, differs: 0, note: 'eşleşen üst seviye fonksiyon yok' };
  const oa = await sandbox.open(codeA, { timeoutMs: 6000 });
  const ob = await sandbox.open(codeB, { timeoutMs: 6000 });
  const results = [];
  try {
    if (!oa.ok || !ob.ok) throw new Error(`bağlam açılamadı: ${oa.error ?? ob.error}`);
    await sandbox.evalIn(oa.token, ENC, {});
    await sandbox.evalIn(ob.token, ENC, {});
    for (const [fa, fb, by] of pairs.slice(0, 40)) {
      if (budget?.exhausted?.()) { results.push({ a: fa.name, b: fb.name, by, status: 'skipped', reason: 'bütçe' }); continue; }
      const res = { a: fa.name, b: fb.name, by, status: 'equal', samples: 0 };
      // sembolik girdiler: çıktı fonksiyonunun her yolunu dolaşan int32 vektörleri
      let vectors = [];
      try {
        const syn = synthesizeInputs(fb.src, { maxPaths: 16 });
        if (syn.status === 'ok' || syn.inputs?.length) vectors = syn.inputs.slice(0, 16);
      } catch { /* motor desteklemiyor */ }
      vectors.push(...argVectors(fb.arity, samples, seed));
      for (const args of vectors) {
        const [x, y] = await callBoth(sandbox, oa.token, ob.token, fa, fb, args);
        budget?.charge?.({ runs: 2 });
        res.samples++;
        if (x !== y) {
          res.status = 'differs';
          res.counterexample = args;
          res.minimized = await shrink(sandbox, oa.token, ob.token, fa, fb, args);
          res.results = await callBoth(sandbox, oa.token, ob.token, fa, fb, res.minimized);
          break;
        }
      }
      if (res.status === 'equal' && smt) {
        const left = budget ? Math.min(timeoutMs, budget.solverLeft()) : timeoutMs;
        if (left > 50) {
          const t0 = Date.now();
          const p = await proveEquivalent(fa.src, fb.src, { backend: 'auto', timeoutMs: left }).catch((e) => ({ status: 'unknown', reason: e.message }));
          budget?.charge?.({ solverMs: Date.now() - t0 });
          res.proof = { status: p.status, backend: p.backend ?? null, checked: p.checked ?? false, reason: p.reason ?? null, counterexample: p.minimized ?? p.counterexample ?? null };
          if (p.status === 'proved') res.status = 'proved';
          // çözücünün karşı örneği somut çalıştırmayla teyit edilir (model ile JS anlamı ayrışırsa kanıt sayılmaz)
          if (p.status === 'refuted') {
            const witnessArgs = p.minimized ?? p.counterexample;
            const [x, y] = await callBoth(sandbox, oa.token, ob.token, fa, fb, witnessArgs);
            res.proof.confirmed = x !== y;
            if (x !== y) { res.status = 'differs'; res.counterexample = p.counterexample; res.minimized = witnessArgs; res.results = [x, y]; }
          }
        }
      }
      results.push(res);
    }
  } finally {
    if (oa.ok) await sandbox.close(oa.token);
    if (ob.ok) await sandbox.close(ob.token);
  }
  return {
    pairs: results,
    tested: results.filter((r) => r.status !== 'skipped').length,
    proved: results.filter((r) => r.status === 'proved').length,
    differs: results.filter((r) => r.status === 'differs').length,
  };
}
