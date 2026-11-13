import { IsoMap } from "./map.js";

const canvas = document.querySelector("#map");
const map = new IsoMap(canvas);
const statusEl = document.querySelector("#status");
const scaleEl = document.querySelector("#scale");
const layersEl = document.querySelector("#layers");
const toursEl = document.querySelector("#tours");
const card = document.querySelector("#card");
const search = document.querySelector("#q");

const state = {
  catalog: null,
  enabled: new Set(),
  query: "",
  tab: "lugares",
};

map.onSelect = (id) => showPlace(id, true);

function foldAccents(value) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function placesOf(layerId) {
  return state.catalog.places.filter((place) => place.layer === layerId);
}

function visiblePlaces() {
  const query = foldAccents(state.query.trim());
  return state.catalog.places.filter((place) => {
    if (!state.enabled.has(place.layer)) return false;
    if (!query) return true;
    return foldAccents(`${place.name} ${place.address} ${place.summary}`).includes(query);
  });
}

function renderLayers() {
  const query = state.query.trim();
  const groups = [];
  for (const layer of state.catalog.layers) {
    const items = placesOf(layer.id).filter((place) => {
      if (!query) return true;
      return foldAccents(`${place.name} ${place.address} ${place.summary}`).includes(foldAccents(query));
    });
    if (!items.length) continue;
    let group = groups.find((item) => item.name === layer.group);
    if (!group) {
      group = { name: layer.group, layers: [] };
      groups.push(group);
    }
    group.layers.push({ layer, items });
  }

  layersEl.replaceChildren();
  for (const group of groups) {
    const label = document.createElement("p");
    label.className = "group-label";
    label.textContent = group.name;
    layersEl.append(label);
    for (const { layer, items } of group.layers) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `layer${state.enabled.has(layer.id) ? " is-on" : ""}`;
      button.innerHTML = `<span>${layer.name}</span><span class="count">${items.length}</span>`;
      button.setAttribute("aria-pressed", String(state.enabled.has(layer.id)));
      button.addEventListener("click", () => {
        if (state.enabled.has(layer.id)) state.enabled.delete(layer.id);
        else state.enabled.add(layer.id);
        syncMap();
        renderLayers();
      });
      layersEl.append(button);
      if (!state.enabled.has(layer.id)) continue;
      for (const place of items) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = `place${map.selected === place.id ? " is-on" : ""}`;
        row.innerHTML = `<strong>${place.name}</strong><span>${place.address}</span>`;
        row.addEventListener("click", () => showPlace(place.id, true));
        layersEl.append(row);
      }
    }
  }
  if (!groups.length) {
    const empty = document.createElement("p");
    empty.className = "fine";
    empty.textContent = "Ningún lugar coincide con esa búsqueda.";
    layersEl.append(empty);
  }
}

function renderTours() {
  toursEl.replaceChildren();
  for (const tour of state.catalog.tours) {
    const stops = tour.stops
      .map((id) => state.catalog.places.find((place) => place.id === id))
      .filter(Boolean);
    if (!stops.length) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tour";
    button.innerHTML = `<strong>${tour.name}</strong><span>${tour.summary}</span>`;
    button.addEventListener("click", () => startTour(stops));
    toursEl.append(button);
  }
}

let tourStops = [];
let tourIndex = 0;

function startTour(stops) {
  tourStops = stops;
  tourIndex = 0;
  openStop();
}

function openStop() {
  const place = tourStops[tourIndex];
  if (!place) return;
  state.enabled.add(place.layer);
  showPlace(place.id, true);
}

