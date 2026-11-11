/* Albion Tarayıcı — tüm ürünleri tüm şehirlerde tarayan kârlılık motoru */
"use strict";

const SCAN_CHUNK = 180;
const SCAN_CONC = 3;

/* Grup sınıflandırma: item-id'ye göre */
const SCAN_GROUPS = [
  ["Kaynak",        /_(ORE|WOOD|FIBER|HIDE|STONE)(@|$)/],
  ["İşlenmiş",      /_(METALBAR|PLANKS|LEATHER|CLOTH|BRICK)(@|$)/],
  ["Silah",         /_(MAINHAND|2H|OFF)_/],
  ["Zırh",          /_(HEAD|ARMOR|SHOES)_/],
  ["Çanta&Pelerin", /_(BAG|CAPE)(@|$)/],
  ["Mount",         /(HORSE|OX|MOUNT)/],
  ["İksir&Yemek",   /(POTION|MEAL|WINE|FOOD|STEW)/],
  ["Günlük",        /JOURNAL/],
  ["Balık&Hasat",   /(FISH|FARM|SEED)/],
  ["Kitap",         /SKILLBOOK/],
  ["Diğer",         /[\s\S]*/],
];

const scanState = {
  running: false,
  abort: false,
  list: [],        /* {i, n, g} */
  itemNames: {},
  done: 0,
  flips: [],       /* tüm fırsatlar */
  filtered: [],
  errors: 0,
  startedAt: 0,
  minNet: 50000,
  minPct: 5,
  depart: "",
  sort: "net",
  favOnly: false,
};

/* ---------- v21: favoriler + fiyat alarmı + buy order analizi verisi ---------- */
let FAVORITES = (() => { try { return JSON.parse(localStorage.getItem("albionFavorites") || "[]"); } catch (e) { return []; } })();
function saveFavorites() {
  try { localStorage.setItem("albionFavorites", JSON.stringify(FAVORITES.slice(0, 200))); } catch (e) { /* kota */ }
}
function isFav(id, q) {
  const nq = Number(q) || 1;
  return FAVORITES.some(f => f.id === id && (Number(f.q) || 1) === nq);
}
/* Buy Order analizi ham satırları: id|q|city → {sm: satış min, bm: buy order max}
   Tarama sırasında dolar; Emir sekmesi bundan hesaplar. (AODP canlı emir derinliği
   vermez; hacim 7g gerçek işlem adetidir — qtyCache'ten gelir.) */
let BO_RAW = new Map();

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function classify(id) {
  for (const [g, re] of SCAN_GROUPS) if (re.test(id)) return g;
  return "Diğer";
}

/* ---------- İnsanca yakın ürün adı ----------
   Önce tam kod yoluyla listede arar; yoksa "@n" kuyruğunu soyup
   taban adı + Romen ench seviyesiyle döner (T5_2H_BOW_AVALON@4 ->
   "Avalonian Bow IV").                                       */
const ROMAN = ["", "I", "II", "III", "IV", "V"];
function itemNameResolve(id) {
  const names = scanState.itemNames || {};
  if (names[id]) return names[id];
  const m = String(id).match(/^(.*?)@(\d+)$/);
  if (m) {
    const base = names[m[1]] || m[1].replace(/_/g, " ");
    const lvl = Number(m[2]);
    return base + " " + (ROMAN[lvl] || "E" + m[2]);
  }
  return (names[id] || names[id.replace(/@\d+$/, "")]) || id.replace(/_/g, " ");
}
window.itemNameResolve = itemNameResolve;

/* ---------- Başlatma ---------- */
async function scannerInit() {
  scanState.groups = Object.fromEntries(SCAN_GROUPS.map(([g]) => [g, false]));
  ["Kaynak", "İşlenmiş", "Silah", "Zırh", "Çanta&Pelerin"].forEach(g => scanState.groups[g] = true);
  const base = (window.SCAN_LIST) ? null : location.pathname.replace(/[^/]*$/, "");
  let raw;
  if (window.SCAN_LIST) {
    raw = SCAN_LIST;
  } else {
    raw = await fetchJSON(base + "data/scan-list.json");
  }
  scanState.list = raw.map(x => ({ i: x.i, n: x.n || x.i, g: classify(x.i) }));
  scanState.itemNames = Object.fromEntries(scanState.list.map(x => [x.i, x.n]));
  renderChips();
  renderScanPrefs();
  loadCachedScan();
  if (scanState.flips.length) warmCache();
}

function loadCachedScan() {
  try {
    const c = JSON.parse(localStorage.getItem("scanResult") || "null");
    if (c && c.flips && c.flips.length) {
      scanState.flips = c.flips.map(f => ({
        ...f,
        age: (f.age && typeof f.age === "string") ? new Date(f.age) : f.age,
        sellAge: (f.sellAge && typeof f.sellAge === "string") ? new Date(f.sellAge)
               : (f.age && typeof f.age === "string") ? new Date(f.age) : f.age,
        // eski kayıtlarda kod adabı: kod görünüyorsa okunaklı ada çevir
      }));
      if (scanState.flips.some(f => !f.name || f.name.includes("_"))) {
        scanState.flips = scanState.flips.map(f => ({ ...f, name: itemNameResolve(f.id) }));
      }
      scanState.loadedAt = c.at;
      applyFilters();
      $("scanInfo").textContent = `Son tarama ${fmtDate(new Date(c.at), true)} — yeniden tarama daha güncel veri getirir.`;
    }
  } catch (e) { /* boş */ }
}

/* ---------- UI ---------- */
/* albionanalyser'ın category-grid tarzında kategori listesi (checkbox + sayı) */
/* tarama sürerken grup değişince tek seferde yeniden başlatma (hızlı tıklamalarda debounce) */
let grpRestartT = null;
let grpWaitT = null;   /* v26: grup bekleme interval'i modül seviyesinde — yetim interval sızıntısı yok */
function grpRestartScan() {
  if (grpRestartT) clearTimeout(grpRestartT);
  grpRestartT = setTimeout(() => {
    grpRestartT = null;
    /* v26: otomatik tarama bayrağını stopScan'den ÖNCE yakala —
       restart taraması auto moddaysa (autoNext ile) bildirimli sürsün */
    if (scanState.running) { scanState.autoNext = scanState.auto; stopScan(); }
    if (grpWaitT) clearInterval(grpWaitT);
    grpWaitT = setInterval(() => {
      if (!scanState.running) {
        clearInterval(grpWaitT); grpWaitT = null;
        if (typeof startScan === "function") startScan({ auto: !!scanState.autoNext });
        scanState.autoNext = false;
      }
    }, 250);
  }, 700);
}
function renderChips() {
  const counts = {};
  scanState.list.forEach(x => counts[x.g] = (counts[x.g] || 0) + 1);
  $("scanChips").innerHTML = SCAN_GROUPS.map(([g]) => {
    const on = scanState.groups[g];
    return `<label><input type="checkbox"${on ? " checked" : ""} data-grp="${esc(g)}"><span>${esc(g)}</span><span class="cat-count">(${counts[g] || 0})</span></label>`;
  }).join("");
  $("scanChips").querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener("change", () => {
      scanState.groups[cb.dataset.grp] = cb.checked;
      if (scanState.running) {
        /* v25: tarama sürerken de grup değiştirilebilir — tarama yeni seçimle yeniden başlar */
        if ($("scanInfo")) $("scanInfo").textContent = "Gruplar değişti — tarama yeni seçimle yeniden başlıyor…";
        grpRestartScan();
      }
    });
  });
}

function renderScanPrefs() {
  const tierOpts = Array.from({ length: 8 }, (_, k) => `<option value="${k + 1}">T${k + 1}</option>`).join("");
  $("scanTierMin").innerHTML = tierOpts;
  $("scanTierMax").innerHTML = tierOpts;
  $("scanTierMin").value = 4;
  $("scanTierMax").value = 8;
  $("scanCity").innerHTML = `<option value="">Herhangi bir şehirden</option>` + ROYAL.map(c => `<option>${c}</option>`).join("");
  $("scanDest").innerHTML = `<option value="">Tüm şehirlere</option>` + ROYAL.map(c => `<option>${c}</option>`).join("") + `<option>Black Market</option>`;
  $("scanSort").innerHTML = `<option value="net">Net kâra göre</option><option value="pct">Yüzdeye göre</option>`;
  $("scanQualityAll").innerHTML = `<option value="1">Kalite 1</option><option value="all">Tüm kaliteler (1-5)</option>`;
  $("minNet").value = scanState.minNet;
  $("minPct").value = scanState.minPct;
}

/* ---------- Tarama ---------- */
function selectedIds() {
  const tmin = Number($("scanTierMin").value), tmax = Number($("scanTierMax").value);
  return scanState.list.filter(x => scanState.groups[x.g]).filter(x => {
    const m = x.i.match(/^T(\d)/);
    return m && Number(m[1]) >= tmin && Number(m[1]) <= tmax;
  }).map(x => x.i);
}

function setProgress(done, total, elapsedMs) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  document.querySelector(".prog").classList.remove("hidden");
  $("scanProgText").style.display = "";
  $("scanBarFill").style.width = pct + "%";
  $("scanProgText").textContent = `${pct}% · ${fmt(done)}/${fmt(total)} ürün · ${(elapsedMs / 1000).toFixed(1)} sn`;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function startScan(opts = {}) {
  if (scanState.running) return;
  scanState.auto = !!opts.auto;
  const ids = selectedIds();
  scanState.minNet = Number($("minNet").value) || 0;
  scanState.minPct = Number($("minPct").value) || 0;
  if (!ids.length) { $("scanInfo").textContent = "En az bir ürün grubu seç."; return; }

  scanState.running = true;
  scanState.abort = false;
  scanState.errors = 0;
  scanState.done = 0;
  scanState.flips = [];
  BO_RAW = new Map();   /* yeni tarama = taze ham veri */
  scanState.startedAt = performance.now();

  $("scanBtn").classList.add("hidden");
  $("stopBtn").classList.remove("hidden");
  $("scanInfo").textContent = "Tarama sürüyor — sonuçlar canlı dolacak…";

  const batches = chunk(ids, SCAN_CHUNK);
  let cursor = 0;
  const worker = async () => {
    while (cursor < batches.length && !scanState.abort) {
      const batch = batches[cursor++];
      try {
        /* BM her zaman taramada (kullanıcının ana stratejisi: ucuz liste → BM anlık satış) */
        const scanCities = ROYAL.concat(["Black Market"]);
        const url = `${API}/prices/${batch.join(",")}?locations=${encodeURIComponent(scanCities.join(","))}&qualities=${$("scanQualityAll").value === "all" ? "1,2,3,4,5" : "1"}`;
        const rows = await fetchJSON429(url);
        absorbRows(rows);
      } catch (e) {
        scanState.errors++;
      }
      scanState.done += batch.length;
      setProgress(scanState.done, ids.length, performance.now() - scanState.startedAt);
      applyFilters();
    }
  };
  await runPool(worker, SCAN_CONC);

  scanState.running = false;
  $("scanBtn").classList.remove("hidden");
  $("stopBtn").classList.add("hidden");
  const secsn = ((performance.now() - scanState.startedAt) / 1000).toFixed(1);
  if (scanState.abort) {
    $("scanInfo").textContent = `Tarama durduruldu · ${fmt(scanState.done)} ürün tarandı · ${scanState.errors} hata`;
  } else {
    $("scanInfo").textContent = `Tarama bitti · ${fmt(ids.length)} ürün · ${fmt(Math.min(scanState.filtered.length, 999))} kârlı satır · ${scanState.errors} hata · ${secsn} sn`;
  }
  scanState.loadedAt = Date.now();
  /* v26: abort (durdur) sonrası kısmi sonuç cache'e yazılmaz — bayat/kırpık sonuç ezmesin */
  if (!scanState.abort) {
    try {
      localStorage.setItem("scanResult", JSON.stringify({ at: Date.now(), flips: scanState.flips.slice(0, 900) }));
    } catch (e) { /* kota aşımı */ }
  }
  warmCache();
  if (scanState.auto) notifyNewFlips();
  checkFavoriteAlerts();
}

/* basit eşzamanlı işçi havuzu */
async function runPool(worker, size) {
  await Promise.all(Array.from({ length: size }, worker));
}

function stopScan() { scanState.abort = true; }

