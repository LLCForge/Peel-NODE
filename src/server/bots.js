import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { deobfuscate } from '../core/pipeline.js';
import { createNodeSandbox } from '../sandbox/node-host.js';
import { detectTechniques } from '../integrations/techniques.js';

// H169: Slack ve Discord botu. Kendi sunucunda çalışır, loopback'e bağlanır; dışarıya bir ters vekil
// ya da tünel ile açılır (Slack/Discord isteği o adrese gönderir). Her istek platformun imzasıyla doğrulanır:
// Slack: HMAC-SHA256 (signing secret, 5 dk zaman penceresi). Discord: Ed25519 (uygulama açık anahtarı).
// Sonuç yalnızca platformun kendi yanıt adresine (hooks.slack.com / discord.com) gönderilir.

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const MAX_BODY = 256 * 1024;
const MAX_CODE = 100_000;
const SLACK_LIMIT = 2900;
const DISCORD_LIMIT = 1800;
const DISCORD_API = 'https://discord.com/api/v10';

export function verifySlack({ secret, timestamp, signature, body, now = Date.now() }) {
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function verifyDiscord({ publicKey, timestamp, signature, body }) {
  if (!/^[0-9a-f]{64}$/i.test(publicKey ?? '') || !/^[0-9a-f]{128}$/i.test(signature ?? '') || !timestamp) return false;
  const key = await crypto.subtle.importKey('raw', Buffer.from(publicKey, 'hex'), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'Ed25519' }, key, Buffer.from(signature, 'hex'), Buffer.from(timestamp + body));
}

