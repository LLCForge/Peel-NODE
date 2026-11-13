import { snapshot, same } from '../core/behavior.js';
import { resilienceScore } from './resilience.js';

// J194: kendi kodunu obfuscate edip test etme. javascript-obfuscator (obfuscator.io) yalnızca bu özellik
// kullanıldığında dinamik olarak yüklenir; tarayıcıda ayrı bir parça olarak gelir. Her şey cihazda çalışır.
// Ön ayarlar test/bench.js'teki gerçek obfuscator ayarlarının özetidir.

export const PRESETS = {
  low: {
    label: { tr: 'Düşük: base64 string dizisi', en: 'Low: base64 string array' },
    options: { compact: true, stringArray: true, stringArrayThreshold: 1, stringArrayEncoding: ['base64'], identifierNamesGenerator: 'hexadecimal' },
  },
  medium: {
    label: { tr: 'Orta: base64 + rotasyon + vekiller', en: 'Medium: base64 + rotation + proxies' },
    options: { compact: true, stringArray: true, stringArrayThreshold: 1, stringArrayEncoding: ['base64'], stringArrayRotate: true, stringArrayShuffle: true, transformObjectKeys: true, splitStrings: true, splitStringsChunkLength: 4 },
  },
  high: {
    label: { tr: 'Yüksek: RC4 + akış düzleştirme + ölü kod', en: 'High: RC4 + control-flow flattening + dead code' },
    options: { compact: true, controlFlowFlattening: true, controlFlowFlatteningThreshold: 1, deadCodeInjection: true, deadCodeInjectionThreshold: 0.5, numbersToExpressions: true, stringArray: true, stringArrayEncoding: ['rc4'], stringArrayRotate: true, stringArrayShuffle: true, stringArrayWrappersCount: 2, stringArrayWrappersType: 'function', stringArrayThreshold: 1, transformObjectKeys: true },
  },
  max: {
    label: { tr: 'Maksimum: obfuscator.io "high" profili', en: 'Maximum: obfuscator.io "high" profile' },
    options: { compact: true, controlFlowFlattening: true, controlFlowFlatteningThreshold: 1, deadCodeInjection: true, deadCodeInjectionThreshold: 1, numbersToExpressions: true, simplify: true, splitStrings: true, splitStringsChunkLength: 5, stringArray: true, stringArrayCallsTransform: true, stringArrayCallsTransformThreshold: 1, stringArrayEncoding: ['rc4'], stringArrayIndexShift: true, stringArrayRotate: true, stringArrayShuffle: true, stringArrayWrappersCount: 5, stringArrayWrappersChainedCalls: true, stringArrayWrappersParametersMaxCount: 5, stringArrayWrappersType: 'function', stringArrayThreshold: 1, transformObjectKeys: true },
  },
};

const MAX_SOURCE = 512 * 1024;

async function loadObfuscator() {
  try {
    const m = await import('javascript-obfuscator');
    return m.default ?? m;
  } catch {
    throw new Error('javascript-obfuscator yüklenemedi (npm install javascript-obfuscator)');
  }
}

/**
 * @param {string} code
 * @param {keyof PRESETS | object} preset  ön ayar adı ya da javascript-obfuscator seçenekleri
 * @param {{seed?: number}} [o]  aynı seed aynı çıktıyı verir
 */
export async function obfuscate(code, preset = 'medium', { seed = 0 } = {}) {
  if (typeof code !== 'string' || !code.trim()) throw new Error('Kod boş');
  if (code.length > MAX_SOURCE) throw new Error('Kod çok büyük (en fazla 512 KB)');
  const options = typeof preset === 'string' ? PRESETS[preset]?.options : preset;
  if (!options) throw new Error(`Bilinmeyen ön ayar: ${preset}`);
  const JavaScriptObfuscator = await loadObfuscator();
  return JavaScriptObfuscator.obfuscate(code, { ...options, seed, debugProtection: false, selfDefending: false }).getObfuscatedCode();
}

/**
 * Obfuscate et, PEEL ile çöz, davranışı ve geri kazanımı ölç.
 * @param {string} code
 * @param {string} preset
 * @param {{deobfuscate: Function, sandbox?: object, seed?: number, onLog?: Function}} o
 */
export async function testOwnCode(code, preset, { deobfuscate, sandbox = null, seed = 0, onLog = () => {} }) {
  const obfuscated = await obfuscate(code, preset, { seed });
  const res = await deobfuscate(obfuscated, { level: 4, sandbox, deep: Boolean(sandbox), onLog });
  let behaviour = null;
  if (sandbox) {
    const a = await snapshot(sandbox, code);
    const b = await snapshot(sandbox, res.code);
    behaviour = a.ok ? { compared: true, same: same(a, b), original: a.lines.slice(0, 50), deobfuscated: b.ok ? b.lines.slice(0, 50) : [] } : { compared: false, reason: a.reason };
  }
  return {
    preset,
    obfuscated,
    deobfuscated: res.code,
    error: res.error ?? null,
    verified: res.verified ?? false,
    behaviour,
    resilience: res.error ? null : resilienceScore({ original: code, deobfuscated: res.code }),
    sizes: { original: code.length, obfuscated: obfuscated.length, deobfuscated: res.code.length },
  };
}