/* API satırlarını fırsatlara çevir */
function absorbRows(rows) {
  /* Buy Order analizi için ham satırları da sakla (kalite filtresine tabi) */
  const qualAll = $("scanQualityAll").value === "all";
  rows.forEach(r => {
    if (r.quality !== 1 && !qualAll) return;
    BO_RAW.set(r.item_id + "|" + r.quality + "|" + r.city, {
      id: r.item_id, q: r.quality, city: r.city,
      sm: r.sell_price_min || 0, bm: r.buy_price_max || 0,
    });
  });
  const byKey = new Map();
  rows.forEach(r => {
    if (r.quality !== 1 && $("scanQualityAll").value !== "all") return;
    const key = r.item_id + "|" + r.quality;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  });
  const t1 = 1 - state.salesTax / 100;
  const t2 = 1 - (state.salesTax + state.setupFee) / 100;
  const newly = [];
  byKey.forEach((rs, key) => {
    const [id, q] = key.split("|");
    const sellers = rs.filter(r => r.sell_price_min > 0).sort((a, b) => a.sell_price_min - b.sell_price_min);
    const buyers = rs.filter(r => r.buy_price_max > 0).sort((a, b) => b.buy_price_max - a.buy_price_max);
    if (!sellers.length) return;
    const buy = sellers[0];
    if (!buy || buy.sell_price_min <= 0) return;

    /* Anlık satış: Black Market DAHİL tüm şehirlerde — hedefin en yüksek
       buy order'ına (anında alıcı) satabilirsin. BM kendisi buy order kurar
       ve senin emrini anında alır; bu yüzden BM'de "satış emri kur ve bekle"
       yolu yerine bu yol kullanılır. Kullanıcının ana stratejisi:
       "herhangi bir şehirde ucuza listelenmiş + BM pahalı alıyor" fırsatı. */
    const allMode = !!$("scanAll")?.checked;
    const bmRow = rs.find(r => r.city === "Black Market" && r.buy_price_max > 0);
    const bm = bmRow ? bmRow.buy_price_max : 0;
    const cand = [];
    for (const r of buyers) {
      if (r.city === buy.city) continue;
      const net = r.buy_price_max * t1 - buy.sell_price_min;
      cand.push({ r, net });
    }
    cand.sort((a, b) => b.net - a.net);
    const picked = cand.filter(o => o.net > 0).slice(0, 3);
    /* BM fırsat satırı: BM başka şehri geçmese (veya ilk 3'e girmese) bile,
       BM alışı (vergi sonrası) liste fiyatını geçiyorsa ayrıca yaz */
    const bmPick = cand.find(o => o.r.city === "Black Market");
    const bmNet = bmPick ? bmPick.net : (bm ? bm * t1 - buy.sell_price_min : -1e18);
    if (bmRow && buy.city !== "Black Market" && !picked.some(o => o.r.city === "Black Market") && (allMode || bmNet > 0)) {
      picked.push({ r: bmRow, net: bmNet });
    }
    /* Bütün itemleri göster: en yüksek buy order şehri net eksi bile olsa satır koy */
    if (allMode && cand.length && cand[0].net <= 0 && !picked.some(o => o.r === cand[0].r)) {
      picked.push(cand[0]);
    }
    picked.sort((a, b) => b.net - a.net);
    newly.push(...picked.map(o => mkFlip(id, q, buy, o.r, "Emir→Emir", o.net, bm)));
    /* "Satış emri kur ve bekle" yolu: BM hariç (BM'de sell_price_min anlamsız) */
    for (const r of sellers) {
      if (r.city === buy.city || r.city === "Black Market" || r.sell_price_min <= buy.sell_price_min) continue;
      const net = r.sell_price_min * t2 - buy.sell_price_min;
      if (net > 0) newly.push(mkFlip(id, q, buy, r, "Emir→SatEmri", net, bm));
      break;
    }
  });
  if (!newly.length) return;
  scanState.flips = scanState.flips.concat(newly).sort((a, b) => b.net - a.net).slice(0, 3000);
}

function mkFlip(id, q, buy, sellRow, kindToken, net, bmExtra) {
  const kind = kindToken === "Emir→Emir" ? "Emir → Emir" : "Emir → Satış emri";
  const sellDate = kindToken === "Emir→Emir" ? sellRow.buy_price_max_date : sellRow.sell_price_min_date;
  const buyDate = buy.sell_price_min_date;
  const isDate = d => d && !d.startsWith("0001");
  const dates = [buyDate, sellDate]
    .filter(isDate)
    .map(pareDate)
    .filter(d => !isNaN(d.getTime()));
  const newest = dates.length ? new Date(Math.max(...dates.map(d => d.getTime()))) : null;
  const t1 = 1 - state.salesTax / 100;
  const t2 = 1 - (state.salesTax + state.setupFee) / 100;
  const grossSell = kindToken === "Emir→Emir" ? sellRow.buy_price_max : sellRow.sell_price_min;
  return {
    id, q: Number(q),
    name: itemNameResolve(id),
    kind,
    buyCity: buy.city, buyPrice: buy.sell_price_min,
    sellCity: sellRow.city, sellPrice: grossSell,
    net, pct: (net / buy.sell_price_min) * 100,
    /* Black Market alış emri (BM'in ödediği üst fiyat) — her satırda görünür */
    bm: Number(bmExtra) > 0 ? Number(bmExtra) : 0,
    tax: Math.abs((kindToken === "Emir→Emir" ? t1 : t2) * grossSell - grossSell),
    age: newest,
    /* Kritik: satış ayağının kendi veri yaşı — 80M gibi bayat emirleri buradan yakalarız */
    sellAge: isDate(sellDate) ? pareDate(sellDate) : null,
    buyAge: isDate(buyDate) ? pareDate(buyDate) : null,
  };
}

/* VERİ hücresi: yaşa göre renkli (yeşil ≤1 sa, sarı ≤6 sa, kırmızı >6 sa) */
function cellAge(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return `<span class="muted">—</span>`;
  const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  const text = mins < 60 ? mins + " dk" : mins < 1440 ? Math.floor(mins / 60) + " sa" : Math.floor(mins / 1440) + " g";
  const cls = mins <= 60 ? "age-fresh" : mins <= 360 ? "age-soft" : "age-old";
  const icon = mins <= 60 ? "●" : mins <= 360 ? "◐" : "○";
  return `<span class="${cls}">${icon} ${text}</span>`;
}

/* ---------- Quantity: son 7 günde hedef şehirde gerçekten satılan adet ---------- */
/* AODP, emir derinliğini (asılı emrin kalan adedini) vermiyor; oyunun market
   ekranında gördüğün "quantity" bilgisine en yakın dürüst ölçü geçmiş işlemler. */
let QTY = (() => { try { return JSON.parse(localStorage.getItem("qtyCache") || "{}"); } catch (e) { return {}; } })();
const QLOC = { 1002: "Caerleon", 2001: "Fort Sterling", 2002: "Lymhurst", 2003: "Martlock", 2004: "Bridgewatch", 2005: "Thetford", 3005: "Black Market" };

function qtyKey(city, q, id) { return `${city}|${q}|${id}`; }
function qtyFresh(key) {
  const v = QTY[key];
  if (!v || !v.at || !Number.isFinite(v.qty)) return null;
  const age = Date.now() - v.at;
  if (v.qty < 0) return age < 10 * 60 * 1000 ? v.qty : null;   /* -1 = "veri yok" (API hatası): 10 dk taze say, sonra tekrar dene */
  return age < 6 * 3600 * 1000 ? v.qty : null;
}
function saveQtyCache() {
  /* kota koruması: en yeni 600 kayıt kalsın */
  const keys = Object.keys(QTY);
  if (keys.length > 600) {
    keys.sort((a, b) => (QTY[a].at || 0) - (QTY[b].at || 0));
    keys.slice(0, keys.length - 600).forEach(k => delete QTY[k]);
  }
  try { localStorage.setItem("qtyCache", JSON.stringify(QTY)); } catch (e) { /* yoksay */ }
}
/* Piyasa değeri (market value): son 7 günün işlem ortalaması, item + kalite + şehir bazında */
let MVA = (() => { try { return JSON.parse(localStorage.getItem("mvCache") || "{}"); } catch (e) { return {}; } })();
function mvFresh(key) {
  const v = MVA[key];
  return v && v.at && (Date.now() - v.at < 6 * 3600 * 1000) && Number.isFinite(v.mv) ? v.mv : null;
}
function saveMvCache() {
  const keys = Object.keys(MVA);
  if (keys.length > 600) {
    keys.sort((a, b) => (MVA[a].at || 0) - (MVA[b].at || 0));
    keys.slice(0, keys.length - 600).forEach(k => delete MVA[k]);
  }
  try { localStorage.setItem("mvCache", JSON.stringify(MVA)); } catch (e) { /* yoksay */ }
}
async function fetchQty(city, q, id) {
  const key = qtyKey(city, q, id);
  const cachedQty = qtyFresh(key);
  const cachedMv = mvFresh(key);
  if (cachedQty !== null && cachedMv !== null) return { qty: cachedQty, mv: cachedMv };
  try {
    const data = await fetchJSON429(`${API}/history/${encodeURIComponent(id)}?locations=${encodeURIComponent(city)}&qualities=${Number(q)}&time-scale=24`);
    const entry = (data || []).find(e => (QLOC[Number(e.location)] || String(e.location ?? "")) === city && Number(e.quality) === Number(q));
    const days = entry ? (entry.data || []).filter(d => d.item_count > 0) : [];
    days.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    /* son 7 günün toplam işlem hacmi (order depth verisi olmadığı için en dürüst "kaç alınabilir" ölçüsü) */
    const qty = days.slice(-7).reduce((n, d) => n + d.item_count, 0);
    /* Piyasa değeri: son 7 günün adet-ağırlıklı ortalaması */
    const r7 = days.slice(-7);
    const wsum = r7.reduce((n, d) => n + d.item_count, 0);
    const mv = wsum > 0 ? r7.reduce((n, d) => n + d.item_count * d.avg_price, 0) / wsum : 0;
    const at = Date.now();
    QTY[key] = { qty, at };
    MVA[key] = { mv, at, ser: r7.map(d => d.avg_price) };
    saveQtyCache();
    saveMvCache();
    return { qty, mv };
  } catch (e) {
    QTY[key] = { qty: -1, at: Date.now() }; /* negatif = "veri yok", tekrar deneme kalması */
    saveQtyCache();
    return { qty: null, mv: null };
  }
}
async function fillQuantities() {
  const els = document.querySelectorAll("#scanRows [data-qtykey]");
  if (!els.length) return;
  const keys = [];
  els.forEach(el => { const k = el.dataset.qtykey; if (k && !keys.includes(k)) keys.push(k); });
  let queue = keys.filter(k => qtyFresh(k) === null);
  const WRK = 2;
  const worker = async () => {
    while (queue.length) {
      const key = queue.shift();
      const parts = key.split("|");
      const city = parts[0], q = parts[1], id = parts.slice(2).join("|");
      const r = await fetchQty(city, q, id);
      updateQtySlots(key, r.qty);
      updateMvSlots(key, r.mv);
      updateRealSlots(key);
    }
  };
  await Promise.all(Array.from({ length: WRK }, worker));
}
function qtyCellHTML(qty) {
  if (qty === null || qty === undefined) return `<span class="muted">—</span>`;
  if (qty < 0) return `<span class="muted small" title="Veri çekilemedi (API hatası) — 10 dk sonra yeniden denenir">—</span>`;   /* -1 sentineli "işlem yok" sanma */
  if (qty === 0) return `<span class="risk-badge risk-bad" title="Son 7 günde işlem yok — likidite yok; BM emri görse bile satamama riski yüksek">işlem yok</span>`;
  if (qty < 30) return `<span class="price profit-positive">${fmt(qty)}</span> <span class="muted small">· 7g</span> <span class="risk-badge" title="7 günde 30'dan az işlem — yavaş item, satış bekleyebilir">az likit</span>`;
  return `<span class="price profit-positive">${fmt(qty)}</span> <span class="muted small">· 7g</span>`;
}
/* item adının yanındaki qty çipi: oyun gibi ×1 / ×10 / ×100 dilimlerinde */
function qtyChipHTML(key) {
  const v = qtyFresh(key);
  if (v !== null && v < 0) return `<span class="muted">·</span>`;   /* veri yok (API hatası) — ×0 çipi basma */
  const b = v !== null ? qtyBucket(v) : null;
  if (b === null && v === null) return `<span class="qty-chip pending" data-qtykey="${key}">…</span>`;
  return `<span class="qty-chip" data-qtykey="${key}" title="Son 7 günde hedef şehirde satılan: ${fmt(v ?? 0)} adet">×${b ?? 0}</span>`;
}
/* BUY hücresi mini-gösterge: kaynak şehirde son 7 gün işlem gören adet */
function buyqtyHTML(qty) {
  if (qty === null || qty === undefined || qty <= 0) return `<span class="muted small">—</span>`;
  return `<span class="small muted" style="font-size:11px">· ${fmt(qty)}/7g</span>`;
}
function updateQtySlots(key, qty) {
  document.querySelectorAll(`td.qty-cell[data-qtykey="${key}"], span.qty-chip[data-qtykey="${key}"], span.buyqty[data-qtykey="${key}"]`).forEach(el => {
    if (el.classList.contains("qty-cell")) el.innerHTML = qtyCellHTML(qty);
    else if (el.classList.contains("buyqty")) { el.innerHTML = buyqtyHTML(qty); }
    else {
      const b = qtyBucket(qty === null || qty === undefined ? null : qty);
      el.classList.remove("pending");
      el.textContent = `×${b ?? 0}`;
      if (qty !== null && Number.isFinite(qty) && qty > 0) el.title = `Son 7 günde hedef şehirde satılan: ${fmt(qty)} adet`;
    }
  });
}

