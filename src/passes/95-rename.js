import { renameAll } from '../naming/names.js';

// Üretilmiş isimler (_0x1a2b) kullanım kanıtından çıkarılan adlarla değiştirilir (72, E222–E226);
// kanıt yoksa deterministik arg/v/fn adları. Kullanıcı sözlüğü ve kalıcı ad haritası da burada uygulanır (E231, 87).
// with (E227), eval (E230) ve window.x (E228) kapsamları binding bazında korunur.
export async function run(ast, { onLog, bump, naming = {} }) {
  const { renamed, skipped } = renameAll(ast, {
    names: naming.names ?? {},
    auto: true,
    originalComments: Boolean(naming.originalComments),
  });
  const blocked = new Map();
  for (const s of skipped) blocked.set(s.reason, (blocked.get(s.reason) ?? 0) + 1);
  for (const [why, n] of blocked) onLog(`rename: ${n} isim korundu (${why})`, 'info');
  if (renamed.length) onLog(`rename: ${renamed.length} isim değiştirildi`, 'info');
  bump('rename', renamed.length);
}
