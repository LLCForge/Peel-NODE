// E724: tarayıcıda Z3 — yalnızca cross-origin isolated sayfada, ilk kullanımda yüklenir (ana thread'i bloklamaz).
// z3-built.js emscripten yapıştırıcısıdır (initZ3 global'i); modül worker'ında importScripts olmadığı için metni
// alınıp global kapsamda değerlendirilir. pthread worker'ları aynı betiği mainScriptUrlOrBlob ile yükler.
import { init } from 'z3-solver';
import z3BuiltUrl from 'z3-solver/build/z3-built.js?url';
import z3WasmUrl from 'z3-solver/build/z3-built.wasm?url';
import { checkWith } from './z3-core.js';

let ctxPromise = null;

function start() {
  ctxPromise ??= (async () => {
    self.global = self; // z3-solver tarayıcı girişi global.initZ3 okur
    // emscripten ortamı importScripts varlığıyla "worker" sayar; modül worker'ında yok → eşzamanlı XHR ile eşdeğeri
    if (typeof self.importScripts !== 'function') {
      self.importScripts = (...urls) => {
        for (const u of urls) {
          const x = new XMLHttpRequest();
          x.open('GET', u, false);
          x.send();
          (0, eval)(x.responseText);
        }
      };
    }
    const src = await (await fetch(z3BuiltUrl)).text();
    (0, eval)(`${src}\n;self.initZ3 = typeof initZ3 !== "undefined" ? initZ3 : self.initZ3;`);
    const api = await init({
      locateFile: (f) => (f.endsWith('.wasm') ? new URL(z3WasmUrl, self.location.href).href : f),
      // pthread'ler Blob'dan başlatılır: worker içinden URL ile iç içe worker yüklemesi bazı Chromium'larda COEP'e takılıyor
      mainScriptUrlOrBlob: new Blob([src], { type: 'text/javascript' }),
    });
    return api.Context('peel');
  })();
  return ctxPromise;
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  let result;
  try {
    if (type === 'init') { await start(); result = { ok: true }; }
    else if (type === 'check') result = await checkWith(await start(), e.data.prep, e.data.timeoutMs);
    else result = { ok: false, error: `bilinmeyen istek: ${type}` };
  } catch (err) {
    result = type === 'init' ? { ok: false, error: err?.message ?? String(err) } : { status: 'unknown', backend: 'z3', ms: 0, reason: `z3: ${err?.message ?? err}` };
  }
  self.postMessage({ id, result });
};