/* ---------- Market değeri hücresi: oyun içi piyasa değeri + fırsat rozetleri ---------- */
function mvCellHTMLRow(mv, buyPrice, sellPrice, trend) {
  if (mv === null || mv === undefined || !Number.isFinite(mv)) return `<span class="muted">…</span>`;
  let badges = "";
  if (typeof trend === "number" && isFinite(trend)) {
    const up = trend >= 3, dn = trend <= -3;
    const arrow = up ? "↗" : dn ? "↘" : "→";
    const cls = up ? "trend-up" : dn ? "trend-down" : "trend-flat";
    badges += ` <span class="${cls}" title="Piyasa değeri yönü: son 7 günün ilk yarısına göre değişim %${trend.toFixed(1)} — ↘ düşen fiyat: emirler bayat olabilir, dikkat"> ${arrow}</span>`;
  }
  if (mv > 0 && buyPrice > 0 && buyPrice <= mv * 0.75) {
    badges += ` <span class="mv-badge mv-undervalue" title="Liste fiyatı piyasaya göre ucuz: buy — item piyasa değerinin %${Math.round((buyPrice / mv) * 100)}'i. Ucuz listelenmiş itemi kaçırmaya gerek yok — anlık alıcı şehre taşıyabilirsin.">⚡ %${Math.round((buyPrice / mv) * 100)}</span>`;
  }
  if (mv > 0 && sellPrice > 0 && sellPrice >= mv * 1.25) {
    badges += ` <span class="mv-badge mv-premium" title="Alış emri piyasa değerinin %${Math.round((sellPrice / mv) * 100)}'i. Bu item piyasadan pahalı alıcı buluyor.">+%${Math.round((sellPrice / mv) * 100)}</span>`;
  }
  return `<span class="price">${fmtShort(mv)}</span>${badges}`;
}
function updateMvSlots(key, mv) {
  document.querySelectorAll(`td.mv-cell[data-qtykey="${key}"]`).forEach(el => {
    const buy = Number(el.dataset.buy || 0);
    const sell = Number(el.dataset.sell || 0);
    el.innerHTML = mvCellHTMLRow(mv, buy, sell, mvTrendOf(key));
  });
}

/* Başlık sıralama göstergesi (MARGIN ▼) */
function refreshSortHeader() {
  document.querySelectorAll("#scanTable thead th.sortable").forEach(th => {
    const active = th.dataset.key === (scanState.sortKey || "profit");
    th.classList.toggle("active-sort", active);
    const old = th.querySelector(".sort-arrow");
    if (old) old.remove();
    if (active) {
      const a = document.createElement("span");
      a.className = "sort-arrow";
      a.textContent = (scanState.sortDir || "desc") === "asc" ? "▲" : "▼";
      th.appendChild(a);
    }
  });
}

/* ---------- Filtre + tablo ---------- */
function applyFilters() {
  scanState.minNet = Number($("minNet").value) || 0;
  scanState.minPct = Number($("minPct").value) || 0;
  scanState.all = !!$("scanAll")?.checked;
  scanState.depart = $("scanCity").value;
  scanState.dest = $("scanDest").value;
  scanState.sort = $("scanSort").value;
  scanState.freshMs = Number($("freshWindow")?.value) || 0;
  scanState.search = ($("scanSearch")?.value || "").trim();
  scanState.tmin = Number($("scanTierMin")?.value) || 0;
  scanState.tmax = Number($("scanTierMax")?.value) || 8;
  scanState.favOnly = !!$("favOnly")?.checked;
  const mn = scanState.all ? -1e18 : scanState.minNet;   /* Bütün itemler: eşik yok */
  const mp = scanState.all ? -1e18 : scanState.minPct;
  const now = Date.now();
  const f = scanState.flips.filter(x => {
    if (x.net < mn || x.pct < mp) return false;
    if (scanState.favOnly && !isFav(x.id, x.q)) return false;
    if (scanState.depart && x.buyCity !== scanState.depart) return false;
    if (scanState.dest && x.sellCity !== scanState.dest) return false;
    if (scanState.search) {
      const qq = scanState.search.toLowerCase();
      if (!String(x.name || "").toLowerCase().includes(qq) && !String(x.id || "").toLowerCase().includes(qq)) return false;
    }
    const tm = String(x.id).match(/^T(\d)/);
    if (tm) {
      const t = Number(tm[1]);
      if (t < scanState.tmin || t > scanState.tmax) return false;
    }
    if (scanState.freshMs) {
      if (!x.sellAge || !(x.sellAge instanceof Date)) return false;
      if ((now - x.sellAge.getTime()) > scanState.freshMs * 1000) return false;
    }
    return true;
  });
  /* Sıralama: tablo başlıklarından (net/pct/buy/sell/qty/mv/updated) — tıklanan başlıkta dir ters döner */
  const key = scanState.sortKey || "profit";
  const dir = scanState.sortDir || (key === "buy" ? "asc" : key === "sell" ? "asc" : "desc");
  const valOf = x => {
    switch (key) {
      case "buy": return x.buyPrice;
      case "sell": return x.sellPrice;
      case "margin": return x.pct;
      case "score": return scoreFor(x);
      case "qty": { const v = qtyFresh(qtyKey(x.sellCity, Number(x.q) || 1, x.id)); return v === null ? -1 : v; }
      case "bm": return x.bm > 0 ? x.bm * (1 - state.salesTax / 100) - x.buyPrice : -1;
      case "mv": { const v = mvFresh(qtyKey(x.sellCity, Number(x.q) || 1, x.id)); return v === null ? -1 : v; }
      case "updated": return (x.sellAge instanceof Date && !isNaN(x.sellAge)) ? x.sellAge.getTime() : 0;
      default: return x.net;
    }
  };
  if (key === "item") {
    f.sort((a, b) => {
      const c = String(a.name || "").localeCompare(String(b.name || ""), "tr");
      return dir === "asc" ? c : -c;
    });
  } else {
    f.sort((a, b) => dir === "asc" ? valOf(a) - valOf(b) : valOf(b) - valOf(a));
  }
  scanState.filtered = f;
  renderScanRoutes();
  renderScanTable();
  refreshSortHeader();
}

function renderScanRoutes() {
  const agg = new Map();
  scanState.filtered.slice(0, 1500).forEach(x => {
    const k = x.buyCity + " → " + x.sellCity;
    const a = agg.get(k) || { city: k, sum: 0, cnt: 0, pctSum: 0, best: null };
    a.sum += x.net; a.cnt++; a.pctSum += x.pct;
    if (!a.best || x.net > a.best.net) a.best = x;
    agg.set(k, a);
  });
  const top = [...agg.values()].sort((a, b) => b.sum - a.sum).slice(0, 8);
  if (!top.length) {
    $("routesGrid").innerHTML = `<span class="muted small">Henüz rota yok — Taramayı Başlat'a bas ya da filtreleri gevşet.</span>`;
    return;
  }
  $("routesGrid").innerHTML = top.map(a => {
    const [bc, sc] = a.city.split(" → ");
    return `
    <div class="route-card item-cell">
      <div class="route-cities"><span class="city-tag city-${esc(bc.replace(/\s/g, ""))}">${esc(bc)}</span><span class="route-arrow">→</span><span class="city-tag city-${esc(sc.replace(/\s/g, ""))}">${esc(sc)}</span></div>
      <div class="route-sum profit-positive">Σ +${fmt(a.sum)}</div>
      <div class="route-count">${a.cnt} ürün · ort %${(a.pctSum / a.cnt).toFixed(0)} · en iyi: ${esc(a.best.name)}</div>
    </div>`;
  }).join("");
}

/* Kısa fiyat: albionanalyser scanner tarzı "1.2M", "389.9K" */
function fmtShort(n) {
  if (!isFinite(n)) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return fmt(n);
}
/* Satabileceğin miktarı oyunun 1/10/100 dilimlerine yuvarlar */
function qtyBucket(qty) {
  if (qty === null || qty === undefined || qty <= 0) return null;
  if (qty < 10) return Math.max(1, Math.round(qty));
  if (qty < 100) return Math.max(10, Math.floor(qty / 10) * 10);
  return Math.max(100, Math.floor(qty / 100) * 100);
}

/* ---------- "Satış emri" satırları için gerçeği fiyatlar ----------
   Liste fiyatı (ask) senin sattığın fiyat DEĞİL — rakibin listelendiği fiyat.
   Gerçekçi satış = o şehirde son 7 günte bloğa gerçekten işlem gören ortalama (history mv).
   Kaçara: Liste fiyatına satış garantisi yok; işlem yoksa risk yüksek. */
function realSellHTML(mv, ask, buy) {
  const t2 = 1 - (state.salesTax + state.setupFee) / 100;
  let top = "";
  if (mv && mv > 0) {
    top = `<span class="price">${fmtShort(mv)}</span> <span class="muted small" title="Son 7 günün gerçek işlem ortalaması — satış beyanını (sell order) bunun civarına koyman gerekir">son satış</span><br><span class="muted small" title="Şu an en düşük liste fiyatı (rakibin ask — onunla yarışman gerekir)">liste ${fmtShort(ask)}</span>`;
  } else {
    top = `<span class="muted small" title="Bu itemin işlem kaydı yok — listede fiyat garanti edilemez, risk yüksek. Anlık buy order satırını tercih et">son satış ?</span><br><span class="muted small">liste ${fmtShort(ask)}</span>`;
  }
  if (mv && mv > 0 && buy > 0) {
    const net = mv * t2 - buy;
    top += ` <span class="net-chip ${net >= 0 ? "positive" : "negative"}" title="Vergi+kuruluş (%${state.salesTax}+%${state.setupFee}) düşünce eline kalan net">${net >= 0 ? "+" : "−"}${fmtShort(Math.abs(net))}</span>`;
  }
  return top;
}
function realProfitHTML(mv, buy) {
  const t2 = 1 - (state.salesTax + state.setupFee) / 100;
  if (!(mv && mv > 0)) return `<span class="muted">?</span>`;
  const net = mv * t2 - buy;
  return `<span class="price ${net < 0 ? "profit-negative" : "profit-positive"}" title="Gerçekçi kâr: son 7 günün işlem ort (mv) üzerinden — liste farkı sonrası">${fmtShort(net)}</span>`;
}
function realMarginHTML(mv, buy) {
  const t2 = 1 - (state.salesTax + state.setupFee) / 100;
  if (!(mv && mv > 0)) return `<span class="muted">—</span>`;
  const net = mv * t2 - buy;
  const pct = (net / buy) * 100;
  const mCls = pct >= 40 ? "margin-badge margin-high" : pct >= 15 ? "margin-badge margin-medium" : pct < 0 ? "margin-badge margin-neg" : "margin-badge margin-low";
  return `<span class="${mCls}" title="Gerçekçi marjin: son satış ort (mv) üzerinden">${pct.toFixed(1)}%</span>`;
}
function updateRealSlots(key) {
  const mv = mvFresh(key);
  document.querySelectorAll(
    `td.real-sell[data-qtykey="${key}"], td.real-profit[data-qtykey="${key}"], td.real-margin[data-qtykey="${key}"]`
  ).forEach(el => {
    const buy = Number(el.dataset.buy || 0);
    const ask = Number(el.dataset.ask || 0);
    if (el.classList.contains("real-sell")) { el.innerHTML = realSellHTML(mv, ask, buy); return; }
    if (el.classList.contains("real-profit")) { el.innerHTML = realProfitHTML(mv, buy); return; }
    if (el.classList.contains("real-margin")) { el.innerHTML = realMarginHTML(mv, buy); return; }
  });
}

