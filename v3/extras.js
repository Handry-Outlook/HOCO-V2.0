// HOCO v3 extras: radar + lightning strikes with an "observed" time slider, PNG export,
// place search, change since the previous run, cookie consent, offline notice, shortcuts.

let X;
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const O = { radar: false, strikes: false, forecast: true, t: null, t0: null, t1: null, playing: false, run: null, frameKey: '', strikeData: null, strikeKey: '', loadingStrikes: false };

// ------------------------------------------------------------------ radar (Windy composite, RadarLoop method)
// Tiles are data: (R+G)/2 encodes reflectivity, pure blue is "no data". Recoloured here through the Operational scale.
const MMH_INTERVALS = [0, 0.046, 0.071, 0.109, 0.168, 0.259, 0.399, 0.615, 0.947, 1.459, 2.246, 3.459, 5.327, 8.203, 12.632, 19.453, 29.956, 46.129, 71.036, 109.39, 168.453];
const OPERATIONAL = [[200, 232, 180, 90], [176, 222, 152, 130], [150, 212, 128, 170], [122, 200, 100, 205], [92, 190, 74, 235], [54, 176, 56, 255], [30, 156, 44, 255], [13, 136, 36, 255],
  [0, 116, 28, 255], [232, 232, 0, 255], [255, 208, 0, 255], [255, 168, 0, 255], [255, 124, 0, 255], [255, 77, 0, 255], [239, 28, 0, 255], [204, 0, 0, 255], [163, 0, 20, 255],
  [180, 0, 120, 255], [150, 0, 200, 255], [106, 0, 184, 255]];
const mmhOf = (enc) => (10 ** (Math.max(0, enc * 56 / 94) / 10) * 0.005) ** 0.625 * 0.3;
// LUT indexed by R+G (0..510)
const LUT = (() => { const l = new Uint8ClampedArray(511 * 4);
  for (let s = 0; s <= 510; s++) { const mmh = mmhOf(s / 2); if (s / 2 <= 0.5 || mmh < 0.03) continue;
    let c = null; for (let i = 1; i < MMH_INTERVALS.length; i++) { if (mmh >= MMH_INTERVALS[i - 1]) c = OPERATIONAL[Math.min(i - 1, OPERATIONAL.length - 1)]; else break; }
    if (c) l.set(c, s * 4); }
  return l; })();
