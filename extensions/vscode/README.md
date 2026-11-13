# PEEL for VS Code

Obfuscated JavaScript'i editörden çıkmadan çözer. Motor, PEEL web uygulaması ve CLI ile aynıdır:
Babel tabanlı pass'ler ve kodu çalıştırması gereken adımlar için yalıtılmış QuickJS (WASM) sandbox'ı.
Kod hiçbir sunucuya gönderilmez.

## Komutlar

| Komut | Ne yapar |
|---|---|
| `PEEL: Dosyayı çöz` | Etkin dosyayı çözer, sonucu yan sekmede açar |
| `PEEL: Seçimi çöz` | Yalnızca seçili kodu çözer (`peel.replaceSelection` ile yerine yazar) |
| `PEEL: Çöz ve analiz et` | Çözer, risk/IOC/teknik raporunu Markdown önizlemede ve bulguları Problems panelinde gösterir |
| `PEEL: Başka sürümle karşılaştır` | İki sürümü çözer, yeniden adlandırmadan bağımsız semantik farkı ve yan yana diff'i gösterir |

## Ayarlar

`peel.level` (1-4), `peel.sandbox`, `peel.deep`, `peel.replaceSelection`, `peel.language` (`tr`/`en`).

## Derleme

```bash
cd extensions/vscode
npm run pack-core      # depo kökünden peel-js paketini (peel-js-0.1.0.tgz) üretir
npm install
npm run package        # peel-vscode-0.1.0.vsix
```

`peel-js` npm'de yayımlandıktan sonra `dependencies` içindeki `file:` bağımlılığı sürüm numarasıyla değiştirilebilir.
