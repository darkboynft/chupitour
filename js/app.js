(function(){
  "use strict";

  let GEO = null;
  let COUNTS = {};
  let CUSTOM_LUGARES = [];
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
      const remote = await fetchRemoteData();
      COUNTS = remote.counts;
      CUSTOM_LUGARES = remote.lugares;
    }catch(err){
      console.error("Error cargando datos de Google Sheets:", err);
      toast("No se pudieron cargar las cantidades desde Google Sheets. Revisa APPS_SCRIPT_URL y el despliegue del Apps Script.");
      COUNTS = {};
      CUSTOM_LUGARES = [];
    }

    mergeCustomLugares();
    populateCcaaSelect();
    renderList();
    updateHeaderStats();
    restaurarPaisesConDatos();

    // Carga en segundo plano los grupos internacionales / especiales, sin bloquear el primer render.
    fetch("data/internacional.json")
      .then(r => r.ok ? r.json() : null)
      .then(extra => {
        if (!extra || !extra.comunidades) return;
        GEO.comunidades = GEO.comunidades.concat(extra.comunidades);
        populateCcaaSelect();
        renderList();
        if (mapInitialized) refreshMapMarkers();
      })
      .catch(err => console.warn("No se pudo cargar data/internacional.json:", err));
  }

  function cacheEls(){
    els.listView = document.getElementById("list-view");
    els.mapView = document.getElementById("map-view");
    els.search = document.getElementById("search-input");
    els.chips = Array.from(document.querySelectorAll(".chip"));
    els.ccaaSelect = document.getElementById("ccaa-select");
    els.statCount = document.getElementById("stat-count");
    els.statOf = document.getElementById("stat-of");
    els.statTotalChupitos = document.getElementById("stat-total-chupitos");
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
    els.addPlaceBtn = document.getElementById("add-place-btn");
    els.addPlaceOverlay = document.getElementById("add-place-overlay");
    els.addPlaceCancel = document.getElementById("add-place-cancel");
    els.addPlaceConfirm = document.getElementById("add-place-confirm");
    els.addPlaceError = document.getElementById("add-place-error");
    els.newPlacePais = document.getElementById("new-place-pais");
    els.newPlaceRegion = document.getElementById("new-place-region");
    els.newPlaceNombre = document.getElementById("new-place-nombre");
    els.newPlaceCantidad = document.getElementById("new-place-cantidad");
    els.newPlaceLat = document.getElementById("new-place-lat");
    els.newPlaceLon = document.getElementById("new-place-lon");
    els.paisesDatalist = document.getElementById("paises-existentes");
    els.geocodeStatus = document.getElementById("geocode-status");
  }

  function bindGlobalControls(){
    let searchDebounce = null;
    els.search.addEventListener("input", () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        state.query = els.search.value.trim().toLowerCase();
        renderList();
        if (currentView === "map") refreshMapMarkers();
      }, 180);
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
        els.addPlaceBtn.hidden = true;
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

    els.addPlaceBtn.addEventListener("click", openAddPlaceModal);
    els.addPlaceCancel.addEventListener("click", closeAddPlaceModal);
    els.addPlaceConfirm.addEventListener("click", submitNewPlace);
    els.newPlaceNombre.addEventListener("blur", autocompletarLugar);
  }

  async function autocompletarLugar(){
    const nombre = els.newPlaceNombre.value.trim();
    if (!nombre) return;
    els.geocodeStatus.textContent = "Buscando coordenadas…";
    try{
      const pistaPais = els.newPlacePais.value.trim();
      const query = pistaPais ? `${nombre}, ${pistaPais}` : nombre;
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, { headers: { "Accept-Language": "es" } });
      const data = await res.json();
      if (!data || data.length === 0){
        els.geocodeStatus.textContent = "No se ha encontrado ese lugar automáticamente. Puedes rellenar los datos a mano.";
        return;
      }
      const r = data[0];
      if (!els.newPlaceLat.value) els.newPlaceLat.value = Number(r.lat).toFixed(5);
      if (!els.newPlaceLon.value) els.newPlaceLon.value = Number(r.lon).toFixed(5);
      const addr = r.address || {};
      if (!els.newPlacePais.value && addr.country) els.newPlacePais.value = addr.country;
      if (!els.newPlaceRegion.value){
        const region = addr.state || addr.region || addr.province || "";
        if (region) els.newPlaceRegion.value = region;
      }
      els.geocodeStatus.textContent = `Encontrado: ${r.display_name.split(",").slice(0,3).join(",")}`;
    }catch(err){
      console.warn("Geocodificación falló:", err);
      els.geocodeStatus.textContent = "No se pudo buscar automáticamente (sin conexión con el servicio). Puedes rellenar a mano.";
    }
  }

  function openAddPlaceModal(){
    els.addPlaceError.style.display = "none";
    els.geocodeStatus.textContent = "";
    els.newPlacePais.value = "";
    els.newPlaceRegion.value = "";
    els.newPlaceNombre.value = "";
    els.newPlaceCantidad.value = "1";
    els.newPlaceLat.value = "";
    els.newPlaceLon.value = "";
    // Rellena el datalist con los países/grupos ya existentes, para autocompletar.
    els.paisesDatalist.innerHTML = "";
    const nombresUnicos = new Set(GEO.comunidades.map(c => c.nombre.replace(/ — Mis lugares$/, "").replace(/ — .*$/, "")));
    nombresUnicos.forEach(n => {
      const opt = document.createElement("option");
      opt.value = n;
      els.paisesDatalist.appendChild(opt);
    });
    els.addPlaceOverlay.hidden = false;
    els.newPlacePais.focus();
  }

  function closeAddPlaceModal(){ els.addPlaceOverlay.hidden = true; }

  async function submitNewPlace(){
    const pais = els.newPlacePais.value.trim();
    const region = els.newPlaceRegion.value.trim();
    let nombre = els.newPlaceNombre.value.trim();
    const cantidad = Math.max(0, parseInt(els.newPlaceCantidad.value, 10) || 0);
    const lat = els.newPlaceLat.value.trim();
    const lon = els.newPlaceLon.value.trim();

    if (!pais){
      els.addPlaceError.textContent = "Falta el país.";
      els.addPlaceError.style.display = "block";
      return;
    }
    if (!nombre){
      nombre = `${pais} (sin concretar)`;
    }

    els.addPlaceConfirm.textContent = "Guardando…";
    try{
      const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          accion: "anadir_lugar",
          pais, region, nombre, cantidad,
          lat: lat === "" ? "" : Number(lat),
          lon: lon === "" ? "" : Number(lon),
          clave: window.__CLAVE_PANEL || ""
        })
      });
      const data = await res.json();
      if (!data.ok){
        els.addPlaceError.textContent = data.error || "No se pudo guardar.";
        els.addPlaceError.style.display = "block";
        els.addPlaceConfirm.textContent = "Guardar lugar";
        return;
      }
      closeAddPlaceModal();
      toast(`Añadido: ${nombre}`);
      // Recarga cantidades + lugares personalizados y vuelve a fusionar/pintar.
      const remote = await fetchRemoteData();
      COUNTS = remote.counts;
      CUSTOM_LUGARES = remote.lugares;
      mergeCustomLugares();
      populateCcaaSelect();
      renderList();
      if (mapInitialized) refreshMapMarkers();
    }catch(err){
      console.error(err);
      els.addPlaceError.textContent = "Error de red al guardar.";
      els.addPlaceError.style.display = "block";
    }
    els.addPlaceConfirm.textContent = "Guardar lugar";
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
    els.addPlaceBtn.hidden = false;
    closeModal();
    renderList();
  }

  async function fetchRemoteData(){
    if (!CONFIG.APPS_SCRIPT_URL || CONFIG.APPS_SCRIPT_URL.includes("TU_ID_DE_DESPLIEGUE")){
      return { counts: {}, lugares: [] };
    }
    const res = await fetch(CONFIG.APPS_SCRIPT_URL);
    if (!res.ok) throw new Error("Error al leer datos de Google Sheets");
    const data = await res.json();
    // Compatibilidad con la versión antigua del Apps Script (devolvía { id: cantidad } directamente).
    if (data && data.counts){
      return { counts: data.counts, lugares: data.lugares || [] };
    }
    return { counts: data || {}, lugares: [] };
  }

  // Países que se guardaron como catálogo completo en su momento. Si el usuario ya tiene
  // cantidades guardadas ahí (de cuando sí estaban cargados), se recuperan solos sin tener
  // que cargar el resto de países de golpe.
  const PAISES_CATALOGO = {
    "alemania": "data/paises/alemania.json",
    "ecuador": "data/paises/ecuador.json",
    "francia": "data/paises/francia.json",
    "holanda": "data/paises/holanda.json",
    "italia": "data/paises/italia.json",
    "mexico": "data/paises/mexico.json",
    "monaco": "data/paises/monaco.json",
    "peru": "data/paises/peru.json",
    "polonia": "data/paises/polonia.json",
    "reinounido": "data/paises/reinounido.json",
    "san-marino": "data/paises/sanmarino.json",
    "suiza": "data/paises/suiza.json"
  };

  function restaurarPaisesConDatos(){
    const prefijos = new Set();
    Object.entries(COUNTS).forEach(([id, v]) => {
      if (Number(v) > 0){
        const prefijo = id.split("__")[0];
        if (PAISES_CATALOGO[prefijo]) prefijos.add(prefijo);
      }
    });
    prefijos.forEach(prefijo => {
      fetch(PAISES_CATALOGO[prefijo])
        .then(r => r.ok ? r.json() : null)
        .then(extra => {
          if (!extra || !extra.comunidades) return;
          GEO.comunidades = GEO.comunidades.concat(extra.comunidades);
          populateCcaaSelect();
          renderList();
          if (mapInitialized) refreshMapMarkers();
          toast(`Recuperados tus lugares guardados de ${prefijo}.`);
        })
        .catch(err => console.warn(`No se pudo recuperar el catálogo de ${prefijo}:`, err));
    });
  }

  function mergeCustomLugares(){
    // Elimina cualquier grupo "custom" añadido en una fusión anterior, para no duplicar.
    GEO.comunidades = GEO.comunidades.filter(c => !c.custom);
    if (!CUSTOM_LUGARES || CUSTOM_LUGARES.length === 0) return;
    const porPais = {};
    CUSTOM_LUGARES.forEach(l => {
      const pais = l.pais || "Otros";
      const region = l.region || "General";
      if (!porPais[pais]) porPais[pais] = {};
      if (!porPais[pais][region]) porPais[pais][region] = [];
      porPais[pais][region].push({
        id: l.id, nombre: l.nombre,
        lat: l.lat != null ? Number(l.lat) : null,
        lon: l.lon != null ? Number(l.lon) : null
      });
    });

    Object.keys(porPais).forEach(pais => {
      const provincias = Object.keys(porPais[pais]).sort().map(region => ({
        nombre: region,
        municipios: porPais[pais][region].sort((a,b) => a.nombre.localeCompare(b.nombre))
      }));
      GEO.comunidades.push({
        nombre: `${pais} — Mis lugares`,
        extra: true,
        custom: true,
        provincias
      });
    });
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
    const existing = new Set(Array.from(els.ccaaSelect.options).map(o => o.value));
    GEO.comunidades.forEach(c => {
      if (existing.has(c.nombre)) return;
      const opt = document.createElement("option");
      opt.value = c.nombre;
      opt.textContent = c.nombre;
      els.ccaaSelect.appendChild(opt);
    });
  }

  function normalize(s){
    return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }
  const ALIASES = {
    "orense": "ourense",
    "zahara de la sierra": "zahara",
    "valenca do minho": "valenca",
    // Exónimos españoles de ciudades extranjeras -> nombre oficial en los datos
    "londres": "london",
    "edimburgo": "edinburgh",
    "florencia": "firenze",
    "milan": "milano",
    "napoles": "napoli",
    "venecia": "venezia",
    "turin": "torino",
    "padua": "padova",
    "bolonia": "bologna",
    "cerdena": "sardegna",
    "sicilia": "sicilia",
    "ginebra": "geneve",
    "basilea": "basel",
    "berna": "bern",
    "lucerna": "luzern",
    "la haya": "den haag",
    "amberes": "antwerpen",
    "brujas": "brugge",
    "varsovia": "warszawa",
    "cracovia": "krakow",
    "praga": "praha",
    "viena": "wien",
    "munich": "munchen",
    "colonia": "koln",
    "hamburgo": "hamburg",
    "brunswick": "braunschweig",
    "oporto": "porto"
  };

  function allMunicipios(withContext){
    const out = [];
    GEO.comunidades.forEach(c => c.provincias.forEach(p => p.municipios.forEach(m => {
      out.push(withContext ? Object.assign({ _ctx: [c.nombre, p.nombre] }, m) : m);
    })));
    return out;
  }

  function officialMunicipios(){
    const out = [];
    GEO.comunidades.filter(c => !c.extra).forEach(c => c.provincias.forEach(p => p.municipios.forEach(m => out.push(m))));
    return out;
  }

  function totalMunicipios(){ return officialMunicipios().length; }
  function totalConseguidos(){
    const ids = new Set(officialMunicipios().map(m => m.id));
    return Object.entries(COUNTS).filter(([id, v]) => ids.has(id) && Number(v) > 0).length;
  }

  function textMatchesQuery(text, q){
    const nombre = normalize(text);
    const aliasTarget = ALIASES[q];
    return nombre.includes(q) || (aliasTarget && nombre.includes(aliasTarget));
  }

  function muniMatchesQuery(m, q){
    if (m._n === undefined) m._n = normalize(m.nombre);
    const aliasTarget = ALIASES[q];
    return m._n.includes(q) || (aliasTarget && m._n.includes(aliasTarget));
  }

  function matchesFilters(m, contextNames){
    const cantidad = Number(COUNTS[m.id]) || 0;
    if (state.filter === "conseguidos" && cantidad <= 0) return false;
    if (state.filter === "pendientes" && cantidad > 0) return false;
    if (state.query){
      const q = normalize(state.query);
      const ownMatch = muniMatchesQuery(m, q);
      const contextMatch = contextNames && contextNames.some(n => textMatchesQuery(n, q));
      if (!ownMatch && !contextMatch) return false;
    }
    return true;
  }

  function totalChupitosOficiales(){
    const ids = new Set(officialMunicipios().map(m => m.id));
    let total = 0;
    Object.entries(COUNTS).forEach(([id, v]) => {
      if (ids.has(id)) total += (Number(v) || 0);
    });
    return total;
  }

  function updateHeaderStats(){
    const total = totalMunicipios();
    const conseguidos = totalConseguidos();
    const totalChupitos = totalChupitosOficiales();
    els.statCount.textContent = conseguidos.toLocaleString("es-ES");
    els.statOf.textContent = `municipios de ${total.toLocaleString("es-ES")}`;
    els.statTotalChupitos.textContent = totalChupitos.toLocaleString("es-ES");
    requestAnimationFrame(() => {
      const pct = total ? (conseguidos / total) * 100 : 0;
      els.progressFill.style.width = pct.toFixed(2) + "%";
    });
  }

  function buildMuniGrids(body, provincias){
    provincias.forEach(p => {
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
  }

  function renderList(){
    if (!GEO) return;
    updateHeaderStats();

    els.listView.innerHTML = "";
    let comunidades = GEO.comunidades;
    if (state.ccaa !== "todas") comunidades = comunidades.filter(c => c.nombre === state.ccaa);

    const isActiveSearch = !!(state.query || state.filter !== "todos" || state.ccaa !== "todas");
    let anyRendered = false;

    comunidades.forEach((ccaa, idx) => {
      const block = document.createElement("div");
      block.className = "ccaa-block";
      block.style.animationDelay = Math.min(idx * 35, 350) + "ms";

      const header = document.createElement("button");
      header.className = "ccaa-header";
      const body = document.createElement("div");
      body.className = "ccaa-body";

      if (isActiveSearch){
        // Modo búsqueda/filtro: hace falta saber exactamente qué queda, así que se calcula y pinta ya.
        const provinciasFiltradas = ccaa.provincias
          .map(p => ({ nombre: p.nombre, municipios: p.municipios.filter(m => matchesFilters(m, [ccaa.nombre, p.nombre])) }))
          .filter(p => p.municipios.length > 0);

        if (provinciasFiltradas.length === 0) return;
        anyRendered = true;
        block.classList.add("open");

        const ccaaConseguidos = ccaa.provincias.reduce((acc, p) =>
          acc + p.municipios.filter(m => Number(COUNTS[m.id]) > 0).length, 0);
        const ccaaTotal = ccaa.provincias.reduce((acc, p) => acc + p.municipios.length, 0);
        header.innerHTML = `<h2>${ccaa.nombre}</h2><span class="ccaa-meta"><span>${ccaaConseguidos} / ${ccaaTotal}</span><span class="ccaa-caret">›</span></span>`;
        header.addEventListener("click", () => block.classList.toggle("open"));

        buildMuniGrids(body, provinciasFiltradas);
      } else {
        // Modo "explorar todo": solo se cuenta (barato); el contenido de cada país se
        // construye la primera vez que se abre, para no crear ~60.000 elementos de golpe.
        anyRendered = true;

        const ccaaConseguidos = ccaa.provincias.reduce((acc, p) =>
          acc + p.municipios.filter(m => Number(COUNTS[m.id]) > 0).length, 0);
        const ccaaTotal = ccaa.provincias.reduce((acc, p) => acc + p.municipios.length, 0);
        header.innerHTML = `<h2>${ccaa.nombre}</h2><span class="ccaa-meta"><span>${ccaaConseguidos} / ${ccaaTotal}</span><span class="ccaa-caret">›</span></span>`;

        let built = false;
        header.addEventListener("click", () => {
          if (!built){
            buildMuniGrids(body, ccaa.provincias);
            built = true;
          }
          block.classList.toggle("open");
        });
      }

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

    const municipios = allMunicipios(true).filter(m => matchesFilters(m, m._ctx) && m.lat != null && m.lon != null);

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