const RADAR_STEP = 5 * 60000;
const frameOf = (ms) => Math.floor(ms / RADAR_STEP) * RADAR_STEP;
function tileUrl(frameMs, z, x, y, archive) {
  const d = new Date(frameMs), p = `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  if (archive) return `https://rdr.windy.com/radar2/archive/composite/${p}/${z}/${x}/${y}/reflectivity.webp?multichannel=true`;
  const m = new Date(frameMs + (4 * 60 + 51) * 1000);
  const maxt = `${m.getUTCFullYear()}${pad(m.getUTCMonth() + 1)}${pad(m.getUTCDate())}${pad(m.getUTCHours())}${pad(m.getUTCMinutes())}${pad(m.getUTCSeconds())}`;
  return `https://rdr.windy.com/radar2/composite/${p}/${z}/${x}/${y}/reflectivity.webp?multichannel=true&maxt=${maxt}`;
}
// Each tile is kept as raw data: (R+G) per pixel, 0 for no data. Colour is applied after interpolation,
// so the picture is smoothed in reflectivity, not stretched as a finished image (RadarLoop's method).
const tileCache = new Map();   // key -> Promise<Uint16Array|null>
async function loadTile(frameMs, z, x, y) {
  const archiveFirst = Date.now() - frameMs > 2 * 3600000 - 10 * 60000;
  const urls = archiveFirst ? [tileUrl(frameMs, z, x, y, true)] : [tileUrl(frameMs, z, x, y, false), tileUrl(frameMs, z, x, y, true)];
  const key = urls[0];
  if (tileCache.has(key)) return tileCache.get(key);
  const p = (async () => {
    for (const u of urls) {
      try { const r = await fetch(u, { mode: 'cors' }); if (!r.ok) continue;
        const bmp = await createImageBitmap(await r.blob()); const c = new OffscreenCanvas(256, 256), g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(bmp, 0, 0, 256, 256); bmp.close?.(); const d = g.getImageData(0, 0, 256, 256).data, out = new Uint16Array(65536);
        for (let i = 0, k = 0; k < 65536; i += 4, k++) { if (d[i + 3] < 2 || (d[i + 2] > 200 && d[i] < 8 && d[i + 1] < 8)) continue; out[k] = d[i] + d[i + 1]; }
        return out;
      } catch (e) { /* try the next endpoint */ }
    }
    return null;
  })();
  tileCache.set(key, p);
  if (tileCache.size > 1500) tileCache.delete(tileCache.keys().next().value);
  return p;
}
const lon2x = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };
const radarCanvas = document.createElement('canvas');
const MAIN_RADAR = { canvas: radarCanvas, key: '', tok: 0, id: 'radar' };
let radarBusy = false, radarAgain = false;
async function drawRadar() {
  if (!O.radar || O.t == null) return;
  if (radarBusy) { radarAgain = true; return; }
  radarBusy = true;
  try { await drawRadarFrame(); } finally { radarBusy = false; if (radarAgain) { radarAgain = false; drawRadar(); } }
}
async function drawRadarFrame() {
  await paintRadar(X.map, MAIN_RADAR, O.t, O.playing, setObsInfo);
}
// Draw one radar frame for any map (the main map, or a compare map). st keeps that map's canvas and state.
export async function paintRadar(map, st, t, playing, info) {
  const cv = map.getCanvas(), W = cv.clientWidth, H = cv.clientHeight; if (!W || !H || t == null) return;
  // backing resolution: screen pixels x device ratio (rounded up like RadarLoop), lighter while playing
  let dpr = playing ? 1 : Math.max(1, Math.min(2, Math.ceil((devicePixelRatio || 1) - 1e-3)));
  while ((W * dpr > 4096 || H * dpr > 4096 || W * H * dpr * dpr > 5e6) && dpr > 1) dpr -= 0.5;
  const Wd = Math.round(W * dpr), Hd = Math.round(H * dpr);
  const nw = map.unproject([0, 0]), se = map.unproject([W, H]);
  // native data zoom: one level sharper than the screen needs, capped at the provider's z7
  let z = Math.max(3, Math.min(7, Math.round(map.getZoom() + Math.log2(dpr) + 0.5)));
  let gx0, gx1, gy0, gy1, tx0, tx1, ty0, ty1;
  for (;;) {
    gx0 = lon2x(nw.lng, z) * 256; gx1 = lon2x(se.lng, z) * 256; gy0 = lat2y(Math.min(85, nw.lat), z) * 256; gy1 = lat2y(Math.max(-85, se.lat), z) * 256;
    tx0 = Math.floor(gx0 / 256) - 1; tx1 = Math.floor(gx1 / 256) + 1; ty0 = Math.max(0, Math.floor(gy0 / 256) - 1); ty1 = Math.min(2 ** z - 1, Math.floor(gy1 / 256) + 1);
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= 110 || z <= 3) break; z--;
  }
  const frame = frameOf(t), key = `${frame}|${z}|${Wd}x${Hd}|${nw.lng.toFixed(4)},${nw.lat.toFixed(4)},${se.lng.toFixed(4)},${se.lat.toFixed(4)}`;
  if (key === st.key) return;
  const tok = ++st.tok; info?.('Loading radar…');
  const n = 2 ** z, jobs = [];
  for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) { const wx = ((x % n) + n) % n; jobs.push(loadTile(frame, z, wx, y).then(d => [x, y, d])); }
  const tiles = await Promise.all(jobs); if (tok !== st.tok) return;
  const cols = tx1 - tx0 + 1, grid = new Array(cols * (ty1 - ty0 + 1)).fill(null); let got = 0;
  tiles.forEach(([x, y, d]) => { if (d) { got++; grid[(y - ty0) * cols + (x - tx0)] = d; } });
  // sample positions per output column / row (mercator is linear on screen when the map is not rotated)
  const sx = new Float64Array(Wd), sy = new Float64Array(Hd);
  for (let i = 0; i < Wd; i++) sx[i] = gx0 + (i + 0.5) / Wd * (gx1 - gx0) - 0.5 - tx0 * 256;
  for (let j = 0; j < Hd; j++) sy[j] = gy0 + (j + 0.5) / Hd * (gy1 - gy0) - 0.5 - ty0 * 256;
  const rowsT = ty1 - ty0 + 1, maxX = cols * 256 - 1, maxY = rowsT * 256 - 1;
  const val = (X_, Y_) => { if (X_ < 0 || Y_ < 0 || X_ > maxX || Y_ > maxY) return 0; const t = grid[(Y_ >> 8) * cols + (X_ >> 8)]; return t ? t[((Y_ & 255) << 8) | (X_ & 255)] : 0; };
  const canvas = st.canvas; canvas.width = Wd; canvas.height = Hd;
  const g = canvas.getContext('2d'), img = g.createImageData(Wd, Hd), out = img.data, L = LUT;
  for (let j = 0; j < Hd; j++) {
    const fy = sy[j], y0 = Math.floor(fy), wy = fy - y0, row = j * Wd * 4;
    for (let i = 0; i < Wd; i++) {
      const fx = sx[i], x0 = Math.floor(fx), wx = fx - x0;
      const a = val(x0, y0), b = val(x0 + 1, y0), c = val(x0, y0 + 1), d = val(x0 + 1, y0 + 1);
      if (!(a | b | c | d)) continue;
      const v = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
      const k = Math.min(510, Math.round(v)) * 4, o = row + i * 4;
      out[o] = L[k]; out[o + 1] = L[k + 1]; out[o + 2] = L[k + 2]; out[o + 3] = L[k + 3];
    }
  }
  g.putImageData(img, 0, 0);
  st.key = key;
  const coords = [[nw.lng, nw.lat], [se.lng, nw.lat], [se.lng, se.lat], [nw.lng, se.lat]];
  const src = map.getSource(st.id || 'radar');
  if (!src) (st.add || addRadarLayer)(coords, map, st); else { src.setCoordinates(coords); src.play(); map.triggerRepaint(); requestAnimationFrame(() => requestAnimationFrame(() => map.getSource(st.id || 'radar')?.pause())); }
  info?.(got ? '' : 'No radar for this time');
  return got;
}
export const newRadarState = (id = 'radar') => ({ canvas: document.createElement('canvas'), key: '', tok: 0, id });
export function addCanvasRadar(coords, map, st, before, opacity = 0.85) {
  if (map.getSource(st.id)) return;
  map.addSource(st.id, { type: 'canvas', canvas: st.canvas, coordinates: coords, animate: false });
  map.addLayer({ id: st.id, type: 'raster', source: st.id, paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, before);
}
function labelLayer() { return X.map.getStyle().layers.find(l => l.type === 'symbol' && l.layout && l.layout['text-field'])?.id; }
export function riskOutlineLayer(map) {
  return ['hoco-line', 'hoco-hindcast-contours'].find(id => map.getLayer(id));
}
function addRadarLayer(coords) {
  const map = X.map; if (map.getSource('radar') || !coords) return;
  map.addSource('radar', { type: 'canvas', canvas: radarCanvas, coordinates: coords, animate: false });
  const before = map.getLayer('strikes') ? 'strikes' : riskOutlineLayer(map) || labelLayer();
  map.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': X.radarOpacity ? X.radarOpacity() : 0.85, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, before);
}
function removeRadar() { const map = X.map; if (map.getLayer('radar')) map.removeLayer('radar'); if (map.getSource('radar')) map.removeSource('radar'); MAIN_RADAR.key = ''; O.frameKey = ''; }

// ------------------------------------------------------------------ lightning strikes (same feeds as the classic site)
const GH = 'https://raw.githubusercontent.com/HandryOutlook/';
const FEEDS = { recent: GH + 'lightning_data_new/main/lightning_data.json', autumn25: GH + 'lightning_data_new/main/lightning_data_2025_autumn.json',
  summer26a: GH + 'lightning_data_new_2026/main/lightning_data_2026_summer_part1.json', summer26: GH + 'lightning_data_new_2026/main/lightning_data_2026_summer.json' };
const METOFFICE = 'https://data.consumer-digital.api.metoffice.gov.uk/v1/lightning';
const UKWX = 'https://ukwx.duckdns.org/lightning';
const jsonCache = new Map();
async function getJson(url, fresh) {
  const c = jsonCache.get(url); if (!fresh && c && Date.now() - c.t < 600000) return c.d;
  try { const r = await fetch(url, { cache: 'no-cache', headers: { Accept: 'application/json' } }); if (!r.ok) return null; const d = await r.json(); jsonCache.set(url, { t: Date.now(), d }); return d; } catch (e) { return null; }
}
const strikesOf = (raw) => Array.isArray(raw) ? raw : (raw?.lightning_strikes || raw?.strikes || []);
const ukwxOf = (raw) => (raw?.points || []).map(p => ({ t: p.t * 1000, lon: p.lon, lat: p.lat }));
let strikeFeed;
async function loadStrikes(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const key = `${startMs}|${endMs}`;
  const fresh = Date.now() - endMs < 15 * 60000;
  if (strikeFeed?.key === key && (!fresh || Date.now() - strikeFeed.at < 120000)) return strikeFeed.data;
  const data = collectStrikes(startMs, endMs);
  strikeFeed = { key, at: Date.now(), data };
  return data;
}
async function collectStrikes(startMs, endMs) {
  const strikes = new Map();
  function add(t, lon, lat) {
    if (!(t >= startMs && t < endMs && Number.isFinite(lon) && Number.isFinite(lat))) return;
    const key = `${Math.round(t / 1000)}|${lon.toFixed(3)}|${lat.toFixed(3)}`;
    if (!strikes.has(key)) strikes.set(key, { t, lon, lat });
  }
  const fromMet = raw => strikesOf(raw).forEach(s => {
    if (s?.coordinates) add(Date.parse(s.strike_time), Number(s.coordinates[0]), Number(s.coordinates[1]));
  });
  const fromUKWX = raw => ukwxOf(raw).forEach(p => add(p.t, p.lon, p.lat));
  const jobs = [getJson(FEEDS.recent).then(fromMet)];
  const start = new Date(startMs), end = new Date(endMs - 1);
  const overlaps = (a, b) => start < new Date(b) && end >= new Date(a);
  if (overlaps('2025-09-01', '2026-01-01')) jobs.push(getJson(FEEDS.autumn25).then(fromMet));
  if (overlaps('2026-05-01', '2026-10-01')) {
    jobs.push(getJson(FEEDS.summer26a).then(fromMet), getJson(FEEDS.summer26).then(fromMet));
  }
  if (Date.now() - endMs < 36 * 3600000) jobs.push(getJson(METOFFICE, true).then(async raw => {
    fromMet(raw);
    const chunks = (raw?.chunks || []).filter(item => /^\d+$/.test(String(item.chunk)));
    const rows = await Promise.all(chunks.map(c => getJson(`${METOFFICE}?last-minutes=1&chunk=${c.chunk}`, true)));
    rows.forEach(fromMet);
  }));
  const weatherDay = ms => Math.floor((ms - 6 * 3600000) / 864e5) * 864e5 + 6 * 3600000;
  const today = weatherDay(Date.now());
  for (let day = weatherDay(startMs); day < endMs && day <= today; day += 864e5) {
    const name = new Date(day).toISOString().slice(0, 10);
    const live = day === today;
    const url = live ? `${UKWX}/europe` : `${UKWX}/archive/europe/${name}.json`;
    jobs.push(getJson(url, live).then(fromUKWX));
  }
  await Promise.all(jobs);
  return [...strikes.values()].sort((a, b) => a.t - b.t);
}
// newest strikes are gold, fading through orange and red to dark plum
// strike colour = how far through the observed part of the forecast period it happened (newest in gold)
const STRIKE_CLASSES = [['#ffd21f', 'Newest'], ['#ff9a1f', 'Recent'], ['#f0442a', 'Mid'], ['#b3173d', 'Older'], ['#5c1a4f', 'Oldest']];
function strikeGeo() { return strikeFeatures(O.strikeData || [], O.t === O.tNow ? O.strikeEnd ?? O.t : O.t, O.t0); }
export function strikeFeatures(list, t, s) {
  const span = Math.max(1, t - s);
  const feats = []; for (const p of list) { if (p.t > t) break; const f = (p.t - s) / span, c = Math.min(4, Math.max(0, 4 - Math.floor(f * 5)));
    feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { c, t: p.t } }); }
  return { type: 'FeatureCollection', features: feats };
}
function drawStrikes() {
  const map = X.map; if (!O.strikes || O.t == null || !O.strikeData) return;
  const g = strikeGeo();
  if (map.getSource('strikes')) map.getSource('strikes').setData(g);
  else {
    map.addSource('strikes', { type: 'geojson', data: g });
    map.addLayer(strikeLayer('strikes'), riskOutlineLayer(map) || labelLayer());
  }
  O.strikeCount = g.features.length; renderObsHead();
}
export function strikeLayer(id) {
  return { id, type: 'circle', source: id, layout: { 'circle-sort-key': ['-', 4, ['get', 'c']] }, paint: {
    'circle-color': ['match', ['get', 'c'], 0, STRIKE_CLASSES[0][0], 1, STRIKE_CLASSES[1][0], 2, STRIKE_CLASSES[2][0], 3, STRIKE_CLASSES[3][0], STRIKE_CLASSES[4][0]],
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, ['match', ['get', 'c'], 0, 3.6, 2.4], 9, ['match', ['get', 'c'], 0, 6.5, 4.5]],
    'circle-stroke-color': '#1a1205', 'circle-stroke-width': ['match', ['get', 'c'], 0, 0.9, 0.4], 'circle-opacity': ['match', ['get', 'c'], 4, 0.75, 0.95] } };
}
export { loadStrikes, frameOf, STRIKE_CLASSES, RADAR_STEP };
function removeStrikes() { const map = X.map; strikePopup?.remove(); if (map.getLayer('strikes')) map.removeLayer('strikes'); if (map.getSource('strikes')) map.removeSource('strikes'); }
let strikePopup = null;
function strikeClick(e) {
  const f = e.features?.[0]; if (!f || !O.run) return;
  const t = +f.properties.t, st = X.startOf(O.run).getTime(), en = X.endOf(O.run).getTime(), [lon, lat] = f.geometry.coordinates;
  const mins = Math.round((Date.now() - t) / 60000), ago = mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
  const pct = Math.round((t - st) / Math.max(1, en - st) * 100), here = X.riskAtGeo(X.S.geo, lon, lat), cls = STRIKE_CLASSES[+f.properties.c];
  strikePopup?.remove();
  strikePopup = new mapboxgl.Popup({ closeButton: true, maxWidth: '260px', className: 'strikepop' }).setLngLat([lon, lat]).setHTML(
    `<div class="sp-head"><i style="background:${cls[0]}"></i><b>Lightning strike</b></div>
     <div class="sp-row"><span>Time</span><b>${pad(new Date(t).getHours())}:${pad(new Date(t).getMinutes())} · ${ago}</b></div>
     <div class="sp-row"><span>Age</span><b>${cls[1]} · ${pct}% through period</b></div>
     <div class="sp-row"><span>Where</span><b>${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}</b></div>
     <div class="sp-row"><span>Forecast</span><b>${here >= 5 ? Math.round(here) + '% here' : 'under 5% here'}</b></div>`).addTo(X.map);
  setTimeout(() => $('probe')?.classList.add('hidden'), 0);
}

