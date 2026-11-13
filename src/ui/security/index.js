// Rapor görünümündeki güvenlik/motor bölümü: render(root, data, actions) düzeninde modüller
import { renderDetection, renderRuntimeSecurity, renderCrypto } from './findings.js';
import { renderTools } from './tools.js';

/**
 * @param {HTMLElement} root   bölümlerin ekleneceği kap
 * @param {object} data        analyze() raporu
 * @param {object} actions     { download, sandbox, getInput, setInput, getOutput, setOutput, getText, getSelection, snapshots }
 */
export function render(root, data, actions) {
  if (!data) return;
  renderDetection(root, data);
  renderRuntimeSecurity(root, data);
  renderCrypto(root, data);
  if (actions) renderTools(root, data, actions);
}
