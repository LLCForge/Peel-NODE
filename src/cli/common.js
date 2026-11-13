import { readFile, stat } from 'node:fs/promises';
import { createNodeSandbox } from '../sandbox/node-host.js';
import { UsageError } from './args.js';

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, CHANGED: 3, RISK: 4 };
export const MAX_INPUT = 50 * 1024 * 1024;
const MAX_URL_BYTES = 20 * 1024 * 1024;

// I182: QuickJS worker_thread'de, bekçili: kilitlenen motor (felaket regex) sonlandırılıp yeniden başlatılır
let sandboxPromise = null;
export function getSandbox() {
  sandboxPromise ??= Promise.resolve(createNodeSandbox());
  return sandboxPromise;
}

export function makeLogger(quiet) {
  return (m, lv = 'info') => { if (!quiet) process.stderr.write(`[${lv}] ${m}\n`); };
}

export async function readInput(path) {
  if (path === '-') {
    const chunks = [];
    let n = 0;
    for await (const c of process.stdin) {
      n += c.length;
      if (n > MAX_INPUT) throw new Error('Girdi çok büyük');
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const s = await stat(path);
  if (!s.isFile()) throw new Error(`Dosya değil: ${path}`);
  if (s.size > MAX_INPUT) throw new Error(`Dosya çok büyük: ${path}`);
  return readFile(path, 'utf8');
}

// G143: kullanıcının verdiği http(s) adresinden script indirir (boyut ve süre sınırlı, yönlendirme en fazla 5)
export async function fetchScript(url) {
  let u;
  try { u = new URL(url); } catch { throw new UsageError(`Geçersiz adres: ${url}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UsageError('Yalnızca http(s) adresleri izlenebilir');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    const r = await fetch(u, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': 'peel-js' } });
    if (!r.ok) throw new Error(`İndirilemedi: HTTP ${r.status}`);
    const len = Number(r.headers.get('content-length') ?? 0);
    if (len > MAX_URL_BYTES) throw new Error('Script çok büyük');
    const reader = r.body.getReader();
    const chunks = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > MAX_URL_BYTES) { await reader.cancel(); throw new Error('Script çok büyük'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

export const isUrl = (s) => /^https?:\/\//i.test(s);

export async function readJson(path) {
  const text = await readFile(path, 'utf8');
  try { return JSON.parse(text); } catch (e) { throw new UsageError(`${path} JSON değil: ${e.message}`); }
}
