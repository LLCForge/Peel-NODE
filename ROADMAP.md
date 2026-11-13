# PEEL Yol Haritası / Roadmap

`[x]` yapıldı · done   `[~]` kısmen · partial   `[ ]` planlandı · planned

Katkı yapmak istersen bir maddeyi seç ve aynı numarayla issue aç. / Pick an item and open an issue with its number.

## A. Çözme motoru · Deobfuscation engine

- [x] 1. Obfuscator parmak izi: hangi araçla (obfuscator.io, js-confuser, packer…) üretildiğini tahmin etme
- [x] 2. obfuscator.io ayarlarını (rotate, encoding, threshold) çıktıdan geri çıkarma — obfuscator.io ayarları girdiden çıkarılıyor: string dizisi, kodlama (none/base64/rc4), rotasyon ve sayısı, indeks ofseti, eşik, sarmalayıcı sayısı/türü, akış düzleştirme, ölü kod, numbersToExpressions, splitStrings, transformObjectKeys, selfDefending, debugProtection, disableConsoleOutput, isim üreteci, compact (rapor: engine.obfuscator)
- [x] 3. RC4/base64 string kodlaması — static-strings pass'i: base64/RC4 string dizisi sandbox olmadan yeniden yazılmış algoritmalarla çözülüyor; rotasyon checksum'ı statik yürütülüyor ve tutmadıkça hiçbir çağrı değiştirilmiyor
- [x] 4. Fonksiyon içine gömülmüş string dizileri (`_0x1234()` getter biçimi)
- [x] 5. Decoder ofsetini sembolik çıkarma — decoder ofseti (i = i - C, sayı ifadeli biçimler dahil) afin biçimden sembolik çıkarılıyor; log ve ayar raporunda gösteriliyor
- [x] 6. Kendini değiştiren decoder'lar — ilk çağrıda yakalanan fonksiyonla çözülüyor
- [x] 7. Obje tabanlı proxy'leri satır içi yazma — sabit nesne özellikleri ve ardışık kurulum (const-objects)
- [x] 8. Operatör proxy'leri (`o.KJs(a, b)` → `a + b`) — a+b, a<b, f(x) proxy nesneleri
- [x] 9. js-confuser dispatcher fonksiyonları — js-confuser dispatcher: fns tablosundaki girdiler ayrı fonksiyonlara çıkarılıyor; (payload=[..], D(k)), clear/createFunction/return-object bayrakları ve new biçimi çözülüyor, length gözlenebiliyorsa rest biçimi korunuyor
- [x] 10. js-confuser global gizleme tabloları (switch proxy + çalışma anında global nesne çözümü)
- [x] 11. Integrity/hash kontrollerini etkisizleştirip raporlama — integrity pass'i (ilk AST pass'i): kaynak hash kontrolünün orijinaldeki sonucu bağlamda hesaplanıp if seçilen dalla değiştiriliyor; rapor: engine.integrity (bulunan/etkisizleştirilen/kalan)
- [x] 12. Tekrarlanan literalleri geri birleştirme (js-confuser sabit literal dizisi)
- [x] 13. Sayısal artıkları katlama
- [x] 14. Template literal'lara gizlenmiş string'ler — ifadeli şablon literallerinde literal ifadeler metne gömülüyor (\, `, ${ kaçışlı); ifadesi kalmayan şablon string oluyor
- [x] 15. toString tabanlı tamper kontrolünü kaldırma
- [x] 16. `/abc/.source` regex string'lerini katlama
- [x] 17. Destructuring ile gizlenmiş atamalar — var/let/const ve atama destructuring'i (dizi/nesne literali) sıralı atamaya açılıyor; takas gibi kendine başvuran ya da yan etkili sıralı değerler korunuyor
- [x] 18. `void 0` artıkları ve virgül zincirleri
- [x] 19. `!0` / `!1` → `true` / `false`
- [x] 20. `a && b()` → if, iç içe ternary → if/else — a && b(), a || b(), ternary deyim → if; virgül zinciri → ayrı deyimler
- [x] 21. js-confuser `M.length = 2; M[0]` → gerçek parametreler — function f(...M) { M.length = N; M[k] } → N gerçek parametre (arguments yoksa ve fonksiyon yalnızca çağrılıyorsa)
- [x] 22. Generator tabanlı durum makinelerini düz fonksiyona çevirme — tslib/TypeScript __generator durum makinesi (yield/return/_a.sent) function*'a çevriliyor; __awaiter'a verilen üreteçler dahil; kullanılmayan yardımcı kaldırılıyor
- [x] 23. Sabit nesneli `with` bloklarını açık erişime çevirme — sabit nesne literalli with bloğu: anahtar ve Object.prototype adları O.x erişimine çevriliyor, blok açılıyor (gölgeleme/var/eval/delete varsa dokunulmuyor)
- [x] 24. Webpack/Rollup/esbuild bundle'larını modüllere ayırma — paket bölme: webpack 4/5 (dizi/nesne/chunk push), browserify, esbuild __commonJS/__esm, yol yorumlu kapsam birleştirmeli çıktı ve kaynak haritalı (Rollup) paketler modüllere ayrılıyor; bağımlılıklar çıkarılıyor; rapor engine.bundle, CLI --split <klasör>. Haritasız ve yorumsuz Rollup çıktısında modül sınırı bilgisi yok
- [x] 25. Kısmi source map ile isim kurtarma — sourcemap metin pass'i: satır içi kaynak haritasındaki adlar bağlamalara yazılıyor (kısmi harita: yalnızca eşlenen konumlar), çakışmada dokunulmuyor; CLI --source-map <dosya>

## B. VM / durum makinesi · VM / state machines

- [x] 26. Geçiş tablosuna koşulları ekleme — Statik keşifte dal koşullu kenarlar; makine yorumunda ve raporda koşullu geçiş tablosu
- [x] 27. Concolic çoklu yol keşfi — Somut çalıştırma + concolic çoklu yol keşfi: ctx.solver (src/symbolic/vm-solver.js) dal günlüğünden yol koşullarını çıkarıp alınmayan dalı çözer; bulunan girdiyle çalıştırma doğrulanır (feasible), kesin önekli UNSAT kanıtlı olanaksız, çözülemeyen dal zorlanır ve doğrulanmamış işaretlenir
- [x] 28. Durum makinesini düz koda çevirme — for/do-while/etiketli makine döngüleri, case içi let/const, makineye etiketli break/continue eklendi; kanıtlanamayan biçimler kural gereği bırakılır
- [x] 29. Sayaç aritmetiği — Toplam dışında -, *, ^, |, &, kaydırma ve nesne alanı sayaçları tek durum değişkenine
- [x] 30. z3.wasm ile opaque koşul kanıtı — opaque-smt z3-solver ile (Node'da her zaman, tarayıcıda cross-origin isolated ise worker); katlama yalnızca yerleşik CDCL çözücünün bağımsız, DRUP denetimli kanıtıyla; raporda kanıtlayan arka uç gösterilir
- [x] 31. jsvmp bytecode VM'ler için disassembler — Genel dağıtım döngüsü tespiti + kısmi değerlendirmeyle disassembly (rapor, CLI --vm-out)
- [x] 32. VM bytecode → JS lifter — vm-lift pass'i: sembolik yığınla pc makinesine, unflatten ile yapısal JS'e; çağrı dönüşleriyle doğrulanır
- [x] 33. Stack VM derinlik analizi — Durum başına yığın derinliği keşifte hesaplanır; disassembly'de d=, raporda en büyük derinlik
- [x] 34. Opcode handler'larını davranıştan adlandırma — Sandbox izinde yığın değişiminden ad (PUSH/ADD/STORE…), statik adla uyum sütunu
- [x] 35. İnteraktif geçiş grafiği — src/ui/vm/graph.js: sürüklenebilir, tıklayınca vurgulayan SVG geçiş grafiği
- [x] 36. Ulaşılmayan case'leri işaretleme — Tam statik keşifte kanıtlı, değilse hiçbir çalıştırmada görülmeyen case'ler; yorum ve rapor
- [x] 37. VM sürümlerini eşleştirme — Rol duyarlı handler imzaları (motor/tablo); raporda ve 'peel vm-compare' ile eşleştirme
- [x] 38. Şifreli bytecode'u çalışma anında yakalama — Döngü girişinde bytecode, sabit havuzu ve durum sandbox'ta çağrı yeri bazında yakalanır
- [x] 39. VM'nin çağırdığı native API listesi — Çevrilmiş koddan native/host API çağrı listesi; durum makinelerinde case çağrıları
- [x] 40. Durum başına yan etki özeti — Case başına çağrılar, durum dışı yazmalar, dönüş/atma ve geçiş şablonu
- [x] 41. Adım adım durum makinesi debugger'ı — src/ui/vm/debugger.js: kayıtlı iz üzerinde ileri/geri, kaydırıcı ve kesme noktası
- [x] 42. Geçiş tablosunda arama — src/ui/vm/table.js: serbest metin ve alan sorgulu (from:/to:/cond:/kaynak:) arama
- [x] 43. İç içe VM'ler — Handler içindeki VM ve çevrilen kodda ortaya çıkan iç VM'ler; derinlik işaretiyle sırayla çevrilir
- [x] 44. Zamanlama tabanlı anti-debug nötralizasyonu — 78-anti-timing: Date.now/performance.now farkıyla tetiklenen anti-debug dalları kaldırılır
- [x] 45. Makineyi orijinal fonksiyon sınırlarına bölme — Parametreden başlayan makine, çağrı yerindeki başlangıçlara göre ayrı fonksiyonlara bölünür; raporda bölgeler

## C. Sandbox ve dinamik analiz · Sandbox & dynamic analysis

- [x] 46. Seçilebilir tarayıcı profilleri — Rapor > Çalışma anı > Sandbox ayarları: profil seçici; ayar tüm sandbox isteklerine (temel ve aday aynı) uygulanır
- [x] 47. Bot ve gerçek kullanıcı profili karşılaştırması — Araçlar > Profilleri karşılaştır: iki profil yan yana (konsol, ağ, parmak izi, taint, yalnızca bir tarafta görülenler, etki farkı)
- [x] 48. Ağ çağrılarını engelleyip kaydetme (fetch, XHR, WebSocket, beacon, image, script)
- [x] 49. Sahte fetch/XHR yanıtları — yapılandırmadaki URL eşleşmesine göre fetch/XHR yanıtı
- [x] 50. Zaman makinesi — Ayarlardan zaman (datetime) ve tohum; determinizm denetimi zamana/rastgeleliğe bağımlılığı raporlar
- [x] 51. Eksik global detektörü — ReferenceError mesajlarından
- [x] 52. Fingerprint envanteri (navigator/screen/document/location okumaları)
- [x] 53. Canvas/WebGL/Audio fingerprint — Canvas fillText/measureText/getImageData/toDataURL, WebGL getParameter/getExtension, Audio düğümleri ve startRendering çağrı kaydı
- [x] 54. Taint takibi — Gölge bellekle değer tabanlı taint: çerez/depolama/navigator/konum/WebGL değerinin ağ çıkışında ham, URI, base64, hex ya da ters görünmesi
- [x] 55. eval/Function ile üretilen kod — Analiz çalıştırmasında eval (doğrudan eval yerel kapsamı korunarak), Function/AsyncFunction/GeneratorFunction, setTimeout(string), document.write ve script metni yakalanır
- [x] 56. Timer ve Promise kuyruğunu sırayla çalıştırma — Promise iş kuyruğu boşaltılıyor; setInterval geri çağrıları analizde bir kez çalıştırılıyor
- [x] 57. Sentetik olaylarla handler tetikleme — kayıtlı işleyiciler analizde sentetik olayla tetikleniyor
- [x] 58. Sandbox anlık görüntüsü — Oturum anlık görüntüsü: kayıt + yığın grafiği; geri yükleme yeniden oynatıp yığın özetini doğrular (src/sandbox/replay.js)
- [x] 59. Deterministik replay — peel-replay kaydı taze runtime'da adım adım yeniden oynatılır, etki ve yığın özetleri karşılaştırılır, sapma adımı bildirilir
- [x] 60. Global nesne ağacı — programın eklediği global ad ve tipleri
- [x] 61. Çalışma anı çağrı grafiği — Enstrümante çıktı çalıştırması: çağıran→çağrılan kenarları ve sayıları, katmanlı SVG + tablo
- [x] 62. Coverage renklendirme — Deyim sayaçlarıyla satır coverage'ı; çıktı kodu çalışan/çalışmayan satır renkleriyle gösterilir
- [x] 63. Sonsuz döngü / anti-debug tuzağını gösterme — Döngü sayaçları, zaman aşımında son döngü ve çağrı yığını; statik debugger/zamanlayıcı/devtools/zamanlama/sonsuz döngü tuzakları
- [x] 64. WASM import/export — Gömülü ayrıştırıcıyla WebAssembly stub'ı: import/export imzaları, bellek/tablo, sağlanan import'lar, export çağrıları; koddaki gömülü modüller statik
- [x] 65. Onaylı gerçek DOM modu — Açık onayla iki katmanlı sandbox iframe (allow-scripts, opak köken) + CSP: ağ ve dış yönlendirme engellenir, WebRTC/iç içe çerçeve kapatılır; tarayıcıda doğrulandı
- [x] 66. Worker kodunu ayrı sandbox'ta çalıştırma — Blob/data URL worker kodu ayrı sandbox bağlamında (pencere yok) çalışır; mesajlar ana programla 3 tura kadar gidip gelir; dış URL yalnızca sahte yanıttan
- [x] 67. Cookie ve localStorage'ı önceden doldurma — Ayarlardan çerez ve localStorage (JSON) doldurma
- [x] 68. `subtle.encrypt` girdi/çıktısını yakalama — crypto.subtle çağrıları algoritma ve veri önizlemesiyle
- [x] 69. Pass başına süre profili
- [x] 70. Bellek/süre sınırlarını arayüzden ayarlama — Ayarlardan bellek (16–1024 MB) ve süre (500–60000 ms) sınırları; tüm sandbox isteklerine uygulanır

## D. Anlamlandırma · Making sense of code

- [x] 71. Yerel LLM ile adlandırma (WebGPU) — src/naming/llm.js: WebGPU + @mlc-ai/web-llm, model yalnızca kullanıcı düğmeye basınca dinamik import ile yüklenir; WebGPU/model yoksa kural tabanlı önerilere düşer (Adlar sekmesi)
- [x] 72. Kural tabanlı ad önerisi — src/naming/suggest.js + 95-rename: dönüş tipi, özellik adları, API çağrıları ve string içeriğinden ad; tüm anlamsız adlar için öneri listesi
- [x] 73. Fonksiyon açıklama yorumları — 99-annotate: her fonksiyona @summary açıklaması (ağ, DOM, depolama, olay, döngü, çağrılar)
- [x] 74. Bilinen kütüphaneleri tanıma (LZString, CryptoJS) — imza tablosu: jQuery, lodash, CryptoJS, LZString, pako, FingerprintJS, GA, Facebook Pixel, CoinHive, React, axios, forge, JSEncrypt
- [x] 75. Kütüphane sürümü tespiti — src/naming/libversion.js: banner/@version yorumları ve VERSION/version/fn.jquery sabitlerinden sürüm; Özet sekmesi
- [x] 76. TypeScript tip çıkarımı — src/naming/types.js: literal, bilinen API, kullanım ve çağrı yeri tiplerinden çıkarım; JSDoc @param/@returns ve .d.ts (Tipler sekmesi, CLI --dts)
- [x] 77. Prototype → `class` — 96-classes: prototype atamaları class'a; new/instanceof dışı kullanım, for-in/yansıma, metodun çağrı dışı okunması ve sıkı mod farkı varsa atlanır
- [x] 78. ES5 → modern sözdizimi — 97-let-const/modern-syntax/destructure: let/const, yerleşik callback'lerde ok fonksiyonu, primitive kanıtlı şablon string, kısa özellik/metot, nesne ayrıştırma
- [x] 79. Babel/regenerator kalıntılarını geri çevirme — 96-babel + naming/regenerator.js + naming/babel-extra.js + 96-classes: klasik ve 7.27+ kompakt regenerator → function*/async; _asyncToGenerator; _createClass/_inherits/_callSuper/_createSuper/_superPropGet/_get ve gevşek _inheritsLoose/_proto/S.call(this) → class extends + super; _createForOfIteratorHelper(Loose) ve dizi indeks döngüsü → for-of; _slicedToArray/_toArray → dizi deseni; _toConsumableArray, [].concat, f.apply(o, [...]) → yayma; _objectSpread/_defineProperty/(_o = {}, …) → nesne literali; _objectWithoutProperties(Loose) → { a, ...rest }; _typeof → typeof; _extends → yayma (kaynakta kendi __proto__ olamıyorsa, yoksa Object.assign). Gerçek Babel 7.20/7.24/7.28 ve loose çıktılı fixture'lar. Kanıtsız durumlar atlanır: gevşek yardımcının generator üzerinde döngüsü (break'te return() farkı), dizi olduğu bilinmeyen _arrayLikeToArray/apply
- [x] 80. Satır satır açıklama modu — src/naming/explain.js: deyim başına TR/EN açıklama, Satır açıklaması sekmesi
- [x] 81. Tek paragraf özet — summary.programSummary: tehdit, kütüphane ve çözülemeyenlerle tek paragraf; Özet sekmesi
- [x] 82. Sihirli sayıları adlandırma — 98-magic: zaman, tuş kodu, HTTP durumu, readyState, nodeType, karakter kodu ve kripto/hash sabitleri adlandırılmış const olur
- [x] 83. URL, anahtar ve regex listesi
- [x] 84. Ölü kodu katlanmış gösterme — src/naming/deadcode.js: erişilemeyen kod, sabit koşullu dallar, çağrılmayan fonksiyonlar katlanmış <details> olarak (Ölü kod sekmesi)
- [x] 85. Kopya fonksiyonları birleştirme — 98-dedupe: aynı kapsamda yapısal olarak eş fonksiyonlar, yalnızca çağrılan kopya birleşir
- [x] 86. Modüllere bölme — Paket ayırma tek uygulama: core/bundle.js (webpack, browserify, esbuild, kaynak haritalı, AMD eklendi; report.engine.bundle ve CLI --split); Anlamlandırma > Modüller sekmesi tek tek ya da ZIP indirme (naming/zip.js)
- [x] 87. Kalıcı yeniden adlandırma — ui/naming/state.js: girdi özetine bağlı ad haritası tarayıcıda saklanır, her çözümde ve anında uygulanır; .peel projesinin adları (integrations/project.js applyRenames) aynı scope-güvenli yeniden adlandırıcıyı kullanır
- [x] 88. Paylaşılabilir ad haritaları — names.serializeNameMap/parseNameMap: JSON dışa/içe aktarma (doğrulamalı), CLI --names
- [x] 89. CFG görseli — Tek uygulama araç panelindeki grafik görünümü (ui/graph-model.js cfg + graph-view.js); anlamlandırma panelindeki kopya kaldırıldı
- [x] 90. Tanım-kullanım zinciri — Ulaşan tanımlar ve def-use zincirleri analysis/defs.js (semantik altyapı) üzerinden; Anlamlandırma > Tanım-kullanım sekmesi bağlama başına tanım/kullanım satırlarını gösterir
- [x] 91. Sekans diyagramı — src/naming/sequence.js + SVG: yerel çağrılar, dış API katılımcıları, opt/loop çerçeveleri, callback'ler
- [x] 92. Okunabilirlik ölçümü — src/naming/metrics.js: önce/sonra isim, satır, karmaşıklık, iç içelik, gizleme izi ölçümleri
- [x] 93. Karmaşıklık ısı haritası — fonksiyon başına döngüsel karmaşıklıkla satır ısı haritası (Okunabilirlik sekmesi)
- [x] 94. Çözülemeyenler — naming/unresolved.js: temel kalıntılar ui/code-intel.js remnants ile aynı tanım; tablo erişimi, kodlanmış/kaçışlı string, string zamanlayıcı, debugger, with, VM eklenir; satır ve nedenle rapor
- [x] 95. Açıklamalı diff — src/naming/diffnotes.js: pipeline anlık görüntüleri arasında pass açıklamalı fark blokları

## E. Güvenlik ve tehdit analizi · Security & threat analysis

- [x] 96. Skimmer/miner/keylogger sınıflandırması — skimmer, madenci, tuş kaydedici, kimlik toplama, yönlendirme, parmak izi, dinamik kod
- [x] 97. Magecart tespiti — ödeme alanları + dışarı gönderim
- [x] 98. Exfiltration haritası — Canary'li çerez/depolama/UA ile kaynak → hedef exfiltration haritası (düz, base64, hex, ters, URL kodlu)
- [x] 99. IOC çıkarma (domain, URL, IP, e-posta, cüzdan, JWT, gömülü anahtar) + JSON dışa aktarma
- [x] 101. YARA kuralı üretme — çözülmüş string ve IOC'lerden
- [x] 102. IDS imzası — Suricata DNS/TLS SNI/HTTP URI kuralları
- [x] 103. Anti-bot sinyal raporu — Gerçek tarayıcı ve headless profil farkı, bot tespit API'leri, 15 bot koruma sağlayıcısı imzası
- [x] 104. Gizlilik (GDPR) raporu — üçüncü taraflar, çerez, depolama, parmak izi
- [x] 105. npm supply-chain karşılaştırması — registry.npmjs.org'dan yalnızca açık istekle indirme (adres önce gösterilir), SHA-512 bütünlük, tar açma, satır/IOC/API farkı, kurulum betikleri
- [x] 106. Tarayıcı eklentisi (.crx/.xpi) analizi — .crx (CRX2/3) / .xpi / .zip tarayıcıda açılır; izin riski, içerik/arka plan betikleri, CSP, güncelleme adresi, JS dosya taraması, girdiye yükleme
- [x] 107. Phishing kit endpoint'leri — Telegram/Discord/Slack webhook, Apps Script, form servisleri, gate.php, tünel, çıplak IP uç noktaları; kimlik alanı gönderimiyle sınıflandırma
- [x] 108. Redirect zinciri — location.href/assign/replace ve window.open kaydı
- [x] 109. Risk skoru kartı — 0–100 skor, sınıf ağırlıkları
- [x] 110. Şüpheli API kullanımı
- [x] 111. Dışarıdan yüklenen ikinci aşama script'ler (script src / image / fetch yakalama)
- [x] 112. Polimorfik varyant aileleri — MinHash (soyut token şingılları) + AST şekli + ortak IOC ile varyant aileleri; oturum koleksiyonu, JSON dışa/içe aktarma
- [x] 113. Script değişim takibi — Etiket başına anlık görüntü; hash, satır, IOC, API, sınıf, risk farkı ve uyarılar; geçmiş JSON dışa/içe aktarma
- [x] 114. Olay müdahale raporu — Markdown + JSON olay müdahale raporu: SHA-256, risk, IOC, exfil, phishing, anti-bot, kripto, kurallar, öneriler, maskeleme; UI ve CLI --incident
- [x] 115. Paylaşmadan önce anahtar maskeleme — JWT, Stripe/AWS/Google/GitHub/Slack anahtarları, e-posta, uzun gizli string

## F. Arayüz ve editör · UI & editor

- [x] 116. Monaco/CodeMirror editör — CodeMirror 6 editör: sözdizimi renklendirme, satır numarası, katlama, bul/değiştir, çoklu imleç (src/ui/editor.js)
- [x] 117. Senkron kaydırma — Senkron kaydırma: eşleme çapalarıyla, yoksa orantılı (ayar + komut)
- [x] 118. Çıktıdan girdiye kaynak eşleme — Çıktıdan girdiye eşleme: token hizalama (patience) ile tam/yaklaşık karşılık vurgusu, Girdide/Çıktıda göster (src/ui/srcmap.js)
- [x] 119. Pass zaman çizelgesi
- [x] 120. Pass hariç tutup yeniden çözme — Pass'ler panelinde işareti kaldırılan pass hariç tutulup yeniden çözülür (ayarda saklanır)
- [x] 121. Komut paleti — Komut paleti: bulanık arama, ':' satıra, '@' sembole git (Ctrl+Shift+P / F1)
- [x] 122. F2 yeniden adlandırma — F2 yeniden adlandırma: kapsam çakışması ve global gölgeleme denetimi, kısayol özellik/import/export korunur, geri alınabilir
- [x] 123. Go to definition / references — F12 tanıma git, Shift+F12 referanslar (bağlama, global ve özellik adları), geri/ileri gezinme geçmişi
- [x] 124. String/çağrı içinde regex arama — Regex arama kapsamı: tüm kod, yalnız string'ler, yalnız çağrılar, yorumlar
- [x] 125. Çok sekme — Çok sekme: sekme başına ayrı editör durumu ve geri alma geçmişi, sonuçlar
- [x] 126. Proje modu (klasör/zip) — Proje modu: klasör aç/sürükle ve zip; dosyalar grup halinde sekmeye, bağımlılık grafiği ve toplu çözme
- [x] 127. 10 MB+ için sanal kaydırma — CodeMirror yalnızca görünen satırları çizer; fark görünümü sanal satır listesi; ağır katmanlar 3 MB üstünde kapalı
- [x] 128. Kalan süre tahmini — Kalan süre tahmini: onProgress yüzdesine göre durum çubuğunda
- [x] 129. Aydınlık tema / yüksek kontrast — Aydınlık ve yüksek kontrast temaları (sistem temasını izleme dahil)
- [x] 130. Mobil okuma modu — Mobil düzen: tek panel + geçiş sekmeleri, kaydırma jesti; çıktı başlığında okuma modu
- [x] 131. IndexedDB oturum kaydı — IndexedDB oturum kaydı: sekmeler, gruplar, girdi/çıktı, notlar, raporlar, kayıtlı aramalar otomatik saklanır ve açılışta geri yüklenir (ayardan kapatılabilir)
- [x] 132. Satır notları ve yer imleri — Satır notları ve yer imleri: oluk işaretleri, Notlar paneli, F8 gezinme, oturumda saklanır
- [x] 133. Sonuç kartı (rapor + durum çubuğu özeti)
- [x] 134. Onaylı URL'den indirme — Onaylı URL'den indirme: adres başına açık onay, onaylı adres listesi, kimlik bilgisi/referer gönderilmez, boyut ve süre sınırı
- [x] 135. Zip/crx/har sürükle-bırak — Pencereye zip/crx/har/klasör sürükle-bırak (zip okuyucu: store/deflate, crx2/crx3 başlığı)
- [x] 136. HAR toplu çözme — HAR'daki JS yanıtları (base64 dahil) grup olarak açılır ve sırayla toplu çözülür
- [x] 137. Kısayol rehberi — Kısayol rehberi (Shift+F1): grup grup, aranabilir, buradan atama yapılır
- [x] 138. Biçimlendirme tercihleri — Biçimlendirme tercihleri: printWidth, tabWidth, semi, singleQuote, trailingComma, bracketSpacing, arrowParens
- [x] 139. Girdi/çıktı fark görünümü
- [x] 140. Erişilebilirlik — Erişilebilirlik: tüm sekme listeleri/ağaç/liste/menü/diyalog ARIA ve klavyeyle, odak halkaları, odak tuzağı, F6 panel geçişi, atlama bağlantısı

## G. Karşılaştırma ve sürüm takibi · Comparison & versioning

- [x] 141. Semantik diff — yeniden adlandırmayı yok sayan yapısal AST diff (src/integrations/compare.js), CLI peel diff, Araçlar > Karşılaştır
- [x] 142. Sürümler arası fonksiyon raporu — fonksiyon bazında aynı/değişmiş/eklenmiş/silinmiş raporu, eklenen string ve API'lerle
- [x] 143. Script izleme — peel track <dosya|url> ile izleme; arayüzde aynı adlı dosyanın yeni sürümü önceki sürümle karşılaştırılıp log'a yazılır
- [x] 144. "Bunu daha önce gördün" uyarısı — aynı girdi, aynı çözüm ve yapısal benzerlik (fonksiyon özetleri Jaccard) uyarısı; CLI --history ve arayüz
- [x] 145. BinDiff tarzı eşleştirme — özet + çağrı grafiği yayılımı + benzerlik ile BinDiff tarzı fonksiyon eşleştirme
- [x] 146. Çözüm geçmişi — çözüm geçmişi: tarayıcıda IndexedDB, CLI'da ~/.peel/history.json; geri yükleme ve silme
- [x] 147. Adları yeni sürüme taşıma — portNames: eşleşen fonksiyonların adları ve yerel değişken adları yeni sürüme taşınır, çakışmalar atlanır
- [x] 148. Yeni teknik uyarısı — ham girdide teknik tespiti; yeni sürümde ilk kez görülen teknik için uyarı (CLI, arayüz, VS Code)
- [x] 149. Regresyon kontrolü (`npm test`, davranış karşılaştırmalı fixture'lar)
- [x] 150. Çıktı özeti (FNV-1a)
- [x] 151. Git commit dizisi olarak dışa aktarma — pass başına commit içeren git fast-import akışı; CLI --git <dizin> depoyu doğrudan kurar, arayüz .fi dosyası indirir
- [x] 152. Paylaşılabilir önce/sonra raporu — bağımsız, betiksiz, CSP'li önce/sonra HTML raporu (CLI --html, arayüz) ve # içinde taşınan paylaşım bağlantısı
- [x] 153. Çoklu dosya sembol eşleme — dosyalar arası sembol haritası, bağımlılık kenarları ve tüm dosyalarda yeniden adlandırma (peel symbols, Araçlar > Dosyalar)
- [x] 154. Electron asar açma — saf JS asar okuyucu/yazıcı, yol geçişi korumalı; peel asar -o dizin -D ve arayüzde .asar açma
- [x] 155. Sürüm etiketi ve not — geçmiş kayıtlarına sürüm etiketi ve not (peel history label/note, arayüz, track --label/--note)

## H. Entegrasyon · Integrations

- [x] 156. CLI (`peel input.js -o out.js --report report.json`)
- [x] 157. npm kütüphane API'si — package.json exports: peel-js (deobfuscate/analyze/peel + entegrasyonlar) ve peel-js/node, TypeScript tipleri
- [x] 158. VS Code eklentisi — extensions/vscode: çözme, seçim çözme, analiz + tanılama, sürüm karşılaştırma; npm run pack-core && npm install && npm run package ile .vsix derlendi (Marketplace'e yayımlanmadı)
- [x] 161. Burp Suite / mitmproxy eklentisi — extensions/mitmproxy (yerel REST sunucusuyla uçtan uca denetlendi) ve extensions/burp (Jython, Extender API; Burp içinde çalıştırılarak denetlenmedi)
- [x] 162. GitHub Action — action.yml (composite) + action/run.js: glob, toplu çözme, SARIF, risk eşiği, adım özeti; yerelde ortam değişkenleriyle denetlendi
- [x] 163. Self-host REST API — peel serve: yalnızca loopback, Bearer token, Host/Origin denetimi, gövde sınırı, kuyruk, zaman aşımı
- [x] 164. `.peel` proje formatı — .peel proje biçimi: dosyalar, seçenekler, kurallar, kullanıcı adları, notlar; CLI --project/--save-project ve arayüz
- [x] 165. Pass eklenti sistemi — pipeline plugins seçeneği, after ile yerleşim, çekirdek doğrulama/geri alma eklentiler için de geçerli
- [x] 166. İmzalı eklenti paylaşımı — Ed25519 imzalı .peelplugin, güvenilen anahtar listesi olmadan yükleme yok (CLI peel plugin, arayüz)
- [x] 167. Dönüşüm kuralı dili — kural dili: $x / $$x meta değişkenleri, when koşulları; eklenti pass'i olarak çalışır (CLI --rules, arayüz)
- [x] 168. Jupyter/Observable — Jupyter sarmalayıcısı + örnek notebook; Observable için npm gerektirmeyen tek dosyalık ESM paketi (npm run build:lib, WASM gömülü) FileAttachment ile yüklenir; Node testi ve tarayıcıda blob URL'den import ile denetlendi
- [x] 169. Slack/Discord botu — peel bot: Slack (HMAC imza) ve Discord (Ed25519 imza) eğik çizgi komutu, loopback'e bağlı; gerçek Slack/Discord çalışma alanında denenmedi
- [x] 170. CI'da fixture regresyonu (`npm test`)
- [x] 171. ESLint/Prettier yapılandırmasına uyma — .prettierrc / package.json#prettier / .eslintrc.json / .editorconfig okunur; CLI --style auto
- [x] 172. Semgrep — extensions/semgrep/peel.yml kural seti ve CLI --semgrep (yerel semgrep, metrics kapalı), bulgular rapora ve SARIF'e eklenir
- [x] 173. SARIF dışa aktarma — SARIF 2.1.0: tehdit sınıfları, şüpheli API'ler, IOC'ler, geri almalar ve Semgrep bulguları (CLI, REST, Action, arayüz)
- [x] 174. PWA / çevrimdışı — manifest + service worker (kabuk ve derlenmiş dosyalar önbellekte); gömülü tarayıcı SW desteklemediği için çevrimdışı akış burada çalışırken gözlenemedi
- [x] 175. Tauri masaüstü sürümü — src-tauri (Tauri 2): cargo build ile derlendi; boş invoke yüzeyi, sıkı CSP; kurulum paketleri için cargo tauri build gerekir

## I. Doğrulama ve güven · Verification & trust

- [x] 176. Güven skoru — Güven skoru: doğrulama düzeyi, geri almalar, gözlem dönüşümleri, coverage, başarı metriği ve denetim sonuçlarından, gerekçeleriyle
- [x] 177. Gözlemle yapılan değişiklikleri ayrı renkle gösterme — Gözlemle (sandbox pass'leri) üretilen literal'ler olaylara kaydedilir, çıktıda vurgulu renkle gösterilir
- [x] 178. Diferansiyel fuzz — Gramer üretimli ortamlarda girdi/çıktı diferansiyel fuzz; ayrışan ortam küçültülür; doğrulama orkestrasyonu ve Araçlar'da
- [x] 179. Fonksiyon bazında eşdeğerlik testi — Üst seviye fonksiyonlar eşleştirilip iki bağlamda sembolik + gramer argümanlarıyla çağrılır; SMT kanıtı ve küçültülmüş karşı örnek
- [x] 180. Geri alınan pass'lerin nedeni
- [x] 181. Pass başına risk rozeti — Pass başına low/medium/high rozeti ve gerekçeleri (gözlem, geri alma, doğrulama düzeyi, yeniden yapılandırma)
- [x] 182. Sandbox kaçış testi paketi — 19 durumluk kaçış paketi; motor bekçisi (tarayıcı Web Worker, Node/CLI worker_thread) kilitlenen motoru sonlandırıp yeniden başlatır ve zaman aşımı döndürür; statik ReDoS dedektörü kalıpları çalıştırmadan önce bildirir; felaket regex durumu testte
- [x] 183. Gerçek obfuscator benchmark'ı (`npm run bench`: 12 obfuscator.io + 10 js-confuser ayarı)
- [x] 184. Başarı metriği — Başarı metriği 0–100: decoder çağrısı, _0x, VM işareti ve boyut azalımının ağırlıklı toplamı
- [x] 185. Yanlış sonuç bildirme şablonu — Maskelenmiş Markdown issue şablonu üreteci (kopyala/indir, URL'ye gömülmez) + .github/ISSUE_TEMPLATE/wrong-result.md
- [x] 186. Determinizm kontrolü — Deobfuscation iki kez çalıştırılıp çıktı SHA-256'sı karşılaştırılır (Araçlar > Determinizm)
- [x] 187. Pass süre bütçesi
- [x] 188. Bellek göstergesi — QuickJS bellek kullanımı her çalıştırmada ölçülür; rapor göstergesi ve telemetri tepe değeri
- [x] 189. İmzalı sürümler ve SBOM — CycloneDX SBOM betiği + etikette Sigstore köken/SBOM tasdikli, SHA256SUMS'lu sürüm iş akışı; iş akışı CI'da henüz çalıştırılmadı
- [x] 190. "Dış ağ isteği yok" göstergesi

## J. Öğrenme ve paylaşım · Learning & sharing

- [x] 191. Eğitim modu — eğitim modu: her pass'in açıklaması ve derslerin gerçek motorla adım adım oynatılması (arayüz, peel learn)
- [x] 192. CTF modu — 5 CTF görevi, cihazda seed'li obfuscator.io ile üretilir, bayrak SHA-256 ile denetlenir; testte hepsi PEEL ile çözüldü
- [x] 193. Obfuscation teknikleri ansiklopedisi — 22 teknik: açıklama, neden kullanıldığı, çözen pass'ler, tespit desenleri ve testte doğrulanan örnekler
- [x] 194. Kendi kodunu obfuscate edip test etme — kendi kodunu obfuscator.io ön ayarlarıyla gizleyip PEEL ile çözme ve davranış karşılaştırması (arayüz, peel obfuscate --test)
- [x] 195. Dayanıklılık skoru — dayanıklılık skoru: yapısal benzerlik, string geri kazanımı ve kalıntı gizleme izleri (0-100)
- [x] 196. Uçtan uca şifreli paylaşım — PBKDF2-SHA256 (600k) + AES-256-GCM ile şifreli, fragment'ta taşınan paylaşım; parola ayrı kanaldan, hiçbir yere yükleme yok
- [x] 197. Anonimleştirilmiş fixture katkısı — göstergeleri örnek değerlerle değiştiren anonimleştirme, çözülmüş çıktıdaki gizli sızıntı uyarısı, fixture dosyası ve kullanıcı tıklamasıyla açılan issue taslağı
- [x] 198. Türkçe / İngilizce arayüz
- [x] 199. "Neden gizlenmiş olabilir" açıklaması — teknik, obfuscator imzası ve tehdit bulgularından kanıtlı, güven düzeyli olası nedenler (arayüz, HTML rapor, peel explain, REST)
- [x] 200. Yeni kalıplar changelog'u — depo geçmişinden derlenmiş kalıp changelog'u, arayüzde görülmemiş girişler için yeni rozeti, peel changelog

---

# Genişletilmiş yol haritası / Extended roadmap (E26–E750)

Önerilen numaralar korunmuştur; yukarıdaki 1–200 ile çakışanlar burada da yer alır.
Henüz tanımlanmamış aralıklar: E241–E250 (I) ve E331–E500 (M–T).
Numbering follows the proposal; overlaps with items 1–200 are kept. Ranges E241–E250 and E331–E500 are not defined yet.

## E-A. Motor, dedeksiyon, yapılandırma (E26–E60)

- [x] E26. Obfuscator imza veritabanı (40+ araç, skor eşiğiyle otomatik profil) — 48 araç imzası, 0–100 skor, eşikle otomatik pass profili; Ayarlar → Otomatik pass profili açıkken uygulama, CLI'da --profile auto uygular; eşik altında tüm pass'ler
- [x] E27. Pass başına 0–100 güven skoru — Pass türü, davranış doğrulaması ve geri alma oranından 0–100 güven skoru (rapor)
- [x] E28. Yapılandırma geri çıkarma (rotate, threshold, splitStrings) — engine-report obfuscatorSettings (obfio modeli) — kodlanmış splitStrings, parça uzunluğu ve kodlanmış selfDefending denetleyicisi bu grupta eklendi
- [x] E29. Araç parmak izi raporu — Rapor bölümü: araç, skor, kanıt, profil, sürüm, geri çıkarılan ayarlar, decoder zinciri
- [x] E30. Aynı aracın sürümlerini ayırt etme — obfuscator.io (0.x–1.x / 2.0–2.9 / ≥2.10 / ≥2.13), js-confuser 1.x/2.x, jsjiami, sojson, packer, webpack sürüm ayrımı
- [x] E31. Bilinmeyen araç modu — her çalıştırma tüm pass'leri en yüksek seviyede koşar
- [x] E32. Pass sırası arama — Varsayılan, decoder önce, yapı önce, ters ve tohumlu karışık sıralar; doğrulanmış en düşük gizlilik skoru (UI + CLI --order-search)
- [x] E33. Kademeli saldırı — Seviye 1→4 kademeli çözme, her aşamanın doğrulanmış çıktısı sonrakinin girdisi (UI + CLI --cascade)
- [x] E34. Bağımlı pass'leri de kapsayan geri alma zinciri — Zaman çizelgesinde davranışı ilk bozan pass ikili aramayla bulunur, bağımlı pass'lerle geri alınıp pass dışarıda bırakılarak yeniden çalıştırılır
- [x] E35. Deterministik mod
- [x] E36. Seçili bölgede artımlı çözme — Seçim tüm program bağlamıyla çözülür: kapsayan fonksiyon yönergeyle, program seviyesi seçim yorum işaretleriyle (keepComments) ya da token hizalamasıyla eşlenip yerine konur; davranış ve dış ad denetimi; uygulamadaki seçimi çöz komutu önce bunu dener
- [x] E37. Fonksiyon içi string dizi getter'ı
- [x] E38. Decoder ofset çözümü — 31-static-strings (obfio): decoder ofseti afin biçimden sembolik, rotasyon checksum'ı statik; sandbox'sız base64/rc4/none
- [x] E39. Kendini değiştiren decoder
- [x] E40. Çok katmanlı decoder zinciri — Sarmalayıcı → decoder zincirleri statik çözülür (31-static-strings + wrappers); zincir derinliği raporlanır
- [x] E41. Obje proxy satır içi yazma — const-objects pass'i (mevcut): sabit nesne özellikleri ve ardışık kurulum satır içine yazılır
- [x] E42. Operatör proxy — const-objects pass'i (mevcut): o.KJs(a, b) → a + b operatör/çağrı proxy'leri
- [x] E43. js-confuser dispatcher — 37-confuser pass'i: js-confuser dispatcher fonksiyonları (new ve referans bayrakları dahil) ayrı fonksiyonlara açılır
- [x] E44. Global gizleme tablosu — çağrılar global adlara çözülüyor
- [x] E45. Bölünmüş string birleştirme
- [x] E46. Tekrarlanan literal toplama (sabit indeksli okumalar yerine yazılıyor)
- [x] E47. Sayısal artefakt katlama
- [x] E48. `toString` tamper tespiti ve silme (obfuscator.io selfDefending dahil)
- [x] E49. Regex `.source/.flags/.length` katlama — Regex .flags/.global/…/.source/.toString() ve literal .length mevcut pass'lerce katlanır
- [x] E50. Destructuring gizleme açma — Literal destructuring 42-indirection'da; kaynak düz ad olan nesne deseni (var {log: l} = console → console.log) 86-restructure'da
- [x] E51. `void 0` ve virgül zinciri — 86-restructure: void 0 → undefined (gölgelenmemişse); virgül zinciri bölme mevcut
- [x] E52. `!0` / `!1` → boolean
- [x] E53. `a && b()` → if — simplify pass'i (mevcut, A-20): a && b() → if, a || b() → if (!a)
- [x] E54. İç içe ternary → if/else — 86-restructure: return/atama/var içindeki iç içe ternary → if/else zinciri
- [x] E55. `M.length=2; M[0]` → gerçek parametreler — 37-confuser: function f(...M) { M.length = 2; M[0] } → gerçek parametreler
- [x] E56. Generator tabanlı durum makinesi — 79-regenerator: doğrusal akış, if/else, döngü (break/continue), try/catch/finally (tamamlanma kaydıyla), yield*, async → function*/async
- [x] E57. Sabit `with` bloğu açma — 42-indirection: sabit nesneli with → açık erişim
- [x] E58. Bundle ayırma — bundle.js: webpack 4/5, webpackChunk, browserify, esbuild, yol yorumu ve kaynak haritalı Rollup + bu grupta Parcel ve ZIP için modül dosyaları; UI ve CLI --split
- [x] E59. Source map ile isim kurtarma — 05-sourcemap pass'i (satır içi harita); harici .map UI'da ve CLI --source-map ile girdiye satır içi eklenir
- [x] E60. Çıktı için source map üretme — ui/srcmap.js token hizalamasıyla çıktı → girdi Source Map v3 (UI indirme + CLI --out-map)

## E-B. String kodlama ve çözme (E61–E95)

- [x] E61. Base64 varyantları — Statik: standart/URL-safe/dolgusuz/MIME/ters base64, basE91; özel alfabeli obfuscator.io base64 31-static-strings ile sandbox'sız
- [x] E62. Base32/Base58/Base85 — Base32, Base58, Ascii85 (rapor)
- [x] E63. Hex string
- [x] E64. Unicode kaçışları
- [x] E65. Octal kaçışları
- [x] E66. HTML entity — HTML entity (rapor)
- [x] E67. Percent encoding — static-decode: decodeURIComponent/decodeURI literal ya da sabit bağlamalı argümanla, sandbox'sız
- [x] E68. UTF-16 / UTF-7 / CESU-8 — UTF-16 LE/BE mevcut; UTF-7 (RFC 2152) ve CESU-8/Java değiştirilmiş UTF-8 çözücüleri
- [x] E69. ROT-n — ROT-n, İngilizce harf sıklığı (ki-kare)
- [x] E70. Atbash
- [x] E71. Vigenère / Sezar — Vigenère anahtarı sütun sütun ki-kare ile; Sezar = ROT-n
- [x] E72. Tek bayt XOR — 255 anahtar, okunabilirlik puanı
- [x] E73. Çok bayt XOR (Kasiski) — anahtar uzunluğu 2–8, sütun başına tek bayt XOR
- [x] E74. RC4 (obfuscator.io rc4 benchmark'ta tam)
- [x] E75. AES-CBC/CTR — AES-128/192/256 ECB/CBC/CTR/CFB/OFB (FIPS-197, SP 800-38A vektörleri); koddan anahtar/IV ile ya da Salted__ parola modu
- [x] E76. DES/3DES — DES ve 2/3 anahtarlı 3DES EDE (FIPS 46-3, SP 800-67 vektörleri)
- [x] E77. RSA parça çözümü — PEM/DER (PKCS#1/PKCS#8/SPKI) ya da n/e/d/p/q parçalarından anahtar; küçük/yakın asal modül çarpanlara ayrılır; PKCS#1 v1.5 çözüm
- [x] E78. TEA/XTEA/XXTEA — TEA, XTEA, XXTEA (referans vektörleri; büyük/küçük-uçlu, xxtea-js uzunluk biçimi)
- [x] E79. Blowfish — Blowfish (pi tabloları BigInt ile hesaplanır; Eric Young vektörleri)
- [x] E80. Özel alfabeli base64
- [x] E81. `String.fromCharCode(...)`
- [x] E82. `fromCharCode.apply(null, arr)`
- [x] E83. `join` tabanlı sayı çözümü — static-decode: literal/sabit dizi join, split/reverse/join zinciri, sandbox'sız
- [x] E84. `parseInt(x, 16)` zinciri — static-decode: parseInt(x, taban)/parseFloat/Number sabit argümanlarla
- [x] E85. `unescape`/`escape` — static-decode: unescape/escape
- [x] E86. `encodeURI` ailesi — static-decode: encodeURI/encodeURIComponent
- [x] E87. BigInt ile paketlenmiş string — büyük tamsayıdan bayt açma
- [x] E88. Bitsel paketleme — Rastgele genişlikte bit açma (5–16, MSB/LSB); rapordaki otomatik arama tüm genişlikleri tarar, 5/6 bit İngilizce sıklık eşiğiyle süzülür
- [x] E89. Uint8Array + TextDecoder — static-decode: new TextDecoder(enc).decode(new Uint8Array([...]) | Uint8Array.from) statik katlanır
- [x] E90. Sıkıştırılmış blob — LZString (base64/UTF16/URI/ham), gzip/zlib/raw deflate (DecompressionStream ya da saf JS), brotli (yerel ya da brotli@1.3.3)
- [x] E91. `atob(x).split("").reverse().join("")`
- [x] E92. Çok katmanlı zincir — Çok katmanlı zincir (base64 → hex → gzip …) en okunabilir sonuca kadar izlenir, katman sayısı raporda
- [x] E93. Ayrı fonksiyondan anahtar toplayan şifreli tablo — RC4 anahtarı ayrı sarmalayıcı fonksiyonların parametrelerinden gelen şifreli tablo 31-static-strings ile sandbox'sız çözülür
- [x] E94. Çalışma anında üretilen alfabe
- [x] E95. Kodlama raporu — rapor: çıktıdaki string'lerin kodlama adayları ve çözümleri

## E-C. Proxy ve dolaylılık (E96–E120)

- [x] E96. Switch proxy
- [x] E97. Fonksiyon proxy (`W("k")(...)`) — function W(k) { return T[k] } / { … }[k] fonksiyon proxy'leri: W("a")(x) → f(x); üye değerleri (0, X.y) ile this'siz yazılıyor
- [x] E98. İki argümanlı proxy — const-objects
- [x] E99. Proxy zinciri — sarmalayıcı zincirleri tek pass'te açılıyor: açılan argümanlardaki literal aritmetik katlanıp tekrar ediliyor
- [x] E100. Getter proxy — get k() { return X } getter proxy'leri okuma yerinde X'e çevriliyor (nesne kaçmıyor, ad aynı bağlamaya çözülüyor)
- [x] E101. Sınıf üye proxy — sınıf statik operatör/çağrı metotları ve literal statik alanlar çağrı yerinde açılıp sınıf kaldırılıyor
- [x] E102. `window["x"]` → nokta notasyonu
- [x] E103. Global alias sadeleştirme
- [x] E104. `self`/`globalThis` birleştirme — typeof ... ? globalThis : window : self … merdivenleri, window.window/self.self/X.globalThis zincirleri globalThis/ad olarak birleştiriliyor
- [x] E105. `this` proxy — new Function("return this")(), getGlobal gövdesi, function(){}.constructor("return this")(), (0, eval)("this"), (function(){return this})() (strict ise void 0) çözülüyor
- [x] E106. `arguments[0]` → parametre adı
- [x] E107. `bind` düzleştirme — f.bind(T, …)(…) → f.call(T, …) (f bilinen fonksiyon) ve o.m.bind(o)(…) → o.m(…)
- [x] E108. `.call/.apply` düzleştirme — yalnızca this undefined iken
- [x] E109. Kısmi uygulama açma — var g = f.bind(T, literal…) çağrı yerlerinde f.call(T, …)'a açılıyor; sarmalayıcılar literal olmayan argümanlarla (sıra korunuyorsa) açılıyor
- [x] E110. Sarmalayıcı fonksiyon sökme — literal argümanlı sarmalayıcılar çağrı yerinde açılıyor (wrappers)
- [x] E111. Kimlik fonksiyonu
- [x] E112. Operatör fonksiyonu — bağımsız operatör/çağrı fonksiyonları (program kapsamında yalnızca seviye 4) tüm çağrılarda açılıp siliniyor
- [x] E113. Sabit döndüren fonksiyon
- [x] E114. `o["m"].call(o, …)` → `o.m(…)`
- [x] E115. `Object.create` sarmalını açma — Object.create(null | Object.prototype | {…}, tam yetkili tanımlayıcılar) nesne literaline (__proto__ ile) çevriliyor; get/set tanımlayıcıları metoda
- [x] E116. `Reflect.get/set` — Reflect.get/set/has/apply/construct doğrudan biçime çevriliyor (hedef kesin nesne, set yalnızca sloppy modda ve sonucu kullanılmıyorsa)
- [x] E117. `Object.defineProperty` sabit değer — yazılamaz/yapılandırılamaz Object.defineProperty sabit değeri tanımdan sonraki okumalara yazılıyor
- [x] E118. Symbol anahtarlarını isimlendirme — Symbol("…")/Symbol.for("…") tutan üretilmiş adlar açıklamadan symXxx olarak adlandırılıyor
- [x] E119. `eval` sarmalayıcı
- [x] E120. `Function` sarmalayıcı

## E-D. Sabit katlama ve sadeleştirme (E121–E150)

- [x] E121. Aritmetik
- [x] E122. Bitsel
- [x] E123. Karşılaştırma
- [x] E124. Mantıksal
- [x] E125. `typeof`
- [x] E126. `instanceof` / `in` — literal instanceof yerleşik kurucu → false, [..] instanceof Array/Object → true, "k" in {literal}/[..] → true/false (prototipteki adlara dokunulmuyor)
- [x] E127. Dizi metotları
- [x] E128. String metotları
- [x] E129. `Math.*` (random hariç)
- [x] E130. `JSON.parse/stringify`
- [x] E131. `Number/String/Boolean`
- [x] E132. `parseInt/parseFloat`
- [x] E133. İfadesiz şablon literal
- [x] E134. Parçaları sabit şablon literal
- [x] E135. RegExp `.source/.test`
- [x] E136. `!!x` → `Boolean(x)` — boolean bağlam dışında !!x → Boolean(x)
- [x] E137. `~~x` — x int32 iken
- [x] E138. `+""` — +"…", +true, +null, +[] sayı literaline katlanıyor
- [x] E139. `x|0` — x int32 iken
- [x] E140. `0+x` — 0 + x / x + 0 → x (x int32), x - 0 → x (x number)
- [x] E141. `x*1`, `x+0`, `x**1` — x number iken
- [x] E142. `x*0` — x * 0 → 0 yalnızca x yan etkisiz, sonlu ve negatif olamıyorsa (>>> sonucu, & pozitif maske, negatif olmayan literal)
- [x] E143. De Morgan
- [x] E144. Çift olumsuzlama kaldırma
- [x] E145. `true?x:y` / `false?x:y`
- [x] E146. `x?x:y` → `x||y`
- [x] E147. `x?y:y` → `y`
- [x] E148. Boş blok temizliği
- [x] E149. Özdeş atama
- [x] E150. `delete` katlama

## E-E. Kontrol akışı (E151–E175)

- [x] E151. String-order dispatcher
- [x] E152. Sayı-order dispatcher — sayı dizili dispatcher sırası; sıra anahtarları türüyle karşılaştırılıyor ("2" ile 2 eşleşmiyor)
- [x] E153. İç içe dispatcher — dış makine açılınca iç makineler sonraki turda açılıyor
- [x] E154. Trace ile sıra kurtarma — statik olmayan ama deterministik sıra ifadesi değerlendirme bağlamında çalıştırılıp gözleniyor ve dispatcher düzleştiriliyor
- [x] E155. Dallanan dispatcher → if/else (somut durum yürütme, iki yol ayrı ayrı)
- [x] E156. Çoklu yol keşfi — makine içindeki durum yazan iç switch if zincirine açılıyor, iki yol ayrı yürütülüyor
- [x] E157. Koşul fonksiyonu kurtarma — durum ataması tek bir durumdan bağımsız koşula bağlıysa (P = c ? a : b, P += (x > 2) * k) koşul gerçek if olarak kurtarılıyor
- [x] E158. `do/while` dispatcher — do { switch } while (T) makineleri (ilk turda test yok)
- [x] E159. `for(;;)` dispatcher — for (init; T; U) { switch } makineleri (her turda güncelleme, başlangıç korunuyor)
- [x] E160. Etiketli blok dispatcher — etiketli makine döngüleri: break L çıkış, continue L yeni tur
- [x] E161. `try/catch` akış gizleme — try { güvenli…; throw LIT } catch (e) { H } → güvenli…; { let e = LIT; H }; fırlatamayan try gövdesinde catch siliniyor
- [x] E162. Koşullu `return` düzleştirme — return a(), b(), x → deyimler + return; karmaşık dallı return ?: → if/return
- [x] E163. `switch` → if zinciri — ≤3 case'li literal testli switch → if/else if zinciri (grup ve default dahil, döngüdeki makine switch'leri hariç)
- [x] E164. `switch` → tablo — literal döndüren ≥4 case'li switch → new Map([...]).get(x) ?? varsayılan
- [x] E165. Dispatcher döngüsünü while/do-while.a çevirme
- [x] E166. `break/continue` normalizasyonu — döngü sonundaki continue ve son case'teki break siliniyor, en içteki hedefe giden etiketli atlama etiketsiz yazılıyor, kullanılmayan etiketler kaldırılıyor
- [x] E167. Sabit koşulda ölü dal budama
- [x] E168. İç içe aynı koşullu if birleştirme
- [x] E169. `else` sonrası erken çıkış
- [x] E170. Guard cümlesi üretimi — fonksiyon/döngü gövdesi sonundaki if (c) { … } → if (!c) return/continue; …
- [x] E171. Tek iterasyonlu döngüyü açma
- [x] E172. `while(true){…break}` → blok
- [x] E173. Yineleme tanıma — çağrı grafiğinde Tarjan ile doğrudan ve karşılıklı özyineleme tanınıyor (rapor: engine.flow.recursion)
- [x] E174. Çözülemeyen bölge için DOT/Mermaid — açılamayan döngü+switch makinelerinin durum geçiş grafiği Mermaid ve DOT olarak üretiliyor (rapor: engine.flow.unresolved)
- [x] E175. Akış raporu — akış raporu: fonksiyon/döngü sayısı, en derin iç içelik, döngüsel karmaşıklık, en karmaşık fonksiyonlar, dispatcher önce/sonra

## E-F. VM ve durum makineleri (E176–E200)

- [x] E176. Register VM tespiti
- [x] E177. Stack VM tespiti — push/pop ve işaretçili (S[sp++]) yığınlar genel olarak tanınır ve çevrilir
- [x] E178. String opcode VM — charCodeAt ile okunan, XOR'lu string bytecode tanınır, yakalanır ve çevrilir
- [x] E179. Sayaç toplamı discriminant → `__peelS`
- [x] E180. XOR/çarpım discriminant — XOR/çarpım/bit işlemli durum ifadeleri __peelS'e alınıp açılır
- [x] E181. Opcode şablon kütüphanesi — Sembolik etkiye göre opcode şablon kütüphanesi (semantics.js TEMPLATES)
- [x] E182. Ham gövde koruması — Ham yorumlayıcı korunur: özeti çıktı yorumunda, kaynağı raporda/indirilebilir; değişiklik yalnızca doğrulanınca
- [x] E183. İşaretleyici ile trace
- [x] E184. Proxy ile state gözleme — Nesne alanında tutulan durum için sandbox'ta Proxy ile yazma gözlemi
- [x] E185. `with` içindeki switch'e ulaşma
- [x] E186. Terminatör modelleme — return/throw ve döngü çıkışı uçları grafikte ve raporda
- [x] E187. `default` dalı — default dalına düşen durumlar kaydedilir ve raporlanır
- [x] E188. Geçiş tablosu
- [x] E189. Opcode isimlendirme — Statik (şablon) ve dinamik (iz) opcode adları; disassembly ve case yorumlarında
- [x] E190. Opcode kaldırma — Bytecode VM'ler tamamen kaldırılır: yorumlayıcı, handler tablosu ve bytecode bildirimi
- [x] E191. Dallanma şablonları — Case geçiş şablonları (sabit/artımlı/koşullu/tablo/hesaplanan) ve JZ/JNZ/JCMP dal şablonları
- [x] E192. Sembolik yorumlayıcı — src/core/vm/interp.js: yan etki sırasını koruyan sembolik yorumlayıcı
- [x] E193. Bytecode'u ayrı dosyaya çıkarma — Raporda bytecode/assembly/ham yorumlayıcı indirme; CLI --vm-out
- [x] E194. Assembler/disassembler — Disassembler + assembler, gidiş-dönüş doğrulamalı; arayüz ve 'peel asm'
- [x] E195. Çoklu çalıştırma sentezi — Temel ve zorlanmış çalıştırmaların geçişleri birleştirilir, kaynağıyla etiketlenir
- [x] E196. Tekrar eden durumları döngüye çevirme
- [x] E197. `__peelS` sonrası ölü aritmetik temizliği — Makine sonrası yalnızca yazılan durum değişkenlerinin saf atamaları ve bildirimleri temizlenir
- [x] E198. jsvmp özel modu — CLI --jsvmp: VM odaklı pass seti, handler ve disassembly özeti
- [x] E199. VM raporu — Raporda 'VM ve durum makineleri' bölümü
- [x] E200. VM çıktısı doğrulama — Orijinal ve çevrilmiş program VM çağrı dönüşleri ve konsol çıktısıyla karşılaştırılır; fark varsa uygulanmaz

## E-G. Ölü kod ve bütünlük (E201–E220)

- [x] E201. Self-defending IIFE ve callController geri çağrıları
- [x] E202. Debug protection
- [x] E203. Zamanlama tabanlı anti-debug — debugger etrafındaki Date.now/performance.now/new Date() süre ölçümü ve eşik dalı kaldırılıyor, normal dal korunuyor
- [x] E204. `console` tespiti — console tespiti: disableConsoleOutput dizisi, console metodu üzerine yazma, döngüde console.clear, getter/toString tuzaklı nesne loglama, console.profile (rapor: engine.integrity.console)
- [x] E205. Bütünlük hash kontrolü tespiti — kaynak (toString) hash'leyen fonksiyonlar ve sabitle karşılaştıran kontroller ile selfDefending regex kontrolü tespit ediliyor
- [x] E206. Bütünlük bloğunu silme — tespit edilen bütünlük bloğu, orijinal sonucu bağlamda doğrulanarak seçilen dalla değiştiriliyor (integrity pass'i)
- [x] E207. Bütünlük raporu — bütünlük raporu: kontrol türü, fonksiyon, hash fonksiyonu, korunan fonksiyon, etkisizleştirilen ve çıktıda kalan sayısı
- [x] E208. Kullanılmayan fonksiyon
- [x] E209. Kullanılmayan değişken
- [x] E210. Kullanılmayan parametre — yalnızca doğrudan çağrılan fonksiyonlarda kullanılmayan parametre ve çağrı yerindeki yan etkisiz argümanı siliniyor
- [x] E211. Kullanılmayan import — kullanılmayan import adları siliniyor; ad kalmazsa import "kaynak" (yan etkiler) korunuyor
- [x] E212. Kullanılmayan sınıf üyesi — hiç kullanılmayan özel (#) sınıf metotları ve yan etkisiz başlatıcılı özel alanlar siliniyor
- [x] E213. Boş fonksiyon
- [x] E214. `return/throw` sonrası erişilemeyen kod — return/throw/break/continue sonrası erişilemeyen deyimler siliniyor; fonksiyon bildirimi ve var adları (hoisting) korunuyor
- [x] E215. Yinelenen tanım — aynı kapsamdaki yinelenen fonksiyon bildirimlerinin öncekileri ve yinelenen yan etkisiz nesne anahtarları (sıra korunarak) siliniyor
- [x] E216. Sabit `if` budama
- [x] E217. Boş `catch` — kullanılmayan catch parametresi kaldırılıyor (catch {}), boş try bloğu siliniyor
- [x] E218. No-op ifade
- [x] E219. Fazla argüman — bilinen fonksiyon çağrılarında parametre sayısını aşan yan etkisiz argümanlar siliniyor
- [x] E220. Ölü kod raporu — ölü kod türlerine göre sayılıyor (dead.* sayaçları; rapor: engine.deadCode / Ölü kod türleri tablosu)

## E-H. Kapsam, isimlendirme, okunabilirlik (E221–E240)

- [x] E221. Scope-güvenli rename
- [x] E222. Callback parametresinden anlam çıkarımı — dizi metotları, then/catch, addEventListener, Promise, replace callback parametre adları
- [x] E223. Tip tabanlı isim — çıkarılan tipten ad (el, event, response, list, num...)
- [x] E224. Fiil isimleri — fonksiyon fiilleri: fetch/send/save/load/render/decode/is.../create/compute
- [x] E225. DOM elemanı ismi — getElementById/querySelector/createElement argümanından eleman adı
- [x] E226. Olay ismi — addEventListener ve onX atamalarından onClick gibi işleyici adları
- [x] E227. `with` varken güvenli rename alt kümesi — with yalnızca gövdesini kapsayan kapsamları korur; diğer binding'ler adlandırılır
- [x] E228. `window.x` erişimi olan global'leri koruma — window/self/globalThis/this.x ile erişilen ya da dinamik global erişimli programlarda global'ler korunur
- [x] E229. Export koruması
- [x] E230. `eval` varken güvenli mod — doğrudan eval yalnızca kendi kapsam zincirini, dolaylı eval/Function/string zamanlayıcı yalnızca global'leri korur
- [x] E231. Kullanıcı isim sözlüğü — tüm dosyalara uygulanan kullanıcı sözlüğü (Adlar sekmesi), pipeline naming.names
- [x] E232. Orijinal adı yorumda saklama — Seçenekler: orijinal adı bildirimin yanında /* _0x... */ yorumu olarak saklama
- [x] E233. `let/const`'a çevirme — 97-let-const: TDZ, blok kapsamı, döngü kapanışı ve tekrar bildirimi kanıtlanınca
- [x] E234. Fonksiyon çıkarma — 98-extract: aynı fonksiyonda ≥3 deyimlik tekrar, kapanış güvenli yardımcıya çıkarılır
- [x] E235. Değişken birleştirme — 97-merge-vars: bildirim+ilk atama ve sabit takma ad birleştirme
- [x] E236. Tanımı kullanıma yaklaştırma — 97-move-decls: literal başlangıçlı bildirim aynı bloktaki ilk kullanımın önüne
- [x] E237. Yorum geri yükleme — 99-comments: kaybolan girdi yorumları bağlı bildirim aynı adla duruyorsa geri gelir; dosya başı yorumları başa
- [x] E238. Bölüm başlıkları — 99-annotate: üst düzey deyim kategorisi değiştikçe // ── Bölüm ── başlıkları
- [x] E239. Biçim profilleri — emit.FORMAT_PROFILES (default, compact, wide, standard, airbnb, tabs) arayüzün tek biçim ayarına (ui/settings.js format, useTabs eklendi) yazılır; CLI --format ve pipeline format seçeneği
- [x] E240. Okunabilirlik skoru — 0–100 okunabilirlik skoru, önce/sonra ve fark

## E-J. Arayüz ve etkileşim (E251–E285)

- [x] E251. AST düğüm seçimi ve çift yönlü vurgu — AST ağacında düğüm seçimi editörde vurgular; editör imleci ağaçta düğümü açıp seçer
- [x] E252. Katlanabilir bloklar — Katlanabilir bloklar (oluk + kısayollar, tümünü katla/aç)
- [x] E253. Seçili bölgede pass çalıştırma — Seçili bölgede etkin pass'leri çalıştırma; sonuç seçimin yerine geçer
- [x] E254. Düğüm bağlam menüsü — Editör bağlam menüsü: tanım, referans, yeniden adlandır, düğüm seç, AST/CFG, eşleme, not, yer imi (Shift+F10)
- [x] E255. Pass önizlemesi — Pass önizlemesi: tek pass'in mevcut koddaki farkı, isteğe bağlı uygulama
- [x] E256. Kuru çalıştırma — Kuru çalıştırma: tam boru hattı çalışır, özet ve fark gösterilir, çıktı yalnızca onayla değişir
- [x] E257. Adım adım onaylı ilerleme — Adım adım onay: her kabul edilecek pass değişikliği fark ile sorulur (kabul/ret/hepsi/durdur); pipeline onApprove
- [x] E258. Zaman çizelgesi kaydırıcısı
- [x] E259. Sınırsız geri al / yinele — Sınırsız geri al/yinele: sekme başına sınırsız derinlikte geçmiş (yeniden adlandırma ve çözme çıktısı dahil)
- [x] E260. Oturum kaydı (JSON) — Oturum JSON dışa/içe aktarma (doğrulamalı), ayarlar dahil
- [x] E261. Komut paleti — Komut paleti
- [x] E262. Atanabilir kısayollar — Atanabilir kısayollar: tuşa basarak kayıt, çakışma temizleme, varsayılana dönüş
- [x] E263. Çoklu sekme — Çoklu sekme
- [x] E264. Sekme grupları — Sekme grupları: renkli, daraltılabilir, taşıma/dağıtma/toplu çözme
- [x] E265. 3–4 panelli görünüm — 2/3/4 panelli düzen; araç panelleri bağımsız, ayırıcılar sürükle/klavye
- [x] E266. Mini harita — Mini harita: belge, arama/eşleme/ölü kod/yer imi işaretleri, tıkla-sürükle gezinme
- [x] E267. Yakınlaştırma — Yakınlaştırma: Ctrl+= / Ctrl+- / Ctrl+0, iki parmakla
- [x] E268. Kelime kaydırma — Kelime kaydırma
- [x] E269. Görünmez karakter gösterimi — Görünmez karakter gösterimi (boşluk/sekme)
- [x] E270. Kontrol karakteri vurgusu — Kontrol, sıfır genişlikli ve bidi karakterleri her zaman işaretli
- [x] E271. Eşleşen parantez — Eşleşen parantez vurgusu
- [x] E272. Girinti rehberleri — Girinti rehberleri
- [x] E273. Aktif satır vurgusu — Aktif satır vurgusu (kapatılabilir)
- [x] E274. Odak modu — Odak modu: yalnızca etkin editör, Esc ile çıkış
- [x] E275. Tam ekran — Tam ekran (Fullscreen API)
- [x] E276. Okuma modu — Okuma modu: yalnız çıktı, kaydırmalı ve büyük yazı
- [x] E277. Tema seçimi — Tema seçimi: koyu, aydınlık, yüksek kontrast, sistem
- [x] E278. Renk körlüğü paletleri — Renk körlüğü paletleri: döteranopi, protanopi, tritanopi (Okabe-Ito)
- [x] E279. Ligatür seçimi — Ligatür seçimi: varsayılan kapalı, ayardan açılır
- [x] E280. Onaltılık satır numarası — Onaltılık satır numarası (oluk ve durum çubuğu)
- [x] E281. Durum çubuğu — Durum çubuğunda imleç satır/sütun ve seçim uzunluğu
- [x] E282. Pass listesini sürükle-bırak sıralama — Pass listesi sürükle-bırak (ve ok tuşları) ile sıralanır; pipeline 'order' seçeneği
- [x] E283. Arayüz dili — Arayüz dili: TR, EN, DE, ES, AR (sağdan sola düzen); eksik anahtar İngilizceye düşer
- [x] E284. Ekran okuyucu — Ekran okuyucu: canlı bölge duyuruları, editör/ağaç/liste etiketleri, grafikler için düğüm listesi
- [x] E285. Dokunmatik jestler — Dokunmatik: iki parmakla yakınlaştırma (editör ve grafik), kaydırarak panel değiştirme

## E-K. Görselleştirme (E286–E310)

- [x] E286. AST ağacı — AST ağacı: tembel açılan, klavyeyle gezilen ağaç
- [x] E287. Kontrol akış grafiği — Kontrol akış grafiği: fonksiyon başına temel bloklar, döngü/switch/try/break/continue
- [x] E288. Veri akış grafiği — Veri akış grafiği: başlangıç, atama ve argüman→parametre akışları
- [x] E289. Çağrı grafiği — Çağrı grafiği: fonksiyonlar ve dış API'ler
- [x] E290. Bağımlılık grafiği — Bağımlılık grafiği: import/require/importScripts/Worker/script src, proje içi yol çözümü
- [x] E291. String tablosu görünümü — String tablosu: sayım, entropi, kullanım yerlerine atlama
- [x] E292. Proxy eşleme tablosu — Proxy eşleme tablosu: ikili/çağrı/üye proxy fonksiyonları ve string alanları
- [x] E293. VM geçiş grafiği — VM/durum makinesi geçiş grafiği: durum değişkeni atamaları ve split sıra dizileri
- [x] E294. Opcode frekans grafiği — Opcode frekans grafiği: code[pc++] dağıtıcısının bytecode dizisi, case karşılığı olan/olmayan
- [x] E295. Dönüşüm ısı haritası — Dönüşüm ısı haritası: pass adımı × kod konumu, hücreden zaman çizelgesine
- [x] E296. Karmaşıklık haritası — Karmaşıklık haritası: döngüsel karmaşıklık ağaç haritası
- [x] E297. Renk kodlu kapsam — Renk kodlu kapsam katmanı
- [x] E298. Gölge ilişkisi görünümü — Gölgeleme tablosu ve iç/dış bağlama vurgusu
- [x] E299. Ölü kod katmanı — Ölü kod katmanı: ulaşılamaz deyimler, sabit koşul kolları, kullanılmayan iç fonksiyonlar
- [x] E300. Güven ısı haritası — Güven ısı haritası: çözülmemiş kalıntı yoğunluğuna dayalı satır katmanı (sezgisel olduğu belirtilir)
- [x] E301. Katman görünümü — Katman görünümü: açılan sarmalayıcı/kodlayıcı katmanları, sekmede açma (pipeline onLayer)
- [x] E302. Pass süreleri çubuk grafiği
- [x] E303. Bellek grafiği — Bellek grafiği: çalıştırma boyunca JS heap (Chromium'da performance.memory) ve kod boyutu; API yoksa açıkça belirtilir
- [x] E304. Düğüm sayısı grafiği — Düğüm sayısı grafiği: her anlık görüntünün AST düğüm sayısı
- [x] E305. Karşılaştırmalı grafik — Karşılaştırmalı grafik: belgenin son çalıştırmaları ve diğer sekmeler, ölçüt başına küçük çoklu
- [x] E306. Grafik dışa aktarma — Grafik dışa aktarma: SVG ve PNG; çizelgeler SVG
- [x] E307. Grafik filtreleme — Grafik filtreleme: metin, en az bağlantı, dış API gizleme
- [x] E308. Grafik düzeni seçimi — Yerleşim seçimi: katmanlı, kuvvet, dairesel, ızgara
- [x] E309. Büyük grafik sanallaştırma — Büyük grafik: görünür alan dışı düğüm/kenar çizilmez, uzakta sadeleştirilmiş çizim, liste sınırı
- [x] E310. Grafikte arama — Grafikte arama ve eşleşmeler arasında gezinme

## E-L. Arama ve gezinme (E311–E330)

- [x] E311. Regex metin arama — Regex metin arama (büyük/küçük harf, tam kelime)
- [x] E312. Yapısal AST sorgusu — Yapısal AST sorgusu: tür/takma ad, öznitelik (=, !=, ~= regex, ^=, $=, *=, sayı karşılaştırma), soy ve çocuk birleştirici
- [x] E313. Düğüm yolu seçici — Düğüm yolu: imleçteki yol kırıntısı, yol yazarak düğüm seçme, yol kopyalama
- [x] E314. String tablosunda arama — String tablosunda süzme ve kullanım yerlerini sonuç listesinde açma
- [x] E315. Çözülmemiş kalıntılar — Çözülmemiş kalıntılar merceği: _0x adları, hex decoder çağrıları, eval/Function, fromCharCode konumlarıyla
- [x] E316. Yüksek entropi arama — Yüksek entropi merceği (Shannon)
- [x] E317. Tekrar eden kod — Tekrar eden kod: yapısal özetle kopya fonksiyon/blok grupları
- [x] E318. Benzer fonksiyon — Benzer fonksiyon: düğüm türü çiftleri kosinüs benzerliği (imleçteki ya da tüm çiftler)
- [x] E319. Tanımsız referanslar — Tanımsız referanslar (bilinen global'ler hariç, typeof korumalı işaretli)
- [x] E320. Kullanılmayan tanımlar — Kullanılmayan tanımlar
- [x] E321. Uzun satırlar — Uzun satırlar
- [x] E322. Derin iç içelik — Derin iç içelik
- [x] E323. Sihirli sayılar — Sihirli sayılar
- [x] E324. Sonraki/önceki eşleşme — Sonraki/önceki eşleşme (F3/Shift+F3, sonuç listesinde oklar)
- [x] E325. Sonuç listesi paneli — Sonuç listesi paneli: konum, metin, not; tıkla/Enter ile git
- [x] E326. Arama geçmişi — Arama geçmişi (oturumda saklanır, öneri listesi)
- [x] E327. Kayıtlı aramalar — Kayıtlı aramalar (ad, tür, seçenekler)
- [x] E328. Arama sonucu dışa aktarma — Arama sonucu dışa aktarma: JSON ve CSV (formül enjeksiyonu kaçışlı)
- [x] E329. Sembol listesi — Sembol listesi paneli ve '@' palet araması
- [x] E330. Tanıma git / referansları bul — Tanıma git / referansları bul

## E-U. Semantik modelleme (E501–E540)

- [x] E501. ToPrimitive/ToNumber/ToString modeli — analysis/ops.js: ToPrimitive/ToNumber/ToString/ToNumeric/ToPropertyKey/IsLooselyEqual ve operatörler; sabit yayılımı ve raporda sandbox'sız katlama adayları
- [x] E502. Sıkı/gevşek mod ayrımı — isStrict(): modül, sınıf gövdesi, "use strict"; gevşek/sıkı farkı olan yapılar (with, delete ad, sekizlik, bildirilmemiş atama, this) raporda
- [x] E503. TDZ modelleme — statik TDZ (bildirimden önce okuma, bildirimden önce çağrılan iç fonksiyon) + veri akışında TDZ giriş tanımı
- [x] E504. Getter/setter yan etkisi — nesne/sınıf/defineProperty/__defineGetter__ erişimcileri, yan etki sınıflaması ve yan etkili özellik okumaları
- [x] E505. Proxy tuzağı semantiği — new Proxy tuzak envanteri, geçersiz tuzak adları, proxy'ye bağlı değişkenler yan etkili sayılır; çalışma anı QuickJS'in gerçek Proxy'si
- [x] E506. Symbol anahtarlı özellikler — ownKeysOrder() (indeks → string → symbol sırası), iyi bilinen Symbol kancaları ve anlamları
- [x] E507. Özel alanlar — sınıf başına özel alan/yöntem/erişimci envanteri, #x in o marka denetimleri
- [x] E508. `with` kapsam modeli — resolveInWith(): with gövdesindeki adın özellik/binding/dinamik çözümü (literal nesne, Object.prototype, unscopables)
- [x] E509. `eval` kapsam modeli — doğrudan/dolaylı eval, new Function, string zamanlayıcılar; sıkı/gevşek var sızıntısı; veri akışı direct eval'li birimi izlemez
- [x] E510. Realm ayrımı — iframe contentWindow/opener/Worker/ShadowRealm kaynakları, başka realm'den temiz yerleşik alma, realm'e duyarlı instanceof/constructor denetimleri
- [x] E511. Modül ad alanı nesnesi — namespaceKeys() kod birimi sıralaması, ad alanına yazma/silme (TypeError), dinamik import, modülün kendi ad alanı şekli
- [x] E512. Top-level await — üst seviye await/for await tespiti; wrapTopLevelAwait() ile sandbox gözlem çalıştırmasında async sarmalayıcı
- [x] E513. Iterator protokolü — for-of/yayma/destructuring/yield*/Array.from/Map-Set girdileri: yerleşik mi kullanıcı yineleyicisi mi, erken çıkışta return()
- [x] E514. Async iterator — for await (senkron yineleyici üzerinde await), Symbol.asyncIterator tanımları, async üreteçler
- [x] E515. Thenable çözümü — then tanımlayan nesneler ve await/Promise.resolve/resolve ile benimsenmeleri; sandbox'ta gerçek thenable benimseme kaydı
- [x] E516. Mikrogörev sırası — sandbox olay döngüsü modeli: makro görev kuyruğu, her görev öncesi mikro kuyruk boşaltma, queueMicrotask; çalışma sırası raporda
- [x] E517. Yakalanmamış ret — söz izleme: new Promise, statikler, then türevleri, async fonksiyon/ok dönüşleri ve async sınıf/nesne/özel yöntemler (gövde ok fonksiyona taşınıp sözü doğrudan izlenir); mikro görev noktası sonrası ret denetimi ve sonradan işlenen ret
- [x] E518. Yığın izi yakalama — statik .stack okuma/inceleme tespiti; analiz çalıştırmasında kurucuyla yaratılan hatalar ve motorun fırlattığı hatalar programa ulaştığı yerde (try/catch enstrümantasyonu, ret işleyicileri) V8 biçiminde (başlık + stackTraceLimit), okumaları kaydedilir
- [x] E519. `Error.captureStackTrace` — sandbox'ta Error.captureStackTrace (kurucu çerçevesini atlar, stackTraceLimit=10) ve statik tespit
- [x] E520. `arguments.callee` — arguments.callee/caller sıkı modda TypeError, gevşekte fonksiyon; veri akışı arguments takma adında parametreleri izlemez
- [x] E521. `function.length/caller` — functionLength() modeli, katlanabilir .length okumaları, defineProperty ile sahte length, sıkı fonksiyonda .caller/.arguments TypeError
- [x] E522. `new.target` — new.target kullanan fonksiyonlar ve new ile/olmadan çağrı sayıları
- [x] E523. Sınıf alan başlatma sırası — classInitOrder(): tanım anı ve örnek başlatma sırası, sonraki alanı okuyan başlatıcı uyarısı
- [x] E524. Statik bloklar — statik bloklar tanım anı sırasında statik alanlarla kaynak sırasıyla; sayım raporda
- [x] E525. Dekoratörler — parser'a decorators eklentisi; decoratorOrder(): değerlendirme (yukarıdan aşağı) ve uygulama (içten dışa, öğeler sonra sınıf) sırası
- [x] E526. RegExp motoru farkları — regexFeatures() + compareRegexEngines(): desenler host motorunda ve QuickJS'te derlenip programın string'leri üzerinde karşılaştırılır
- [x] E527. Unicode özellik kaçışları — \p{…} kaçışları, u/v bayraksız literal anlamı ve host motorunda özellik adı geçerliliği
- [x] E528. `lastIndex` durumu — g/y bayraklı değişkenlerin çoklu/döngüde test/exec kullanımı, lastIndex okuma/yazma
- [x] E529. Saat dilimi — sandbox Date: sabit dakika ya da IANA saat dilimi (yaz saati dahil, host Intl verisi), varsayılan UTC; yerel getter/setter, kurucu, Date.parse, toString dilim adı; statik tespit
- [x] E530. `toLocaleString` — Date/Number/BigInt/Array toLocale* ve String#localeCompare ECMA-402 varsayılanlarıyla host Intl köprüsü üzerinden: dateStyle/timeStyle, tüm alan seçenekleri, era, dayPeriod, hourCycle, timeZoneName türleri, IANA timeZone; 8 yerel ayarda V8 çıktısıyla birebir test edildi
- [x] E531. `Intl.NumberFormat` — Intl.NumberFormat (unit, scientific, engineering, compact, currency, yuvarlama seçenekleri, BigInt) ve PluralRules/Collator/RelativeTimeFormat/ListFormat host Intl köprüsüyle; 8 yerel ayarda V8 çıktısıyla birebir test edildi
- [x] E532. Tohumlu `crypto.getRandomValues`
- [x] E533. Tohumlu `Math.random`
- [x] E534. `performance.now` — performance.now monoton ve deterministik (çağrı başına perfStep ms, varsayılan 1)
- [x] E535. `-0` ve `NaN` ayrımı
- [x] E536. BigInt semantiği — BigInt aritmetiği, karışık tür TypeError, 0n bölme/negatif üs RangeError, >>> TypeError, karşılaştırma ve ToString
- [x] E537. TypedArray takma adı — aynı ArrayBuffer üzerindeki TypedArray/DataView/subarray görünümleri ve yazmalar (takma ad grupları)
- [x] E538. Ayrılmış ArrayBuffer — çalışma anı ayırma modeli: transfer/transferToFixedLength, structuredClone transfer, window/MessagePort/Worker postMessage; ayrılmış tampon byteLength 0, detached, görünüm uzunluğu 0, indeks undefined, yöntemler/DataView/kurucular TypeError (TypedArray örnekleri Proxy ile sarılır); statik ayırma sonrası kullanım tespiti
- [x] E539. SharedArrayBuffer / Atomics — SharedArrayBuffer/Atomics tespiti; sandbox'ta tek ajan ana iş parçacığı Atomics modeli (wait TypeError, waitAsync/notify)
- [x] E540. WeakRef / FinalizationRegistry — WeakRef/FinalizationRegistry tespiti; sandbox'ta hiç toplanmayan (spec'e uygun) deterministik model

## E-V. Analiz altyapısı (E541–E580)

- [x] E541. Pass bağımlılık DAG'ı — PASS_DEPS + passDag(): kayıt sırasının topolojik doğrulaması (test), raporda sıra/ihlaller
- [x] E542. Pass çakışma tespiti — passConflicts(): karşılıklı geri alma, turlar arası salınım, bir pass sonrası tekrarlayan başarısızlıklar
- [x] E543. Pass etkileşim matrisi — interactionMatrix(): etkinleştirme/bozma sayıları, raporda tablo
- [x] E544. Maliyet modeliyle sıralama — costOrder(): ortalama süre ve faydaya göre bağımlılıklara uyan sıra; pipeline passOrder seçeneği doğrulayarak uygular
- [x] E545. Hash ile fixpoint/döngü kırıcı
- [x] E546. İşlem geri alma — salvage(): davranış doğrulaması başarısız pass'in yama işlemleri tek tek denenip korunanlar tutulur (pipeline'da, davranış temeli varken)
- [x] E547. Kontrol noktası — trace.checkpoint() her tur (kod + sürümlü AST + özet), restoreCheckpoint() doğrulama, deobfuscate({ resume })
- [x] E548. Yapısal paylaşım — SnapshotStore: hash-consing ile alt ağaç paylaşımı, eşitlik doğrulamalı; raporda paylaşım oranı
- [x] E549. Artımlı yeniden analiz — AnalysisSession: birim özetleri hash'e göre önbellekte; her pass sonrası yalnızca kirli birimler yeniden analiz edilir
- [x] E550. Kirli küme takibi — dirtyUnits(): değişen/eklenen/silinen/temiz birimler, pass başına raporda
- [x] E551. Alt ağaç hash önbelleği — structuralHash(): WeakMap önbellekli 64 bit yapısal hash, invalidate/forget
- [x] E552. Talep odaklı analiz — session.reaching/constant yalnızca istenen birimi analiz eder; raporda tehlikeli çağrılara giden değerler
- [x] E553. Analiz geçersizleştirme — artık bulunmayan hash'lerin özetleri düşer; birim dışı bağlam (prototype yaması, eval/arguments gölgelemesi) anahtarda
- [x] E554. Worklist algoritmaları — dataflow.solve(): ileri/geri, istisna kenarlı genel worklist çözücü (min-heap)
- [x] E555. Deterministik sıra — worklist önceliği (ters) son sıra; aynı girdi aynı analiz raporunu üretir (test)
- [x] E556. Kararlı düğüm kimlikleri — stableIds(): birim yolu + tür + yapısal hash + sıra; yeniden parse ve başka birimdeki değişiklikte değişmez
- [x] E557. Düğüm kökeni meta verisi — trace: düğüm eşlemeyle taşınan girdi konumları; raporda çıktı fonksiyonlarının girdi satırları
- [x] E558. Dönüşüm gerekçesi — pass başına gerekçe kaydı: log satırları + yama özeti (işlem/kaldırılan/eklenen)
- [x] E559. Geri alınabilir dönüşüm günlüğü — pass başına AST yaması günlüğü, invertPatch, undoTo(k), son yamanın tersi raporda doğrulanır
- [x] E560. Diff'lenebilir anlık görüntüler (zaman çizelgesi)
- [x] E561. Sürümlü AST serileştirme — serializeAst/deserializeAst: peel-ast biçimi, sürüm denetimi, yükseltme tablosu, düğüm türü doğrulaması
- [x] E562. AST diff/patch biçimi — diffAst/applyPatch: splice/replace işlemleri, çakışma denetimi, alt küme uygulanabilir
- [x] E563. Çalıştırmalar arası düğüm eşleme — matchTrees(): tekil hash, ada göre bildirim, aşağıdan yukarı oy ve konumsal eşleme
- [x] E564. Yorumdan ayrı not kanalı — trace.note() kanalı; pass'lerin değiştirdiği deyimlere otomatik notlar, eşlemeyle taşınır, raporda
- [x] E565. Yorum koruma stratejisi — kaybolan yorumlar eşlenen düğüme ya da eşlenmiş deyim atasına geri takılır (arayüz ve CLI'da açık)
- [x] E566. Direktif koruma
- [x] E567. ASI'ye duyarlı üretim
- [x] E568. Parantez minimizasyonu
- [x] E569. Öncelik farkındalıklı yazdırma
- [x] E570. Minifier güvenli çıktı — minifierSafety(): kaynak/ad/parametre sayısı okuma, dinamik kapsam, özellik karışımı; güvenli terser seçenekleri raporda
- [x] E571. Gölgeleme analizi — shadowReport()/shadowChain()/shadowsBuiltin(): tüm kapsamlarda yerel ve yerleşik ad gölgelemesi
- [x] E572. Kapsam sınırı haritası
- [x] E573. Binding grafiği
- [x] E574. Referans sayımı
- [x] E575. Def-use zincirleri — analyzeFunction(): kullanım → tanımlar ve tanım → kullanımlar zincirleri
- [x] E576. Ulaşan tanımlar — istisna kenarlı CFG üzerinde ulaşan tanımlar (koşullu tanım öldürmez)
- [x] E577. Canlılık analizi — geri yönlü canlılık; istisna işleyicisine canlı değişkenler korunur
- [x] E578. Ölü atama tespiti — ölü atamalar (yakalanmayan, with/eval dışı değişkenlerde) raporda
- [x] E579. Kopya yayılımı — mevcut kopyalar (must) analizi + applyCopyPropagation() (gölgeleme denetimli)
- [x] E580. Sabit yayılımı — CFG üzerinde sabit yayılımı: soyut işlem modeli, TDZ birleşimi, bileşik/mantıksal atama ve artırma

## E-W. Sembolik ve concolic yürütme (E581–E610)

- [x] E581. Sembolik değerler — Sembolik IR (src/symbolic/ir.js): sabit/değişken/işlem terimleri, kesin JS anlamlı değerlendirme ve sadeleştirme
- [x] E582. Kısıt deposu — Kısıt deposu (store.js): push/pop çerçeveleri, fazlalık/çelişki tespiti, önbellekli ve bağımsızlık bölmeli tatmin sorgusu
- [x] E583. Yol çatallama — Sembolik yürütücüde dal başına durum çatallama (exec.js branch)
- [x] E584. Yol birleştirme — Birleşme noktalarında yol birleştirme: değişkenler/yığın ite ile, ifade düzeyinde de
- [x] E585. Durum patlaması kontrolü — Durum sayısı sınırı, birleştirme ve tekrar eden koşul ayıklamayla patlama kontrolü
- [x] E586. Concolic mod — Concolic: QuickJS'te somut koşu + kayıtlı dallarla host'ta sembolik yeniden oynatma (concolic.js)
- [x] E587. Kapsam geri beslemesi — Dal kapsamı izlenir, kapsanmamış hedefli girdiler önce denenir
- [x] E588. Girdi sentezi — Dal koşulu olumsuzlanıp çözülerek ortam okumaları ve argümanlar için girdi sentezi
- [x] E589. Bit-vektör/dizi/string yol koşulu çözücüsü — Bit-blast + CDCL çözücü: tamsayı/bit işlemleri, sınırlı stringler, dizi seçimi (ite), tip bölme
- [x] E590. String kısıt çözücü — Sınırlı string kodlaması: eşitlik, birleştirme, length, charCodeAt, slice, indexOf/startsWith/endsWith/includes, sözlük sırası, regex üyeliği
- [x] E591. Regex sentezi — Örneklerden regex sentezi (regex.js) ve concolic raporunda dal başına girdi deseni; NFA ile regex üyelik kısıtı
- [x] E592. Opaque predicate SMT çözümü — opaque-smt pass'i: SSA tip/aralık bilgisiyle dal koşulları çözücüyle kanıtlanıp sabitlenir
- [x] E593. Dallanma korelasyonu — cfg-opt'ta baskın dal olgularıyla korelasyon kanıtı ve katlama; concolic'te koşular arası korelasyon çözücü kanıtı
- [x] E594. Kanıt üretimi — UNSAT kanıtları: DRUP lemmaları bağımsız RUP denetleyicisiyle doğrulanır; tüketici sayım/aralık kanıtları; rapora ve günlüğe yazılır
- [x] E595. Tanık küçültme — Yeni kapsam getiren girdiler çözücüyle ikili aramada küçültülür, somut koşuyla doğrulanır
- [x] E596. Sembolik dizi modeli — Dizi modeli: sembolik indeksli okuma/yazma, push/pop/shift/indexOf/includes/join/slice
- [x] E597. Sembolik nesne modeli — Nesne modeli: özellik haritası, sembolik anahtar seçimi, prototip üyeleri modellenmez (bilinmeyen)
- [x] E598. Sembolik string modeli — String modeli: length, charAt/charCodeAt/at, slice/substring, indexOf vb., büyük/küçük harf, şablon
- [x] E599. Sembolik tip modeli — Tip kümeleri (types), typeof katlama, 'any' değişkenlerde çözücüde tip bölme
- [x] E600. Yol budama — Çatallamada her iki yönün tatmin edilebilirliği denetlenir, imkânsız yollar budanır
- [x] E601. Sabit yayılımıyla budama — Sabit/aralık analizi ve yol koşulundaki olgularla çözücüsüz dal kararı
- [x] E602. Kısmi değerlendirme — Genel çevrimiçi kısmi değerlendirici (opt/pe.js): statik dallar, statik denetimli döngülerin açılması, önek açma
- [x] E603. Fonksiyon özelleştirme — specialize pass'i: sabit argümanlı çağrı grupları için kısmi değerlendirilmiş kopya fonksiyon
- [x] E604. Döngü kısmi açma — Yürütücüde döngüler sınırlı turda açılıp kalan durum havoc'lanır; kısmi değerlendiricide önek açma
- [x] E605. Durum birleştirme — Döngü turlarında ve deyim listelerinde aynı konumdaki durumlar birleştirilir
- [x] E606. Özet yorumlama — Fonksiyon özetleri: parametreler sembolik, yol başına (koşul, dönüş); yan etkili/yaklaşık özetler geçersiz
- [x] E607. Özet tablosu — Özet tablosu: kaynak özetine göre önbellek, isabet/ıska sayaçları
- [x] E608. Özet yeniden kullanımı — Çağrı yerinde özet örneklenir (argüman yerleştirme + ite zinciri) satır içi yürütme yerine
- [x] E609. Sembolik yürütme bütçesi — Adım/süre/durum/çözücü çağrısı bütçeleri; tükenme nedeni istatistikte
- [x] E610. Sembolik iz — Yol başına iz (dal, çağrı, özet, havoc, fırlatma); raporda örnek iz

## E-Kripto. Kripto ve istatistik (E611–E630)

- [x] E611. Şifre tanıma (S-box, round sabiti) — AES S-box/ters S-box/Rcon/T-tablosu, DES S-kutusu/IP, Blowfish pi, TEA delta, ChaCha/Salsa, RC4 KSA kalıbı
- [x] E612. Hash tanıma (MD5/SHA sabitleri) — MD5, MD5/SHA-1 IV, SHA-1/224/256/512, RIPEMD-160, Murmur3, xxHash32, FNV-1a, CRC32 sabitleri
- [x] E613. Anahtar çıkarma — CryptoJS/Node/forge/WebCrypto/XXTEA/JSEncrypt çağrılarından ve isimli değişkenlerden anahtar; sandbox importKey kayıtları
- [x] E614. IV/salt tespiti — IV, Salted__ tuzu, PBKDF2/EvpKDF tuz ve iterasyon tespiti
- [x] E615. Mod tespiti — Çağrı/algoritma adından mod (CBC/ECB/CTR/CFB/OFB/GCM) ve tekrar eden bloklardan ECB
- [x] E616. Dolgu tespiti — PKCS7/ANSI X9.23/ISO 7816/sıfır dolgu tespiti (yapılandırma ve çözülmüş metinden)
- [x] E617. Entropi analizi — Shannon entropisi, kayan pencere entropisi, blob raporu
- [x] E618. Shannon entropisi eşiği — Alfabeye göre normalize entropi eşikleri: text/hex/base64/encoded/random kararı
- [x] E619. Sıkıştırma oranı analizi — CompressionStream deflate oranı, yoksa LZ77 tahmini
- [x] E620. Base64 tespiti — Base64/base64url/hex/base32/base85 alfabe ailesi ve entropi ile blob tespiti
- [x] E621. Çoklu kodlama katmanı tespiti — Yapısal çözücülerle katmanlı kodlama zinciri ve katman sayısı
- [x] E622. Doğal dil tespiti — Yazı sistemi + durak kelimesi/özel harf ile dil (en/tr/de/fr/es/it/pt/nl) ve doğal metin kararı
- [x] E623. Karakter dağılımı — Karakter sınıfları, alfabe boyutu, en sık karakterler
- [x] E624. Tekrar eden blok (ECB) — 8/16 baytlık tekrar eden blok sayımı (ECB)
- [x] E625. Rastgelelik testleri — NIST frekans (monobit) ve koşu testleri, bayt ki-kare, seri korelasyon
- [x] E626. Korelasyonla XOR anahtarı — Normalize Hamming ile anahtar uzunluğu + sütun başına İngilizce frekans korelasyonu
- [x] E627. Kasiski — Tekrar eden trigram uzaklıkları, EBOB ve çarpan oylaması
- [x] E628. Index of coincidence — Harf ve bayt tesadüf indeksi
- [x] E629. Bilinen düz metin saldırısı — Crib'lerle (function, https://, var …) tekrarlı XOR anahtar akışı kurtarma
- [x] E630. Küçük anahtar uzayında kaba kuvvet — Tek bayt XOR/toplama/artan XOR, bit döndürme, 16 bit XOR (65536), afin şifre kaba kuvveti

## E-VM. VM ve decompilation (E631–E660)

- [x] E631. Decoder şekli tanıma
- [x] E632. Rotasyon cebiri — Rotasyon checksum'ı decoder (indeks/base64/rc4) taklidiyle statik çözülür; sandbox'la çapraz denetim, sandbox'sız çözüm pass'i
- [x] E633. Decoder tersini sentezleme — Tanınan decoder için kodlayıcı kaynağı üretilir, tüm değerlerde gidiş-dönüşle doğrulanır
- [x] E634. String tablosu tekilleştirme — Değere göre tekilleştirilmiş string tablosu
- [x] E635. Kullanımlardan tablo yeniden kurma — Çağrı yerlerindeki argümanlardan tablo yeniden kurulur
- [x] E636. Kısmi tablo kurtarma — Anahtarsız çözülebilen indeksler kurtarılır, çözülemeyenler listelenir
- [x] E637. Proxy tablosunu deneyerek tamamlama — Statik çözülemeyen proxy anahtarları program çalıştırılarak gözlenir ve tablo tamamlanır
- [x] E638. Opcode alfabesi çıkarımı — Opcode alfabesi
- [x] E639. Komut kümesi çıkarımı — Komut kümesi: opcode, ham değer, mnemonic, işlenen sayısı
- [x] E640. Handler kümeleme — Aynı sembolik etkili ya da aynı biçimli handler kümeleri
- [x] E641. VM bellek düzeni — Bellek düzeni: bytecode, pc, opcode, yığın, register, sabit havuzu
- [x] E642. Register sayısı — Register sayısı ve kullanılan indeksler
- [x] E643. Yığın derinliği — Durum başına ve en büyük yığın derinliği
- [x] E644. Dispatch stili sınıflandırma — switch / if zinciri / handler tablosu dağıtımı sınıflandırılır
- [x] E645. Döngü yapısı kurtarma — Bytecode geri kenarları ve yapısal while/do-while kurtarma
- [x] E646. Çıkış koşulu — Döngü koşulu, halt ve return/throw çıkışları
- [x] E647. Bytecode bölütleme — Temel bloklar ve komut olarak erişilmeyen bytecode aralıkları
- [x] E648. Sabit havuzu — Sabit havuzu çıkarımı ve disassembly açıklaması
- [x] E649. Bytecode → IR — Komut başına yığın yuvalı ara gösterim
- [x] E650. IR → yapısal kod — pc makinesi + unflatten ile yapısal kod
- [x] E651. Handler semantiği sentezi — Handler'ın genel (yer tutuculu) ya da somut sembolik etkisi
- [x] E652. Okunur yorumlayıcı üretimi — Rolleri yeniden adlandırılmış, açıklamalı yorumlayıcı (rapor/CLI); çevrilemezse yerinde açıklama
- [x] E653. Hibrit VM + host kod — VM'nin çağırdığı host/native fonksiyonlar ayrıştırılır; çevrilmiş kodda doğrudan, this korunarak çağrılır
- [x] E654. İç içe VM tespiti — Handler içindeki ve çevrilmiş kodda ortaya çıkan iç VM'ler, derinlikle
- [x] E655. VM içinde VM açma — İç VM bir sonraki turda çevrilir (fixture: VM içinde VM)
- [x] E656. VM sürüm ayrımı — Motor/tablo imzasıyla sürüm ayrımı: eklenen/çıkan handler, karışık opcode eşlemesi
- [x] E657. jsvmp şablon seti — jsvmp tarzı yığın işlemlerini kapsayan şablon seti (TEMPLATES)
- [x] E658. Bytecode assembler — Bytecode assembler (arayüz ve CLI), kodlanmış opcode'larla
- [x] E659. Decompiler çıktı doğrulama — VM'e özgü fark doğrulaması (çağrı dönüşleri + çıktı)
- [x] E660. Decompilation raporu — Disassembly, IR, çevrilmiş kod, doğrulama ve kapsam içeren decompilation raporu

## E-X. Derleyici optimizasyonları (E661–E700)

- [x] E661. Koşula sabit yayılımı — ssa-opt: SCCP sabitleri koşullara yayılır, tek yönlü dallar kaldırılır
- [x] E662. Kopya yayılımı — ssa-opt: SSA sürüm eşitliği denetimli kopya yayılımı
- [x] E663. Ölü atama eleme — ssa-opt: canlılık sabit noktasıyla ölü atama eleme (tip denetimli yan etkisizlik)
- [x] E664. Fazla yükleme eleme — ssa-opt: kaçmayan nesnelerin skaler değiştirilmesi; özellik okumaları SSA ile katlanır
- [x] E665. Global değer numaralandırma — ssa-opt: baskınlık ağacında değer numaralı GVN (kopyalar ve sabitler birleşik, değişmeli işlemler)
- [x] E666. Ortak alt ifade eleme — ssa-opt: blok içi tekrarlanan saf ifadeler geçici değişkene alınır
- [x] E667. Kısmi fazlalık eleme — ssa-opt: if/else birleşmelerinde kısmi fazlalık eleme (kenarlara hesap ekleme)
- [x] E668. Döngü değişmezi taşıma — loop-opt: saf, tipli, döngü değişmezi ifadeler döngü öncesine taşınır
- [x] E669. Güç indirgeme — loop-opt: i*k aralık kanıtlı artımlı geçiciye indirgenir
- [x] E670. İndüksiyon değişkeni sadeleştirme — loop-opt: türetilmiş IV temel IV cinsinden yazılır, artışı kaldırılır
- [x] E671. Döngü açma — loop-opt: sabit tur sayılı küçük döngüler tamamen açılır
- [x] E672. Döngü soyma — loop-opt: ilk turu farklı bayrak taşıyan döngüde ilk tur soyulur
- [x] E673. Döngü bölme/birleştirme — loop-opt: bağımsız eş başlıklı döngüler birleştirilir; açılabilir ayrık grup bölünür
- [x] E674. Dal katlama (sabit koşul)
- [x] E675. Switch normalizasyonu — cfg-opt: gereksiz break/default silme, aynı gövdeli case birleştirme, tek case → if/else
- [x] E676. Kuyruk çoğaltma — cfg-opt: küçük if/return kuyruğu, sabitleşen dallara çoğaltılır
- [x] E677. Atlama ipekleme — cfg-opt: çoğaltılan koşul dal sonundaki sabitle katlanıp doğrudan hedefe bağlanır
- [x] E678. If-dönüşümü — cfg-opt: tek atamalı/dönüşlü if-else koşul ifadesine çevrilir
- [x] E679. Yüklemleme — cfg-opt: boolean dallar ve c ? true : false koşul yüklemine çevrilir
- [x] E680. Seyrek koşullu sabit yayılımı — opt/lattice.js SCCP: çalıştırılabilir kenarlar ve sabit kafesi
- [x] E681. SSA kurulumu — opt/ssa.js: CFG, baskınlık (Cooper-Harvey-Kennedy), yeniden adlandırma
- [x] E682. Phi yerleştirme — Yinelenen baskınlık sınırına φ yerleştirme
- [x] E683. SSA bozma — SSA bozma: φ-ağı birleştirme, canlılıkla girişim denetimi, kenarlara kopya ekleme; ssa-opt girişimsizlik denetimiyle kullanır
- [x] E684. Fazla phi eleme — Tek değere inen ve öz-kopyalı φ'ler elenir, kullanımlar güncellenir
- [x] E685. Andersen alias analizi — Andersen kapsama analizi (alan duyarlı, anında çağrı grafiği), raporda nokta kümeleri
- [x] E686. Nokta-analizi — Steensgaard birleştirme analizi ve takma ad sorguları, raporda
- [x] E687. Kaçış analizi — Tahsis yerleri için global/dış dünya/alan kapanışıyla kaçış analizi
- [x] E688. Saflık/etki çıkarımı — Fonksiyon başına etki çıkarımı (global/yığın yazma, bilinmeyen çağrı, belirsizlik, fırlatma) çağrı grafiğinde sabit nokta
- [x] E689. Taint takibi — Kaynak→havuz taint akışları, bağlamlar arası parametre yayılımı
- [x] E690. Aralık analizi — SSA üzerinde genişletmeli aralık analizi, dal olgularıyla daraltma
- [x] E691. Yapısal tip çıkarımı — Tip kümesi kafesi (BigInt/nesne/valueOf etkileri dahil)
- [x] E692. Nesne şekli çıkarımı — Tahsis başına özellik şekli (sonradan eklenenler işaretli)
- [x] E693. String uzunluk analizi — String uzunluk aralığı analizi
- [x] E694. Nullability analizi — Null/undefined olabilirlik, dal olgularıyla daraltma
- [x] E695. Erişilemezlik kanıtı — SCCP ile çalıştırılamayan kenarlar kanıt metniyle raporlanır ve ssa-opt'ta silinir
- [x] E696. İddia sentezi — Değişmez ve son koşullardan iddia sentezi, farklı yapılandırmayla sandbox'ta doğrulama
- [x] E697. Ön koşul çıkarımı — Fırlatan yolların koşullarından ön koşul çıkarımı (sembolik yürütme)
- [x] E698. Son koşul çıkarımı — Dönüş yollarından son koşul (yol koşulu ⇒ dönüş), tam özetlerde iddiayla doğrulama
- [x] E699. Spesifikasyon madenciliği — Çağrı dizisinden yanıt/öncelik kuralları madenciliği
- [x] E700. Değişmez tespiti — Daikon tarzı giriş/çıkış değişmezleri (tip, aralık, mod, önek, ilişkisel, doğrusal dönüş)

## E-Y. Doğrulama (E701–E725)

- [x] E701. SMT ile semantik denklik kanıtı — Yerleşik CDCL + bit-blasting SMT ile int32 fonksiyon denkliği kanıtı; fonksiyon denkliği denetiminde kullanılır
- [x] E702. Sınırlı model kontrolü — boundedCheck: döngüleri k kez açarak özellik denetimi, sınır aşımı raporlanır
- [x] E703. Ayrışan girdi için yol koşulu çözümü — divergingInput: iki fonksiyonun ayrıştığı girdi ve iki yolun koşulu
- [x] E704. Tanık üretimi — Karşı örnek tanığı terim değerlendirmesiyle doğrulanır; somut çalıştırmayla teyit edilir
- [x] E705. Karşı örnek küçültme — Çözücü modelinde bit bit küçültme + test tabanlı argüman küçültme + fuzz ortamı küçültme
- [x] E706. Her dönüşüm sonrası çeviri doğrulaması — Her pass sonrası parse + console + gözlenebilir etkiler temel çalıştırmayla karşılaştırılır
- [x] E707. Bisimülasyon — Zayıf bisimülasyon: olay türleri etiketli adım, zamanlayıcılar τ; adım adım etki karşılaştırması
- [x] E708. İz denkliği — Gözlenebilir etki dizilerinin birebir denkliği ve ilk ayrışma noktası
- [x] E709. Determinizm kontrolü — Aynı yapılandırmayla k çalıştırma + zaman/tohum duyarlılığı
- [x] E710. Idempotans kanıtı — Çıktı yeniden çözülür, SHA-256 eşitliği ve değişen satırlar/pass'ler
- [x] E711. Davranış parmak izi (etki vektörü) — Etki vektörü: tür sayımları, hedef kümesi, iz özeti
- [x] E712. Semantik hash — Biçimden bağımsız, gözlenen davranıştan semantik hash
- [x] E713. Denklik sınıfı kümeleme — Semantik hash sınıfları + Jaccard benzerliğiyle birleştirme
- [x] E714. Hash tabanlı regresyon seçimi — selectRegression + scripts/regress-select.js: değişen pass kaynağına dokunan fixture'lar ve sınıf temsilcileri
- [x] E715. Etki farkı — Girdi/çıktı aynı ortamda çalıştırılıp etki farkı; doğrulama raporunda
- [x] E716. Semantik yama sentezi — Önce/sonra çiftlerinden anti-unification ile kural sentezi, SMT/sandbox testiyle doğrulama, koda uygulama; Rapor > Araçlar > Kural sentezi
- [x] E717. Kanıt taşıyan çıktı — Kod + SHA-256 + dönüşüm/doğrulama iddiaları ECDSA P-256 ile imzalı paket; checkBundle imza/özet/davranışı yeniden doğrular
- [x] E718. Dönüşüm gerekçesi kaydı — Kabul edilen her değişiklik için özetler, boyut farkı, doğrulama düzeyi, gözlem değerleri; raporda gerekçe tablosu
- [x] E719. Doğrulama bütçesi — Süre/çalıştırma/çözücü bütçesi; aşılınca denetimler 'bütçe' ile atlanır
- [x] E720. Doğrulama seviyeleri — none/parse/behaviour/effects/functions/proof seviyeleri; ayarlardan seçilir, pass doğrulaması ve son doğrulama buna göre
- [x] E721. Başarısız kanıt raporu — Başarısız denetim, karşı örnek, kanıt, şüpheli pass'ler ve yeniden üretim adımları (nesne + Markdown)
- [x] E722. Geri alma politikası — doğrulanamayan değişiklik kabul edilmez
- [x] E723. Kademeli sıkılaştırma — Risk sinyali başına bir seviye yükseltme; etki ayrışması görülünce plan yeniden kurulur
- [x] E724. Z3 wasm entegrasyonu — z3-solver@5.4.1: Node/CLI'da doğrudan; tarayıcıda sayfa cross-origin isolated ise (vite COOP/COEP başlıkları, public/_headers) tembel yüklenen worker'da, değilse yerleşik CDCL çözücü; tarayıcıda doğrulandı
- [x] E725. Çözücü zaman aşımı yönetimi — Çatışma/süre bütçesi, Z3 zaman aşımı parametresi, 'unknown' sonucu ve boşta Z3 thread kapatma

## E-Z. Yürütme motoru (E726–E750)

- [x] E726. Heap anlık görüntüsü / geri yükleme — Yığın grafiği anlık görüntüsü ve yeniden oynatmayla doğrulanan geri yükleme
- [x] E727. Deterministik yeniden oynatma — Deterministik sandbox üzerinde kayıt/yeniden oynatma, adım başına özet karşılaştırması
- [x] E728. Zaman yolculuğu hata ayıklama — Kaydırıcıyla adımlar arası gezinme, adım etkileri ve yığın farkı; travel() ile k. adım durumu
- [x] E729. Etki günlüğü — Tüm stub'larda sıralı etki günlüğü (ağ, depolama, çerez, DOM, diyalog, geçmiş, worker, WASM, kripto, parmak izi…)
- [x] E730. `onRead/onWrite/onCall` kanca API'si — __peel.onRead/onWrite/onCall sandbox API'si + ayarlardaki izlenen yollar
- [x] E731. Builtin'lerde proxy tuzağı — document/navigator/screen/location proxy'lerinde okuma sayımı, yazma etkisi ve taint etiketi
- [x] E732. Gölge bellek — Gölge bellek: nesneler için WeakMap, string'ler için değer tablosu; taint kaynak etiketleri
- [x] E733. Sembolik değer enjeksiyonu — Sembolik/somut parametre ve global enjeksiyonu (execute seçenekleri)
- [x] E734. Kısıt deposu entegrasyonu — Artımlı, önbellekli kısıt deposu; olanaksız yollar budanır
- [x] E735. Yol çatallama motoru — if/döngü/ternary/mantıksal işleçlerde yol çatallama
- [x] E736. Yol birleştirme motoru — Birleşme noktalarında ite ile yol birleştirme
- [x] E737. Durum patlaması sınırlayıcı — Yol/derinlik/terim sınırları; kesilen yollar 'limit' olarak raporlanır
- [x] E738. Kapsam geri besleme döngüsü — Enstrümante coverage ile yeni deyim açan ortamlar korpusa girer ve mutasyonla çoğaltılır
- [x] E739. Girdi sentezleyici — Her uygulanabilir yol için çözücüyle argüman üretimi; fonksiyon denkliğinde kullanılır
- [x] E740. Gramer tabanlı fuzz — Tohumlu gramer üreteci: sayı, string, JSON, URL, çerez, depolama, yanıt gövdesi, ortam
- [x] E741. AST mutasyon motoru — Operatör/literal/koşul/deyim/dönüş mutasyonları; mutant öldürme oranıyla doğrulama gücü
- [x] E742. Çökme triyajı — Normalize imzayla çökme gruplama ve en küçük yeniden üretici ortam
- [x] E743. Etki farkı motoru — LCS hizalamalı etki farkı motoru, add/del/change birleştirme
- [x] E744. Yeniden oynatma kayıt biçimi — peel-replay v1 biçimi, yapısal doğrulama ve kod özeti denetimi
- [x] E745. Motor durumu serileştirme — Oturum JSON'a serileştirilir; geri yüklemede yığın özeti doğrulanır
- [x] E746. Çalıştırma başına izolasyon (her probe taze QuickJS runtime)
- [x] E747. Kaynak muhasebesi (bellek, süre, yığın)
- [x] E748. Kesme ve Durdur
- [x] E749. Motor telemetrisi — İstek türü başına sayı/süre/başarısızlık, bellek tepe değeri, kesme ve sızan runtime sayısı; raporda tablo
- [x] E750. Motor eklenti kancası — Serileştirilebilir eklentiler (prelude + collect) mesajla ya da createHost seçeneğiyle


## OBF. Obfuscator araştırması · Obfuscator research

Kaynak: `docs/research/obfuscators.md` (javascript-obfuscator, webpack-obfuscator, js-confuser, jfogs, JavaScriptObfuscate, synchrony, obfuscator-io-deobfuscator, baffle).

- [x] OBF-1. jfogs (varsayılan/reverse/zero/breakout) parametre taşıma IIFE'si geri çevrilir (iife-args)
- [x] OBF-2. JSFuck (eval'li, üst kapsamlı ve çalıştırılmayan ifade kipleri) gerçek örneklerle çözülür
- [x] OBF-3. AAEncode ve JJEncode (seçilebilir değişken adı dahil) ara çözücü zinciriyle çözülür
- [x] OBF-4. webpack eval devtool modülleri fonksiyon gövdesine açılır (eval-inline)
- [x] OBF-5. webpack paketi: modül tablosu, __webpack_require__ ve modül parametre adları yerinde geri verilir, modüller yorumla işaretlenir
- [x] OBF-6. webpack-obfuscator loader'ının modül başına string dizileri çözülür ve gövde içinden temizlenir
- [x] OBF-7. obfuscator.io stringArrayIndexesType: hexadecimal-numeric-string ve 0.18 sürümü "0x.." indeksleri
- [x] OBF-8. javascript-obfuscator 0.x selfDefending kalıpları kaldırılır
- [x] OBF-9. js-confuser lock.selfDefending ve lock.integrity denetimleri açılır, integrity kabuğu özgün fonksiyonla birleşir (integrity)
- [x] OBF-10. js-confuser RGF: eval'li string fonksiyon tablosu ve kabuk fonksiyonlar özgün gövdeye döner
- [x] OBF-11. js-confuser variableMasking rest dizisi parametre/değişkenlere açılır (confuser)
- [x] OBF-12. js-confuser flatten düz nesnesi ve program düzeyine taşınan gövde geri birleştirilir
- [x] OBF-13. js-confuser dispatcher payload/dağıtıcı yapısı adlı fonksiyonlara açılır (confuser)
- [x] OBF-14. Bench: javascript-obfuscator'ın tüm seçenekleri, js-confuser'ın tüm dönüşümleri ve test/corpus örnekleri
- [x] OBF-15. Araştırma belgesi: docs/research/obfuscators.md (8 depo, teknikler, lisanslar, kapsam)
- [x] OBF-16. obfuscator.io sarmalayıcı + kontrol akışı + selfDefending birleşimi (medium/high hazır ayarı, io-everything) tam çözülür
- [x] OBF-17. js-confuser controlFlowFlattening çıktısı küçülür ve okunur: kapsam nesneleri yerel değişkenlere bölünür (cff-scope)
- [x] OBF-18. js-confuser stringConcealing + CFF: ölü kalan çalışma anı yardımcısı silinir (confuser-runtime)
- [x] OBF-22. js-confuser flatten+dispatcher, opaquePredicates+deadCode ve low hazır ayarı tamamen okunur (0.6 KB)
- [x] OBF-23. Kapalı decoder (CFF string şifresi) hiç çalışmayan dallarda bağımsız sandbox ile çözülür
- [x] OBF-24. js-confuser high hazır ayarı: pack IIFE'sindeki makine kopyaları, kapsam nesnesine düzleştirilmiş dispatcher (fonksiyon ifadesi, payload kapsamda) ve string/global yardımcıları açılır; 0.2–1.2 MB çekimler 1–2 KB okunur program