function renderScanTable() {
  const rows = scanState.filtered.slice(0, 400);
  $("scanCount").textContent = scanState.filtered.length > 400
    ? `${fmt(scanState.filtered.length)} fırsat · ilk 400 gösteriliyor`
    : `${fmt(scanState.filtered.length)} fırsat`;
  if (!rows.length) {
    $("scanRows").innerHTML = `<tr><td colspan="14" class="muted">Sonuç yok — daha düşük eşik dene ya da taramayı başlat.</td></tr>`;
    return;
  }
  $("scanRows").innerHTML = rows.map((x, n) => {
    const mCls = x.pct >= 40 ? "margin-badge margin-high" : x.pct >= 15 ? "margin-badge margin-medium" : x.pct < 0 ? "margin-badge margin-neg" : "margin-badge margin-low";
    const score = scoreFor(x);
    const scoreCls = score >= 70 ? "score-hi" : score >= 40 ? "score-mid" : "score-lo";
    /* item: "6.3 Claws" / alt satır "T6.3 · Good" — albionanalyser scanner düzeni */
    const m = String(x.id || "").match(/^T(\d)(?:[^@]*)@(\d+)$/);
    const tierN = m ? m[1] : (String(x.id).match(/^T(\d)/) || [])[1] || "";
    const enchN = m ? m[2] : "";
    const tp = tierPretty(x.id);
    const shortName = String(x.name || "").replace(/^T\d+\s*/, "");
    const qLabel = Number(x.q) > 1 ? ` · ${QUALITY_NAMES[Number(x.q)] || "Q" + x.q}` : "";
    const subTier = enchN ? `T${tierN}.${enchN}` : `T${tierN}`;
    const qkey = qtyKey(x.sellCity, Number(x.q) || 1, x.id);
    const bqkey = qtyKey(x.buyCity, Number(x.q) || 1, x.id);
    const qtyCol = qtyFresh(qkey) !== null ? qtyCellHTML(qtyFresh(qkey)) : `<span class="muted">…</span>`;
    const mv0 = mvFresh(qkey);
    const mvT = mvTrendOf(qkey);
    const mvCol = mv0 !== null ? mvCellHTMLRow(mv0, x.buyPrice, x.sellPrice, mvT) : `<span class="muted">…</span>`;
    const bmNet = x.bm > 0 ? x.bm * (1 - state.salesTax / 100) - x.buyPrice : null;
    const bmCol = x.bm > 0
      ? `<span class="price ${bmNet > 0 ? "profit-positive" : ""}" title="Black Market alış emri${bmNet > 0 ? ` — BM'e satsan net +${fmt(bmNet)} (şu anki hedef: ${esc(x.sellCity)})` : ""}">${fmtShort(x.bm)}${bmNet > 0 && x.sellCity !== "Black Market" ? ` <span class="bm-chip">+${fmtShort(bmNet)}</span>` : ""}</span>`
      : `<span class="muted">—</span>`;
    return `
    <tr data-id="${esc(x.id)}" data-q="${Number(x.q) || 1}" data-fkey="${esc(fkeyOf(x))}" class="scan-row">
      <td><div class="item-cell">
        <img loading="lazy" alt="" class="item-icon" src="https://render.albiononline.com/v2/item/${esc(x.id)}.png?size=32" onerror="this.style.display='none'">
        <span><span class="item-name copyname" data-copyname="${esc(shortName)}" data-copyfull="${esc(tp + ' ' + shortName)}" title="Tıkla: ismi kopyala (oyuna yapıştır) · Shift+tık: item kodu kopyalar">${tp} ${esc(shortName)}</span> ${qtyChipHTML(qkey)}<br><span class="muted small">${subTier}${qLabel}</span></span>
      </div></td>
      <td class="kind-label" title="${esc(x.kind)}">${x.kind === "Emir → Emir" ? "Anlık (BO)" : "Satış emri"}</td>
      <td><span class="city-tag city-${esc(x.buyCity.replace(/\s/g, ""))}">${esc(x.buyCity)}</span></td>
      <td><span class="city-tag city-${esc(x.sellCity.replace(/\s/g, ""))}">${esc(x.sellCity)}</span></td>
    <td class="num price">${fmtShort(x.buyPrice)} <span class="buyqty" data-qtykey="${esc(bqkey)}">${qtyFresh(bqkey) !== null ? buyqtyHTML(qtyFresh(bqkey)) : `<span class="muted small">…</span>`}</span></td>`
    + (x.kind === "Emir → Satış emri"
    ? `<td class="num price real-sell" data-qtykey="${esc(qkey)}" data-buy="${x.buyPrice}" data-ask="${x.sellPrice}">${realSellHTML(mv0, x.sellPrice, x.buyPrice)}</td>`
    + `<td class="num real-profit" data-qtykey="${esc(qkey)}" data-buy="${x.buyPrice}" data-ask="${x.sellPrice}">${realProfitHTML(mv0, x.buyPrice)}</td>`
    + `<td class="num real-margin" data-qtykey="${esc(qkey)}" data-buy="${x.buyPrice}" data-ask="${x.sellPrice}">${realMarginHTML(mv0, x.buyPrice)}</td>`
    : `<td class="num price">${fmtShort(x.sellPrice)} <span class="net-chip ${x.net >= 0 ? "positive" : "negative"}" title="Vergi (%${state.salesTax}) düşünce eline kalan net — %${state.salesTax} · satış ${fmtShort(x.sellPrice)} × ${1 - state.salesTax / 100} − alış ${fmtShort(x.buyPrice)}">${x.net >= 0 ? "+" : "−"}${fmtShort(Math.abs(x.net))}</span></td>`
    + `<td class="num price ${x.net < 0 ? "profit-negative" : "profit-positive"}">${fmtShort(x.net)}</td>`
    + `<td class="num"><span class="${mCls}">${x.pct.toFixed(1)}%</span></td>`)
    + `<td class="num score-cell"><span class="score-b ${scoreCls}" title="Fırsat skoru: likidite × trend × marj (0-100)">${score}</span></td>`
    + `<td>${cellAge(x.sellAge || x.age)}</td>
      <td class="num qty-cell" data-qtykey="${esc(qkey)}">${qtyCol}</td>
      <td class="num mv-cell" data-qtykey="${esc(qkey)}" data-buy="${x.buyPrice}" data-sell="${x.sellPrice}" title="Piyasa değeri: son 7 günün işlem ortalaması (oyun içi piyasa değeri)">${mvCol}</td>
      <td class="num bm-cell">${bmCol}</td>
      <td class="row-actions"><button type="button" class="detail-btn fav-btn${isFav(x.id, x.q) ? " faved" : ""}" title="Favori ekle/çıkar — alarm eşiğini sol panelde ayarla" data-fav="${esc(x.id)}" data-fq="${Number(x.q) || 1}">★</button> <button type="button" class="detail-btn" title="Ürün detayını aç" data-id="${esc(x.id)}" data-q="${Number(x.q) || 1}">↗</button> <button type="button" class="detail-btn ledger-add" title="Deftere ekle" data-add="${esc(fkeyOf(x))}">+</button></td>
    </tr>`;}).join("");
  /* Satır artık tıklanmaz (kopyala/yapıştır serbest) — yalnızca ↗ butonu detay açar */
  $("scanRows").querySelectorAll(".detail-btn").forEach(btn => {
    btn.addEventListener("click", ev => {
      ev.stopPropagation();
      openDetailFromScan(btn.dataset.id, btn.dataset.q);
    });
  });
  /* + butonu: satırı flip defterine ekler */
  const byKey = new Map(rows.map(x => [fkeyOf(x), x]));
  $("scanRows").querySelectorAll(".ledger-add").forEach(btn => {
    btn.addEventListener("click", ev => {
      ev.stopPropagation();
      const f = byKey.get(btn.dataset.add);
      if (!f) return;
      ledgerAdd(f);
      btn.textContent = "✓";
      btn.classList.add("done");
      setTimeout(() => { btn.textContent = "+"; btn.classList.remove("done"); }, 1200);
    });
  });
  fillQuantities(); /* quantity hücreleri arkaplanda dolar */
}

function openDetailFromScan(id, q) {
  if (!id) return;
  state.item = id;
  if (q) state.quality = String(q);
  const qSel = $("quality");
  if (qSel) qSel.value = state.quality;
  savePrefs();
  showTab("detail");
  refresh();
}

