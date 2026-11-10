# Dr aLabeen — Albion Pazar Analiz

Albion Online **Europe** sunucusu için canlı pazar analiz paneli ve tam pazar tarayıcı — albionanalyser.com tarzı.
Veri kaynağı: **Albion Online Data Project (AODP)** ücretsiz açık API'si.

## Çevrimiçi site (kalıcı URL) 🌐

- **https://barisdralabeen-glitch.github.io/albion-dashboard/** — GitHub Pages'ta barındırılır, kurulumda arkadaşlara bunu gönder.
- Güncelleme: site değişince tek komut —
  ```powershell
  powershell -ExecutionPolicy Bypass -File deploy.ps1
  ```
  Bu betik `index.html / app.js / scanner.js / styles.css / README.md` dosyalarını `deploy/` klasörüne kopyalar, commit edip GitHub'a push eder; arkadaşlarda sayfa açıldığında güncel sürüm görünür.
- Not: `share.json`, `serve.ps1`, `watchdog.ps1` yüklenmez (bunlar yerel/tünel altyapısına aittir).

## Nasıl açılır?

**Yöntem 1 (en kolay):** `index.html` dosyasını çift tıkla. Tarayıcıda açılır, veriler otomatik yüklenir. ✅

**Yöntem 2 (yedek):** Veri bir engelle karşılaşırsa yerel sunucuyu çalıştır:

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
# sonra tarayıcıda http://127.0.0.1:8722/ adresini aç
```

## Albionanalyser.com/dashboard ters mühendisliği (2026-11-08)

Site görsel kimliği, albionanalyser.com/dashboard'ın shipped-artifact analizinden birebir alındı
(kanıtlar `_rea-albionanalyser/` klasöründe: `dashboard-flat.css` = çıkarılan 346 kural, `main.js`,
`chunk-CN5ZYI7G.dashboard.js` = Dashboard bileşen bundle'ı):

- **Tasarım token'ları (birebir)**: bg #0d1117 / #161b22 / #21262d, kart #1c2028, kenarlık #30363d,
  metin #e6edf3 / #8b949e / #6e7681, altın aksan #d4a843 → #b8922e gradyan butonlar, yeşil #3fb950,
  kırmızı #f85149, mavi #58a6ff, turuncu #d29922, profit-glow rgba(63,185,80,.15).
- **Layout**: .header (20px 32px, h1 26px altın) → .app = .left-nav (84px ikon navigasyon) +
  .sidebar (340px filtre paneli, .panel/.panel-title) + .content (24px 32px).
- **Kontrol panelleri**: kategori grid'i (.category-grid checkbox + cat-count), custom checkbox işareti,
  toggle, .btn/.btn-primary gradyan, .status-bar + .progress-bar (4px altın fill).
- **Sonuç tablosu**: .results-table-wrapper (sticky başlık, sortable, hover #d4a8430a),
  .item-cell + 34px pixelated item ikonu (render.albiononline.com), .city-tag renk paleti şehir bazlı
  (Caerleon kırmızı, Martlock mavi, Lymhurst yeşil...), .price monospace,
  .margin-badge margin-high/medium/low, tbody tr.high-profit yeşil parıltı.
- **API**: aynı AODP uçları (europe/west.albion-online-data.com/api/v2/stats/prices) — artık
  header'daki Sunucu seçicisiyle Europe / US West arası geçiş yapılıyor (?server= URL paramı da işler).
- Kopyalanmayan: logo/premium görselleri (kendi markalı kaldı); albionanalyser'ın Supabase hesap
  sistemi, Crafting Advisor ve Farming Advisor (premium) modülleri.

## Özellikler

### 🔍 Tarayıcı (Scanner) — ana özellik
Tek tıkla **tüm piyasa ürünlerini tarar** (8.700+ ürün, ao-bin-dumps oyun dump'ından) ve tüm şehirler arası en kârlı nakil (kırmız/flip) fırsatlarını sıralar:

- **Grup çipleri:** Kaynak, İşlenmiş, Silah, Zırh, Çanta&Pelerin (+ Mount, İksir&Yemek, Günlük, Balık&Hasat, Kitap, Diğer) — tıklayarak kapsam seçilir
- **Tier aralığı** (T4–T8 varsayılan), **kalite** (yalnız Q1 veya tümü), **kalkış şehri** ve **varış şehri** (Tümü + 6 şehir + Black Market) filtreleri
- **Black Market hedefi** seçeneği (Caerleon arasıları için)
- **En iyi rotalar:** Şehir çiftlerine göre toplam kâr kartları (örn. "Lymhurst → Bridgewatch Σ +6.9M")
- **Kırmız fırsat tablosu:** her satırda tıklayınca o ürünün detay sekmesi açılır — satırın kendi kalitesi (Q2/Q4 vb.) detayda otomatik seçilir
- Ürün adları okunaklıdır: `T5_2H_BOW_AVALON@4` yerine "Expert's Mistpiercer" yazılır
- Sonuçlar canlı dolar; tarama ~1–10 saniye sürer, "0 hata" ile biter
- Son tarama tarayıcı hafızasında tutulur, sayfa yenilense de saklı kalır
- **CSV indir** ile 2.000 satıra kadar dışa aktarım (Excel uyumlu)

### ⚡ Black Market anlık satışı (v11 yeniliği)
Black Market'in çalışma mantığı özel: BM kendisi buy order kurar ve oyuncunun sell emrini
**ANINDA** alır. Bu yüzden BM satışı "satış emri kur ve bekle" (sell_price_min) yoluyla
DEĞİL, BM'in **en yüksek buy order fiyatına (buy_price_max)** anlık satış olarak hesaplanır:

- Tarama artık her item için **en iyi 3 anlık-satış hedef şehrini** üretir (BM dahil);
  bunlar tabloda "Emir → Emir" satırı, TYPE kolonunda **"Anlık (BO)"** olarak gösterilir
- "Satış emri kur ve bekle" yolu ("Emir → Satış emri", TYPE: **"Satış emri"**) BM **hariç**
  tüm şehirlerde çalışır — BM'de sell_price_min anlamsız olduğundan BM bu yoldan çıkarıldı

### 🧩 "Bütün itemleri göster" modu (v11 yeniliği)
- Filtrede yeni **"Bütün itemleri göster"** onay kutusu (varsayılan **açık**): kâr eşiği
  (min net kâr / min marjin) yoksayılır; en yüksek buy order şehri net eksi bile olsa
  satır tabloda görünür
- Negatif kâr **kırmızı**, negatif marjin rozeti **kırmızı** (`margin-neg`) gösterilir —
  "zarar da olsa hedef şehirde anında bozulabilir" bilgisini kaybetmeme için

### 📊 Piyasa değeri kolonu (v11 yeniliği)
- Yeni, **sıralanabilir "Piyasa" kolonu**: son 7 günün **işlem hacmi-ağırlıklı ortalaması**
  (oyun içi piyasa değeri), `/history` uç noktasından
- `localStorage "mvCache"`: 6 saat taze, 600 kayıt kotası; `qtyCache` ile **aynı fetch'te**
  hesaplanır (ekstra ağ isteği yok)
- **Otomatik fırsat rozetleri:**
  - **"⚡ Piyasa altı %X"** (yeşil) — liste fiyatı piyasa değerinin %75'inin altındaysa
  - **"+%X premium alıcı"** (mavi) — satış (buy order) fiyatı piyasa değerinin %125'inin üstündeyse
  - Örnek senaryo: itemi 150K listelemişsin, piyasa değeri 250K ve BM 350K alışıyorsa → anlık fırsat

### 🧾 Kolon düzeni (12 kolon)
`ITEM` (tier + ad + qty çipi) | `TYPE` (Anlık BO / Satış emri) | `ORIGIN` | `DEST` |
`BUY` (en düşük liste fiyatı) | `SELL` (en yüksek anlık buy order) | `PROFIT` | `MARGIN` |
`UPDATED` | `QTY` (son 3 gün gerçek satış) | `PİYASA` (market value + rozetler) | `↗` (detay butonu)

**Sürümler:** scanner.js v21 · app.js v12 · serve.ps1 iki kuyruklu paralel yerel
sunucu (port 8722, IPAddress.Any ile LAN'da da dinler)### 📦 Ürün Detayı
- **Ürün arama:** Adla (örn. "ore", "deri", "çanta", "T6") ya da doğrudan item koduyla (örn. `T6_1H_SWORD`, Enter)
- **Şehir fiyat tablosu:** 6 kraliyet şehri (+ Black Market seçeneği): satış min–max, alış emri max, veri tazeliği
- **Kırmız (flip) bulucu:** Şehirler arası en iyi al→sat fırsatları; hem "emir→emir"
  (Black Market dâhil — BM hedefinde anlık satış, buy_price_max esas alınır) hem
  "emir→satış emri" (BM hariç) yolları, vergi sonrası net kâr
- **GERÇEK SATIŞLAR kartı (son dönem):** Tarayıcı API'sinin (*asılı emir değil, gerçekleşen işlemler*) şehir/kalite bazlı satış verisi:
  - kaç adet satıldı, ortalama satış fiyatı, son satış ne zaman/ne kadara oldu, yaklaşık ciro
  - özet: toplam adet + ciro + kaç şehir + kaç "şehir-kalite" satırı
  - %243 gibi tuhaf marjların "gerçekten satan var mı" sınavı buradan yapılır; nadir ürünlerde "işlem kaydı yok" dürüst cevaptır
- **Kalite geçişi:** Satır tıklaması, Q çipleri ve açılır menü hep aynı `setQuality` yolunu kullanır; fiyat sorgusu Q1–Q5 toplu çekilir
- **URL ile doğrudan açılış:** `index.html?item=T4_BAG&q=2` → sayfa o ürün ve kaliteyle Ürün Detayı'nda açılır
- **Ayarlanabilir vergiler:** Satış vergisi %4 ve emir kuruluş ücreti %2,5 varsayılan — değiştirilebilir
- **Fiyat geçmişi grafiği:** Saatlik / 6 saatlik / günlük çözünürlük, işlem hacmi dahil
- **Altın (GOLD) fiyat kartı:** Son 64 saatlik altın fiyatı grafiği
- Ürün, kalite ve vergi ayarları otomatik hatırlanır (localStorage)
- Sayfa 2 dakikada bir kendini sessizce yeniler

### 🚀 v19 yenilikleri (2026-11-10)
- **Trend oku:** Piyasa kolonunda son 7 günün ilk/son yarısı karşılaştırılır — ↗ yükseliş, ↘ düşüş, → yatay (±%3 bant). ↘ itemlerde alış emirleri bayat olabilir.
- **Likidite rozetleri:** QTY kolonunda "işlem yok" (kırmızı, 7g'de 0 işlem) ve "az likit" (sarı, <30 işlem) uyarısı — satamama riski işareti.
- **Tabloda ara:** ada/item koduna göre anlık süzgeç; **Kolonlar göster/gizle** paneli (13 kolon, tercih hatırlanır).
- **Tarama profilleri:** mevcut filtre setini isimle kaydet, seçimle geri yükle, sil.
- **Otomatik tarama:** 5/10/15/30 dk'da bir sessiz tarama; yeni kârlı satırda sekme başlığı 🔔 + satır parlaması + kısa bip + masaüstü bildirimi.
- **Cache ısıtma:** tarama sonrası görünür tablonun qty/piyasa verisi arka planda, kapıya saygılı hızla doldurulur.
- **Hesap sekmesi (Kâr Hesaplayıcı):** hammadde × dönüş oranı + istasyon ücreti → vergi sonrası net kâr ve marjin; Premium vergisi (%4/%8) filtredeki seçimden gelir.
- **Defter sekmesi (Flip Defteri):** tarama satırındaki **+** ile işlem eklenir; adet/durum/gerçek net düzenlenir, planlanan vs gerçekleşen kâr özeti + CSV dışa aktarım.
- **Satış trendi sparkline'ı:** Ürün Detayı'ndaki şehir satış tablosunda son 14 dönemin mini grafiği + yön yüzdesi.
- **Sunucu iki kuyruk:** statik dosyalar 8 hızlı işçiden (AODP kapısından geçmez), proxy istekleri 4 kapılı işçiden (900 ms aralık, 429'da soğuma, en fazla 8 sn bekleme) geçer — AODP yavaşlasa bile site her zaman açılır. watchdog.ps1 her 5 sn denetler; düşen sunucu ölçülen **~2 sn**'de kendiliğinden döner.

## Arkadaşlarla paylaşım (v22 eklentisi)

Site **Cloudflare tüneli** (cloudflared, ücretsiz, hesapsız) ile internete açıldı:

- Header'daki **🔗 Paylaş** butonu site linkini kopyalar — Discord'a yapıştırıp arkadaşlarına at. Tünel aktifken görünür.
- Arkadaşların siteyi **senin PC'nden yükler**: senin sürümün neyse onlarınki o. Dosyalar `no-store` + sürüm parametreli servis edildiği için **senin güncellemelerin sayfa yenilemesiyle otomatik olarak onlara gider** — hiçbir kurulum gerekmez.
- **AlbionSiteTunel** gardiyan görevi (1 dk) tünelin hep açık kalmasını sağlar; tünel her başladığında güncel adres `share.json`'a yazılır (site butonu oradan okur).
- **PC yeniden başlarsa link değişir** (Cloudflare ücretsiz quick-tunnel kuralı): yeni link için Paylaş butonuna tıkla, arkadaşlarına tekrar gönder.
- Arkadaşlar kullanırken PC'nin açık olması gerekir. Trafik Cloudflare üzerinden şifreli; proxy yalnız `*.albion-online-data.com` alan adlarını kabul eder ve kapılıdır (900 ms aralık + 429 soğuma).
- Aynı Wi-Fi'daki arkadaşlar yerelden doğrudan: `http://<PC-IP>:8722` (örn. `http://192.168.1.12:8722`).
- Sabit URL alternatifi (isteğe bağlı): ücretsiz Cloudflare hesabı + named tünel ile "trycloudflare" adresi kalıcı yapılabilir.

