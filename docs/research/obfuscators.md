# Obfuscator ve deobfuscator araştırması

Bu belge sekiz açık kaynak deponun ne olduğunu, kodu nasıl gizlediğini (ya da deobfuscator ise neyi geri
çevirdiğini) ve PEEL'in bu çalışmadan sonra hangi pass ile neyi geri çevirdiğini anlatır. Depolar
`git clone --depth 1` ile PEEL dışındaki ayrı dizinlere indirildi, yalnızca okundu; hiçbir kurulum betiği
çalıştırılmadı. Örnek üretmek için gereken yayımlanmış npm paketleri (`jfogs`, `jsfuck`, `webpack`,
`webpack-obfuscator`, `javascript-obfuscator@0.18.8`) `--ignore-scripts` ile ayrı bir karalama dizinine kuruldu
ve PEEL dışındaki kendi betiklerimizle sürüldü. **Bu depolardan PEEL'e kod kopyalanmadı**; tüm decoder'lar
çıktıların incelenmesine dayanan bağımsız uygulamalardır. Örneklerdeki önce/sonra parçaları bu belge için
yazılmıştır.

Örnek çıktılar: `test/corpus/<araç>/` (bir kez üretilip depoya kondu) ve `test/bench.js` ön ayarları
(javascript-obfuscator ve js-confuser her çalıştırmada yeniden üretilir). Her decoder için
`test/fixtures/` altında bir fixture vardır.

| # | Depo | Tür | Lisans | Okunan sürüm / commit |
|---|------|-----|--------|------------------------|
| 1 | javascript-obfuscator/javascript-obfuscator | obfuscator | BSD-2-Clause | 5.10.1, `4db5ea3` (bench: npm 5.10.0) |
| 2 | relative/synchrony | deobfuscator | GPL-3.0-only | 2.4.6, `710e9f6` |
| 3 | javascript-obfuscator/webpack-obfuscator | webpack eklentisi + loader | BSD-2-Clause | 3.6.1, `b45af83` |
| 4 | ben-sb/obfuscator-io-deobfuscator | deobfuscator | Apache-2.0 (LICENSE dosyası; package.json "ISC" yazıyor) | 1.0.6, `42efc01` |
| 5 | zswang/jfogs | obfuscator | MIT | 1.0.0-alpha.5, `b3f54f7` |
| 6 | camwiegert/baffle | DOM metin efekti (kod gizleyici değil) | MIT | 0.3.6, `d505a96` |
| 7 | MichaelXF/js-confuser | obfuscator | MIT | 2.1.3, `31c5a47` |
| 8 | Python3WebSpider/JavaScriptObfuscate | javascript-obfuscator demo betikleri | MIT (package.json; LICENSE dosyası yok) | `f7781e1` |

GPL lisanslı synchrony'den (ve diğerlerinden) yalnızca hangi tekniklerin ele alındığı öğrenildi; kod ya da
yapı aktarılmadı.

---

## 1. javascript-obfuscator (obfuscator.io)

TypeScript ile yazılmış, Babel değil kendi AST dönüştürücüleri (`src/node-transformers/*`) ve şablon tabanlı
"custom code helper"lar (`src/custom-code-helpers/*`) kullanan obfuscator. `obfuscatePro` ve `vmObfuscation`
seçenekleri kapalı kaynak bir sunucu API'sine (obfuscator.io Pro) gider; yerel paket bu dönüşümü içermez.

Dönüşüm aşamaları: hazırlık (yorumlar, `eval` içindeki kodu da dönüştürme, korunan adlar), dönüştürme
(nesne anahtarları, sayılar, split, şablon literal), kontrol akışı düzleştirme, ölü kod ekleme, string dizisi,
yeniden adlandırma, sadeleştirme, son aşamada kaçış dizileri.