function exportCSV() {
  const head = "urun,isim,kalite,al_sehir,al_fiyat,sat_sehir,sat_fiyat,yol,net_kar,yuzde,skor,piyasa_degeri,adet_7g,bm_ali,trend";
  const lines = scanState.filtered.slice(0, 2000).map(x => {
    const xkey = qtyKey(x.sellCity, Number(x.q) || 1, x.id);
    const mv = mvFresh(xkey);
    const qty = qtyFresh(xkey);
    const trend = mvTrendOf(xkey);
    return [x.id, '"' + String(x.name).replace(/"/g, "'") + '"', x.q, x.buyCity, x.buyPrice, x.sellCity, x.sellPrice, '"' + x.kind + '"', Math.round(x.net), x.pct.toFixed(1),
      scoreFor(x),
      mv === null ? "" : Math.round(mv),
      qty === null || qty === -1 ? "" : qty,
      x.bm || 0,
      trend === null ? "" : trend.toFixed(1)
    ].join(",");
  });
  const blob = new Blob(["\ufeff" + head + "\n" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "albion-kirmiz-scan.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- Sekmeler ---------- */
function showTab(name) {
  document.querySelectorAll(".nav-item").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".sidebar").forEach(s => s.classList.toggle("hidden", s.id !== "sidebar-" + name));
  ["scanner", "detail", "calc", "ledger", "order"].forEach(n => {
    const el = $("tab-" + n);
    if (el) el.classList.toggle("hidden", n !== name);
  });
  if (name === "ledger") renderLedger();
  if (name === "calc") computeCalc();
  if (name === "order") renderBO();
}

/* ?demo=1: taramayı beklemek istemiyorsan örnek satırlarla tabloyu doldurur */
function demoSeed() {
  if (new URLSearchParams(location.search).get("demo") !== "1") return false;
  const demobm = { "T6_2H_CLAWPAIR@3": 1620000, "T8_MAIN_FIRESTAFF_KEEPER@4": 42000000, "T7_MAIN_HELM_HELL@3": 3410000, "T4_BAG": 6800, "T6_BAG@2": 81000, "T5_PLANKS": 1900, "T7_HIDE": 21500 };
  const mk = (id, q, bc, sc, bp, sp) => mkFlip(id, q, { city: bc, sell_price_min: bp, sell_price_min_date: new Date().toISOString() }, (sc === "Caerleon" || sc === "Black Market")
      ? { city: sc, buy_price_max: sp, buy_price_max_date: new Date().toISOString() }
      : { city: sc, sell_price_min: sp, sell_price_min_date: new Date().toISOString() }, (sc === "Caerleon" || sc === "Black Market") ? "Emir→Emir" : "Emir→SatEmir", Math.round(sp * (1 - state.salesTax / 100) - bp), demobm[id] || 0);
  scanState.flips = [
    mk("T6_2H_CLAWPAIR@3", 1, "Fort Sterling", "Lymhurst", 1200000, 1498864),
    mk("T8_MAIN_FIRESTAFF_KEEPER@4", 4, "Bridgewatch", "Caerleon", 40000000, 42000000),
    mk("T7_MAIN_HELM_HELL@3", 1, "Martlock", "Black Market", 2600000, 3410000),
    mk("T4_BAG", 1, "Lymhurst", "Caerleon", 3400, 6100),
    mk("T6_BAG@2", 1, "Martlock", "Caerleon", 58000, 77000),
    mk("T5_PLANKS", 1, "Thetford", "Fort Sterling", 1200, 1740),
    mk("T7_HIDE", 1, "Bridgewatch", "Martlock", 14000, 19000),
  ].filter(Boolean);
  scanState.loadedAt = Date.now();
  $("minNet").value = 0; $("minPct").value = 0;
  /* Demo için qty + piyasa değeri (gerçek oyun verisi değil, kolonları/rozetleri görmek için;
     hem QTY hem MVA seed edilmeli ki fillQuantities gerçek fetch ile ezmesin) */
  const at = Date.now();
  const demoqty = [12, 3, 0, 45, 0, 7];
  const demomv = {
    "Lymhurst|1|T6_2H_CLAWPAIR@3": 1310000,     /* sat 1500K = %114 premium alıcı */
    "Caerleon|4|T8_MAIN_FIRESTAFF_KEEPER@4": 39500000,
    "Black Market|1|T7_MAIN_HELM_HELL@3": 2500000, /* BM buy 3410K = %136 premium */
    "Caerleon|1|T4_BAG": 4600,                  /* buy 3400 = %74 → "Piyasa altı" */
    "Caerleon|1|T6_BAG@2": 65000,
    "Fort Sterling|1|T5_PLANKS": 1400,          /* buy 1200 = %86; sat 1740 = %124 */
    "Martlock|1|T7_HIDE": 16000,
  };
  const demobuy = [34, 12, 0, 60, 8, 15];
  const demoser = {
    "Lymhurst|1|T6_2H_CLAWPAIR@3": [1250000, 1280000, 1300000, 1295000, 1315000, 1330000, 1350000],
    "Caerleon|4|T8_MAIN_FIRESTAFF_KEEPER@4": [39800000, 39600000, 39700000, 39500000, 39400000, 39200000, 39100000],
    "Black Market|1|T7_MAIN_HELM_HELL@3": [2400000, 2430000, 2450000, 2460000, 2480000, 2490000, 2500000],
    "Caerleon|1|T4_BAG": [4300, 4400, 4350, 4450, 4500, 4550, 4600],
    "Caerleon|1|T6_BAG@2": [67000, 66000, 66500, 65500, 66000, 65000, 64800],
    "Fort Sterling|1|T5_PLANKS": [1350, 1360, 1380, 1390, 1395, 1400, 1400],
    "Martlock|1|T7_HIDE": [16500, 16300, 16200, 16100, 16000, 16000, 16000],
  };
  scanState.flips.forEach((x, i) => {
    QTY[qtyKey(x.sellCity, Number(x.q) || 1, x.id)] = { qty: demoqty[i % demoqty.length], at };
    QTY[qtyKey(x.buyCity, Number(x.q) || 1, x.id)] = { qty: demobuy[i % demobuy.length], at };
    const dkey = qtyKey(x.sellCity, Number(x.q) || 1, x.id);
    if (demomv[dkey]) MVA[dkey] = { mv: demomv[dkey], at, ser: demoser[dkey] };
  });
  /* Demo için buy order ham satırları: Emir sekmesinin dolması için */
  BO_RAW.set("T4_BAG|1|Caerleon", { id: "T4_BAG", q: 1, city: "Caerleon", sm: 6100, bm: 5600 });
  BO_RAW.set("T4_BAG|1|Lymhurst", { id: "T4_BAG", q: 1, city: "Lymhurst", sm: 6600, bm: 0 });
  BO_RAW.set("T5_PLANKS|1|Thetford", { id: "T5_PLANKS", q: 1, city: "Thetford", sm: 1740, bm: 1500 });
  BO_RAW.set("T5_PLANKS|1|Martlock", { id: "T5_PLANKS", q: 1, city: "Martlock", sm: 1950, bm: 0 });
  QTY["Thetford|1|T5_PLANKS"] = { qty: 55, at };
  showTab("scanner");
  applyFilters();
  return true;
}

async function scannerSetup() {
  /* URL'de ?item= varsa sayfa doğrudan Ürün Detayı ile açılır */
  const qs = new URLSearchParams(location.search);
  showTab(qs.get("item") ? "detail" : "scanner");
  window.onerror = (msg, src, line) => {
    $("scanInfo").textContent = `Hata: ${msg} (${(src || "").split("/").pop()}:${line})`;
  };
  /* Başlık sıralaması: MARGIN'e basınca yüksekten düşüğe (▼), tekrar basınca ▲ */
  document.querySelectorAll("#scanTable thead th.sortable").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.key;
      if (scanState.sortKey === k) {
        scanState.sortDir = (scanState.sortDir || "desc") === "asc" ? "desc" : "asc";
      } else {
        scanState.sortKey = k;
        scanState.sortDir = (k === "buy" || k === "sell") ? "asc" : "desc";
      }
      applyFilters();
    });
  });
  /* Otomatik filtre: seçim değişince tablo anında güncellenir (uygula butonu yok) */
  ["minNet", "minPct", "scanCity", "scanDest", "scanAll", "scanQualityAll", "freshWindow", "scanTierMin", "scanTierMax"].forEach(id => {
    $(id).addEventListener("change", () => { if (scanState.flips.length) applyFilters(); });
  });
  ["minNet", "minPct"].forEach(id => {
    $(id).addEventListener("input", () => { if (scanState.flips.length) applyFilters(); });
  });
  /* Premium vergisi seçimi: Premium %4 / Premiumsuz %8 — tablu yeniden net kârlanir (yeniden tarama gereksiz) */
  const taxSel = $("taxMode");
  if (taxSel) {
    taxSel.value = String(state.salesTax);
    taxSel.addEventListener("change", () => {
      state.salesTax = Number(taxSel.value) || 4;
      savePrefs();
      const txIn = $("salesTax");
      if (txIn) txIn.value = state.salesTax;
      if (!scanState.flips.length) return;
      const t1 = 1 - state.salesTax / 100;
      const t2 = 1 - (state.salesTax + state.setupFee) / 100;
      scanState.flips = scanState.flips.map(x => {
        const t = x.kind === "Emir → Emir" ? t1 : t2;
        const net = x.kind === "Emir → Emir"
          ? x.sellPrice * t - x.buyPrice
          : ((mvFresh(qtyKey(x.sellCity, Number(x.q) || 1, x.id)) ?? x.sellPrice) * t - x.buyPrice);
        return { ...x, net, pct: x.buyPrice ? (net / x.buyPrice) * 100 : 0 };
      }).sort((a, b) => b.net - a.net);
      applyFilters();
    });
  }
  $("scanSort").addEventListener("change", e => {
    scanState.sortKey = e.target.value === "pct" ? "margin" : "profit";
    scanState.sortDir = "desc";
    if (scanState.flips.length) applyFilters();
  });
  /* v19: arama, profil, otomatik tarama, kolonlar, hesap, defter */
  $("scanSearch")?.addEventListener("input", () => { if (scanState.flips.length) applyFilters(); });
  $("favOnly")?.addEventListener("change", () => { if (scanState.flips.length) applyFilters(); });
  /* Item ismine tıkla → panoya kopyala (oyuna yapıştırmak için); Shift+tık → item kodu.
     ★ butonu → favori ekle/çıkar (alarm sol panelde). */
  $("scanRows").addEventListener("click", ev => {
    const fav = ev.target.closest("[data-fav]");
    if (fav) {
      ev.stopPropagation();
      toggleFavorite(fav.dataset.fav, fav.dataset.fq);
      return;
    }
    const el = ev.target.closest("[data-copyname]");
    if (!el) return;
    ev.stopPropagation();
    const tr = el.closest("tr");
    copyToClipboard((ev.shiftKey && tr && tr.dataset.id) ? tr.dataset.id : (el.dataset.copyfull || el.dataset.copyname));
  });
  $("orderBody")?.addEventListener("click", ev => {
    const el = ev.target.closest("[data-copyname]");
    if (!el) return;
    copyToClipboard((ev.shiftKey && el.dataset.copyid) ? el.dataset.copyid : (el.dataset.copyfull || el.dataset.copyname));
  });
  buildColPanel();
  applyHiddenCols();
  profFillSel();
  $("profSel")?.addEventListener("change", () => {
    let all = {};
    try { all = JSON.parse(localStorage.getItem("albionProfiles") || "{}"); } catch (e) { }
    profApply(all[$("profSel").value]);
  });
  $("profSave")?.addEventListener("click", () => {
    const name = prompt("Profil adı (örn. BM hızlı):");
    if (!name) return;
    let all = {};
    try { all = JSON.parse(localStorage.getItem("albionProfiles") || "{}"); } catch (e) { }
    all[name] = profCollect();
    try { localStorage.setItem("albionProfiles", JSON.stringify(all)); } catch (e) { }
    profFillSel(name);
    $("scanInfo").textContent = "Profil kaydedildi: " + name;
  });
  $("profDel")?.addEventListener("click", () => {
    const k = $("profSel").value;
    if (!k) return;
    let all = {};
    try { all = JSON.parse(localStorage.getItem("albionProfiles") || "{}"); } catch (e) { }
    delete all[k];
    try { localStorage.setItem("albionProfiles", JSON.stringify(all)); } catch (e) { }
    profFillSel();
    $("scanInfo").textContent = "Profil silindi: " + k;
  });
  const autoCb = $("autoScan");
  if (autoCb) {
    autoCb.checked = localStorage.getItem("albionAuto") === "1";
    if (autoCb.checked) setAutoTimer();
    autoCb.addEventListener("change", () => {
      try { localStorage.setItem("albionAuto", autoCb.checked ? "1" : "0"); } catch (e) { }
      if (autoCb.checked) {
        try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch (e) { }
        setAutoTimer();
        $("scanInfo").textContent = `Otomatik tarama açık — her ${$("autoEvery").value} dk'da sessiz tarama; yeni fırsatta bildirim + kısa bip.`;
      } else if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
        $("scanInfo").textContent = "Otomatik tarama kapalı.";
      }
    });
    $("autoEvery")?.addEventListener("change", () => { if (autoCb.checked) setAutoTimer(); });
  }
  ["calcRes", "calcNeed", "calcReturn", "calcQty", "calcFee", "calcShip", "calcSell"].forEach(id => {
    $(id)?.addEventListener("input", computeCalc);
  });
  $("calcWay")?.addEventListener("change", computeCalc);
  /* Hammadde otomatik fiyat: item ara → seç → AODP'den en ucuz şehir fiyatını çek */
  $("calcItem")?.addEventListener("input", e => calcSearch(e.target.value));
  $("calcFetch")?.addEventListener("click", calcFetchPrice);
  $("calcItemInfo").textContent = "Hammadde: " + calcItemSel;
  /* Buy Order analizi filtresi */
  $("orderMinQty")?.addEventListener("input", () => renderBO());
  $("orderRefresh")?.addEventListener("click", () => renderBO(true));
  /* Yedek indir / geri yükle */
  $("backupBtn")?.addEventListener("click", backupAll);
  $("restoreBtn")?.addEventListener("click", () => $("restoreFile")?.click());
  $("restoreFile")?.addEventListener("change", ev => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { try { restoreAll(JSON.parse(String(rd.result))); } catch (e) { $("scanInfo").textContent = "Yedek okunamadı: " + e.message; } };
    rd.readAsText(f);
    ev.target.value = "";
  });
  /* Klavye kısayolları: R = tarama, / = arama kutusu, F = favori filtresi.
     Yazı alanlarında (input/textarea/select) çalışmaz — yazı yazmayı bozmaz. */
  document.addEventListener("keydown", ev => {
    const t = ev.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === "r" || ev.key === "R") { if (!scanState.running) startScan(); }
    else if (ev.key === "/") {
      ev.preventDefault();
      showTab("scanner");
      const el = $("scanSearch");
      if (el) { el.focus(); el.select(); }
    } else if (ev.key === "f" || ev.key === "F") {
      const cb = $("favOnly");
      if (cb) { cb.checked = !cb.checked; if (scanState.flips.length) applyFilters(); }
    }
  });
  renderFavPanel();
  /* Paylaş butonu: turev adresi varsa (share.json turev koruyucusu yazar) göster */
  fetch("share.json", { cache: "no-store" }).then(r => r.ok ? r.json() : null).then(s => {
    if (!s || !s.url) return;
    const btn = $("shareBtn");
    if (btn) { btn.dataset.share = s.url; btn.classList.remove("hidden"); }
  }).catch(() => { /* sunucu yoksa buton gizli kalir */ });
  /* v23: İlk açılışta boş görünmesin — kayıtlı tarama sonucu yoksa 800 ms sonra otomatik tarama */
  try {
    setTimeout(() => {
      try {
        /* scannerInit'teki loadCachedScan kaydı yüklemediyse flips boş kalır;
           localStorage'da da sonuç yoksa sayfa ilk açılışta tamamen boş demektir */
        const cached = JSON.parse(localStorage.getItem("scanResult") || "null");
        const hasCached = !!(cached && cached.flips && cached.flips.length);
        if (!hasCached && !scanState.running && scanState.flips.length === 0 && typeof startScan === "function") {
          try { startScan(); } catch (e) { /* yoksay */ }
        }
      } catch (e) { /* yoksay */ }
    }, 800);
  } catch (e) { /* yoksay */ }
  const lb = $("ledgerBody");
  if (lb) {
    lb.addEventListener("change", ev => {
      const tr = ev.target.closest("tr[data-li]");
      if (!tr) return;
      const z = LEDGER[Number(tr.dataset.li)];
      if (!z) return;
      if (ev.target.dataset.ed === "qty") z.qty = Math.max(1, Number(ev.target.value) || 1);
      if (ev.target.dataset.ed === "status") z.status = ev.target.value;
      if (ev.target.dataset.ed === "real") z.real = ev.target.value === "" ? null : Number(ev.target.value);
      ledgerSave();
      renderLedger();
    });
    lb.addEventListener("click", ev => {
      const del = ev.target.closest("[data-del]");
      if (!del) return;
      LEDGER.splice(Number(del.dataset.del), 1);
      ledgerSave();
      renderLedger();
    });
  }
  $("ledgerCsv")?.addEventListener("click", exportLedgerCSV);
  $("ledgerClear")?.addEventListener("click", () => {
    if (!LEDGER.length || confirm("Defterdeki tüm işlemler silinsin mi?")) {
      LEDGER = [];
      ledgerSave();
      renderLedger();
    }
  });
  document.querySelectorAll(".nav-item").forEach(t => t.addEventListener("click", () => showTab(t.dataset.tab)));
  const qs0 = new URLSearchParams(location.search);
  await scannerInit();
  if (!qs0.get("item")) demoSeed();
}

