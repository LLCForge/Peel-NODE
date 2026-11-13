import * as t from '@babel/types';
import { gen } from '../../util/ast.js';
import { walk } from './detect.js';

// Durum makinesi (switch-in-loop) raporu: case özetleri, geçiş tablosu (koşullarıyla), ulaşılmayan case'ler,
// uçlar, default dalı, durum başına yan etkiler, native API listesi ve giriş noktasına göre bölgeler.

const NATIVE = new Set(['window', 'globalThis', 'self', 'document', 'navigator', 'location', 'console', 'Math', 'JSON',
  'Date', 'String', 'Number', 'Object', 'Array', 'fetch', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'setTimeout',
  'setInterval', 'atob', 'btoa', 'eval', 'Function', 'crypto', 'performance', 'parseInt', 'parseFloat', 'escape', 'unescape',
  'encodeURIComponent', 'decodeURIComponent', 'WebSocket', 'Promise', 'Reflect', 'Symbol', 'RegExp', 'Error', 'alert']);

const pathOf = (n) => {
  if (t.isIdentifier(n)) return n.name;
  if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
    const b = pathOf(n.object);
    return b && `${b}.${n.property.name}`;
  }
  if (t.isMemberExpression(n) && n.computed && (t.isStringLiteral(n.property) || t.isNumericLiteral(n.property))) {
    const b = pathOf(n.object);
    return b && `${b}.${n.property.value}`;
  }
  return null;
};

// Case'in kendi deyimleri (düşme varsa sonraki case'lere ilk break/return'e kadar)
function ownList(sw, i) {
  const out = [];
  for (const c of sw.cases.slice(i)) {
    for (const s of c.consequent) {
      out.push(s);
      if (t.isBreakStatement(s) || t.isContinueStatement(s) || t.isReturnStatement(s) || t.isThrowStatement(s)) return out;
    }
  }
  return out;
}

const writesState = (n, names) => (t.isAssignmentExpression(n) && names.has(pathOf(n.left))) || (t.isUpdateExpression(n) && names.has(pathOf(n.argument)));

// E191: geçiş şablonu — case'in durum güncellemesinin biçimi
export function branchTemplate(stmts, names) {
  let conditional = false;
  let updates = 0;
  let kind = null;
  let term = null;
  const visit = (n, inIf) => {
    if (!n || typeof n !== 'object' || t.isFunction(n)) return;
    if ((t.isReturnStatement(n) || t.isThrowStatement(n)) && !term) term = t.isReturnStatement(n) ? 'return' : 'throw';
    if (writesState(n, names)) {
      updates++;
      if (inIf) conditional = true;
      const rhs = n.right;
      if (t.isUpdateExpression(n) || (n.operator && n.operator !== '=')) kind = kind ?? 'artımlı';
      else if (t.isNumericLiteral(rhs) || t.isStringLiteral(rhs) || (t.isUnaryExpression(rhs, { operator: '-' }) && t.isNumericLiteral(rhs.argument))) kind = kind ?? 'sabit';
      else if (t.isMemberExpression(rhs) && rhs.computed) kind = kind ?? 'tablo';
      else if (t.isConditionalExpression(rhs)) { kind = kind ?? 'sabit'; conditional = true; }
      else kind = 'hesaplanan';
    }
    const inner = inIf || t.isIfStatement(n) || t.isConditionalExpression(n) || t.isLogicalExpression(n);
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => visit(c, inner && !(t.isIfStatement(n) && k === 'test'))); else visit(v, inner && !(t.isIfStatement(n) && k === 'test'));
    }
  };
  stmts.forEach((s) => visit(s, false));
  if (!updates) return term ? `çıkış (${term})` : 'geçiş yok';
  const base = { sabit: 'sabit geçiş', artımlı: 'artımlı geçiş', tablo: 'tablo geçişi', hesaplanan: 'hesaplanan geçiş' }[kind];
  return `${conditional ? 'koşullu ' : ''}${base}${term ? ` + ${term}` : ''}`;
}

// Madde 40/39: durum başına yan etkiler — çağrılar, durum dışı yazmalar, dönüş/atma
export function caseSummaries(sw, stateNames) {
  const names = new Set(stateNames);
  return sw.cases.map((c, i) => {
    const stmts = ownList(sw, i);
    const calls = new Set();
    const writes = new Set();
    let returns = false;
    let throws = false;
    for (const s of stmts) {
      walk(s, (n) => {
        if (t.isFunction(n)) return false;
        if (t.isCallExpression(n) || t.isNewExpression(n)) {
          const name = pathOf(n.callee) ?? (t.isMemberExpression(n.callee) ? `${pathOf(n.callee.object) ?? '?'}[…]` : '(ifade)');
          calls.add(name);
        }
        if (t.isAssignmentExpression(n) || t.isUpdateExpression(n)) {
          const target = pathOf(t.isAssignmentExpression(n) ? n.left : n.argument) ?? gen(t.isAssignmentExpression(n) ? n.left : n.argument).slice(0, 40);
          if (!names.has(target) && !names.has(target.split('.')[0])) writes.add(target);
        }
        if (t.isReturnStatement(n)) returns = true;
        if (t.isThrowStatement(n)) throws = true;
        return undefined;
      });
    }
    return {
      index: i,
      label: c.test ? gen(c.test) : 'default',
      isDefault: !c.test,
      calls: [...calls],
      writes: [...writes],
      returns,
      throws,
      template: branchTemplate(stmts, names),
      source: gen(t.blockStatement(stmts)).slice(0, 400),
    };
  });
}