### 🚀 v21 yenilikleri (2026-11-10) — 9 özellik paketi
- **⭐ Favoriler + fiyat alarmı:** tablodaki ★ butonu itemi favoriye alır; sol paneldeki listede **alarm eşiği** (net ≥) yazılır. Otomatik taramalarda eşik aşılırsa **bip + masaüstü bildirimi + başlık uyarısı** gelir (30 dk dedupe). **"Sadece favoriler"** filtresi + **F** kısayolu. localStorage `albionFavorites`.
- **📈 Kâr grafiği (Defter):** "Yapıldı" işaretlenen işlemlerden **günlük birikimli kâr eğrisi** + "En çok kazandıran itemler" satırı (app.js'in lineChart'ı yeniden kullanılır).
- **💾 Yedek indir / geri yükle (Defter paneli):** defter + profiller + favoriler + kolon tercihleri + otomatik tarama + ayarlar tek **JSON** dosyasına (`albion-yedek-YYYY-MM-DD.json`); geri yükleme her şeyi yerine koyar.
- **🧮 Fırsat skoru:** yeni **sıralanabilir "Skor" kolonu** (Margin sonrası): likidite (7g hacim, 0-40) + trend (fiyat yönü, 0-20) + marj (0-40) = 0-100. Renk: ≥70 yeşil, 40-69 sarı, <40 kırmızı. CSV'ye de yazılır.
- **⚙️ Hesap sekmesi otomatik fiyat:** hammadde itemini ara/seç → **"Hammadde fiyatını çek"** AODP'den kalite-1 en ucuz şehir fiyatını birim fiyat alanına doldurur. Yeni **"Nakliye (toplam)"** alanı maliyete eklenir (tablo satırı + KPI).
- **📱 Telefon/LAN erişimi:** serve.ps1 artık **IPAddress.Any** ile tüm arabirimlerde dinler (0.0.0.0:8722); güvenlik duvarı kuralı `AlbionSite8722` hazır. Oyundayken telefondan **http://<PC-IP>:8722** açılır (örn. `http://192.168.1.12:8722`).
- **🗂️ Son gerçek satışlar (Ürün Detayı):** fiyat grafiğinin altında son 8 gerçek işlem dönemi listesi (fiyat · adet · zaman) — dürüst etiketle "seçili çözünürlükte".
- **⌨️ Klavye kısayolları:** **R** = taramayı başlat, **/** = arama kutusuna odak, **F** = favori filtresi. Yazı alanlarında çalışmaz (yazmayı bozmaz).
- **🛒 Emir sekmesi (Buy Order analizi):** yeni 5. sekme — "hangi iteme buy order kurmak mantıklı?" Taramada ham emir satırları saklanır; item+şehir bazında **7g gerçek satış hacmi ≥ eşik** (sol panelde, varsayılan 30) olan kurulumlar listelenir: Kur (buy) → Satış hedefi (aynı şehirde sat emri **veya** BM/başka şehrin anlık alıcısı — hangisi daha kârlıysa), net/adet, marjin, skor. AODP canlı emir derinliği vermez; hacim son 7 günün **gerçek işlem adetidir**.

## Önemli notlar

- Veriler topluluk tarafından yüklenir: AODP istemcisi açıkken oyuncular pazar pencerelerini gezdikçe veri güncellenir. Bir ürün "veri yok" diyorsa, oyunda o pazar frenine bakıldığında veri gelecektir.
- Bu araç Sandbox Interactive GmbH ile bağlantılı değildir.

## Dosyalar

| Dosya          | Amaç                                            |
|----------------|--------------------------------------------------|
| index.html     | Arayüz (Tarayıcı + Ürün Detayı + Hesap + Defter + Emir) |
| styles.css     | Tema (koyu Albion + altın vurgu)                |
| app.js (v12)   | Ürün detayı: API çekme, kırmız hesabı, grafikler, sparkline, son satışlar|
| scanner.js (v22)| Tarama motoru: filtreler, flip hesabı, CSV, trend/likidite, profil, defter, hesap, favoriler+alarm, skor, buy order analizi, yedek, kısayollar, paylaş |
| data/scan-list.js | 8.713 piyasa ürünü (ao-bin-dumps'tan)         |
| serve.ps1      | Opsiyonel: iki kuyruklu yerel sunucu + AODP proxy (port 8722, LAN açık) |
| watchdog.ps1   | Sunucuyu HTTP sağlık kontrolüyle her 5 sn denetler; takılı/düşen sunucuyu yeniden başlatır |
| %APPDATA%\albion-tunnel\ | Arkadaşlarla paylaşım: cloudflared.exe + turev kosucu/gardiyani + loglar |
| README.md      | Bu dosya                                        |
