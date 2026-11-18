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
const tileCache = new Map();   // url -> Promise<ImageData|null>
async function loadTile(frameMs, z, x, y) {
  const archiveFirst = Date.now() - frameMs > 2 * 3600000 - 10 * 60000;
  const urls = archiveFirst ? [tileUrl(frameMs, z, x, y, true)] : [tileUrl(frameMs, z, x, y, false), tileUrl(frameMs, z, x, y, true)];
  const key = urls[0];
  if (tileCache.has(key)) return tileCache.get(key);
  const p = (async () => {
    for (const u of urls) {
      try { const r = await fetch(u, { mode: 'cors' }); if (!r.ok) continue;
        const bmp = await createImageBitmap(await r.blob()); const c = new OffscreenCanvas(256, 256), g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(bmp, 0, 0, 256, 256); const img = g.getImageData(0, 0, 256, 256), d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 2 || (d[i + 2] > 200 && d[i] < 8 && d[i + 1] < 8)) { d[i + 3] = 0; continue; }
          const s = d[i] + d[i + 1], j = s * 4; d[i] = LUT[j]; d[i + 1] = LUT[j + 1]; d[i + 2] = LUT[j + 2]; d[i + 3] = LUT[j + 3];
        }
        return img;
      } catch (e) { /* try the next endpoint */ }
    }
    return null;
  })();
  tileCache.set(key, p);
  if (tileCache.size > 900) tileCache.delete(tileCache.keys().next().value);
  return p;
}
const lon2x = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };
const x2lon = (x, z) => x / 2 ** z * 360 - 180;
const y2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(Math.sinh(n)); };
const radarCanvas = document.createElement('canvas');
let radarToken = 0;
async function drawRadar() {
  if (!O.radar || O.t == null) return;
  const map = X.map, zm = map.getZoom(), z = zm < 5.5 ? 5 : zm < 6.5 ? 6 : 7;
  const b = map.getBounds(), n = 2 ** z;
  let x0 = Math.floor(lon2x(b.getWest(), z)), x1 = Math.floor(lon2x(b.getEast(), z)), y0 = Math.floor(lat2y(Math.min(85, b.getNorth()), z)), y1 = Math.floor(lat2y(Math.max(-85, b.getSouth()), z));
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(n - 1, x1, x0 + 9); y1 = Math.min(n - 1, y1, y0 + 9);
  const frame = frameOf(O.t), key = `${frame}|${z}|${x0}|${y0}|${x1}|${y1}`;
  if (key === O.frameKey) return;
  const tok = ++radarToken; setObsInfo('Loading radar…');
  const jobs = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(loadTile(frame, z, x, y).then(img => ({ x, y, img })));
  const tiles = await Promise.all(jobs); if (tok !== radarToken) return;
  radarCanvas.width = (x1 - x0 + 1) * 256; radarCanvas.height = (y1 - y0 + 1) * 256;
  const g = radarCanvas.getContext('2d'); g.clearRect(0, 0, radarCanvas.width, radarCanvas.height);
  let got = 0; tiles.forEach(({ x, y, img }) => { if (img) { got++; g.putImageData(img, (x - x0) * 256, (y - y0) * 256); } });
  O.frameKey = key;
  const coords = [[x2lon(x0, z), y2lat(y0, z)], [x2lon(x1 + 1, z), y2lat(y0, z)], [x2lon(x1 + 1, z), y2lat(y1 + 1, z)], [x2lon(x0, z), y2lat(y1 + 1, z)]];
  const src = map.getSource('radar');
  if (!src) addRadarLayer(coords); else { src.setCoordinates(coords); src.play(); map.triggerRepaint(); requestAnimationFrame(() => requestAnimationFrame(() => map.getSource('radar')?.pause())); }
  setObsInfo(got ? '' : 'No radar for this time');
}
function labelLayer() { return X.map.getStyle().layers.find(l => l.type === 'symbol' && l.layout && l.layout['text-field'])?.id; }
function addRadarLayer(coords) {
  const map = X.map; if (map.getSource('radar') || !coords) return;
  map.addSource('radar', { type: 'canvas', canvas: radarCanvas, coordinates: coords, animate: false });
  map.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, map.getLayer('strikes') ? 'strikes' : labelLayer());
}
function removeRadar() { const map = X.map; if (map.getLayer('radar')) map.removeLayer('radar'); if (map.getSource('radar')) map.removeSource('radar'); O.frameKey = ''; }

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
async function loadStrikes(startMs, endMs, regionId) {
  const key = `${regionId}|${startMs}|${endMs}`, live = Date.now() - endMs < 15 * 60000;
  if (O.strikeKey === key && O.strikeData && (!live || Date.now() - O.strikeAt < 120000)) return O.strikeData;
  const out = [], add = (t, lon, lat) => { if (t >= startMs && t <= endMs && Number.isFinite(lon) && Number.isFinite(lat)) out.push({ t, lon, lat }); };
  const fromStd = (raw) => strikesOf(raw).forEach(s => s?.coordinates && add(new Date(s.strike_time).getTime(), +s.coordinates[0], +s.coordinates[1]));
  const uk = regionId === 'England' || regionId === 'Scotland', s = new Date(startMs), mo = s.getMonth(), yr = s.getFullYear();
  const jobs = [];
  if (uk) {
    jobs.push(getJson(FEEDS.recent).then(fromStd));
    if (yr === 2025 && mo >= 8) jobs.push(getJson(FEEDS.autumn25).then(fromStd));
    if (yr === 2026 && mo >= 4 && mo <= 8) { jobs.push(getJson(FEEDS.summer26a).then(fromStd)); jobs.push(getJson(FEEDS.summer26).then(fromStd)); }
    if (Date.now() - endMs < 36 * 3600000 || Date.now() - startMs < 36 * 3600000) jobs.push(getJson(METOFFICE, true).then(async (raw) => {
      fromStd(raw); const chunks = (raw?.chunks || []).map(c => `${METOFFICE}?last-minutes=1&chunk=${c.chunk}`);
      (await Promise.all(chunks.map(u => getJson(u, true)))).forEach(fromStd); }));
  }
  // ukwx: one file per 06Z-06Z weather day, plus the live feed
  const dayKey = (ms) => new Date(ms - 6 * 3600000).toISOString().slice(0, 10);
  const keys = []; let c = new Date(dayKey(startMs) + 'T00:00:00Z'); const last = new Date(dayKey(endMs) + 'T00:00:00Z');
  while (c <= last && keys.length < 5) { keys.push(c.toISOString().slice(0, 10)); c = new Date(c.getTime() + 864e5); }
  keys.forEach(k => jobs.push(getJson(`${UKWX}/archive/europe/${k}.json`).then(raw => ukwxOf(raw).forEach(p => add(p.t, p.lon, p.lat)))));
  if (Date.now() - endMs < 6 * 3600000) jobs.push(getJson(`${UKWX}/europe`, true).then(raw => ukwxOf(raw).forEach(p => add(p.t, p.lon, p.lat))));
  await Promise.all(jobs);
  const r = X.REGIONS.find(x => x.id === regionId), seen = new Set();
  const list = out.filter(p => (!r || (p.lon >= r.west && p.lon <= r.east && p.lat >= r.south && p.lat <= r.north)))
    .filter(p => { const k = `${Math.round(p.t / 1000)}|${p.lon.toFixed(3)}|${p.lat.toFixed(3)}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.t - b.t);
  O.strikeKey = key; O.strikeData = list; O.strikeAt = Date.now();
  return list;
}
// newest strikes are gold, fading through orange and red to dark plum
const AGES = [[15, '#ffd21f', 'Under 15 min'], [60, '#ff8f1f', '15–60 min'], [180, '#e8392b', '1–3 h'], [Infinity, '#7a1f4f', 'Older']];
function strikeGeo() {
  const t = O.t, list = O.strikeData || [];
  const feats = []; for (const p of list) { if (p.t > t) break; const age = (t - p.t) / 60000; const i = AGES.findIndex(a => age < a[0]);
    feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { a: i } }); }
  return { type: 'FeatureCollection', features: feats };
}
function drawStrikes() {
  const map = X.map; if (!O.strikes || O.t == null || !O.strikeData) return;
  const g = strikeGeo();
  if (map.getSource('strikes')) map.getSource('strikes').setData(g);
  else {
    map.addSource('strikes', { type: 'geojson', data: g });
    map.addLayer({ id: 'strikes', type: 'circle', source: 'strikes', paint: {
      'circle-color': ['match', ['get', 'a'], 0, AGES[0][1], 1, AGES[1][1], 2, AGES[2][1], AGES[3][1]],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, ['match', ['get', 'a'], 0, 3.4, 2.2], 9, ['match', ['get', 'a'], 0, 6, 4]],
      'circle-stroke-color': '#1a1205', 'circle-stroke-width': ['match', ['get', 'a'], 0, 0.8, 0.3], 'circle-opacity': ['match', ['get', 'a'], 3, 0.7, 0.95] } }, labelLayer());
    // newest on top
    map.setLayoutProperty('strikes', 'circle-sort-key', ['-', 3, ['get', 'a']]);
  }
  setObsCount(g.features.length);
}
function removeStrikes() { const map = X.map; if (map.getLayer('strikes')) map.removeLayer('strikes'); if (map.getSource('strikes')) map.removeSource('strikes'); }

// ------------------------------------------------------------------ observed time slider
function obsRange(run) {
  const s = X.startOf(run), e = X.endOf(run); if (!s || !e) return null;
  const now = Date.now(); if (s.getTime() > now) return { future: true, s: s.getTime(), e: e.getTime() };
  return { s: frameOf(s.getTime()), e: frameOf(Math.min(e.getTime(), now - 5 * 60000)) };
}
function setObsInfo(t) { const el = $('obsInfo'); if (el) { el.dataset.msg = t || ''; renderObsInfo(); } }
function setObsCount(n) { const el = $('obsInfo'); if (el) { el.dataset.count = n; renderObsInfo(); } }
function renderObsInfo() {
  const el = $('obsInfo'); if (!el) return; const msg = el.dataset.msg, n = el.dataset.count;
  el.textContent = msg || (O.strikes ? `${n ?? 0} strike${+n === 1 ? '' : 's'} so far${O.radar ? ' · radar' : ''}` : 'Radar');
}
function fmtObs(ms) { const d = new Date(ms); return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function syncObs() {
  const on = O.radar || O.strikes, bar = $('obsBar');
  document.body.classList.toggle('obs-on', on);
  if (!on || !O.run) { bar.classList.add('hidden'); stop(); return; }
  bar.classList.remove('hidden');
  const r = obsRange(O.run);
  if (!r || r.future) { $('obsSlider').disabled = true; $('obsPlay').disabled = true; $('obsNow').disabled = true;
    $('obsTime').textContent = 'Not started yet'; setObsInfo(`Radar and strikes appear once this forecast starts (${r ? fmtObs(r.s) : '–'})`); removeRadar(); removeStrikes(); X.measureDock(); return; }
  [$('obsSlider'), $('obsPlay'), $('obsNow')].forEach(e => e.disabled = false);
  const atEnd = O.t == null || O.t >= O.t1 || O.runId !== O.run.id;
  O.runId = O.run.id; O.t0 = r.s; O.t1 = Math.max(r.e, r.s);
  if (atEnd || O.t < O.t0 || O.t > O.t1) O.t = O.t1;
  const sl = $('obsSlider'); sl.min = 0; sl.max = Math.round((O.t1 - O.t0) / RADAR_STEP); sl.value = Math.round((O.t - O.t0) / RADAR_STEP);
  sl.style.setProperty('--pct', sl.max > 0 ? sl.value / sl.max * 100 + '%' : '100%');
  $('obsStart').textContent = fmtObs(O.t0); $('obsEnd').textContent = O.t1 >= frameOf(Date.now() - 10 * 60000) ? 'Now' : fmtObs(O.t1);
  setTime(O.t, true);
  X.measureDock();
}
async function setTime(ms, force) {
  O.t = Math.max(O.t0, Math.min(O.t1, ms));
  const sl = $('obsSlider'); sl.value = Math.round((O.t - O.t0) / RADAR_STEP); sl.style.setProperty('--pct', sl.max > 0 ? sl.value / sl.max * 100 + '%' : '100%');
  $('obsTime').textContent = fmtObs(O.t);
  if (O.strikes) {
    if (!O.strikeData || force) { if (!O.loadingStrikes) { O.loadingStrikes = true; setObsInfo('Loading strikes…');
      const run = O.run, r = obsRange(run);
      try { await loadStrikes(r.s, Math.min(X.endOf(run).getTime(), Date.now()), X.S.region); } catch (e) { O.strikeData = []; }
      O.loadingStrikes = false; setObsInfo(''); } }
    drawStrikes();
  }
  if (O.radar) await drawRadar();
}
let playTimer = null;
function stop() { O.playing = false; clearTimeout(playTimer); const b = $('obsPlay'); if (b) { b.innerHTML = PLAY; b.setAttribute('aria-label', 'Play'); } }
async function step() {
  if (!O.playing) return;
  let next = O.t + RADAR_STEP * (O.t1 - O.t0 > 12 * 3600000 ? 3 : 2); if (next > O.t1) next = O.t0;
  await setTime(next);
  playTimer = setTimeout(step, O.t >= O.t1 ? 1200 : 350);
}
const PLAY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';
const PAUSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';

function renderLayersPop() {
  const pop = $('layersPop');
  pop.innerHTML = `<span class="kicker" style="padding:4px 6px 6px">Map layers</span>
    ${[['forecast', 'Forecast areas', 'HOCO thunderstorm risk'], ['radar', 'Rain radar', 'Observed rain, up to now'], ['strikes', 'Lightning strikes', 'Newest in gold']].map(([k, l, d]) =>
      `<label class="item layer"><span><b>${l}</b><small>${d}</small></span><input type="checkbox" class="switch" data-layer="${k}" ${O[k] ? 'checked' : ''}></label>`).join('')}
    <div class="key"><span class="kicker">Strike age</span>${AGES.map(a => `<span><i style="background:${a[1]}"></i>${a[2]}</span>`).join('')}</div>
    <div class="key"><span class="kicker">Rain</span><span class="rainbar"></span><span class="muted" style="font-size:11px;display:flex;justify-content:space-between;width:100%"><span>Light</span><span>Heavy</span></span></div>`;
  pop.querySelectorAll('[data-layer]').forEach(i => i.onchange = () => setLayer(i.dataset.layer, i.checked));
}
function setLayer(k, on) {
  O[k] = on;
  const map = X.map;
  if (k === 'forecast') { ['hoco-fill', 'hoco-line'].forEach(id => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')); return; }
  if (k === 'radar' && !on) removeRadar();
  if (k === 'strikes' && !on) { removeStrikes(); }
  if (k === 'strikes' && on) O.strikeData = null;
  try { localStorage.setItem('hocoLayers', JSON.stringify({ radar: O.radar, strikes: O.strikes })); } catch (e) { /* private mode */ }
  syncObs();
}

// ------------------------------------------------------------------ PNG export (plain chart style)
const EXPORTS = { landscape: [1600, 1000, 'Landscape'], square: [1080, 1080, 'Square'], story: [1080, 1920, 'Story'] };
async function exportPng(kind) {
  const [W, H] = EXPORTS[kind], run = O.run; if (!run) return X.toast('Nothing to export yet');
  X.toast('Preparing image…');
  await new Promise(r => { X.map.once('render', r); X.map.triggerRepaint(); });
  const src = X.map.getCanvas(), c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = '#eef2f7'; g.fillRect(0, 0, W, H);
  const stripH = Math.round(H * 0.06), mapH = H - stripH, scale = Math.max(W / src.width, mapH / src.height), dw = src.width * scale, dh = src.height * scale;
  g.drawImage(src, (W - dw) / 2, (mapH - dh) / 2, dw, dh);
  const u = Math.min(W, H) / 1080, F = (s, w = 600) => `${w} ${Math.round(s * u)}px Inter, system-ui, sans-serif`;
  // title box
  const pk = X.peakOf(X.S.geo || { features: [] }), st = X.startOf(run), en = X.endOf(run), cr = X.created(run);
  const lines = [[`HOCO thunderstorm outlook · ${run.region || X.S.region}`, F(34, 800), '#0f1b2d'],
    [`Chance of lightning within 20 km${pk.risk >= 5 ? ` · peak ${Math.round(pk.risk)}%` : ''}`, F(22, 500), '#3b4a5e'],
    [`Valid ${st ? `${X.dayName(st)} ${X.hhmm(st)}` : ''} – ${en ? `${X.dayName(en)} ${X.hhmm(en)}` : ''}  ·  Issued ${cr ? `${X.dayDate(cr)} ${X.hhmm(cr)}` : ''}`, F(20, 500), '#3b4a5e']];
  const padB = 22 * u; g.font = lines[0][1]; let bw = 0; lines.forEach(l => { g.font = l[1]; bw = Math.max(bw, g.measureText(l[0]).width); });
  const bx = 28 * u, by = 28 * u, bh = padB * 2 + 34 * u + 2 * 30 * u; bw = Math.min(W - 56 * u, bw + padB * 2);
  g.fillStyle = '#ffffff'; g.strokeStyle = '#0f1b2d'; g.lineWidth = 2 * u; g.fillRect(bx, by, bw, bh); g.strokeRect(bx, by, bw, bh);
  let y = by + padB + 30 * u; lines.forEach((l, i) => { g.font = l[1]; g.fillStyle = l[2]; g.fillText(l[0], bx + padB, y, bw - padB * 2); y += i === 0 ? 34 * u : 30 * u; });
  // band key: discrete boxes
  const bands = X.BANDS, kw = Math.min(64 * u, (W - 56 * u - 20 * u) / bands.length), kh = 26 * u, kx = 28 * u, ky = mapH - 28 * u - kh - 26 * u;
  g.fillStyle = '#ffffff'; g.fillRect(kx - 10 * u, ky - 10 * u, kw * bands.length + 20 * u, kh + 46 * u); g.strokeRect(kx - 10 * u, ky - 10 * u, kw * bands.length + 20 * u, kh + 46 * u);
  bands.forEach((b, i) => { g.fillStyle = b.fill; g.fillRect(kx + i * kw, ky, kw - 2 * u, kh); g.fillStyle = '#0f1b2d'; g.font = F(16, 600); g.textAlign = 'center';
    g.fillText(i === bands.length - 1 ? `${b.min}%+` : `${b.min}`, kx + i * kw + (kw - 2 * u) / 2, ky + kh + 22 * u); });
  g.textAlign = 'left';
  // credit strip
  g.fillStyle = '#0f1b2d'; g.fillRect(0, mapH, W, stripH); g.fillStyle = '#ffffff'; g.font = F(20, 700);
  g.fillText('Handry Outlook · HOCO', 28 * u, mapH + stripH / 2 + 7 * u);
  g.font = F(16, 500); g.textAlign = 'right'; g.fillStyle = '#c9d3e0';
  g.fillText(`${(X.TYPE_LABEL[run.type] || 'HOCO')}  ·  Map © Mapbox © OpenStreetMap`, W - 28 * u, mapH + stripH / 2 + 6 * u); g.textAlign = 'left';
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const name = `HOCO-${run.region || X.S.region}-${st ? `${st.getFullYear()}${pad(st.getMonth() + 1)}${pad(st.getDate())}` : 'run'}-${kind}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'HOCO outlook' }); return; } catch (e) { /* fall back to download */ } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  X.toast('Image saved');
}
function openExport(btn) {
  const pop = $('exportPop');
  pop.innerHTML = `<span class="kicker" style="padding:4px 6px 6px">Export image</span>` + Object.entries(EXPORTS).map(([k, [w, h, l]]) =>
    `<button class="item" data-exp="${k}"><span class="ratio" style="aspect-ratio:${w}/${h}"></span><span><b>${l}</b><small class="muted" style="display:block;font-weight:500">${w} × ${h} PNG</small></span></button>`).join('');
  X.openPop(pop, btn);
  pop.querySelectorAll('[data-exp]').forEach(b => b.onclick = () => { pop.classList.add('hidden'); exportPng(b.dataset.exp); });
}

