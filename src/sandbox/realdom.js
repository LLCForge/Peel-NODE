// C65: onaylı gerçek DOM modu — kod, kullanıcının açık onayıyla gerçek tarayıcı motorunda, sayfadan yalıtılmış iki
// katmanlı bir iframe'de çalışır:
//  - dış çerçeve: sandbox="allow-scripts" (allow-same-origin YOK → opak köken; uygulamanın DOM'una, çerezine,
//    depolamasına erişemez), CSP default-src 'none' (fetch/XHR/WebSocket/img/script yüklemeleri engellenir),
//    frame-src 'none' (iç çerçevenin kendini dış URL'ye yönlendirmesi istek çıkmadan engellenir);
//  - iç çerçeve: aynı CSP'yi miras alır; kod burada çalışır. Popup, form, üst pencere yönlendirmesi sandbox ile kapalı.
// CSP'nin kapsamadığı kanallar (WebRTC, iç içe about:blank çerçeve) kayıt betiği tarafından kod çalışmadan kapatılır.
// Sonuçlar (konsol, hata, engellenen istek, DOM değişiklikleri, son DOM) postMessage ile gelir ve güvenilmez veridir.

export const CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; frame-src 'none'; child-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";
const MAX_FIELD = 20000;

// </script> ve satır ayırıcıları satır içi betikte güvenle taşınır
const embed = (s) => JSON.stringify(s).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const RECORDER = `(function () {
  var report = { console: [], errors: [], blocked: [], mutations: 0, listeners: {}, frames: 0 };
  var post = function (type, data) { parent.postMessage({ peelRealDom: TOKEN, type: type, data: data }, "*"); };
  ["log", "info", "warn", "error", "debug"].forEach(function (k) {
    var orig = console[k];
    console[k] = function () {
      try { report.console.push(k + ": " + Array.prototype.map.call(arguments, function (x) { try { return typeof x === "object" ? JSON.stringify(x) : String(x); } catch (e) { return String(x); } }).join(" ")); } catch (e) {}
      return orig.apply(console, arguments);
    };
  });
  addEventListener("error", function (e) { report.errors.push(String(e.message || e)); });
  addEventListener("unhandledrejection", function (e) { report.errors.push("reddedilen promise: " + String(e.reason)); });
  document.addEventListener("securitypolicyviolation", function (e) {
    var last = report.blocked[report.blocked.length - 1];
    if (last && last.uri === String(e.blockedURI || "") && last.directive === (e.effectiveDirective || e.violatedDirective)) return;
    report.blocked.push({ directive: e.effectiveDirective || e.violatedDirective, uri: String(e.blockedURI || "") });
  });
  var addL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (t) { report.listeners[t] = (report.listeners[t] || 0) + 1; return addL.apply(this, arguments); };
  // CSP dışı kanallar: WebRTC ve iç içe çerçeveler (yeni realm = kapatılmamış API'ler)
  ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate"].forEach(function (k) {
    try { Object.defineProperty(window, k, { value: undefined, writable: false, configurable: false }); } catch (e) {}
  });
  var FRAME = /<\\s*(iframe|frame|frameset|object|embed|portal)\\b/i;
  var isFrame = function (n) { return n && n.nodeType === 1 && /^(IFRAME|FRAME|FRAMESET|OBJECT|EMBED|PORTAL)$/.test(n.nodeName); };
  var hasFrame = function (n) { return n && (isFrame(n) || (n.querySelector && n.querySelector("iframe,frame,frameset,object,embed,portal"))); };
  var deny = function () { report.frames++; throw new DOMException("PEEL gerçek DOM modu: iç içe çerçeve engellendi", "SecurityError"); };
  [[Node.prototype, ["appendChild", "insertBefore", "replaceChild"]], [Element.prototype, ["append", "prepend", "after", "before", "replaceWith", "insertAdjacentElement", "replaceChildren"]],
   [DocumentFragment.prototype, ["append", "prepend", "replaceChildren"]], [Document.prototype, ["append", "prepend", "replaceChildren"]]].forEach(function (pair) {
    pair[1].forEach(function (m) {
      var orig = pair[0][m];
      if (typeof orig !== "function") return;
      Object.defineProperty(pair[0], m, { configurable: false, writable: false, value: function () {
        for (var i = 0; i < arguments.length; i++) if (typeof arguments[i] === "object" && hasFrame(arguments[i])) deny();
        return orig.apply(this, arguments);
      } });
    });
  });
  [[Element.prototype, "innerHTML"], [Element.prototype, "outerHTML"], [ShadowRoot.prototype, "innerHTML"]].forEach(function (pair) {
    var d = Object.getOwnPropertyDescriptor(pair[0], pair[1]);
    if (!d || !d.set) return;
    Object.defineProperty(pair[0], pair[1], { configurable: false, get: d.get, set: function (v) { if (FRAME.test(String(v))) deny(); return d.set.call(this, v); } });
  });
  var ins = Element.prototype.insertAdjacentHTML;
  Object.defineProperty(Element.prototype, "insertAdjacentHTML", { configurable: false, writable: false, value: function (p, h) { if (FRAME.test(String(h))) deny(); return ins.call(this, p, h); } });
  ["write", "writeln"].forEach(function (m) {
    var w = Document.prototype[m];
    Object.defineProperty(Document.prototype, m, { configurable: false, writable: false, value: function () { if (FRAME.test(Array.prototype.join.call(arguments, ""))) deny(); return w.apply(this, arguments); } });
  });
  var cr = Range.prototype.createContextualFragment;
  Object.defineProperty(Range.prototype, "createContextualFragment", { configurable: false, writable: false, value: function (h) { if (FRAME.test(String(h))) deny(); return cr.call(this, h); } });
  new MutationObserver(function (list) { list.forEach(function (m) { report.mutations += m.addedNodes.length + m.removedNodes.length + (m.type === "attributes" ? 1 : 0); }); })
    .observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  var snap = function (type) {
    post(type, { console: report.console.slice(0, 500), errors: report.errors.slice(0, 100), blocked: report.blocked.slice(0, 200),
      mutations: report.mutations, listeners: report.listeners, frames: report.frames, title: document.title,
      dom: (document.body ? document.body.outerHTML : "").slice(0, ${MAX_FIELD}) });
  };
  // ara görüntüler: kod sayfayı yönlendirmeye çalışırsa belge hata sayfasıyla değişir, son görüntü korunur
  var timer = setInterval(function () { snap("progress"); }, 400);
  addL.call(window, "pagehide", function () { snap("progress"); });
  addL.call(window, "beforeunload", function () { snap("progress"); });
  addL.call(window, "load", function () { setTimeout(function () { clearInterval(timer); snap("done"); }, DELAY); });
})();`;

