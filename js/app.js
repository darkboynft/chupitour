(function(){
  "use strict";

  let GEO = null;
  let COUNTS = {};
  let unlocked = false;
  let currentView = "list";
  let leafletMap = null;
  let filledLayer = null;
  let pendingLayer = null;
  let mapInitialized = false;

  const state = { query: "", filter: "todos", ccaa: "todas" };
  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init(){
    cacheEls();
    bindGlobalControls();

    try{
      GEO = await fetch("data/municipios.json").then(r => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
    }catch(err){
      console.error("Error cargando municipios.json:", err);
      toast("No se pudo cargar data/municipios.json. Revisa que el archivo esté en el repo.");
      GEO = { comunidades: [] };
    }

    try{
      COUNTS = await fetchCounts();
    }catch(err){
      console.error("Error cargando datos de Google Sheets:", err);
      toast("No se pudieron cargar las cantidades desde Google Sheets. Revisa APPS_SCRIPT_URL y el despliegue del Apps Script.");
      COUNTS = {};
    }

    populateCcaaSelect();
    renderList();
    updateHeaderStats();
  }

  function cacheEls(){
    els.listView = document.getElementById("list-view");
    els.mapView = document.getElementById("map-view");
    els.search = document.getElementById("search-input");
    els.chips = Array.from(document.querySelectorAll(".chip"));
    els.ccaaSelect = document.getElementById("ccaa-select");
    els.statCount = document.getElementById("stat-count");
    els.statOf = document.getElementById("stat-of");
    els.progressFill = document.getElementById("progress-fill");
    els.lockBtn = document.getElementById("lock-btn");
    els.modalOverlay = document.getElementById("modal-overlay");
    els.modalInput = document.getElementById("modal-password");
    els.modalConfirm = document.getElementById("modal-confirm");
    els.modalCancel = document.getElementById("modal-cancel");
    els.toast = document.getElementById("status-toast");
    els.btnViewList = document.getElementById("btn-view-list");
    els.btnViewMap = document.getElementById("btn-view-map");
    els.showPendingMap = document.getElementById("show-pending-map");
  }

  function bindGlobalControls(){
    els.search.addEventListener("input", () => {
      state.query = els.search.value.trim().toLowerCase();
      renderList();
      if (currentView === "map") refreshMapMarkers();
    });

    els.chips.forEach(chip => {
      chip.addEventListener("click", () => {
        els.chips.forEach(c => c.setAttribute("aria-pressed", "false"));
        chip.setAttribute("aria-pressed", "true");
        state.filter = chip.dataset.filter;
        renderList();
        if (currentView === "map") refreshMapMarkers();
      });
    });

    els.ccaaSelect.addEventListener("change", () => {
      state.ccaa = els.ccaaSelect.value;
      renderList();
      if (currentView === "map") refreshMapMarkers();
    });

    els.lockBtn.addEventListener("click", () => {
      if (unlocked){
        unlocked = false;
        els.lockBtn.classList.remove("unlocked");
        els.lockBtn.textContent = "🔒 Panel";
        renderList();
      } else {
        openModal();
      }
    });

    els.modalCancel.addEventListener("click", closeModal);
    els.modalConfirm.addEventListener("click", tryUnlock);
    els.modalInput.addEventListener("keydown", e => { if (e.key === "Enter") tryUnlock(); });

    els.btnViewList.addEventListener("click", () => switchView("list"));
    els.btnViewMap.addEventListener("click", () => switchView("map"));
    els.showPendingMap.addEventListener("change", refreshMapMarkers);
  }

  function switchView(view){
    currentView = view;
    els.btnViewList.setAttribute("aria-pressed", String(view === "list"));
    els.btnViewMap.setAttribute("aria-pressed", String(view === "map"));
    els.listView.classList.toggle("hidden", view === "map");
    els.mapView.classList.toggle("active", view === "map");
    if (view === "map"){
      initMapIfNeeded();
      setTimeout(() => { if (leafletMap) leafletMap.invalidateSize(); refreshMapMarkers(); }, 50);
    }
  }

  function openModal(){
    els.modalOverlay.hidden = false;
    els.modalInput.value = "";
    els.modalInput.focus();
  }
  function closeModal(){ els.modalOverlay.hidden = true; }

  function tryUnlock(){
    const val = els.modalInput.value;
    if (!val) return;
    window.__CLAVE_PANEL = val;
    unlocked = true;
    els.lockBtn.classList.add("unlocked");
    els.lockBtn.textContent = "🔓 Panel activo";
    closeModal();
    renderList();
  }

  async function fetchCounts(){
    if (!CONFIG.APPS_SCRIPT_URL || CONFIG.APPS_SCRIPT_URL.includes("TU_ID_DE_DESPLIEGUE")) return {};
    const res = await fetch(CONFIG.APPS_SCRIPT_URL);
    if (!res.ok) throw new Error("Error al leer datos de Google Sheets");
    return res.json();
  }

  async function saveCount(id, cantidad){
    if (!CONFIG.APPS_SCRIPT_URL || CONFIG.APPS_SCRIPT_URL.includes("TU_ID_DE_DESPLIEGUE")){
      toast("Configura APPS_SCRIPT_URL en js/config.js primero.");
      return false;
    }
    try{
      const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ id, cantidad, clave: window.__CLAVE_PANEL || "" })
      });
      const data = await res.json();
      if (!data.ok){
        toast(data.error || "No se pudo guardar (¿clave incorrecta?)");
        return false;
      }
      return true;
    }catch(err){
      console.error(err);
      toast("Error de red al guardar.");
      return false;
    }
  }

  function populateCcaaSelect(){
    if (!GEO || !GEO.comunidades) return;
    GEO.comunidades.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c.nombre;
      opt.textContent = c.nombre;
      els.ccaaSelect.appendChild(opt);
    });
  }

  function allMunicipios(){
    const out = [];
    GEO.comunidades.forEach(c => c.provincias.forEach(p => p.municipios.forEach(m => out.push(m))));
    return out;
  }

  function totalMunicipios(){ return allMunicipios().length; }
  function totalConseguidos(){ return Object.values(COUNTS).filter(v => Number(v) > 0).length; }

  function matchesFilters(m){
    const cantidad = Number(COUNTS[m.id]) || 0;
    if (state.filter === "conseguidos" && cantidad <= 0) return false;
    if (state.filter === "pendientes" && cantidad > 0) return false;
    if (state.query && !m.nombre.toLowerCase().includes(state.query)) return false;
    return true;
  }

  function updateHeaderStats(){
    const total = totalMunicipios();
    const conseguidos = totalConseguidos();
    els.statCount.textContent = conseguidos.toLocaleString("es-ES");
    els.statOf.textContent = `de ${total.toLocaleString("es-ES")} municipios`;
    requestAnimationFrame(() => {
      const pct = total ? (conseguidos / total) * 100 : 0;
      els.progressFill.style.width = pct.toFixed(2) + "%";
    });
  }

  function renderList(){
    if (!GEO) return;
    updateHeaderStats();

    els.listView.innerHTML = "";
    let comunidades = GEO.comunidades;
    if (state.ccaa !== "todas") comunidades = comunidades.filter(c => c.nombre === state.ccaa);

    let anyRendered = false;

    comunidades.forEach((ccaa, idx) => {
      const provinciasFiltradas = ccaa.provincias
        .map(p => ({ nombre: p.nombre, municipios: p.municipios.filter(matchesFilters) }))
        .filter(p => p.municipios.length > 0);

      if (provinciasFiltradas.length === 0) return;
      anyRendered = true;

      const ccaaConseguidos = ccaa.provincias.reduce((acc, p) =>
        acc + p.municipios.filter(m => Number(COUNTS[m.id]) > 0).length, 0);
      const ccaaTotal = ccaa.provincias.reduce((acc, p) => acc + p.municipios.length, 0);

      const block = document.createElement("div");
      block.className = "ccaa-block";
      block.style.animationDelay = Math.min(idx * 35, 350) + "ms";

      const isActiveSearch = !!(state.query || state.filter !== "todos" || state.ccaa !== "todas");
      if (isActiveSearch) block.classList.add("open");

      const header = document.createElement("button");
      header.className = "ccaa-header";
      header.innerHTML = `
        <h2>${ccaa.nombre}</h2>
        <span class="ccaa-meta">
          <span>${ccaaConseguidos} / ${ccaaTotal}</span>
          <span class="ccaa-caret">›</span>
        </span>`;
      header.addEventListener("click", () => block.classList.toggle("open"));

      const body = document.createElement("div");
      body.className = "ccaa-body";

      provinciasFiltradas.forEach(p => {
        const provBlock = document.createElement("div");
        provBlock.className = "prov-block";
        const provTitle = document.createElement("p");
        provTitle.className = "prov-title";
        provTitle.textContent = p.nombre;
        provBlock.appendChild(provTitle);

        const grid = document.createElement("div");
        grid.className = "muni-grid";
        p.municipios.forEach(m => grid.appendChild(renderMuniChip(m)));
        provBlock.appendChild(grid);
        body.appendChild(provBlock);
      });

      block.appendChild(header);
      block.appendChild(body);
      els.listView.appendChild(block);
    });

    if (!anyRendered){
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "Ningún municipio coincide con la búsqueda o el filtro.";
      els.listView.appendChild(empty);
    }
  }

  function renderMuniChip(m){
    const cantidad = Number(COUNTS[m.id]) || 0;
    const chip = document.createElement("div");
    chip.className = "muni-chip" + (cantidad > 0 ? " filled" : "");
    chip.dataset.id = m.id;

    if (unlocked){
      chip.innerHTML = `
        <span>${m.nombre}</span>
        <input class="muni-edit" type="number" min="0" value="${cantidad}" aria-label="Cantidad de chupitos en ${m.nombre}">
        <button class="muni-save" type="button">Guardar</button>`;
      const input = chip.querySelector(".muni-edit");
      const btn = chip.querySelector(".muni-save");
      btn.addEventListener("click", async () => {
        const val = Math.max(0, parseInt(input.value, 10) || 0);
        const eraPrimero = cantidad === 0 && val > 0;
        btn.textContent = "…";
        const ok = await saveCount(m.id, val);
        btn.textContent = "Guardar";
        if (ok){
          COUNTS[m.id] = val;
          chip.classList.toggle("filled", val > 0);
          chip.classList.remove("just-saved");
          void chip.offsetWidth;
          chip.classList.add("just-saved");
          toast(`Guardado: ${m.nombre} (${val})`);
          updateHeaderStats();
          if (mapInitialized) refreshMapMarkers();
          if (eraPrimero) celebrate(chip);
        }
      });
    } else {
      chip.innerHTML = `<span>${m.nombre}</span>` + (cantidad > 0 ? `<span class="muni-badge">${cantidad}</span>` : "");
    }
    return chip;
  }

  // ---------- Map view ----------
  function initMapIfNeeded(){
    if (mapInitialized) return;
    if (typeof L === "undefined"){
      document.getElementById("map-container").innerHTML =
        '<p class="empty-state">No se pudo cargar el mapa (Leaflet). Comprueba tu conexión o que no haya un bloqueador de scripts activo, y recarga la página.</p>';
      toast("No se pudo cargar el mapa.");
      return;
    }
    mapInitialized = true;
    leafletMap = L.map("map-container", { preferCanvas: true }).setView([40.2, -3.7], 6);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; colaboradores de <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a>"
    }).addTo(leafletMap);
    filledLayer = L.layerGroup().addTo(leafletMap);
    pendingLayer = L.layerGroup();
  }

  function refreshMapMarkers(){
    if (!leafletMap) return;
    filledLayer.clearLayers();
    pendingLayer.clearLayers();

    const municipios = allMunicipios().filter(m => matchesFilters(m) && m.lat != null && m.lon != null);

    municipios.forEach(m => {
      const cantidad = Number(COUNTS[m.id]) || 0;
      if (cantidad > 0){
        const marker = L.circleMarker([m.lat, m.lon], {
          radius: 7,
          color: "#0A6B60",
          weight: 1,
          fillColor: "#17B8A6",
          fillOpacity: 0.9
        });
        marker.bindPopup(`<p class="popup-title">${m.nombre}</p><p class="popup-count">${cantidad} chupito${cantidad === 1 ? "" : "s"}</p>`);
        marker.addTo(filledLayer);
      } else if (els.showPendingMap.checked){
        const marker = L.circleMarker([m.lat, m.lon], {
          radius: 3,
          color: "#D8D3E4",
          weight: 1,
          fillColor: "#D8D3E4",
          fillOpacity: 0.6
        });
        marker.bindPopup(`<p class="popup-title">${m.nombre}</p><p>Pendiente</p>`);
        marker.addTo(pendingLayer);
      }
    });

    if (els.showPendingMap.checked && !leafletMap.hasLayer(pendingLayer)) pendingLayer.addTo(leafletMap);
    if (!els.showPendingMap.checked && leafletMap.hasLayer(pendingLayer)) leafletMap.removeLayer(pendingLayer);
  }

  const CONFETTI_COLORS = ["#FF5D73", "#17B8A6", "#FFC93C", "#8E7CC3"];
  function celebrate(anchorEl){
    const rect = anchorEl.getBoundingClientRect();
    const originX = rect.left + rect.width / 2;
    const originY = rect.top + rect.height / 2;
    for (let i = 0; i < 14; i++){
      const piece = document.createElement("div");
      piece.className = "confetti-piece";
      piece.style.left = originX + "px";
      piece.style.top = originY + "px";
      piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      const angle = Math.random() * Math.PI * 2;
      const dist = 60 + Math.random() * 70;
      piece.style.setProperty("--dx", (Math.cos(angle) * dist) + "px");
      piece.style.setProperty("--dy", (Math.sin(angle) * dist - 20) + "px");
      piece.style.setProperty("--rot", (Math.random() * 360) + "deg");
      document.body.appendChild(piece);
      piece.addEventListener("animationend", () => piece.remove());
    }
  }

  let toastTimer = null;
  function toast(msg){
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3200);
  }
})();