function showPlace(id, move) {
  map.select(id);
  if (!id) {
    card.hidden = true;
    history.replaceState(null, "", location.pathname + location.search);
    renderLayers();
    return;
  }
  const place = state.catalog.places.find((item) => item.id === id);
  if (!place) return;
  state.enabled.add(place.layer);
  document.querySelector("#card-kicker").textContent = state.catalog.layers.find((layer) => layer.id === place.layer)?.name || "";
  document.querySelector("#card-title").textContent = place.name;
  document.querySelector("#card-address").textContent = place.address;
  document.querySelector("#card-summary").textContent = place.summary;
  document.querySelector("#card-source").textContent = `Fuente: ${place.source}`;
  card.hidden = false;
  if (move) map.focus(place.x, place.y, Math.max(map.cam.zoom, 1.35));
  history.replaceState(null, "", `#${place.id}`);
  syncMap();
  renderLayers();
}

function syncMap() {
  map.setPlaces(state.catalog.places, state.enabled);
  scaleEl.textContent = map.scaleLabel();
}

function setTab(name) {
  state.tab = name;
  for (const button of document.querySelectorAll(".tab")) {
    const on = button.dataset.tab === name;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-selected", String(on));
  }
  for (const view of ["lugares", "recorridos", "acerca"]) {
    document.querySelector(`#view-${view}`).hidden = view !== name;
  }
}

function frame() {
  if (map.dirty) {
    map.draw();
    if (state.catalog) {
      scaleEl.textContent = map.scaleLabel();
    }
  }
  requestAnimationFrame(frame);
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => setTab(button.dataset.tab));
});
document.querySelector("#fold").addEventListener("click", () => {
  document.querySelector("#panel").classList.toggle("is-folded");
  requestAnimationFrame(() => map.resize());
});
search.addEventListener("input", () => {
  state.query = search.value;
  renderLayers();
});
document.querySelector("#card-close").addEventListener("click", () => showPlace(null, false));
document.querySelector("#north").addEventListener("click", () => map.resetNorth());
document.querySelector("#zoom-in").addEventListener("click", () => map.zoomBy(1.25));
document.querySelector("#zoom-out").addEventListener("click", () => map.zoomBy(0.8));
document.querySelector("#rot-l").addEventListener("click", () => map.rotate(-1));
document.querySelector("#rot-r").addEventListener("click", () => map.rotate(1));
document.querySelector("#night").addEventListener("click", (event) => {
  map.night = !map.night;
  event.currentTarget.setAttribute("aria-pressed", String(map.night));
  map.dirty = true;
});
document.querySelector("#labels").addEventListener("click", (event) => {
  map.labels = !map.labels;
  event.currentTarget.setAttribute("aria-pressed", String(map.labels));
  map.dirty = true;
});

window.addEventListener("keydown", (event) => {
  if (event.target.matches("input, textarea")) return;
  if (event.key === "ArrowUp") map._pan(0, -70);
  if (event.key === "ArrowDown") map._pan(0, 70);
  if (event.key === "ArrowLeft") map._pan(-70, 0);
  if (event.key === "ArrowRight") map._pan(70, 0);
  if (event.key === "+" || event.key === "=") map.zoomBy(1.2);
  if (event.key === "-" || event.key === "_") map.zoomBy(0.84);
  if (event.key === "q" || event.key === "Q") map.rotate(-1);
  if (event.key === "e" || event.key === "E") map.rotate(1);
  if (event.key === "Escape") showPlace(null, false);
  if (event.key === "n" || event.key === "N") map.resetNorth();
});

window.addEventListener("resize", () => map.resize());
map.resize();
frame();

const [city, catalog] = await Promise.all([
  fetch("data/city.json").then((response) => response.json()),
  fetch("data/places.json").then((response) => response.json()),
]);

state.catalog = catalog;
for (const layer of catalog.layers) {
  if (!layer.off) state.enabled.add(layer.id);
}
map.setCity(city);
syncMap();
renderLayers();
renderTours();
statusEl.textContent = `${city.buildings.length.toLocaleString("es-CL")} edificios · datos © OpenStreetMap`;
const hash = location.hash.replace("#", "");
if (hash) showPlace(hash, true);