export function buildRealDomDoc(code, { token, delayMs = 1500 } = {}) {
  if (typeof token !== 'string' || !/^[a-z0-9-]{8,64}$/i.test(token)) throw new Error('geçersiz belirteç');
  const meta = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  const recorder = RECORDER.replace('TOKEN', embed(token)).replace('DELAY', String(Math.max(0, Math.min(10000, delayMs | 0))));
  const inner = `<!doctype html><html><head>${meta}<script>${recorder}</script></head><body><script>(function () {
  var s = document.createElement("script"); s.textContent = ${embed(code)}; document.body.appendChild(s);
  s.remove();
})();</script></body></html>`;
  // dış çerçeve: iç çerçeveyi kurar, mesajları yalnızca iç çerçeveden alıp üst sayfaya iletir; engellenen yönlendirmeyi bildirir
  const outer = `<!doctype html><html><head>${meta}</head><body><script>(function () {
  var f = document.createElement("iframe");
  f.setAttribute("sandbox", "allow-scripts");
  f.setAttribute("referrerpolicy", "no-referrer");
  f.srcdoc = ${embed(inner)};
  var token = ${embed(token)};
  addEventListener("message", function (e) {
    if (e.source !== f.contentWindow || !e.data || e.data.peelRealDom !== token) return;
    parent.postMessage(e.data, "*");
  });
  document.addEventListener("securitypolicyviolation", function (e) {
    parent.postMessage({ peelRealDom: token, type: "violation", data: { directive: e.effectiveDirective || e.violatedDirective, uri: String(e.blockedURI || "") } }, "*");
  });
  document.body.appendChild(f);
})();</script></body></html>`;
  return outer;
}

