/* Albion TarayÄ±cÄ± â€” tÃ¼m Ã¼rÃ¼nleri tÃ¼m ÅŸehirlerde tarayan kÃ¢rlÄ±lÄ±k motoru */
"use strict";

const SCAN_CHUNK = 180;
const SCAN_CONC = 3;

/* Grup sÄ±nÄ±flandÄ±rma: item-id'ye gÃ¶re */
const SCAN_GROUPS = [
  ["Kaynak",        /_(ORE|WOOD|FIBER|HIDE|STONE)(@|$)/],
  ["Ä°ÅŸlenmiÅŸ",      /_(METALBAR|PLANKS|LEATHER|CLOTH|BRICK)(@|$)/],
  ["Silah",         /_(MAINHAND|2H|OFF)_/],
  ["ZÄ±rh",          /_(HEAD|ARMOR|SHOES)_/],
  ["Ã‡anta&Pelerin", /_(BAG|CAPE)(@|$)/],
  ["Mount",         /(HORSE|OX|MOUNT)/],
  ["Ä°ksir&Yemek",   /(POTION|MEAL|WINE|FOOD|STEW)/],
  ["GÃ¼nlÃ¼k",        /JOURNAL/],
  ["BalÄ±k&Hasat",   /(FISH|FARM|SEED)/],
  ["Kitap",         /SKILLBOOK/],
  ["DiÄŸer",         /[\s\S]*/],
];

const scanState = {
  running: false,
  abort: false,
  list: [],        /* {i, n, g} */
  itemNames: {},
  done: 0,
  flips: [],       /* tÃ¼m fÄ±rsatlar */
  filtered: [],
  errors: 0,
  startedAt: 0,
  minNet: 50000,
  minPct: 5,
  depart: "",
  sort: "net",
  favOnly: false,
};

/* ---------- v21: favoriler + fiyat alarmÄ± + buy order analizi verisi ---------- */
let FAVORITES = (() => { try { return JSON.parse(localStorage.getItem("albionFavorites") || "[]"); } catch (e) { return []; } })();
function saveFavorites() {
  try { localStorage.setItem("albionFavorites", JSON.stringify(FAVORITES.slice(0, 200))); } catch (e) { /* kota */ }
}
function isFav(id, q) {
  const nq = Number(q) || 1;
  return FAVORITES.some(f => f.id === id && (Number(f.q) || 1) === nq);
}
/* Buy Order analizi ham satÄ±rlarÄ±: id|q|city â†’ {sm: satÄ±ÅŸ min, bm: buy order max}
   Tarama sÄ±rasÄ±nda dolar; Emir sekmesi bundan hesaplar. (AODP canlÄ± emir derinliÄŸi
   vermez; hacim 7g gerÃ§ek iÅŸlem adetidir â€” qtyCache'ten gelir.) */
let BO_RAW = new Map();

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function classify(id) {
  for (const [g, re] of SCAN_GROUPS) if (re.test(id)) return g;
  return "DiÄŸer";
}

/* ---------- Ä°nsanca yakÄ±n Ã¼rÃ¼n adÄ± ----------
   Ã–nce tam kod yoluyla listede arar; yoksa "@n" kuyruÄŸunu soyup
   taban adÄ± + Romen ench seviyesiyle dÃ¶ner (T5_2H_BOW_AVALON@4 ->
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

/* ---------- BaÅŸlatma ---------- */
async function scannerInit() {
  scanState.groups = Object.fromEntries(SCAN_GROUPS.map(([g]) => [g, false]));
  ["Kaynak", "Ä°ÅŸlenmiÅŸ", "Silah", "ZÄ±rh", "Ã‡anta&Pelerin"].forEach(g => scanState.groups[g] = true);
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
    const selectedQuality = scanQualSel();
    if (c && Array.isArray(c.flips) && c.flips.length &&
        (c.quality === "all" || (Number.isInteger(Number(c.quality)) && Number(c.quality) >= 1 && Number(c.quality) <= 5)) &&
        (c.quality === "all" || selectedQuality === null || Number(c.quality) === selectedQuality)) {
      scanState.cacheQuality = c.quality;
      scanState.flips = c.flips.map(f => ({
        ...f,
        age: (f.age && typeof f.age === "string") ? new Date(f.age) : f.age,
        sellAge: (f.sellAge && typeof f.sellAge === "string") ? new Date(f.sellAge)
               : (f.age && typeof f.age === "string") ? new Date(f.age) : f.age,
        // eski kayÄ±tlarda kod adabÄ±: kod gÃ¶rÃ¼nÃ¼yorsa okunaklÄ± ada Ã§evir
      }));
      if (scanState.flips.some(f => !f.name || f.name.includes("_"))) {
        scanState.flips = scanState.flips.map(f => ({ ...f, name: itemNameResolve(f.id) }));
      }
      if (selectedQuality !== null) scanState.flips = scanState.flips.filter(f => Number(f.q) === selectedQuality);
      scanState.loadedAt = c.at;
      applyFilters();
      $("scanInfo").textContent = `Son tarama ${fmtDate(new Date(c.at), true)} â€” yeniden tarama daha gÃ¼ncel veri getirir.`;
    } else if (c && Array.isArray(c.flips) && c.flips.length && c.quality !== "all" && selectedQuality !== null && Number(c.quality) !== selectedQuality) {
      scanState.cacheQuality = c.quality;
      $("scanInfo").textContent = `Ã–nbellek Q${c.quality}; seÃ§ili Q${selectedQuality} iÃ§in taramayÄ± baÅŸlatÄ±n.`;
    }
  } catch (e) { /* boÅŸ */ }
}

