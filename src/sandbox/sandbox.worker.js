import { getQuickJS } from 'quickjs-emscripten';
import { createHost } from './core.js';

const hostPromise = getQuickJS().then(createHost);

self.onmessage = async (e) => {
  const { id, ...msg } = e.data;
  let result;
  try {
    result = (await hostPromise).handle(msg);
  } catch (err) {
    result = { ok: false, error: err?.message ?? String(err) };
  }
  self.postMessage({ id, ...result });
};
