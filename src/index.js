// PEEL kütüphane API'si (H157). Tarayıcıda ve Node'da aynı motor; sandbox QuickJS (WASM) içinde çalışır.
//   import { deobfuscate, analyze, peel } from 'peel-js';
// Node'a özgü yardımcılar (dosya tabanlı geçmiş, stil dosyası arama, Semgrep) 'peel-js/node' altındadır.
import { getQuickJS } from 'quickjs-emscripten';
import { deobfuscate as runPipeline } from './core/pipeline.js';
import { analyze as runAnalyze } from './core/analyze.js';
import { createHost, sandboxApi } from './sandbox/core.js';
import { PASSES } from './core/registry.js';

let shared = null;

/**
 * Yeni, yalıtılmış bir QuickJS sandbox'ı. Ağ yok, gerçek DOM yok, bellek ve süre sınırlı.
 * Bekçili (I182): Node'da worker_thread, tarayıcıda Web Worker; kilitlenen motor (felaket regex)
 * sonlandırılıp yeniden başlatılır. İkisi de yoksa (ör. tek dosyalık paket Node'da) süreç içinde çalışır.
 */
export async function createSandbox() {
  if (typeof process !== 'undefined' && process.versions?.node) {
    // değişken yol: tarayıcı paketine node:worker_threads girmesin
    const nodeHost = './sandbox/node-host.js';
    try {
      const { createNodeSandbox } = await import(/* @vite-ignore */ nodeHost);
      return createNodeSandbox();
    } catch {
      // tek dosyalık pakette yan dosya yok: aşağıdaki süreç içi host'a düş
    }
  } else if (typeof Worker !== 'undefined') {
    const { createWatchdog } = await import('./sandbox/watchdog.js');
    const dog = createWatchdog({
      spawn() {
        const w = new Worker(new URL('./sandbox/sandbox.worker.js', import.meta.url), { type: 'module' });
        return {
          post: (m) => w.postMessage(m),
          onMessage: (cb) => { w.onmessage = (e) => cb(e.data); },
          onError: (cb) => { w.onerror = (e) => cb(e.message); },
          terminate: () => w.terminate(),
        };
      },
    });
    return { ...sandboxApi(dog.send), watchdog: true, close: () => dog.terminate() };
  }
  const host = createHost(await getQuickJS());
  return sandboxApi(async (msg) => host.handle(msg));
}

async function resolveSandbox(sandbox) {
  if (sandbox === false || sandbox === null) return null;
  if (sandbox && typeof sandbox === 'object') return sandbox;
  shared ??= createSandbox();
  return shared;
}

function checkInput(input) {
  if (typeof input !== 'string') throw new TypeError('input string olmalı');
}

/**
 * @param {string} input
 * @param {import('./index.d.ts').DeobfuscateOptions} [options]
 */
export async function deobfuscate(input, options = {}) {
  checkInput(input);
  const { sandbox, level = 4, deep, ...rest } = options;
  const sb = await resolveSandbox(sandbox);
  return runPipeline(input, { level, sandbox: sb, deep: deep ?? Boolean(sb), ...rest });
}

/**
 * @param {{input: string, output: string, text?: string, events?: object[], sandbox?: boolean|object, config?: object}} o
 */
export async function analyze({ sandbox, ...o }) {
  checkInput(o.input);
  checkInput(o.output);
  return runAnalyze({ ...o, sandbox: await resolveSandbox(sandbox) });
}

/** Tek çağrıda çöz + analiz et. */
export async function peel(input, options = {}) {
  const sb = await resolveSandbox(options.sandbox);
  const result = await deobfuscate(input, { ...options, sandbox: sb ?? false });
  if (result.error) return { ...result, report: null };
  const report = await analyze({ input, text: result.text, output: result.code, events: result.events, sandbox: sb ?? false });
  return { ...result, report };
}

export const passes = () => PASSES.map(({ id, level, kind, needs }) => ({ id, level, kind, needs }));

export { semanticDiff, formatDiff, matchFunctions, extractFunctions, portNames } from './integrations/compare.js';
export { createHistory, memoryStore } from './integrations/history.js';
export { encodeShare, decodeShare, isEncrypted, shareUrl } from './integrations/share.js';
export { fastImportStream } from './integrations/gitexport.js';
export { buildReportHtml } from './integrations/report-html.js';
export { symbolMap, renameAcross } from './integrations/multifile.js';
export { readAsar, writeAsar, isScript } from './integrations/asar.js';
export { createProject, parseProject, serializeProject, validateProject, upsertFile, applyRenames } from './integrations/project.js';
export { definePlugin, importPluginSource } from './integrations/plugins.js';
export { generateKeyPair, signPlugin, verifyPlugin, fingerprint as keyFingerprint } from './integrations/signing.js';
export { parseRules, applyRules, rulesPlugin } from './integrations/rules.js';
export { toSarif } from './integrations/sarif.js';
export { resolveStyle, formatWithStyle } from './integrations/style.js';
export { TECHNIQUES, detectTechniques } from './integrations/techniques.js';
export { explainWhy } from './integrations/why.js';
export { anonymize, buildFixture } from './integrations/anonymize.js';
export { resilienceScore } from './integrations/resilience.js';
export { obfuscate, testOwnCode, PRESETS as OBFUSCATION_PRESETS } from './integrations/obfuscate.js';
export { PASS_DOCS, LESSONS, playLesson } from './integrations/tutorial.js';
export { CHALLENGES, buildChallenge, checkFlag } from './integrations/ctf.js';
export { PATTERN_CHANGELOG } from './integrations/changelog.js';
