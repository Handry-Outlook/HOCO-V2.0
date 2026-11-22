import { doc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const $ = id => document.getElementById(id);
const format = options => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", ...options });
const clock = format({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const zonedClock = format({ hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" });
const stamp = format({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23", timeZoneName: "short" });
const empty = { type: "FeatureCollection", features: [] };

function windowHours(start, end) {
    const zone = value => zonedClock.formatToParts(value).find(part => part.type === "timeZoneName")?.value;
    return (zone(start) === zone(end) ? clock.format(start) : zonedClock.format(start)) + "–" + zonedClock.format(end);
}

function savedWindows(record) {
    return (record?.schema === 1 && Array.isArray(record.windows) ? record.windows : [])
        .filter(w => w.validFrom?.toMillis?.() < w.validTo?.toMillis?.())
        .sort((a, b) => a.validFrom.toMillis() - b.validFrom.toMillis());
}

function windowDisplayEnd(record, item) {
    // Keep the exclusive boundary for selection and comparisons, but show the final included minute.
    return ["storm-hour-v2", "storm-hour-traditional-v1"].includes(record.timingVersion)
        ? new Date(item.validTo.toMillis() - 1)
        : item.validTo.toDate();
}

function windowRun(record, item) {
    const start = item.validFrom.toDate(), end = windowDisplayEnd(record, item);
    return {
        id: record.sourceRunId + "/" + start.toISOString(), type: "timing",
        sourceRunId: record.sourceRunId, region: record.region, geojsonUrl: item.geojsonUrl, basis: record.basis,
        createdAt: record.issuedAt, ownerId: record.ownerId, validFrom: item.validFrom, validTo: item.validTo,
        windowLabel: windowHours(start, end),
        windowValidity: stamp.format(start) + " – " + stamp.format(end)
    };
}

export function createStormTiming({ db, display, userId }) {
    const periods = $("timingPeriods");
    const slider = $("timingSlider"), preview = $("timingPreview");
    const cached = new Map(), manifests = new Map();
    let key, stop, pending, windows = [], selected, record, region, day, sourceRun, privateSourceMeta = null;

    function previewWindow(index) {
        const item = windows[index];
        if (!item) return;
        const start = item.validFrom.toDate(), end = windowDisplayEnd(record, item);
        preview.textContent = windowHours(start, end);
        slider.setAttribute("aria-valuetext", stamp.format(start) + " to " + stamp.format(end));
        slider.style.setProperty("--pct", windows.length > 1 ? index / (windows.length - 1) * 100 + "%" : "100%");
    }
    slider.oninput = () => previewWindow(Number(slider.value));
    slider.onchange = () => { if (windows.length) select(windows[Number(slider.value)], region, day); };


    function address(region, day) {
        const url = new URL(location.href);
        for (const name of ["run", "open"]) url.searchParams.delete(name);
        url.searchParams.set("region", region);
        url.searchParams.set("day", day);
        url.searchParams.set("view", "timing");
        if (sourceRun) url.searchParams.set("run", sourceRun);
        if (selected) url.searchParams.set("window", selected);
        else url.searchParams.delete("window");
        history.replaceState(null, "", url);
    }

    function reset() {
        stop?.(); stop = null;
        pending?.abort();
        key = null; windows = []; record = null; selected = null; privateSourceMeta = null; cached.clear();
        periods.hidden = true;
        $("timingSource").hidden = true;
        $("timingMethod").hidden = true;
    }

    async function fetchGeo(run, signal) {
        if (run.ownerId && run.ownerId !== userId()) throw Error("Private forecast");
        const url = new URL(run.geojsonUrl);
        if (url.protocol !== "https:" || !["storage.googleapis.com", "firebasestorage.googleapis.com"].includes(url.hostname)) throw Error();
        if (cached.has(url.href)) return cached.get(url.href);
        const response = await fetch(url, { signal });
        if (!response.ok) throw Error();
        const data = await response.json();
        if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) throw Error();
        cached.set(url.href, data);
        if (cached.size > 48) cached.delete(cached.keys().next().value);
        return data;
    }

    function manifest(runId) {
        if (!runId) return null;
        if (!manifests.has(runId)) {
            const request = getDoc(doc(db, "system_stats", "storm_timing_run_" + runId))
                .then(snap => snap.data())
                .catch(() => { manifests.delete(runId); return null; });
            manifests.set(runId, request);
            if (manifests.size > 12) manifests.delete(manifests.keys().next().value);
        }
        return manifests.get(runId);
    }

    async function readPrivate(source) {
        const owner = userId();
        if (!owner || owner !== source.userId) return null;
        const snapshot = await getDoc(doc(db, "users", owner, "hourcast_runs", source.id));
        const data = snapshot.data();
        return data && owner === userId() ? { ...data, ownerId: owner } : null;
    }

    async function windowsFor(source) {
        if (!source?.stormHour) return [];
        const data = source.type === "manual" ? await readPrivate(source) : await manifest(source.id);
        if (!data || data.sourceRunId !== source.id || data.region !== source.region) return [];
        return savedWindows(data).map(item => windowRun(data, item));
    }

    function runs() {
        return windows.map(item => windowRun(record, item));
    }

    function adjacent(run) {
        const list = runs(), index = list.findIndex(item => item.id === run.id);
        const other = index >= 0 && (list[index - 1] || list[index + 1]);
        return other ? { ...other, changeLabel: "the " + other.windowLabel + " window" } : null;
    }

    async function comparison(run, previousId) {
        const previous = await manifest(previousId);
        if (!previous || previous.region !== run.region || previous.sourceRunId !== previousId) return null;
        const start = run.validFrom.toMillis(), end = run.validTo.toMillis();
        let best = null, bestOverlap = 0.8;
        for (const item of savedWindows(previous)) {
            const from = item.validFrom.toMillis(), to = item.validTo.toMillis();
            const overlap = (Math.min(end, to) - Math.max(start, from)) / Math.max(end - start, to - from);
            if (overlap >= bestOverlap) { best = item; bestOverlap = overlap; }
        }
        if (!best) return null;
        const match = windowRun(previous, best);
        return { ...match, changeLabel: stamp.format(previous.issuedAt.toDate()) + " run · " + match.windowLabel };
    }

    async function select(item, region, day) {
        pending?.abort();
        const controller = new AbortController();
        pending = controller;
        const run = windowRun(record, item);
        selected = item.validFrom.toDate().toISOString();
        address(region, day);
        slider.value = windows.indexOf(item);
        previewWindow(Number(slider.value));
        display(empty, null, "Loading " + run.windowLabel + "…");
        try {
            const data = await fetchGeo(run, controller.signal);
            if (controller.signal.aborted) return;
            display(data, run);
        } catch {
            if (!controller.signal.aborted) display(empty, null, "Map unavailable · " + run.windowValidity);
        }
    }

    function render(region, day) {
        pending?.abort();
        windows = savedWindows(record);
        periods.hidden = !windows.length;
        const notes = [];
        if (record?.basis === "traditional") notes.push(record.timingInputs === "validity-duration"
            ? "Traditional outlook divided by window duration."
            : "Based on Traditional HOCO and hourly model guidance.");
        if (record?.timingVersion && record.day === "day2") notes.push("Hourcast covers the first 18 hours of Day 2.");
        if (record?.timingInputs === "historical-timing") notes.push("Window estimates use the broader outlook and historical lightning timing.");
        $("timingMethod").hidden = !windows.length || !notes.length;
        $("timingMethod").textContent = notes.join(" ");
        slider.max = Math.max(0, windows.length-1);
        slider.disabled = windows.length < 2;
        const liveUrls = new Set(windows.map(item => item.geojsonUrl));
        for (const url of cached.keys()) if (!liveUrls.has(url)) cached.delete(url);
        const hasFullRun = !privateSourceMeta || !!(privateSourceMeta.geojsonUrl || privateSourceMeta.inlineGeojson || privateSourceMeta.inlineGeojsonText);
        $("timingSource").hidden = !windows.length || !record?.sourceRunId || !hasFullRun;
        if (!windows.length) {
            selected = null;
            address(region, day);
            display(empty, null, sourceRun ? "No windows were saved for this run." : "No Hourcast forecast for this date and day.");
            return;
        }
        if (privateSourceMeta) {
            $("timingSource").href = "./?" + new URLSearchParams({ open: record.sourceRunId });
            $("timingSource").textContent = privateSourceMeta.forecastProduct === "ai" ? "Source AI HOCO run" : "Source full-period run";
        } else {
            $("timingSource").href = "./?" + new URLSearchParams({ region, day, run: record.sourceRunId });
            $("timingSource").textContent = "Source full-day run";
        }
        const current = windows.find(w => w.validFrom.toDate().toISOString() === selected);
        const next = windows.find(w => w.validTo.toMillis() > Date.now());
        select(current || next || windows[0], region, day);
    }

    function watch(nextRegion, nextDay, runId, initialWindow, privateSource) {
        const next = JSON.stringify([nextRegion, nextDay, runId]);
        if (key === next) return;
        reset();
        region = nextRegion; day = nextDay; sourceRun = runId; privateSourceMeta = privateSource || null;
        key = next; selected = initialWindow;
        if (!runId) { render(region, day); return; }
        display(empty, null, "Loading forecast windows…");
        address(region, day);
        if (privateSource) {
            readPrivate(privateSource).then(data => {
                if (key !== next) return;
                record = data?.sourceRunId === runId && data.region === region ? data : null;
                render(region, day);
            }).catch(() => {
                if (key === next) display(empty, null, "Sign in with the account that created this Hourcast run.");
            });
            return;
        }
        stop = onSnapshot(doc(db, "system_stats", "storm_timing_run_" + runId), snapshot => {
            if (key !== next || (snapshot.metadata.fromCache && !snapshot.exists())) return;
            const data = snapshot.data();
            record = data?.sourceRunId === runId && data.region === region ? data : null;
            render(region, day);
        }, () => {
            if (key !== next) return;
            record = null;
            periods.hidden = true;
            display(empty, null, "This Hourcast run could not be loaded.");
        });
    }
    return { watch, reset, runs, windowsFor, adjacent, comparison, fetchGeo };
}
