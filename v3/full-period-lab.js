import { collection, doc, getDoc, getDocs, limit, orderBy, query, where } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getDownloadURL, ref } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";
import { addForecastLayers, loadMapbox, MAPBOX_TOKEN, BOUNDS } from "./first-hour-lab.js?v=2";

const dateFormat = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London" });
const ukTime = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" });
const empty = { type: "FeatureCollection", features: [] };
const storageHosts = ["storage.googleapis.com", "firebasestorage.googleapis.com"];

function ukDay(value) {
    const parts = Object.fromEntries(dateFormat.formatToParts(value).map(({type, value}) => [type, value]));
    return [parts.year, parts.month, parts.day].join("-");
}

function forecastTime(run, field, legacy) {
    const timestamp = run[field]?.toMillis?.();
    if (Number.isFinite(timestamp)) return timestamp;
    const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(run[legacy] || "");
    return match ? Date.UTC(+match[3], +match[2] - 1, +match[1], +match[4], +match[5]) : NaN;
}

function datesOf(run) {
    return [forecastTime(run, "validFrom", "startTime"), forecastTime(run, "validTo", "endTime")];
}

export function isFullForecastPair(ai, traditional) {
    if (!ai || !traditional || ai.cancelled || traditional.cancelled || ai.type !== "ai" ||
        traditional.type !== "automated" || ai.sourceRunId !== traditional.id || ai.region !== traditional.region) return false;
    const [start, end] = datesOf(ai);
    const [tradStart, tradEnd] = datesOf(traditional);
    return Number.isFinite(start) && end > start && start === tradStart && end === tradEnd;
}

async function fetchMap(run, storage, signal) {
    const inline = run.inlineGeojson ?? run.inlineGeojsonText ?? run.geojson;
    if (inline) return typeof inline === "string" ? JSON.parse(inline) : inline;
    const url = new URL(run.geojsonUrl);
    if (url.protocol !== "https:" || !storageHosts.includes(url.hostname)) throw Error("Unsupported forecast URL");
    let response = await fetch(url, { signal });
    if ((response.status === 401 || response.status === 403) && run.geojsonPath) {
        response = await fetch(await getDownloadURL(ref(storage, run.geojsonPath)), { signal });
    }
    if (!response.ok) throw Error("Could not load forecast map");
    const data = await response.json();
    if (data?.type !== "FeatureCollection" || !Array.isArray(data.features)) throw Error("Invalid forecast GeoJSON");
    return data;
}

