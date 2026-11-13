// worker_threads tarafı: tarayıcıdaki sandbox.worker.js'in Node karşılığı
import { parentPort } from 'node:worker_threads';
import { getQuickJS } from 'quickjs-emscripten';
import { createHost } from './core.js';

const hostPromise = getQuickJS().then(createHost);

parentPort.on('message', async ({ id, ...msg }) => {
  let result;
  try {
    result = (await hostPromise).handle(msg);
  } catch (err) {
    result = { ok: false, error: err?.message ?? String(err) };
  }
  parentPort.postMessage({ id, ...result });
});
