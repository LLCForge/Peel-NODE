// Node (CLI ve testler) için bekçili sandbox: QuickJS ayrı bir worker_thread'de çalışır; kilitlenen motor
// sonlandırılıp yeniden başlatılır (I182). Boşta worker süreci açık tutmaz (unref).
import { Worker } from 'node:worker_threads';
import { sandboxApi } from './core.js';
import { createWatchdog } from './watchdog.js';

const WORKER = new URL('./node-worker.js', import.meta.url);

export function createNodeSandbox({ deadline } = {}) {
  const dog = createWatchdog({
    deadline,
    spawn() {
      const w = new Worker(WORKER);
      let onErr = () => {};
      w.on('error', (e) => onErr(e?.message ?? String(e)));
      w.on('exit', (code) => { if (code !== 0) onErr(`worker çıktı (${code})`); });
      return {
        post: (m) => w.postMessage(m),
        onMessage: (cb) => w.on('message', cb),
        onError: (cb) => { onErr = cb; },
        terminate: () => { onErr = () => {}; w.terminate(); },
        ref: () => w.ref(),
        unref: () => w.unref(),
      };
    },
  });
  return { ...sandboxApi(dog.send), watchdog: true, watchdogStats: dog.stats, close: () => dog.terminate() };
}
