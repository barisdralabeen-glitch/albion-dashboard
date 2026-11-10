/* Albion Pazar Takip — Europe (AODP) canlı veri paneli */
"use strict";

/* API: seçili AODP sunucusu (albionanalyser'daki server dropdown gibi) */
function aodpBase(server) {
  return `https://${server}.albion-online-data.com/api/v2/stats`;
}
let API = aodpBase(localStorage.getItem("albionServer") || "europe");
const ROYAL = ["Caerleon", "Bridgewatch", "Lymhurst", "Martlock", "Thetford", "Fort Sterling", "Brecilien"];

/* ---------- Ürün kataloğu ---------- */
const RAW = [
  ["ORE", "Cevher"], ["WOOD", "Odun"], ["FIBER", "Lif"], ["HIDE", "Ham Deri"], ["STONE", "Taş"],
];
const REFINED = [
  ["METALBAR", "Metal Kütüğü"], ["PLANKS", "Tahta"], ["CLOTH", "Kumaş"], ["LEATHER", "İşlenmiş Deri"], ["BRICK", "Tuğla"],
];
const EXTRAS = [
  ["BAG", "Çanta"], ["CAPE", "Pelerin"], ["JOURNAL", "Günlük (boş)"], ["HORSE", "At"], ["OX", "Öküz"], ["BARREL", "Nakliye Fıçısı"],
];

const CATALOG = [];
for (let t = 2; t <= 8; t++) {
  RAW.forEach(([f, n]) => CATALOG.push({ id: `T${t}_${f}`, name: `T${t} ${n}`, group: "Ham Madde" }));
  REFINED.forEach(([f, n]) => CATALOG.push({ id: `T${t}_${f}`, name: `T${t} ${n}`, group: "İşlenmiş" }));
}
for (let t = 2; t <= 8; t++) {
  EXTRAS.forEach(([f, n]) => CATALOG.push({ id: `T${t}_${f}`, name: `T${t} ${n}`, group: `T${t} Diğer` }));
}
const BY_ID = Object.fromEntries(CATALOG.map(c => [c.id, c]));

/* ---------- Durum ---------- */
const state = {
  item: "T4_BAG",
  quality: "1",
  salesTax: 4,
  setupFee: 2.5,
  blackMarket: false,
  timescale: 24,
};

const $ = id => document.getElementById(id);
const fmt = n => (n === null || n === undefined || !isFinite(n)) ? "—" : new Intl.NumberFormat("tr-TR").format(Math.round(n));
const fmtSilver = n => fmt(n) + " gümüş";
const pareDate = s => new Date(s.endsWith("Z") ? s : s + "Z");

/* Albion kalite adları (oyun içi EN adlarıyla aynı) */
const QUALITY_NAMES = { 1: "Normal", 2: "Good", 3: "Outstanding", 4: "Excellent", 5: "Masterpiece" };
window.QUALITY_NAMES = QUALITY_NAMES;

/* Tier.enchant: T6_2H_CLAWPAIR@3 → "6.3" (enchantsız → "6.0") */
function tierPretty(id) {
  const m = String(id).match(/^T(\d)[^@]*@(\d+)$/);
  if (m) return `${m[1]}.${m[2]}`;
  const t = String(id).match(/^T(\d)/);
  return t ? `${t[1]}.0` : "";
}
window.tierPretty = tierPretty;

/* ---------- Ayarları sakla ---------- */
function loadPrefs() {
  try {
    const s = JSON.parse(localStorage.getItem("albionDash") || "{}");
    Object.assign(state, s);
  } catch (e) { /* yoksay */ }
}
function savePrefs() {
  localStorage.setItem("albionDash", JSON.stringify(state));
}

/* ---------- Veri ---------- */
/* ---------- Veri ----------
   Önce doğrudan API denenir; tarayıcı engellerse (CORS) otomatik olarak
   yerel sunucunun /proxy yoluna geçilir (serve.ps1 çalışırken). */
let USE_PROXY = false;

function proxied(url) {
  return "/proxy?url=" + encodeURIComponent(url);
}