// Slack mesajlarında kod ``` ile ya da düz gelir; Slack &, <, > karakterlerini kaçışlar
export function extractCode(text) {
  let s = String(text ?? '').trim();
  const fence = s.match(/```(?:js|javascript)?\n?([\s\S]*?)```/);
  if (fence) s = fence[1];
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function summarize(code, input, lang = 'tr') {
  const tech = detectTechniques(input).map((x) => (lang === 'tr' ? x.nameTr : x.name));
  const head = tech.length ? `${lang === 'tr' ? 'Teknikler' : 'Techniques'}: ${tech.join(', ')}\n` : '';
  return { head, code };
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n// … (${s.length - n} karakter kesildi)` : s);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {{host?: string, port?: number, slack?: {signingSecret: string}, discord?: {publicKey: string, applicationId: string}, fetchImpl?: typeof fetch, log?: (m: string) => void}} o
 */
export async function startBotServer({ host = '127.0.0.1', port = 8788, slack = null, discord = null, fetchImpl = fetch, log = () => {} } = {}) {
  if (!LOOPBACK.has(host)) throw new Error('Bot sunucusu yalnızca loopback adresine bağlanır; dışarıya ters vekil/tünel ile açın');
  if (!slack?.signingSecret && !discord?.publicKey) throw new Error('En az bir platform yapılandırılmalı (Slack signing secret ya da Discord public key)');
  if (discord && !/^\d{5,25}$/.test(discord.applicationId ?? '')) throw new Error('Discord applicationId geçersiz');

  // I182: bekçili sandbox (worker_thread)
  const sandbox = createNodeSandbox();
  let chain = Promise.resolve();
  const run = (input) => {
    const job = chain.then(() => deobfuscate(input, { level: 4, sandbox, deep: true }));
    chain = job.catch(() => {});
    return job;
  };

  async function slackJob(input, responseUrl) {
    let text;
    try {
      const r = await run(input);
      if (r.error) text = `Parse edilemedi: ${r.error}`;
      else {
        const s = summarize(r.code, input);
        text = `${s.head}\`\`\`${clip(s.code, SLACK_LIMIT)}\`\`\``;
      }
    } catch (e) {
      text = `Hata: ${e.message}`;
    }
    await fetchImpl(responseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ response_type: 'ephemeral', text }) });
  }

  async function discordJob(input, token) {
    let content;
    try {
      const r = await run(input);
      if (r.error) content = `Parse edilemedi: ${r.error}`;
      else {
        const s = summarize(r.code, input);
        content = `${s.head}\`\`\`js\n${clip(s.code, DISCORD_LIMIT - s.head.length)}\n\`\`\``;
      }
    } catch (e) {
      content = `Hata: ${e.message}`;
    }
    await fetchImpl(`${DISCORD_API}/webhooks/${discord.applicationId}/${encodeURIComponent(token)}/messages/@original`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
  }

  const server = createServer(async (req, res) => {
    const reply = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method !== 'POST') return reply(405, { error: 'method' });
      const body = await readBody(req);
      const path = new URL(req.url, 'http://localhost').pathname;

      if (path === '/slack/command' && slack) {
        if (!verifySlack({ secret: slack.signingSecret, timestamp: req.headers['x-slack-request-timestamp'], signature: req.headers['x-slack-signature'], body })) return reply(401, { error: 'imza' });
        const form = new URLSearchParams(body);
        const responseUrl = form.get('response_url') ?? '';
        let u;
        try { u = new URL(responseUrl); } catch { return reply(400, { error: 'response_url' }); }
        if (u.protocol !== 'https:' || u.hostname !== 'hooks.slack.com') return reply(400, { error: 'response_url' });
        const input = extractCode(form.get('text'));
        if (!input) return reply(200, { response_type: 'ephemeral', text: 'Kullanım: /peel <obfuscated kod>' });
        if (input.length > MAX_CODE) return reply(200, { response_type: 'ephemeral', text: 'Kod çok uzun (en fazla 100 KB)' });
        slackJob(input, u.toString()).catch((e) => log(`slack: ${e.message}`));
        return reply(200, { response_type: 'ephemeral', text: 'PEEL çözüyor…' });
      }

      if (path === '/discord/interactions' && discord) {
        const ok = await verifyDiscord({ publicKey: discord.publicKey, timestamp: req.headers['x-signature-timestamp'], signature: req.headers['x-signature-ed25519'], body });
        if (!ok) return reply(401, { error: 'imza' });
        const msg = JSON.parse(body);
        if (msg.type === 1) return reply(200, { type: 1 });
        if (msg.type === 2 && msg.data?.name === 'peel') {
          const input = extractCode(msg.data.options?.find((o) => o.name === 'code')?.value);
          if (!input) return reply(200, { type: 4, data: { content: 'Kullanım: /peel code:<obfuscated kod>', flags: 64 } });
          if (input.length > MAX_CODE) return reply(200, { type: 4, data: { content: 'Kod çok uzun', flags: 64 } });
          if (typeof msg.token !== 'string' || !/^[\w.-]{10,500}$/.test(msg.token)) return reply(400, { error: 'token' });
          discordJob(input, msg.token).catch((e) => log(`discord: ${e.message}`));
          return reply(200, { type: 5, data: { flags: 64 } });
        }
        return reply(400, { error: 'desteklenmeyen etkileşim' });
      }
      return reply(404, { error: 'bulunamadı' });
    } catch (e) {
      log(`bot: ${e.message}`);
      return reply(400, { error: 'geçersiz istek' });
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const addr = server.address();
  return { port: addr.port, close: () => new Promise((r) => server.close(() => r())) };
}

/** Discord /peel komutunu uygulamaya kaydeder (bir kez çalıştırılır). */
export async function registerDiscordCommand({ applicationId, botToken, fetchImpl = fetch }) {
  const r = await fetchImpl(`${DISCORD_API}/applications/${applicationId}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
    body: JSON.stringify({
      name: 'peel',
      description: 'Obfuscated JavaScript kodunu çöz (PEEL)',
      options: [{ type: 3, name: 'code', description: 'Obfuscated kod', required: true, max_length: 6000 }],
    }),
  });
  if (!r.ok) throw new Error(`Discord komut kaydı başarısız: ${r.status}`);
  return r.json();
}