const clip = (v, n = MAX_FIELD) => String(v ?? '').slice(0, n);
const strList = (a, n) => (Array.isArray(a) ? a.slice(0, n).map((x) => clip(x, 2000)) : []);

// Güven sınırı: iframe'den gelen veri doğrulanır ve kırpılır
export function sanitizeResult(d) {
  const o = d && typeof d === 'object' ? d : {};
  return {
    console: strList(o.console, 500),
    errors: strList(o.errors, 100),
    blocked: (Array.isArray(o.blocked) ? o.blocked : []).slice(0, 200).map((b) => ({ directive: clip(b?.directive, 64), uri: clip(b?.uri, 2000) })),
    mutations: Number.isFinite(o.mutations) ? o.mutations : 0,
    listeners: Object.fromEntries(Object.entries(o.listeners && typeof o.listeners === 'object' ? o.listeners : {}).slice(0, 50).map(([k, v]) => [clip(k, 64), Number(v) || 0])),
    frames: Number(o.frames) || 0,
    title: clip(o.title, 300),
    dom: clip(o.dom),
  };
}

// Tarayıcıda çalıştırır. consent === true olmadan hiçbir şey yapılmaz.
export function runRealDom(code, { consent = false, container = null, timeoutMs = 8000, delayMs = 1500 } = {}) {
  if (consent !== true) return Promise.reject(new Error('Gerçek DOM modu açık onay gerektirir'));
  if (typeof document === 'undefined') return Promise.reject(new Error('Gerçek DOM modu yalnızca tarayıcıda çalışır'));
  const token = `peel-${crypto.randomUUID()}`;
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; usb 'none'; serial 'none'; bluetooth 'none'; clipboard-read 'none'; clipboard-write 'none'");
  frame.setAttribute('title', 'PEEL gerçek DOM sandbox');
  frame.style.cssText = 'width:100%;height:240px;border:1px solid var(--line, #333);background:#fff';
  frame.srcdoc = buildRealDomDoc(code, { token, delayMs });
  const violations = [];
  return new Promise((resolve) => {
    let timer = null;
    let last = null;
    let finished = false;
    const done = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      removeEventListener('message', onMessage);
      resolve({ ...result, navigationBlocked: violations.filter((v) => v.directive === 'frame-src'), violations });
    };
    const onMessage = (e) => {
      if (e.source !== frame.contentWindow || !e.data || e.data.peelRealDom !== token) return;
      if (e.data.type === 'progress') last = sanitizeResult(e.data.data);
      if (e.data.type === 'done') done({ ok: true, ...sanitizeResult(e.data.data) });
      if (e.data.type === 'violation') {
        const v = sanitizeResult({ blocked: [e.data.data] }).blocked[0];
        violations.push(v);
        // engellenen yönlendirme belgeyi hata sayfasıyla değiştirir: son ara görüntüyle bitir
        if (v.directive === 'frame-src') setTimeout(() => done({ ok: true, navigated: true, ...(last ?? sanitizeResult({})) }), 300);
      }
    };
    addEventListener('message', onMessage);
    timer = setTimeout(() => done({ ok: false, error: 'zaman aşımı (sayfa yüklenmedi ya da kod kilitlendi)', ...(last ?? sanitizeResult({})) }), timeoutMs);
    (container ?? document.body).append(frame);
  }).finally(() => {
    // görsel inceleme için çerçeve kapsayıcı verildiyse kalır, yoksa kaldırılır
    if (!container) frame.remove();
  });
}