async function fetchJSON(url) {
  const target = USE_PROXY ? proxied(url) : url;
  let r;
  try {
    r = await fetch(target, { headers: { Accept: "application/json" } });
  } catch (err) {
    // Genelde CORS/ağ hatası — yerel proxy'e geç
    if (!USE_PROXY) { USE_PROXY = true; return fetchJSON(url); }
    throw new Error("Bağlantı başarısız — serve.ps1 çalışıyor mu?");
  }
  if (!r.ok) throw new Error(`API hatası (${r.status})`);
  return r.json();
}

/* AODP istek kapısı: 429 Too Many Requests'e takılmamak için
   istekler arası min aralık + 429 gelince soğuma ve tekrar deneme. */
let __aodpLast = 0, __aodpCoolUntil = 0;
async function aodpGate() {
  for (;;) {
    const now = Date.now();
    if (now < __aodpCoolUntil) { await new Promise(res => setTimeout(res, Math.min(__aodpCoolUntil - now, 900))); continue; }
    const gap = now - __aodpLast;
    if (gap < 350) await new Promise(res => setTimeout(res, 350 - gap));
    __aodpLast = Date.now();
    return;
  }
}
async function fetchJSON429(url, tries = 6) {
  const t0 = USE_PROXY, target0 = proxied(url);
  const attempt = async (target) => {
    await aodpGate();
    let resp;
    try { resp = await fetch(target, { headers: { Accept: "application/json" } }); }
    catch (err) {
      if (!USE_PROXY) { USE_PROXY = true; }   // Doğrudan API engellendiyse kalıcı olarak proxy'e geç
      else throw new Error("Bağlantı başarısız — serve.ps1 çalışıyor mu?");
      return attempt(target0);
    }
    if (resp.status === 429) throw new Error("API hatası (429)");
    if (!resp.ok) throw new Error(`API hatası (${resp.status})`);
    return resp.json();
  };
  for (let t = 1; t <= tries; t++) {
    try { return await attempt(USE_PROXY ? target0 : url); }
    catch (e) {
      const msg = String(e && e.message || e);
      if (msg.includes("(429)") && t < tries) { __aodpCoolUntil = Date.now() + 6000 * t; continue; }
      if (t < tries && (msg.includes("(502)") || msg.includes("(504)"))) { __aodpCoolUntil = Date.now() + 2500 * t; continue; }
      throw e;
    }
  }
}

function cities() {
  return state.blackMarket ? ROYAL.concat(["Black Market"]) : ROYAL;
}

async function loadPrices() {
  setBusy("Fiyatlar yükleniyor…");
  const url = `${API}/prices/${state.item}?locations=${encodeURIComponent(cities().join(","))}&qualities=1,2,3,4,5`;
  const rows = await fetchJSON429(url);  state.priceRows = rows.map(r => ({
    q: r.quality,
    city: r.city,
    sellMin: r.sell_price_min || 0,
    sellMax: r.sell_price_max || 0,
    buyMax: r.buy_price_max || 0,
    sellDate: r.sell_price_min_date,
    buyDate: r.buy_price_max_date,
  }));
}

