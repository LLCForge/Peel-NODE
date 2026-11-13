import { el, tx } from './dom.js';
import { render as renderSettings } from './settings.js';
import { render as renderCoverage } from './coverage.js';
import { render as renderCallgraph } from './callgraph.js';
import { render as renderCapture } from './capture.js';
import { render as renderVerify } from './verify.js';
import { render as renderTools } from './tools.js';
import { getSettings, setSettings } from '../../sandbox/settings.js';
import { sandbox } from '../../sandbox/client.js';

// Rapor sekmesine eklenen çalışma anı bölümü: ayarlar her zaman; rapor varsa doğrulama, coverage, çağrı grafiği,
// yakalanan çalışma anı kayıtları ve isteğe bağlı araçlar.
export function mountRuntime(root, report) {
  const box = el('div', { class: 'rt' });
  const part = () => { const d = el('div'); box.append(d); return d; };
  if (report?.verification) renderVerify(part(), report);
  if (report?.dynamic) {
    const code = report.dynamic.code ?? {};
    renderCoverage(part(), { code: code.output ?? '', coverage: report.dynamic.coverage, observed: report.verification?.observed ?? [], traps: report.dynamic.traps ?? [] });
    renderCallgraph(part(), report.dynamic.coverage);
    renderCapture(part(), report.dynamic);
    renderTools(part(), { sandbox, report, text: code.text ?? null, output: code.output ?? '' });
  }
  const settingsBox = part();
  const onChange = (s) => setSettings(s);
  renderSettings(settingsBox, getSettings(), onChange);
  root.append(el('details', { class: 'rep-section', open: !report }, el('summary', {}, tx('runtime')), box));
  return box;
}