export function nativeCalls(cases) {
  const out = new Map();
  for (const c of cases) {
    for (const name of c.calls) {
      const root = name.split('.')[0];
      if (!NATIVE.has(root)) continue;
      out.set(name, (out.get(name) ?? 0) + 1);
    }
  }
  return [...out].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

// Gözlenen olay dizisinden (ardışık durum değerleri) kenarlar
export function observedEdges(seq) {
  const edges = new Map();
  for (let i = 0; i + 1 < seq.length; i++) {
    const k = `${seq[i]}→${seq[i + 1]}`;
    edges.set(k, { from: String(seq[i]), to: String(seq[i + 1]), count: (edges.get(k)?.count ?? 0) + 1 });
  }
  return [...edges.values()];
}

// Tüm kaynakları birleştir: statik (koşullu), gözlenen ve zorlanmış (concolic) kenarlar
export function machineReport({ id, fn, line, discriminant, stateNames, cases, staticGraph = null, observed = [], forced = [], runs = 0, proxyWrites = [], entries = [] }) {
  const edges = new Map();
  const add = (e, source) => {
    const k = `${e.from}→${e.to}|${e.cond ?? ''}`;
    const prev = edges.get(k);
    if (prev) { prev.sources = [...new Set([...prev.sources, source])]; prev.count = (prev.count ?? 0) + (e.count ?? 0); return; }
    edges.set(k, { from: e.from, to: e.to, cond: e.cond ?? null, sources: [source], count: e.count ?? 0 });
  };
  staticGraph?.edges.forEach((e) => add(e, 'statik'));
  observed.forEach((e) => add(e, 'gözlendi'));
  // madde 27: çözücüyle bulunan girdiyle gözlenen kenar doğrulanmıştır; çözülemeyip zorlanan dal doğrulanmamış
  forced.forEach((e) => add(e, e.status === 'feasible' ? 'çözücüyle doğrulanmış yol' : 'zorlanmış yol (doğrulanmamış)'));
  // gözlenen kenarın statik karşılığı koşulluysa koşulu taşı
  const all = [...edges.values()];
  const nodes = new Set(all.flatMap((e) => [e.from, e.to]));
  const caseValues = cases.map((c) => {
    try { return c.isDefault ? null : String(JSON.parse(c.label.replace(/'/g, '"'))); } catch { return c.label; }
  });
  const reachedStatic = new Set(staticGraph?.nodes.map((n) => n.id) ?? []);
  const reachedAny = new Set([...reachedStatic, ...nodes]);
  const unreachable = cases.map((c, i) => ({ c, v: caseValues[i] })).filter(({ c, v }) => !c.isDefault && !reachedAny.has(v)).map(({ c, v }) => ({
    label: c.label,
    certainty: staticGraph?.complete ? 'kanıtlandı (tüm yollar statik olarak gezildi)' : 'gözlenmedi',
    value: v,
  }));
  const defaultHits = staticGraph?.nodes.filter((n) => n.isDefault).map((n) => n.id) ?? [];
  // Madde 45: her giriş durumundan ulaşılan durum kümesi (giriş noktaları ayrı fonksiyon bölgeleri)
  const adj = new Map();
  for (const e of all) { if (!adj.has(e.from)) adj.set(e.from, new Set()); adj.get(e.from).add(e.to); }
  const regions = entries.map((entry) => {
    const seen = new Set();
    const stack = [String(entry)];
    while (stack.length) {
      const x = stack.pop();
      if (seen.has(x)) continue;
      seen.add(x);
      for (const y of adj.get(x) ?? []) stack.push(y);
    }
    seen.delete('ÇIKIŞ');
    return { entry: String(entry), states: [...seen] };
  });
  const shared = regions.length > 1 ? regions[0].states.filter((s) => regions.slice(1).every((r) => r.states.includes(s))) : [];
  return {
    id, fn, line, discriminant, stateNames,
    cases,
    edges: all,
    terminators: [
      ...(staticGraph?.terms ?? []).map((x) => ({ from: x.from, kind: x.kind, cond: x.cond, src: x.src })),
      ...all.filter((e) => e.to === 'ÇIKIŞ').map((e) => ({ from: e.from, kind: 'döngü çıkışı', cond: e.cond, src: null })),
    ],
    defaultHits,
    unreachable,
    native: nativeCalls(cases),
    complete: staticGraph?.complete ?? false,
    staticReason: staticGraph?.reason ?? null,
    concolicRuns: runs,
    proxyWrites: proxyWrites.slice(0, 200),
    regions,
    sharedStates: shared,
  };
}

// Adım adım hata ayıklayıcı için iz: olay dizisi → adımlar (durum, case kaynağı)
export function debugSteps(seq, cases, writes = []) {
  const byValue = new Map();
  cases.forEach((c) => { if (!c.isDefault) byValue.set(String(c.label).replace(/^["']|["']$/g, ''), c); });
  const def = cases.find((c) => c.isDefault);
  return seq.slice(0, 3000).map((v, i) => {
    const c = byValue.get(String(v)) ?? def ?? null;
    return { i, state: String(v), label: c?.label ?? '?', source: c?.source ?? '', effects: c ? [...c.calls, ...c.writes.map((w) => `${w} =`)] : [], writes: writes[i] ?? null };
  });
}

