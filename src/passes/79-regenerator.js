import { reverseRegenerator } from './96-babel.js';

// E56: regenerator durum makinesi → function* / async function. Uygulama 96-babel.js reverseRegenerator'dadır
// (klasik regeneratorRuntime.mark/wrap ve Babel 7.27+ kompakt _regenerator().m/w; try/catch/finally, döngü, if/else,
// yield*; _asyncToGenerator yardımcısı gövdesiyle tanınır). Okunabilirlik aşamasını beklemeden level 2'de çalışır.
export async function run(ast, { onLog, bump, naming = {} }) {
  if (naming.babel === false) return;
  const stats = { generators: 0, asyncs: 0 };
  reverseRegenerator(ast, stats);
  const n = stats.generators + stats.asyncs;
  if (n) onLog(`regenerator: ${stats.generators} generator, ${stats.asyncs} async fonksiyon geri çevrildi`, 'info');
  bump('regenerator', n);
}
