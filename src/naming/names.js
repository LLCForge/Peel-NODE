import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { parse } from '../core/parse.js';
import { raw, pretty } from '../core/emit.js';
import { scan, renameBlocker, isValidName, isAvoided } from './scope.js';
import { createInferer } from './types.js';
import { suggestName } from './suggest.js';

// Scope-güvenli yeniden adlandırma çekirdeği: rename pass'i, kullanıcı sözlüğü (E231),
// kalıcı ad haritası (87) ve paylaşılan haritalar (88) aynı yoldan geçer.

export const GENERATED = /^_0x[0-9a-f]+$/i;
const PREFIX = { hoisted: 'fn', local: 'fn', param: 'arg', var: 'v', let: 'v', const: 'c' };
const MAX_ENTRIES = 5000;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @param {object} ast
 * @param {object} o
 * @param {Record<string,string>} o.names  kullanıcı haritası: eski → yeni (herhangi bir binding adı)
 * @param {boolean} o.auto                üretilmiş (_0x) isimleri kurallarla adlandır
 * @param {boolean} o.originalComments    E232: eski adı bildirimin yanına yorum olarak yaz
 */
export function renameAll(ast, { names = {}, auto = true, originalComments = false } = {}) {
  const info = scan(ast);
  const inf = auto ? createInferer() : null;
  const taken = info.taken;
  const renamed = [];
  const skipped = [];
  // aynı eski adın farklı kapsamlardaki kopyaları aynı yeni adı alabilir (yapı aynen korunur)
  const producedFrom = new Map();

  const counters = {};
  const fresh = (prefix) => {
    let name;
    do { counters[prefix] = (counters[prefix] ?? 0) + 1; name = `${prefix}${counters[prefix]}`; } while (taken.has(name));
    taken.add(name);
    return name;
  };
  const uniq = (base) => {
    let name = base;
    for (let i = 2; taken.has(name) || isAvoided(name) || !isValidName(name); i++) name = `${base}${i}`;
    return name;
  };
  const user = (n) => (Object.hasOwn(names, n) ? names[n] : null);
  // fonksiyon gövdesi blok'u fonksiyonun kapsamını paylaşır: aynı binding iki kez ziyaret edilmesin
  const done = new WeakSet();

  traverse(ast, {
    Scopable: {
      enter(p) {
        for (const [name, binding] of Object.entries(p.scope.bindings)) {
          if (binding.scope !== p.scope || done.has(binding.identifier)) continue;
          done.add(binding.identifier);
          let target = user(name);
          let reason = target ? 'kullanıcı' : null;
          if (!target && auto && GENERATED.test(name)) {
            const prefix = PREFIX[binding.kind];
            if (!prefix) continue;
            const blocker = renameBlocker(info, binding);
            if (blocker) { skipped.push({ name, reason: blocker }); continue; }
            const fallback = fresh(prefix);
            const s = suggestName(binding, inf);
            if (s && isValidName(s.name)) {
              taken.delete(fallback);
              target = uniq(s.name);
              reason = s.reason;
            } else {
              target = fallback;
              reason = 'üretilmiş isim';
            }
            const again = user(target);
            if (again) { target = again; reason = 'kullanıcı'; }
          }
          if (!target || target === name) continue;
          const blocker = renameBlocker(info, binding);
          if (blocker) { skipped.push({ name, reason: blocker }); continue; }
          if (!isValidName(target)) { skipped.push({ name, reason: `geçersiz ad: ${target}` }); continue; }
          if (taken.has(target) && producedFrom.get(target) !== name && reason === 'kullanıcı') {
            skipped.push({ name, reason: `çakışma: ${target}` });
            continue;
          }
          const line = binding.identifier.loc?.start.line ?? null;
          const decl = binding.identifier;
          p.scope.rename(name, target);
          taken.add(target);
          producedFrom.set(target, name);
          if (originalComments && name !== target) {
            const value = ` ${name} `;
            if (!(decl.trailingComments ?? []).some((c) => c.value === value)) t.addComment(decl, 'trailing', value, false);
          }
          renamed.push({ from: name, to: target, reason, line });
        }
      },
    },
  });
  return { renamed, skipped };
}

/** Çözülmüş kodda ad haritasını uygular (yeniden çözmeden). */
export async function applyNameMap(code, names, { originalComments = false } = {}) {
  const ast = parse(code);
  const r = renameAll(ast, { names, auto: false, originalComments });
  return { code: await pretty(raw(ast)), ...r };
}

/**
 * Ad önerileri listesi (UI): anlamsız görünen tüm binding'ler (_0x, 1-2 harf) için öneri ve nedeni.
 * Yalnızca rapor: koda dokunmaz.
 */
export function listSuggestions(code, limit = 400) {
  let ast;
  try { ast = parse(code); } catch { return []; }
  const info = scan(ast);
  const inf = createInferer();
  const out = [];
  const seen = new Set();
  traverse(ast, {
    Scopable(p) {
      for (const [name, b] of Object.entries(p.scope.bindings)) {
        if (b.scope !== p.scope || seen.has(b.identifier) || out.length >= limit) continue;
        seen.add(b.identifier);
        if (!(GENERATED.test(name) || name.length <= 2 || /^(fn|arg|v|c)\d+$/.test(name))) continue;
        const s = suggestName(b, inf);
        out.push({
          name,
          kind: b.kind,
          line: b.identifier.loc?.start.line ?? null,
          refs: b.referencePaths.length,
          type: inf.binding(b),
          suggestion: s?.name ?? null,
          reason: s?.reason ?? null,
          blocked: renameBlocker(info, b),
        });
      }
    },
  });
  return out;
}

// ── 88: paylaşılabilir ad haritası ───────────────────────

export function serializeNameMap(names, source = null) {
  return JSON.stringify({ peel: 'names', version: 1, source, names }, null, 2);
}

/** Dışarıdan gelen JSON'u doğrular: yalnızca geçerli tanımlayıcı → geçerli tanımlayıcı çiftleri kabul edilir. */
export function parseNameMap(text) {
  if (typeof text !== 'string' || text.length > 1_000_000) return { ok: false, error: 'dosya çok büyük' };
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, error: 'JSON ayrıştırılamadı' }; }
  const src = data && typeof data === 'object' && !Array.isArray(data) && data.names && typeof data.names === 'object' ? data.names : data;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return { ok: false, error: 'ad haritası nesne olmalı' };
  const names = Object.create(null);
  let count = 0;
  const rejected = [];
  for (const [k, v] of Object.entries(src)) {
    if (++count > MAX_ENTRIES) return { ok: false, error: `en fazla ${MAX_ENTRIES} kayıt` };
    // nesne anahtarı olarak özel anlamı olan adlar haritaya girmez (prototip kirliliğine karşı)
    if (isValidName(k) && isValidName(v) && !UNSAFE_KEYS.has(k) && !UNSAFE_KEYS.has(v)) names[k] = v;
    else rejected.push(k.slice(0, 64));
  }
  return { ok: true, names: { ...names }, rejected, source: typeof data.source === 'string' ? data.source.slice(0, 64) : null };
}