/* ================= v19: trend, likidite, cache isitma, otomatik tarama,
   profil, kolon gizle, flip defteri, kar hesaplayici ================= */

/* Piyasa degeri yonu: son 7 gunun ilk yarisi vs son yarisi (yuzde degisim) */
function mvTrendOf(key) {
  const v = MVA[key];
  if (!v || !Array.isArray(v.ser) || v.ser.length < 4) return null;
  const half = Math.floor(v.ser.length / 2);
  const a = v.ser.slice(0, half), b = v.ser.slice(half);
  const ma = a.reduce((s, n) => s + n, 0) / a.length;
  const mb = b.reduce((s, n) => s + n, 0) / b.length;
  if (!(ma > 0)) return null;
  return ((mb - ma) / ma) * 100;
}

/* Firsat kimligi: defter + uyarilar icin stabil anahtar */
function fkeyOf(x) {
  return `${x.id}|${Number(x.q) || 1}|${x.buyCity}|${x.sellCity}|${x.kind}`;
}

/* Cache isitma: gorunen tablonun qty/mv verisini arka planda tamamlar
   (sunucu kapisi 900 ms araliga saygili; bir isci, sira ile) */
let warming = false;
function warmCache() {
  if (warming) return;
  const keys = [];
  scanState.flips.slice(0, 100).forEach(x => {
    const k = qtyKey(x.sellCity, Number(x.q) || 1, x.id);
    if (qtyFresh(k) === null && !keys.includes(k)) keys.push(k);
    const bk = qtyKey(x.buyCity, Number(x.q) || 1, x.id);
    if (qtyFresh(bk) === null && !keys.includes(bk)) keys.push(bk);
  });
  if (!keys.length) return;
  warming = true;
  (async () => {
    for (const k of keys.slice(0, 60)) {
      const p = k.split("|");
      try {
        const r = await fetchQty(p[0], p[1], p.slice(2).join("|"));
        updateQtySlots(k, r.qty);
        updateMvSlots(k, r.mv);
        updateRealSlots(k);
      } catch (e) { /* arka plan — sessiz */ }
      await new Promise(res => setTimeout(res, 150));
    }
    warming = false;
  })();
}

/* Otomatik tarama + yeni firsat uyarisi (baslik, parlama, bip, bildirim) */
let autoTimer = null;
function setAutoTimer() {
  if (autoTimer) clearInterval(autoTimer);
  const mins = Number($("autoEvery")?.value) || 15;
  autoTimer = setInterval(() => { if (!scanState.running) startScan({ auto: true }); }, mins * 60000);
}
function notifyNewFlips() {
  const th = Math.max(scanState.minNet || 0, 100000);
  const cur = new Set(scanState.flips.filter(x => x.net >= th).slice(0, 400).map(fkeyOf));
  if (scanState.lastKeys instanceof Set) {
    const fresh = [...cur].filter(k => !scanState.lastKeys.has(k));
    if (fresh.length) {
      document.title = `🔔 ${fresh.length} yeni fırsat — Albion`;
      setTimeout(() => { document.title = "Dr aLabeen — Albion Pazar Analiz"; }, 40000);
      $("scanRows").querySelectorAll("tr[data-fkey]").forEach(tr => {
        if (fresh.includes(tr.dataset.fkey)) {
          tr.classList.add("flash-new");
          setTimeout(() => tr.classList.remove("flash-new"), 6000);
        }
      });
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = 660;
        o.connect(g);
        g.connect(ctx.destination);
        g.gain.setValueAtTime(0.12, ctx.currentTime);
        o.start();
        o.stop(ctx.currentTime + 0.18);
        setTimeout(() => { ctx.close().catch(() => { }); }, 400);
      } catch (e) { /* ses yok */ }
      try {
        if (window.Notification && Notification.permission === "granted") {
          new Notification("Albion fırsat", { body: `${fresh.length} yeni kârlı satır (≥ ${fmt(th)}) — sekmeye dön` });
        }
      } catch (e) { /* bildirim yok */ }
    }
  }
  scanState.lastKeys = cur;
}

/* Tarama profilleri: filtre setlerini kaydet/geri yukle/sil */
function profCollect() {
  return {
    city: $("scanCity").value, dest: $("scanDest").value,
    minNet: $("minNet").value, minPct: $("minPct").value,
    tmin: $("scanTierMin").value, tmax: $("scanTierMax").value,
    qual: $("scanQualityAll").value, sort: $("scanSort").value,
    fresh: $("freshWindow")?.value || "21600", tax: $("taxMode")?.value || "4",
    all: $("scanAll").checked,
    groups: { ...scanState.groups },
  };
}
function profApply(p) {
  if (!p) return;
  $("scanCity").value = p.city || "";
  $("scanDest").value = p.dest || "";
  $("minNet").value = p.minNet ?? scanState.minNet;
  $("minPct").value = p.minPct ?? scanState.minPct;
  $("scanTierMin").value = p.tmin || 4;
  $("scanTierMax").value = p.tmax || 8;
  $("scanQualityAll").value = p.qual || "1";
  $("scanSort").value = p.sort || "net";
  if ($("freshWindow")) $("freshWindow").value = p.fresh || "21600";
  if ($("taxMode")) $("taxMode").value = p.tax || "4";
  $("scanAll").checked = !!p.all;
  state.salesTax = Number(p.tax) || 4;
  const txIn = $("salesTax");
  if (txIn) txIn.value = state.salesTax;
  if (p.groups) { scanState.groups = { ...p.groups }; renderChips(); }
  applyFilters();
}
function profFillSel(sel) {
  let all = {};
  try { all = JSON.parse(localStorage.getItem("albionProfiles") || "{}"); } catch (e) { }
  const el = $("profSel");
  if (el) el.innerHTML = `<option value="">Profil seç…</option>` + Object.keys(all).map(k => `<option${k === sel ? " selected" : ""}>${esc(k)}</option>`).join("");
}

/* Kolon gizle/goster: tabloda nth-child kurallari uretilir */
const SCAN_COLS = ["Item", "Type", "Origin", "Dest", "Buy", "Sell", "Profit", "Margin", "Skor", "Updated", "Qty", "Piyasa", "BM", "↗"];
let hiddenCols = (() => { try { return JSON.parse(localStorage.getItem("albionHiddenCols") || "[]"); } catch (e) { return []; } })();
function applyHiddenCols() {
  const table = $("scanTable");
  if (!table) return;
  for (let i = 0; i < 14; i++) table.classList.toggle("hidec" + i, hiddenCols.includes(i));
}
function buildColPanel() {
  let st = $("colStyle");
  if (!st) {
    st = document.createElement("style");
    st.id = "colStyle";
    document.head.appendChild(st);
  }
  st.textContent = Array.from({ length: 14 }, (_, i) => `#scanTable.hidec${i} th:nth-child(${i + 1}),#scanTable.hidec${i} td:nth-child(${i + 1}){display:none}`).join("\n");
  const p = $("colPanel");
  if (!p) return;
  p.innerHTML = SCAN_COLS.map((t, i) => `<label class="check"><input type="checkbox" data-col="${i}"${hiddenCols.includes(i) ? "" : " checked"}> ${esc(t)}</label>`).join("");
  p.querySelectorAll("input[data-col]").forEach(cb => {
    cb.addEventListener("change", () => {
      const i = Number(cb.dataset.col);
      hiddenCols = cb.checked ? hiddenCols.filter(z => z !== i) : hiddenCols.concat([i]);
      try { localStorage.setItem("albionHiddenCols", JSON.stringify(hiddenCols)); } catch (e) { }
      applyHiddenCols();
    });
  });
  $("colBtn")?.addEventListener("click", () => p.classList.toggle("hidden"));
}

