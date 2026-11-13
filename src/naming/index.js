import { parse } from '../core/parse.js';
import { libraries } from '../core/threat.js';
import { programSummary } from './summary.js';
import { compareReadability } from './metrics.js';
import { unresolved } from './unresolved.js';
import { libraryVersions } from './libversion.js';
import { listSuggestions } from './names.js';

// Anlamlandırma raporu: analiz sonrası hafif özetler (paket modülleri motor raporundan gelir: report.engine.bundle). Ağır görünümler (CFG, tanım-kullanım, sekans, açıklama)
// arayüzde sekme açılınca güncel çıktı üzerinden hesaplanır.

export function namingReport({ input, text, output, threat = null }) {
  let ast = null;
  try { ast = parse(output); } catch { /* çıktı parse edilemiyorsa yalnızca metin ölçümleri */ }
  const libs = libraries(output);
  const versions = ast ? libraryVersions(ast, libs.map((l) => l.name)) : [];
  const unres = ast ? unresolved(ast, output) : { items: [], counts: {} };
  const source = text ?? input;
  return {
    summary: ast ? programSummary(ast, { threat, libraries: libs.map((l) => ({ ...l, version: l.version ?? versions.find((v) => v.name === l.name)?.version ?? null })), unresolved: unres.items }) : '',
    readability: compareReadability(source, output),
    unresolved: unres,
    libraryVersions: versions,
    suggestions: listSuggestions(output),
  };
}