async function loadHistory() {
  if ($("dataStatus")?.dataset.abort) return;
  setBusy("Geçmiş yükleniyor…");
  const url = `${API}/history/${state.item}?locations=${encodeURIComponent(cities().join(","))}&qualities=1,2,3,4,5&time-scale=${state.timescale}`;
  const data = await fetchJSON429(url);
  const byTime = new Map();
  /* Şehir bazında gerçek satış: son 14 veri noktası (günlük modda 14 gün) */
  const LOC = { 1002: "Caerleon", 2001: "Fort Sterling", 2002: "Lymhurst", 2003: "Martlock", 2004: "Bridgewatch", 2005: "Thetford", 3005: "Black Market" };
  state.salesByCity = data
    .map(entry => {
      const cityName = LOC[Number(entry.location)] || String(entry.location ?? "");
      const days = (entry.data || []).filter(d => d.item_count > 0);
      const totalSold = days.reduce((n, d) => n + d.item_count, 0);
      const revenue = days.reduce((n, d) => n + d.item_count * d.avg_price, 0);
      const last = days.length ? days[days.length - 1] : null;
      return {
        city: cityName,
        q: entry.quality,
        totalSold,
        revenue,
        vwap: totalSold ? revenue / totalSold : 0,
        lastT: last ? pareDate(last.timestamp) : null,
        lastSold: last ? last.item_count : 0,
        lastPrice: last ? last.avg_price : 0,
        days: days.length,
        series: days.slice(-14).map(d => ({ t: pareDate(d.timestamp), price: d.avg_price, count: d.item_count })),
      };
    })
    .filter(c => c.totalSold > 0 && Object.values(LOC).includes(c.city))
    .sort((a, b) => b.totalSold - a.totalSold);
  data.forEach(entry => {
    (entry.data || []).forEach(d => {
      const prev = byTime.get(d.timestamp) || { price: 0, count: 0, n: 0 };
      prev.price += d.avg_price; prev.count += d.item_count; prev.n++;
      byTime.set(d.timestamp, prev);
    });
  });
  state.history = [...byTime.entries()]
    .map(([t, v]) => ({ t: pareDate(t), price: v.price / v.n, count: v.count }))
    .sort((a, b) => a.t - b.t);
}

async function loadGold() {
  const gold = await fetchJSON429(`${API}/gold?count=64`);
  state.gold = gold
    .map(g => ({ t: pareDate(g.timestamp), price: g.price }))
    .sort((a, b) => a.t - b.t);
}

/* ---------- Kırmız hesabı ---------- */
function computeFlips() {
  const rows = (state.priceRows || []).filter(r => r.q === Number(state.quality)).filter(r => r.city !== "Black Market");
  const sellers = rows.filter(r => r.sellMin > 0);
  const buyers = rows.filter(r => r.buyMax > 0);
  const net1 = x => x * (1 - state.salesTax / 100); // emre anında satış
  const net2 = x => x * (1 - (state.salesTax + state.setupFee) / 100); // satış emri kurulur
  const flips = [];
  sellers.forEach(a => buyers.forEach(b => {
    if (a.city === b.city) return;
    const gross = b.buyMax - a.sellMin;
    if (gross <= 0) return;
    const net = net1(b.buyMax) - a.sellMin;
    if (net > 0) flips.push({
      kind: "Emir → Emir", buy: a, sell: b, net, pct: (net / a.sellMin) * 100, tax: net1(b.buyMax) - b.buyMax,
    });
  }));
  const sellRows = rows.filter(r => r.sellMin > 0);
  sellRows.forEach(a => sellRows.forEach(b => {
    if (a.city === b.city || b.sellMin <= a.sellMin) return;
    const net = net2(b.sellMin) - a.sellMin;
    if (net <= 0) return;
    flips.push({
      kind: "Emir → Satış emri", buy: a, sell: b, net, pct: (net / a.sellMin) * 100, tax: net2(b.sellMin) - b.sellMin,
    });
  }));
  flips.sort((x, y) => y.net - x.net);
  const seen = new Set(), uniq = [];
  flips.forEach(f => {
    const key = f.buy.city + ">" + f.sell.city + ">" + f.kind;
    if (seen.has(key)) return; seen.add(key); uniq.push(f);
  });
  return uniq.slice(0, 3);
}

/* ---------- Çizim ---------- */
function setBusy(text, cls) {
  const el = $("dataStatus");
  el.textContent = text;
  el.className = "status-badge muted" + (cls ? " " + cls : "");
  if (cls === undefined && text !== "Hazır") el.classList.add("loading");
}

function renderItemHeader() {
  const fallback = BY_ID[state.item] || { name: state.item, group: "Özel" };
  const nice = window.itemNameResolve ? window.itemNameResolve(state.item) : null;
  const c = (nice && nice !== state.item) ? { ...fallback, name: nice } : fallback;
  $("itemName").textContent = c.name;
  $("itemCode").textContent = `${state.item} · ${c.group}${tierPretty(state.item) ? " · T" + tierPretty(state.item) : ""} · ${QUALITY_NAMES[Number(state.quality)] || "Q" + state.quality}`;

  const icon = $("itemIcon"), badge = $("itemBadge");
  icon.style.display = "";
  badge.classList.add("hidden");
  icon.src = `https://render.albiononline.com/v2/item/${state.item}.png?quality=1&size=64`;
  icon.alt = c.name;
  icon.onerror = () => {
    icon.style.display = "none";
    badge.classList.remove("hidden");
    badge.textContent = (state.item.match(/^T\d*/) || ["◈"])[0];
  };
}

