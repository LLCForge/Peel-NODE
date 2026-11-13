import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { deobfuscate } from '../core/pipeline.js';
import { analyze } from '../core/analyze.js';
import { createNodeSandbox } from '../sandbox/node-host.js';
import { PASSES } from '../core/registry.js';
import { semanticDiff } from '../integrations/compare.js';
import { toSarif } from '../integrations/sarif.js';
import { explainWhy } from '../integrations/why.js';

// H163: self-host REST API. Yalnızca loopback adresine bağlanır (127.0.0.1 / ::1); her istek için
// Bearer token, Host başlığı denetimi (DNS rebinding), Origin'li (tarayıcıdan gelen) isteklerin reddi,
// gövde boyu sınırı, JSON şema denetimi, tek işlik kuyruk ve iş başına zaman aşımı uygulanır.
// İstek gövdeleri hiçbir yere yazılmaz ya da loglanmaz.

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const DEFAULT_MAX_BODY = 5 * 1024 * 1024;
const MAX_QUEUE = 8;
const SECURITY_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > max) {
      reject(new HttpError(413, 'Gövde çok büyük'));
      req.resume();
      return;
    }
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > max) {
        reject(new HttpError(413, 'Gövde çok büyük'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const str = (v, field, max) => {
  if (typeof v !== 'string') throw new HttpError(400, `${field} string olmalı`);
  if (v.length > max) throw new HttpError(413, `${field} çok uzun`);
  return v;
};
const level = (v) => {
  if (v === undefined) return 4;
  if (![1, 2, 3, 4].includes(v)) throw new HttpError(400, 'level 1-4 olmalı');
  return v;
};

function sameToken(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * @param {{host?: string, port?: number, token?: string|null, maxBody?: number, timeoutMs?: number, log?: (m: string) => void}} [o]
 */
export async function startServer({ host = '127.0.0.1', port = 8787, token = null, maxBody = DEFAULT_MAX_BODY, timeoutMs = 60_000, log = () => {} } = {}) {
  if (!LOOPBACK.has(host)) throw new Error(`Sunucu yalnızca loopback adresine bağlanır (127.0.0.1, ::1, localhost); verilen: ${host}`);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Geçersiz port');
  const secret = token ?? randomBytes(24).toString('hex');
  if (secret.length < 16) throw new Error('Token en az 16 karakter olmalı');

  // I182: bekçili sandbox (worker_thread); kilitlenen motor sonlandırılıp yeniden başlatılır
  let box = createNodeSandbox();
  const sandbox = new Proxy({}, { get: (_t, k) => box[k] });

  // tek işlik kuyruk: aynı QuickJS host'u eşzamanlı pipeline'larla paylaşılmaz
  let chain = Promise.resolve();
  let queued = 0;
  const enqueue = (fn) => {
    if (queued >= MAX_QUEUE) throw new HttpError(503, 'Kuyruk dolu, sonra tekrar deneyin');
    queued++;
    const job = chain.then(fn).finally(() => { queued--; });
    chain = job.catch(() => {});
    return job;
  };

  const withTimeout = async (fn) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fn(ac.signal);
    } catch (e) {
      if (ac.signal.aborted) {
        // yarıda kalan bağlamlar atılır: motor yeniden başlatılır
        box.close();
        box = createNodeSandbox();
        throw new HttpError(504, 'Zaman aşımı');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  const routes = {
    'GET /health': async () => ({ ok: true }),
    'GET /v1/passes': async () => ({ passes: PASSES.map(({ id, level: l, kind, needs }) => ({ id, level: l, kind, needs })) }),
    'POST /v1/deobfuscate': async (body) => {
      const code = str(body.code, 'code', maxBody);
      const lv = level(body.level);
      const withReport = body.analyze === true;
      return enqueue(() => withTimeout(async (signal) => {
        const r = await deobfuscate(code, { level: lv, sandbox, deep: body.deep !== false, signal });
        if (r.error) throw new HttpError(422, `Parse edilemedi: ${r.error}`);
        const out = { code: r.code, stats: r.stats, verified: r.verified, events: r.events };
        if (withReport) {
          out.report = await analyze({ input: code, text: r.text, output: r.code, events: r.events, sandbox });
          // tembel sembolik rapor JSON yanıtında hesaplanmış hâliyle döner
          out.report.symbolic = await out.report.symbolic();
          out.why = explainWhy({ input: code, report: out.report });
        }
        return out;
      }));
    },
    'POST /v1/sarif': async (body) => {
      const code = str(body.code, 'code', maxBody);
      const uri = body.uri === undefined ? 'peeled.js' : str(body.uri, 'uri', 500);
      return enqueue(() => withTimeout(async (signal) => {
        const r = await deobfuscate(code, { level: 4, sandbox, deep: true, signal });
        if (r.error) throw new HttpError(422, `Parse edilemedi: ${r.error}`);
        const report = await analyze({ input: code, text: r.text, output: r.code, events: r.events, sandbox });
        return toSarif(report, { output: r.code, uri });
      }));
    },
    'POST /v1/diff': async (body) => {
      const a = str(body.old, 'old', maxBody);
      const b = str(body.new, 'new', maxBody);
      const deob = body.deobfuscate === true;
      return enqueue(() => withTimeout(async (signal) => {
        let oa = a;
        let ob = b;
        if (deob) {
          const ra = await deobfuscate(a, { level: 4, sandbox, deep: true, signal });
          const rb = await deobfuscate(b, { level: 4, sandbox, deep: true, signal });
          if (ra.error || rb.error) throw new HttpError(422, 'Girdilerden biri parse edilemedi');
          oa = ra.code;
          ob = rb.code;
        }
        try {
          return { diff: semanticDiff(oa, ob, { oldInput: a, newInput: b }), old: deob ? oa : undefined, new: deob ? ob : undefined };
        } catch (e) {
          throw new HttpError(422, e.message);
        }
      }));
    },
  };

  const server = createServer(async (req, res) => {
    const t0 = Date.now();
    const send = (status, obj) => {
      res.writeHead(status, SECURITY_HEADERS);
      res.end(JSON.stringify(obj));
      log(`${req.method} ${req.url} ${status} ${Date.now() - t0}ms`);
    };
    try {
      const hostHeader = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (!LOOPBACK.has(hostHeader)) throw new HttpError(421, 'Host kabul edilmiyor');
      if (req.headers.origin !== undefined) throw new HttpError(403, 'Tarayıcıdan gelen istekler kabul edilmiyor');
      const path = new URL(req.url, 'http://localhost').pathname;
      const handler = routes[`${req.method} ${path}`];
      if (!handler) throw new HttpError(404, 'Bulunamadı');
      if (path !== '/health') {
        const auth = String(req.headers.authorization ?? '');
        if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), secret)) throw new HttpError(401, 'Yetkisiz');
      }
      let body = {};
      if (req.method === 'POST') {
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) throw new HttpError(415, 'Content-Type application/json olmalı');
        const text = await readBody(req, maxBody + 64 * 1024);
        try { body = JSON.parse(text); } catch { throw new HttpError(400, 'Geçersiz JSON'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Gövde JSON nesnesi olmalı');
      }
      send(200, await handler(body));
    } catch (e) {
      if (e instanceof HttpError) send(e.status, { error: e.message });
      else {
        log(`hata: ${e.message}`);
        send(500, { error: 'Sunucu hatası' });
      }
    }
  });
  server.requestTimeout = timeoutMs + 30_000;
  server.headersTimeout = 15_000;
  server.maxHeadersCount = 50;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address();
  const shown = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  return {
    url: `http://${shown}:${addr.port}`,
    port: addr.port,
    token: secret,
    close: () => new Promise((resolve) => server.close(() => { box.close(); resolve(); })),
  };
}
