import { defineConfig } from 'vite';

// E724: cross-origin isolation (SharedArrayBuffer → tarayıcıda Z3 wasm). Tüm kaynaklar aynı kökenden geldiği için
// require-corp bir şeyi bozmaz. Statik barındırmada aynı başlıklar public/_headers ile verilir.
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  // @babel/traverse tarayıcıda process.env okuyor
  define: { 'process.env': {} },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['quickjs-emscripten'] },
  build: { target: 'es2022' },
  server: { headers: ISOLATION },
  preview: { headers: ISOLATION },
});
