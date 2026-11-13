// E106: tarayıcı eklentisi (.crx / .xpi / .zip) analizi. Paket bellekte açılır, manifest izinleri
// risk düzeyine göre sınıflandırılır, içerik/arka plan betikleri ve her JS dosyası taranır.
import { parseZip, unpackCrx } from './archive.js';
import { detectTools } from '../core/detect.js';
import { extractIocs } from '../core/analyze.js';

const PERMISSION_RISK = {
  high: ['<all_urls>', 'cookies', 'webRequest', 'webRequestBlocking', 'debugger', 'nativeMessaging', 'proxy', 'management',
    'history', 'clipboardRead', 'privacy', 'browsingData', 'contentSettings', 'desktopCapture', 'pageCapture', 'tabCapture',
    'declarativeNetRequestWithHostAccess', 'webNavigation', 'scripting', 'downloads', 'geolocation', 'identity'],
  medium: ['tabs', 'activeTab', 'storage', 'unlimitedStorage', 'clipboardWrite', 'notifications', 'declarativeNetRequest',
    'contextMenus', 'bookmarks', 'topSites', 'alarms', 'offscreen', 'sidePanel'],
};

const API_PATTERNS = [
  [/\beval\s*\(|new\s+Function\s*\(/, 'dinamik kod (eval/Function)'],
  [/chrome\.cookies|browser\.cookies/, 'çerez API'],
  [/chrome\.webRequest|browser\.webRequest/, 'istek yakalama'],
  [/chrome\.scripting\.executeScript|tabs\.executeScript/, 'sayfaya kod enjeksiyonu'],
  [/chrome\.debugger/, 'debugger protokolü'],
  [/document\.cookie/, 'sayfa çerezleri'],
  [/addEventListener\(\s*["']key(down|press|up)/, 'tuş olayları'],
  [/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/, 'ağ isteği'],
  [/importScripts\(|createElement\(\s*["']script["']\s*\)/, 'uzak betik yükleme'],
  [/chrome\.runtime\.sendNativeMessage|connectNative/, 'yerel uygulama mesajı'],
  [/localStorage|chrome\.storage/, 'depolama'],
  [/atob\(|fromCharCode/, 'kodlanmış veri'],
];

const asList = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);

function permissionTable(manifest) {
  const perms = [...asList(manifest.permissions), ...asList(manifest.optional_permissions)];
  const hosts = [...asList(manifest.host_permissions), ...asList(manifest.optional_host_permissions)];
  // MV2'de host izinleri permissions içindedir
  for (const p of [...perms]) if (/^(\*|https?|wss?|file|ftp):\/\/|^<all_urls>$/.test(p) && p !== '<all_urls>') { hosts.push(p); perms.splice(perms.indexOf(p), 1); }
  const rows = perms.map((p) => ({
    permission: p,
    risk: PERMISSION_RISK.high.includes(p) ? 'high' : PERMISSION_RISK.medium.includes(p) ? 'medium' : 'low',
  }));
  for (const h of hosts) rows.push({ permission: h, risk: /^<all_urls>$|^\*:\/\/\*\/\*$|^https?:\/\/\*\/\*$/.test(h) ? 'high' : 'medium', host: true });
  return rows;
}

function scanJs(name, text) {
  const tools = detectTools(text).filter((d) => d.score >= 50).map((d) => `${d.name} (${d.score})`);
  const iocs = extractIocs([], text);
  return {
    name,
    size: text.length,
    tools,
    apis: API_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label),
    domains: iocs.domains.slice(0, 30),
    urls: iocs.urls.slice(0, 30),
  };
}

/**
 * @param {Uint8Array} bytes  .crx / .xpi / .zip içeriği
 * @returns {object} manifest, izin tablosu, betikler, dosya taramaları ve 0–100 risk
 */
export function analyzeExtension(bytes) {
  const { format, zip } = unpackCrx(bytes);
  const entries = parseZip(zip);
  const byName = new Map(entries.map((e) => [e.name.replace(/^\.?\//, ''), e]));
  const mf = byName.get('manifest.json');
  if (!mf?.data) throw new Error('manifest.json bulunamadı');
  let manifest;
  try {
    // manifest yorum satırı içerebilir (Chrome bunları kabul eder)
    manifest = JSON.parse(new TextDecoder().decode(mf.data).replace(/^﻿/, '').replace(/^\s*\/\/.*$/gm, ''));
  } catch (e) {
    throw new Error(`manifest.json okunamadı: ${e.message}`);
  }
  const permissions = permissionTable(manifest);
  const contentScripts = asList(manifest.content_scripts).map((c) => ({ matches: asList(c.matches), js: asList(c.js), runAt: c.run_at ?? 'document_idle', allFrames: Boolean(c.all_frames) }));
  const background = manifest.background
    ? [...asList(manifest.background.scripts), ...asList(manifest.background.service_worker), ...asList(manifest.background.page)]
    : [];
  const csp = typeof manifest.content_security_policy === 'string' ? manifest.content_security_policy : manifest.content_security_policy?.extension_pages ?? null;
  const files = entries.map((e) => ({ name: e.name, size: e.size, encrypted: Boolean(e.encrypted), unsupported: e.unsupported ?? null }));
  const scripts = entries.filter((e) => e.data && /\.(m?js|cjs)$/i.test(e.name)).slice(0, 200)
    .map((e) => scanJs(e.name, new TextDecoder().decode(e.data)));
  const findings = [];
  if (permissions.some((p) => p.risk === 'high' && p.host)) findings.push('tüm sitelere erişim');
  if (contentScripts.some((c) => c.matches.some((m) => /<all_urls>|\*:\/\/\*\/\*/.test(m)))) findings.push('her sayfaya içerik betiği');
  if (csp && /unsafe-eval|unsafe-inline|https?:\/\//.test(csp)) findings.push(`gevşek CSP: ${csp.slice(0, 120)}`);
  if (manifest.externally_connectable) findings.push('dış sitelerden mesaj kabulü (externally_connectable)');
  if (manifest.update_url && !/clients2\.google\.com|addons\.mozilla\.org|edge\.microsoft\.com/.test(manifest.update_url)) findings.push(`mağaza dışı güncelleme adresi: ${manifest.update_url}`);
  if (scripts.some((s) => s.apis.includes('dinamik kod (eval/Function)'))) findings.push('dinamik kod çalıştırma');
  if (scripts.some((s) => s.tools.length)) findings.push('gizlenmiş (obfuscated) betik');
  if (scripts.some((s) => s.apis.includes('uzak betik yükleme'))) findings.push('uzak betik yükleme');
  const high = permissions.filter((p) => p.risk === 'high').length;
  const score = Math.min(100, high * 12 + permissions.filter((p) => p.risk === 'medium').length * 4 + findings.length * 10);
  return {
    format,
    name: manifest.name ?? '?',
    version: manifest.version ?? '?',
    manifestVersion: manifest.manifest_version ?? null,
    permissions,
    contentScripts,
    background,
    csp,
    webAccessible: asList(manifest.web_accessible_resources).flatMap((w) => (typeof w === 'string' ? [w] : asList(w.resources))),
    updateUrl: manifest.update_url ?? null,
    files,
    scripts,
    findings,
    risk: { score, level: score >= 70 ? 'high' : score >= 35 ? 'medium' : score > 0 ? 'low' : 'none' },
    // seçilen dosyayı ana çözücüye yüklemek için içerik erişimi
    read: (name) => {
      const e = byName.get(name);
      return e?.data ? new TextDecoder().decode(e.data) : null;
    },
  };
}