function renderPrices() {
  let rows = (state.priceRows || []).filter(r => r.q === Number(state.quality));
  rows = rows.filter(r => r.city !== "Black Market" || state.blackMarket);
  const body = $("priceBody");
  if (!rows.length) {
    const qs = [...new Set((state.priceRows || []).filter(r => r.sellMin > 0 || r.buyMax > 0).map(r => r.q))].sort((a, b) => a - b);
    body.innerHTML = `<tr><td colspan="5" class="muted">${qs.length
      ? `Bu kalitede (Q${state.quality}) işlem yok — veri olan kaliteler: ` + qs.map(q => `<button class="chip" type="button" onclick="setQuality(${q})">Q${q} — ${QUALITY_NAMES[q]}</button>`).join(" ")
      : "Bu ürün için veri bulunamadı. Oyunda pazar penceresinde pazar penceresi açılınca AODP verisi yükler."}</td></tr>`;
    return;
  }
  body.innerHTML = rows.map(r => {
    const sellCell = r.sellMin > 0 ? `${fmt(r.sellMin)} <span class="muted small">–</span> ${fmt(r.sellMax)}` : `<span class="muted">—</span>`;
    const buyCell = r.buyMax > 0 ? fmt(r.buyMax) : `<span class="muted">emir yok</span>`;
    const dates = [r.sellDate, r.buyDate]
      .filter(d => d && !d.startsWith("0001"))
      .map(pareDate)
      .filter(d => !isNaN(d.getTime()));
    const ageText = dates.length ? ageOf(Math.max(...dates.map(d => d.getTime()))) : `<span class="muted">veri yok</span>`;
    /* Gerçek satış: aynı şehir+kayıt kalitesinde son 3 günün işlem ortalaması */
    const realSale = (state.salesByCity || []).find(c => c.city === r.city && c.q === Number(state.quality));
    const realCell = realSale
      ? `<span class="age-fresh">~${fmt(realSale.vwap)}</span> <span class="muted small">· ${fmt(realSale.totalSold)} adet</span>`
      : `<span class="muted">—</span>`;
    return `<tr><td><div class="city-cell"><span class="city-tag city-${escCity(r.city).replace(/\s/g, "")}">${escCity(r.city)}</span></div></td><td class="num price">${sellCell}</td><td class="num price">${buyCell}</td><td>${ageText}</td><td class="num price">${realCell}</td></tr>`;
  }).join("");
}

/* Kaliteyi değiştirmede merkezi nokta (çipler ve tarayıcı satır tıklaması kullanır) */
function setQuality(q) {
  state.quality = String(q);
  const sel = $("quality");
  if (sel) sel.value = state.quality;
  savePrefs();
  refresh();
}
window.setQuality = setQuality;

function ageOf(ms) {
  const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  const live = mins < 120;
  return `<span class="${live ? "ok" : "muted"}">${live ? "● " : "○ "}${mins < 60 ? mins + " dk" : Math.floor(mins / 60) + " sa"}</span>`;
}

function renderKPIs() {
  const rows = (state.priceRows || []).filter(r => r.q === Number(state.quality));
  const sellers = rows.filter(r => r.sellMin > 0);
  const buyers = rows.filter(r => r.buyMax > 0);
  const bestSell = sellers.reduce((p, c) => (c.sellMin < p.sellMin ? c : p), sellers[0]);
  const bestBuy = buyers.reduce((p, c) => (c.buyMax > p.buyMax ? c : p), buyers[0]);
  const top = (state.flips || [])[0];
  let html = "";
  if (bestSell) html += kpiHTML("En düşük satış", fmtSilver(bestSell.sellMin), `${bestSell.city}`);
  if (bestBuy) html += kpiHTML("En yüksek alış emri", fmtSilver(bestBuy.buyMax), `${bestBuy.city}`);
  if (top) html += kpiHTML("En iyi kırmız (net)", fmtSilver(top.net), `${top.buy.city} → ${top.sell.city}`, "pos");
  $("kpiRow").innerHTML = html || `<span class="muted small">Ölçümlenecek veri yok</span>`;
}

