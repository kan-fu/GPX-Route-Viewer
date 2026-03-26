const map = L.map("map", {
  zoomControl: true,
}).setView([20, 0], 2);

const baseLayers = {
  streets: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }),
  quiet: L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
  }),
};

let activeBaseLayer = baseLayers.quiet;
activeBaseLayer.addTo(map);

const colorPalette = [
  "#0072b2",
  "#d55e00",
  "#009e73",
  "#cc79a7",
  "#e69f00",
  "#56b4e9",
  "#9b2226",
  "#3a86ff",
  "#0081a7",
  "#8338ec",
];

const trackStyle = {
  normalMainWeight: 5,
  activeMainWeight: 6,
  dimMainWeight: 4,
  normalMainOpacity: 0.95,
  activeMainOpacity: 1,
  dimMainOpacity: 0.45,
  normalHaloWeight: 9,
  activeHaloWeight: 10,
  dimHaloWeight: 7,
  normalHaloOpacity: 0.78,
  activeHaloOpacity: 0.9,
  dimHaloOpacity: 0.35,
};

const state = {
  colorIndex: 0,
  routes: [],
  nextRouteId: 1,
  activeRouteId: null,
  geocodeCache: new Map(),
  geocodeQueue: Promise.resolve(),
  geocodeGeneration: 0,
  geocodeAbortControllers: new Set(),
};

const gpxInput = document.getElementById("gpxInput");
const resolveLocationsBtn = document.getElementById("resolveLocationsBtn");
const clearFocusBtn = document.getElementById("clearFocusBtn");
const clearBtn = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");
const fileListEl = document.getElementById("fileList");
const layoutEl = document.querySelector(".layout");
const panelResizerEl = document.getElementById("panelResizer");
const mapStyleToggleEl = document.getElementById("mapStyleToggle");

if (layoutEl && panelResizerEl) {
  initializePanelResize();
}

if (mapStyleToggleEl) {
  mapStyleToggleEl.addEventListener("change", (event) => {
    setBaseLayer(event.target.checked ? "quiet" : "streets");
  });
}

gpxInput.addEventListener("change", async (event) => {
  const files = Array.from(event.target.files || []);

  if (!files.length) {
    setStatus("No files selected.");
    return;
  }

  await loadFromUploads(files);
  gpxInput.value = "";
});

clearBtn.addEventListener("click", () => {
  clearMap();
  setStatus("Cleared all tracks.");
});

if (clearFocusBtn) {
  clearFocusBtn.addEventListener("click", () => {
    clearFocus();
  });
}

if (resolveLocationsBtn) {
  resolveLocationsBtn.addEventListener("click", async () => {
    await resolveLocationsForLoadedRoutes();
  });
}

async function loadFromUploads(files) {
  setStatus(`Reading ${files.length} uploaded file${files.length === 1 ? "" : "s"} ...`);

  let loaded = 0;
  let skippedDuplicates = 0;
  const takenNames = new Set(state.routes.map((route) => normalizeFileName(route.fileName)));

  for (const file of files) {
    const normalizedName = normalizeFileName(file.name);
    if (takenNames.has(normalizedName)) {
      skippedDuplicates += 1;
      continue;
    }

    const xmlText = await file.text();
    const ok = drawGpx(file.name, xmlText);
    if (ok) {
      loaded += 1;
      takenNames.add(normalizedName);
    }
  }

  updateBounds();
  const duplicateMessage =
    skippedDuplicates > 0
      ? ` Skipped ${skippedDuplicates} duplicate file${skippedDuplicates === 1 ? "" : "s"}.`
      : "";
  setStatus(`Loaded ${loaded} of ${files.length} uploaded file${files.length === 1 ? "" : "s"}.${duplicateMessage}`);
}

function normalizeFileName(name) {
  return String(name).trim().toLowerCase();
}

