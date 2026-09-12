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
      toast("No se pudo cargar data/municipios.json. Revisa que el archivo estÃ© en el repo.");
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
    els.geocodeBtn = document.getElementById("geocode-btn");
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
        els.lockBtn.textContent = "ðŸ”’ Panel";
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
    els.geocodeBtn.addEventListener("click", autocompletarLugar);
  }

  async function autocompletarLugar(){
    const nombre = els.newPlaceNombre.value.trim();
    if (!nombre) return;
    els.geocodeStatus.textContent = "Buscando coordenadasâ€¦";
    try{
      const pistaPais = els.newPlacePais.value.trim();
      const query = pistaPais ? `${nombre}, ${pistaPais}` : nombre;
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, { headers: { "Accept-Language": "es" } });
      const data = await res.json();
      if (!data || data.length === 0){
        els.geocodeStatus.textContent = "No se ha encontrado ese lugar automÃ¡ticamente. Puedes rellenar los datos a mano.";
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
      console.warn("GeocodificaciÃ³n fallÃ³:", err);
      els.geocodeStatus.textContent = "No se pudo buscar automÃ¡ticamente (sin conexiÃ³n con el servicio). Puedes rellenar a mano.";
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
    // Rellena el datalist con los paÃ­ses/grupos ya existentes, para autocompletar.
    els.paisesDatalist.innerHTML = "";
    const nombresUnicos = new Set(GEO.comunidades.map(c => c.nombre.replace(/ â€” Mis lugares$/, "").replace(/ â€” .*$/, "")));
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
      els.addPlaceError.textContent = "Falta el paÃ­s.";
      els.addPlaceError.style.display = "block";
      return;
    }
    if (!nombre){
      nombre = `${pais} (sin concretar)`;
    }

    els.addPlaceConfirm.textContent = "Guardandoâ€¦";
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
      toast(`AÃ±adido: ${nombre}`);
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
    els.lockBtn.textContent = "ðŸ”“ Panel activo";
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
    // Compatibilidad con la versiÃ³n antigua del Apps Script (devolvÃ­a { id: cantidad } directamente).
    if (data && data.counts){
      return { counts: data.counts, lugares: data.lugares || [] };
    }
    return { counts: data || {}, lugares: [] };
  }

  // PaÃ­ses que se guardaron como catÃ¡logo completo en su momento. Si el usuario ya tiene
  // cantidades guardadas ahÃ­ (de cuando sÃ­ estaban cargados), se recuperan solos sin tener
  // que cargar el resto de paÃ­ses de golpe.
  const PAISES_CATALOGO = {
    "alemania": "data/paises/alemania.json",
    "ecuador": "data/paises/ecuador.json",
    "francia": "data/paises/francia.json",
    "holanda": "data/paises/holanda.json",
    
