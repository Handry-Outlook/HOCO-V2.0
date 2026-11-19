import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const MAPBOX_VERSION = "3.2.0";
const MAPBOX_TOKEN = "pk.eyJ1IjoiaGFuZHJ5MjAxOTEwMjYiLCJhIjoiY21jYWg2eG1lMDNkYTJxczVyOWM5bW9mciJ9.bA-qxiByTB_RseY1fgU4rg";
const BOUNDS = {
    england: [[-10.234, 48.788], [5.471, 56.578]],
    scotland: [[-9.4482, 55.9161], [0, 60]],
};
const localTime = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London",
});
const percentage = (value) => value === null ? "—" : `${(100 * value).toFixed(1)}%`;
const ratio = (value, total) => total > 0 ? value / total : null;
const EMPTY_MAP = { type: "FeatureCollection", features: [] };

let mapboxReady;
function loadMapbox() {
    if (!mapboxReady) {
        mapboxReady = new Promise((resolve, reject) => {
            const css = document.createElement("link");
            css.rel = "stylesheet";
            css.href = `https://api.mapbox.com/mapbox-gl-js/v${MAPBOX_VERSION}/mapbox-gl.css`;
            document.head.append(css);
            const script = document.createElement("script");
            script.src = `https://api.mapbox.com/mapbox-gl-js/v${MAPBOX_VERSION}/mapbox-gl.js`;
            script.onload = () => resolve(window.mapboxgl);
            script.onerror = () => reject(new Error("Basemap failed to load"));
            document.head.append(script);
        }).catch((error) => { mapboxReady = null; throw error; });
    }
    return mapboxReady;
}