function kpiHTML(lab, val, sub, cls) {
  return `<div class="kpi"><span class="kpi-val ${cls || ""}">${val}</span><span class="kpi-lab">${lab} <span class="muted">· ${sub}</span></span></div>`;
}

/* Gerçek satış analizi: son günlerde kaç adet, hangi fiyattan satıldı */
function renderSales() {
  const list = state.salesByCity || [];
  const body = $("salesBody");
  const summary = $("salesSummary");
  const totN = list.reduce((n, c) => n + c.totalSold, 0);
  const totR = list.reduce((n, c) => n + c.revenue, 0);
  if (summary) {
    const uniqCities = new Set(list.map(c => c.city)).size;
    summary.textContent = list.length
      ? `Toplam ${fmt(totN)} adet · ~${fmt(totR)} gümüş ciro · ${uniqCities} şehir · ${list.length} şehir-kalite satırı`
      : "";
  }
  if (!body) return;
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="6" class="muted small">Son dönemde bu kalitede işlem kaydı yok (veri tazeliği oyuncu tarayıcılarına bağlıdır).</td></tr>`;
    return;
  }
  body.innerHTML = list.map(c => {
    const lastCell = c.lastT ? `${ageAgeOf(c.lastT)} · ${fmt(c.lastSold)} adet @ ${fmt(c.lastPrice)}` : `<span class="muted">—</span>`;
    return `<tr>
      <td><div class="city-cell"><span class="city-tag city-${escCity(c.city).replace(/\s/g, "")}">${escCity(c.city)}</span>${c.q > 1 ? ` <span class="muted small">Q${c.q}</span>` : ""}</div></td>
      <td class="num price"><b>${fmt(c.totalSold)}</b> <span class="muted small">adet</span></td>
      <td class="num price">${fmt(c.vwap)}</td>
      <td>${lastCell}</td>
      <td class="num price">${fmt(c.revenue)}</td>
      <td>${sparklineSVG(c.series)}</td>
    </tr>`;
  }).join("");
}

function escCity(s) {
  return String(s ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

/* Son gerçek satışlar: fiyat grafiğinin altında, son 8 işlem dönem listesi.
   Dürüst etiket: seçili çözünürlükteki (saatlik/6sa/günlük) dönem ortalamaları. */
function renderRecentSales(hs) {
  const el = $("recentSales");
  if (!el) return;
  const pts = (hs || []).filter(d => isFinite(d.price) && d.price > 0 && (d.count || 0) > 0).slice(-8).reverse();
  if (!pts.length) {
    el.innerHTML = `<span class="muted small">İşlem kaydı yok.</span>`;
    return;
  }
  const label = { 1: "saatlik", 6: "6 saatlik", 24: "günlük" }[Number(state.timescale)] || "seçili";
  el.innerHTML = `<span class="muted small" style="flex-basis:100%">Son gerçek satışlar (${label} çözünürlükte, tüm şehirlerin ortalaması — en yenisi başta):</span>`
    + pts.map(d => `<span class="rs-item" title="Bu dönemde ${fmt(d.count)} adet işlem gördü"><b>${fmt(Math.round(d.price))}</b> <span class="muted">· ${fmt(d.count)} adet · ${fmtDate(d.t, true)}</span></span>`).join("");
}

/* Mini grafik (sparkline): son dönem işlem serisi → küçük SVG çizgi + yön yüzdesi */
function sparklineSVG(series, w, h) {
  w = w || 120; h = h || 28;
  const pts = (series || []).filter(d => isFinite(d.price) && d.price > 0);
  if (pts.length < 2) return `<span class="muted">—</span>`;
  const min = Math.min(...pts.map(d => d.price)), max = Math.max(...pts.map(d => d.price));
  const range = max - min || 1;
  const xy = (d, i) => `${((i / (pts.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 3 - ((d.price - min) / range) * (h - 6)).toFixed(1)}`;
  const up = pts[pts.length - 1].price >= pts[0].price;
  const color = up ? "#4ade80" : "#f87171";
  const pct = ((pts[pts.length - 1].price - pts[0].price) / pts[0].price) * 100;
  return `<span class="spark" title="Son dönem işlem fiyatı seyri"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts.map(xy).join(" ")}" fill="none" stroke="${color}" stroke-width="1.6"/></svg> <span class="${up ? "trend-up" : "trend-down"}">${up ? "↗" : "↘"} %${Math.abs(pct).toFixed(0)}</span></span>`;
}
function ageAgeOf(d) {
  const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  return mins < 60 ? `${mins} dk önce` : mins < 1440 ? `${Math.floor(mins / 60)} sa önce` : `${Math.floor(mins / 1440)} gün önce`;
}

function renderFlips() {
  const flips = state.flips || [];
  const list = $("flipList");
  if (!flips.length) {
    list.innerHTML = `<p class="muted small">Şu an kârlı geçiş kalmamış — vergileri değiştirip tekrar deneyin.</p>`;
    return;
  }
  list.innerHTML = flips.map(f => `
    <div class="flip-item">
      <div>
        <div class="flip-route">${f.kind}: <span class="city-tag city-${escCity(f.buy.city).replace(/\s/g, "")}">${escCity(f.buy.city)}</span> <span class="route-arrow">→</span> <span class="city-tag city-${escCity(f.sell.city).replace(/\s/g, "")}">${escCity(f.sell.city)}</span></div>
        <div class="flip-price">${fmt(f.buy.sellMin)} al · ${f.kind === "Emir → Emir" ? fmt(f.sell.buyMax) : fmt(f.sell.sellMin)} sat · vergi ≈ ${fmt(Math.abs(f.tax))}</div>
      </div>
      <div class="flip-profit">
        <span class="amt pos">+${fmt(f.net)}</span>
        <span class="pct muted">%${f.pct.toFixed(1)}</span>
      </div>
    </div>`).join("");
}

/* SVG çizgi grafiği */
function lineChart(elId, data, opts) {
  const el = $(elId);
  el.innerHTML = "";
  if (!data || data.length < 2) {
    el.innerHTML = `<div class="muted chart-placeholder">Grafik için yeterli geçmiş yok</div>`;
    return;
  }
  const W = 900, H = opts.h || 190, padL = 60, padR = 12, padT = 12, padB = 24;
  const xs = i => padL + (i / (data.length - 1)) * (W - padL - padR);
  const min = Math.min(...data.map(d => d.price)), max = Math.max(...data.map(d => d.price));
  const range = max - min || 1;
  const ys = v => padT + (1 - (v - min) / range) * (H - padT - padB);
  const pts = data.map((d, i) => `${xs(i)},${ys(d.price)}`).join(" ");
  const area = `${padL},${H - padB} ${pts} ${W - padR},${H - padB}`;

  const ticks = 3;
  const chartText = "#6e7681";
  let grid = "";
  for (let i = 0; i <= ticks; i++) {
    const v = min + (range * i) / ticks;
    grid += `<line x1="${padL}" x2="${W - padR}" y1="${ys(v)}" y2="${ys(v)}" stroke="rgba(255,255,255,.07)"/>
             <text x="${padL - 6}" y="${ys(v) + 4}" fill="${chartText}" font-size="10" text-anchor="end">${fmt(v)}</text>`;
  }
  const first = data[0].t, last = data[data.length - 1].t;
  const labels = `<text x="${padL}" y="${H - 6}" fill="${chartText}" font-size="10">${fmtDate(first)}</text>
                  <text x="${W - padR}" y="${H - 6}" fill="${chartText}" font-size="10" text-anchor="end">${fmtDate(last)}</text>`;

  el.innerHTML = `
<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" id="${elId}-svg">
  <defs><linearGradient id="g-${elId}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="rgba(212,168,67,.5)"/><stop offset="100%" stop-color="rgba(212,168,67,0)"/>
  </linearGradient></defs>
  ${grid}
  <polygon points="${area}" fill="url(#g-${elId})"/>
  <polyline points="${pts}" fill="none" stroke="#d4a843" stroke-width="2"/>
  ${labels}
  <circle id="${elId}-dot" r="3.5" fill="#fff" stroke="#d4a843" style="display:none"/>
</svg>
<div class="tip-box" id="${elId}-tip"></div>`;

  const svg = $(`${elId}-svg`), dot = $(`${elId}-dot`), tip = $(`${elId}-tip`);
  svg.addEventListener("mousemove", ev => {
    const r = svg.getBoundingClientRect();
    const relX = (ev.clientX - r.left) / r.width * W;
    let idx = Math.round((relX - padL) / ((W - padL - padR) / (data.length - 1)));
    idx = Math.max(0, Math.min(data.length - 1, idx));
    const d = data[idx];
    dot.style.display = "block";
    dot.setAttribute("cx", xs(idx)); dot.setAttribute("cy", ys(d.price));
    dot.style.display = "";
    tip.style.display = "block";
    tip.style.left = `${Math.min(r.width - 130, (xs(idx) / W) * r.width + 10)}px`;
    tip.style.top = `${(ys(d.price) / H) * r.height - 40}px`;
    tip.innerHTML = `<b>${fmt(Math.round(d.price))}</b> ${opts.unit || ""}<br><span class="muted small">${fmtDate(d.t, true)}${d.count ? " · mahsul: " + fmt(d.count) : ""}</span>`;
  });
  svg.addEventListener("mouseleave", () => { dot.style.display = "none"; tip.style.display = "none"; });
}

function fmtDate(d, withHour) {
  const pad = n => String(n).padStart(2, "0");
  const base = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
  return withHour ? `${base} ${pad(d.getHours())}:${pad(d.getMinutes())}` : base;
}

/* ---------- Yükleme akışı ---------- */
let loadToken = 0;

async function refresh() {
  const token = ++loadToken;
  renderItemHeader();
  setBusy("Yükleniyor…");
  $("apiError").textContent = "";
  try {
    await loadPrices();
    state.flips = computeFlips();
    if (token !== loadToken) return;
    renderPrices(); renderKPIs(); renderFlips();
    $("lastUpdated").textContent = "Güncellendi: " + new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
    setBusy("Canlı");
  } catch (err) {
    if (token !== loadToken) return;
    setBusy("Bağlantı hatası", "error");
    $("apiError").textContent = " " + err.message;
    $("priceBody").innerHTML = `<tr><td colspan="5" class="muted">Veri çekilemedi.</td></tr>`;
    return;
  }
  try {
    const h = await loadHistory();
    if (token !== loadToken) return;
    const hs = state.history || [];
    lineChart("historyChart", hs, { h: 190, unit: "gümüş" });
    $("histCaption").textContent = `Ortalama pazar fiyatı toplamda (tüm şehirler)`;
    const total = hs.reduce((n, d) => n + (d.count || 0), 0);
    $("histStats").textContent = hs.length ? `${hs.length} nokta · toplam ${fmt(total)} adet` : "";
    renderRecentSales(hs);
    /* Gerçek satış verileri geç geldikçe fiyat tablosundaki "Gerçek satış" sütununu da besler */
    renderPrices();
    renderSales();
  } catch (e) { /* geçmiş opsiyonel */ }
  try {
    await loadGold();
    if (token !== loadToken) return;
    if (state.gold?.length) {
      $("goldNow").textContent = fmt(state.gold[state.gold.length - 1].price);
      lineChart("goldChart", state.gold.map(g => ({ t: g.t, price: g.price, count: 0 })), { h: 110, unit: "altın" });
    }
  } catch (e) { /* gold opsiyonel */ }
  if (token === loadToken) setBusy("Canlı");
}

/* ---------- Arama ---------- */
function renderSearchResults(q) {
  const box = $("searchResults");
  const query = q.trim().toLowerCase();
  if (!query) { box.classList.add("hidden"); return; }
  const hits = CATALOG.filter(c =>
    c.name.toLowerCase().includes(query) || c.id.toLowerCase().includes(query) || c.group.toLowerCase().includes(query)
  ).slice(0, 60);
  box.innerHTML = hits.map((c, i) => `
    <div class="sr-item${i === 0 ? " active" : ""}" data-id="${c.id}">
      <img src="https://render.albiononline.com/v2/item/${c.id}.png?size=32" alt="" onerror="this.style.visibility='hidden'">
      <span>${c.name}</span><span class="sr-code">${c.id}</span>
    </div>`).join("") || `<div class="sr-item"><span class="muted">Sonuç yok — doğrudan kod yazın (örn. T6_1H_SWORD)</span></div>`;
  box.classList.remove("hidden");

  box.querySelectorAll(".sr-item").forEach(el => {
    el.addEventListener("click", () => {
      selectItem(el.dataset.id);
      box.classList.add("hidden");
    });
  });
}

function selectItem(id) {
  state.item = (BY_ID[id] ? id : id.toUpperCase().trim()) || state.item;
  $("search").value = "";
  savePrefs();
  if (typeof showTab === "function") showTab("detail");
  refresh();
}

/* Simply press Enter with raw code */
function init() {
  loadPrefs();
  /* URL parametreleri: ?item=T4_BAG&q=2 — sayfayı doğrudan istediğin ürünle açar */
  const qs = new URLSearchParams(location.search);
  if (qs.get("server")) localStorage.setItem("albionServer", qs.get("server"));
  const srv = localStorage.getItem("albionServer") || "europe";
  API = aodpBase(srv);
  const srvSel = $("serverSelect");
  if (srvSel) {
    srvSel.value = srv;
    srvSel.addEventListener("change", () => {
      localStorage.setItem("albionServer", srvSel.value);
      location.reload();
    });
  }
  if (qs.get("item")) { state.item = qs.get("item").toUpperCase().trim(); savePrefs(); if (typeof showTab === "function") showTab("detail"); }
  if (qs.get("q")) { state.quality = String(Number(qs.get("q")) || state.quality); savePrefs(); }
  $("quality").value = state.quality;
  $("salesTax").value = state.salesTax;
  $("setupFee").value = state.setupFee;
  $("includeBlackMarket").checked = !!state.blackMarket;

  $("search").addEventListener("input", e => renderSearchResults(e.target.value));
  $("search").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      const first = $("searchResults").querySelector(".sr-item.active");
      selectItem(first ? first.dataset.id : $("search").value);
    }
    if (e.key === "Escape") $("searchResults").classList.add("hidden");
  });
  document.addEventListener("click", e => {
    if (!e.target.closest(".search-wrap")) $("searchResults").classList.add("hidden");
  });

  $("quality").addEventListener("change", e => { state.quality = e.target.value; savePrefs(); refresh(); });
  $("salesTax").addEventListener("change", e => { state.salesTax = Number(e.target.value) || 0; savePrefs(); state.flips = computeFlips(); renderKPIs(); renderFlips(); });
  $("setupFee").addEventListener("change", e => { state.setupFee = Number(e.target.value) || 0; savePrefs(); state.flips = computeFlips(); renderKPIs(); renderFlips(); });
  $("includeBlackMarket").addEventListener("change", e => { state.blackMarket = e.target.checked; savePrefs(); refresh(); });

  document.querySelectorAll(".chip[data-scale]").forEach(ch => {
    ch.addEventListener("click", () => {
      document.querySelectorAll(".chip[data-scale]").forEach(c => c.classList.remove("active"));
      ch.classList.add("active");
      state.timescale = Number(ch.dataset.scale);
      savePrefs();
      refresh();
    });
  });
  const active = document.querySelector(`.chip[data-scale="${state.timescale}"]`);
  if (active) { document.querySelectorAll(".chip").forEach(c => c.classList.remove("active")); active.classList.add("active"); }

  refresh();
  setInterval(refresh, 120000);
}

init();
