import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { parse } from '../core/parse.js';

// H165: pass eklenti sistemi. Eklenti, çekirdek pass'lerle aynı sözleşmeye uyan bir nesnedir:
//   { id, kind: 'ast'|'text', level: 1-4, needs: null|'sandbox', after?: '<pass id>', run(ast|text, ctx) }
// Eklenti pass'leri de çekirdektekiler gibi doğrulanır: parse edilemeyen ya da (derin modda) davranışı
// değiştiren sonuç geri alınır. run'a verilen ctx, çekirdek bağlamına ek olarak Babel yardımcılarını taşır
// (ctx.t, ctx.traverse, ctx.gen, ctx.parse); böylece eklenti kendi bağımlılığını getirmek zorunda kalmaz.

const ID = /^[a-z0-9][a-z0-9-]{1,48}$/;

/** Eklenti nesnesini doğrular ve pipeline'ın beklediği pass kaydına çevirir. */
export function definePlugin(p, coreIds = []) {
  if (!p || typeof p !== 'object') throw new TypeError('Eklenti nesne olmalı');
  if (!ID.test(p.id ?? '')) throw new Error(`Eklenti kimliği geçersiz: ${p.id}`);
  if (coreIds.includes(p.id)) throw new Error(`Eklenti kimliği çekirdek pass ile çakışıyor: ${p.id}`);
  if (p.kind !== 'ast' && p.kind !== 'text') throw new Error(`${p.id}: kind 'ast' ya da 'text' olmalı`);
  const level = p.level ?? 2;
  if (![1, 2, 3, 4].includes(level)) throw new Error(`${p.id}: level 1-4 olmalı`);
  if (p.needs !== undefined && p.needs !== null && p.needs !== 'sandbox') throw new Error(`${p.id}: needs null ya da 'sandbox' olmalı`);
  if (typeof p.run !== 'function') throw new Error(`${p.id}: run fonksiyonu yok`);
  if (p.after !== undefined && typeof p.after !== 'string') throw new Error(`${p.id}: after string olmalı`);
  const run = p.run;
  return {
    id: p.id,
    level,
    kind: p.kind,
    needs: p.needs ?? null,
    after: p.after ?? null,
    plugin: true,
    mod: { run: (x, ctx) => run(x, { ...ctx, t, traverse, gen, parse }) },
  };
}

/**
 * Çekirdek pass listesine eklentileri yerleştirir. `after` verilen eklenti o pass'in hemen arkasına,
 * verilmeyen kendi türünün (text/ast) sonuna eklenir; rename her zaman en sonda kalır.
 */
export function resolvePasses(core, plugins = []) {
  if (!plugins?.length) return core;
  const coreIds = core.map((p) => p.id);
  const defs = plugins.map((p) => (p?.mod?.run ? p : definePlugin(p, coreIds)));
  const seen = new Set();
  for (const d of defs) {
    if (seen.has(d.id)) throw new Error(`Aynı kimlikte iki eklenti: ${d.id}`);
    seen.add(d.id);
  }
  const list = [...core];
  for (const d of defs) {
    let at;
    if (d.after) {
      const i = list.findIndex((p) => p.id === d.after);
      if (i < 0) throw new Error(`${d.id}: after hedefi yok: ${d.after}`);
      if (list[i].kind !== d.kind) throw new Error(`${d.id}: ${d.kind} eklentisi ${list[i].kind} pass'inin arkasına konamaz`);
      at = i + 1;
    } else if (d.kind === 'text') {
      at = list.findLastIndex((p) => p.kind === 'text') + 1;
    } else {
      const r = list.findIndex((p) => p.id === 'rename');
      at = r >= 0 ? r : list.length;
    }
    list.splice(at, 0, d);
  }
  return list;
}

/** ES modül kaynağından eklenti yükler (default export ya da `plugin` adlı export). */
export async function importPluginSource(code) {
  const bytes = new TextEncoder().encode(code);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const url = `data:text/javascript;base64,${btoa(bin)}`;
  const m = await import(/* @vite-ignore */ url);
  const p = m.default ?? m.plugin;
  if (!p) throw new Error('Eklenti modülü default export vermiyor');
  return p;
}
