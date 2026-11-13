import { defineConfig } from 'vite';

// H168: peel-js kütüphanesinin tek dosyalık, bağımsız ESM paketi (npm gerektirmez).
// QuickJS WASM ve isteğe bağlı javascript-obfuscator dahil her şey tek dosyaya gömülür; böylece
// Observable notebook'u dosyayı FileAttachment olarak ekleyip import() ile yükleyebilir.
// Çıktı: extensions/observable/dist/peel.js  (npm run build:lib)
// Tek dosyalık pakette worker yok (yan dosya üretilemez; quickjs/z3 worker'ları dinamik import içerdiği için iife worker
// derlemesi de kod bölme hatası verir):
//  - sandbox: tarayıcıda da süreç içi host kullanılır (index.js'in "ikisi de yoksa" yolu; bekçi yok)
//  - z3 (~50 MB wasm): tarayıcı yolu "kullanılamıyor" döner, yerleşik çözücü kullanılır (Node'da z3-solver yine yüklenir)
const NO_WORKER = [
  ['/src/index.js', [
    ["} else if (typeof Worker !== 'undefined') {", '} else if (false) {'],
    ["new Worker(new URL('./sandbox/sandbox.worker.js', import.meta.url), { type: 'module' })", 'null'],
  ]],
  ['/src/symbolic/z3/z3.js', [
    ["new Worker(new URL('./z3.worker.js', import.meta.url), { type: 'module' })",
      "(() => { throw new Error('tarayıcı: tek dosyalık pakette z3 worker yok, yerleşik çözücü kullanılıyor'); })()"],
  ]],
];
const noWorkers = {
  name: 'peel-lib-no-workers',
  enforce: 'pre',
  transform(code, id) {
    const hit = NO_WORKER.find(([suffix]) => id.replace(/\\/g, '/').endsWith(suffix));
    if (!hit) return null;
    let out = code;
    for (const [from, to] of hit[1]) {
      if (!out.includes(from)) throw new Error(`${hit[0]}: "${from}" bulunamadı (vite.lib.config.js güncellenmeli)`);
      out = out.replace(from, to);
    }
    return out;
  },
};

export default defineConfig({
  plugins: [noWorkers],
  define: { 'process.env': {} },
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: 'extensions/observable/dist',
    emptyOutDir: true,
    copyPublicDir: false,
    minify: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    lib: {
      entry: 'src/index.js',
      formats: ['es'],
      fileName: () => 'peel.js',
    },
    rollupOptions: {
      // obfuscator'ın tarayıcı derlemesi `self` bekliyor; modül kapsamında tanımlanır ki paket Node/worker'da da yüklensin
      output: { inlineDynamicImports: true, banner: 'const self = globalThis;' },
    },
  },
});
