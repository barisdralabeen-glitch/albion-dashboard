# Dr aLabeen - Albion Pazar Analiz

Albion Online Europe sunucusu için canlı pazar analiz paneli ve tam pazar tarayıcısı. Veri kaynağı: Albion Online Data Project (AODP) ücretsiz açık API'si.

## Çevrimiçi site

Arkadaşlara göndermek için önerilen kalıcı bağlantı: **https://barisdralabeen-glitch.github.io/albion-dashboard/** (GitHub Pages). Bu bağlantı, GitHub Pages'te yayınlanan sabit site adresidir; yerel geliştirme sunucusuyla veya Cloudflare quick-tunnel ile aynı şey değildir.

Cloudflare quick-tunnel yalnızca geçici yedektir: adresi dinamiktir ve değişebilir. Site bilgisayarından sunulduğu için arkadaşlarının kullanabilmesi için bilgisayarın açık, yerel sunucunun ve tünelin çalışır durumda olması gerekir. Aynı ağdaki cihazlar için yerel yedek: `http://<PC-IP>:8722`.

## Nasıl açılır?

### Tarama (kolay başlangıç)

1. Fırsat türünü seç: **Flip**, **Ucuz ilan** veya **Buy fırsatı**.
2. İstersen kaliteyi değiştir; varsayılan olarak tüm kalite seviyeleri seçilidir.
3. **Taramayı Başlat** düğmesine bas. Tarama kendiliğinden başlamaz.

Diğer ayarlar **Daha fazla ayar** bölümündedir. Sonuç tablosunda yalnızca temel sütunlar gösterilir; ek sütunları kolon görünürlüğü ayarından açabilirsin.

`index.html` dosyasını tarayıcıda aç. Gerekirse yerel sunucuyu çalıştır:

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
# http://127.0.0.1:8722/
```

Arkadaşlarla paylaşım için kalıcı GitHub Pages bağlantısını kullan. Yerel sunucu ve Cloudflare quick-tunnel yalnızca geçici erişim/yedek içindir; tünel bağlantısı bilgisayar ve tünel çalıştığı sürece kullanılabilir.

## Özellikler

- **Tarayıcı:** 8.700+ ürün; tier, kalite, şehir ve kategori filtreleri; fırsat tablosu, rota kârları ve CSV dışa aktarımı.
- **Ürün detayı:** canlı şehir fiyatları, kâr/fırsat hesapları, fiyat geçmişi, altın fiyatı ve son gerçek satış verileri.
- **QTY:** son 7 gün içindeki gerçekleşmiş satışların toplam işlem adedi; açık emirleri saymaz.
- **Piyasa değeri:** son 7 günün işlem hacmi-ağırlıklı ortalaması ve trend göstergeleri.
- **Flip satış verisi:** Normal Flip satırları, hedef şehirde taze 7 günlük satış ortalaması yoksa gizlenir; geçmiş henüz yüklenirken veya API hatası olduğunda satırlar korunur ve filtreler veri geldikçe yeniden uygulanır. UCUZ/BUY mantığı değişmez.
- **Hesap, Defter ve Emir** sekmeleri; favoriler, alarmlar, profiller ve yedekleme.
- **Fırsat tipi:** Flip (yalnızca normal flip satırları), UCUZ liste (piyasa değerinin belirgin altında listelenmiş itemler) ve BUY pazarı (ortalama satış değerinin belirgin altında listelenmiş item bulur; satış güncel buy emrine anlık ya da ort. değerde satış emriyle olur) satırları; `Flip` yalnızca normal flipleri, `both` tüm tipleri gösterir; eşiği ve tipi panelden seç, tabloda rozet ve CSV'de `tip,indirim_pct` sütunu ile görünür.

## Güncel dosya sürümleri

Sürüm numaraları `index.html` içindeki cache-buster değerleriyle eşleşir:

| Dosya | `index.html` referansı | Amaç |
|---|---|---|
| `app.js` | `?v=15` | Ürün detayları, API ve grafikler |
| `scanner.js` | `?v=31` | Tarama, filtreler ve fırsat analizi |
| `data/scan-list.js` | `?v=4` | Tarayıcının ürün listesi |
| `styles.css` | `?v=26` | Arayüz stilleri |

> `scanner.js` içindeki kaynak yorumları özellik değişikliklerini belirtir; tarayıcının yüklediği sürüm ve cache-buster `index.html` içindeki `?v=31` değeridir.

## Yayınlama

`deploy.ps1`, proje kökünden GitHub Pages yayınını yapar. Yayın deposuna kopyalanan dosyalar:

- `index.html`
- `app.js`
- `scanner.js`
- `styles.css`
- `README.md`
- `data/scan-list.js`

Dağıtım betiği kopyalanan her dosyanın SHA-256 değerini kaynakla doğrular. Betiği çalıştırmak için Git ve GitHub CLI (`gh`) kurulu ve kimlik doğrulaması yapılmış olmalıdır. Yayın hedefi `https://barisdralabeen-glitch.github.io/albion-dashboard/` adresidir. README dosyası site içeriği üretmez; proje ve yayınlama bilgilerini açıklar.

## Önemli notlar

- QTY, AODP'nin son 7 günlük geçmiş işlem verisinden hesaplanır; veri kaydı yoksa miktar sıfır veya eksik görünebilir.
- Veriler topluluk tarafından AODP'ye yüklenir; bazı ürünlerde güncel veri bulunmayabilir.
- Bu araç Sandbox Interactive GmbH ile bağlantılı değildir.
Flip modu yalnizca normal flip satirlarini gosterir. Yerel 7g islem ortalamasi yoksa genel ortalama ve katkida bulunan sehirler tooltipte belirtilir; item hover tooltipinde tum sehirlerin min sell / max buy fiyatlari bulunur.
