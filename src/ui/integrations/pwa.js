// H174: service worker kaydı. Yalnızca derlenmiş (üretim) sürümde ve güvenli bağlamda etkin;
// geliştirme sunucusunda önbellek, sıcak yeniden yüklemeyi bozmasın diye kaydedilmez.
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  if (!import.meta.env.PROD) {
    // aynı kökende daha önce `vite preview` ile kaydolmuş worker dev modüllerini eski önbellekten sunar: kaldır
    navigator.serviceWorker.getRegistrations()
      .then(async (regs) => {
        if (!regs.length) return;
        await Promise.all(regs.map((r) => r.unregister()));
        for (const key of await caches.keys()) await caches.delete(key);
        if (navigator.serviceWorker.controller) location.reload();
      })
      .catch(() => {});
    return;
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: './' }).catch(() => {
      // kayıt başarısız olursa uygulama çevrimiçi çalışmaya devam eder
    });
  });
}
