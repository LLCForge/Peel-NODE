// E717: kanıt taşıyan çıktı — çözülmüş kod, girdi/çıktı SHA-256 özetleri, uygulanan dönüşümlerin gerekçeleri ve
// doğrulama kanıtları (semantik hash eşitliği, fonksiyon kanıtları, determinizm) tek pakette; ECDSA P-256 ile
// imzalı (imzalı rapor). checkBundle imzayı, özetleri ve istenirse davranış iddiasını yeniden doğrular.

export const BUNDLE_FORMAT = 'peel-proof';
const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto (crypto.subtle) yok');
  return s;
};

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sha256(text) {
  return hex(await subtle().digest('SHA-256', new TextEncoder().encode(text)));
}

// Kanonik JSON: anahtarlar sıralı, imza her ortamda aynı baytlar üzerinde
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

export const generateSigningKey = () => subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

const ALG = { name: 'ECDSA', hash: 'SHA-256' };

export async function signPayload(payload, keyPair) {
  const keys = keyPair ?? await generateSigningKey();
  const sig = await subtle().sign(ALG, keys.privateKey, new TextEncoder().encode(canonical(payload)));
  return { payload, signature: { alg: 'ES256', publicKey: await subtle().exportKey('jwk', keys.publicKey), value: b64(sig) } };
}

export async function verifyPayload(signed) {
  try {
    const { payload, signature } = signed;
    if (signature?.alg !== 'ES256') return false;
    const key = await subtle().importKey('jwk', signature.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await subtle().verify(ALG, key, unb64(signature.value), new TextEncoder().encode(canonical(payload)));
  } catch {
    return false;
  }
}

// Rapor imzalama (JSON dışa aktarım için): imza raporun kanonik biçimi üzerinde
export const signReport = (report, keyPair) => signPayload({ kind: 'peel-report', report }, keyPair);

export async function buildBundle({ input, output, events = [], verification = null, semantic = null, version = '0.1.0' }) {
  const claims = {
    inputSha256: await sha256(input),
    outputSha256: await sha256(output),
    transforms: events.filter((e) => e.state === 'ok').map((e) => ({ pass: e.id, round: e.round, before: e.before ?? null, after: e.after ?? null, verifiedBy: e.verifiedBy ?? null, observation: Boolean(e.observation) })),
    rollbacks: events.filter((e) => e.state === 'fail').map((e) => ({ pass: e.id, reason: e.reason ?? null })),
    semantic, // { input, output, equal }: semantik hash'ler
    verification, // seviye, denetimler ve sonuçları
  };
  return { format: BUNDLE_FORMAT, version: 1, tool: `peel ${version}`, createdAt: new Date().toISOString(), code: output, claims };
}

export async function signBundle(bundle, keyPair) {
  return signPayload(bundle, keyPair);
}

// İmza + çıktı özeti + (sandbox verilirse) semantik hash iddiası yeniden hesaplanarak doğrulanır
export async function checkBundle(signed, { input = null, recheck = null } = {}) {
  const problems = [];
  if (signed?.payload?.format !== BUNDLE_FORMAT) return { valid: false, problems: ['biçim tanınmadı'] };
  if (!(await verifyPayload(signed))) problems.push('imza geçersiz');
  const { code, claims } = signed.payload;
  if ((await sha256(code)) !== claims.outputSha256) problems.push('çıktı özeti uyuşmuyor');
  if (input != null && (await sha256(input)) !== claims.inputSha256) problems.push('girdi özeti uyuşmuyor');
  if (recheck && claims.semantic) {
    const now = await recheck(code);
    if (now !== claims.semantic.output) problems.push('davranış özeti yeniden hesaplanınca farklı');
  }
  return { valid: problems.length === 0, problems };
}
