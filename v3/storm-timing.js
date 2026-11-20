import { doc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const $ = id => document.getElementById(id);
const format = options => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", ...options });
const clock = format({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const date = format({ weekday: "short", day: "numeric", month: "short" });
const zonedClock = format({ hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" });
const stamp = format({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23", timeZoneName: "short" });
const empty = { type: "FeatureCollection", features: [] };

export function createStormTiming({ db, display, firstAvailable, selectDay }) {
    const periods = $("timingPeriods");
    const slider = $("timingSlider"), preview = $("timingPreview");
    const cached = new Map();
    let key, stop, timer, pending, windows = [], selected, record, region, day;

    function previewWindow(index) {
        const item = windows[index];
        if (!item) return;
        const start = item.validFrom.toDate(), end = item.validTo.toDate();
        preview.textContent = clock.format(start) + "–" + zonedClock.format(end);
        slider.setAttribute("aria-valuetext", stamp.format(start) + " to " + stamp.format(end));
        slider.style.setProperty("--pct", windows.length > 1 ? index / (windows.length - 1) * 100 + "%" : "100%");
    }
    slider.oninput = () => previewWindow(Number(slider.value));
    slider.onchange = () => { if (windows.length) select(windows[Number(slider.value)], region, day); };
    function step(direction) {
        if (windows.length < 2) return;
        slider.value = Math.max(0, Math.min(windows.length - 1, Number(slider.value) + direction));
        previewWindow(Number(slider.value));
        slider.onchange();
    }

    function address(region, day) {
        const url = new URL(location.href);
        for (const name of ["run", "open"]) url.searchParams.delete(name);
        url.searchParams.set("region", region);
        url.searchParams.set("day", day);
        url.searchParams.set("view", "timing");
        if (selected) url.searchParams.set("window", selected);
        else url.searchParams.delete("window");
        history.replaceState(null, "", url);
    }

    function reset() {
        stop?.(); stop = null;
        clearTimeout(timer);
        pending?.abort();
        key = null; windows = []; record = null; selected = null; cached.clear();
        periods.hidden = true;
        $("timingSource").hidden = true;
        $("timingIssued").textContent = "";
        $("timingMethod").hidden = true;
    }

    async function select(item, region, day) {
        pending?.abort();
        const controller = new AbortController();
        pending = controller;
        const start = item.validFrom.toDate(), end = item.validTo.toDate();
        selected = start.toISOString();
        address(region, day);
        slider.value = windows.indexOf(item);
        previewWindow(Number(slider.value));
        $("timingTitle").textContent = date.format(start);
        $("timingStatus").textContent = "Loading window…";
        const zone = value => zonedClock.formatToParts(value).find(part => part.type === "timeZoneName")?.value;
        const hours = (zone(start) === zone(end) ? clock.format(start) : zonedClock.format(start)) + "–" + zonedClock.format(end);
        const dates = date.format(start) === date.format(end) ? date.format(start) : date.format(start) + " → " + date.format(end);
        const validity = stamp.format(start) + " – " + stamp.format(end);
        display(empty);
        try {
            const url = new URL(item.geojsonUrl);
            if (url.protocol !== "https:" || !["storage.googleapis.com", "firebasestorage.googleapis.com"].includes(url.hostname)) throw Error();
            let data = cached.get(url.href);
            if (!data) {
                const response = await fetch(url, { signal: controller.signal });
                if (!response.ok) throw Error();
                data = await response.json();
                if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) throw Error();
            }
            if (controller.signal.aborted || end <= Date.now()) return;
            cached.set(url.href, data);
            display(data, { id: record.sourceRunId + "/" + selected, region, type: "ai",
                validFrom: item.validFrom, validTo: item.validTo, createdAt: record.issuedAt });
            $("timingTitle").textContent = hours;
            $("timingStatus").textContent = dates;
        } catch {
            if (!controller.signal.aborted) $("timingStatus").textContent = "Map unavailable · " + validity;
        }
    }

    function render(region, day) {
        clearTimeout(timer);
        pending?.abort();
        const now = Date.now();
        windows = (record?.schema === 1 && Array.isArray(record.windows) ? record.windows : [])
            .filter(w => w.validFrom?.toMillis?.() < w.validTo?.toMillis?.() && w.validTo.toMillis() > now)
            .sort((a, b) => a.validFrom.toMillis() - b.validFrom.toMillis());
        periods.hidden = !windows.length;
        const notes = [];
        if (record?.timingVersion && day === 2) notes.push("Storm hour covers the first 18 hours of Day 2.");
        if (record?.timingInputs === "historical-timing") notes.push("Window estimates use the broader outlook and historical lightning timing.");
        $("timingMethod").hidden = !windows.length || !notes.length;
        $("timingMethod").textContent = notes.join(" ");
        slider.max = Math.max(0, windows.length-1);
        slider.disabled = windows.length < 2;
        const liveUrls = new Set(windows.map(item => item.geojsonUrl));
        for (const url of cached.keys()) if (!liveUrls.has(url)) cached.delete(url);
        $("timingSource").hidden = !windows.length || !record?.sourceRunId;
        if (!windows.length) {
            selected = null;
            address(region, day);
            display(empty);
            $("timingIssued").textContent = "";
            $("timingTitle").textContent = "No active window";
            $("timingStatus").textContent = day === 0 ? "No hourly forecast is active for this run. Try Day 1 or Day 2."
                : "There are no published windows for this day.";
            return;
        }
        $("timingSource").href = "./?" + new URLSearchParams({ region, day, run: record.sourceRunId });
        $("timingIssued").textContent = record.issuedAt ? "Issued " + stamp.format(record.issuedAt.toDate()) : "";
        timer = setTimeout(() => render(region, day), windows[0].validTo.toMillis() - now + 30);
        select(windows.find(w => w.validFrom.toDate().toISOString() === selected) || windows[0], region, day);
    }

    async function chooseAvailable(region, watchedKey) {
        for (const day of [1, 2]) {
            try {
                const snapshot = await getDoc(doc(db, "system_stats", "storm_timing_" + region.toLowerCase() + "_day" + day));
                if (key !== watchedKey || windows.length) return;
                if (snapshot.data()?.windows?.some(w => w.validTo?.toMillis?.() > Date.now())) {
                    selectDay(day);
                    return;
                }
            } catch { if (key !== watchedKey) return; }
        }
    }

    function watch(nextRegion, nextDay, initialWindow) {
        region = nextRegion; day = nextDay;
        const next = region + day;
        if (key === next) return;
        reset();
        const preferAvailable = firstAvailable && day === 0;
        firstAvailable = false;
        key = next; selected = initialWindow;
        display(empty);
        address(region, day);
        $("timingTitle").textContent = "Storm timing";
        $("timingStatus").textContent = "Loading forecast windows…";
        stop = onSnapshot(doc(db, "system_stats", "storm_timing_" + region.toLowerCase() + "_day" + day), { includeMetadataChanges: true }, snapshot => {
            if (key !== next || snapshot.metadata.fromCache) return;
            record = snapshot.data();
            render(region, day);
            if (preferAvailable && !windows.length) chooseAvailable(region, next);
        }, () => {
            if (key !== next) return;
            record = null;
            render(region, day);
            $("timingStatus").textContent = "Storm timing is temporarily unavailable.";
        });
    }
    return { watch, reset, step };
}
