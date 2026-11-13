// PEEL, observablehq.com notebook'u için hücreler (H168). Her blok ayrı bir hücreye yapıştırılır.
// Önce depo kökünde `npm run build:lib` çalıştırıp extensions/observable/dist/peel.js dosyasını
// notebook'a "peel.js" adıyla dosya eki olarak ekle (Files paneli). npm ya da CDN gerekmez; kod cihazdan çıkmaz.

// --- hücre 1
peelLib = import(await FileAttachment("peel.js").url())

// --- hücre 2
viewof input = Inputs.textarea({
  label: "Obfuscated JavaScript",
  rows: 8,
  value: 'var _0x1 = ["aHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vdjE=", "bG9n"]; function _0x2(i) { return atob(_0x1[i]); } console[_0x2(1)](_0x2(0));'
})

// --- hücre 3
result = peelLib.peel(input)

// --- hücre 4
html`<pre style="max-height: 420px; overflow: auto">${result.code}</pre>`

// --- hücre 5
Inputs.table([
  {alan: "Risk", değer: `${result.report.threat.risk.score}/100 (${result.report.threat.risk.level})`},
  {alan: "Teknikler", değer: peelLib.detectTechniques(input).map((x) => x.nameTr).join(", ") || "-"},
  {alan: "URL'ler", değer: result.report.iocs.urls.join(", ") || "-"},
  {alan: "Davranış doğrulandı", değer: result.verified ? "evet" : "hayır"}
])

// --- hücre 6
peelLib.explainWhy({input, report: result.report}).map((r) => html`<p><b>${r.title.tr}</b>: ${r.detail.tr}</p>`)