/* ---------- UI ---------- */
/* albionanalyser'Ä±n category-grid tarzÄ±nda kategori listesi (checkbox + sayÄ±) */
/* tarama sÃ¼rerken grup deÄŸiÅŸince tek seferde yeniden baÅŸlatma (hÄ±zlÄ± tÄ±klamalarda debounce) */
let grpRestartT = null;
let grpWaitT = null;   /* v26: grup bekleme interval'i modÃ¼l seviyesinde â€” yetim interval sÄ±zÄ±ntÄ±sÄ± yok */
let qualityRestartT = null;
let qualityWaitT = null;
function grpRestartScan() {
  if (grpRestartT) clearTimeout(grpRestartT);
  grpRestartT = setTimeout(() => {
    grpRestartT = null;
    /* v26: otomatik tarama bayraÄŸÄ±nÄ± stopScan'den Ã–NCE yakala â€”
       restart taramasÄ± auto moddaysa (autoNext ile) bildirimli sÃ¼rsÃ¼n */
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
function qualityRestartScan() {
  if (qualityRestartT) clearTimeout(qualityRestartT);
  qualityRestartT = setTimeout(() => {
    qualityRestartT = null;
    if (scanState.running) {
      scanState.autoNext = scanState.auto;
      stopScan();
    }
    if (qualityWaitT) clearInterval(qualityWaitT);
    qualityWaitT = setInterval(() => {
      if (!scanState.running) {
        clearInterval(qualityWaitT); qualityWaitT = null;
        startScan({ auto: !!scanState.autoNext });
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
        /* v25: tarama sÃ¼rerken de grup deÄŸiÅŸtirilebilir â€” tarama yeni seÃ§imle yeniden baÅŸlar */
        if ($("scanInfo")) $("scanInfo").textContent = "Gruplar deÄŸiÅŸti â€” tarama yeni seÃ§imle yeniden baÅŸlÄ±yorâ€¦";
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
  $("scanCity").innerHTML = `<option value="">Herhangi bir ÅŸehirden</option>` + ROYAL.map(c => `<option>${c}</option>`).join("");
  $("scanDest").innerHTML = `<option value="">TÃ¼m ÅŸehirlere</option>` + ROYAL.map(c => `<option>${c}</option>`).join("") + `<option>Black Market</option>`;
  $("scanSort").innerHTML = `<option value="net">Net kÃ¢ra gÃ¶re</option><option value="pct">YÃ¼zdeye gÃ¶re</option>`;
  /* v27: kalite seÃ§imi â€” 1-5 arasÄ± ayrÄ± ayrÄ± (sadece "1" ve "tÃ¼mÃ¼" deÄŸildi) */
  $("scanQualityAll").innerHTML = [1, 2, 3, 4, 5].map(n => `<option value="${n}">Kalite ${n} â€” ${QUALITY_NAMES[n]}</option>`).join("") + `<option value="all">TÃ¼m kaliteler (1-5)</option>`;
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
  $("scanProgText").textContent = `${pct}% Â· ${fmt(done)}/${fmt(total)} Ã¼rÃ¼n Â· ${(elapsedMs / 1000).toFixed(1)} sn`;
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
  if (!ids.length) { $("scanInfo").textContent = "En az bir Ã¼rÃ¼n grubu seÃ§."; return; }

  scanState.running = true;
  const requestedQuality = scanQualSel() ?? "all";
  scanState.abort = false;
  scanState.errors = 0;
  scanState.done = 0;
  /* Keep the last successful scope available until this scan commits. Snapshot
     before changing quality or clearing flips; failed/aborted scans restore it. */
  const previous = {
    flips: scanState.flips,
    loadedAt: scanState.loadedAt,
    resultQuality: scanState.resultQuality,
    cacheQuality: scanState.cacheQuality,
    scanQuality: scanState.scanQuality,
    boRaw: BO_RAW,
    cache: (() => {
      try { return localStorage.getItem("scanResult"); } catch (e) { return null; }
    })(),
  };
  scanState.scanBackup = previous.flips.length ? previous : null;
  scanState.scanQuality = requestedQuality;
  scanState.flips = [];
  BO_RAW = new Map();   /* yeni tarama = taze ham veri; restore if scan is aborted */
  scanState.startedAt = performance.now();

  $("scanBtn").classList.add("hidden");
  $("stopBtn").classList.remove("hidden");
  $("scanInfo").textContent = "Tarama sÃ¼rÃ¼yor â€” sonuÃ§lar canlÄ± dolacakâ€¦";

  const batches = chunk(ids, SCAN_CHUNK);
  let cursor = 0;
  const worker = async () => {
    while (cursor < batches.length && !scanState.abort) {
      const batch = batches[cursor++];
      try {
        /* BM her zaman taramada (kullanÄ±cÄ±nÄ±n ana stratejisi: ucuz liste â†’ BM anlÄ±k satÄ±ÅŸ) */
        const scanCities = ROYAL.concat(["Black Market"]);
        const qv = scanState.scanQuality;
        const url = `${API}/prices/${batch.join(",")}?locations=${encodeURIComponent(scanCities.join(","))}&qualities=${qv === "all" ? "1,2,3,4,5" : qv}`;
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
    const backup = scanState.scanBackup;
    if (backup) {
      scanState.flips = backup.flips;
      scanState.loadedAt = backup.loadedAt;
      scanState.resultQuality = backup.resultQuality;
      scanState.cacheQuality = backup.cacheQuality;
      scanState.scanQuality = backup.scanQuality;
      BO_RAW = backup.boRaw;
    } else {
      scanState.flips = [];
      scanState.loadedAt = previous.loadedAt;
      scanState.resultQuality = previous.resultQuality;
      scanState.cacheQuality = previous.cacheQuality;
      scanState.scanQuality = previous.scanQuality;
      BO_RAW = new Map();
    }
    scanState.scanBackup = null;
    /* No code in an aborted scan writes the result cache. Keep this explicit
       guard so a future cache write cannot silently replace the old scope. */
    try {
      if (previous.cache === null) localStorage.removeItem("scanResult");
      else localStorage.setItem("scanResult", previous.cache);
    } catch (e) { /* kota / private browsing */ }
    applyFilters();
    $("scanInfo").textContent = `Tarama durduruldu Â· ${fmt(scanState.done)} Ã¼rÃ¼n tarandÄ± Â· ${scanState.errors} hata`;
  } else {
    scanState.cacheQuality = scanState.scanQuality;
    scanState.resultQuality = scanState.scanQuality;
    scanState.scanBackup = null;
    $("scanInfo").textContent = `Tarama bitti Â· ${fmt(ids.length)} Ã¼rÃ¼n Â· ${fmt(Math.min(scanState.filtered.length, 999))} kÃ¢rlÄ± satÄ±r Â· ${scanState.errors} hata Â· ${secsn} sn`;
  }
  if (!scanState.abort) scanState.loadedAt = Date.now();
  /* v26: abort (durdur) sonrasÄ± kÄ±smi sonuÃ§ cache'e yazÄ±lmaz â€” bayat/kÄ±rpÄ±k sonuÃ§ ezmesin */
  if (!scanState.abort) {
    try {
      localStorage.setItem("scanResult", JSON.stringify({ at: Date.now(), quality: scanState.resultQuality, flips: scanState.flips.slice(0, 900) }));
    } catch (e) { /* kota aÅŸÄ±mÄ± */ }
  }
  if (!scanState.abort) {
    warmCache();
    if (scanState.auto) notifyNewFlips();
    checkFavoriteAlerts();
  }
}

/* basit eÅŸzamanlÄ± iÅŸÃ§i havuzu */
async function runPool(worker, size) {
  await Promise.all(Array.from({ length: size }, worker));
}

function stopScan() { scanState.abort = true; }

/* API satÄ±rlarÄ±nÄ± fÄ±rsatlara Ã§evir */
function scanQualSel() {
  /* v27: seÃ§ili kalite â€” null = tÃ¼m kaliteler */
  const v = $("scanQualityAll").value;
  return v === "all" ? null : (Number(v) || 1);
}
function absorbRows(rows) {
  /* Buy Order analizi iÃ§in ham satÄ±rlarÄ± da sakla (kalite filtresine tabi) */
  const qSel = scanState.scanQuality ?? (scanQualSel() ?? "all");
  rows.forEach(r => {
    if (qSel !== "all" && Number(r.quality) !== qSel) return;
    BO_RAW.set(r.item_id + "|" + r.quality + "|" + r.city, {
      id: r.item_id, q: r.quality, city: r.city,
      sm: r.sell_price_min || 0, bm: r.buy_price_max || 0,
    });
  });
  const byKey = new Map();
  rows.forEach(r => {
    if (qSel !== "all" && Number(r.quality) !== qSel) return;
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

    /* AnlÄ±k satÄ±ÅŸ: Black Market DAHÄ°L tÃ¼m ÅŸehirlerde â€” hedefin en yÃ¼ksek
       buy order'Ä±na (anÄ±nda alÄ±cÄ±) satabilirsin. BM kendisi buy order kurar
       ve senin emrini anÄ±nda alÄ±r; bu yÃ¼zden BM'de "satÄ±ÅŸ emri kur ve bekle"
       yolu yerine bu yol kullanÄ±lÄ±r. KullanÄ±cÄ±nÄ±n ana stratejisi:
       "herhangi bir ÅŸehirde ucuza listelenmiÅŸ + BM pahalÄ± alÄ±yor" fÄ±rsatÄ±. */
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
    /* BM fÄ±rsat satÄ±rÄ±: BM baÅŸka ÅŸehri geÃ§mese (veya ilk 3'e girmese) bile,
       BM alÄ±ÅŸÄ± (vergi sonrasÄ±) liste fiyatÄ±nÄ± geÃ§iyorsa ayrÄ±ca yaz */
    const bmPick = cand.find(o => o.r.city === "Black Market");
    const bmNet = bmPick ? bmPick.net : (bm ? bm * t1 - buy.sell_price_min : -1e18);
    if (bmRow && buy.city !== "Black Market" && !picked.some(o => o.r.city === "Black Market") && (allMode || bmNet > 0)) {
      picked.push({ r: bmRow, net: bmNet });
    }
    /* BÃ¼tÃ¼n itemleri gÃ¶ster: en yÃ¼ksek buy order ÅŸehri net eksi bile olsa satÄ±r koy */
    if (allMode && cand.length && cand[0].net <= 0 && !picked.some(o => o.r === cand[0].r)) {
      picked.push(cand[0]);
    }
    picked.sort((a, b) => b.net - a.net);
    newly.push(...picked.map(o => mkFlip(id, q, buy, o.r, "Emirâ†’Emir", o.net, bm)));
    /* "SatÄ±ÅŸ emri kur ve bekle" yolu: BM hariÃ§ (BM'de sell_price_min anlamsÄ±z) */
    for (const r of sellers) {
      if (r.city === buy.city || r.city === "Black Market" || r.sell_price_min <= buy.sell_price_min) continue;
      const net = r.sell_price_min * t2 - buy.sell_price_min;
      if (net > 0) newly.push(mkFlip(id, q, buy, r, "Emirâ†’SatEmri", net, bm));
      break;
    }
  });
  if (!newly.length) return;
  scanState.flips = scanState.flips.concat(newly).sort((a, b) => b.net - a.net).slice(0, 3000);
}

function mkFlip(id, q, buy, sellRow, kindToken, net, bmExtra) {
  const kind = kindToken === "Emirâ†’Emir" ? "Emir â†’ Emir" : "Emir â†’ SatÄ±ÅŸ emri";
  const sellDate = kindToken === "Emirâ†’Emir" ? sellRow.buy_price_max_date : sellRow.sell_price_min_date;
  const buyDate = buy.sell_price_min_date;
  const isDate = d => d && !d.startsWith("0001");
  const dates = [buyDate, sellDate]
    .filter(isDate)
    .map(pareDate)
    .filter(d => !isNaN(d.getTime()));
  const newest = dates.length ? new Date(Math.max(...dates.map(d => d.getTime()))) : null;
  const t1 = 1 - state.salesTax / 100;
  const t2 = 1 - (state.salesTax + state.setupFee) / 100;
  const grossSell = kindToken === "Emirâ†’Emir" ? sellRow.buy_price_max : sellRow.sell_price_min;
  return {
    id, q: Number(q),
    name: itemNameResolve(id),
    kind,
    buyCity: buy.city, buyPrice: buy.sell_price_min,
    sellCity: sellRow.city, sellPrice: grossSell,
    net, pct: (net / buy.sell_price_min) * 100,
    /* Black Market alÄ±ÅŸ emri (BM'in Ã¶dediÄŸi Ã¼st fiyat) â€” her satÄ±rda gÃ¶rÃ¼nÃ¼r */
    bm: Number(bmExtra) > 0 ? Number(bmExtra) : 0,
    tax: Math.abs((kindToken === "Emirâ†’Emir" ? t1 : t2) * grossSell - grossSell),
    age: newest,
    /* Kritik: satÄ±ÅŸ ayaÄŸÄ±nÄ±n kendi veri yaÅŸÄ± â€” 80M gibi bayat emirleri buradan yakalarÄ±z */
    sellAge: isDate(sellDate) ? pareDate(sellDate) : null,
    buyAge: isDate(buyDate) ? pareDate(buyDate) : null,
  };
}

/* VERÄ° hÃ¼cresi: yaÅŸa gÃ¶re renkli (yeÅŸil â‰¤1 sa, sarÄ± â‰¤6 sa, kÄ±rmÄ±zÄ± >6 sa) */
function cellAge(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return `<span class="muted">â€”</span>`;
  const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  const text = mins < 60 ? mins + " dk" : mins < 1440 ? Math.floor(mins / 60) + " sa" : Math.floor(mins / 1440) + " g";
  const cls = mins <= 60 ? "age-fresh" : mins <= 360 ? "age-soft" : "age-old";
  const icon = mins <= 60 ? "â—" : mins <= 360 ? "â—" : "â—‹";
  return `<span class="${cls}">${icon} ${text}</span>`;
}

/* ---------- Quantity: son 7 gÃ¼nde hedef ÅŸehirde gerÃ§ekten satÄ±lan adet ---------- */
/* AODP, emir derinliÄŸini (asÄ±lÄ± emrin kalan adedini) vermiyor; oyunun market
   ekranÄ±nda gÃ¶rdÃ¼ÄŸÃ¼n "quantity" bilgisine en yakÄ±n dÃ¼rÃ¼st Ã¶lÃ§Ã¼ geÃ§miÅŸ iÅŸlemler. */
let QTY = (() => { try { return JSON.parse(localStorage.getItem("qtyCache") || "{}"); } catch (e) { return {}; } })();
const QLOC = { 1002: "Caerleon", 2001: "Fort Sterling", 2002: "Lymhurst", 2003: "Martlock", 2004: "Bridgewatch", 2005: "Thetford", 3005: "Black Market" };

function qtyKey(city, q, id) { return `${city}|${q}|${id}`; }
function qtyFresh(key) {
  const v = QTY[key];
  if (!v || !v.at || !Number.isFinite(v.qty)) return null;
  const age = Date.now() - v.at;
  if (v.qty < 0) return age < 10 * 60 * 1000 ? v.qty : null;   /* -1 = "veri yok" (API hatasÄ±): 10 dk taze say, sonra tekrar dene */
  return age < 6 * 3600 * 1000 ? v.qty : null;
}
function saveQtyCache() {
  /* kota korumasÄ±: en yeni 600 kayÄ±t kalsÄ±n */
  const keys = Object.keys(QTY);
  if (keys.length > 600) {
    keys.sort((a, b) => (QTY[a].at || 0) - (QTY[b].at || 0));
    keys.slice(0, keys.length - 600).forEach(k => delete QTY[k]);
  }
  try { localStorage.setItem("qtyCache", JSON.stringify(QTY)); } catch (e) { /* yoksay */ }
}
/* Piyasa deÄŸeri (market value): son 7 gÃ¼nÃ¼n iÅŸlem ortalamasÄ±, item + kalite + ÅŸehir bazÄ±nda */
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
    /* son 7 gÃ¼nÃ¼n toplam iÅŸlem hacmi (order depth verisi olmadÄ±ÄŸÄ± iÃ§in en dÃ¼rÃ¼st "kaÃ§ alÄ±nabilir" Ã¶lÃ§Ã¼sÃ¼) */
    const qty = days.slice(-7).reduce((n, d) => n + d.item_count, 0);
    /* Piyasa deÄŸeri: son 7 gÃ¼nÃ¼n adet-aÄŸÄ±rlÄ±klÄ± ortalamasÄ± */
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
    QTY[key] = { qty: -1, at: Date.now() }; /* negatif = "veri yok", tekrar deneme kalmasÄ± */
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
  if (qty === null || qty === undefined) return `<span class="muted">â€”</span>`;
  if (qty < 0) return `<span class="muted small" title="Veri Ã§ekilemedi (API hatasÄ±) â€” 10 dk sonra yeniden denenir">â€”</span>`;   /* -1 sentineli "iÅŸlem yok" sanma */
  if (qty === 0) return `<span class="risk-badge risk-bad" title="Son 7 gÃ¼nde iÅŸlem yok â€” likidite yok; BM emri gÃ¶rse bile satamama riski yÃ¼ksek">iÅŸlem yok</span>`;
  if (qty < 30) return `<span class="price profit-positive">${fmt(qty)}</span> <span class="muted small">Â· 7g</span> <span class="risk-badge" title="7 gÃ¼nde 30'dan az iÅŸlem â€” yavaÅŸ item, satÄ±ÅŸ bekleyebilir">az likit</span>`;
  return `<span class="price profit-positive">${fmt(qty)}</span> <span class="muted small">Â· 7g</span>`;
}
/* item adÄ±nÄ±n yanÄ±ndaki qty Ã§ipi: oyun gibi Ã—1 / Ã—10 / Ã—100 dilimlerinde */
function qtyChipHTML(key) {
  const v = qtyFresh(key);
  if (v !== null && v < 0) return `<span class="muted">Â·</span>`;   /* veri yok (API hatasÄ±) â€” Ã—0 Ã§ipi basma */
  const b = v !== null ? qtyBucket(v) : null;
  if (b === null && v === null) return `<span class="qty-chip pending" data-qtykey="${key}">â€¦</span>`;
  return `<span class="qty-chip" data-qtykey="${key}" title="Son 7 gÃ¼nde hedef ÅŸehirde satÄ±lan: ${fmt(v ?? 0)} adet">Ã—${b ?? 0}</span>`;
}
/* BUY hÃ¼cresi mini-gÃ¶sterge: kaynak ÅŸehirde son 7 gÃ¼n iÅŸlem gÃ¶ren adet */
function buyqtyHTML(qty) {
  if (qty === null || qty === undefined || qty <= 0) return `<span class="muted small">â€”</span>`;
  return `<span class="small muted" style="font-size:11px">Â· ${fmt(qty)}/7g</span>`;
}
function updateQtySlots(key, qty) {
  document.querySelectorAll(`td.qty-cell[data-qtykey="${key}"], span.qty-chip[data-qtykey="${key}"], span.buyqty[data-qtykey="${key}"]`).forEach(el => {
    if (el.classList.contains("qty-cell")) el.innerHTML = qtyCellHTML(qty);
    else if (el.classList.contains("buyqty")) { el.innerHTML = buyqtyHTML(qty); }
    else {
      const b = qtyBucket(qty === null || qty === undefined ? null : qty);
      el.classList.remove("pending");
      el.textContent = `Ã—${b ?? 0}`;
      if (qty !== null && Number.isFinite(qty) && qty > 0) el.title = `Son 7 gÃ¼nde hedef ÅŸehirde satÄ±lan: ${fmt(qty)} adet`;
    }
  });
}

/* ---------- Market deÄŸeri hÃ¼cresi: oyun iÃ§i piyasa deÄŸeri + fÄ±rsat rozetleri ---------- */
function mvCellHTMLRow(mv, buyPrice, sellPrice, trend) {
  if (mv === null || mv === undefined || !Number.isFinite(mv)) return `<span class="muted">â€¦</span>`;
  let badges = "";
  if (typeof trend === "number" && isFinite(trend)) {
    const up = trend >= 3, dn = trend <= -3;
    const arrow = up ? "â†—" : dn ? "â†˜" : "â†’";
    const cls = up ? "trend-up" : dn ? "trend-down" : "trend-flat";
    badges += ` <span class="${cls}" title="Piyasa deÄŸeri yÃ¶nÃ¼: son 7 gÃ¼nÃ¼n ilk yarÄ±sÄ±na gÃ¶re deÄŸiÅŸim %${trend.toFixed(1)} â€” â†˜ dÃ¼ÅŸen fiyat: emirler bayat olabilir, dikkat"> ${arrow}</span>`;
  }
  if (mv > 0 && buyPrice > 0 && buyPrice <= mv * 0.75) {
    badges += ` <span class="mv-badge mv-undervalue" title="Liste fiyatÄ± piyasaya gÃ¶re ucuz: buy â€” item piyasa deÄŸerinin %${Math.round((buyPrice / mv) * 100)}'i. Ucuz listelenmiÅŸ itemi kaÃ§Ä±rmaya gerek yok â€” anlÄ±k alÄ±cÄ± ÅŸehre taÅŸÄ±yabilirsin.">âš¡ %${Math.round((buyPrice / mv) * 100)}</span>`;
  }
  if (mv > 0 && sellPrice > 0 && sellPrice >= mv * 1.25) {
    badges += ` <span class="mv-badge mv-premium" title="AlÄ±ÅŸ emri piyasa deÄŸerinin %${Math.round((sellPrice / mv) * 100)}'i. Bu item piyasadan pahalÄ± alÄ±cÄ± buluyor.">+%${Math.round((sellPrice / mv) * 100)}</span>`;
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

/* BaÅŸlÄ±k sÄ±ralama gÃ¶stergesi (MARGIN â–¼) */
function refreshSortHeader() {
  document.querySelectorAll("#scanTable thead th.sortable").forEach(th => {
    const active = th.dataset.key === (scanState.sortKey || "profit");
    th.classList.toggle("active-sort", active);
    const old = th.querySelector(".sort-arrow");
    if (old) old.remove();
    if (active) {
      const a = document.createElement("span");
      a.className = "sort-arrow";
      a.textContent = (scanState.sortDir || "desc") === "asc" ? "â–²" : "â–¼";
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
  const qualityFilter = scanQualSel();
  const resultQuality = scanState.scanQuality ?? scanState.cacheQuality;
  const mn = scanState.all ? -1e18 : scanState.minNet;   /* BÃ¼tÃ¼n itemler: eÅŸik yok */
  const mp = scanState.all ? -1e18 : scanState.minPct;
  const now = Date.now();
  const f = scanState.flips.filter(x => {
    /* Quality filtering must honor both the UI choice and the actual scan/cache scope. */
    if (resultQuality !== undefined && resultQuality !== "all" && Number(x.q) !== Number(resultQuality)) return false;
    if (qualityFilter !== null && Number(x.q) !== qualityFilter) return false;
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
  /* SÄ±ralama: tablo baÅŸlÄ±klarÄ±ndan (net/pct/buy/sell/qty/mv/updated) â€” tÄ±klanan baÅŸlÄ±kta dir ters dÃ¶ner */
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
    const k = x.buyCity + " â†’ " + x.sellCity;
    const a = agg.get(k) || { city: k, sum: 0, cnt: 0, pctSum: 0, best: null };
    a.sum += x.net; a.cnt++; a.pctSum += x.pct;
    if (!a.best || x.net > a.best.net) a.best = x;
    agg.set(k, a);
  });
  const top = [...agg.values()].sort((a, b) => b.sum - a.sum).slice(0, 8);
  if (!top.length) {
    $("routesGrid").innerHTML = `<span class="muted small">HenÃ¼z rota yok â€” TaramayÄ± BaÅŸlat'a bas ya da filtreleri gevÅŸet.</span>`;
    return;
  }
  $("routesGrid").innerHTML = top.map(a => {
    const [bc, sc] = a.city.split(" â†’ ");
    return `
    <div class="route-card item-cell">
      <div class="route-cities"><span class="city-tag city-${esc(bc.replace(/\s/g, ""))}">${esc(bc)}</span><span class="route-arrow">â†’</span><span class="city-tag city-${esc(sc.replace(/\s/g, ""))}">${esc(sc)}</span></div>
      <div class="route-sum profit-positive">Î£ +${fmt(a.sum)}</div>
      <div class="route-count">${a.cnt} Ã¼rÃ¼n Â· ort %${(a.pctSum / a.cnt).toFixed(0)} Â· en iyi: ${esc(a.best.name)}</div>
    </div>`;
  }).join("");
}

/* KÄ±sa fiyat: albionanalyser scanner tarzÄ± "1.2M", "389.9K" */
function fmtShort(n) {
  if (!isFinite(n)) return "â€”";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return fmt(n);
}
/* SatabileceÄŸin miktarÄ± oyunun 1/10/100 dilimlerine yuvarlar */
function qtyBucket(qty) {
  if (qty === null || qty === undefined || qty <= 0) return null;
  if (qty < 10) return Math.max(1, Math.round(qty));
  if (qty < 100) return Math.max(10, Math.floor(qty / 10) * 10);
  return Math.max(100, Math.floor(qty / 100) * 100);
}

/* ---------- "SatÄ±ÅŸ emri" satÄ±rlarÄ± iÃ§in gerÃ§eÄŸi fiyatlar ----------
   Liste fiyatÄ± (ask) senin sattÄ±ÄŸÄ±n fiyat DEÄÄ°L â€” rakibin listelendiÄŸi fiyat.
   GerÃ§ekÃ§i satÄ±ÅŸ = o ÅŸehirde son 7 gÃ¼nte bloÄŸa gerÃ§ekten iÅŸlem gÃ¶ren ortalama (history mv).
   KaÃ§ara: Liste fiyatÄ±na satÄ±ÅŸ garantisi yok; iÅŸlem yoksa risk yÃ¼ksek. */
function realSellHTML(mv, ask, buy) {
  const t2 = 1 - (state.salesTax + state.setupFee) / 100;
  let top = "";
  if (mv && mv > 0) {
    top = `<span class="price">${fmtShort(mv)}</span> <span class="muted small" title="Son 7 gÃ¼nÃ¼n gerÃ§ek iÅŸlem ortalamasÄ± â€” satÄ±ÅŸ beyanÄ±nÄ± (sell order) bunun civarÄ±na koyman gerekir">son satÄ±ÅŸ</span><br><span class="muted small" title="Åu an en dÃ¼ÅŸÃ¼k liste fiyatÄ± (rakibin ask â€” onunla yarÄ±ÅŸman gerekir)">liste ${fmtShort(ask)}</span>`;
  } else {
    top = `<span class="muted small" title="Bu itemin iÅŸlem kaydÄ± yok â€” listede fiyat garanti edilemez, risk yÃ¼ksek. AnlÄ±k buy order satÄ±rÄ±nÄ± tercih et">son satÄ±ÅŸ ?</span><br><span class="muted small">liste ${fmtShort(ask)}</span>`;
  }
  if (mv && mv > 0 && buy > 0) {
    const net = mv * t2 - buy;
    top += ` <span class="net-chip ${net >= 0 ? "positive" : "negative"}" title="Vergi+kuruluÅŸ (%${state.salesTax}+%${state.setupFee}) dÃ¼ÅŸÃ¼nce eline kalan net">${net >= 0 ? "+" : "âˆ’"}${fmtShort(Math.abs(net))}</span>`;
  }
  return top;
}
function realProfitHTML(mv, buy) {
  const t2 = 1 - (state.salesTax + state.setupFee) / 100;
  if (!(mv && mv > 0)) return `<span class="muted">?</span>`;
  const net = mv * t2 - buy;
  return `<span class="price ${net < 0 ? "profit-negative" : "profit-positive"}" title="GerÃ§ekÃ§i kÃ¢r: son 7 gÃ¼nÃ¼n iÅŸlem ort (mv) Ã¼zerinden â€” liste farkÄ± sonrasÄ±">${fmtShort(net)}</span>`;
}
function realMarginHTML(mv, buy) {
  const t2 = 1 - (state.salesTax + state.setupFee) / 100;
  if (!(mv && mv > 0)) return `<span class="muted">â€”</span>`;
  const net = mv * t2 - buy;
  const pct = (net / buy) * 100;
  const mCls = pct >= 40 ? "margin-badge margin-high" : pct >= 15 ? "margin-badge margin-medium" : pct < 0 ? "margin-badge margin-neg" : "margin-badge margin-low";
  return `<span class="${mCls}" title="GerÃ§ekÃ§i marjin: son satÄ±ÅŸ ort (mv) Ã¼zerinden">${pct.toFixed(1)}%</span>`;
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
    ? `${fmt(scanState.filtered.length)} fÄ±rsat Â· ilk 400 gÃ¶steriliyor`
    : `${fmt(scanState.filtered.length)} fÄ±rsat`;
  if (!rows.length) {
    $("scanRows").innerHTML = `<tr><td colspan="14" class="muted">SonuÃ§ yok â€” daha dÃ¼ÅŸÃ¼k eÅŸik dene ya da taramayÄ± baÅŸlat.</td></tr>`;
    return;
  }
  $("scanRows").innerHTML = rows.map((x, n) => {
    const mCls = x.pct >= 40 ? "margin-badge margin-high" : x.pct >= 15 ? "margin-badge margin-medium" : x.pct < 0 ? "margin-badge margin-neg" : "margin-badge margin-low";
    const score = scoreFor(x);
    const scoreCls = score >= 70 ? "score-hi" : score >= 40 ? "score-mid" : "score-lo";
    /* item: "6.3 Claws" / alt satÄ±r "T6.3 Â· Good" â€” albionanalyser scanner dÃ¼zeni */
    const m = String(x.id || "").match(/^T(\d)(?:[^@]*)@(\d+)$/);
    const tierN = m ? m[1] : (String(x.id).match(/^T(\d)/) || [])[1] || "";
    const enchN = m ? m[2] : "";
    const tp = tierPretty(x.id);
    const shortName = String(x.name || "").replace(/^T\d+\s*/, "");
    const qLabel = Number(x.q) > 1 ? ` Â· ${QUALITY_NAMES[Number(x.q)] || "Q" + x.q}` : "";
    const subTier = enchN ? `T${tierN}.${enchN}` : `T${tierN}`;
    const qkey = qtyKey(x.sellCity, Number(x.q) || 1, x.id);
    const bqkey = qtyKey(x.buyCity, Number(x.q) || 1, x.id);
    const qtyCol = qtyFresh(qkey) !== null ? qtyCellHTML(qtyFresh(qkey)) : `<span class="muted">â€¦</span>`;
    const mv0 = mvFresh(qkey);
    const mvT = mvTrendOf(qkey);
    const mvCol = mv0 !== null ? mvCellHTMLRow(mv0, x.buyPrice, x.sellPrice, mvT) : `<span class="muted">â€¦</span>`;
    const bmNet = x.bm > 0 ? x.bm * (1 - state.salesTax / 100) - x.buyPrice : null;
    const bmCol = x.bm > 0
      ? `<span class="price ${bmNet > 0 ? "profit-positive" : ""}" title="Black Market alÄ±ÅŸ emri${bmNet > 0 ? ` â€” BM'e satsan net +${fmt(bmNet)} (ÅŸu anki hedef: ${esc(x.sellCity)})` : ""}">${fmtShort(x.bm)}${bmNet > 0 && x.sellCity !== "Black Market" ? ` <span class="bm-chip">+${fmtShort(bmNet)}</span>` : ""}</span>`
      : `<span class="muted">â€”</span>`;
    return `
    <tr data-id="${esc(x.id)}" data-q="${Number(x.q) || 1}" data-fkey="${esc(fkeyOf(x))}" class="scan-row">
      <td><div class="item-cell">
        <img loading="lazy" alt="" class="item-icon" src="https://render.albiononline.com/v2/item/${esc(x.id)}.png?size=32" onerror="this.style.display='none'">
        <span><span class="item-name copyname" data-copyname="${esc(shortName)}" data-copyfull="${esc(tp + ' ' + shortName)}" title="TÄ±kla: ismi kopyala (oyuna yapÄ±ÅŸtÄ±r) Â· Shift+tÄ±k: item kodu kopyalar">${tp} ${esc(shortName)}</span> ${qtyChipHTML(qkey)}<br><span class="muted small">${subTier}${qLabel}</span></span>
      </div></td>
      <td class="kind-label" title="${esc(x.kind)}">${x.kind === "Emir â†’ Emir" ? "AnlÄ±k (BO)" : "SatÄ±ÅŸ emri"}</td>
      <td><span class="city-tag city-${esc(x.buyCity.replace(/\s/g, ""))}">${esc(x.buyCity)}</span></td>
      <td><span class="city-tag city-${esc(x.sellCity.replace(/\s/g, ""))}">${esc(x.sellCity)}</span></td>
    <td class="num price">${fmtShort(x.buyPrice)} <span class="buyqty" data-qtykey="${esc(bqkey)}">${qtyFresh(bqkey) !== null ? buyqtyHTML(qtyFresh(bqkey)) : `<span class="muted small">â€¦</span>`}</span></td>`
    + (x.kind === "Emir â†’ SatÄ±ÅŸ emri"
    ? `<td class="num price real-sell" data-qtykey="${esc(qkey)}" data-buy="${x.buyPrice}" data-ask="${x.sellPrice}">${realSellHTML(mv0, x.sellPrice, x.buyPrice)}</td>`
    + `<td class="num real-profit" data-qtykey="${esc(qkey)}" data-buy="${x.buyPrice}" data-ask="${x.sellPrice}">${realProfitHTML(mv0, x.buyPrice)}</td>`
    + `<td class="num real-margin" data-qtykey="${esc(qkey)}" data-buy="${x.buyPrice}" data-ask="${x.sellPrice}">${realMarginHTML(mv0, x.buyPrice)}</td>`
    : `<td class="num price">${fmtShort(x.sellPrice)} <span class="net-chip ${x.net >= 0 ? "positive" : "negative"}" title="Vergi (%${state.salesTax}) dÃ¼ÅŸÃ¼nce eline kalan net â€” %${state.salesTax} Â· satÄ±ÅŸ ${fmtShort(x.sellPrice)} Ã— ${1 - state.salesTax / 100} âˆ’ alÄ±ÅŸ ${fmtShort(x.buyPrice)}">${x.net >= 0 ? "+" : "âˆ’"}${fmtShort(Math.abs(x.net))}</span></td>`
    + `<td class="num price ${x.net < 0 ? "profit-negative" : "profit-positive"}">${fmtShort(x.net)}</td>`
    + `<td class="num"><span class="${mCls}">${x.pct.toFixed(1)}%</span></td>`)
    + `<td class="num score-cell"><span class="score-b ${scoreCls}" title="FÄ±rsat skoru: likidite Ã— trend Ã— marj (0-100)">${score}</span></td>`
    + `<td>${cellAge(x.sellAge || x.age)}</td>
      <td class="num qty-cell" data-qtykey="${esc(qkey)}">${qtyCol}</td>
      <td class="num mv-cell" data-qtykey="${esc(qkey)}" data-buy="${x.buyPrice}" data-sell="${x.sellPrice}" title="Piyasa deÄŸeri: son 7 gÃ¼nÃ¼n iÅŸlem ortalamasÄ± (oyun iÃ§i piyasa deÄŸeri)">${mvCol}</td>
      <td class="num bm-cell">${bmCol}</td>
      <td class="row-actions"><button type="button" class="detail-btn fav-btn${isFav(x.id, x.q) ? " faved" : ""}" title="Favori ekle/Ã§Ä±kar â€” alarm eÅŸiÄŸini sol panelde ayarla" data-fav="${esc(x.id)}" data-fq="${Number(x.q) || 1}">â˜…</button> <button type="button" class="detail-btn" title="ÃœrÃ¼n detayÄ±nÄ± aÃ§" data-id="${esc(x.id)}" data-q="${Number(x.q) || 1}">â†—</button> <button type="button" class="detail-btn ledger-add" title="Deftere ekle" data-add="${esc(fkeyOf(x))}">+</button></td>
    </tr>`;}).join("");
  /* SatÄ±r artÄ±k tÄ±klanmaz (kopyala/yapÄ±ÅŸtÄ±r serbest) â€” yalnÄ±zca â†— butonu detay aÃ§ar */
  $("scanRows").querySelectorAll(".detail-btn").forEach(btn => {
    btn.addEventListener("click", ev => {
      ev.stopPropagation();
      openDetailFromScan(btn.dataset.id, btn.dataset.q);
    });
  });
  /* + butonu: satÄ±rÄ± flip defterine ekler */
  const byKey = new Map(rows.map(x => [fkeyOf(x), x]));
  $("scanRows").querySelectorAll(".ledger-add").forEach(btn => {
    btn.addEventListener("click", ev => {
      ev.stopPropagation();
      const f = byKey.get(btn.dataset.add);
      if (!f) return;
      ledgerAdd(f);
      btn.textContent = "âœ“";
      btn.classList.add("done");
      setTimeout(() => { btn.textContent = "+"; btn.classList.remove("done"); }, 1200);
    });
  });
  fillQuantities(); /* quantity hÃ¼creleri arkaplanda dolar */
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

/* ?demo=1: taramayÄ± beklemek istemiyorsan Ã¶rnek satÄ±rlarla tabloyu doldurur */
function demoSeed() {
  if (new URLSearchParams(location.search).get("demo") !== "1") return false;
  const demobm = { "T6_2H_CLAWPAIR@3": 1620000, "T8_MAIN_FIRESTAFF_KEEPER@4": 42000000, "T7_MAIN_HELM_HELL@3": 3410000, "T4_BAG": 6800, "T6_BAG@2": 81000, "T5_PLANKS": 1900, "T7_HIDE": 21500 };
  const mk = (id, q, bc, sc, bp, sp) => mkFlip(id, q, { city: bc, sell_price_min: bp, sell_price_min_date: new Date().toISOString() }, (sc === "Caerleon" || sc === "Black Market")
      ? { city: sc, buy_price_max: sp, buy_price_max_date: new Date().toISOString() }
      : { city: sc, sell_price_min: sp, sell_price_min_date: new Date().toISOString() }, (sc === "Caerleon" || sc === "Black Market") ? "Emirâ†’Emir" : "Emirâ†’SatEmir", Math.round(sp * (1 - state.salesTax / 100) - bp), demobm[id] || 0);
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
  /* Demo iÃ§in qty + piyasa deÄŸeri (gerÃ§ek oyun verisi deÄŸil, kolonlarÄ±/rozetleri gÃ¶rmek iÃ§in;
     hem QTY hem MVA seed edilmeli ki fillQuantities gerÃ§ek fetch ile ezmesin) */
  const at = Date.now();
  const demoqty = [12, 3, 0, 45, 0, 7];
  const demomv = {
    "Lymhurst|1|T6_2H_CLAWPAIR@3": 1310000,     /* sat 1500K = %114 premium alÄ±cÄ± */
    "Caerleon|4|T8_MAIN_FIRESTAFF_KEEPER@4": 39500000,
    "Black Market|1|T7_MAIN_HELM_HELL@3": 2500000, /* BM buy 3410K = %136 premium */
    "Caerleon|1|T4_BAG": 4600,                  /* buy 3400 = %74 â†’ "Piyasa altÄ±" */
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
  /* Demo iÃ§in buy order ham satÄ±rlarÄ±: Emir sekmesinin dolmasÄ± iÃ§in */
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
  /* URL'de ?item= varsa sayfa doÄŸrudan ÃœrÃ¼n DetayÄ± ile aÃ§Ä±lÄ±r */
  const qs = new URLSearchParams(location.search);
  showTab(qs.get("item") ? "detail" : "scanner");
  window.onerror = (msg, src, line) => {
    $("scanInfo").textContent = `Hata: ${msg} (${(src || "").split("/").pop()}:${line})`;
  };
  /* BaÅŸlÄ±k sÄ±ralamasÄ±: MARGIN'e basÄ±nca yÃ¼ksekten dÃ¼ÅŸÃ¼ÄŸe (â–¼), tekrar basÄ±nca â–² */
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
  /* Otomatik filtre: seÃ§im deÄŸiÅŸince tablo anÄ±nda gÃ¼ncellenir (uygula butonu yok) */
  ["minNet", "minPct", "scanCity", "scanDest", "scanAll", "freshWindow", "scanTierMin", "scanTierMax"].forEach(id => {
    $(id).addEventListener("change", () => { if (scanState.flips.length) applyFilters(); });
  });
  /* Kalite deÄŸiÅŸimi API sorgusunun kapsamÄ±nÄ± deÄŸiÅŸtirir: yeniden tarama gerekir,
     Ã§Ã¼nkÃ¼ tek-kalite sonucunda diÄŸer kaliteler sorgulanmamÄ±ÅŸtÄ±r. */
  $("scanQualityAll").addEventListener("change", () => {
    if (scanState.flips.length) applyFilters();
    if (scanState.running || scanState.flips.length) qualityRestartScan();
  });
  ["minNet", "minPct"].forEach(id => {
    $(id).addEventListener("input", () => { if (scanState.flips.length) applyFilters(); });
  });
  /* Premium vergisi seÃ§imi: Premium %4 / Premiumsuz %8 â€” tablu yeniden net kÃ¢rlanir (yeniden tarama gereksiz) */
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
        const t = x.kind === "Emir â†’ Emir" ? t1 : t2;
        const net = x.kind === "Emir â†’ Emir"
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
  /* Item ismine tÄ±kla â†’ panoya kopyala (oyuna yapÄ±ÅŸtÄ±rmak iÃ§in); Shift+tÄ±k â†’ item kodu.
     â˜… butonu â†’ favori ekle/Ã§Ä±kar (alarm sol panelde). */
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
    const all = loadProfiles();
    profApply(all[$("profSel").value]);
  });
  $("profSave")?.addEventListener("click", () => {
    const rawName = prompt("Profil ad�� (��rn. BM h��zl��):");
    if (rawName === null) return;
    const name = rawName.trim();
    const info = $("scanInfo");
    if (!name || name.length > 40) {
      if (info) info.textContent = "Profil ad�� 1-40 karakter olmal��.";
      return;
    }
    const all = loadProfiles();
    if (Object.prototype.hasOwnProperty.call(all, name) && !confirm(`'${name}' profili zaten var. Üzerine yazılsın mı?`)) return;
    all[name] = profCollect();
    try { localStorage.setItem("albionProfiles", JSON.stringify(all)); }
    catch (e) { if (info) info.textContent = "Profil kaydedilemedi: " + (e && e.message || e); return; }
    profFillSel(name);
    if (info) info.textContent = "Profil kaydedildi: " + name;
  });
  $("profDel")?.addEventListener("click", () => {
    const k = $("profSel").value;
    if (!k) return;
    const all = loadProfiles();
    delete all[k];
    try { localStorage.setItem("albionProfiles", JSON.stringify(all)); }
    catch (e) { $("scanInfo").textContent = "Profil silinemedi: " + (e && e.message || e); return; }
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
        $("scanInfo").textContent = `Otomatik tarama aÃ§Ä±k â€” her ${$("autoEvery").value} dk'da sessiz tarama; yeni fÄ±rsatta bildirim + kÄ±sa bip.`;
      } else if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
        $("scanInfo").textContent = "Otomatik tarama kapalÄ±.";
      }
    });
    $("autoEvery")?.addEventListener("change", () => { if (autoCb.checked) setAutoTimer(); });
  }
  ["calcRes", "calcNeed", "calcReturn", "calcQty", "calcFee", "calcShip", "calcSell"].forEach(id => {
    $(id)?.addEventListener("input", computeCalc);
  });
  $("calcWay")?.addEventListener("change", computeCalc);
  /* Hammadde otomatik fiyat: item ara â†’ seÃ§ â†’ AODP'den en ucuz ÅŸehir fiyatÄ±nÄ± Ã§ek */
  $("calcItem")?.addEventListener("input", e => calcSearch(e.target.value));
  $("calcFetch")?.addEventListener("click", calcFetchPrice);
  $("calcItemInfo").textContent = "Hammadde: " + calcItemSel;
  /* Buy Order analizi filtresi */
  $("orderMinQty")?.addEventListener("input", () => renderBO());
  $("orderRefresh")?.addEventListener("click", () => renderBO(true));
  /* Yedek indir / geri yÃ¼kle */
  $("backupBtn")?.addEventListener("click", backupAll);
  $("restoreBtn")?.addEventListener("click", () => $("restoreFile")?.click());
  $("restoreFile")?.addEventListener("change", ev => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { try { restoreAll(JSON.parse(String(rd.result))); } catch (e) { $("scanInfo").textContent = "Yedek okunamadÄ±: " + e.message; } };
    rd.readAsText(f);
    ev.target.value = "";
  });
  /* Klavye kÄ±sayollarÄ±: R = tarama, / = arama kutusu, F = favori filtresi.
     YazÄ± alanlarÄ±nda (input/textarea/select) Ã§alÄ±ÅŸmaz â€” yazÄ± yazmayÄ± bozmaz. */
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
  /* PaylaÅŸ butonu: turev adresi varsa (share.json turev koruyucusu yazar) gÃ¶ster */
  fetch("share.json", { cache: "no-store" }).then(r => r.ok ? r.json() : null).then(s => {
    if (!s || !s.url) return;
    const btn = $("shareBtn");
    if (btn) { btn.dataset.share = s.url; btn.classList.remove("hidden"); }
  }).catch(() => { /* sunucu yoksa buton gizli kalir */ });
  /* v23: Ä°lk aÃ§Ä±lÄ±ÅŸta boÅŸ gÃ¶rÃ¼nmesin â€” kayÄ±tlÄ± tarama sonucu yoksa 800 ms sonra otomatik tarama */
  try {
    setTimeout(() => {
      try {
        /* scannerInit'teki loadCachedScan kaydÄ± yÃ¼klemediyse flips boÅŸ kalÄ±r;
           localStorage'da da sonuÃ§ yoksa sayfa ilk aÃ§Ä±lÄ±ÅŸta tamamen boÅŸ demektir */
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
    if (!LEDGER.length || confirm("Defterdeki tÃ¼m iÅŸlemler silinsin mi?")) {
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
      } catch (e) { /* arka plan â€” sessiz */ }
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
      document.title = `ğŸ”” ${fresh.length} yeni fÄ±rsat â€” Albion`;
      setTimeout(() => { document.title = "Dr aLabeen â€” Albion Pazar Analiz"; }, 40000);
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
          new Notification("Albion fÄ±rsat", { body: `${fresh.length} yeni kÃ¢rlÄ± satÄ±r (â‰¥ ${fmt(th)}) â€” sekmeye dÃ¶n` });
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
function validProfile(p) {
  const validNum = (v, min, max) => (typeof v === "number" || typeof v === "string") && String(v).trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max;
  const groups = Object.fromEntries(SCAN_GROUPS.map(([g]) => [g, false]));
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const proto = Object.getPrototypeOf(p);
  if (proto !== Object.prototype && proto !== null) return null;
  const allowedFields = new Set(["city", "dest", "minNet", "minPct", "tmin", "tmax", "qual", "sort", "fresh", "tax", "all", "groups"]);
  if (Object.keys(p).some(k => !allowedFields.has(k))) return null;
  if (typeof p.city !== "string" || !["", ...ROYAL].includes(p.city)) return null;
  if (typeof p.dest !== "string" || !["", ...ROYAL, "Black Market"].includes(p.dest)) return null;
  if (!validNum(p.minNet, 0, 1e12) || !validNum(p.minPct, 0, 10000)) return null;
  if (!validNum(p.tmin, 1, 8) || !validNum(p.tmax, 1, 8) || Number(p.tmin) > Number(p.tmax)) return null;
  if (!(p.qual === "all" || /^[1-5]$/.test(String(p.qual)))) return null;
  if (!( ["net", "pct"].includes(p.sort))) return null;
  if (!( ["0", "900", "3600", "10800", "21600", "43200", "86400"].includes(String(p.fresh)))) return null;
  if (!( ["4", "8"].includes(String(p.tax))) || typeof p.all !== "boolean") return null;
  const sourceGroups = p.groups;
  if (!sourceGroups || typeof sourceGroups !== "object" || Array.isArray(sourceGroups)) return null;
  const groupProto = Object.getPrototypeOf(sourceGroups);
  if (groupProto !== Object.prototype && groupProto !== null) return null;
  if (Object.keys(sourceGroups).some(k => !Object.prototype.hasOwnProperty.call(groups, k)) ||
      Object.values(sourceGroups).some(v => typeof v !== "boolean")) return null;
  return {
    city: p.city, dest: p.dest, minNet: p.minNet, minPct: p.minPct,
    tmin: p.tmin, tmax: p.tmax, qual: p.qual, sort: p.sort,
    fresh: p.fresh, tax: p.tax, all: p.all,
    groups: { ...groups, ...sourceGroups },
  };
}
function loadProfiles() {
  try {
    const parsed = JSON.parse(localStorage.getItem("albionProfiles") || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) return Object.create(null);
    const out = Object.create(null);
    for (const [name, profile] of Object.entries(parsed)) {
      const checked = validProfile(profile);
      if (name.length >= 1 && name.length <= 40 && checked) out[name] = checked;
    }
    return out;
  } catch (e) { return Object.create(null); }
}
function profApply(p) {
  p = validProfile(p);
  if (!p) { $("scanInfo").textContent = "Profil geÃ§ersiz veya desteklenmeyen biÃ§imde; uygulanmadÄ±."; return; }
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
  const all = loadProfiles();
  const el = $("profSel");
  if (el) {
    el.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Profil seÃ§â€¦";
    el.appendChild(placeholder);
    Object.keys(all).forEach(k => {
      const option = document.createElement("option");
      option.value = k;
      option.textContent = k;
      option.selected = k === sel;
      el.appendChild(option);
    });
  }
}

/* Kolon gizle/goster: tabloda nth-child kurallari uretilir */
const SCAN_COLS = ["Item", "Type", "Origin", "Dest", "Buy", "Sell", "Profit", "Margin", "Skor", "Updated", "Qty", "Piyasa", "BM", "â†—"];
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

/* Flip defteri: planlanan â†’ yapilan islemler, gercek kar/zarar */
let LEDGER = (() => { try { return JSON.parse(localStorage.getItem("albionLedger") || "[]"); } catch (e) { return []; } })();
function ledgerSave() {
  try { localStorage.setItem("albionLedger", JSON.stringify(LEDGER.slice(0, 500))); } catch (e) { }
}
function ledgerAdd(x) {
  LEDGER.unshift({
    at: Date.now(), id: x.id, name: x.name, q: Number(x.q) || 1,
    buyCity: x.buyCity, buyPrice: x.buyPrice, sellCity: x.sellCity, sellPrice: x.sellPrice,
    kind: x.kind, qty: 1, plan: Math.round(x.net), status: "PlanlandÄ±", real: null,
  });
  ledgerSave();
  const info = $("scanInfo");
  if (info) info.textContent = "Deftere eklendi: " + (x.name || x.id);
}
function ledgerStats() {
  const open = LEDGER.filter(z => z.status === "PlanlandÄ±");
  const done = LEDGER.filter(z => z.status === "YapÄ±ldÄ±");
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
    body.innerHTML = `<tr><td colspan="10" class="muted">Defter boÅŸ â€” tarama satÄ±rÄ±ndaki + butonuyla iÅŸlem ekle.</td></tr>`;
  } else {
    body.innerHTML = LEDGER.map((z, i) => `
    <tr data-li="${i}">
      <td class="muted small">${fmtDate(new Date(z.at), true)}</td>
      <td><span class="item-name">${esc(z.name || z.id)}</span>${Number(z.q) > 1 ? ` <span class="muted small">Q${z.q}</span>` : ""}</td>
      <td class="muted small">${esc(z.buyCity)} â†’ ${esc(z.sellCity)}</td>
      <td class="num"><input type="number" min="1" step="1" value="${z.qty || 1}" data-ed="qty" style="width:52px"></td>
      <td class="num">${fmtShort(z.buyPrice)}</td>
      <td class="num">${fmtShort(z.sellPrice)}</td>
      <td class="num ${z.plan >= 0 ? "profit-positive" : "profit-negative"}">${fmtShort(z.plan)}</td>
      <td><select data-ed="status">
        <option${z.status === "PlanlandÄ±" ? " selected" : ""}>PlanlandÄ±</option>
        <option${z.status === "YapÄ±ldÄ±" ? " selected" : ""}>YapÄ±ldÄ±</option>
        <option${z.status === "Ä°ptal" ? " selected" : ""}>Ä°ptal</option>
      </select></td>
      <td class="num"><input type="number" step="100" value="${z.real ?? ""}" placeholder="${z.plan}" data-ed="real" style="width:90px"></td>
      <td><button type="button" class="detail-btn" data-del="${i}" title="Defterden sil">âœ•</button></td>
    </tr>`).join("");
  }
  const s = ledgerStats();
  const box = $("ledgerStatsBox");
  if (box) {
    box.innerHTML = LEDGER.length
      ? `<b>${LEDGER.length}</b> iÅŸlem Â· planlanan Î£ <b class="profit-positive">+${fmtShort(s.planSum)}</b> (${s.open} aÃ§Ä±k) Â· gerÃ§ekleÅŸen Î£ <b class="${s.doneSum >= 0 ? "profit-positive" : "profit-negative"}">${s.doneSum >= 0 ? "+" : "âˆ’"}${fmtShort(Math.abs(s.doneSum))}</b> (${s.done} bitti${s.done ? ` Â· %${Math.round((s.wins / s.done) * 100)} kazanÃ§lÄ±` : ""})`
      : "HenÃ¼z iÅŸlem yok.";
  }
  renderLedgerChart();
}
function exportLedgerCSV() {
  const head = "tarih,item,rota,adet,alis,satis,plan_net,durum,gercek_net";
  const lines = LEDGER.map(z => [
    new Date(z.at).toISOString(),
    '"' + String(z.name || z.id).replace(/"/g, "'") + '"',
    '"' + z.buyCity + " â†’ " + z.sellCity + '"',
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

/* Kar hesaplayici: crafting/refining maliyeti â†’ net kar */
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
      <div class="kpi"><span class="kpi-val" style="color:${col}">${net >= 0 ? "+" : "âˆ’"}${fmtShort(Math.abs(net))}</span><span class="kpi-lab">Toplam net (${fmt(qty)} Ã¼rÃ¼n) <span class="muted">Â· birim ${per >= 0 ? "+" : "âˆ’"}${fmtShort(Math.abs(per))}</span></span></div>
      <div class="kpi"><span class="kpi-val" style="color:${col}">${pct.toFixed(1)}%</span><span class="kpi-lab">Marjin <span class="muted">Â· kÃ¢r / maliyet</span></span></div>
      <div class="kpi"><span class="kpi-val">${fmtShort(cost)}</span><span class="kpi-lab">Toplam maliyet <span class="muted">Â· hammadde ${fmtShort(totalRes)} + Ã¼cret ${fmtShort(fees)}${ship > 0 ? " + nakliye " + fmtShort(ship) : ""}</span></span></div>
    </div>
    <table class="calc-break">
      <tr><td>Hammadde maliyeti (Ã¼rÃ¼n baÅŸÄ±na)</td><td class="num">${fmt(unitRes)}</td></tr>
      <tr><td>BrÃ¼t satÄ±ÅŸ (${fmt(qty)} Ã— ${fmtShort(sell)})</td><td class="num">${fmtShort(gross)}</td></tr>
      ${ship > 0 ? `<tr><td>Nakliye (toplam)</td><td class="num">âˆ’${fmtShort(ship)}</td></tr>` : ""}
      <tr><td>Vergi (%${taxPct}${way === "so" ? " + kuruluÅŸ" : ""})</td><td class="num">âˆ’${fmtShort(taxVal)}</td></tr>
      <tr><td>Net (satÄ±ÅŸ âˆ’ vergi âˆ’ maliyet)</td><td class="num" style="color:${col}">${net >= 0 ? "+" : "âˆ’"}${fmtShort(Math.abs(net))}</td></tr>
    </table>
    ${pos ? "" : `<p class="muted small" style="margin-top:8px">Negatif â€” bu fiyata Ã¼retim zarar. Hammadde fiyatÄ±nÄ± dÃ¼ÅŸÃ¼r, dÃ¶nÃ¼ÅŸ oranÄ±nÄ± yÃ¼kselt veya satÄ±ÅŸ fiyatÄ±nÄ± artÄ±r.</p>`}
  `;
}

/* Item ismi kopyalama: tabloda isme tÄ±kla â†’ panoya alÄ±r (oyun sohbetine yapÄ±ÅŸtÄ±rmak iÃ§in).
   Panoya API yoksa gizli textarea + execCommand yedeÄŸi devreye girer. */
function copyToClipboard(text) {
  const info = $("scanInfo");
  const done = ok => { if (info) info.textContent = ok ? "ğŸ“‹ KopyalandÄ±: " + text : "KopyalanamadÄ± â€” ismi elle seÃ§ip kopyalayÄ±n"; };
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

/* Paylas butonu: site linkini panoya kopyalar â€” Discord'a yapÄ±ÅŸtÄ±rÄ±p arkadaÅŸlara gÃ¶nder */
function shareCopy() {
  const btn = $("shareBtn");
  const url = btn && btn.dataset.share;
  if (!url) return;
  const restore = () => { if (btn) btn.textContent = "ğŸ”— PaylaÅŸ"; };
  const ok = () => {
    if (!btn) return;
    btn.textContent = "âœ“ Link kopyalandÄ± â€” Discord'a yapÄ±ÅŸtÄ±r";
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

/* ================= v21: skor, favoriler + alarm, yedek, hammadde fiyatÄ±,
   kÃ¢r grafiÄŸi, buy order analizi ================= */

/* FÄ±rsat skoru 0-100: likidite (7g hacim, 0-40) Ã— trend (fiyat yÃ¶nÃ¼, 0-20) Ã— marj (0-40).
   Veri yoksa nÃ¶tr-dÃ¼ÅŸÃ¼k puan verir â€” gerÃ§ek veri geldikÃ§e skoru yÃ¼kselir. */
function scoreFor(x) {
  const qkey = qtyKey(x.sellCity, Number(x.q) || 1, x.id);
  const qty = qtyFresh(qkey);
  const trend = mvTrendOf(qkey);
  const marj = x.buyPrice > 0 ? (x.net / x.buyPrice) * 100 : 0;
  let lik;
  if (qty === null || qty === undefined) lik = 8;
  else if (qty < 0) lik = 0;   /* veri yok (-1) â†’ skor bilinmiyor, dÃ¼ÅŸÃ¼k baÅŸlar */
  else if (qty <= 0) lik = 0;
  else lik = Math.min(40, (qty / 300) * 40);
  const tr = (typeof trend === "number" && isFinite(trend)) ? Math.max(0, Math.min(20, 10 + trend)) : 10;
  const mr = Math.max(0, Math.min(40, (marj / 100) * 40));
  return Math.round(lik + tr + mr);
}
window.scoreFor = scoreFor;

/* ---------- Favoriler + fiyat alarmÄ± ---------- */
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
    box.innerHTML = `<span class="muted small">Favori yok â€” tabloda â˜…'a bas. Alarm eÅŸiÄŸini yazarsan taramalarda fiyat aÅŸÄ±lÄ±nca bip + bildirim gelir.</span>`;
    return;
  }
  box.innerHTML = FAVORITES.map((f, i) => `
    <div class="fav-item">
      <button type="button" class="detail-btn" data-fopen="${i}" title="ÃœrÃ¼n detayÄ±nÄ± aÃ§">â†—</button>
      <span class="fav-name" title="${esc(f.id)}">${esc(f.name || f.id)}${Number(f.q) > 1 ? ` <span class="muted small">Q${f.q}</span>` : ""}</span>
      <input type="number" min="0" step="10000" placeholder="alarm net â‰¥" value="${f.th || ""}" data-fth="${i}" title="Taramada bu netin Ã¼stÃ¼nde fÄ±rsat varsa bip + bildirim (30 dk'da bir)">
      <button type="button" class="detail-btn" data-fdel="${i}" title="Favoriden Ã§Ä±kar">âœ•</button>
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
      hits.push(`${f.name || f.id}: net â‰¥ ${fmt(Math.max(...found.map(x => x.net)))} (${found[0].buyCity} â†’ ${found[0].sellCity})`);
    }
  });
  if (!hits.length) return;
  try { localStorage.setItem("albionFavAlerts", JSON.stringify(favAlerts)); } catch (e) { /* kota */ }
  beep(1040);
  try { if (window.Notification && Notification.permission === "granted") new Notification("â­ Favori alarm", { body: hits.join("\n") }); } catch (e) { /* yok */ }
  const info = $("scanInfo");
  if (info) info.textContent = "â­ FAVORÄ° ALARM â€” " + hits.join(" Â· ");
  document.title = "ğŸ”” Favori alarm â€” Albion";
  setTimeout(() => { document.title = "Dr aLabeen â€” Albion Pazar Analiz"; }, 40000);
}

/* ---------- Yedek indir / geri yÃ¼kle (JSON) ---------- */
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
  if (info) info.textContent = "ğŸ’¾ Yedek indirildi (defter + favoriler + profiller + ayarlar).";
}
function restorePlainObject(value, maxKeys = 500) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const keys = Object.keys(value);
  if (keys.length > maxKeys) return null;
  const safe = Object.create(null);
  for (const key of keys) {
    if (["__proto__", "prototype", "constructor"].includes(key)) return null;

    safe[key] = value[key];
  }
  return safe;
}
function restoreString(value, maxLength = 200) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}
function restoreNumber(value, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function restoreLedger(value) {
  if (!Array.isArray(value) || value.length > 500) return null;
  const rows = [];
  for (const input of value) {
    const row = restorePlainObject(input, 20);
    if (!row || !restoreNumber(row.at, 0, Date.now() + 86400000) ||
        !restoreString(row.id, 100) || !/^[A-Z0-9_@.-]+$/.test(row.id) ||
        (row.name !== undefined && !restoreString(row.name, 200)) ||
        !Number.isInteger(row.q) || !restoreNumber(row.q, 1, 5) ||
        !restoreString(row.buyCity, 40) || !restoreString(row.sellCity, 40) ||
        !restoreNumber(row.buyPrice, 0) || !restoreNumber(row.sellPrice, 0) ||
        !["Emir â†’ Emir", "Emir â†’ SatÄ±ÅŸ emri"].includes(row.kind) ||
        !restoreNumber(row.qty, 1, 1000000) || !restoreNumber(row.plan) ||
        !["PlanlandÄ±", "YapÄ±ldÄ±", "Ä°ptal"].includes(row.status) ||
        !(row.real === null || restoreNumber(row.real))) return null;
    rows.push({ at: row.at, id: row.id, name: row.name || row.id, q: row.q,
      buyCity: row.buyCity, buyPrice: row.buyPrice, sellCity: row.sellCity,
      sellPrice: row.sellPrice, kind: row.kind, qty: row.qty, plan: row.plan,
      status: row.status, real: row.real });
  }
  return rows;
}
function restoreFavorites(value) {
  if (!Array.isArray(value) || value.length > 500) return null;
  const rows = [];
  for (const input of value) {
    const row = restorePlainObject(input, 10);
    if (!row || !restoreString(row.id, 100) || !/^[A-Z0-9_@.-]+$/.test(row.id) ||
        !Number.isInteger(row.q) || !restoreNumber(row.q, 1, 5) ||
        (row.name !== undefined && !restoreString(row.name, 200)) ||
        !restoreNumber(row.th, 0) ||
        (row.at !== undefined && !restoreNumber(row.at, 0, Date.now() + 86400000))) return null;
    rows.push({ id: row.id, q: row.q, name: row.name || row.id, th: row.th, at: row.at || Date.now() });
  }
  return rows;
}
function restorePrefs(value) {
  const input = restorePlainObject(value, 32);
  if (!input) return null;
  const allowed = {
    item: v => restoreString(v, 100) && /^T[1-8]_[A-Z0-9_]+(?:@[1-5])?$/.test(v),
    quality: v => typeof v === "string" && /^[1-5]$/.test(v),
    salesTax: v => restoreNumber(v, 0, 100),
    setupFee: v => restoreNumber(v, 0, 100),
    blackMarket: v => typeof v === "boolean",
    timescale: v => [1, 6, 24].includes(v),
    server: v => ["europe", "west"].includes(v),
  };
  const safe = Object.create(null);
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(allowed, key) || !allowed[key](input[key])) return null;
    safe[key] = input[key];
  }
  return safe;
}
function restoreProfiles(value) {
  const input = restorePlainObject(value, 100);
  if (!input) return null;
  const safe = Object.create(null);
  for (const [name, profile] of Object.entries(input)) {
    const checked = validProfile(profile);
    if (!name.trim() || name.trim() !== name || name.length > 40 || !checked) return null;
    safe[name] = checked;
  }
  return safe;
}
function restoreAlerts(value) {
  const input = restorePlainObject(value, 500);
  if (!input) return null;
  const safe = Object.create(null);
  for (const [key, at] of Object.entries(input)) {
    if (!restoreString(key, 150) || !restoreNumber(at, 0, Date.now() + 86400000)) return null;
    safe[key] = at;
  }
  return safe;
}
function restoreAll(p) {
  const info = $("scanInfo");
  const root = restorePlainObject(p, 20);
  if (!root || root.app !== "albion-dashboard" || root.v !== 21 || !Number.isInteger(root.v)) {
    if (info) info.textContent = "Geçersiz yedek dosyası: desteklenmeyen şema veya sürüm.";
    return;
  }
  // Validate every supplied data set before the first state or storage write.
  const ledger = restoreLedger(root.ledger);
  const favorites = restoreFavorites(root.favorites);
  const prefs = root.prefs === undefined ? undefined : restorePrefs(root.prefs);
  const profiles = root.profiles === undefined ? undefined : restoreProfiles(root.profiles);
  const columns = root.hiddenCols === undefined ? undefined :
    (Array.isArray(root.hiddenCols) && root.hiddenCols.length <= 14 && root.hiddenCols.every(n => Number.isInteger(n) && n >= 0 && n < 14)
      ? [...new Set(root.hiddenCols)] : null);
  const alerts = root.favAlerts === undefined ? undefined : restoreAlerts(root.favAlerts);
  const errors = [];
  if (ledger === null) errors.push("defter");
  if (favorites === null) errors.push("favoriler");
  if (root.prefs !== undefined && prefs === null) errors.push("ayarlar");
  if (root.profiles !== undefined && profiles === null) errors.push("profiller");
  if (root.hiddenCols !== undefined && columns === null) errors.push("gizli sütunlar");
  if (root.favAlerts !== undefined && alerts === null) errors.push("favori alarmları");
  if (root.albionAuto !== undefined && !(typeof root.albionAuto === "string" && ["0", "1"].includes(root.albionAuto))) errors.push("otomatik tarama");
  if (errors.length) {
    if (info) info.textContent = `Yedek geri yüklenmedi: geçersiz veri (${errors.join(", ")}).`;
    return;
  }
  const writes = [
    ["albionLedger", JSON.stringify(ledger.slice(0, 500))],
    ["albionFavorites", JSON.stringify(favorites.slice(0, 200))],
  ];
  if (profiles !== undefined) writes.push(["albionProfiles", JSON.stringify(profiles)]);
  if (columns !== undefined) writes.push(["albionHiddenCols", JSON.stringify(columns)]);
  if (root.albionAuto !== undefined) writes.push(["albionAuto", root.albionAuto]);
  if (alerts !== undefined) writes.push(["albionFavAlerts", JSON.stringify(alerts)]);
  if (prefs !== undefined) writes.push(["albionDash", JSON.stringify({ ...state, ...prefs })]);
  let previous;
  try {
    previous = writes.map(([key]) => [key, localStorage.getItem(key)]);
  } catch (e) {
    if (info) info.textContent = "Yedek geri yüklenemedi; tarayıcı deposu okunamadı: " + (e && e.message || e);
    return;
  }
  let written = 0;
  try {
    for (const [key, value] of writes) {
      localStorage.setItem(key, value);
      written++;
    }
  } catch (e) {
    for (let i = written - 1; i >= 0; i--) {
      const [key, value] = previous[i];
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch (rollbackError) { /* Best-effort rollback if storage remains unavailable. */ }
    }
    if (info) info.textContent = "Yedek geri yüklenemedi; tarayıcı deposuna yazılamadı: " + (e && e.message || e);
    return;
  }

  LEDGER = ledger;
  FAVORITES = favorites;
  if (profiles !== undefined) profFillSel();
  if (prefs !== undefined) {
    const qualityEl = $("quality"); if (qualityEl) qualityEl.value = state.quality;
    const itemEl = $("item"); if (itemEl) itemEl.value = state.item;
    const bmEl = $("includeBlackMarket"); if (bmEl) bmEl.checked = state.blackMarket;
    const scaleEl = $("timescale"); if (scaleEl) scaleEl.value = String(state.timescale);
  }
  if (columns !== undefined) { hiddenCols = columns; applyHiddenCols(); }
  if (root.albionAuto !== undefined) {
    const cb = $("autoScan");
    if (cb) { cb.checked = root.albionAuto === "1"; if (cb.checked) setAutoTimer(); else if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }
  }
  if (alerts !== undefined) favAlerts = alerts;
  if (prefs !== undefined) {
    for (const key of Object.keys(prefs)) state[key] = prefs[key];
    const tx = $("salesTax"); if (tx) tx.value = state.salesTax;
    const tm = $("taxMode"); if (tm) tm.value = String(state.salesTax);
    const sx = $("setupFee"); if (sx) sx.value = state.setupFee;
  }
  if (scanState.flips.length) {
    const tax = Number(state.salesTax), fee = Number(state.setupFee);
    const t1 = 1 - tax / 100, t2 = 1 - (tax + fee) / 100;
    scanState.flips = scanState.flips.map(x => {
      const net = x.kind === "Emir ��' Emir" ? x.sellPrice * t1 - x.buyPrice
        : ((mvFresh(qtyKey(x.sellCity, Number(x.q) || 1, x.id)) ?? x.sellPrice) * t2 - x.buyPrice);
      return { ...x, net, pct: x.buyPrice ? (net / x.buyPrice) * 100 : 0 };
    }).sort((a, b) => b.net - a.net);
    applyFilters();
  }
  renderFavPanel();
  renderLedger();
  if (info) info.textContent = "Yedek geri yüklendi (defter + favoriler + profiller + ayarlar).";
}
/* ---------- Hesap sekmesi: hammadde fiyatÄ±nÄ± AODP'den Ã§ek ---------- */
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
    || `<div class="sr-item"><span class="muted">SonuÃ§ yok â€” kod yaz (Ã¶rn. T6_ORE)</span></div>`;
  box.classList.remove("hidden");
  box.querySelectorAll("[data-cid]").forEach(el => el.addEventListener("click", () => {
    calcItemSel = el.dataset.cid;
    try { localStorage.setItem("albionCalcItem", calcItemSel); } catch (e) { }
    $("calcItem").value = "";
    box.classList.add("hidden");
    $("calcItemInfo").textContent = calcItemSel + " â€” fiyat Ã§ekiliyorâ€¦";
    calcFetchPrice();
  }));
}
async function calcFetchPrice() {
  const btn = $("calcFetch"), info = $("calcItemInfo");
  if (!btn || !info) return;
  btn.disabled = true;
  btn.textContent = "â€¦ Ã§ekiliyor";
  try {
    const url = `${API}/prices/${encodeURIComponent(calcItemSel)}?locations=${encodeURIComponent(ROYAL.join(","))}&qualities=1`;
    const rows = await fetchJSON429(url);
    const cands = (rows || []).filter(r => r.sell_price_min > 0).sort((a, b) => a.sell_price_min - b.sell_price_min);
    if (cands.length) {
      $("calcRes").value = Math.round(cands[0].sell_price_min);
      info.textContent = `${calcItemSel} â†’ en ucuz ${cands[0].city}: ${fmt(cands[0].sell_price_min)} (kalite 1)`;
      computeCalc();
    } else {
      info.textContent = `${calcItemSel} iÃ§in satÄ±ÅŸ verisi yok â€” elle yaz.`;
    }
  } catch (e) {
    info.textContent = "Fiyat Ã§ekilemedi: " + (e && e.message || e);
  }
  btn.disabled = false;
  btn.textContent = "ğŸ”„ Hammadde fiyatÄ±nÄ± Ã§ek";
}

/* ---------- KÃ¢r grafiÄŸi (defter): gÃ¼nlÃ¼k birikimli kÃ¢r ---------- */
function renderLedgerChart() {
  const el = $("ledgerChart");
  if (!el) return;
  const realOf = z => (z.real === null || z.real === undefined || z.real === "") ? z.plan : Number(z.real);
  const done = LEDGER.filter(z => z.status === "YapÄ±ldÄ±").slice().sort((a, b) => a.at - b.at);
  const topBox = $("ledgerTop");
  if (!done.length) {
    el.innerHTML = `<div class="muted chart-placeholder">Ä°ÅŸlemleri "YapÄ±ldÄ±" iÅŸaretleyip gerÃ§ek netleri yazÄ±nca gÃ¼nlÃ¼k birikimli kÃ¢r grafiÄŸi burada oluÅŸur.</div>`;
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
  if (typeof lineChart === "function") lineChart("ledgerChart", data, { h: 170, unit: "gÃ¼mÃ¼ÅŸ (birikimli)" });
  if (topBox) {
    const top = [...byItem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    topBox.innerHTML = "En Ã§ok kazandÄ±ran: " + top.map(([n, v]) => `${esc(n)} <b class="profit-positive">+${fmtShort(v)}</b>`).join(" Â· ");
  }
}

/* ---------- Buy Order analizi: hangi iteme buy order kurmak mantÄ±klÄ± ---------- */
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
      const qty = qtyFresh(qtyKey(v.city, q, id));    /* bu ÅŸehirde 7g'de buy'lara satÄ±lan */
      if (qty === null || qty < minQty) return;       /* hacim eÅŸiÄŸi: emrin dolma olasÄ±lÄ±ÄŸÄ± */
      let net = -Infinity, sellPrice = 0, how = "";
      if (v.sm > 0) {                                  /* yol A: aynÄ± ÅŸehirde satÄ±ÅŸ emri kur */
        net = v.sm * t2 - v.bm;
        sellPrice = v.sm;
        how = "sat emri (aynÄ± ÅŸehir)";
      }
      const others = rs.filter(o => o.city !== v.city && o.bm > 0);
      if (others.length) {                             /* yol B: BM/baÅŸka ÅŸehrin anlÄ±k alÄ±cÄ±sÄ±na sat */
        const best = others.reduce((p, c) => (c.bm > p.bm ? c : p));
        const nB = best.bm * t1 - v.bm;
        if (nB > net) { net = nB; sellPrice = best.bm; how = "anlÄ±k " + best.city + (best.city === "Black Market" ? " (BM)" : ""); }
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
  if (count) count.textContent = rows.length ? `${fmt(rows.length)} kurulum Â· skora gÃ¶re sÄ±ralÄ±` : "";
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="8" class="muted">Uygun kurulum yok â€” tarama yap (analiz taramadan beslenir), hacim eÅŸiÄŸini dÃ¼ÅŸÃ¼r ya da hacim verisinin dolmasÄ±nÄ± bekle. ${BO_RAW.size ? "Hacim verisi arka planda dolar (oyuncular pazarÄ± gezdikÃ§e)." : "Buy order verisi henÃ¼z yok."}</td></tr>`;
    return;
  }
  const cls = s => s >= 70 ? "score-hi" : s >= 40 ? "score-mid" : "score-lo";
  body.innerHTML = rows.slice(0, 80).map(x => {
    const shortName = String(x.name || "").replace(/^T\d+\s*/, "");
    const mCls = x.pct >= 40 ? "margin-badge margin-high" : x.pct >= 15 ? "margin-badge margin-medium" : "margin-badge margin-low";
    /* v24: kopyaya tier ekleniyor (Ã¶r. "6.3 Grandmaster's Cape") */
    const tp = tierPretty(x.id);
    return `
    <tr class="scan-row">
      <td><div class="item-cell">
        <img loading="lazy" alt="" class="item-icon" src="https://render.albiononline.com/v2/item/${esc(x.id)}.png?size=32" onerror="this.style.display='none'">
        <span><span class="item-name copyname" data-copyname="${esc(shortName)}" data-copyfull="${esc(tp + ' ' + shortName)}" data-copyid="${esc(x.id)}" title="TÄ±kla: ismi kopyala Â· Shift+tÄ±k: item kodu">${esc(x.name)}</span></span>
      </div></td>
      <td><span class="city-tag city-${esc(x.city.replace(/\s/g, ""))}">${esc(x.city)}</span></td>
      <td class="num price" title="Son 7 gÃ¼nde bu ÅŸehirde buy order'lara satÄ±lan adet">${fmt(x.qty)} <span class="muted small">Â· 7g</span></td>
      <td class="num price" title="Emri bu fiyattan kur (ÅŸu anki en yÃ¼ksek buy order)">${fmtShort(x.kur)}</td>
      <td class="num"><span class="price">${fmtShort(x.sellPrice)}</span> <span class="muted small">${esc(x.how)}</span></td>
      <td class="num price profit-positive">+${fmtShort(x.net)}</td>
      <td class="num"><span class="${mCls}">${x.pct.toFixed(1)}%</span></td>
      <td class="num score-cell"><span class="score-b ${cls(x.score)}" title="Skor: likidite Ã— trend Ã— marj">${x.score}</span></td>
    </tr>`;
  }).join("");
}
window.renderBO = renderBO;