function addForecastLayers(map) {
    map.addSource("shadow-risk", { type: "geojson", data: EMPTY_MAP });
    map.addLayer({ id: "shadow-risk", source: "shadow-risk", type: "fill",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": ["get", "fill"], "fill-opacity": .68 } });
    map.addLayer({ id: "shadow-15", source: "shadow-risk", type: "line",
        filter: ["all", ["==", ["geometry-type"], "Polygon"], ["==", ["get", "band_min"], 15]],
        paint: { "line-color": "#374815", "line-width": 1.3 } });
}

async function fetchLayer(value, signal) {
    const url = new URL(value);
    if (url.protocol !== "https:" ||
        !["storage.googleapis.com", "firebasestorage.googleapis.com"].includes(url.hostname)) {
        throw new Error("Forecast layer unavailable");
    }
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error("Forecast layer unavailable");
    const data = await response.json();
    if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
        throw new Error("Invalid forecast layer");
    }
    return data;
}

function renderScores(target, runs, day) {
    const verified = runs.filter((run) => run.verificationStatus === "verified" && run.verification);
    const note = document.createElement("p");
    note.className = "note";
    if (!verified.length) {
        note.textContent = "Scores appear after the valid windows have verified against observed lightning.";
        target.replaceChildren(note);
        return;
    }
    const results = verified.flatMap((run) => run.verification);
    const total = (key) => results.reduce((n, score) => n + score[key], 0);
    const sum = (kind, key) => results.reduce((n, score) => n + score[kind][key], 0);
    const uniqueDays = new Set(verified.map((run) => (run.publishedAt || run.validFrom).toDate().toISOString().slice(0, 10)));
    note.textContent = `${verified.length} recent verified runs across ${uniqueDays.size} UTC issue dates, including quiet runs.`;
    const table = document.createElement("table");
    table.className = "tbl";
    function row(values, header = false) {
        const line = table.insertRow();
        for (const value of values) {
            const cell = document.createElement(header ? "th" : "td");
            cell.style.textAlign = "left";
            cell.style.padding = "5px";
            if (header) cell.scope = "col";
            cell.textContent = value;
            line.append(cell);
        }
    }
    row(["Forecast", "Brier", "Detection at 15%", "False alarms at 15%"], true);
    for (const [kind, label] of [["traditional", "Traditional full-day outlook"],
        ["baseline", "Same-window baseline"], ["shadow", "AI shadow forecast"]]) {
        const brier = kind === "traditional" ? "—" :
            (results.reduce((n, score) => n + score[kind].brier * score.cells, 0) / total("cells")).toFixed(4);
        const hits = sum(kind, "hits");
        const falseAlarms = sum(kind, "falseAlarms");
        row([label, brier, percentage(ratio(hits, total("lightningCells"))),
            percentage(ratio(falseAlarms, hits + falseAlarms))]);
    }
    const detail = document.createElement("p");
    detail.className = "note";
    const format = (count) => count.toLocaleString("en-GB");
    detail.textContent = `At 15%, ${format(sum("added", "hits"))} of ${format(sum("added", "cells"))} added cells verified with lightning. ${format(sum("removed", "hits"))} of ${format(sum("removed", "cells"))} removed cells verified.`;
    const scroll = document.createElement("div");
    scroll.className = "scroll";
    scroll.append(table);
    const adjacent = document.createElement("div");
    if (day !== "day0") {
        for (const [field, label] of [["quietBeforeLightning", "Quiet windows before lightning"],
            ["quietAfterLightning", "Quiet windows after lightning"]]) {
            const values = results.map((score) => score[field]).filter(Boolean);
            const count = (key) => values.reduce((n, score) => n + score[key], 0);
            const text = document.createElement("p");
            text.className = "note";
            const cells = count("cells");
            text.textContent = cells ? `${label} within the forecast day · Share of cells flagged at 15% · Baseline ${percentage(ratio(count("baseline"), cells))} · AI ${percentage(ratio(count("shadow"), cells))} · ${format(cells)} cells`
                : `${label} · No qualifying cells`;
            adjacent.append(text);
        }
    }
    target.replaceChildren(note, scroll, detail, adjacent);
}

export function startFirstHourLab(db) {
    const section = document.getElementById("firstHourLab");
    const horizon = document.getElementById("shadowHorizon");
    const region = document.getElementById("shadowRegion");
    const validWindow = document.getElementById("shadowWindow");
    const windowLabel = document.getElementById("shadowWindowLabel");
    const layer = document.getElementById("shadowLayer");
    const status = document.getElementById("shadowStatus");
    const target = document.getElementById("shadowMap");
    const referenceTarget = document.getElementById("shadowReferenceMap");
    const aiTarget = document.getElementById("shadowAiMap");
    const divider = document.getElementById("shadowDivider");
    const referenceLabel = document.getElementById("shadowReferenceLabel");
    const aiLabel = document.getElementById("shadowAiLabel");
    const legend = document.getElementById("shadowLegend");
    const scores = document.getElementById("shadowScores");
    let stop, timer, map, aiMap, selected, abort, revision = 0, runs = [], windowRun = null;
    let split = 50;

    function setSplit(value) {
        split = Math.max(0, Math.min(100, Math.round(value)));
        target.style.setProperty("--shadow-split", `${split}%`);
        divider.setAttribute("aria-valuenow", String(split));
        divider.setAttribute("aria-valuetext", `${referenceLabel.textContent} ${split}%, AI HOCO ${100 - split}%`);
        referenceLabel.hidden = divider.hidden || split < 18;
        aiLabel.hidden = divider.hidden || split > 82;
    }

    function updateSplitFromPointer(event) {
        const rect = target.getBoundingClientRect();
        if (rect.width) setSplit((event.clientX - rect.left) / rect.width * 100);
    }

    divider.onpointerdown = (event) => {
        if (event.button !== 0) return;
        divider.focus();
        divider.setPointerCapture(event.pointerId);
        updateSplitFromPointer(event);
        event.preventDefault();
    };
    divider.onpointermove = (event) => {
        if (divider.hasPointerCapture(event.pointerId)) updateSplitFromPointer(event);
    };
    divider.onkeydown = (event) => {
        const position = { ArrowLeft: split - 5, ArrowRight: split + 5, Home: 0, End: 100 }[event.key];
        if (position === undefined) return;
        event.preventDefault();
        setSplit(position);
    };

    function syncCamera() {
        if (map && aiMap) aiMap.jumpTo({ center: map.getCenter(), zoom: map.getZoom(),
            bearing: map.getBearing(), pitch: map.getPitch() });
    }

    new ResizeObserver(() => {
        if (map && aiMap && target.clientWidth && target.clientHeight) {
            map.resize();
            aiMap.resize();
            syncCamera();
        }
    }).observe(target);

    function setComparisonReady(ready) {
        target.toggleAttribute("data-ready", ready);
        divider.hidden = !ready;
        legend.hidden = !ready;
        setSplit(split);
    }

    function clearMap() {
        ++revision;
        abort?.abort();
        map?.remove();
        aiMap?.remove();
        map = null;
        aiMap = null;
        selected = null;
        target.hidden = true;
        setComparisonReady(false);
        layer.disabled = true;
    }

    async function showComparison() {
        const left = map?.getSource("shadow-risk");
        const right = aiMap?.getSource("shadow-risk");
        if (!selected || !left || !right) return;
        const revisionAtStart = ++revision;
        abort?.abort();
        abort = new AbortController();
        const reference = layer.value;
        const maps = selected.maps;
        setComparisonReady(false);
        left.setData(EMPTY_MAP);
        right.setData(EMPTY_MAP);
        try {
            const [baseline, shadow] = await Promise.all([
                fetchLayer(maps[reference], abort.signal),
                fetchLayer(maps.shadow, abort.signal),
            ]);
            if (revisionAtStart !== revision) return;
            left.setData(baseline);
            right.setData(shadow);
            referenceLabel.textContent = reference === "traditional" ? "Traditional HOCO" : "Same-window baseline";
            status.textContent = `Valid ${localTime.format(selected.validFrom.toDate())} to ${localTime.format(selected.validTo.toDate())} UK time.`;
            legend.replaceChildren();
            for (const band of shadow.properties?.bands || baseline.properties?.bands || []) {
                if (!/^#[0-9a-f]{6}$/i.test(band.fill)) continue;
                const key = document.createElement("span");
                key.style.marginRight = "10px";
                const swatch = document.createElement("span");
                Object.assign(swatch.style, { display: "inline-block", width: "9px", height: "9px",
                    marginRight: "4px", backgroundColor: band.fill });
                key.append(swatch, document.createTextNode(band.label));
                legend.append(key);
            }
            syncCamera();
            setComparisonReady(true);
        } catch (err) {
            if (revisionAtStart !== revision || err.name === "AbortError") return;
            status.textContent = "The forecasts could not both be loaded for comparison.";
        }
    }

    async function refresh() {
        clearTimeout(timer);
        renderScores(scores, runs, horizon.value);
        const now = Date.now();
        const firstHour = horizon.value === "day0";
        const current = runs.find((run) => now < run.validTo.toMillis() &&
            (!firstHour || run.validFrom.toMillis() <= now));
        if (!current) {
            clearMap();
            windowLabel.hidden = validWindow.hidden = true;
            status.textContent = runs.length ? "The latest timing forecast has expired." : "Waiting for the next eligible automated run.";
            return;
        }
        timer = setTimeout(refresh, current.validTo.toMillis() - now + 30);
        const key = `${current.runId}/${current.publishedAt?.toMillis() ?? current.validFrom.toMillis()}`;
        windowLabel.hidden = validWindow.hidden = firstHour;
        if (!firstHour && windowRun !== key) {
            windowRun = key;
            const windows = current.windows || [];
            validWindow.replaceChildren(...windows.map((period, i) => new Option(
                `${localTime.format(period.validFrom.toDate())} – ${localTime.format(period.validTo.toDate())}`, i)));
            const next = windows.findIndex((period) => period.validTo.toMillis() > now);
            validWindow.value = String(Math.max(0, next));
        }
        const period = firstHour ? current : current.windows?.[Number(validWindow.value)];
        if (!period) return;
        const selectionKey = `${key}/${period.validFrom.toMillis()}`;
        if (selected?.key === selectionKey) return;
        status.textContent = `Valid ${localTime.format(period.validFrom.toDate())} to ${localTime.format(period.validTo.toDate())} UK time.`;
        if (map?.getSource("shadow-risk") && aiMap?.getSource("shadow-risk")) {
            selected = { ...period, key: selectionKey };
            showComparison();
            return;
        }
        clearMap();
        selected = { ...period, key: selectionKey };
        const revisionAtStart = revision;
        try {
            const mapbox = await loadMapbox();
            if (revisionAtStart !== revision || current.validTo.toMillis() <= Date.now()) return;
            mapbox.accessToken = MAPBOX_TOKEN;
            target.hidden = false;
            const options = { style: "mapbox://styles/mapbox/light-v11",
                bounds: BOUNDS[region.value], fitBoundsOptions: { padding: 22 }, maxZoom: 11 };
            map = new mapbox.Map({ ...options, container: referenceTarget });
            aiMap = new mapbox.Map({ ...options, container: aiTarget, interactive: false, attributionControl: false });
            map.on("move", syncCamera);
            const onLoad = (pane) => {
                if (revisionAtStart !== revision) return;
                addForecastLayers(pane);
                if (map.getSource("shadow-risk") && aiMap.getSource("shadow-risk")) {
                    layer.disabled = false;
                    showComparison();
                }
            };
            const [referencePane, aiPane] = [map, aiMap];
            referencePane.on("load", () => onLoad(referencePane));
            aiPane.on("load", () => onLoad(aiPane));
        } catch {
            if (revisionAtStart === revision) {
                clearMap();
                status.textContent = "The comparison map could not be started.";
            }
        }
    }

    function watchRegion() {
        stop?.();
        clearTimeout(timer);
        clearMap();
        runs = [];
        windowRun = null;
        windowLabel.hidden = validWindow.hidden = true;
        status.textContent = "Loading timing forecasts…";
        scores.replaceChildren();
        const id = horizon.value === "day0" ? `first_hour_shadow_${region.value}`
            : `timing_shadow_${region.value}_${horizon.value}`;
        stop = onSnapshot(doc(db, "developer_access", id),
            (snapshot) => {
                runs = snapshot.exists() ? snapshot.data().runs || [] : [];
                refresh();
            },
            () => { status.textContent = "The shadow forecast records are unavailable."; });
    }
    horizon.onchange = watchRegion;
    region.onchange = watchRegion;
    layer.onchange = showComparison;
    validWindow.onchange = refresh;

    return { setDeveloper(allowed) {
        section.hidden = !allowed;
        if (allowed) {
            watchRegion();
        } else {
            stop?.();
            clearTimeout(timer);
            clearMap();
            runs = [];
            scores.replaceChildren();
        }
    } };
}
