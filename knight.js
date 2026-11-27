// knight.js — Knight Online pazar & GB fiyatları (veri: EnUcuzGB API)
// Çalışma modu:
//   - Proxy URL varsa: istekler proxy üzerinden gider (anahtar worker'da kalır).
//   - Yoksa: localStorage'daki API anahtarıyla doğrudan enucuzgb.com'a gider (kişisel kullanım).
(function () {
  const STORAGE_KEY = "knightSettings.v1";
  const CACHE_KEY = "knightGbCache.v1";
  const SERVERS_FALLBACK = [
    { server_code: "server1", server_name: "ZERO" },
    { server_code: "server2", server_name: "FELIS" },
    { server_code: "server3", server_name: "AGARTHA" },
    { server_code: "server4", server_name: "PANDORA" },
    { server_code: "server5", server_name: "DRYADS" },
    { server_code: "server6", server_name: "DESTAN" },
    { server_code: "server7", server_name: "MINARK" },
    { server_code: "server8", server_name: "OREADS" },
  ];

  const state = {
    settings: { proxyUrl: "", apiKey: "" },
    gbRows: [],
    lastGbFetch: 0,
    marketItems: [],
    selectedItemId: null,
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) state.settings = Object.assign(state.settings, JSON.parse(raw));
    } catch (e) {}
  }
  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings)); } catch (e) {}
  }

  function effectiveBase() {
    const p = (state.settings.proxyUrl || "").trim().replace(/\/+$/, "");
    if (p) return p;
    return "https://www.enucuzgb.com";
  }
  function directMode() { return !(state.settings.proxyUrl || "").trim(); }

  async function apiFetch(path, params) {
    const base = effectiveBase();
    const full = base + (path.startsWith("/") ? path : "/" + path);
    const u = new URL(full);
    if (params) Object.keys(params).forEach(k => {
      if (params[k] !== undefined && params[k] !== null && params[k] !== "") u.searchParams.set(k, params[k]);
    });
    const headers = { Accept: "application/json" };
    if (directMode() && state.settings.apiKey) headers["X-API-Key"] = state.settings.apiKey;
    const res = await fetch(u.toString(), { headers });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      const msg = (json && json.error && json.error.message) || ("HTTP " + res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.code = (json && json.error && json.error.code) || "";
      throw err;
    }
    return json;
  }

  function fmtPrice(v) {
    if (v === null || v === undefined) return "—";
    const n = parseFloat(v);
    if (isNaN(n)) return String(v);
    return n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtTime(s) {
    if (!s) return "—";
    return String(s).replace("T", " ").slice(0, 16);
  }

  // ---- GB prices ----
  async function loadGbServers() {
    const sel = document.getElementById("knightGbServer");
    const msel = document.getElementById("knightMarketServer");
    if (!sel) return;
    // Try catalog; fall back to static list
    let servers = SERVERS_FALLBACK;
    try {
      const j = await apiFetch("/api/v1/catalog/servers", { game: "knight" });
      if (j && Array.isArray(j.data) && j.data.length) {
        servers = j.data.map(s => ({ server_code: s.server_code, server_name: s.server_name }));
      }
    } catch (e) { /* keep fallback */ }
    const opts = ['<option value="">Tümü</option>'].concat(servers.map(s =>
      `<option value="${esc(s.server_name)}">${esc(s.server_name)}</option>`));
    sel.innerHTML = opts.join("");
    if (msel) msel.innerHTML = opts.join("");
  }

  async function fetchGb() {
    const status = document.getElementById("knightDataStatus");
    const info = document.getElementById("knightGbInfo");
    const updated = document.getElementById("knightGbUpdated");
    const server = document.getElementById("knightGbServer").value;
    if (status) status.textContent = "Yükleniyor…";
    try {
      const params = { game: "knight" };
      if (server) params.server = server;
      const j = await apiFetch("/api/v1/prices/current", params);
      state.gbRows = Array.isArray(j.data) ? j.data : [];
      state.lastGbFetch = Date.now();
      renderGb();
      if (status) status.textContent = "Hazır";
      if (info) info.textContent = `${state.gbRows.length} kayıt`;
      if (updated) updated.textContent = "Son: " + new Date().toLocaleTimeString("tr-TR");
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), rows: state.gbRows })); } catch (e) {}
    } catch (e) {
      if (status) status.textContent = "Hata";
      if (info) info.textContent = e.message + (e.status === 401 ? " — API anahtarı/proxy kontrol et (Ayarlar)." : "");
      // try cache
      try {
        const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
        if (c && Array.isArray(c.rows)) { state.gbRows = c.rows; renderGb(); if (info) info.textContent += " (önbellek)"; }
      } catch (err) {}
    }
  }

  function renderGb() {
    const body = document.getElementById("knightGbBody");
    if (!body) return;
    if (!state.gbRows.length) {
      body.innerHTML = '<tr><td colspan="6" class="muted">Veri yok.</td></tr>';
      return;
    }
    // group by server_name then source
    const rows = state.gbRows.slice().sort((a, b) => {
      const sa = (a.server_name || a.server || "").localeCompare(b.server_name || b.server || "");
      if (sa) return sa;
      return (a.source_display_name || a.source || "").localeCompare(b.source_display_name || b.source || "");
    });
    body.innerHTML = rows.map(r => {
      const buy = (r.buy_price === null || r.buy_price === undefined || r.buy_price === "0.0000") ? "—" : fmtPrice(r.buy_price);
      const sell = (r.sell_price === null || r.sell_price === undefined || r.sell_price === "9999.0000" || r.sell_price === "9999") ? "—" : fmtPrice(r.sell_price);
      const status = (r.status === 1 || r.status === "1") ? '<span class="age-fresh">Aktif</span>' : '<span class="age-stale">Pasif</span>';
      return `<tr>
        <td>${esc(r.server_name || r.server || "—")}</td>
        <td>${esc(r.source_display_name || r.source || "—")}</td>
        <td class="num">${buy}</td>
        <td class="num">${sell}</td>
        <td>${status}</td>
        <td class="muted small">${fmtTime(r.source_refreshed_at || r.captured_at)}</td>
      </tr>`;
    }).join("");
  }

  // ---- Item market ----
  async function searchItems() {
    const q = (document.getElementById("knightItemSearch").value || "").trim();
    const info = document.getElementById("knightItemResults");
    const body = document.getElementById("knightMarketBody");
    if (!q) { if (info) info.textContent = "Eşya adı gir."; return; }
    if (info) info.textContent = "Aranıyor…";
    if (body) body.innerHTML = '<tr><td colspan="6" class="muted">Yükleniyor…</td></tr>';
    try {
      const j = await apiFetch("/api/v2/items", { name_like: q, limit: 20 });
      const items = Array.isArray(j.data) ? j.data : [];
      state.marketItems = items;
      if (!items.length) {
        if (info) info.textContent = "Eşleşen item yok.";
        if (body) body.innerHTML = '<tr><td colspan="6" class="muted">Sonuç yok.</td></tr>';
        return;
      }
      if (info) info.textContent = `${items.length} item bulundu. Birini seçmek için tabloda tıkla; ilanlar otomatik çekilir.`;
      // Render item list as clickable rows placeholder; fetch live for first item
      await fetchMarketForItem(items[0].item_id, items[0].item_name);
    } catch (e) {
      if (info) info.textContent = "Hata: " + e.message + (e.status === 403 ? " — v2 erişimi onaylı mı? (Ayarlar)" : "");
      if (body) body.innerHTML = '<tr><td colspan="6" class="muted">Hata.</td></tr>';
    }
  }

  async function fetchMarketForItem(itemId, itemName) {
    const body = document.getElementById("knightMarketBody");
    const info = document.getElementById("knightItemResults");
    const type = document.getElementById("knightMarketType").value || "sell";
    const server = document.getElementById("knightMarketServer").value;
    if (body) body.innerHTML = '<tr><td colspan="6" class="muted">İlanlar yükleniyor…</td></tr>';
    try {
      const params = { item_id: itemId, type, limit: 50 };
      if (server) params.server = server;
      const j = await apiFetch("/api/v2/market/live", params);
      const rows = Array.isArray(j.data) ? j.data : [];
      state.selectedItemId = itemId;
      if (info) info.textContent = `${itemName || itemId} — ${rows.length} ilan (${type}).`;
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="6" class="muted">İlan yok.</td></tr>';
        return;
      }
      body.innerHTML = rows.map(r => `<tr>
        <td>${esc(r.item_name || itemName || "—")}</td>
        <td>${esc(r.server || "—")}</td>
        <td>${esc(r.username || "—")}</td>
        <td class="num">${fmtPrice(r.price)}</td>
        <td class="muted small">${r.pos_x != null ? (r.pos_x + ", " + r.pos_z) : "—"}</td>
        <td class="muted small">${fmtTime(r.created_at)}</td>
      </tr>`).join("");
    } catch (e) {
      if (info) info.textContent = "Hata: " + e.message;
      if (body) body.innerHTML = '<tr><td colspan="6" class="muted">Hata.</td></tr>';
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- Settings modal ----
  function openSettings() {
    const m = document.getElementById("knightSettingsModal");
    if (!m) return;
    document.getElementById("knightProxyUrl").value = state.settings.proxyUrl || "";
    document.getElementById("knightApiKey").value = state.settings.apiKey || "";
    m.classList.remove("hidden");
  }
  function closeSettings() {
    const m = document.getElementById("knightSettingsModal");
    if (m) m.classList.add("hidden");
  }
  function saveSettingsFromModal() {
    state.settings.proxyUrl = document.getElementById("knightProxyUrl").value.trim();
    state.settings.apiKey = document.getElementById("knightApiKey").value.trim();
    saveSettings();
    closeSettings();
    // refresh servers (catalog may differ by key scope)
    loadGbServers();
  }

  // ---- Tabs ----
  function switchTab(name) {
    document.querySelectorAll(".knight-tab").forEach(b => b.classList.toggle("active", b.dataset.ktab === name));
    document.querySelectorAll(".knight-tabpane").forEach(p => p.classList.toggle("hidden", p.id !== "ktab-" + name));
  }

  function knightSetup() {
    loadSettings();
    // tabs
    document.querySelectorAll(".knight-tab").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.ktab)));
    // gb
    const refreshBtn = document.getElementById("knightGbRefresh");
    if (refreshBtn) refreshBtn.addEventListener("click", fetchGb);
    const serverSel = document.getElementById("knightGbServer");
    if (serverSel) serverSel.addEventListener("change", fetchGb);
    // market
    const searchBtn = document.getElementById("knightItemSearchBtn");
    if (searchBtn) searchBtn.addEventListener("click", searchItems);
    const searchInput = document.getElementById("knightItemSearch");
    if (searchInput) searchInput.addEventListener("keydown", e => { if (e.key === "Enter") searchItems(); });
    const typeSel = document.getElementById("knightMarketType");
    if (typeSel) typeSel.addEventListener("change", () => {
      if (state.selectedItemId) fetchMarketForItem(state.selectedItemId, null);
    });
    // settings
    const setBtn = document.getElementById("knightSettingsBtn");
    if (setBtn) setBtn.addEventListener("click", openSettings);
    const saveBtn = document.getElementById("knightSettingsSave");
    if (saveBtn) saveBtn.addEventListener("click", saveSettingsFromModal);
    const closeBtn = document.getElementById("knightSettingsClose");
    if (closeBtn) closeBtn.addEventListener("click", closeSettings);
    const modal = document.getElementById("knightSettingsModal");
    if (modal) modal.addEventListener("click", e => { if (e.target === modal) closeSettings(); });

    // init
    loadGbServers().then(() => {
      // auto-load gb if configured
      if (state.settings.proxyUrl || state.settings.apiKey) fetchGb();
    });
  }

  window.knightSetup = knightSetup;
})();
