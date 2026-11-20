import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { doc, getDoc, getFirestore, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const app = initializeApp({ apiKey: "AIzaSyA8IYTApDl8vhZENPJXIw48rR_SUhfFPVQ", projectId: "hoco-3b23e" });
const db = getFirestore(app);
const $ = (id) => document.getElementById(id);
const region = $("region"), day = $("day"), period = $("period"), status = $("status");
const validTime = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/London", timeZoneName: "short" });
const empty = { type: "FeatureCollection", features: [] };
const defaultBounds = { England: [-10.234, 48.788, 5.471, 56.578], Scotland: [-9.4482, 55.9161, 0, 60] };
const url = new URL(location.href);
region.value = url.searchParams.get("region") === "Scotland" ? "Scotland" : "England";
day.value = ["0", "1", "2"].includes(url.searchParams.get("day")) ? url.searchParams.get("day") : "0";
let chosen = url.searchParams.get("window");
let stop, map, mapRegion, record, expiry, abort, request = 0, subscription = 0;
let risk = empty, boundary = empty;
let windows = [];

function forecastRef(r, d) {
    return doc(db, "system_stats", `storm_timing_${r.toLowerCase()}_day${d}`);
}

function liveWindows(data, now = Date.now()) {
    return data?.schema === 1 && Array.isArray(data.windows)
        ? data.windows.filter((item) => item.validFrom?.toMillis?.() < item.validTo?.toMillis?.() &&
            item.validTo.toMillis() > now) : [];
}

function range(window) {
    return `${validTime.format(window.validFrom.toDate())} – ${validTime.format(window.validTo.toDate())}`;
}

function updateAddress() {
    url.searchParams.set("region", region.value);
    url.searchParams.set("day", day.value);
    if (chosen) url.searchParams.set("window", chosen);
    else url.searchParams.delete("window");
    history.replaceState(null, "", url);
    $("back").href = "./?" + new URLSearchParams({ region: region.value, day: day.value });
}

function setSources() {
    map?.getSource("timed-risk")?.setData(risk);
    map?.getSource("timed-coverage")?.setData(boundary);
}

function startMap() {
    const box = window.mapboxgl;
    if (!box) return;
    box.accessToken = "pk.eyJ1IjoiaGFuZHJ5MjAxOTEwMjYiLCJhIjoiY21jYWg2eG1lMDNkYTJxczVyOWM5bW9mciJ9.bA-qxiByTB_RseY1fgU4rg";
    try {
        map = new box.Map({ container: "map", style: "mapbox://styles/mapbox/light-v11",
            bounds: defaultBounds[region.value], fitBoundsOptions: { padding: 20 }, maxZoom: 11 });
        map.addControl(new box.NavigationControl({ showCompass: false }), "top-right");
        map.on("load", () => {
            map.addSource("timed-risk", { type: "geojson", data: risk });
            const label = map.getStyle().layers.find((layer) => layer.type === "symbol" &&
                layer.layout?.["text-field"])?.id;
            map.addLayer({ id: "timed-fill", type: "fill", source: "timed-risk",
                filter: ["==", ["get", "feature_type"], "polygon"],
                paint: { "fill-color": ["get", "fill"], "fill-opacity": .66 } }, label);
            map.addSource("timed-coverage", { type: "geojson", data: boundary });
            map.addLayer({ id: "timed-coverage-halo", type: "line", source: "timed-coverage",
                paint: { "line-color": "#fff", "line-width": 3.5, "line-opacity": .8 } });
            map.addLayer({ id: "timed-coverage-line", type: "line", source: "timed-coverage",
                paint: { "line-color": "#284e74", "line-dasharray": [2, 2], "line-width": 1.8 } });
            fitRegion();
        });
    } catch {
        map = null;
        status.textContent = "The map could not start in this browser.";
    }
}

function fitRegion() {
    const bounds = record?.bounds || defaultBounds[region.value];
    if (map && mapRegion !== region.value && bounds?.length === 4 && bounds.every(Number.isFinite)) {
        mapRegion = region.value;
        map.fitBounds(bounds, { padding: 18, duration: 0 });
    }
}

function updateBands(data) {
    const colors = $("bands");
    colors.replaceChildren();
    for (const band of data.properties?.bands || []) {
        if (!/^#[0-9a-f]{6}$/i.test(band.fill)) continue;
        const key = document.createElement("span"), square = document.createElement("span");
        key.className = "key";
        square.className = "swatch";
        square.style.backgroundColor = band.fill;
        key.append(square, document.createTextNode(band.label));
        colors.append(key);
    }
}

async function showWindow(item) {
    const token = ++request;
    abort?.abort();
    abort = new AbortController();
    risk = empty;
    setSources();
    updateBands(empty);
    const issued = record.issuedAt?.toDate?.();
    const description = `Valid ${range(item)}${issued ? ` · Issued ${validTime.format(issued)}` : ""}`;
    status.textContent = `Loading · ${description}`;
    try {
        const endpoint = new URL(item.geojsonUrl);
        if (endpoint.protocol !== "https:" ||
            !["storage.googleapis.com", "firebasestorage.googleapis.com"].includes(endpoint.hostname)) throw Error();
        const response = await fetch(endpoint, { signal: abort.signal });
        if (!response.ok) throw Error();
        const data = await response.json();
        if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) throw Error();
        if (token !== request || item.validTo.toMillis() <= Date.now()) return;
        risk = data;
        updateBands(data);
        setSources();
        status.textContent = description;
    } catch (error) {
        if (token === request && error.name !== "AbortError") status.textContent = "This forecast map could not be loaded.";
    }
}

function render(preserveChoice = false) {
    clearTimeout(expiry);
    ++request;
    abort?.abort();
    risk = boundary = empty;
    updateBands(empty);
    windows = liveWindows(record);
    const source = $("source");
    source.hidden = !windows.length;
    period.disabled = !windows.length;
    period.replaceChildren();
    if (!windows.length) {
        status.textContent = day.value === "0" ? "No first-hour forecast is active. Try Day 1 or Day 2."
            : "No storm timing forecast is available for this region and day.";
        if (!preserveChoice) chosen = null;
        updateAddress();
        fitRegion();
        setSources();
        return;
    }
    const now = Date.now();
    const coordinates = record.verificationBoundary?.map(({ lon, lat }) => [lon, lat]);
    if (coordinates?.length >= 2 && coordinates.every((pair) => pair.every(Number.isFinite))) {
        boundary = { type: "FeatureCollection", features: [{ type: "Feature", properties: {},
            geometry: { type: "LineString", coordinates } }] };
    }
    windows.forEach((item, index) => period.add(new Option(range(item), index)));
    const match = windows.findIndex((w) => w.validFrom.toDate().toISOString() === chosen);
    period.value = String(Math.max(0, match));
    const item = windows[Number(period.value)];
    chosen = item.validFrom.toDate().toISOString();
    source.href = "./?" + new URLSearchParams({ region: region.value, day: day.value, run: record.sourceRunId });
    updateAddress();
    fitRegion();
    setSources();
    expiry = setTimeout(render, windows[0].validTo.toMillis() - now + 30);
    showWindow(item);
}

async function chooseAvailable(watch, watchedRegion) {
    for (const candidate of ["1", "2"]) {
        try {
            const snapshot = await getDoc(forecastRef(watchedRegion, candidate));
            if (watch !== subscription || liveWindows(record).length) return;
            if (liveWindows(snapshot.data()).length) {
                day.value = candidate;
                watchForecast();
                return;
            }
        } catch {
            if (watch !== subscription) return;
        }
    }
}

function watchForecast(preferAvailable = false) {
    stop?.();
    const watch = ++subscription, watchedRegion = region.value, watchedDay = day.value;
    let choose = preferAvailable && watchedDay === "0";
    record = null;
    render(true);
    status.textContent = "Loading storm timing forecasts…";
    stop = onSnapshot(forecastRef(watchedRegion, watchedDay), (snapshot) => {
        if (watch !== subscription) return;
        record = snapshot.data();
        render(snapshot.metadata?.fromCache);
        if (choose && !snapshot.metadata?.fromCache) {
            choose = false;
            if (!liveWindows(record).length) chooseAvailable(watch, watchedRegion);
        }
    }, () => {
        if (watch !== subscription) return;
        status.textContent = "Storm timing forecasts are temporarily unavailable.";
    });
}

function chooseWindow() {
    const item = windows[Number(period.value)];
    if (!item) return;
    chosen = item.validFrom.toDate().toISOString();
    updateAddress();
    showWindow(item);
}

region.onchange = day.onchange = () => { chosen = null; watchForecast(); };
period.onchange = chooseWindow;
if (window.mapboxgl) startMap();
else window.addEventListener("load", startMap, { once: true });
watchForecast(!url.searchParams.has("window"));