function drawGpx(fileName, xmlText) {
  const xmlDoc = new DOMParser().parseFromString(xmlText, "application/xml");

  const parseError = xmlDoc.querySelector("parsererror");
  if (parseError) {
    addFileIssueListItem(fileName, "#9aa7b8", "Invalid XML");
    return false;
  }

  const segments = extractSegments(xmlDoc);
  if (!segments.length) {
    addFileIssueListItem(fileName, "#9aa7b8", "No track points found");
    return false;
  }

  const color = nextColor();
  const layerGroup = L.layerGroup();
  const allPoints = [];
  const mainLines = [];
  const haloLines = [];

  for (const points of segments) {
    const haloLine = L.polyline(points, {
      color: "#0f1725",
      weight: trackStyle.normalHaloWeight,
      opacity: trackStyle.normalHaloOpacity,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    });

    const line = L.polyline(points, {
      color,
      weight: trackStyle.normalMainWeight,
      opacity: trackStyle.normalMainOpacity,
      lineCap: "round",
      lineJoin: "round",
    });

    line.bindPopup(`<strong>${escapeHtml(fileName)}</strong><br />${points.length} points`);
    haloLine.addTo(layerGroup);
    line.addTo(layerGroup);
    mainLines.push(line);
    haloLines.push(haloLine);

    allPoints.push(...points);
  }

  if (allPoints.length > 0) {
    const start = allPoints[0];
    const end = allPoints[allPoints.length - 1];

    L.circleMarker(start, {
      radius: 4,
      color,
      fillColor: color,
      fillOpacity: 1,
      weight: 1,
    })
      .bindTooltip(`${escapeHtml(fileName)} start`)
      .addTo(layerGroup);

    L.circleMarker(end, {
      radius: 4,
      color,
      fillColor: "#ffffff",
      fillOpacity: 1,
      weight: 2,
    })
      .bindTooltip(`${escapeHtml(fileName)} end`)
      .addTo(layerGroup);
  }

  layerGroup.addTo(map);
  const route = {
    id: state.nextRouteId,
    fileName,
    color,
    pointsCount: allPoints.length,
    firstPoint: allPoints[0],
    coordKey: toCoordinateKey(allPoints[0]),
    locationKey: `coord:${toCoordinateKey(allPoints[0])}`,
    locationLabel: toCoordinateLabel(allPoints[0]),
    bounds: L.latLngBounds(allPoints),
    layer: layerGroup,
    mainLines,
    haloLines,
    isVisible: true,
  };

  for (const line of mainLines) {
    line.on("click", () => {
      setActiveRoute(route.id, { shouldScrollIntoView: true });
    });
  }

  state.nextRouteId += 1;
  state.routes.push(route);
  addFileListItem(route);
  updateRouteStyles();
  return true;
}

async function resolveLocationsForLoadedRoutes() {
  const pendingRoutes = state.routes.filter((route) => route.coordKey !== "unknown" && !route.locationKey.startsWith("geo:"));

  if (!pendingRoutes.length) {
    setStatus("No unresolved locations to geocode.");
    return;
  }

  if (resolveLocationsBtn) {
    resolveLocationsBtn.disabled = true;
    resolveLocationsBtn.textContent = "Resolving...";
  }

  const runGeneration = state.geocodeGeneration + 1;
  clearPendingGeocodeWork();

  try {
    const tasks = pendingRoutes.map((route) => requestReverseGeocodeForRoute(route));
    await Promise.all(tasks);

    const resolvedCount = state.routes.filter((route) => route.locationKey.startsWith("geo:")).length;
    setStatus(`Resolved locations for ${resolvedCount} file${resolvedCount === 1 ? "" : "s"}.`);
  } finally {
    // If another clear/cancel happened during processing, avoid re-enabling stale run state.
    if (state.geocodeGeneration >= runGeneration && resolveLocationsBtn) {
      resolveLocationsBtn.disabled = false;
      resolveLocationsBtn.textContent = "Resolve locations";
    }
  }
}