// ------------------------------------------------------------------ observed time bar: whole forecast period, future part greyed
// 'last24': the slider always covers the past 24 hours and the forecast underneath follows the time.
// 'run': only the chosen forecast's own period, with that forecast fixed underneath.
const loadMode = () => { try { return localStorage.getItem('hocoObsMode') === 'last24' ? 'last24' : 'run'; } catch (e) { return 'run'; } };
O.mode = loadMode(); O.tempRun = false;
const effMode = () => (O.mode === 'run' || O.tempRun || X.S.custom || X.S.timing) ? 'run' : 'last24';
function obsRange(run) {
  if (effMode() === 'last24') {
    // archive day: that day's outlook, 06:00 to 06:00 the next morning; live: the past 24 hours
    if (X.S.archive) { const s = new Date(X.S.archive.date + 'T06:00:00').getTime(), e = frameOf(Math.min(s + 24 * 3600000 - 5 * 60000, Date.now() - 5 * 60000)); return s > Date.now() ? { future: true, s, e: s } : { s, e, now: e }; }
    const now = frameOf(Date.now() - 5 * 60000); return { s: now - 24 * 3600000, e: now, now }; }
  const s = X.startOf(run), e = X.endOf(run); if (!s || !e) return null;
  const now = Date.now(); if (s.getTime() > now) return { future: true, s: s.getTime(), e: e.getTime() };
  return { s: frameOf(s.getTime()), e: frameOf(e.getTime()), now: frameOf(Math.min(e.getTime(), now - 5 * 60000)) };
}
const fmtObs = (ms) => { const d = new Date(ms); return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const hm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function buildObsBar() {
  $('obsBar').innerHTML = `
    <div class="obs-row">
      <button class="btn icon" id="obsPlay" aria-label="Play">${PLAY}</button>
      <div class="obs-mid">
        <div class="obs-head"><b id="obsTitle">–</b><span class="tag live hidden" id="obsLive">Live</span><small id="obsHoco"></small><small id="obsInfo"></small></div>
        <label class="sr" for="obsSlider">Observed time</label>
        <div class="obs-track"><input type="range" id="obsSlider" min="0" max="0" value="0" step="1"><span class="obs-future" id="obsFuture"><em>not happened yet</em></span></div>
        <div class="obs-ticks" id="obsTicks"></div>
      </div>
      <div class="obs-btns"><button class="btn sm" id="obsMode" aria-pressed="false" title="Only this forecast's period, with this forecast shown underneath">This run</button><button class="btn sm" id="obsNow">Now</button><button class="btn sm" id="obsKeyBtn" aria-expanded="false">Key</button><button class="btn icon sm" id="obsClose" aria-label="Turn off radar and strikes">✕</button></div>
    </div>
    <div class="obs-keys hidden" id="obsKeys"></div>`;
  $('obsKeyBtn').onclick = () => { O.keyOpen = !O.keyOpen; $('obsKeys').classList.toggle('hidden', !O.keyOpen); $('obsKeyBtn').setAttribute('aria-expanded', O.keyOpen); X.measureDock(); };
}
function renderObsHead() {
  const t = $('obsTitle'); if (!t || O.t == null) return;
  const name = O.radar ? 'Rain radar' : 'Lightning strikes';
  t.innerHTML = `<span class="o-lg">${name} · </span>${hm(O.t)}`;
  const atNow = O.tNow != null && O.t >= O.tNow && Date.now() - O.tNow < 20 * 60000;
  $('obsLive').classList.toggle('hidden', !atNow);
  const msg = $('obsInfo').dataset.msg;
  $('obsInfo').textContent = msg || (O.strikes ? `${O.strikeCount ?? 0} strike${O.strikeCount === 1 ? '' : 's'} so far${O.strikeAt ? ` · updated ${hm(O.strikeAt)}` : ''}` : '');
}
function setObsInfo(m) { const el = $('obsInfo'); if (el) { el.dataset.msg = m || ''; renderObsHead(); } }
function renderObsKeys() {
  const k = $('obsKeys'); if (!k) return;
  k.innerHTML = (O.strikes ? `<div class="okey"><b>Strikes</b>${STRIKE_CLASSES.map(c => `<span><i style="background:${c[0]}"></i>${c[1]}</span>`).join('')}<small>Met Office and UKWX · colour shows time within the selected period</small></div>` : '')
    + (O.radar ? `<div class="okey rain"><b>Rain rate</b><span class="rainwrap"><span class="rainbar"></span><span class="rticks"><span>0.1</span><span>1</span><span>5</span><span>20</span><span>100 mm/h</span></span></span></div>` : '');
}
function syncObs() {
  const on = O.radar || O.strikes, bar = $('obsBar');
  document.body.classList.toggle('obs-on', on);
  if (!on || !O.run) { bar.classList.add('hidden'); stop(); if (!O.run) removeStrikes(); followHoco(); X.measureDock(); return; }
  bar.classList.remove('hidden'); renderObsKeys();
  const r = obsRange(O.run);
  if (!r || r.future) { $('obsSlider').disabled = true; $('obsPlay').disabled = true; $('obsNow').disabled = true;
    $('obsTitle').textContent = 'Not started yet'; $('obsLive').classList.add('hidden'); $('obsTicks').innerHTML = ''; $('obsFuture').style.width = '100%';
    setObsInfo(`Radar and strikes appear once this forecast starts (${r ? fmtObs(r.s) : '–'})`); removeRadar(); removeStrikes(); X.measureDock(); return; }
  [$('obsSlider'), $('obsPlay'), $('obsNow')].forEach(e => e.disabled = false);
  const mode = effMode(), mk = mode + '|' + (mode === 'run' ? O.run.id : (X.S.archive?.date || 'live')), fresh = O.runId !== mk, atEnd = O.t == null || O.t >= O.tNow;
  O.runId = mk;
  const mb = $('obsMode'); if (mb) { mb.setAttribute('aria-pressed', mode === 'run'); mb.disabled = !!X.S.custom || X.S.timing; } O.t0 = r.s; O.t1 = Math.max(r.e, r.s); O.tNow = Math.max(r.s, r.now);
  if (fresh || atEnd || O.t < O.t0 || O.t > O.tNow) O.t = O.tNow;
  const sl = $('obsSlider'); sl.min = 0; sl.max = Math.max(1, Math.round((O.t1 - O.t0) / RADAR_STEP));
  const nowPct = Math.min(100, (O.tNow - O.t0) / Math.max(1, O.t1 - O.t0) * 100);
  $('obsFuture').style.width = (100 - nowPct) + '%'; $('obsFuture').classList.toggle('hidden', nowPct >= 99.5);
  const ticks = [0, 1 / 3, 2 / 3, 1].map(f => O.t0 + f * (O.t1 - O.t0));
  $('obsTicks').innerHTML = ticks.map((t, i) => `<span>${i === 0 || i === 3 ? fmtObs(t) : hm(t)}</span>`).join('');
  setTime(O.t, true);
  X.measureDock();
}
async function setTime(ms, force) {
  O.t = Math.max(O.t0, Math.min(O.tNow ?? O.t1, ms));
  const sl = $('obsSlider'); sl.value = Math.round((O.t - O.t0) / RADAR_STEP); sl.style.setProperty('--pct', sl.max > 0 ? sl.value / sl.max * 100 + '%' : '100%');
  renderObsHead();
  if (O.strikes) {
    const run = O.run;
    const period = obsRange(run);
    const ownPeriod = effMode() === 'run';
    const start = ownPeriod ? X.startOf(run).getTime() : period.s;
    let end = ownPeriod ? X.endOf(run).getTime() : period.e + RADAR_STEP;
    if (ownPeriod && ['ai', 'automated'].includes(run.type) && new Date(end).getUTCMinutes() === 59) end += 60000;
    end = Math.min(end, Math.floor(Date.now() / 60000) * 60000);
    const key = `${start}|${end}`;
    if (force || O.strikeKey !== key || !O.strikeData) {
      O.strikeKey = key;
      setObsInfo('Loading strikes…');
      try {
        const hits = await loadStrikes(start, end);
        if (O.run !== run || !O.strikes || O.strikeKey !== key) return;
        O.strikeData = hits;
        O.strikeEnd = end;
        O.strikeAt = Date.now();
      } catch (error) {
        if (O.run !== run || O.strikeKey !== key) return;
        O.strikeData = [];
      }
      setObsInfo('');
    }
    drawStrikes();
  }
  followHoco();
  if (O.radar) await drawRadar();
}
// In 'last24' the map shows the newest forecast that had been issued by the time on the slider.
let hocoTok = 0;
async function followHoco() {
  const lbl = $('obsHoco');
  if (effMode() !== 'last24' || !(O.radar || O.strikes) || O.t == null) { if (O.hocoId !== undefined) { O.hocoId = undefined; X.showObsGeo(null); } if (lbl) lbl.textContent = ''; return; }
  const run = X.runAt(O.t), id = run ? run.id : null;
  if (lbl) lbl.innerHTML = run ? `<span class="o-lg">Forecast issued </span><span class="o-sh">HOCO </span><span class="o-lg">${new Date(X.created(run)).toLocaleDateString('en-GB', { weekday: 'short' })} </span>${hm(X.created(run).getTime())}` : 'No forecast for this time';
  if (id === O.hocoId) return; O.hocoId = id; const tok = ++hocoTok;
  if (!run) { X.showObsGeo({ type: 'FeatureCollection', features: [] }); return; }
  try { const g = await X.fetchGeo(run); if (tok === hocoTok) X.showObsGeo(g, run); } catch (e) { /* keep what is shown */ }
}
let playTimer = null;
function stop() { O.playing = false; clearTimeout(playTimer); const b = $('obsPlay'); if (b) { b.innerHTML = PLAY; b.setAttribute('aria-label', 'Play'); } }
async function step() {
  if (!O.playing) return;
  let next = O.t + RADAR_STEP * ((O.tNow - O.t0) > 12 * 3600000 ? 3 : 2); if (next > O.tNow) next = O.t0;
  await setTime(next);
  playTimer = setTimeout(step, O.t >= O.tNow ? 1200 : 350);
}
const PLAY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';
const PAUSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
let lineSaved = null;
export function syncForecastLayers() {
  const map = X.map, spread = X.spreadActive();
  const visible = O.forecast && !spread;
  if (map.getLayer('hoco-line')) map.setLayoutProperty('hoco-line', 'visibility', visible ? 'visible' : 'none');
  if (map.getLayer('hoco-fill')) map.setLayoutProperty('hoco-fill', 'visibility', visible && !O.outlines && !diffOn ? 'visible' : 'none');
  if (map.getLayer('hoco-diff')) map.setLayoutProperty('hoco-diff', 'visibility', spread ? 'none' : 'visible');
  const toggle = $('lySpread'), forecast = document.querySelector('#layersPop [data-layer="forecast"]');
  if (toggle) {
    toggle.checked = spread;
    toggle.disabled = !X.spreadAvailable();
    $('lySpreadNote').textContent = X.spreadAvailable() ? 'Standard deviation across contributing fields' : 'Unavailable for this forecast';
  }
  if (forecast) forecast.disabled = spread;
}
function setOutlines(on) {
  const map = X.map; O.outlines = on;
  if (!map.getLayer('hoco-line')) return;
  if (on) { if (!lineSaved) lineSaved = { c: map.getPaintProperty('hoco-line', 'line-color'), w: map.getPaintProperty('hoco-line', 'line-width') };
    map.setLayoutProperty('hoco-fill', 'visibility', 'none'); map.setPaintProperty('hoco-line', 'line-color', ['coalesce', ['get', 'fill'], X.colorExpr()]); map.setPaintProperty('hoco-line', 'line-width', 2.2); }
  else { if (O.forecast) map.setLayoutProperty('hoco-fill', 'visibility', 'visible'); if (lineSaved) { map.setPaintProperty('hoco-line', 'line-color', lineSaved.c); map.setPaintProperty('hoco-line', 'line-width', lineSaved.w); } lineSaved = null; }
  syncForecastLayers();
}

// ------------------------------------------------------------------ layers + map style popover
const STYLES = [['default', 'Default', 'Light or dark, follows the theme'], ['classic', 'Classic HOCO', 'The style from the classic site'], ['standard', 'Standard', 'Mapbox Standard, with 3D buildings'],
  ['light', 'Light', 'Always light'], ['dark', 'Dark', 'Always dark'], ['outdoors', 'Outdoors', 'Hills, paths and terrain'],
  ['satellite', 'Satellite', 'Imagery only'], ['satellite-streets', 'Satellite + streets', 'Imagery with roads and names']];
// small drawn previews of each style (same coastline, the style's own colours)
const GB = 'M54 4l7 2-1 6 5 3-2 6 6 4 1 7 7 5-1 6 6 4-4 5-9 1-6 3-9-1-7 2-3-4 5-4-4-3 5-4-6-3 3-5-4-4 4-6-3-5 4-4-2-6z';
const IE = 'M30 24l7-2 5 3-1 6 2 5-4 5-8 2-6-3 1-6-3-4z';
const FR = 'M86 56l8-4 12 1 14 3v4H82z';
const TH = {
  light: { sea: '#cfd8de', land: '#f7f7f4', line: '#d9d9d4', label: '#9aa4ad' },
  dark: { sea: '#17191c', land: '#33363a', line: '#4a4e54', label: '#7d848c' },
  classic: { sea: '#a9c3d9', land: '#eef0ec', line: '#c8ccc6', label: '#7d8b99', coast: '#55687a' },
  standard: { sea: '#9fcdea', land: '#f2eee4', line: '#ffffff', road: '#f6cf62', park: '#cfe5bf', label: '#6b7a86' },
  outdoors: { sea: '#a7d2e6', land: '#eef0d8', line: '#e2d9c0', park: '#bcd9a0', contour: '#d4c9a6', label: '#6c7a5f' },
  satellite: { sea: '#14283c', land: '#3f5a2e', land2: '#6b6a3c', sat: true },
  'satellite-streets': { sea: '#14283c', land: '#3f5a2e', land2: '#6b6a3c', sat: true, road: '#f2c94c', label: '#ffffff' }
};
function styleThumb(k) {
  const one = (t, id) => {
    const fill = t.sat ? `url(#g${id})` : t.land;
    return `${t.sat ? `<defs><linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.land}"/><stop offset=".55" stop-color="${t.land2}"/><stop offset="1" stop-color="${t.land}"/></linearGradient></defs>` : ''}
      <rect width="120" height="60" fill="${t.sea}"/><path d="${GB}" fill="${fill}" ${t.coast ? `stroke="${t.coast}" stroke-width=".8"` : ''}/><path d="${IE}" fill="${fill}"/><path d="${FR}" fill="${fill}"/>
      ${t.park ? `<path d="M58 24c3-2 6 0 5 3s-6 2-5-3zM66 40c3-1 5 1 4 3s-5 1-4-3z" fill="${t.park}"/>` : ''}
      ${t.contour ? `<path d="M50 14c4 2 6 6 5 10M57 12c3 3 4 7 3 10" fill="none" stroke="${t.contour}" stroke-width=".7"/>` : ''}
      ${t.line ? `<path d="M56 46l9-8 4-10M65 38l8 4" fill="none" stroke="${t.line}" stroke-width="1"/>` : ''}
      ${t.road ? `<path d="M55 47l10-9 5-12M66 38l9 5M60 20l6 6" fill="none" stroke="${t.road}" stroke-width="1.3" stroke-linecap="round"/>` : ''}
      ${t.label ? `<rect x="62" y="44" width="12" height="2" rx="1" fill="${t.label}"/><rect x="58" y="22" width="9" height="2" rx="1" fill="${t.label}"/>` : ''}`;
  };
  if (k === 'default') return `<svg viewBox="0 0 120 60" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><clipPath id="cpd"><path d="M120 0v60H40z"/></clipPath></defs>${one(TH.light, 'l')}<g clip-path="url(#cpd)">${one(TH.dark, 'd')}</g><path d="M120 0 40 60" stroke="rgba(255,255,255,.7)" stroke-width="1"/></svg>`;
  return `<svg viewBox="0 0 120 60" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${one(TH[k], k)}</svg>`;
}
function renderLayersPop() {
  const pop = $('layersPop'), cur = X.mapStyle();
  pop.innerHTML = `<span class="kicker" style="padding:4px 6px 6px">Map layers</span>
    ${[['forecast', 'Forecast areas', 'HOCO thunderstorm risk'], ['radar', 'Rain radar', 'Observed rain through the period'], ['strikes', 'Lightning strikes', 'Newest in gold']].map(([k, l, d]) =>
      `<label class="item layer"><span><b>${l}</b><small>${d}</small></span><input type="checkbox" class="switch" data-layer="${k}" ${O[k] ? 'checked' : ''}></label>`).join('')}
    <label class="item layer"><span><b>Model spread</b><small id="lySpreadNote"></small></span><input type="checkbox" class="switch" id="lySpread" aria-describedby="lySpreadNote"></label>
    <label class="item layer"><span><b>Map outlines</b><small>Coasts and borders on top of the colours</small></span><input type="checkbox" class="switch" id="lyOutlines" ${X.outlines() ? 'checked' : ''}></label>
    <label class="item layer"><span><b>Forecast as outlines only</b><small>Handy with radar on</small></span><input type="checkbox" class="switch" id="lyHocoLines" ${O.outlines ? 'checked' : ''}></label>
    <span class="kicker" style="padding:10px 6px 6px;display:block">Map style</span>
    <div class="stylegrid">${STYLES.map(([k, l, d]) => `<button class="stylebtn" data-style="${k}" aria-pressed="${cur === k}" title="${d}"><i>${styleThumb(k)}</i><span>${l}</span></button>`).join('')}</div>`;
  pop.querySelectorAll('[data-layer]').forEach(i => i.onchange = () => setLayer(i.dataset.layer, i.checked));
  $('lySpread').onchange = (e) => X.setSpread(e.target.checked);
  syncForecastLayers();
  $('lyOutlines').onchange = (e) => X.setOutlines(e.target.checked);
  $('lyHocoLines').onchange = (e) => setOutlines(e.target.checked);
  pop.querySelectorAll('[data-style]').forEach(b => b.onclick = () => { X.setMapStyle(b.dataset.style); pop.querySelectorAll('[data-style]').forEach(x => x.setAttribute('aria-pressed', x === b)); });
}
export function setLayer(k, on, opts = {}) {
  O[k] = on;
  const map = X.map;
  if (k === 'forecast') { syncForecastLayers(); return; }
  if (k === 'radar' && !on) removeRadar();
  if (k === 'strikes' && !on) removeStrikes();
  if (k === 'strikes' && on) O.strikeData = null;
  if (!opts.temp && !O.archive) { try { localStorage.setItem('hocoLayers', JSON.stringify({ radar: O.radar, strikes: O.strikes })); } catch (e) { } }
  syncObs();
}
export function archiveMode(on) {
  O.archive = on;
  if (on) { O.before = { strikes: O.strikes }; if (!O.strikes) setLayer('strikes', true, { temp: true }); }
  else if (O.before) { if (!O.before.strikes && O.strikes) setLayer('strikes', false, { temp: true }); O.before = null; }
}

// ------------------------------------------------------------------ export: PNG or KML, with options
const EXPORTS = { landscape: [1600, 1000, 'Landscape'], square: [1080, 1080, 'Square'], story: [1080, 1920, 'Story'] };
const EX = { size: 'landscape', file: 'png', key: true };
async function renderExport(kind, withKey = true) {
  const [W, H] = EXPORTS[kind], run = O.run;
  await Promise.race([new Promise(r => { X.map.once('render', r); X.map.triggerRepaint(); }), new Promise(r => setTimeout(r, 700))]);
  const src = X.map.getCanvas(), c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = '#eef2f7'; g.fillRect(0, 0, W, H);
  const stripH = Math.round(H * 0.06), mapH = H - stripH, scale = Math.max(W / src.width, mapH / src.height), dw = src.width * scale, dh = src.height * scale;
  g.drawImage(src, (W - dw) / 2, (mapH - dh) / 2, dw, dh);
  const u = Math.min(W, H) / 1080, F = (s, w = 600) => `${w} ${Math.round(s * u)}px Inter, system-ui, sans-serif`;
  const pk = X.peakOf(X.S.geo || { features: [] }), st = X.startOf(run), en = X.endOf(run), cr = X.created(run);
  const lines = [[`${run.type === 'timing' ? 'Hourcast' : 'HOCO Thunderstorm Outlook'}: ${run.region || X.S.region}`, F(34, 800), '#0f1b2d'],
    [`Chance of lightning within 20 km${pk.risk >= 5 ? ` · peak ${Math.round(pk.risk)}%` : ''}`, F(22, 500), '#3b4a5e'],
    [`Valid ${run.windowValidity || (st && en ? `${X.dayName(st)} ${X.hhmm(st)} – ${X.dayName(en)} ${X.hhmm(en)}` : '')}  ·  Issued ${cr ? `${X.dayDate(cr)} ${X.hhmm(cr)}` : ''}`, F(20, 500), '#3b4a5e']];
  const padB = 22 * u; let bw = 0; lines.forEach(l => { g.font = l[1]; bw = Math.max(bw, g.measureText(l[0]).width); });
  const bx = 28 * u, by = 28 * u, bh = padB * 2 + 34 * u + 2 * 30 * u; bw = Math.min(W - 56 * u, bw + padB * 2);
  g.fillStyle = '#ffffff'; g.strokeStyle = '#0f1b2d'; g.lineWidth = 2 * u; g.fillRect(bx, by, bw, bh); g.strokeRect(bx, by, bw, bh);
  let y = by + padB + 30 * u; lines.forEach((l, i) => { g.font = l[1]; g.fillStyle = l[2]; g.fillText(l[0], bx + padB, y, bw - padB * 2); y += i === 0 ? 34 * u : 30 * u; });
  if (withKey) {
    const bands = X.BANDS, kw = Math.min(64 * u, (W - 56 * u - 20 * u) / bands.length), kh = 26 * u, kx = 28 * u, extra = O.strikes ? 40 * u : 0, ky = mapH - 28 * u - kh - 26 * u - extra;
    g.fillStyle = '#ffffff'; g.fillRect(kx - 10 * u, ky - 10 * u, kw * bands.length + 20 * u, kh + 46 * u + extra); g.strokeRect(kx - 10 * u, ky - 10 * u, kw * bands.length + 20 * u, kh + 46 * u + extra);
    bands.forEach((b, i) => { g.fillStyle = b.fill; g.fillRect(kx + i * kw, ky, kw - 2 * u, kh); g.fillStyle = '#0f1b2d'; g.font = F(16, 600); g.textAlign = 'center';
      g.fillText(i === bands.length - 1 ? `${b.min}%+` : `${b.min}`, kx + i * kw + (kw - 2 * u) / 2, ky + kh + 22 * u); });
    g.textAlign = 'left';
    if (O.strikes) { let sx = kx; const sy = ky + kh + 50 * u; g.font = F(15, 600);
      STRIKE_CLASSES.forEach(([col, l]) => { g.fillStyle = col; g.beginPath(); g.arc(sx + 7 * u, sy - 5 * u, 7 * u, 0, Math.PI * 2); g.fill(); g.fillStyle = '#0f1b2d'; g.fillText(l, sx + 18 * u, sy); sx += g.measureText(l).width + 36 * u; }); }
  }
  g.fillStyle = '#0f1b2d'; g.fillRect(0, mapH, W, stripH); g.fillStyle = '#ffffff'; g.font = F(20, 700);
  g.fillText('Handry Outlook · HOCO', 28 * u, mapH + stripH / 2 + 7 * u);
  g.font = F(16, 500); g.textAlign = 'right'; g.fillStyle = '#c9d3e0';
  g.fillText(`${(X.TYPE_LABEL[run.type] || 'HOCO')}${O.strikes ? '  ·  Strikes: Met Office, ukwx' : ''}  ·  Map © Mapbox © OpenStreetMap`, W - 28 * u, mapH + stripH / 2 + 6 * u); g.textAlign = 'left';
  return c;
}
function kmlColor(hex, a = 'b3') { const h = hex.replace('#', ''); return a + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2); }
function buildKml() {
  const run = O.run, g = X.S.geo, st = X.startOf(run), en = X.endOf(run), xe = (s) => String(s).replace(/[<&>]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
  const styles = X.BANDS.map((b, i) => `<Style id="b${i}"><LineStyle><color>${kmlColor(b.fill, 'ff')}</color><width>1</width></LineStyle><PolyStyle><color>${kmlColor(b.fill)}</color></PolyStyle></Style>`).join('');
  const marks = g.features.filter(f => f.properties?.feature_type === 'polygon' && (f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon')).map(f => {
    const r = X.riskOf(f.properties), b = X.bandFor(r), i = Math.max(0, X.BANDS.indexOf(b)), polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    return polys.map(p => `<Placemark><name>${xe(X.bandLabel(b))}</name><styleUrl>#b${i}</styleUrl><Polygon><tessellate>1</tessellate>${p.map((ring, k) => `<${k ? 'innerBoundaryIs' : 'outerBoundaryIs'}><LinearRing><coordinates>${ring.map(c => `${c[0]},${c[1]},0`).join(' ')}</coordinates></LinearRing></${k ? 'innerBoundaryIs' : 'outerBoundaryIs'}>`).join('')}</Polygon></Placemark>`).join('');
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${run.type === "timing" ? "Hourcast" : "HOCO"} ${xe(run.region || X.S.region)} ${st ? X.dayDate(st) : ''}</name>
<description>Chance of lightning within 20 km. Valid ${run.windowValidity || (st && en ? `${X.dayName(st)} ${X.hhmm(st)} – ${X.dayName(en)} ${X.hhmm(en)}` : '')}. Handry Outlook HOCO.</description>${styles}${marks}</Document></kml>`;
}
async function download(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'HOCO outlook' }); return; } catch (e) { } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function fileBase() { const run = O.run, st = X.startOf(run); if (run.type === 'timing') return `Hourcast-${run.region}-${st.toISOString().slice(0,16).replace(':','')}`; return `HOCO-${run.region || X.S.region}-${st ? `${st.getFullYear()}${pad(st.getMonth() + 1)}${pad(st.getDate())}` : 'run'}`; }
export function openExport() {
  const run = O.run; if (!run) return X.toast('Nothing to export yet');
  const d = $('cookieDlg'), st = X.startOf(run), en = X.endOf(run);
  const draw = () => {
    d.innerHTML = `<section class="dialog" role="dialog" aria-modal="true" aria-label="Export image"><div class="rowbetween"><h2>Export image</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
      <div class="expreview"><b>${run.type === 'timing' ? 'Hourcast' : 'HOCO Thunderstorm Outlook'}: ${esc(run.region || X.S.region)}</b><span>${run.windowValidity || (st && en ? `${X.dayName(st)} ${X.hhmm(st)} – ${X.dayName(en)} ${X.hhmm(en)}` : '')}</span></div>
      <label class="item layer"><span><b>Show lightning strikes</b><small>Observed strikes up to now, newest in gold</small></span><input type="checkbox" class="switch" id="exStrikes" ${O.strikes ? 'checked' : ''}></label>
      <label class="item layer"><span><b>Show colour key</b><small>The chance-of-lightning boxes</small></span><input type="checkbox" class="switch" id="exKey" ${EX.key ? 'checked' : ''}></label>
      <div class="setgrp"><span class="kicker">File</span><div class="seg wide" role="group"><button data-file="png" aria-pressed="${EX.file === 'png'}">PNG image</button><button data-file="kml" aria-pressed="${EX.file === 'kml'}">KML (Google Earth)</button></div></div>
      ${EX.file === 'png' ? `<div class="setgrp"><span class="kicker">Size</span><div class="seg wide" role="group">${Object.entries(EXPORTS).map(([k, [w, h, l]]) => `<button data-size="${k}" aria-pressed="${EX.size === k}">${l}<small style="display:block;font-weight:500;font-size:11px;opacity:.75">${w}×${h}</small></button>`).join('')}</div></div>` : ''}
      <div class="chips" style="justify-content:flex-end"><button class="btn" id="exLink">Copy link</button>${X.openEmbed ? '<button class="btn" id="exEmbed">Embed</button>' : ''}<button class="btn" id="exShare">Share</button><button class="btn primary" id="exGo">Download ${EX.file.toUpperCase()}</button></div></section>`;
    d.classList.remove('hidden');
    d.querySelector('[data-x]').onclick = () => d.classList.add('hidden');
    $('exStrikes').onchange = (e) => setLayer('strikes', e.target.checked);
    $('exKey').onchange = (e) => { EX.key = e.target.checked; };
    d.querySelectorAll('[data-file]').forEach(b => b.onclick = () => { EX.file = b.dataset.file; draw(); });
    d.querySelectorAll('[data-size]').forEach(b => b.onclick = () => { EX.size = b.dataset.size; draw(); });
    $('exLink').onclick = async () => { try { await navigator.clipboard.writeText(location.href); X.toast('Link copied'); } catch (e) { X.toast(location.href); } };
    $('exEmbed') && ($('exEmbed').onclick = () => { d.classList.add('hidden'); X.openEmbed(); });
    const make = async () => {
      if (EX.file === 'kml') return new Blob([buildKml()], { type: 'application/vnd.google-earth.kml+xml' });
      if (O.strikes && O.loadingStrikes) await new Promise(r => setTimeout(r, 1500));
      const c = await renderExport(EX.size, EX.key); return new Promise(r => c.toBlob(r, 'image/png'));
    };
    $('exGo').onclick = async () => { X.toast('Preparing…'); const b = await make(); await download(b, `${fileBase()}${EX.file === 'png' ? '-' + EX.size : ''}.${EX.file}`); X.toast(EX.file === 'kml' ? 'KML saved' : 'Image saved'); };
    $('exShare').onclick = async () => {
      const b = await make(), f = new File([b], `${fileBase()}.${EX.file}`, { type: b.type });
      if (navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f], title: 'HOCO outlook', url: location.href }); return; } catch (e) { return; } }
      try { await navigator.clipboard.writeText(location.href); X.toast('Sharing files is not supported here, so the link was copied'); } catch (e) { X.toast(location.href); }
    };
  };
  draw();
}

// ------------------------------------------------------------------ places: search, saved places, place card, alerts
let placeMarker = null, place = null;
const loadPlaces = () => { try { return JSON.parse(localStorage.getItem('hocoPlaces') || 'null') || []; } catch (e) { return []; } };
const savePlaces = (list) => { try { localStorage.setItem('hocoPlaces', JSON.stringify(list)); } catch (e) { } };
const samePlace = (a, b) => a && b && Math.abs(a.lon - b.lon) < 0.01 && Math.abs(a.lat - b.lat) < 0.01;
async function dayRisk(p) {   // chance at a place for Day 0, 1, 2 (latest run of each)
  const type = X.S.product === 'ai' ? 'ai' : 'automated';
  return Promise.all([0, 1, 2].map(async d => { const r = X.runsFor(d, type).at(-1); if (!r) return null; try { return X.riskAtGeo(await X.fetchGeo(r), p.lon, p.lat); } catch (e) { return null; } }));
}
const pctTxt = (r) => r == null ? '–' : r < 5 ? '<5%' : Math.round(r) + '%';
async function search(q) {
  const list = $('searchList');
  const locRow = `<button class="item" id="useLoc"><span class="locico">◎</span><span><b>Use my location</b></span></button>`;
  if (!q.trim()) { list.innerHTML = locRow + savedRows(); wireSearch([]); return; }
  try {
    const r = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${mapboxgl.accessToken}&country=gb,ie,fr,be,nl,de,pl,lt,lv,ee&types=place,locality,postcode,district,region,neighborhood&limit=6&language=en`);
    const d = await r.json(), feats = d.features || [];
    list.innerHTML = locRow + (feats.map((f, i) => `<button class="item" data-i="${i}"><span><b>${esc(f.text)}</b><small class="muted" style="display:block;font-weight:500">${esc(f.place_name.replace(f.text + ', ', ''))}</small></span><em class="srisk" data-sr="${i}"></em></button>`).join('') || '<div class="muted" style="padding:10px">No places found</div>');
    wireSearch(feats);
    const day0 = X.S.timing ? O.run : X.S.byDay[0].at(-1);
    if (day0) { const g = await X.fetchGeo(day0); feats.forEach((f, i) => { const el = list.querySelector(`[data-sr="${i}"]`); if (el) { const rr = X.riskAtGeo(g, f.center[0], f.center[1]); el.textContent = `${pctTxt(rr)} ${X.S.timing ? 'this window' : X.S.archive ? '' : 'today'}`; } }); }
  } catch (e) { list.innerHTML = locRow + '<div class="muted" style="padding:10px">Search is unavailable right now</div>'; wireSearch([]); }
}
function savedRows() { const s = loadPlaces(); return s.length ? `<span class="kicker" style="padding:8px 12px 4px;display:block">Saved places</span>` + s.map((p, i) => `<button class="item" data-saved="${i}"><span><b>${esc(p.name)}</b>${p.alertAt ? `<small class="muted" style="display:block;font-weight:500">Alert at ${p.alertAt}%+</small>` : ''}</span></button>`).join('') : ''; }
function wireSearch(feats) {
  const list = $('searchList');
  list.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { const f = feats[+b.dataset.i]; pickPlace({ name: f.text, lon: f.center[0], lat: f.center[1] }); });
  list.querySelectorAll('[data-saved]').forEach(b => b.onclick = () => pickPlace(loadPlaces()[+b.dataset.saved]));
  $('useLoc') && ($('useLoc').onclick = () => { if (!navigator.geolocation) return X.toast('Location is not available on this device');
    $('useLoc').querySelector('b').textContent = 'Finding you…';
    navigator.geolocation.getCurrentPosition(async (pos) => { const lon = pos.coords.longitude, lat = pos.coords.latitude; let name = 'My location';
      try { const r = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?access_token=${mapboxgl.accessToken}&types=place,locality,neighborhood&limit=1`); const d = await r.json(); if (d.features?.[0]) name = d.features[0].text; } catch (e) { }
      pickPlace({ name, lon, lat }); }, () => { X.toast('Could not find your location'); $('useLoc').querySelector('b').textContent = 'Use my location'; }); });
}
function setPlace(p, fly = true) {
  place = p;
  if (!p) { placeMarker?.remove(); placeMarker = null; renderPlace(); try { localStorage.removeItem('hocoPlace'); } catch (e) { } return; }
  try { localStorage.setItem('hocoPlace', JSON.stringify(p)); } catch (e) { }
  if (!placeMarker) { const el = document.createElement('div'); el.className = 'pin'; placeMarker = new mapboxgl.Marker({ element: el, anchor: 'bottom' }); }
  placeMarker.setLngLat([p.lon, p.lat]).addTo(X.map);
  if (fly) X.map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(X.map.getZoom(), 7), padding: innerWidth <= 640 ? { bottom: 130, top: 110 } : { bottom: 100 } });
  renderPlace();
}
let placeTok = 0;
async function renderPlace() {
  const els = document.querySelectorAll('[data-place]'), tok = ++placeTok;
  if (!place) { els.forEach(el => el.classList.add('hidden')); X.measureDock(); return; }
  const saved = loadPlaces().find(x => samePlace(x, place));
  const html = (days) => `<div class="pl-top"><span class="pin-s" aria-hidden="true"></span><b class="pl-name">${esc(place.name)}</b>
      <button class="btn icon sm" data-pl-save aria-label="${saved ? 'Remove from saved places' : 'Save place'}" title="${saved ? 'Saved' : 'Save place'}">${saved ? '★' : '☆'}</button>
      <button class="btn icon sm${saved?.alertAt ? ' on' : ''}" data-pl-alert aria-label="Storm alert" title="${saved?.alertAt ? `Alert at ${saved.alertAt}%+` : 'Set an alert'}">🔔</button>
      <button class="btn icon sm" data-pl-x aria-label="Close place">✕</button></div>
    <div class="pl-days">${X.S.timing ? `<div><small>${esc(O.run?.windowLabel || 'Selected window')}</small><b>${pctTxt(O.run ? X.riskAtGeo(X.S.geo, place.lon, place.lat) : null)}</b></div>` : [0, 1, 2].map(d => { const dt = X.addDays(X.baseDay(), d), r = days?.[d], bb = r != null ? X.bandFor(r) : null;
      return `<div><small>${d === 0 ? 'Today' : X.dayName(dt)}</small><b><i style="background:${bb ? bb.fill : 'var(--track)'}"></i>${days ? pctTxt(r) : '…'}</b></div>`; }).join('')}</div>`;
  const wire = () => els.forEach(el => { el.classList.remove('hidden');
    el.querySelector('[data-pl-x]').onclick = () => setPlace(null);
    el.querySelector('[data-pl-save]').onclick = () => { const s = loadPlaces(); const i = s.findIndex(x => samePlace(x, place)); if (i >= 0) s.splice(i, 1); else s.push({ ...place, alertAt: null }); savePlaces(s); renderPlace(); X.toast(i >= 0 ? 'Removed from saved places' : 'Place saved'); };
    el.querySelector('[data-pl-alert]').onclick = () => openAlerts(place); });
  els.forEach(el => el.innerHTML = html(null)); wire(); X.measureDock();
  if (X.S.timing) return;
  const days = await dayRisk(place); if (tok !== placeTok) return;
  els.forEach(el => el.innerHTML = html(days)); wire(); X.measureDock();
}
let addingAlert = false;
function pickPlace(p) { $('searchPop').classList.add('hidden'); setPlace(p); X.openSummary?.(); if (addingAlert) { addingAlert = false; openAlerts(p); } }
export function openAlerts(focus) {
  let list = loadPlaces();
  if (focus && !list.some(x => samePlace(x, focus))) { list.push({ ...focus, alertAt: 30 }); savePlaces(list); }
  let sel = focus ? list.findIndex(x => samePlace(x, focus)) : 0;
  const d = $('cookieDlg');
  const draw = () => {
    list = loadPlaces(); const cur = list[sel];
    d.innerHTML = `<section class="dialog" role="dialog" aria-modal="true" aria-label="Storm alerts"><div class="rowbetween"><h2>Storm alerts</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
      <p class="lead">Get a notification when the chance of lightning at a saved place goes above your level.</p>
      <div class="alist">${list.length ? list.map((p, i) => `<button class="arow" data-sel="${i}" aria-pressed="${i === sel}"><span><b>${esc(p.name)}</b><small>${p.alertAt ? `alert at ${p.alertAt}%+` : 'no alert'}</small></span><span class="btn icon sm" data-del="${i}" role="button" aria-label="Remove ${esc(p.name)}">✕</span></button>`).join('') : '<p class="muted">No saved places yet.</p>'}</div>
      ${cur ? `<div class="setgrp"><span class="kicker">Alert level for ${esc(cur.name)}</span><div class="chips">${[null, 20, 30, 50, 70].map(v => `<button class="chipbtn" data-lvl="${v}" aria-pressed="${cur.alertAt === v}">${v ? v + '%+' : 'Off'}</button>`).join('')}</div></div>` : ''}
      <div class="chips" style="justify-content:space-between"><button class="btn" id="alAdd">+ Add a place</button><button class="btn primary" id="alDone">Done</button></div>
      <small class="muted">Alerts are checked whenever a new run arrives while HOCO is open. On phones, alerts need HOCO added to your home screen.</small></section>`;
    d.classList.remove('hidden');
    d.querySelector('[data-x]').onclick = () => { d.classList.add('hidden'); renderPlace(); };
    d.querySelectorAll('[data-sel]').forEach(b => b.onclick = (e) => { if (e.target.closest('[data-del]')) return; sel = +b.dataset.sel; draw(); });
    d.querySelectorAll('[data-del]').forEach(b => b.onclick = (e) => { e.stopPropagation(); const s = loadPlaces(); s.splice(+b.dataset.del, 1); savePlaces(s); sel = 0; draw(); renderPlace(); });
    d.querySelectorAll('[data-lvl]').forEach(b => b.onclick = async () => { const s = loadPlaces(); s[sel].alertAt = b.dataset.lvl === 'null' ? null : +b.dataset.lvl; savePlaces(s);
      if (s[sel].alertAt && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (e) { } }
      draw(); renderPlace(); });
    $('alAdd').onclick = (e) => { e.stopPropagation(); d.classList.add('hidden'); $('searchBtn').click(); addingAlert = true; X.toast('Search for a town or postcode to add it'); };
    $('alDone').onclick = () => { d.classList.add('hidden'); renderPlace(); };
  };
  draw();
}
export async function checkAlerts(latest) {
  const places = loadPlaces().filter(p => p.alertAt); if (!places.length) return;
  let done; try { done = JSON.parse(localStorage.getItem('hocoAlerted') || '[]'); } catch (e) { done = []; }
  for (const [day, run] of latest.entries()) {
    if (!run) continue;
    let g; try { g = await X.fetchGeo(run); } catch (e) { continue; }
    for (const p of places) {
      const key = `${run.id}|${p.lon.toFixed(2)},${p.lat.toFixed(2)}`; if (done.includes(key)) continue; done.push(key);
      const r = X.riskAtGeo(g, p.lon, p.lat); if (r < p.alertAt) continue;
      const when = day === 0 ? 'today' : day === 1 ? 'tomorrow' : X.dayName(X.startOf(run)), msg = `${Math.round(r)}% chance of lightning near ${p.name} ${when}`;
      X.toast(`⚡ ${msg}`);
      if ('Notification' in window && Notification.permission === 'granted') { try { const n = new Notification('HOCO storm alert', { body: msg, icon: 'icons/icon-192.png', tag: key }); n.onclick = () => { focus(); X.goDay(day); }; } catch (e) { } }
    }
  }
  try { localStorage.setItem('hocoAlerted', JSON.stringify(done.slice(-200))); } catch (e) { }
}

// ------------------------------------------------------------------ change since the previous run: line, plain-English summary, change map
const keyOf = (c) => `${(+c[0]).toFixed(3)},${(+c[1]).toFixed(3)}`;
function pointMap(g) { const m = new Map(); for (const f of g.features) if (f.geometry?.type === 'Point') m.set(keyOf(f.geometry.coordinates), [f.geometry.coordinates, X.riskOf(f.properties)]); return m; }
function diffOf(geo, pg, includeQuiet) {
  const a = pointMap(geo), b = pointMap(pg);
  if (includeQuiet) for (const [k, [c]] of b) { if (!a.has(k)) a.set(k, [c, 0]); }
  else if (!a.size || !b.size) return null;
  let up = null, down = null; const feats = [];
  for (const [k, [c, r]] of a) { const o = b.get(k); const d = r - (o ? o[1] : 0); if (Math.abs(d) >= 5) feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { d } });
    if (!up || d > up.d) up = { d, c }; if (!down || d < down.d) down = { d, c }; }
  return { feats, up, down };
}
function likelihood(p) { return p >= 50 ? 'likely' : p >= 30 ? 'possible' : p >= 15 ? 'a few could form' : p >= 5 ? 'a small chance' : 'unlikely'; }
function plainText(geo, diff, prev, peakChange) {
  const pts = []; for (const f of geo.features) if (f.geometry?.type === 'Point') pts.push([f.geometry.coordinates, X.riskOf(f.properties)]);
  const pk = X.peakOf(geo), region = O.run?.region || X.S.region;
  if (pk.risk < 5) return `Thunderstorms are unlikely anywhere in ${region} during this ${O.run?.type === "timing" ? "window" : "forecast"}.`;
  const p1 = X.nearestPlace(pk.lat, pk.lon), dist = (c) => Math.hypot((c[0] - pk.lon) * Math.cos(pk.lat * Math.PI / 180), c[1] - pk.lat) * 111;
  let second = null; for (const [c, r] of pts) if (dist(c) > 160 && r >= Math.max(10, pk.risk * 0.35) && (!second || r > second[1])) second = [c, r];
  let s;
  if (pk.risk >= 50) s = `Thunderstorms are likely, most likely near ${p1}.`;
  else if (pk.risk >= 30) s = `Thunderstorms are possible, most likely near ${p1}.`;
  else if (pk.risk >= 15) s = `A few thunderstorms could form, most likely near ${p1}.`;
  else s = `There is only a small chance of a thunderstorm, highest near ${p1}.`;
  if (second) { const p2 = X.nearestPlace(second[0][1], second[0][0]); if (p2 !== p1) s += second[1] >= pk.risk - 8 ? ` ${p2} has a similar chance.` : ` ${p2} has a smaller chance.`; }
  if (prev && peakChange != null) {
    const t = X.hhmm(X.created(prev)), a = Math.abs(peakChange);
    const where = diff && (peakChange > 0 ? diff.up : diff.down) && Math.abs((peakChange > 0 ? diff.up : diff.down).d) >= 5 ? `, mostly near ${X.nearestPlace((peakChange > 0 ? diff.up : diff.down).c[1], (peakChange > 0 ? diff.up : diff.down).c[0])}` : '';
    const reference = prev.changeLabel ? `compared with ${prev.changeLabel}` : `since the ${t} run`;
    s += a < 3 ? ` The peak chance is similar ${reference}.` : ` The risk is ${peakChange > 0 ? 'up' : 'down'} ${a >= 10 ? 'sharply' : 'a little'} ${reference}${where}.`;
  }
  return s;
}
function stats(g) { let peak = 0, n20 = 0, any = false;
  for (const f of g.features) { if (f.geometry?.type !== 'Point') continue; any = true; const r = X.riskOf(f.properties); if (r > peak) peak = r; if (r >= 20) n20++; }
  if (!any) peak = X.peakOf(g).risk; return { peak, n20, any }; }
let changeTok = 0, lastDiff = null, diffOn = false;
function showDiff(on) {
  const map = X.map; diffOn = on && !!lastDiff;
  if (map.getLayer('hoco-diff')) map.removeLayer('hoco-diff'); if (map.getSource('hoco-diff')) map.removeSource('hoco-diff');
  if (diffOn) {
    map.addSource('hoco-diff', { type: 'geojson', data: { type: 'FeatureCollection', features: lastDiff.feats } });
    map.addLayer({ id: 'hoco-diff', type: 'circle', source: 'hoco-diff', paint: {
      'circle-color': ['interpolate', ['linear'], ['get', 'd'], -40, '#1d4ed8', -5, '#93c5fd', 5, '#fca5a5', 40, '#b91c1c'],
      'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 4, 3, 6, 9, 8, 30], 'circle-blur': 0.5, 'circle-opacity': 0.75 } }, labelLayer());
    ['hoco-fill'].forEach(id => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', 'none'));
  }
  syncForecastLayers();
  renderChangeBox();
}
let changeState = null;
function renderChangeBox() {
  const els = document.querySelectorAll('[data-changed]'), c = changeState;
  if (!c) { els.forEach(e => { e.innerHTML = ''; e.classList.add('hidden'); }); return; }
  const relation = c.reference ? `vs ${esc(c.reference)}` : `since the ${c.t} run`;
  const d = lastDiff, nm = (x) => X.nearestPlace(x.c[1], x.c[0]);
  els.forEach(e => { e.classList.remove('hidden');
    e.innerHTML = `<div class="ch-line"><span class="arr ${c.dp > 0 ? 'up' : c.dp < 0 ? 'down' : ''}">${c.dp > 0 ? '▲' : c.dp < 0 ? '▼' : '•'}</span><span>${c.dp === 0 ? 'Peak unchanged' : `Peak ${c.dp > 0 ? '+' : '−'}${Math.abs(c.dp)}`} ${relation}</span>
      ${d ? `<button class="linkbtn" data-diff>${diffOn ? 'Hide map' : 'Show on map'}</button>` : ''}</div>
      ${diffOn && d ? `<div class="ch-map"><span class="kicker">Changes ${relation}</span><div class="ch-key"><span><i style="background:#c53030"></i>Risk up</span><span><i style="background:#2b59d9"></i>Risk down</span></div>
        ${!d.feats.length ? '<small>No changes of 5 percentage points or more.</small>' : ''}
        ${d.up && d.up.d >= 5 ? `<small>Biggest rise: ${nm(d.up)}, +${Math.round(d.up.d)} points</small>` : ''}${d.down && d.down.d <= -5 ? `<small>Biggest drop: ${nm(d.down)}, −${Math.round(-d.down.d)} points</small>` : ''}</div>` : ''}`;
    const b = e.querySelector('[data-diff]'); if (b) b.onclick = () => showDiff(!diffOn); });
  X.measureDock();
}
async function renderChange(run, geo, prev) {
  const tok = ++changeTok, plains = document.querySelectorAll('[data-plain]');
  const setPlain = (t) => plains.forEach(e => { e.textContent = t; e.classList.toggle('hidden', !t); });
  lastDiff = null; changeState = null; if (diffOn) showDiff(false);
  renderChangeBox(); setPlain(plainText(geo, null, null, null));
  if (!prev || (X.showChanged && !X.showChanged())) return;
  try {
    prev = await prev; if (tok !== changeTok || !prev) return;
    const pg = await X.fetchGeo(prev); if (tok !== changeTok) return;
    const a = stats(geo), b = stats(pg), dp = Math.round(a.peak) - Math.round(b.peak);
    let area = '';
    if (a.any && b.any && (a.n20 || b.n20)) { const d = b.n20 ? Math.round((a.n20 - b.n20) / b.n20 * 100) : 100;
      area = Math.abs(d) < 5 ? 'the 20%+ area is about the same' : `the 20%+ area ${d > 0 ? 'grew' : 'shrank'} ${Math.min(Math.abs(d), 999)}%`; }
    lastDiff = diffOf(geo, pg, run.type === "timing");
    changeState = { dp, reference: prev.changeLabel, t: X.hhmm(X.created(prev)), peak: dp === 0 ? 'peak unchanged' : `peak ${dp > 0 ? 'up' : 'down'} ${Math.abs(dp)} point${Math.abs(dp) === 1 ? '' : 's'}`, area };
    renderChangeBox(); setPlain(plainText(geo, lastDiff, prev, dp));
  } catch (e) { if (tok === changeTok) renderChangeBox(); }
}

// ------------------------------------------------------------------ cookies, offline, shortcuts
function consent() { try { return JSON.parse(localStorage.getItem('hocoConsent') || 'null'); } catch (e) { return null; } }
function saveConsent(v) { try { localStorage.setItem('hocoConsent', JSON.stringify({ ...v, at: new Date().toISOString() })); } catch (e) { } $('cookieBar').classList.add('hidden'); $('cookieDlg').classList.add('hidden'); X.onConsent?.(); }
export function openCookies() {
  const c = consent() || { stats: false, ads: false }, d = $('cookieDlg');
  d.innerHTML = `<section class="dialog" role="dialog" aria-modal="true" aria-label="Cookie choices"><div class="rowbetween"><h2>Cookie choices</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
    <label class="item layer"><span><b>Essential</b><small>Sign-in, your settings and saved places</small></span><span class="muted" style="font-size:13px;font-weight:600;white-space:nowrap">Always on</span></label>
    <label class="item layer"><span><b>Advertising</b><small>Personalised ads from Google AdSense. Off means you still see ads, just not personalised.</small></span><input type="checkbox" class="switch" id="ckAds" ${c.ads ? 'checked' : ''}></label>
    <label class="item layer"><span><b>Measurement</b><small>Google Analytics counts visits so we know what to improve</small></span><input type="checkbox" class="switch" id="ckStats" ${c.stats ? 'checked' : ''}></label>
    <div class="chips" style="justify-content:flex-end"><a class="btn" href="privacy.html#cookies">Cookie policy</a><button class="btn" id="ckSave">Save choices</button><button class="btn primary" id="ckAll2">Accept all</button></div></section>`;
  d.classList.remove('hidden');
  d.querySelector('[data-x]').onclick = () => d.classList.add('hidden');
  $('ckSave').onclick = () => saveConsent({ stats: $('ckStats').checked, ads: $('ckAds').checked });
  $('ckAll2').onclick = () => saveConsent({ stats: true, ads: true });
}
export function openShortcuts() {
  const d = $('cookieDlg');
  d.innerHTML = `<section class="dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"><div class="rowbetween"><h2>Keyboard shortcuts</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
    <div class="keys">${[['← →', 'Previous / next run'], ['1 2 3', 'Day 0, 1, 2'], ['T', 'Traditional or AI HOCO'], ['R', 'Radar on or off'], ['S', 'Strikes on or off'], ['Space', 'Play / pause radar and strikes'], ['/', 'Search for a place'], ['C', 'Compare maps'], ['E', 'Export'], ['?', 'Show this list'], ['Esc', 'Close panels']]
      .map(([k, l]) => `<div><kbd>${k}</kbd><span>${l}</span></div>`).join('')}</div></section>`;
  d.classList.remove('hidden'); d.querySelector('[data-x]').onclick = () => d.classList.add('hidden');
}

// ------------------------------------------------------------------ init + hooks
export function initExtras(ctx) {
  X = ctx;
  window.__hocoRenderExport = (k) => renderExport(k || 'landscape').then(c => c.toDataURL('image/png'));   // for checking the layout
  buildObsBar();
  if (X.embedLayers != null) { O.radar = X.embedLayers.includes('radar'); O.strikes = X.embedLayers.includes('strikes'); }
  else { try { const l = JSON.parse(localStorage.getItem('hocoLayers') || 'null'); if (l) { O.radar = !!l.radar; O.strikes = !!l.strikes; } else if (X.strikesDefault?.()) O.strikes = true; } catch (e) { } }
  $('layersBtn').onclick = (e) => { e.stopPropagation(); renderLayersPop(); X.openPop($('layersPop'), $('layersBtn')); const p = $('layersPop'), r = $('layersBtn').getBoundingClientRect();
    if (innerWidth > 640) { p.style.left = ''; p.style.right = (innerWidth - r.left + 8) + 'px'; p.style.top = Math.max(10, Math.min(r.top, innerHeight - p.offsetHeight - 10)) + 'px'; } else { const top = $('ctrlsBox').getBoundingClientRect().top; p.style.left = ''; p.style.right = '56px'; p.style.bottom = ''; p.style.top = top + 'px'; p.style.maxHeight = `calc(100dvh - ${top}px - var(--dockh,90px) - 24px)`; } };
  document.querySelectorAll('[data-export]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openExport(); });
  $('searchBtn').onclick = (e) => { e.stopPropagation(); addingAlert = false; X.openPop($('searchPop'), $('searchBtn')); const p = $('searchPop');
    if (innerWidth <= 640) { p.style.left = '10px'; p.style.right = '10px'; } $('searchIn').value = ''; search(''); setTimeout(() => $('searchIn').focus(), 30); };
  let st = null; $('searchIn').oninput = (e) => { clearTimeout(st); st = setTimeout(() => search(e.target.value), 250); };
  $('searchIn').onkeydown = (e) => { if (e.key === 'Enter') { const b = $('searchList').querySelector('[data-i]'); b && b.click(); } };
  $('obsSlider').oninput = (e) => { stop(); const t = O.t0 + +e.target.value * RADAR_STEP; if (t > O.tNow) { e.target.value = Math.round((O.tNow - O.t0) / RADAR_STEP); } setTime(Math.min(t, O.tNow)); };
  $('obsPlay').onclick = () => { if (O.playing) return stop(); O.playing = true; $('obsPlay').innerHTML = PAUSE; $('obsPlay').setAttribute('aria-label', 'Pause'); if (O.t >= O.tNow) O.t = O.t0 - RADAR_STEP; step(); };
  $('obsNow').onclick = () => { stop(); O.strikeData = null; syncObs(); };
  $('obsMode').onclick = () => { stop(); const toRun = effMode() !== 'run'; O.mode = toRun ? 'run' : 'last24'; O.tempRun = false; try { localStorage.setItem('hocoObsMode', O.mode); } catch (e) {} O.strikeData = null; O.t = null; syncObs(); };
  $('obsClose').onclick = () => { setLayer('radar', false); setLayer('strikes', false); };
  X.map.on('moveend', () => { if (O.radar) drawRadar(); });
  X.map.on('click', 'strikes', strikeClick);
  X.map.on('mouseenter', 'strikes', () => { X.map.getCanvas().style.cursor = 'pointer'; });
  X.map.on('mouseleave', 'strikes', () => { X.map.getCanvas().style.cursor = ''; });
  // cookie banner on first visit
  if (!consent() && !X.embed) $('cookieBar').classList.remove('hidden');
  $('ckAll').onclick = () => saveConsent({ stats: true, ads: true });
  $('ckReject').onclick = () => saveConsent({ stats: false, ads: false });
  $('ckManage').onclick = openCookies;
  $('cookieDlg').onclick = (e) => { if (e.target.id === 'cookieDlg') $('cookieDlg').classList.add('hidden'); };
  // offline
  const net = () => { const off = !navigator.onLine; $('offline').classList.toggle('hidden', !off);
    if (off) { const r = X.S.current; $('offlineText').textContent = `You're offline · showing the last run${r && X.created(r) ? ` from ${X.hhmm(X.created(r))}` : ''}`; } };
  addEventListener('online', () => { net(); X.toast('Back online'); }); addEventListener('offline', net); net();
  $('offlineRetry').onclick = () => { if (navigator.onLine) location.reload(); else X.toast('Still offline. Check your connection.'); };
  addEventListener('keydown', (e) => {
    if (e.target.closest('input,textarea,select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'r') setLayer('radar', !O.radar); else if (k === 's' || k === 'l') setLayer('strikes', !O.strikes);
    else if (e.key === ' ' && (O.radar || O.strikes)) { e.preventDefault(); $('obsPlay').click(); }
    else if (e.key === '/') { e.preventDefault(); $('searchBtn').click(); } else if (k === 'e') openExport();
    else if (e.key === '?') openShortcuts(); else if (e.key === 'Escape') { $('cookieDlg').classList.add('hidden'); stop(); }
  });
  try { const p = JSON.parse(localStorage.getItem('hocoPlace') || 'null'); if (p) place = p; } catch (e) { }
}
// a run is on the map (live view or a chosen run)
export function onShown(run, geo, prev) {
  // picking another day or an older run shows that run's own period until you go back to the latest Day 0
  O.tempRun = !!run && X.S.day !== 0 || (X.S.byDay?.[0]?.length && run && X.S.byDay[0].at(-1)?.id !== run.id && X.S.day === 0);
  if (O.hocoId !== undefined) O.hocoId = null;
  ++hocoTok;
  O.run = run;
  if (place && !placeMarker) setPlace(place, false); else renderPlace();
  renderChange(run, geo, prev);
  O.strikeData = null; syncObs();
}
export function onEmpty() { O.run = null; ++hocoTok; changeTok++; lastDiff = null; changeState = null; if (diffOn) showDiff(false); renderChangeBox(); document.querySelectorAll('[data-plain]').forEach(e => e.classList.add('hidden')); syncObs(); }
// the basemap style was swapped: our layers must be added again
export function onStyle() {
  O.frameKey = ''; MAIN_RADAR.key = ''; lineSaved = null;
  if (!O.forecast) setLayer('forecast', false);
  if (O.strikes && O.strikeData) drawStrikes();
  if (O.radar) drawRadar();
  if (O.outlines) setOutlines(true);
  if (diffOn) showDiff(true);
}