// ------------------------------------------------------------------ place search
let placeMarker = null, place = null;
async function search(q) {
  const list = $('searchList'); if (!q.trim()) { list.innerHTML = ''; return; }
  try {
    const r = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${mapboxgl.accessToken}&country=gb,ie,fr,be,nl,de,pl,lt,lv,ee&types=place,locality,postcode,district,region,neighborhood&limit=6&language=en`);
    const d = await r.json();
    list.innerHTML = (d.features || []).map((f, i) => `<button class="item" data-i="${i}"><span><b>${esc(f.text)}</b><small class="muted" style="display:block;font-weight:500">${esc(f.place_name.replace(f.text + ', ', ''))}</small></span></button>`).join('') || '<div class="muted" style="padding:10px">No places found</div>';
    list.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { const f = d.features[+b.dataset.i]; $('searchPop').classList.add('hidden'); setPlace({ name: f.text, lon: f.center[0], lat: f.center[1] }); });
  } catch (e) { list.innerHTML = '<div class="muted" style="padding:10px">Search is unavailable right now</div>'; }
}
function riskAt(lon, lat) {
  const g = X.S.geo; if (!g) return null;
  let best = 0, bd = 1e9, near = 0;
  for (const f of g.features) { const gm = f.geometry; if (!gm || gm.type !== 'Point') continue;
    const dx = (gm.coordinates[0] - lon) * Math.cos(lat * Math.PI / 180), dy = gm.coordinates[1] - lat, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; near = X.riskOf(f.properties); } if (d < 0.0081) best = Math.max(best, X.riskOf(f.properties)); }   // within ~10 km
  if (bd < 1e9) return Math.max(best, bd < 0.03 ? near : 0);
  // older runs without points: polygon containing the place
  let r = 0; for (const f of g.features) { const gm = f.geometry; if (gm?.type !== 'Polygon') continue; if (inRing([lon, lat], gm.coordinates[0])) r = Math.max(r, X.riskOf(f.properties)); }
  return r;
}
function inRing(p, ring) { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j];
  if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) ins = !ins; } return ins; }
function setPlace(p) {
  place = p;
  if (!p) { placeMarker?.remove(); placeMarker = null; renderPlace(); try { localStorage.removeItem('hocoPlace'); } catch (e) { } return; }
  try { localStorage.setItem('hocoPlace', JSON.stringify(p)); } catch (e) { }
  if (!placeMarker) { const el = document.createElement('div'); el.className = 'pin'; placeMarker = new mapboxgl.Marker({ element: el, anchor: 'bottom' }); }
  placeMarker.setLngLat([p.lon, p.lat]).addTo(X.map);
  X.map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(X.map.getZoom(), 7), padding: innerWidth <= 640 ? { bottom: 260, top: 120 } : { left: innerWidth > 1100 ? 360 : 0, bottom: 200 } });
  renderPlace();
}
function renderPlace() {
  document.querySelectorAll('[data-place]').forEach(el => {
    if (!place) { el.classList.add('hidden'); return; }
    const r = riskAt(place.lon, place.lat), b = r != null ? X.bandFor(r) : null;
    el.classList.remove('hidden');
    el.innerHTML = `<span class="sw" style="background:${b ? b.fill : 'transparent'}"></span><span class="pl-t"><b>${esc(place.name)}</b><small>${r == null ? '–' : r < 5 ? 'Below 5% chance of lightning' : `${Math.round(r)}% chance of lightning (${X.bandLabel(b)})`}</small></span><button class="btn icon sm" aria-label="Clear place">✕</button>`;
    el.querySelector('button').onclick = () => setPlace(null);
  });
  X.measureDock();
}

// ------------------------------------------------------------------ change since the previous run
function stats(g) { let peak = 0, n20 = 0, any = false;
  for (const f of g.features) { if (f.geometry?.type !== 'Point') continue; any = true; const r = X.riskOf(f.properties); if (r > peak) peak = r; if (r >= 20) n20++; }
  if (!any) peak = X.peakOf(g).risk; return { peak, n20, any }; }
let changeTok = 0;
async function renderChange(run, geo, prev) {
  const tok = ++changeTok, els = document.querySelectorAll('[data-changed]');
  const set = (h) => els.forEach(e => { e.innerHTML = h; e.classList.toggle('hidden', !h); });
  if (!prev) { set(''); return; }
  try {
    const pg = await X.fetchGeo(prev); if (tok !== changeTok) return;
    const a = stats(geo), b = stats(pg), dp = Math.round(a.peak) - Math.round(b.peak);
    let area = '';
    if (a.any && b.any && (a.n20 || b.n20)) { const d = b.n20 ? Math.round((a.n20 - b.n20) / b.n20 * 100) : 100;
      area = Math.abs(d) < 5 ? 'the 20%+ area is about the same' : `the 20%+ area ${d > 0 ? 'grew' : 'shrank'} ${Math.min(Math.abs(d), 999)}%`; }
    const peak = dp === 0 ? 'peak unchanged' : `peak ${dp > 0 ? 'up' : 'down'} ${Math.abs(dp)} point${Math.abs(dp) === 1 ? '' : 's'}`;
    const arrow = dp > 0 ? '▲' : dp < 0 ? '▼' : '•';
    set(`<span class="arr ${dp > 0 ? 'up' : dp < 0 ? 'down' : ''}">${arrow}</span><span>Since the ${X.hhmm(X.created(prev))} run: ${peak}${area ? `, ${area}` : ''}.</span>`);
  } catch (e) { set(''); }
}

// ------------------------------------------------------------------ cookies, offline, shortcuts
function consent() { try { return JSON.parse(localStorage.getItem('hocoConsent') || 'null'); } catch (e) { return null; } }
function saveConsent(v) { try { localStorage.setItem('hocoConsent', JSON.stringify({ ...v, at: new Date().toISOString() })); } catch (e) { } $('cookieBar').classList.add('hidden'); $('cookieDlg').classList.add('hidden'); }
export function openCookies() {
  const c = consent() || { stats: false, ads: false }, d = $('cookieDlg');
  d.innerHTML = `<section class="dialog" role="dialog" aria-modal="true" aria-label="Cookie settings"><div class="rowbetween"><h2>Cookie settings</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
    <label class="item layer"><span><b>Essential</b><small>Keeps you signed in and remembers your theme, region and layers. Always on.</small></span><input type="checkbox" class="switch" checked disabled></label>
    <label class="item layer"><span><b>Usage statistics</b><small>Anonymous counts of which features are used, to improve HOCO.</small></span><input type="checkbox" class="switch" id="ckStats" ${c.stats ? 'checked' : ''}></label>
    <label class="item layer"><span><b>Advertising</b><small>Lets ad partners show ads in the ad spaces. Off by default.</small></span><input type="checkbox" class="switch" id="ckAds" ${c.ads ? 'checked' : ''}></label>
    <div class="chips" style="justify-content:flex-end"><a class="btn" href="privacy.html">Privacy policy</a><button class="btn primary" id="ckSave">Save choices</button></div></section>`;
  d.classList.remove('hidden');
  d.querySelector('[data-x]').onclick = () => d.classList.add('hidden');
  $('ckSave').onclick = () => saveConsent({ stats: $('ckStats').checked, ads: $('ckAds').checked });
}
export function openShortcuts() {
  const d = $('cookieDlg');
  d.innerHTML = `<section class="dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"><div class="rowbetween"><h2>Keyboard shortcuts</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
    <div class="keys">${[['← →', 'Older / newer run'], ['1 2 3', 'Day 0, 1, 2'], ['T', 'Traditional / AI HOCO'], ['R', 'Rain radar on / off'], ['L', 'Lightning strikes on / off'], ['Space', 'Play / pause radar and strikes'], ['/', 'Search for a place'], ['E', 'Export image'], ['?', 'This list'], ['Esc', 'Close panels']]
      .map(([k, l]) => `<div><kbd>${k}</kbd><span>${l}</span></div>`).join('')}</div></section>`;
  d.classList.remove('hidden'); d.querySelector('[data-x]').onclick = () => d.classList.add('hidden');
}

// ------------------------------------------------------------------ init + hooks
export function initExtras(ctx) {
  X = ctx;
  try { const l = JSON.parse(localStorage.getItem('hocoLayers') || '{}'); O.radar = !!l.radar; O.strikes = !!l.strikes; } catch (e) { }
  $('layersBtn').onclick = (e) => { e.stopPropagation(); renderLayersPop(); X.openPop($('layersPop'), $('layersBtn')); const p = $('layersPop'), r = $('layersBtn').getBoundingClientRect();
    if (innerWidth > 640) { p.style.left = ''; p.style.right = (innerWidth - r.left + 8) + 'px'; p.style.top = r.top + 'px'; } else { p.style.left = ''; p.style.right = '10px'; p.style.top = ''; p.style.bottom = (innerHeight - r.top + 8) + 'px'; } };
  document.querySelectorAll('[data-export]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openExport(b); });
  $('searchBtn').onclick = (e) => { e.stopPropagation(); X.openPop($('searchPop'), $('searchBtn')); const p = $('searchPop');
    if (innerWidth <= 640) { p.style.left = '10px'; p.style.right = '10px'; } $('searchIn').value = ''; $('searchList').innerHTML = ''; setTimeout(() => $('searchIn').focus(), 30); };
  let st = null; $('searchIn').oninput = (e) => { clearTimeout(st); st = setTimeout(() => search(e.target.value), 250); };
  $('searchIn').onkeydown = (e) => { if (e.key === 'Enter') { const b = $('searchList').querySelector('[data-i]'); b && b.click(); } };
  $('obsSlider').oninput = (e) => { stop(); setTime(O.t0 + +e.target.value * RADAR_STEP); };
  $('obsPlay').onclick = () => { if (O.playing) return stop(); O.playing = true; $('obsPlay').innerHTML = PAUSE; $('obsPlay').setAttribute('aria-label', 'Pause'); if (O.t >= O.t1) O.t = O.t0 - RADAR_STEP; step(); };
  $('obsNow').onclick = () => { stop(); syncObs(); setTime(O.t1, true); };
  $('obsClose').onclick = () => { setLayer('radar', false); setLayer('strikes', false); };
  X.map.on('moveend', () => { if (O.radar) drawRadar(); });
  // cookie banner on first visit
  if (!consent()) $('cookieBar').classList.remove('hidden');
  $('ckAll').onclick = () => saveConsent({ stats: true, ads: true });
  $('ckEssential').onclick = () => saveConsent({ stats: false, ads: false });
  $('ckManage').onclick = openCookies;
  $('cookieDlg').onclick = (e) => { if (e.target.id === 'cookieDlg') $('cookieDlg').classList.add('hidden'); };
  // offline
  const net = () => { $('offline').classList.toggle('hidden', navigator.onLine); };
  addEventListener('online', () => { net(); X.toast('Back online'); }); addEventListener('offline', net); net();
  addEventListener('keydown', (e) => {
    if (e.target.closest('input,textarea,select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'r') setLayer('radar', !O.radar); else if (k === 'l') setLayer('strikes', !O.strikes);
    else if (e.key === ' ' && (O.radar || O.strikes)) { e.preventDefault(); $('obsPlay').click(); }
    else if (e.key === '/') { e.preventDefault(); $('searchBtn').click(); } else if (k === 'e') openExport(document.querySelector('[data-export]'));
    else if (e.key === '?') openShortcuts(); else if (e.key === 'Escape') { $('cookieDlg').classList.add('hidden'); stop(); }
  });
  try { const p = JSON.parse(localStorage.getItem('hocoPlace') || 'null'); if (p) place = p; } catch (e) { }
}
// a run is on the map (live view or a chosen run)
export function onShown(run, geo, prev) {
  O.run = run;
  if (place && !placeMarker) setPlace(place); else renderPlace();
  renderChange(run, geo, prev);
  O.strikeData = null; syncObs();
}
export function onEmpty() { O.run = null; document.querySelectorAll('[data-changed]').forEach(e => e.classList.add('hidden')); syncObs(); }
// the basemap style was swapped (theme change): our layers must be added again
export function onStyle() {
  O.frameKey = '';
  if (!O.forecast) setLayer('forecast', false);
  if (O.strikes && O.strikeData) drawStrikes();
  if (O.radar) drawRadar();
}
