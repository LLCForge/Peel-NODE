import { sandboxApi } from './core.js';
import { applySettings, getSettings } from './settings.js';
import { createWatchdog } from './watchdog.js';

// Ana thread tarafı: sandbox worker'ına RPC. İstekler bekçiden geçer: motor kilitlenirse worker sonlandırılıp
// yeniden başlatılır (I182). kill() çalışan her şeyi keser.
const dog = createWatchdog({
  spawn() {
    const w = new Worker(new URL('./sandbox.worker.js', import.meta.url), { type: 'module' });
    return {
      post: (m) => w.postMessage(m),
      onMessage: (cb) => { w.onmessage = (e) => cb(e.data); },
      onError: (cb) => { w.onerror = (e) => cb(e.message); },
      terminate: () => w.terminate(),
    };
  },
  // arayüz ayarları (profil, zaman, depolama, sınırlar) her isteğe aynı biçimde uygulanır
  prepare: (msg) => applySettings(msg, getSettings()),
});

export const sandbox = {
  ...sandboxApi(dog.send),
  watchdog: true,
  watchdogStats: dog.stats,
  async health() {
    const r = await dog.send({ type: 'batch', list: ['1+1'] });
    return r.ok && r.results?.[0]?.value === 2;
  },
  kill() {
    dog.kill('Durduruldu');
  },
};