export function startFullPeriodLab(db, storage) {
    const get = id => document.getElementById(id);
    const section = get("fullPeriodLab"), day = get("fullDay"), region = get("fullRegion");
    const date = get("fullIssueDate"), run = get("fullRun"), status = get("fullStatus"), grid = get("fullMaps");
    date.value = date.max = ukDay(Date.now());
    let choices = [], revision = 0, request, maps = [], mapRegion, syncing = false;
    let priorSelection = "";

    function clear() {
        grid.hidden = true;
        get("fullLegend").replaceChildren();
        maps.forEach(map => map.getSource("shadow-risk")?.setData(empty));
    }

    async function show() {
        const ai = choices.find(item => item.id === run.value);
        if (!ai) return;
        priorSelection = ai.id;
        const stamp = ++revision;
        request?.abort();
        request = new AbortController();
        const signal = request.signal;
        status.textContent = "Loading the matched full forecasts…";
        clear();
        try {
            const snapshot = await getDoc(doc(db, "hoco_requests", ai.sourceRunId));
            const traditional = snapshot.exists() ? { ...snapshot.data(), id: snapshot.id } : null;
            if (!isFullForecastPair(ai, traditional)) {
                if (stamp === revision) status.textContent = "This AI run has no Traditional forecast with the same validity period.";
                return;
            }
            const [left, right, box] = await Promise.all([fetchMap(traditional, storage, signal), fetchMap(ai, storage, signal), loadMapbox()]);
            if (stamp !== revision) return;
            const bounds = BOUNDS[region.value.toLowerCase()];
            grid.hidden = false;
            if (!maps.length) {
                box.accessToken = MAPBOX_TOKEN;
                const style = document.documentElement.dataset.theme === "dark" ? "mapbox://styles/mapbox/dark-v11" : "mapbox://styles/mapbox/light-v11";
                maps = ["fullTradMap", "fullAiMap"].map(container => new box.Map({
                    container, style, bounds, fitBoundsOptions: { padding: 20 },
                    dragRotate: false, pitchWithRotate: false
                }));
                mapRegion = region.value;
                maps.forEach((map, index) => map.on("move", () => {
                    if (syncing) return;
                    syncing = true;
                    maps[1 - index].jumpTo({ center: map.getCenter(), zoom: map.getZoom() });
                    syncing = false;
                }));
            }
            const ready = maps.map((map, index) => new Promise(resolve => {
                const set = () => {
                    if (stamp === revision) {
                        if (!map.getSource("shadow-risk")) addForecastLayers(map);
                        map.getSource("shadow-risk").setData(index === 0 ? left : right);
                    }
                    resolve();
                };
                if (map.loaded() || map.getSource("shadow-risk")) set();
                else map.once("load", set);
            }));
            maps.forEach(map => map.resize());
            if (mapRegion !== region.value) {
                maps[0].fitBounds(bounds, { padding: 20, duration: 0 });
                mapRegion = region.value;
            }
            await Promise.all(ready);
            if (stamp === revision) {
                const [start, end] = datesOf(ai);
                for (const band of right.properties?.bands || left.properties?.bands || []) {
                    if (!/^#[0-9a-f]{6}$/i.test(band.fill) || typeof band.label !== "string") continue;
                    const key = document.createElement("span");
                    const swatch = document.createElement("i");
                    swatch.style.backgroundColor = band.fill;
                    key.append(swatch, document.createTextNode(band.label));
                    get("fullLegend").append(key);
                }
                status.textContent = `Both forecasts valid from ${ukTime.format(start)} to ${ukTime.format(end)} UK time.`;
            }
        } catch (err) {
            if (stamp === revision && err.name !== "AbortError") {
                clear();
                status.textContent = "One or both maps could not be loaded. Try another saved run.";
            }
        }
    }

    async function search() {
        const stamp = ++revision;
        request?.abort();
        clear();
        choices = [];
        run.disabled = true;
        run.replaceChildren();
        if (!date.value) { status.textContent = "Choose an issue date."; return; }
        status.textContent = "Finding AI forecasts…";
        const dateKey = date.value;
        const midnight = Date.parse(dateKey + "T00:00:00Z");
        const start = new Date(midnight - 3600000), end = new Date(midnight + 25 * 3600000);
        try {
            const results = await getDocs(query(collection(db, "hoco_requests"),
                where("createdAt", ">=", start), where("createdAt", "<", end), orderBy("createdAt", "desc"), limit(700)));
            if (stamp !== revision) return;
            choices = results.docs.map(doc => ({ ...doc.data(), id: doc.id })).filter(r =>
                r.type === "ai" && !r.cancelled && r.region === region.value &&
                typeof r.sourceRunId === "string" && r.sourceRunId &&
                ukDay(r.createdAt.toMillis()) === dateKey &&
                (r.ml?.bucket || "day" + /-Day([012])(?:-|$)/i.exec(r.sourceRunId)?.[1]) === day.value);
            run.replaceChildren(...choices.map(r => new Option(ukTime.format(r.createdAt.toMillis()), r.id)));
            run.disabled = !choices.length;
            if (!choices.length) { status.textContent = "No saved full-period AI HOCO forecast for this date, region and forecast day."; return; }
            if (choices.some(r => r.id === priorSelection)) run.value = priorSelection;
            show();
        } catch {
            if (stamp === revision) status.textContent = "The forecast archive could not be loaded.";
        }
    }

    [region, day, date].forEach(control => control.addEventListener("change", search));
    run.addEventListener("change", show);
    const visible = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
            visible.disconnect();
            if (!revision) search();
        }
    });
    visible.observe(section);
    new ResizeObserver(() => {
        if (!grid.hidden && grid.clientWidth) maps.forEach(map => map.resize());
    }).observe(grid);
}
