---
title: PEEL ile deobfuscation
---

# PEEL ile deobfuscation

Bu sayfa bir [Observable Framework](https://observablehq.com/framework/) sayfasıdır. npm gerekmez: PEEL kütüphanesi
tek dosyalık bir ESM paketi olarak derlenir ve sayfaya dosya eki (FileAttachment) olarak eklenir.

1. Depo kökünde `npm run build:lib` çalıştır: `extensions/observable/dist/peel.js` oluşur (QuickJS WASM gömülüdür).
2. `peel.js` dosyasını Framework projesinde bu sayfanın yanına kopyala (`src/peel.js`), bu sayfayı `src/peel.md` olarak kaydet.

PEEL tamamen tarayıcıda çalışır; kod hiçbir sunucuya gönderilmez.

```js
const peelLib = await import(await FileAttachment("peel.js").url());
const {peel, semanticDiff, formatDiff, detectTechniques, explainWhy} = peelLib;
```

```js
const input = view(Inputs.textarea({
  label: "Obfuscated JavaScript",
  rows: 8,
  value: 'var _0x1 = ["aHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vdjE=", "bG9n"]; function _0x2(i) { return atob(_0x1[i]); } console[_0x2(1)](_0x2(0));'
}));
```

```js
const result = peel(input);
```

## Çözülmüş kod

```js
html`<pre style="max-height: 420px; overflow: auto">${result.code}</pre>`
```

## Rapor

```js
Inputs.table([
  {alan: "Risk", değer: `${result.report.threat.risk.score}/100 (${result.report.threat.risk.level})`},
  {alan: "Teknikler", değer: detectTechniques(input).map((x) => x.nameTr).join(", ") || "-"},
  {alan: "URL'ler", değer: result.report.iocs.urls.join(", ") || "-"},
  {alan: "Davranış doğrulandı", değer: result.verified ? "evet" : "hayır"}
])
```

```js
explainWhy({input, report: result.report}).map((r) => html`<p><b>${r.title.tr}</b>: ${r.detail.tr}</p>`)
```

## Sürüm karşılaştırma

```js
const older = view(Inputs.textarea({label: "Eski sürüm", rows: 4, value: "function send(d) { return navigator.sendBeacon('/a', d); } send(1);"}));
const newer = view(Inputs.textarea({label: "Yeni sürüm", rows: 4, value: "function _0x9(_0x1) { return navigator.sendBeacon('/b', _0x1); } _0x9(1);"}));
```

```js
html`<pre>${formatDiff(semanticDiff(older, newer, {oldInput: older, newInput: newer}))}</pre>`
```