| Seçenek | Ne yapar | Küçük örnek | PEEL karşılığı |
|---|---|---|---|
| `stringArray`, `stringArrayThreshold` | String literal'ler tek bir diziye taşınır, yerlerine indeks çağrısı gelir | `"a"` → `_0x1c(0x1f)` | `string-array`, `runtime-decoders` |
| `stringArrayRotate` | Dizi, bir IIFE içinde `push(shift())` ile checksum tutana kadar döndürülür | `(function(a,n){while(!![]){...parseInt(_0x1c(0x9b))...}})(_0xarr, 0x6b1a5)` | aynı (rotasyon sandbox'ta çalışır) |
| `stringArrayShuffle` | Dizi sırası karıştırılır | — | aynı |
| `stringArrayIndexShift` | İndekse sabit bir kaydırma eklenir (`i -= 0xe5`) | — | aynı |
| `stringArrayIndexesType: hexadecimal-number` | İndeks sayı: `_0x1c(0x1f)` | — | aynı |
| `stringArrayIndexesType: hexadecimal-numeric-string` | İndeks string: `_0x1c("0x1f")` | `_0x1c("0x9b")` → `"Hello, "` | `runtime-decoders` (bu çalışmada eklendi: `"0x…"` string'leri indeks sayılır) |
| `stringArrayEncoding: base64` | Dizi elemanları özel alfabeli base64; decoder `decodeURIComponent` ile çözer | `_0x1c(0x3)` → `"alpha"` | `string-array` / `runtime-decoders` |
| `stringArrayEncoding: rc4` | RC4 + base64, çağrıda anahtar: `_0x1c(0x3, "Fg#k")` | aynı | aynı |
| `stringArrayEncoding: [none, base64, rc4]` | Birden çok decoder, her string rastgele birine | — | aynı |
| `stringArrayWrappersCount/Type/ChainedCalls/ParametersMaxCount` | Her kapsamda ara sarmalayıcılar (`var _0x5 = _0x1c` ya da parametre karıştıran `function _0x5(a,b,c){return _0x1c(b - 0x12, c)}`), zincirli olabilir | `_0x5(0x3, 0x7, 0x9)` | `wrappers`, `runtime-decoders` (alias zinciri) |
| `stringArrayCallsTransform(+Threshold)` | Decoder çağrıları kontrol akışı nesnesine (`_0x4a.abc(...)`) taşınır | — | `proxy`, `runtime-decoders` |
| `controlFlowFlattening(+Threshold)` | Bloklar `'3|1|0|2'.split('|')` sıralı `switch` döngüsüne; işlemler/literal'ler "storage" nesnesindeki proxy fonksiyonlara (`_0x4a.xYz(a, b)` = `a + b`) | `while(!![]){switch(o[i++]){case '0': ...; continue;}break;}` | `control-flow`, `proxy`, `const-objects` |
| `deadCodeInjection(+Threshold)` | Gerçek koddan kopyalanmış ölü bloklar opak `if ("abc" === "abc")` dallarına eklenir | `if ('xYz' !== 'xYz') {…kopya…}` | `opaque`, `dead-code` |
| `debugProtection`, `debugProtectionInterval` | `debugger` döngüsü kuran fonksiyon; interval ile tekrar | `(function(){return false;}).constructor("debu"+"gger").call("action")` | `dead-code` (GUARD_STRINGS, koruma IIFE'leri) |
| `selfDefending` | "callController" ile tek seferlik çağrılan geri çağrı kodun kendi metnini `(((.+)+)+)+$` ile tarar; biçimlendirilince felakete varan geri izleme | `_0x4b.toString().search("(((.+)+)+)+$")` | `dead-code` (`removeGuardedCallbacks`) |
| `disableConsoleOutput` | `console.log/warn/...` boş fonksiyonla değiştirilir | `that.console[m] = func` | **dokunulmaz**: gerçek davranıştır (çıktı kapanır). String'leri çözülür, kod okunur kalır |
| `domainLock`, `domainLockRedirectUrl` | `document.domain/location.hostname` gizli adlarla bulunur, izinli alan değilse yönlendirir | `"[a-z]"` farkı ile saklanmış alan listesi | **dokunulmaz** (ortama bağlı gerçek davranış); string'ler çözülür, kod okunur |
| `transformObjectKeys` | `{a: 1, b: x}` → `var o = {}; o.a = 1; o.b = x;` | — | `const-objects`, `simplify` |
| `renameProperties` (safe/unsafe) | Özellik adları `_0x…` adlarına (ör. `this.n` → `this._0x3f2a`) | — | Özgün adlar geri alınamaz (bilgi kaybı); davranış korunur, `rename` okunur adlar verir |
| `renameGlobals` | Üst seviye adlar da değişir | — | `rename` (bu çalışmada class bildirimini iki kez adlandırma hatası giderildi) |
| `identifierNamesGenerator` (hexadecimal/mangled/mangled-shuffled/dictionary), `identifiersPrefix`, `identifiersDictionary` | Ad üretim biçimi | `_0x1a2b`, `a`, `peel_0x…` | `rename` yalnızca `_0x…` biçimini yeniden adlandırır; diğerleri olduğu gibi kalır |
| `numbersToExpressions` | `42` → `-0x1*0x5d3+0x7*0x9b+...` | — | `const-fold` |
| `splitStrings(+ChunkLength)` | `"abcdef"` → `"abc" + "def"` | — | `const-fold` |
| `unicodeEscapeSequence` | String'ler `\x41` biçiminde | — | `literals` |
| `simplify` | Deyimleri virgül/üçlü ifadelere birleştirir | `if(a){b()}` → `a&&b()` | `simplify` |
| `target: node / browser-no-eval / service-worker` | Global nesneyi bulma şablonu değişir (`Function("return this")` yerine `window`/`global`), no-eval'de `debugger` doğrudan yazılır | — | aynı pass'ler (`literals`'in `return this` kuralı, `dead-code`) |
| `reservedNames`, `reservedStrings`, `forceTransformStrings`, `exclude`, `ignoreImports` | Dönüşüm kapsamı | — | etkisiz |
| `seed`, `compact`, `sourceMap*`, `log`, `inputFileName`, `identifierNamesCache` | Üretim ayarları | — | etkisiz |
| `optionsPreset` (low/medium/high) | Yukarıdakilerin birleşimleri; low ve high `disableConsoleOutput` ve `selfDefending` açar | — | yukarıdakiler |
| `vmObfuscation` (Pro API) | Sunucu tarafında bayt kodlu VM | — | **Doğası gereği kapsam dışı**: dönüşüm yalnızca obfuscator.io sunucusunda (ücretli API) çalışır, yerel paket içermez; örnek üretilemediği için hedeflenmiş decoder yazılamaz. Genel bytecode VM'leri `vm-lift`/`vm` ile ele alınır |

Bench ön ayarları: `io-*` (48 ön ayar; tüm seçenekler tek tek, kodlama/sarmalayıcı/indeks varyantları,
hedefler, ad üreticileri, hazır ayarlar, `io-everything`).

**Sarmalayıcı + kontrol akışı + selfDefending birleşimi** (`io-preset-medium/high`, `io-everything`) ikinci
turda tamamen çözüldü (high 76 KB → 2.4 KB, everything 72 KB → 2.2 KB, davranış aynı). Neden çözülmüyordu:

1. QuickJS'in yığın sınırı (1 MB) Node/tarayıcı yığınından büyüktü; debugProtection'ın sonsuz özyinelemesi
   QuickJS "stack overflow" yerine host yığınını taşırıp bağlamı düşürüyordu → derin doğrulama kapanıyor,
   rc4 decoder'ları denetimsiz yanlış çözülüyordu. Sınır 320 KB yapıldı. Ayrıca `(((.+)+)+)+$` araması
   QuickJS'in özyinelemeli regex motorunda host yığınını taşırıyordu; sandbox'ta kalıbın anlamı kesin
   hesaplanır (son satırın başı).
2. Koruma string'i ve callController çağrısı CFF depo nesnesinin arkasındaydı (`o.k`, `o.c(C, this, cb)`,
   `o.r(g)`): `dead-code` artık hiç değişmeyen nesne literal'inin özelliğini değer olarak çözer.
3. Depo nesnesi aynı `var` bildirimindeki sonraki tanımlayıcılarca kullanılıyordu (`var o = {…}, v = o.f(…)`),
   ölü enjekte dallarda olmayan anahtar okunuyordu (`o.length`) ve değer olarak kaçıyordu (`f(o)`):
   `const-objects` üçünü de ele alır (seviye 3+'ta kaçış derin doğrulamayla denetlenir).
4. Program düzeyi decoder yalnızca hiç çalışmayan koruma dalından çağrılıyordu: `runtime-decoders` onu
   global adıyla bağlar; sarmalayıcı bildirimli rotasyon IIFE'si de rotasyon sayılır.
5. `vm-lift`, `'2|0|1'.split('|')` dağıtıcısını VM sanıp bildirimleri kaybederek açıyordu: sırası statik
   (ya da depo nesnesindeki string'den) bilinen dağıtıcılar `control-flow`'a bırakılır.

Fixture'lar: `io-selfdef-cff-wrappers`, `io-selfdef-cff-deadcode`.

## 2. relative/synchrony (deobfuscator, GPL-3.0)

Acorn + escodegen tabanlı. Sabit bir dönüştürücü sırası çalıştırır:
`Simplify → MemberExpressionCleaner → LiteralMap → DeadCode → Demangle → StringDecoder → Simplify →
MemberExpressionCleaner → Desequence → ControlFlow → Desequence → MemberExpressionCleaner → Simplify →
DeadCode`, sonra isteğe bağlı `Rename`.

| Dönüştürücü | Geri çevirdiği teknik | PEEL karşılığı |
|---|---|---|
| Simplify | `!0`/`!![]` → `true`, negatif sayı düzeltme, sabit işlemleri hesaplama, `(function(a,b){return b(a())})(f,h)` → `h(f())` | `const-fold`, `simplify`, `proxy` |
| MemberExpressionCleaner | `a["b"]` → `a.b` | `literals` |
| LiteralMap | Salt okunur değişkenlerin literal ile değiştirilmesi | `const-fold`, `const-arrays`, `const-objects` |
| DeadCode | `if (true/false)` dallarını katlama, yanlış testte dalları çevirme, ölü değişkenler | `dead-code`, `opaque`, `unused` |
| Demangle | Decoder proxy'lerini string decoder şemasına uydurma, `arr[idx - off]` kaydırmasını çıkarma, base64/rc4 alfabesini bulma | `string-array`, `runtime-decoders` (PEEL decoder'ı statik eşleme yerine sandbox'ta çalıştırır) |
| StringDecoder | String dizisi + rotasyon IIFE'si (push/shift döngüsünü checksum'a kadar yeniden oynatır), base64/rc4 çözümü, alias'ların izlenmesi | aynı |
| Desequence | `a(), b(), c();` → ayrı deyimler | `dead-code` (sequence bölme), `simplify` |
| ControlFlow | `'1|0|2'.split('|')` switch düzleştirmesi ve storage nesnesi proxy'leri | `control-flow`, `proxy`, `const-objects` |
| jsconfuser/calculator, jsconfuser/controlflow | Eski (1.x) js-confuser hesap makinesi fonksiyonu ve CFF | `proxy`/`const-fold`, `unflatten`, `state-var` |
| ArrayMap (kapalı) | `[null, …]` ile başlayan literal dizi eşlemeleri | `const-arrays` |
| Rename | Okunur adlar | `rename` |

PEEL'in synchrony'den farkı: her dönüşüm sandbox'ta davranış karşılaştırmasından geçer, decoder'lar şablon
eşleşmesine değil çalıştırmaya dayanır.

## 3. webpack-obfuscator (BSD-2-Clause)

İki kullanım biçimi:

- **Plugin**: `processAssets` (`PROCESS_ASSETS_STAGE_DEV_TOOLING`) aşamasında her çıktı dosyasını bütün halinde
  javascript-obfuscator'dan geçirir; her dosyaya `identifiersPrefix: "a0"`, `"a1"`… verir (aynı sayfadaki
  paketlerin adları çakışmasın). Kaynak haritası iki aşamalı olarak aktarılır.
- **Loader**: her modülü ayrı ayrı gizler (`ignoreRequireImports: true`); her modülün **kendi** string dizisi,
  rotasyonu ve decoder'ı olur, bunlar modül fonksiyonunun içinde kalır.

Paketin geri kalanı webpack'in kendi yapısıdır: modül tablosu (`{944(o){…}}` ya da `"./src/a.js"(m, e, r){…}`),
`__webpack_require__` (küçültülmüş: `function e(n){…t[n]={exports:{}}…o[n](s,s.exports,e)…}`) ve `eval`
devtool'unda her modülün `eval("{…//# sourceURL=…}")` içinde string olarak saklanması.

| Teknik | Örnek | PEEL karşılığı |
|---|---|---|
| Plugin: tüm paket tek string dizisiyle | `a0_0x5e1d()` | `string-array`, `runtime-decoders` (+ `rename` `a0_0x…` adları için webpack pass'inde tanınır) |
| Loader: modül başına string dizisi | modül fonksiyonunda `function s(){var t=[…]}`, `function a(t,n){return t-=220,s()[t]}` | `runtime-decoders`: kodlamasız indeks decoder'ı tanınır, rotasyon yalnızca döngü gövdeli IIFE sayılır (önceden bütün paket IIFE'si rotasyon sanılıp siliniyordu), altyapı fonksiyon gövdelerinden de temizlenir |
| `eval` devtool | `eval("{__webpack_require__.r(...)…}")` | `eval-inline` (yeni) |
| Küçültülmüş runtime adları | `e(944)`, `o[n](s, s.exports, e)` | `webpack` (yeni): `__webpack_require__`, `__webpack_modules__`, `module/exports/__webpack_require__` parametreleri ve `/* webpack modül 944 */` |

Bench: `test/corpus/webpack/` (prod-plain, prod-plugin, prod-plugin-high, dev-eval-plain, dev-eval-plugin,
dev-loader, prod-loader). Modüller ayrı dosyalara bölünmez: PEEL tek çıktı üretir; modül sınırları yorumla
işaretlenir, adlar geri verilir.

Eklenti (plugin) çıktılarında her örnekte bir geri alma vardı: webpack-obfuscator rotasyon IIFE'sini paket
gövdesiyle tek virgül ifadesine koyar (`(function (T, n) {…push…shift…})(T, 0x57f15), (() => {…})()`).
`static-strings` rotasyonu tanımadığı için rotasyonsuz model kuruyor, checksum çağrılarını da değiştiriyor,
program sonsuz döngüye giriyordu (davranış kontrolü geri alıyordu). Şimdi program düzeyinde ilk ifadesi rotasyon
olan virgül ifadesi ayrı deyime bölünür; rotasyon deyim olarak tanınmadığı hâlde dizi bir yerde karıştırılıyorsa
model hiç kurulmaz. Fixture: `webpack-rotator-sequence`.

## 4. ben-sb/obfuscator-io-deobfuscator (Apache-2.0)

Babel + `@codemod/matchers`. "Sandbox kullanmaz" ilkesiyle her şeyi statik eşleştirir; dönüşümler 50 tura kadar
tekrarlanır: `UnusedVariableRemover, ConstantPropagator, ReassignmentRemover, DeadBranchRemover, ObjectPacker,
ProxyFunctionInliner, ExpressionSimplifier, SequenceSplitter, ControlFlowRecoverer, PropertySimplifier,
AntiTamperRemover, ObjectSimplifier, StringRevealer`.

| Dönüşüm | Teknik | PEEL karşılığı |
|---|---|---|
| StringRevealer | basic/base64/rc4 decoder, rotasyon (yeniden oynatarak), sarmalayıcılar | `string-array`, `runtime-decoders`, `wrappers` |
| ObjectPacker / ObjectSimplifier / ProxyObject | `transformObjectKeys` ve CFF storage nesneleri | `const-objects`, `proxy` |
| ProxyFunctionInliner | `function _0x2(a,b){return a+b}` proxy'leri | `proxy`, `wrappers` |
| ControlFlowRecoverer | `'2|0|1'.split('|')` switch | `control-flow` |
| DeadBranchRemover | `deadCodeInjection` opak dalları | `opaque`, `dead-code` |
| AntiTamperRemover | selfDefending, debugProtection **ve disableConsoleOutput** fonksiyonlarını siler | selfDefending/debugProtection: `dead-code`. disableConsoleOutput'u PEEL **bilerek silmez** (konsolu gerçekten kapatır; silmek davranışı değiştirir) |
| ExpressionSimplifier, SequenceSplitter, PropertySimplifier, ConstantPropagator, ReassignmentRemover, UnusedVariableRemover | sadeleştirme | `const-fold`, `simplify`, `unused` |

domainLock'u ele almaz. PEEL'de de domainLock kodu kalır, yalnızca okunur hale gelir.

## 5. zswang/jfogs (MIT)

Esprima ile ayrıştırıp kaynak metni aralıklarla yeniden yazar. Programdaki her literal (string, sayı, regex,
true/false/null) ve her `a.b` özellik adı benzersiz değerlere ayrılıp bir IIFE parametresine (`$fog$0`, …)
dönüştürülür; değerler çağrı argümanı olur. Başa bir koruma eklenir: son parametre `"‮"` (sağdan sola
işareti) değilse fonksiyon hiçbir şey yapmaz.

```js
// önce
console.log("Hi", 42);
// jfogs (varsayılan)
(function ($fog$2, $fog$0, $fog$1, $fog$3) {
  if ("‮" !== $fog$2) { return; }
  console[$fog$0]($fog$1, $fog$3);
})("‮", "log", "Hi", 42);
```

Kipler (`type`):

- **varsayılan**: değerler olduğu gibi.
- **reverse**: string argümanlar ters yazılır; gövde başındaki döngü `arguments` üzerinden onları geri çevirir
  (`a[i] = a[i].split("").reverse().join("")`), ikinci döngü parametre sırasını uçtan uca takas eder.
  Katı olmayan kipte `arguments[i]` parametreye bağlı olduğu için parametreler yerinde değişir.
- **zero**: her string karakteri 7 (Unicode varsa 8, UTF-8 baytları üzerinden) bitlik ikilik koda, bitler
  sıfır genişlikli karakterlere (`‌` = 0, `‍` = 1) çevrilir; döngü `replace(/./g)` ve
  `replace(/.{7}/g, parseInt(x, 2))` ile çözer, Unicode'da UTF-8 çözümü de yapar.
- **breakout**: üst seviye adlar dış değişkene kopyalanır (`var $fog$N = {}; … $fog$N.f = f; … var f = $fog$N.f;`).

PEEL: **`iife-args`** (yeni). Sabit argümanlı IIFE'nin önsözü (koruma, `var a = arguments`, `arguments`
döngüleri) sandbox'ta aynı katılık kipinde çalıştırılır, parametrelerin son değerleri alınır; primitive olanlar
kullanım yerlerine yazılır, nesne değerler (regex, `String`, `parseInt`) orijinal argümanıyla parametre olarak
kalır ya da kullanılmıyorsa silinir. Korumasız (sıradan) sabit argümanlı IIFE'lere dokunulmaz.
Kalan: dış IIFE (`(function () { … })()`) korunur, çünkü açmak üst seviye bildirimleri global yapar.

Bench: `test/corpus/jfogs/` (default, reverse, zero, her biri Unicode'lu ve breakout varyantları).

## 6. camwiegert/baffle (MIT)

**Kod gizleyici değildir.** DOM öğelerinin `textContent`'ini rastgele karakterlerle (`characters` seçeneği)
değiştirip zamanla asıl metni "açığa çıkaran" görsel bir efekt kütüphanesidir (`start()`, `reveal(ms)`,
`text()`). JavaScript kaynağını dönüştürmez; geri çevrilecek bir kodlama yoktur. PEEL'e decoder eklenmedi.

## 7. MichaelXF/js-confuser 2.1.3 (MIT)

Babel tabanlı. Dönüşümler `src/order.ts` sırasıyla çalışır: Preparation → ObjectExtraction → Flatten → Lock →
RGF → Dispatcher → DeadCode → Calculator → GlobalConcealing → OpaquePredicates → StringSplitting →
StringConcealing → VariableMasking → DuplicateLiteralsRemoval → ControlFlowFlattening → MovedDeclarations →
RenameLabels → Minify → AstScrambler → RenameVariables → Finalizer (StringEncoding, hexadecimalNumbers) → Pack →
Integrity (en son).

| Seçenek | Ne yapar | Küçük örnek | PEEL karşılığı |
|---|---|---|---|
| preparation (her zaman) | `o.x` → `o["x"]`, `{x:1}` → `{["x"]:1}`, tek deyimleri bloklara | — | `literals`, `simplify` |
| `objectExtraction` | Sabit nesneyi ayrı değişkenlere böler: `var o={a:1}` → `var o_a=1` | — | davranış aynı, okunur |
| `flatten` | Fonksiyon gövdesi program düzeyine taşınır, dış değişkenlere getter/setter/`typeof`/çağrı yöntemli "düz nesne" ile erişilir; kabuk `function f(...A){var O={…};return F(O,A)}` | `F(O, [name])` | **`flat-fns`** (yeni) |
| `lock.selfDefending` | Her fonksiyona `new RegExp("\n").test(f)` ise `while(true){}` | — | **`integrity`** (main ile birleştirildi) |
| `lock.antiDebug` | `debugger;` deyimleri | — | `dead-code` |
| `lock.integrity` | Fonksiyon kopyası `G`'nin `toString()` özeti (cyrb53) hesaplanır; `if (h === 6542284030023826) {…} else {karşı önlem}` | — | **`integrity`**: özet çağrısı değerlendirme bağlamında hesaplanır, özet testi özgün dalla değiştirilir, `function F(){return G(...arguments)}` kabuğu `G`'nin gövdesine döner |
| `lock.tamperProtection` | Yerel fonksiyon denetimi (`{ [native code] }`) ve katı kip tespiti | — | gerçek davranış, dokunulmaz (okunur) |
| `lock.domainLock` | `if (!new RegExp("example.com").test(location.href)) while(true){}` | — | gerçek davranış, dokunulmaz |
| `lock.startDate/endDate` | `Date.now()` karşılaştırması | — | gerçek davranış, dokunulmaz |
| `lock.countermeasures`, `customLocks`, `defaultMaxCount` | Karşı önlem fonksiyonu adı, özel kilitler | — | karşı önlem kodu kalır |
| `rgf` | Fonksiyon gövdeleri string olarak bir diziye konur, `eval` ile üretilir; kabuk `R[k].apply(this,[R,arguments])` | `E('function X(){var[R,A]=arguments;…}X;')` | **`rgf`** (yeni) |
| `dispatcher` | Fonksiyonlar tek dağıtıcının nesnesine, argümanlar global payload dizisiyle; referans/`new` bayrakları | `(P=["PEEL"], D("k1"))` | **`confuser`** (main'in dispatcher çözücüsü; bu çalışmanın ayrı pass'i onunla birleştirildi) |
| `deadCode` | Şablonlardan (`deadCodeTemplates`) ölü fonksiyonlar ve opak dallar | — | `dead-code`, `opaque`, `unused` |
| `calculator` | İkili işlemler `calc(op, a, b)` switch fonksiyonuna | — | `proxy`, `runtime-functions` |
| `globalConcealing` | Global adlar `getGlobal("dZGlvoH")` ile | — | `runtime-decoders` (global adı döner) |
| `opaquePredicates` | `if (PREDICATE() && test)` | — | `opaque`, `const-fold` |
| `stringSplitting` | `"abc"` → `"a"+"bc"` | — | `const-fold` |
| `stringConcealing`, `customStringEncodings` | Base91 türevi rastgele alfabe + LZ-string sıkıştırma; decoder kapsam nesnelerinde | — | `runtime-decoders`, `runtime-functions` |
| `stringEncoding` | `\x`/`\u` kaçışları | — | `literals` |
| `variableMasking` (1.x'teki "stack") | Parametre ve yerel değişkenler tek rest dizisinin elemanlarına | `function f(...M){return M[0]+M.a}` | **`confuser`** (A-21; bu çalışmanın var-mask mantığı main'in rest+length çözücüsünün yerine geçti: adlı anahtarlar ve length deyimsiz biçim de açılır) |
| `duplicateLiteralsRemoval` | Tekrarlanan literal'ler diziye | — | `const-arrays` |
| `controlFlowFlattening` | Gövde parçalara bölünüp `while`+`switch` durum makinesine; `with` kapsamları, durum değişkenleri | — | `unflatten`, `state-var`, `vm`, `control-flow` |
| `movedDeclarations` | Değişkenler kullanılmayan parametrelere taşınır | — | `unused`, `simplify` |
| `renameLabels` | Etiketler kısaltılır/silinir | — | etkisiz |
| `minify` | Ölü kod, gruplama, `!0`, `void 0` | — | `literals`, `simplify` |
| `astScrambler` | Deyimleri virgül ifadelerine katlar | — | `dead-code` (sequence bölme) |
| `renameVariables`, `renameGlobals`, `identifierGenerator` (hexadecimal/randomized/zeroWidth/mangled/number/chinese) | Ad üretimi | — | özgün adlar kayıp; `rename` yalnızca `_0x…` biçimini adlandırır |
| `hexadecimalNumbers`, `compact` | Sayı biçimi | — | `literals` |
| `preserveFunctionLength` | `Object.defineProperty(fn, "length", …)` yardımcısı | — | `dead-code` (length sarmalayıcısı); `rgf`/`flat-fns`/`confuser` açtığı fonksiyonun length'i zaten parametre sayısı olur |
| `pack` | Tüm program `new Function` / IIFE içine, globaller bir nesne üzerinden | — | `unpack`, kalan IIFE kabuğu korunur |
| preset `low/medium/high` | Birleşimler | — | yukarıdakiler |

Bench ön ayarları: `jc-*` (44 ön ayar; her dönüşüm tek tek, her kilit ayrı, her ad üreticisi, hazır ayarlar
ve `jc-node`). Hepsi davranış olarak doğru ve 7/7 iğne buluyor.

**controlFlowFlattening** (ikinci tur): `jc-cff` 30 KB → 1.3–3 KB, `jc-cff-rich` 35 KB → 2–4 KB. Neden büyüyordu:
`unflatten` etiketli döngüdeki `break outer`'ı makineye atlama sayıp bir çağrı yerini açamıyordu; açılan
kopyalarla birlikte özgün makine de kalıyordu (dörtte üç kopya + özgün). Etiket deyimin kendi içindeyse atlama
sayılmaz. Hiç çalışmayan çağrı yerlerinin (const-fold'un katladığı fonksiyonlar) başlangıç durum dizisi
argümanı yan etkisizse (sayılar + sabit dizi dilimleri) program sonunda değerlendirilir. Okunurluk için
`cff-scope` (yeni): tek çağrılı makine kopyası kabuğuna taşınır, kapsam nesnesi özellikleri
(`scope.K.x`) yerel değişkenlere bölünür, okunmayan kapsam özelliğine atanmış ölü fonksiyonlar ve giriş
makinesinin kullanılmayan durum parametreleri silinir. Fixture'lar: `jc-cff-scope`, `jc-cff-labels`.

**stringConcealing + CFF** (ikinci tur): yardımcı (getGlobal + UTF-8 `bufferToString` çözücüsü, kendisi de CFF
ile düzleştirilmiş) çağrılar çözüldükten sonra ölü kalıyordu. Çalışmayan çağrı yerlerinin statik başlangıç
durumu sayesinde yardımcının makineleri de açılır; `confuser-runtime` (yeni) sonucu kullanılmayan yardımcı
IIFE'sini (yalnızca yerel atama, `new Array(n)`, `String.fromCharCode` okuması), okunmayan yerleşik takma
adlarını (`S = G.String || String`) ve getGlobal'ı siler. 186 KB'lık örnek 1 KB'a iner. Fixture: `jc-cff-strings`.

**Üçüncü tur (hazır ayarlar):** `jc-flatten` 2 KB → 0.6 KB (dispatcher girdisinin iç içe parametre kalıbı),
`jc-opaque` 12 KB → 0.6 KB (blok içi ölü fonksiyon bildirimleri; Annex B'yi koruyarak ölü dal katlama),
`jc-low` 9–17 KB → 0.6–0.7 KB (tek atamalı değişken yayılımı, movedDeclarations'ın parametreye taşıdığı
dispatcher nesnesi ve girdi yerelleri, `!x;` kalıntıları, program düzeyi string yardımcısı),
`jc-medium` 203 KB → 10 KB. Kapalı decoder'lar (CFF string şifresi `xor(key, start, len)`) hiç çalışmayan
dallarda bile bağımsız sandbox'ta çözülür; durum dizisi argüman dizisinden açılan makineler de kopyalanır.
Fixture'lar: `jc-flatten-dispatcher`, `jc-opaque-deadcode`, `jc-low-small`, `jc-dispatcher-moved`.

**Dördüncü tur (`jc-high`, OBF-24 kapandı):** 23 rastgele çekimde (190 KB – 1.2 MB) davranış aynı, tüm iğneler,
geri alma yok; 21'i 0.9–3.2 KB'lık okunur programa iner (jc-medium/jc-cff gibi), 1.17 MB'lık çekim 9.5 KB'a.
Bir jc-high-rich çekiminde (328 KB → 41 KB) kapsam nesnesi eksik bir iç fonksiyon makinesi kopyası (hiç
çağrılmıyor, çağrılsa TypeError verir) global getter'ı ve dispatcher'ı canlı tutar. Yüksek ayarda `pack` tüm programı bir IIFE'ye koyar,
programın kendi bloğu da CFF ile düzleşir: dispatcher kapsam nesnesi özelliğine
(`scope.K.p = function (...a) { return M(seq, {K: scope.K, L: {}}, rt, a); }`), payload da kapsam nesnesine
taşınır ve dispatcher'ın gövdesi ayrıca kendi makinesine bölünür. Neden kalıyordu ve ne yapıldı:

- `cff-scope` makine kopyalarını yalnızca program düzeyinde arıyordu; pack IIFE'sinin gövdesindeki kopyalar da
  kabuğa taşınır. Çağrı kabuğun son deyimi olabilir (`return M(seq)` IIFE gövdesinin sonunda); verilmeyen
  argümanın varsayılanı (`scope = { K: {} }`) bildirimin başlangıcı olur, kopyanın adları kabukla çakışırsa
  yeniden adlandırılır. Kapsam bölme bloğa girerken kurulan nesneleri (`scope.L = {}`) de böler: deyim, L'nin
  yerellerini `undefined`'a çeken atamaya döner. Okunmayan kapsam özelliği atamaları (ölü küme), kopya kabuğa
  taşınınca oluşan takma ad kökleri (`var S2 = { K: S.K, L: {} }`) ve fonksiyon ifadesi makinelerine geçen
  kapsamlar varken de silinir.
- js-confuser CFF dönüş bayrağı protokolü (`F = undefined; V = inner(); if (F) return V;`, sonunda çıplak
  `return;` olabilir): inner'ın her değerli dönüşü bayrağı kuruyorsa gövdesi dış fonksiyonun sonuna açılır.
- `unflatten`: tek kez atanan fonksiyon ifadesi makineleri (`V = function (states, scope = {…}) {…}`) de çağrı
  başına kopyalanır; kopyası kabuğa taşınmış makinenin sabit durum dizisi (`var S = [n, …slice(a, b)]`)
  statik hesaplanıp makine yerinde açılır.
- `confuser`: rest dizisinden açılan argümanlar (`function (...R) { let a, b; [a, b = {…}] = R; }`) gerçek
  parametre olur; dispatcher program düzeyinde olmasa da (pack IIFE'si), tek kez atanan bir fonksiyon ifadesi
  olsa da tanınır; tablo başlangıçsız yerelde (`let fns; fns = {…}`) ya da dispatcher'ın kendi taze kapsam
  kökünde (`S.K.fns = {…}`; fonksiyon üretme dalı makinenin içinde kalmışsa referans çağrıları açılmaz;
  temizleme dalında başka deyim ya da okunamayan dönüş sarmalı varsa yalnızca o bayraklı çağrılar kalır),
  bayrak testleri `true &&` ya da boş
  fonksiyona `in` testi önekli, temizleme dalında ölü bildirimler, dönüş `ret === "…" ? {k: v} : v` biçiminde
  olabilir. Payload çağrıdan önceki deyimde atanabilir (`P = [a, b]; return new D("k", f, r).k`); girdiler
  payload'u atama biçimiyle (`[x, [y]] = P`) okuyabilir. Girdiler yalnızca `fns[name]()` / `.apply(this)` ile
  çağrılıyorsa rest maskeli girdinin her indeksi yereldir; variableMasking negatif ve büyük indeksleri de açar.
  movedDeclarations'ın hiç verilmeyen parametreye taşıdığı fonksiyon (`if (!P) P = function …`) düz atama olur.
- `dead-code`: tek kez atanan boş fonksiyona `"k" in V` testi (her test atamadan sonra çalışıyorsa) katlanır;
  kapsam yolundaki `"k" in S.K.f` de, `f` adına programda tek yazma (boş fonksiyon) varsa, ad başka yerde
  anahtar/string/silme hedefi değilse ve dinamik adlı yazma yoksa (unused'un ad tabanlı ölü özellik kuralı);
  `dead-extra`: break'siz `while (true)` sonrası erişilemez sayılır, sonucu kullanılmayan literal tablo deyimi
  silinir.
- `confuser-runtime`: ilk adayı `globalThis` olan getGlobal (diğer adaylar CFF/string gizlemeyle şişmiş
  `new Function("return this")` olsa da hiç çalışmaz) ve sonucu kullanılmayan çağrısı, UTF-8 çözücü IIFE'sinin
  kendi rest dizisine yazması etkisiz sayılır.
- `runtime-decoders`: dispatcher (gövdesinde decoder taşısa da) decoder adayı değildir. Kapsam yolundaki az
  çağrılı, kaynağı decoder'a benzemeyen fonksiyon ancak her çağrısında sayısal (indeks) argüman varsa, bütün
  sonuçları global nesneyse (globalConcealing getter'ı; yerele bölünmüş getter da, dışarıya yazmıyorsa) ya da
  yakalanan metni saf ise (dışarıya yazmıyor, çağrı içermiyor; metin yalnızca ayrıştırılır) decoder sayılır:
  sayaç artıran string→string fonksiyonun çağrısını değerle değiştirmek yan etkisini siliyordu. Dizi/nesne
  argümanlı dinamik çağrı (makine kopyası çağrısı) gözlemle değiştirilmez.
- `unused`: yalnızca kendi içinden okunan, tek kez atanmış fonksiyon değişkeni (açılmış getter'ın ölü decoder
  makinesi) silinir; `restructure`: makine açılırken dallara kopyalanan ortak kuyruk birleşir
  (`if (c) { A; T } T` → `if (c) { A } T`; yalnızca sonek ortaksa `if (c) { A } else { B } S`); `extract`:
  fonksiyon tanımlayan atamalar yardımcıya çıkarılmaz (henüz açılmamış kapsam deposunu sonraki turlardan
  saklıyordu). Kapsam bölme anahtar başına yapılır: değer olarak başka makineye geçen anahtar (`{ P: S.P }`)
  yerinde kalır, diğer taze anahtarlar bölünür. Global getter'ın yalnızca global nesneye çözülen çağrıları
  değiştirilir; kapsam yolundaki dispatcher, yakalanan metni ayrıştırılarak tanınır ve decoder sayılmaz.
- `pipeline`: büyük çekimler katman katman açıldığı için tur sınırı 25 → 40 (değişiklik durunca biter),
  derin (davranış) doğrulama sınırı 1 MB → 2 MB (1.1 MB'lık çekimler de doğrulanır).

`jc-high-rich` çekimlerinin bazılarında js-confuser'ın kendi çıktısı `#secret` özel alanını bozar (`"hidden"`
yerine başka değer basılır). `test/bench.js` bunu (yalnızca o satır farklıysa) algılar, satırı
`jc-high-rich (#secret bozuk)` olarak gösterir: beklenen davranış gizlenmiş kodunkidir, `"hidden"` iğnesi aranmaz.
Fixture'lar: `jc-dispatcher-scoped`, `jc-dispatcher-expression`, `jc-dispatcher-moved-fn`, `jc-pack-machine`,
`jc-return-flag`, `jc-getglobal-helper`, `jc-global-getter`, `jc-variable-masking-locals`, `jc-scope-string-fn`,
`dead-endless-loop`, `restructure-tail-merge`, `restructure-tail-else`, `unused-self-ref`, `dead-in-property`,
`extract-fn-defs`, `jc-dispatcher-scope-table`, `jc-global-getter-partial`, `jc-scope-partial-split`;
açıklama boyutu için `annotate-compact`.

Doğası gereği geri alınamayanlar (bkz. yol haritası işaretleri):

- **Özgün adlar** (`renameVariables`, `identifierGenerator`, javascript-obfuscator `renameProperties` ve ad
  üreticileri): çıktıda yalnızca üretilmiş adlar vardır, özgünü hiçbir yerde saklanmaz. dispatcher ile adı
  kaybolan fonksiyonlar `fn_<anahtar>` olur.
- **Function.length**: `rgf`/`flat-fns`/`confuser` (variableMasking)/integrity kabuğu açılınca fonksiyonun
  `length` değeri özgün kaynaktaki parametre sayısına döner (gizlenmiş kodda 0'dı, preserveFunctionLength
  ayrıca yazıyordu). Kabuktaki 0 değerini korumak gizlemeyi geri getirmek olurdu; PEEL'in length-sarmalayıcısı
  kuralıyla aynı kabul.
- js-confuser 2.1.3'ün CFF'si bazı rastgele çekimlerde sınıf özel alanını bozuyor (`#secret` yerine rastgele
  string basılıyor): gizlenmiş programın kendi davranışıdır, PEEL aynen korur (`jc-cff-rich` bu çekimde 6/7).

## 8. Python3WebSpider/JavaScriptObfuscate

"Python3 web scraping" kitabının (Germey) örnek deposu. İçinde **yalnızca javascript-obfuscator 0.18.8**
kullanan 13 demo betiği ve bir `main.js` vardır; JSFuck, AAEncode, JJEncode ya da eval paketleyici
**içermez**. Demolar ve ayarları:

| Demo | Ayarlar |
|---|---|
| demo_compact | `compact: false` |
| demo_control_flow_flattening, main | `compact: false, controlFlowFlattening: true` |
| demo_dead_code_injection | `deadCodeInjection: true, deadCodeInjectionThreshold: 1` |
| demo_debug_protection | `debugProtection: true` |
| demo_disable_console_output | `disableConsoleOutput: true` |
| demo_domain_lock | `domainLock: ['cuiqingcai.com']` |
| demo_identifier_names_generator | `identifierNamesGenerator: 'mangled'` |
| demo_identifiers_prefix | `identifiersPrefix: 'germey'` |
| demo_rename_globals | `renameGlobals: true` |
| demo_self_defending | `selfDefending: true` |
| demo_string_array | `stringArray, rotateStringArray, stringArrayEncoding: true (base64), stringArrayThreshold: 1` |
| demo_target | `target: 'browser-no-eval'` |
| demo_transform_object_keys | `transformObjectKeys: true` |
| demo_unicode_escape_sequence | `unicodeEscapeSequence: true` |

0.18 sürümünün 5.x'ten farkları ve PEEL karşılığı:

- İndeksler string: `_0x5d7c('0x1f')`, rc4'te `_0x5d7c('0x1f', 'Fg#k')` → `runtime-decoders` (`"0x…"` indeks).
- Decoder kendi içinde bir selfDefending denetimi (çerez/`RegExp` + `removeCookie`) taşır; dizi ve decoder
  birlikte silindiği için ayrıca ele almaya gerek kalmaz.
- selfDefending geri çağrısı farklı şablondur: `\w+ *\(\) *{\w+ *['|"].+['|"];? *}` ile sıkıştırılmış fonksiyon
  metnini, `(\\[x|u](\w){2,4})+` ile kaçış dizilerini test eder; tutmazsa sonsuz özyineleme
  (`indеxOf`, Kiril "е"). → `dead-code` GUARD_STRINGS'e eklendi.
- Rotasyon `while (--n) arr.push(arr.shift())` sayaçlı biçimdedir → `string-array`.

Görevde beklenen JSFuck/AAEncode/JJEncode ve eval paketleyicileri bu depoda olmasa da PEEL'in
`predecoders` pass'i bunları iddia ettiği için gerçek örneklerle sınandı ve düzeltildi:

- **JSFuck** (jsfuck 0.4.0): Function'a `[]["flat"]["constructor"]` ile ulaşır; `wrapWithEval` ve
  `runInParentScope` kipleri `Function("return eval")()` zinciri kurar. Önceki kanca sahte (boş) fonksiyon
  döndürdüğü için zincir kopuyordu. Ayrıca QuickJS'te argümansız `"".fontcolor()` hata veriyordu (jsfuck `"`
  karakterini buradan alır) → sandbox'ta tarayıcı davranışına eşitlendi. Çalıştırılmayan ifade kipi
  (`encode(s, false)`) bir string üretir → string literal'e çevrilir.
- **AAEncode**: `(ﾟДﾟ)['_'] = (o^_^o)['constructor']['constructor']` (Function), sekizlik kaçışlarla yazılmış
  kaynak `Function('return "\\143…"')()` ile çözülüp `Function(kaynak)('_')` çalıştırılır. Önceden ilk
  yakalanan `return "…"` gövdesi program sanılıyordu (davranış sessizce değişiyordu).
- **JJEncode**: `$=~[];$={___:++$,…}` sözlüğü, `$.$($.$($.$$+"\""+…+"\"")())()`; global değişken adı
  seçilebilir (`_peel=~[];…`) → tanıma genişletildi.
- Tek `return` deyiminden oluşan ara gövdeler artık aday sayılmaz; yük zaman aşımına uğrasa da yakalananlar
  korunur.

Bench: `test/corpus/javascriptobfuscate/` (16 örnek) ve `test/corpus/encoders/` (jsfuck, jsfuck-eval,
jsfuck-parent, aaencode, aaencode-unicode, jjencode, jjencode-gv).

---

## Bu çalışmada eklenen / değişen pass'ler

| Pass | Dosya | Seviye | Ne yapar |
|---|---|---|---|
| `integrity` | `src/passes/24-integrity.js` | 1 | main'in özet denetimi çözücüsü + bu çalışmadan js-confuser selfDefending IIFE'si ve integrity kabuğunun birleştirilmesi |
| `iife-args` | `src/passes/23-iife-args.js` | 2 | jfogs parametre taşıma IIFE'si, çözücü önsöz sandbox'ta |
| `eval-inline` | `src/passes/38-eval-inline.js` | 2 | Fonksiyonun tek deyimi olan sabit `eval("…")` |
| `rgf` | `src/passes/39-rgf.js` | 2 | js-confuser RGF tablosu ve kabukları |
| `confuser` | `src/passes/37-confuser.js` | 2 | main'in dispatcher/rest-parametre/__generator pass'i; variableMasking mantığı bu çalışmadan |
| `flat-fns` | `src/passes/47-flat-fns.js` | 2 | js-confuser flatten |
| `cff-scope` | `src/passes/46-cff-scope.js` | 3 | js-confuser CFF makine kopyaları ve kapsam nesneleri |
| `confuser-runtime` | `src/passes/48-confuser-runtime.js` | 2 | js-confuser stringConcealing ölü yardımcısı |
| `const-objects`, `unflatten`, `control-flow`, `vm-lift` | 28, 76, 70, 77 | — | ikinci turdaki genişletmeler (yukarıda) |
| `webpack` | `src/passes/93-webpack.js` | 2 | webpack modül tablosu ve runtime adları |
| `predecoders` | `src/passes/20-predecoders.js` | 1 | JSFuck/AAEncode/JJEncode düzeltmeleri |
| `runtime-decoders` | `src/passes/35-runtime-decoders.js` | 2 | hex string indeks, kodlamasız indeks decoder'ı, gövde içi altyapı |
| `dead-code` | `src/passes/80-dead-code.js` | 2 | 0.x selfDefending kalıpları |
| `unused` | `src/passes/90-unused.js` | 3 | for başlığındaki kullanılmayan alias |
| `rename` | `src/passes/95-rename.js` | 4 | class bildiriminin çift adlandırılması hatası |
| `static-strings` | `src/passes/31-static-strings.js`, `src/core/obfio.js` | 2 | virgül ifadesindeki rotasyon IIFE'si (webpack-obfuscator) |
| `dead-extra` | `src/passes/82-dead-extra.js` | 2 | break'siz sonsuz döngü sonrası, etkisiz literal tablo ve `Object.create(null)` deyimleri |
| `restructure` | `src/passes/86-restructure.js` | 2 | dala kopyalanmış ortak kuyruk birleştirme |
| `annotate` | `src/passes/99-annotate.js` | 4 | kalıp özet yazılmaz, bilgi yoksa JSDoc eklenmez, boş deyim bölüm başlığı almaz, hesaplanan değişkenler ana akışta |

Fixture'lar: `jfogs-default`, `jfogs-reverse`, `jfogs-zero`, `jsfuck-eval`, `aaencode`, `jjencode`,
`eval-inline`, `webpack-bundle`, `webpack-loader`, `io-index-string`, `io018-self-defending`, `jc-integrity`,
`jc-integrity-collapse`, `jc-lock-selfdefending`, `jc-rgf`, `jc-variable-masking`, `jc-flatten`, `jc-dispatcher-small`.
