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

function renderScores(target, runs) {
    const verified = runs.filter((run) => run.verificationStatus === "verified" && run.verification);
    const note = document.createElement("p");
    note.className = "note";
    if (!verified.length) {
        note.textContent = "Scores appear after a completed hour has verified against the lightning feed.";
        target.replaceChildren(note);
        return;
    }
    const results = verified.map((run) => run.verification);
    const total = (key) => results.reduce((n, score) => n + score[key], 0);
    const sum = (kind, key) => results.reduce((n, score) => n + score[kind][key], 0);
    const uniqueDays = new Set(verified.map((run) => run.validFrom.toDate().toISOString().slice(0, 10)));
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
    for (const [kind, label] of [["traditional", "Traditional Day 0"],
        ["baseline", "First-hour baseline"], ["shadow", "AI first hour"]]) {
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
    target.replaceChildren(note, scroll, detail);
}

export function startFirstHourLab(db) {
    const section = document.getElementById("firstHourLab");
    const region = document.getElementById("shadowRegion");
    const layer = document.getElementById("shadowLayer");
    const status = document.getElementById("shadowStatus");
    const target = document.getElementById("shadowMap");
    const legend = document.getElementById("shadowLegend");
    const scores = document.getElementById("shadowScores");
    let stop, timer, map, selected, abort, revision = 0, runs = [];
    new ResizeObserver(() => {
        if (map && target.clientWidth && target.clientHeight) map.resize();
    }).observe(target);

    function clearMap() {
        ++revision;
        abort?.abort();
        map?.remove();
        map = null;
        selected = null;
        target.hidden = true;
        legend.hidden = true;
        layer.disabled = true;
    }

    async function showLayer() {
        if (!selected || !map) return;
        const revisionAtStart = ++revision;
        abort?.abort();
        abort = new AbortController();
        const url = new URL(selected.maps[layer.value]);
        if (url.protocol !== "https:" ||
            !["storage.googleapis.com", "firebasestorage.googleapis.com"].includes(url.hostname)) {
            status.textContent = "The saved layer URL is unavailable.";
            return;
        }
        try {
            map.getSource("shadow-risk")?.setData({ type: "FeatureCollection", features: [] });
            const response = await fetch(url, { signal: abort.signal });
            if (!response.ok) throw new Error("Layer unavailable");
            const data = await response.json();
            if (revisionAtStart !== revision) return;
            map.getSource("shadow-risk").setData(data);
            legend.replaceChildren();
            for (const band of data.properties?.bands || []) {
                if (!/^#[0-9a-f]{6}$/i.test(band.fill)) continue;
                const key = document.createElement("span");
                key.style.marginRight = "10px";
                const swatch = document.createElement("span");
                Object.assign(swatch.style, { display: "inline-block", width: "9px", height: "9px",
                    marginRight: "4px", backgroundColor: band.fill });
                key.append(swatch, document.createTextNode(band.label));
                legend.append(key);
            }
            legend.hidden = false;
        } catch (err) {
            if (revisionAtStart !== revision || err.name === "AbortError") return;
            status.textContent = "The saved forecast layer could not be loaded.";
        }
    }

    async function refresh() {
        clearTimeout(timer);
        renderScores(scores, runs);
        const now = Date.now();
        const current = runs.find((run) => run.validFrom.toMillis() <= now && now < run.validTo.toMillis());
        if (!current) {
            clearMap();
            status.textContent = runs.length ? "The latest first-hour map has expired." : "Waiting for the next Day 0 run.";
            return;
        }
        timer = setTimeout(refresh, current.validTo.toMillis() - now + 30);
        if (selected?.runId === current.runId && selected.validFrom.toMillis() === current.validFrom.toMillis()) return;
        clearMap();
        selected = current;
        const revisionAtStart = revision;
        status.textContent = `Valid ${localTime.format(current.validFrom.toDate())} to ${localTime.format(current.validTo.toDate())} UK time.`;
        try {
            const mapbox = await loadMapbox();
            if (revisionAtStart !== revision || current.validTo.toMillis() <= Date.now()) return;
            mapbox.accessToken = MAPBOX_TOKEN;
            target.hidden = false;
            map = new mapbox.Map({ container: target, style: "mapbox://styles/mapbox/light-v11",
                bounds: BOUNDS[region.value], fitBoundsOptions: { padding: 22 }, maxZoom: 11 });
            map.on("load", () => {
                if (revisionAtStart !== revision) return;
                map.addSource("shadow-risk", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
                map.addLayer({ id: "shadow-risk", source: "shadow-risk", type: "fill",
                    filter: ["==", ["geometry-type"], "Polygon"],
                    paint: { "fill-color": ["get", "fill"], "fill-opacity": .68 } });
                map.addLayer({ id: "shadow-15", source: "shadow-risk", type: "line",
                    filter: ["all", ["==", ["geometry-type"], "Polygon"], ["==", ["get", "band_min"], 15]],
                    paint: { "line-color": "#374815", "line-width": 1.3 } });
                layer.disabled = false;
                showLayer();
            });
        } catch {
            if (revisionAtStart === revision) status.textContent = "The comparison map could not be started.";
        }
    }

    function watchRegion() {
        stop?.();
        clearTimeout(timer);
        clearMap();
        runs = [];
        status.textContent = "Loading first-hour forecasts…";
        scores.replaceChildren();
        stop = onSnapshot(doc(db, "developer_access", `first_hour_shadow_${region.value}`),
            (snapshot) => {
                runs = snapshot.exists() ? snapshot.data().runs || [] : [];
                refresh();
            },
            () => { status.textContent = "The first-hour forecast records are unavailable."; });
    }
    region.onchange = watchRegion;
    layer.onchange = showLayer;

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
