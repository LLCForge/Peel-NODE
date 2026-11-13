import { isValidName } from './scope.js';
import { listSuggestions } from './names.js';

// 71: yerel LLM ile adlandırma (WebGPU). Model yalnızca kullanıcı açıkça isteyince indirilir (dinamik import:
// başlangıçta hiçbir şey yüklenmez); kod tarayıcıdan çıkmaz, model cihazda çalışır.
// WebGPU ya da model yoksa kural tabanlı ada (72) düşer.

const PREFERRED = [/^Qwen2\.5-Coder-0\.5B-Instruct-q4f16_1/, /^Qwen2\.5-Coder-1\.5B-Instruct-q4f16_1/, /^Qwen2\.5-0\.5B-Instruct-q4f16_1/, /^SmolLM2-360M-Instruct-q4f16_1/];
const MAX_ITEMS = 40;
const SNIPPET = 160;

let engine = null;
let engineModel = null;

export async function webgpuStatus() {
  const gpu = globalThis.navigator?.gpu;
  if (!gpu) return { ok: false, reason: 'WebGPU yok' };
  try {
    const adapter = await gpu.requestAdapter();
    return adapter ? { ok: true } : { ok: false, reason: 'WebGPU bağdaştırıcısı bulunamadı' };
  } catch (e) {
    return { ok: false, reason: `WebGPU: ${e?.message ?? e}` };
  }
}

// Önceden derlenmiş model listesinden küçük bir kod modeli seç (liste sürüme göre değişebilir: ad tahmin edilmez)
export function pickModel(list) {
  for (const re of PREFERRED) {
    const m = list.find((x) => re.test(x.model_id));
    if (m) return m.model_id;
  }
  const small = list.filter((x) => x.low_resource_required && typeof x.vram_required_MB === 'number')
    .sort((a, b) => a.vram_required_MB - b.vram_required_MB);
  return small[0]?.model_id ?? null;
}

/** Modeli indirir/yükler. onProgress({ progress: 0..1, text }) */
export async function loadModel(onProgress = () => {}) {
  const status = await webgpuStatus();
  if (!status.ok) throw new Error(status.reason);
  const webllm = await import('@mlc-ai/web-llm');
  const model = pickModel(webllm.prebuiltAppConfig.model_list);
  if (!model) throw new Error('uygun model bulunamadı');
  if (engine && engineModel === model) return { model };
  engine = await webllm.CreateMLCEngine(model, {
    initProgressCallback: (r) => onProgress({ progress: typeof r.progress === 'number' ? r.progress : 0, text: String(r.text ?? '') }),
  });
  engineModel = model;
  return { model };
}

export const modelLoaded = () => Boolean(engine);

// Model çıktısındaki JSON nesnesini güvenle ayrıştır: yalnızca bilinen eski adlar ve geçerli yeni adlar
export function parseModelNames(text, allowed) {
  const m = /\{[\s\S]*\}/.exec(String(text ?? ''));
  if (!m) return {};
  let data;
  try { data = JSON.parse(m[0]); } catch { return {}; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (allowed.has(k) && typeof v === 'string' && isValidName(v) && v !== k) out[k] = v;
  }
  return out;
}

// Her binding için tanım satırı ve kullanım bağlamı
function contextOf(code, items) {
  const lines = code.split('\n');
  return items.map((s) => {
    const line = s.line ? lines[s.line - 1]?.trim() ?? '' : '';
    return `- ${s.name} (${s.kind}, tip: ${s.type}${s.suggestion ? `, kural önerisi: ${s.suggestion}` : ''}): ${line.slice(0, SNIPPET)}`;
  }).join('\n');
}

/**
 * Ad önerileri: model yüklüyse LLM, değilse kural tabanlı. Dönüş { names, source: 'llm'|'rules', reason? }
 */
export async function suggestNames(code, { signal = null } = {}) {
  const items = listSuggestions(code).filter((s) => !s.blocked).slice(0, MAX_ITEMS);
  const rules = Object.fromEntries(items.filter((s) => s.suggestion).map((s) => [s.name, s.suggestion]));
  if (!engine) return { names: rules, source: 'rules', reason: 'model yüklü değil' };
  const allowed = new Set(items.map((s) => s.name));
  const prompt = `Aşağıdaki gizlenmiş JavaScript değişken/fonksiyon adları için anlamlı camelCase adlar öner.\n` +
    `Yalnızca JSON nesnesi döndür: {"eskiAd": "yeniAd", ...}. Açıklama yazma.\n\n${contextOf(code, items)}`;
  try {
    const res = await engine.chat.completions.create({
      messages: [
        { role: 'system', content: 'You rename identifiers in deobfuscated JavaScript. Reply with a JSON object only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 800,
    });
    if (signal?.aborted) throw new Error('İptal edildi');
    const names = parseModelNames(res.choices?.[0]?.message?.content, allowed);
    // modelin atladıklarını kural önerileriyle tamamla
    for (const [k, v] of Object.entries(rules)) if (!names[k]) names[k] = v;
    return { names, source: 'llm' };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { names: rules, source: 'rules', reason: `model hatası: ${e?.message ?? e}` };
  }
}

export async function unloadModel() {
  if (engine?.unload) await engine.unload();
  engine = null;
  engineModel = null;
}