function extractSegments(xmlDoc) {
  const trkSegments = Array.from(xmlDoc.querySelectorAll("trkseg"));
  const routePoints = Array.from(xmlDoc.querySelectorAll("rtept"));

  const segments = trkSegments
    .map((segment) => {
      const points = Array.from(segment.querySelectorAll("trkpt"))
        .map(toLatLng)
        .filter(Boolean);
      return points;
    })
    .filter((points) => points.length > 1);

  if (segments.length > 0) {
    return segments;
  }

  if (routePoints.length > 1) {
    return [routePoints.map(toLatLng).filter(Boolean)];
  }

  return [];
}

function toLatLng(node) {
  const lat = Number(node.getAttribute("lat"));
  const lon = Number(node.getAttribute("lon"));

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return [lat, lon];
  }

  return null;
}

function nextColor() {
  const color = colorPalette[state.colorIndex % colorPalette.length];
  state.colorIndex += 1;
  return color;
}

function addFileListItem(route) {
  const groupList = ensureLocationGroup(route.locationKey, route.locationLabel);
  const li = document.createElement("li");
  li.dataset.routeId = String(route.id);

  const name = document.createElement("span");
  name.className = "file-name";
  name.textContent = route.fileName;

  const right = document.createElement("span");
  right.className = "file-right";

  const metaEl = document.createElement("span");
  metaEl.className = "file-meta";
  metaEl.textContent = `${route.pointsCount} pts`;

  const controls = document.createElement("span");
  controls.className = "file-actions";

  const centerBtn = document.createElement("button");
  centerBtn.type = "button";
  centerBtn.className = "mini-btn";
  centerBtn.textContent = "◎";
  centerBtn.title = "Center map on this route";
  centerBtn.setAttribute("aria-label", "Center map on this route");
  centerBtn.addEventListener("click", () => {
    centerRoute(route.id);
  });

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "mini-btn route-toggle-btn";
  toggleBtn.textContent = "◉";
  toggleBtn.title = "Hide this route";
  toggleBtn.setAttribute("aria-label", "Hide this route");
  toggleBtn.addEventListener("click", () => {
    toggleRouteVisibility(route.id);
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "mini-btn danger";
  deleteBtn.textContent = "✕";
  deleteBtn.title = "Delete this route";
  deleteBtn.setAttribute("aria-label", "Delete this route");
  deleteBtn.addEventListener("click", () => {
    deleteRoute(route.id);
  });

  controls.append(centerBtn, toggleBtn, deleteBtn);

  const dot = document.createElement("span");
  dot.className = "color-dot";
  dot.style.backgroundColor = route.color;

  right.append(metaEl, controls, dot);
  li.append(name, right);
  groupList.appendChild(li);
}

function addFileIssueListItem(fileName, color, meta) {
  const li = document.createElement("li");

  const name = document.createElement("span");
  name.className = "file-name";
  name.textContent = fileName;

  const right = document.createElement("span");
  right.className = "file-right";

  const metaEl = document.createElement("span");
  metaEl.className = "file-meta";
  metaEl.textContent = meta;

  const dot = document.createElement("span");
  dot.className = "color-dot";
  dot.style.backgroundColor = color;

  right.append(metaEl, dot);
  li.append(name, right);
  fileListEl.appendChild(li);
}

function updateBounds() {
  const visibleRoutes = state.routes.filter((route) => route.isVisible && map.hasLayer(route.layer));
  if (!visibleRoutes.length) {
    map.setView([20, 0], 2);
    return;
  }

  const merged = L.latLngBounds([]);

  for (const route of visibleRoutes) {
    route.layer.eachLayer((layer) => {
      if (typeof layer.getLatLng === "function") {
        merged.extend(layer.getLatLng());
        return;
      }

      if (typeof layer.getLatLngs === "function") {
        extendBoundsWithLatLngs(merged, layer.getLatLngs());
      }
    });
  }

  if (!merged.isValid()) {
    return;
  }

  map.fitBounds(merged.pad(0.12));
}

function updateRouteStyles() {
  const activeRoute = state.routes.find((route) => route.id === state.activeRouteId && route.isVisible) || null;

  for (const route of state.routes) {
    const isActive = activeRoute && route.id === activeRoute.id;
    const shouldDim = Boolean(activeRoute) && !isActive;

    for (const line of route.mainLines || []) {
      line.setStyle({
        weight: isActive
          ? trackStyle.activeMainWeight
          : shouldDim
            ? trackStyle.dimMainWeight
            : trackStyle.normalMainWeight,
        opacity: isActive
          ? trackStyle.activeMainOpacity
          : shouldDim
            ? trackStyle.dimMainOpacity
            : trackStyle.normalMainOpacity,
      });
      if (line.bringToFront) {
        line.bringToFront();
      }
    }

    for (const haloLine of route.haloLines || []) {
      haloLine.setStyle({
        weight: isActive
          ? trackStyle.activeHaloWeight
          : shouldDim
            ? trackStyle.dimHaloWeight
            : trackStyle.normalHaloWeight,
        opacity: isActive
          ? trackStyle.activeHaloOpacity
          : shouldDim
            ? trackStyle.dimHaloOpacity
            : trackStyle.normalHaloOpacity,
      });
    }

    const li = findRouteListItem(route.id);
    if (li) {
      li.classList.toggle("is-active", Boolean(isActive));
    }
  }
}

function extendBoundsWithLatLngs(bounds, latLngs) {
  for (const item of latLngs) {
    if (Array.isArray(item)) {
      extendBoundsWithLatLngs(bounds, item);
    } else if (item && typeof item.lat === "number" && typeof item.lng === "number") {
      bounds.extend(item);
    }
  }
}

function toggleRouteVisibility(routeId) {
  const route = state.routes.find((entry) => entry.id === routeId);
  if (!route) {
    return;
  }

  route.isVisible = !route.isVisible;

  if (route.isVisible) {
    route.layer.addTo(map);
  } else {
    map.removeLayer(route.layer);
    if (state.activeRouteId === route.id) {
      state.activeRouteId = null;
    }
  }

  const li = findRouteListItem(route.id);
  if (li) {
    li.classList.toggle("is-hidden", !route.isVisible);
    const toggleBtn = li.querySelector(".route-toggle-btn");
    if (toggleBtn) {
      toggleBtn.textContent = route.isVisible ? "◉" : "◌";
      const actionText = route.isVisible ? "Hide this route" : "Show this route";
      toggleBtn.title = actionText;
      toggleBtn.setAttribute("aria-label", actionText);
    }
  }

  updateRouteStyles();
}

function centerRoute(routeId) {
  const route = state.routes.find((entry) => entry.id === routeId);
  if (!route || !route.bounds || !route.bounds.isValid()) {
    return;
  }

  if (!route.isVisible || !map.hasLayer(route.layer)) {
    setStatus(`${route.fileName} is hidden. Show it first to center and focus.`);
    return;
  }

  setActiveRoute(route.id);
  map.fitBounds(route.bounds.pad(0.16));
  setStatus(`Centered map on ${route.fileName}.`);
}

function deleteRoute(routeId) {
  const routeIndex = state.routes.findIndex((entry) => entry.id === routeId);
  if (routeIndex === -1) {
    return;
  }

  const route = state.routes[routeIndex];
  map.removeLayer(route.layer);
  state.routes.splice(routeIndex, 1);

  if (state.activeRouteId === route.id) {
    state.activeRouteId = null;
  }

  const li = findRouteListItem(routeId);
  if (li) {
    const groupEl = li.closest(".location-group");
    li.remove();

    if (groupEl && !groupEl.querySelector("li[data-route-id]")) {
      groupEl.remove();
    }
  }

  updateRouteStyles();
  cleanupEmptyLocationGroups();
  updateBounds();
  setStatus(`Removed ${route.fileName}.`);
}

function ensureLocationGroup(locationKey, locationLabel) {
  let groupEl = fileListEl.querySelector(`.location-group[data-location-key="${locationKey}"]`);
  if (!groupEl) {
    groupEl = document.createElement("div");
    groupEl.className = "location-group";
    groupEl.dataset.locationKey = locationKey;

    const titleEl = document.createElement("div");
    titleEl.className = "location-group-title";
    titleEl.textContent = locationLabel;

    const listEl = document.createElement("ul");
    listEl.className = "location-group-list";

    groupEl.append(titleEl, listEl);
    fileListEl.appendChild(groupEl);
  } else {
    const titleEl = groupEl.querySelector(".location-group-title");
    if (titleEl) {
      titleEl.textContent = locationLabel;
    }
  }

  const listEl = groupEl.querySelector(".location-group-list");
  return listEl;
}

function cleanupEmptyLocationGroups() {
  const groups = Array.from(fileListEl.querySelectorAll(".location-group"));
  for (const groupEl of groups) {
    if (!groupEl.querySelector("li[data-route-id]")) {
      groupEl.remove();
    }
  }
}

function toCoordinateKey(point) {
  const lat = Number(point?.[0]);
  const lon = Number(point?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return "unknown";
  }

  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

function toCoordinateLabel(point) {
  const lat = Number(point?.[0]);
  const lon = Number(point?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return "Unknown start location";
  }

  return `Start: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

async function requestReverseGeocodeForRoute(route) {
  if (!route?.firstPoint || route.coordKey === "unknown") {
    return;
  }

  const generation = state.geocodeGeneration;

  let geocodePromise = state.geocodeCache.get(route.coordKey);
  if (!geocodePromise) {
    geocodePromise = enqueueReverseGeocode(route.firstPoint, generation);
    state.geocodeCache.set(route.coordKey, geocodePromise);
  }

  const geocodeResult = await geocodePromise;
  if (!geocodeResult || generation !== state.geocodeGeneration) {
    return;
  }

  applyResolvedLocationToRoute(route.id, geocodeResult);
}

function enqueueReverseGeocode(point, generation) {
  const run = state.geocodeQueue.then(async () => {
    if (generation !== state.geocodeGeneration) {
      return null;
    }

    const result = await reverseGeocodePoint(point, generation);

    if (generation !== state.geocodeGeneration) {
      return null;
    }

    await delay(1100);
    return result;
  });

  state.geocodeQueue = run.catch(() => null);
  return run.catch(() => null);
}

async function reverseGeocodePoint(point, generation) {
  const lat = Number(point?.[0]);
  const lon = Number(point?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  if (generation !== state.geocodeGeneration) {
    return null;
  }

  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}` +
    `&lon=${encodeURIComponent(lon)}&zoom=10&addressdetails=1`;

  const controller = new AbortController();
  state.geocodeAbortControllers.add(controller);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const location = extractLocationFromNominatim(data);
    if (!location) {
      return null;
    }

    return {
      key: `geo:${location.key}`,
      label: location.label,
    };
  } catch {
    return null;
  } finally {
    state.geocodeAbortControllers.delete(controller);
  }
}

function extractLocationFromNominatim(data) {
  const address = data?.address || {};
  const locality =
    address.city ||
    address.town ||
    address.village ||
    address.hamlet ||
    address.municipality ||
    address.county ||
    address.state_district ||
    address.state;
  const country = address.country;

  if (!locality && !country) {
    return null;
  }

  const label = locality && country ? `${locality}, ${country}` : locality || country;
  const key = [locality || "", country || ""].join("|").trim().toLowerCase();

  return {
    key: key || "unknown",
    label,
  };
}

function applyResolvedLocationToRoute(routeId, location) {
  const route = state.routes.find((entry) => entry.id === routeId);
  if (!route || !location?.key || !location?.label) {
    return;
  }

  if (route.locationKey === location.key && route.locationLabel === location.label) {
    return;
  }

  route.locationKey = location.key;
  route.locationLabel = location.label;

  const li = findRouteListItem(route.id);
  if (!li) {
    return;
  }

  const targetList = ensureLocationGroup(route.locationKey, route.locationLabel);
  targetList.appendChild(li);
  cleanupEmptyLocationGroups();
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function setActiveRoute(routeId, options = {}) {
  const { shouldScrollIntoView = false } = options;
  const route = state.routes.find((entry) => entry.id === routeId);
  if (!route || !route.isVisible || !map.hasLayer(route.layer)) {
    return;
  }

  state.activeRouteId = route.id;
  updateRouteStyles();

  if (shouldScrollIntoView) {
    scrollRouteListItemIntoView(route.id);
  }
}

function scrollRouteListItemIntoView(routeId) {
  const li = findRouteListItem(routeId);
  if (!li) {
    return;
  }

  li.scrollIntoView({
    behavior: "smooth",
    block: "nearest",
    inline: "nearest",
  });
}

function clearFocus() {
  if (state.activeRouteId === null) {
    setStatus("No focused route to clear.");
    return;
  }

  state.activeRouteId = null;
  updateRouteStyles();
  setStatus("Cleared route focus.");
}

function setBaseLayer(layerId) {
  const nextLayer = baseLayers[layerId] || baseLayers.quiet;
  if (nextLayer === activeBaseLayer) {
    return;
  }

  map.removeLayer(activeBaseLayer);
  nextLayer.addTo(map);
  activeBaseLayer = nextLayer;
}

function findRouteListItem(routeId) {
  return fileListEl.querySelector(`li[data-route-id="${routeId}"]`);
}

function clearMap() {
  clearPendingGeocodeWork();

  for (const route of state.routes) {
    map.removeLayer(route.layer);
  }

  state.routes = [];
  state.nextRouteId = 1;
  state.activeRouteId = null;
  state.colorIndex = 0;
  fileListEl.innerHTML = "";
  map.setView([20, 0], 2);
}

function clearPendingGeocodeWork() {
  state.geocodeGeneration += 1;
  state.geocodeCache.clear();
  state.geocodeQueue = Promise.resolve();

  for (const controller of state.geocodeAbortControllers) {
    controller.abort();
  }

  state.geocodeAbortControllers.clear();
}

function setStatus(message) {
  statusEl.textContent = message;
}

function initializePanelResize() {
  const minWidth = 280;
  let isDragging = false;

  panelResizerEl.addEventListener("pointerdown", (event) => {
    if (window.matchMedia("(max-width: 980px)").matches) {
      return;
    }

    isDragging = true;
    panelResizerEl.classList.add("is-dragging");
    document.body.classList.add("is-resizing");
    panelResizerEl.setPointerCapture(event.pointerId);
  });

  panelResizerEl.addEventListener("pointermove", (event) => {
    if (!isDragging) {
      return;
    }

    const layoutRect = layoutEl.getBoundingClientRect();
    const maxWidth = Math.max(minWidth + 40, Math.min(680, layoutRect.width * 0.75));
    const nextWidth = clamp(event.clientX - layoutRect.left, minWidth, maxWidth);

    layoutEl.style.setProperty("--panel-width", `${nextWidth}px`);
    map.invalidateSize({ pan: false, debounceMoveend: true });
  });

  const stopDrag = (pointerId) => {
    if (!isDragging) {
      return;
    }

    isDragging = false;
    panelResizerEl.classList.remove("is-dragging");
    document.body.classList.remove("is-resizing");

    if (pointerId !== undefined && panelResizerEl.hasPointerCapture(pointerId)) {
      panelResizerEl.releasePointerCapture(pointerId);
    }

    map.invalidateSize({ pan: false });
  };

  panelResizerEl.addEventListener("pointerup", (event) => {
    stopDrag(event.pointerId);
  });

  panelResizerEl.addEventListener("pointercancel", (event) => {
    stopDrag(event.pointerId);
  });

  window.addEventListener("resize", () => {
    map.invalidateSize({ pan: false });
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(input) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