/* Flip defteri: planlanan → yapilan islemler, gercek kar/zarar */
let LEDGER = (() => { try { return JSON.parse(localStorage.getItem("albionLedger") || "[]"); } catch (e) { return []; } })();
function ledgerSave() {
  try { localStorage.setItem("albionLedger", JSON.stringify(LEDGER.slice(0, 500))); } catch (e) { }
}
function ledgerAdd(x) {
  LEDGER.unshift({
    at: Date.now(), id: x.id, name: x.name, q: Number(x.q) || 1,
    buyCity: x.buyCity, buyPrice: x.buyPrice, sellCity: x.sellCity, sellPrice: x.sellPrice,
    kind: x.kind, qty: 1, plan: Math.round(x.net), status: "Planlandı", real: null,
  });
  ledgerSave();
  const info = $("scanInfo");
  if (info) info.textContent = "Deftere eklendi: " + (x.name || x.id);
}
function ledgerStats() {
  const open = LEDGER.filter(z => z.status === "Planlandı");
  const done = LEDGER.filter(z => z.status === "Yapıldı");
  const realOf = z => (z.real === null || z.real === undefined || z.real === "") ? z.plan : Number(z.real);
  const planSum = open.reduce((n, z) => n + z.plan * (z.qty || 1), 0);
  const doneSum = done.reduce((n, z) => n + realOf(z) * (z.qty || 1), 0);
  const wins = done.filter(z => realOf(z) > 0).length;
  return { open: open.length, done: done.length, planSum, doneSum, wins };
}
function renderLedger() {
  const body = $("ledgerBody");
  if (!body) return;
  if (!LEDGER.length) {
    body.innerHTML = `<tr><td colspan="10" class="muted">Defter boş — tarama satırındaki + butonuyla işlem ekle.</td></tr>`;
  } else {
    body.innerHTML = LEDGER.map((z, i) => `
    <tr data-li="${i}">
      <td class="muted small">${fmtDate(new Date(z.at), true)}</td>
      <td><span class="item-name">${esc(z.name || z.id)}</span>${Number(z.q) > 1 ? ` <span class="muted small">Q${z.q}</span>` : ""}</td>
      <td class="muted small">${esc(z.buyCity)} → ${esc(z.sellCity)}</td>
      <td class="num"><input type="number" min="1" step="1" value="${z.qty || 1}" data-ed="qty" style="width:52px"></td>
      <td class="num">${fmtShort(z.buyPrice)}</td>
      <td class="num">${fmtShort(z.sellPrice)}</td>
      <td class="num ${z.plan >= 0 ? "profit-positive" : "profit-negative"}">${fmtShort(z.plan)}</td>
      <td><select data-ed="status">
        <option${z.status === "Planlandı" ? " selected" : ""}>Planlandı</option>
        <option${z.status === "Yapıldı" ? " selected" : ""}>Yapıldı</option>
        <option${z.status === "İptal" ? " selected" : ""}>İptal</option>
      </select></td>
      <td class="num"><input type="number" step="100" value="${z.real ?? ""}" placeholder="${z.plan}" data-ed="real" style="width:90px"></td>
      <td><button type="button" class="detail-btn" data-del="${i}" title="Defterden sil">✕</button></td>
    </tr>`).join("");
  }
  const s = ledgerStats();
  const box = $("ledgerStatsBox");
  if (box) {
    box.innerHTML = LEDGER.length
      ? `<b>${LEDGER.length}</b> işlem · planlanan Σ <b class="profit-positive">+${fmtShort(s.planSum)}</b> (${s.open} açık) · gerçekleşen Σ <b class="${s.doneSum >= 0 ? "profit-positive" : "profit-negative"}">${s.doneSum >= 0 ? "+" : "−"}${fmtShort(Math.abs(s.doneSum))}</b> (${s.done} bitti${s.done ? ` · %${Math.round((s.wins / s.done) * 100)} kazançlı` : ""})`
      : "Henüz işlem yok.";
  }
  renderLedgerChart();
}
function exportLedgerCSV() {
  const head = "tarih,item,rota,adet,alis,satis,plan_net,durum,gercek_net";
  const lines = LEDGER.map(z => [
    new Date(z.at).toISOString(),
    '"' + String(z.name || z.id).replace(/"/g, "'") + '"',
    '"' + z.buyCity + " → " + z.sellCity + '"',
    z.qty || 1, z.buyPrice, z.sellPrice, z.plan, z.status,
    z.real === null || z.real === undefined ? "" : z.real,
  ].join(","));
  const blob = new Blob(["\ufeff" + head + "\n" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "albion-flip-defteri.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* Kar hesaplayici: crafting/refining maliyeti → net kar */
function computeCalc() {
  const box = $("calcResult");
  if (!box) return;
  const res = Number($("calcRes").value) || 0;
  const need = Math.max(1, Number($("calcNeed").value) || 1);
  const ret = Math.min(60, Math.max(0, Number($("calcReturn").value) || 0)) / 100;
  const qty = Math.max(1, Number($("calcQty").value) || 1);
  const fee = Number($("calcFee").value) || 0;
  const ship = Number($("calcShip")?.value) || 0;
  const sell = Number($("calcSell").value) || 0;
  const way = $("calcWay")?.value || "bo";
  const taxPct = state.salesTax + (way === "so" ? (state.setupFee || 2.5) : 0);
  const unitRes = res * need * (1 - ret);
  const totalRes = unitRes * qty;
  const fees = fee * qty;
  const gross = sell * qty;
  const taxVal = gross * taxPct / 100;
  const cost = totalRes + fees + ship;
  const net = gross - taxVal - cost;
  const pct = cost > 0 ? (net / cost) * 100 : 0;
  const per = net / qty;
  const pos = net >= 0;
  const col = pos ? "#4ade80" : "#f87171";
  box.innerHTML = `
    <div class="calc-cards">
      <div class="kpi"><span class="kpi-val" style="color:${col}">${net >= 0 ? "+" : "−"}${fmtShort(Math.abs(net))}</span><span class="kpi-lab">Toplam net (${fmt(qty)} ürün) <span class="muted">· birim ${per >= 0 ? "+" : "−"}${fmtShort(Math.abs(per))}</span></span></div>
      <div class="kpi"><span class="kpi-val" style="color:${col}">${pct.toFixed(1)}%</span><span class="kpi-lab">Marjin <span class="muted">· kâr / maliyet</span></span></div>
      <div class="kpi"><span class="kpi-val">${fmtShort(cost)}</span><span class="kpi-lab">Toplam maliyet <span class="muted">· hammadde ${fmtShort(totalRes)} + ücret ${fmtShort(fees)}${ship > 0 ? " + nakliye " + fmtShort(ship) : ""}</span></span></div>
    </div>
    <table class="calc-break">
      <tr><td>Hammadde maliyeti (ürün başına)</td><td class="num">${fmt(unitRes)}</td></tr>
      <tr><td>Brüt satış (${fmt(qty)} × ${fmtShort(sell)})</td><td class="num">${fmtShort(gross)}</td></tr>
      ${ship > 0 ? `<tr><td>Nakliye (toplam)</td><td class="num">−${fmtShort(ship)}</td></tr>` : ""}
      <tr><td>Vergi (%${taxPct}${way === "so" ? " + kuruluş" : ""})</td><td class="num">−${fmtShort(taxVal)}</td></tr>
      <tr><td>Net (satış − vergi − maliyet)</td><td class="num" style="color:${col}">${net >= 0 ? "+" : "−"}${fmtShort(Math.abs(net))}</td></tr>
    </table>
    ${pos ? "" : `<p class="muted small" style="margin-top:8px">Negatif — bu fiyata üretim zarar. Hammadde fiyatını düşür, dönüş oranını yükselt veya satış fiyatını artır.</p>`}
  `;
}

/* Item ismi kopyalama: tabloda isme tıkla → panoya alır (oyun sohbetine yapıştırmak için).
   Panoya API yoksa gizli textarea + execCommand yedeği devreye girer. */
function copyToClipboard(text) {
  const info = $("scanInfo");
  const done = ok => { if (info) info.textContent = ok ? "📋 Kopyalandı: " + text : "Kopyalanamadı — ismi elle seçip kopyalayın"; };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => done(true)).catch(() => done(fallbackCopy(text)));
  } else {
    done(fallbackCopy(text));
  }
}
function fallbackCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

/* Paylas butonu: site linkini panoya kopyalar — Discord'a yapıştırıp arkadaşlara gönder */
function shareCopy() {
  const btn = $("shareBtn");
  const url = btn && btn.dataset.share;
  if (!url) return;
  const restore = () => { if (btn) btn.textContent = "🔗 Paylaş"; };
  const ok = () => {
    if (!btn) return;
    btn.textContent = "✓ Link kopyalandı — Discord'a yapıştır";
    setTimeout(restore, 3000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(ok).catch(() => { fallbackCopy(url); ok(); });
  } else {
    fallbackCopy(url);
    ok();
  }
}
window.shareCopy = shareCopy;

/* ================= v21: skor, favoriler + alarm, yedek, hammadde fiyatı,
   kâr grafiği, buy order analizi ================= */

/* Fırsat skoru 0-100: likidite (7g hacim, 0-40) × trend (fiyat yönü, 0-20) × marj (0-40).
   Veri yoksa nötr-düşük puan verir — gerçek veri geldikçe skoru yükselir. */
function scoreFor(x) {
  const qkey = qtyKey(x.sellCity, Number(x.q) || 1, x.id);
  const qty = qtyFresh(qkey);
  const trend = mvTrendOf(qkey);
  const marj = x.buyPrice > 0 ? (x.net / x.buyPrice) * 100 : 0;
  let lik;
  if (qty === null || qty === undefined) lik = 8;
  else if (qty < 0) lik = 0;   /* veri yok (-1) → skor bilinmiyor, düşük başlar */
  else if (qty <= 0) lik = 0;
  else lik = Math.min(40, (qty / 300) * 40);
  const tr = (typeof trend === "number" && isFinite(trend)) ? Math.max(0, Math.min(20, 10 + trend)) : 10;
  const mr = Math.max(0, Math.min(40, (marj / 100) * 40));
  return Math.round(lik + tr + mr);
}
window.scoreFor = scoreFor;

/* ---------- Favoriler + fiyat alarmı ---------- */
function toggleFavorite(id, q) {
  if (isFav(id, q)) {
    const nq = Number(q) || 1;
    FAVORITES = FAVORITES.filter(f => !(f.id === id && (Number(f.q) || 1) === nq));
  } else {
    FAVORITES.push({ id, q: Number(q) || 1, name: itemNameResolve(id), th: 0, at: Date.now() });
  }
  saveFavorites();
  renderFavPanel();
  document.querySelectorAll(`#scanRows tr[data-id="${CSS.escape(id)}"] .fav-btn`).forEach(b => {
    if ((Number(b.dataset.fq) || 1) === (Number(q) || 1)) b.classList.toggle("faved", isFav(id, q));
  });
  if (scanState.favOnly && scanState.flips.length) applyFilters();
}
function renderFavPanel() {
  const box = $("favList");
  if (!box) return;
  if (!FAVORITES.length) {
    box.innerHTML = `<span class="muted small">Favori yok — tabloda ★'a bas. Alarm eşiğini yazarsan taramalarda fiyat aşılınca bip + bildirim gelir.</span>`;
    return;
  }
  box.innerHTML = FAVORITES.map((f, i) => `
    <div class="fav-item">
      <button type="button" class="detail-btn" data-fopen="${i}" title="Ürün detayını aç">↗</button>
      <span class="fav-name" title="${esc(f.id)}">${esc(f.name || f.id)}${Number(f.q) > 1 ? ` <span class="muted small">Q${f.q}</span>` : ""}</span>
      <input type="number" min="0" step="10000" placeholder="alarm net ≥" value="${f.th || ""}" data-fth="${i}" title="Taramada bu netin üstünde fırsat varsa bip + bildirim (30 dk'da bir)">
      <button type="button" class="detail-btn" data-fdel="${i}" title="Favoriden çıkar">✕</button>
    </div>`).join("");
  box.querySelectorAll("[data-fdel]").forEach(b => b.addEventListener("click", () => {
    FAVORITES.splice(Number(b.dataset.fdel), 1);
    saveFavorites();
    renderFavPanel();
    if (scanState.flips.length) applyFilters();
  }));
  box.querySelectorAll("[data-fth]").forEach(inp => inp.addEventListener("change", () => {
    const f = FAVORITES[Number(inp.dataset.fth)];
    if (f) { f.th = Number(inp.value) || 0; saveFavorites(); }
  }));
  box.querySelectorAll("[data-fopen]").forEach(b => b.addEventListener("click", () => {
    const f = FAVORITES[Number(b.dataset.fopen)];
    if (f) openDetailFromScan(f.id, f.q);
  }));
}
let favAlerts = (() => { try { return JSON.parse(localStorage.getItem("albionFavAlerts") || "{}"); } catch (e) { return {}; } })();
function beep(freq) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = freq || 880;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    o.start();
    o.stop(ctx.currentTime + 0.22);
    setTimeout(() => { ctx.close().catch(() => { }); }, 450);
  } catch (e) { /* ses yok */ }
}
function checkFavoriteAlerts() {
  if (!FAVORITES.length) return;
  const hits = [];
  FAVORITES.forEach(f => {
    if (!(Number(f.th) > 0)) return;
    const found = scanState.flips.filter(x => x.id === f.id && (Number(x.q) || 1) === (Number(f.q) || 1) && x.net >= Number(f.th));
    if (!found.length) return;
    const key = f.id + "|" + (Number(f.q) || 1);
    const last = favAlerts[key] || 0;
    if (Date.now() - last > 30 * 60 * 1000) {   /* 30 dk dedupe: her taramada bip etmesin */
      favAlerts[key] = Date.now();
      hits.push(`${f.name || f.id}: net ≥ ${fmt(Math.max(...found.map(x => x.net)))} (${found[0].buyCity} → ${found[0].sellCity})`);
    }
  });
  if (!hits.length) return;
  try { localStorage.setItem("albionFavAlerts", JSON.stringify(favAlerts)); } catch (e) { /* kota */ }
  beep(1040);
  try { if (window.Notification && Notification.permission === "granted") new Notification("⭐ Favori alarm", { body: hits.join("\n") }); } catch (e) { /* yok */ }
  const info = $("scanInfo");
  if (info) info.textContent = "⭐ FAVORİ ALARM — " + hits.join(" · ");
  document.title = "🔔 Favori alarm — Albion";
  setTimeout(() => { document.title = "Dr aLabeen — Albion Pazar Analiz"; }, 40000);
}

/* ---------- Yedek indir / geri yükle (JSON) ---------- */
function backupAll() {
  let profiles = {}, prefs = {};
  try { profiles = JSON.parse(localStorage.getItem("albionProfiles") || "{}"); } catch (e) { }
  try { prefs = JSON.parse(localStorage.getItem("albionDash") || "{}"); } catch (e) { }
  const payload = {
    app: "albion-dashboard", v: 21, at: new Date().toISOString(),
    ledger: LEDGER,
    profiles,
    favorites: FAVORITES,
    hiddenCols,
    albionAuto: localStorage.getItem("albionAuto") || "0",
    favAlerts,
    prefs,
  };
  const blob = new Blob(["\ufeff" + JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "albion-yedek-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
  const info = $("scanInfo");
  if (info) info.textContent = "💾 Yedek indirildi (defter + favoriler + profiller + ayarlar).";
}
function restoreAll(p) {
  const info = $("scanInfo");
  if (!p || typeof p !== "object") { if (info) info.textContent = "Geçersiz yedek dosyası."; return; }
  if (Array.isArray(p.ledger)) { LEDGER = p.ledger; ledgerSave(); renderLedger(); }
  if (p.profiles && typeof p.profiles === "object") {
    try { localStorage.setItem("albionProfiles", JSON.stringify(p.profiles)); } catch (e) { }
    profFillSel();
  }
  if (Array.isArray(p.favorites)) { FAVORITES = p.favorites; saveFavorites(); renderFavPanel(); if (scanState.flips.length) applyFilters(); }
  if (Array.isArray(p.hiddenCols)) {
    hiddenCols = p.hiddenCols;
    try { localStorage.setItem("albionHiddenCols", JSON.stringify(hiddenCols)); } catch (e) { }
    applyHiddenCols();
  }
  if (typeof p.albionAuto === "string") {
    try { localStorage.setItem("albionAuto", p.albionAuto); } catch (e) { }
    const cb = $("autoScan");
    if (cb) { cb.checked = p.albionAuto === "1"; if (cb.checked) setAutoTimer(); }
  }
  if (p.favAlerts && typeof p.favAlerts === "object") { try { localStorage.setItem("albionFavAlerts", JSON.stringify(p.favAlerts)); } catch (e) { } }
  if (p.prefs && typeof p.prefs === "object") {
    Object.assign(state, p.prefs);
    savePrefs();
    const tx = $("salesTax"); if (tx) tx.value = state.salesTax;
    const tm = $("taxMode"); if (tm) tm.value = String(state.salesTax);
    const sx = $("setupFee"); if (sx) sx.value = state.setupFee;
  }
  if (info) info.textContent = "📂 Yedek geri yüklendi — defter + favoriler + profiller + ayarlar.";
}

/* ---------- Hesap sekmesi: hammadde fiyatını AODP'den çek ---------- */
let calcItemSel = localStorage.getItem("albionCalcItem") || "T4_ORE";
function calcSearch(q) {
  const box = $("calcResults");
  if (!box) return;
  const query = (q || "").trim().toLowerCase();
  if (!query) { box.classList.add("hidden"); return; }
  const hits = (typeof CATALOG !== "undefined" ? CATALOG : []).filter(c => /ORE|WOOD|FIBER|HIDE|STONE|METALBAR|PLANKS|LEATHER|CLOTH|BRICK/.test(c.id))
    .filter(c => c.name.toLowerCase().includes(query) || c.id.toLowerCase().includes(query))
    .slice(0, 30);
  box.innerHTML = hits.map(c => `<div class="sr-item" data-cid="${c.id}"><img src="https://render.albiononline.com/v2/item/${c.id}.png?size=32" alt="" onerror="this.style.visibility='hidden'"><span>${c.name}</span><span class="sr-code">${c.id}</span></div>`).join("")
    || `<div class="sr-item"><span class="muted">Sonuç yok — kod yaz (örn. T6_ORE)</span></div>`;
  box.classList.remove("hidden");
  box.querySelectorAll("[data-cid]").forEach(el => el.addEventListener("click", () => {
    calcItemSel = el.dataset.cid;
    try { localStorage.setItem("albionCalcItem", calcItemSel); } catch (e) { }
    $("calcItem").value = "";
    box.classList.add("hidden");
    $("calcItemInfo").textContent = calcItemSel + " — fiyat çekiliyor…";
    calcFetchPrice();
  }));
}
async function calcFetchPrice() {
  const btn = $("calcFetch"), info = $("calcItemInfo");
  if (!btn || !info) return;
  btn.disabled = true;
  btn.textContent = "… çekiliyor";
  try {
    const url = `${API}/prices/${encodeURIComponent(calcItemSel)}?locations=${encodeURIComponent(ROYAL.join(","))}&qualities=1`;
    const rows = await fetchJSON429(url);
    const cands = (rows || []).filter(r => r.sell_price_min > 0).sort((a, b) => a.sell_price_min - b.sell_price_min);
    if (cands.length) {
      $("calcRes").value = Math.round(cands[0].sell_price_min);
      info.textContent = `${calcItemSel} → en ucuz ${cands[0].city}: ${fmt(cands[0].sell_price_min)} (kalite 1)`;
      computeCalc();
    } else {
      info.textContent = `${calcItemSel} için satış verisi yok — elle yaz.`;
    }
  } catch (e) {
    info.textContent = "Fiyat çekilemedi: " + (e && e.message || e);
  }
  btn.disabled = false;
  btn.textContent = "🔄 Hammadde fiyatını çek";
}

/* ---------- Kâr grafiği (defter): günlük birikimli kâr ---------- */
function renderLedgerChart() {
  const el = $("ledgerChart");
  if (!el) return;
  const realOf = z => (z.real === null || z.real === undefined || z.real === "") ? z.plan : Number(z.real);
  const done = LEDGER.filter(z => z.status === "Yapıldı").slice().sort((a, b) => a.at - b.at);
  const topBox = $("ledgerTop");
  if (!done.length) {
    el.innerHTML = `<div class="muted chart-placeholder">İşlemleri "Yapıldı" işaretleyip gerçek netleri yazınca günlük birikimli kâr grafiği burada oluşur.</div>`;
    if (topBox) topBox.textContent = "";
    return;
  }
  const byDay = new Map();
  const byItem = new Map();
  done.forEach(z => {
    const v = realOf(z) * (z.qty || 1);
    const d = new Date(z.at);
    d.setHours(0, 0, 0, 0);
    byDay.set(d.getTime(), (byDay.get(d.getTime()) || 0) + v);
    const k = z.name || z.id;
    byItem.set(k, (byItem.get(k) || 0) + v);
  });
  let cum = 0;
  const data = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => { cum += v; return { t: new Date(t), price: cum, count: 0 }; });
  if (typeof lineChart === "function") lineChart("ledgerChart", data, { h: 170, unit: "gümüş (birikimli)" });
  if (topBox) {
    const top = [...byItem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    topBox.innerHTML = "En çok kazandıran: " + top.map(([n, v]) => `${esc(n)} <b class="profit-positive">+${fmtShort(v)}</b>`).join(" · ");
  }
}

/* ---------- Buy Order analizi: hangi iteme buy order kurmak mantıklı ---------- */
function buildBO() {
  const minQty = Math.max(1, Number($("orderMinQty")?.value) || 30);
  const t1 = 1 - state.salesTax / 100;
  const t2 = 1 - (state.salesTax + state.setupFee) / 100;
  const byItem = new Map();
  BO_RAW.forEach(v => {
    const k = v.id + "|" + v.q;
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k).push(v);
  });
  const out = [];
  byItem.forEach((rs, k) => {
    const at = k.lastIndexOf("|");
    const id = k.slice(0, at);
    const q = Number(k.slice(at + 1)) || 1;
    rs.forEach(v => {
      if (!(v.bm > 0)) return;                        /* buy order yoksa kuracak zemin yok */
      const qty = qtyFresh(qtyKey(v.city, q, id));    /* bu şehirde 7g'de buy'lara satılan */
      if (qty === null || qty < minQty) return;       /* hacim eşiği: emrin dolma olasılığı */
      let net = -Infinity, sellPrice = 0, how = "";
      if (v.sm > 0) {                                  /* yol A: aynı şehirde satış emri kur */
        net = v.sm * t2 - v.bm;
        sellPrice = v.sm;
        how = "sat emri (aynı şehir)";
      }
      const others = rs.filter(o => o.city !== v.city && o.bm > 0);
      if (others.length) {                             /* yol B: BM/başka şehrin anlık alıcısına sat */
        const best = others.reduce((p, c) => (c.bm > p.bm ? c : p));
        const nB = best.bm * t1 - v.bm;
        if (nB > net) { net = nB; sellPrice = best.bm; how = "anlık " + best.city + (best.city === "Black Market" ? " (BM)" : ""); }
      }
      if (!isFinite(net) || net <= 0) return;
      const pct = v.bm > 0 ? (net / v.bm) * 100 : 0;
      const qkey = qtyKey(v.city, q, id);
      const trend = mvTrendOf(qkey);
      const lik = Math.min(40, (qty / 300) * 40);
      const tr = (typeof trend === "number" && isFinite(trend)) ? Math.max(0, Math.min(20, 10 + trend)) : 10;
      const mr = Math.max(0, Math.min(40, (pct / 100) * 40));
      out.push({
        id, q, name: itemNameResolve(id), city: v.city, qty,
        kur: v.bm, sellPrice, net, pct, how,
        score: Math.round(lik + tr + mr),
      });
    });
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}
function renderBO(force) {
  const body = $("orderBody");
  if (!body) return;
  const rows = buildBO();
  const count = $("orderCount");
  if (count) count.textContent = rows.length ? `${fmt(rows.length)} kurulum · skora göre sıralı` : "";
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="8" class="muted">Uygun kurulum yok — tarama yap (analiz taramadan beslenir), hacim eşiğini düşür ya da hacim verisinin dolmasını bekle. ${BO_RAW.size ? "Hacim verisi arka planda dolar (oyuncular pazarı gezdikçe)." : "Buy order verisi henüz yok."}</td></tr>`;
    return;
  }
  const cls = s => s >= 70 ? "score-hi" : s >= 40 ? "score-mid" : "score-lo";
  body.innerHTML = rows.slice(0, 80).map(x => {
    const shortName = String(x.name || "").replace(/^T\d+\s*/, "");
    const mCls = x.pct >= 40 ? "margin-badge margin-high" : x.pct >= 15 ? "margin-badge margin-medium" : "margin-badge margin-low";
    /* v24: kopyaya tier ekleniyor (ör. "6.3 Grandmaster's Cape") */
    const tp = tierPretty(x.id);
    return `
    <tr class="scan-row">
      <td><div class="item-cell">
        <img loading="lazy" alt="" class="item-icon" src="https://render.albiononline.com/v2/item/${esc(x.id)}.png?size=32" onerror="this.style.display='none'">
        <span><span class="item-name copyname" data-copyname="${esc(shortName)}" data-copyfull="${esc(tp + ' ' + shortName)}" data-copyid="${esc(x.id)}" title="Tıkla: ismi kopyala · Shift+tık: item kodu">${esc(x.name)}</span></span>
      </div></td>
      <td><span class="city-tag city-${esc(x.city.replace(/\s/g, ""))}">${esc(x.city)}</span></td>
      <td class="num price" title="Son 7 günde bu şehirde buy order'lara satılan adet">${fmt(x.qty)} <span class="muted small">· 7g</span></td>
      <td class="num price" title="Emri bu fiyattan kur (şu anki en yüksek buy order)">${fmtShort(x.kur)}</td>
      <td class="num"><span class="price">${fmtShort(x.sellPrice)}</span> <span class="muted small">${esc(x.how)}</span></td>
      <td class="num price profit-positive">+${fmtShort(x.net)}</td>
      <td class="num"><span class="${mCls}">${x.pct.toFixed(1)}%</span></td>
      <td class="num score-cell"><span class="score-b ${cls(x.score)}" title="Skor: likidite × trend × marj">${x.score}</span></td>
    </tr>`;
  }).join("");
}
window.renderBO = renderBO;
