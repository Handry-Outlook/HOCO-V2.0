// HOCO v3 account side: settings, compare maps (+ load a run into a map), accuracy, AI HOCO status,
// upgrade requests, API access, install, tutorial, embed code, Europe map, ad spaces.
import { PRODUCTS, hasHourcast, productButtons } from './products.js?v=1';

let X;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');

// ------------------------------------------------------------------ settings
export const DEFAULTS = { mapStyle: 'default', opacity: 1, radarOpacity: 0.85, region: '', changed: true, palette: 'standard', strikesDefault: false, notifyRuns: true };
export function getSettings() { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('hocoSettings') || '{}') }; } catch (e) { return { ...DEFAULTS }; } }
function saveSettings(patch) { const s = { ...getSettings(), ...patch, styleV2: true }; try { localStorage.setItem('hocoSettings', JSON.stringify(s)); } catch (e) { } X.applySettings(s, patch); return s; }
function dialog(html, label, wide) {
  const d = $('cookieDlg');
  d.innerHTML = `<section class="dialog${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(label)}">${html}</section>`;
  d.classList.remove('hidden');
  d.querySelectorAll('[data-x]').forEach(b => b.onclick = () => d.classList.add('hidden'));
  return d;
}
export function openProductInfo() {
  const d = dialog(`<div class="rowbetween"><h2>Forecast products</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
    <dl class="forecast-defs">${['automated','ai','timing'].map(key => `<dt><b>${PRODUCTS[key].label}</b></dt><dd>${PRODUCTS[key].detail}</dd>`).join('')}</dl>
    <small class="muted">The percentages apply to the displayed period. Use the Hourcast slider to change that period.</small>`, 'Forecast products');
  const opener = document.activeElement, close = d.querySelector('[data-x]');
  close.onclick = () => { d.classList.add('hidden'); opener?.focus(); };
  close.focus();
}

const seg = (name, cur, opts) => `<div class="seg wide" role="group">${opts.map(([v, l]) => `<button data-${name}="${v}" aria-pressed="${String(cur) === String(v)}">${l}</button>`).join('')}</div>`;
const STYLE_NAMES = [['default', 'Default'], ['classic', 'Classic HOCO'], ['standard', 'Standard'], ['light', 'Light'], ['dark', 'Dark'], ['outdoors', 'Outdoors'], ['satellite', 'Satellite'], ['satellite-streets', 'Satellite + streets']];

export function renderSettings(root) {
  const s = getSettings();
  root.innerHTML = `
    <div class="setgrp"><span class="kicker">Look</span>
      <small class="muted">Theme</small>${seg('th', X.S.theme, [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']])}
      <div class="rowbetween"><small class="muted">Grid opacity</small><output id="opOut">${Math.round(s.opacity * 70)}%</output></div>
      <input type="range" id="setOp" min="0.4" max="1.4" step="0.05" value="${s.opacity}" style="--pct:${(s.opacity - 0.4) * 100}%">
      <small class="muted">Risk colours</small>${seg('pal', s.palette, [['standard', 'Standard'], ['colourblind', 'Colour-blind friendly']])}</div>
    <div class="setgrp"><span class="kicker">Map</span>
      <label class="item layer"><span><b>Show lightning strikes by default</b><small>Turn strikes on whenever HOCO opens</small></span><input type="checkbox" class="switch" id="setStrikes" ${s.strikesDefault ? 'checked' : ''}></label>
      <div class="rowbetween"><small class="muted">Map style</small><select id="setStyle">${STYLE_NAMES.map(([k, l]) => `<option value="${k}" ${s.mapStyle === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="rowbetween"><small class="muted">Radar strength</small><output id="rOut">${Math.round(s.radarOpacity * 100)}%</output></div>
      <input type="range" id="setROp" min="0.3" max="1" step="0.05" value="${s.radarOpacity}" style="--pct:${(s.radarOpacity - 0.3) / 0.7 * 100}%">
      <label class="item layer"><span><b>Show what changed</b><small>A line comparing each run with the one before</small></span><input type="checkbox" class="switch" id="setChanged" ${s.changed ? 'checked' : ''}></label>
      <div class="grid2"><select id="setRegion" aria-label="Start on region"><option value="">Start: last region used</option>${X.REGIONS.filter(r => r.west !== undefined).map(r => `<option value="${r.id}" ${s.region === r.id ? 'selected' : ''}>Start: ${r.name}</option>`).join('')}</select>
        <select id="setProduct" aria-label="Start on forecast"><option value="traditional" ${X.S.product !== 'ai' ? 'selected' : ''}>Traditional</option><option value="ai" ${X.S.product === 'ai' ? 'selected' : ''}>AI HOCO</option></select></div></div>
    <div class="setgrp"><span class="kicker">Notifications</span>
      <label class="item layer"><span><b>Notify me when my runs are ready</b><small>A message in HOCO and, if allowed, on your device</small></span><input type="checkbox" class="switch" id="setNotify" ${s.notifyRuns ? 'checked' : ''}></label>
      <div class="rowbetween"><span><b style="font-size:14px">Storm alerts</b><small class="muted" style="display:block">For your saved places</small></span><button class="btn sm" id="setAlerts">Manage</button></div></div>
    <div class="setgrp"><div class="rowbetween"><span class="kicker">Keyboard shortcuts</span><button class="btn sm" id="setKeys">Show list</button></div></div>`;
  root.querySelectorAll('[data-th]').forEach(b => b.onclick = () => { X.setTheme(b.dataset.th); root.querySelectorAll('[data-th]').forEach(x => x.setAttribute('aria-pressed', x === b)); });
  root.querySelectorAll('[data-pal]').forEach(b => b.onclick = () => { saveSettings({ palette: b.dataset.pal }); root.querySelectorAll('[data-pal]').forEach(x => x.setAttribute('aria-pressed', x === b)); });
  $('setOp').oninput = (e) => { const v = +e.target.value; e.target.style.setProperty('--pct', (v - 0.4) * 100 + '%'); $('opOut').textContent = Math.round(v * 70) + '%'; saveSettings({ opacity: v }); };
  $('setROp').oninput = (e) => { const v = +e.target.value; e.target.style.setProperty('--pct', (v - 0.3) / 0.7 * 100 + '%'); $('rOut').textContent = Math.round(v * 100) + '%'; saveSettings({ radarOpacity: v }); };
  $('setStrikes').onchange = (e) => saveSettings({ strikesDefault: e.target.checked });
  $('setStyle').onchange = (e) => saveSettings({ mapStyle: e.target.value });
  $('setChanged').onchange = (e) => saveSettings({ changed: e.target.checked });
  $('setRegion').onchange = (e) => saveSettings({ region: e.target.value });
  $('setProduct').onchange = (e) => X.setProduct(e.target.value);
  $('setNotify').onchange = (e) => { saveSettings({ notifyRuns: e.target.checked }); X.setNotifyRuns?.(e.target.checked); };
  $('setAlerts').onclick = () => X.openAlerts();
  $('setKeys').onclick = () => X.openShortcuts();
}
export function openSettings() {
  dialog(`<div class="rowbetween"><h2>Settings</h2><button class="btn icon" data-x aria-label="Close">✕</button></div><div id="setRoot" class="setroot"></div>`, 'Settings');
  renderSettings($('setRoot'));
}

// ------------------------------------------------------------------ compare maps: 1-4 maps side by side, or two maps with a swipe divider
const C = { panes: [], hourcast: new Map(), days: [], maps: [], marks: [], link: true, syncing: false, day: 0, mode: 'side', split: 0.5 };
const typeLabel = (r) => (r?.forecastProduct === 'timing' && r.type === 'human-mimic' ? 'Hourcast Ensemble' : PRODUCTS[r?.type]?.label || ({'human-mimic':'Ensemble',manual:'Manual'}[r?.type]) || 'Run');
const typeCls = (r) => ({ timing: 'ai', automated: 'trad', ai: 'ai', 'human-mimic': 'ens', manual: 'man' }[r?.type] || 'man');
const runDay = (r) => { const s = r && X.startOf(r); if (!s) return null; const t = X.baseDay(); const d = Math.round((new Date(s).setHours(0, 0, 0, 0) - t) / 864e5); return d >= 0 && d <= 2 ? d : null; };
function ensembles() { const me = X.auth?.currentUser?.uid; return X.S.runs.filter(r => r.type === 'human-mimic' && (r.userId === me || r.public) && r.cancelled !== true).slice(0, 12); }
const extra = new Map();   // runs loaded from Tools › Runs that are not in the normal lists (archive, manual)
const findRun = (id) => { if (!id) return null; for (const t of ['automated', 'ai']) for (let d = 0; d < 3; d++) { const r = X.runsFor(d, t).find(x => x.id === id); if (r) return r; } return C.hourcast.get(id) || extra.get(id) || X.S.runs.find(r => r.id === id) || null; };
// ------------------------------------------------------------------ radar and lightning on the compare maps (one shared time)
const RAD = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 12 19 5"/><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7a5 5 0 1 0 5 5"/></svg>';
const BOLT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';
const PLAYI = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';
const PAUSEI = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
const CO = { outlines: (() => { try { return localStorage.getItem('hocoCmpOutlines') !== '0'; } catch (e) { return true; } })(), radar: false, strikes: false, t: null, t0: null, t1: null, playing: false, list: null, listKey: '', states: [], timer: null, keyOpen: false, note: '' };
const E = () => X.extras?.();
const hmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function obsRange() {
  if (C.verification) {
    const { start, end } = C.verification.entry, frame = E()?.frameOf || (time => Math.floor(time / 3e5) * 3e5);
    return { s: frame(start), e: frame(end) };
  }
  const runs = C.panes.map(findRun).filter(Boolean), now = Date.now();
  const starts = runs.map(r => X.startOf(r)?.getTime()).filter(Number.isFinite), ends = runs.map(r => X.endOf(r)?.getTime()).filter(Number.isFinite);
  if (!starts.length) return null;
  const s = Math.min(...starts), e = Math.max(...ends);
  if (s > now) return { future: true, s };
  const ex = E(); const f = ex?.frameOf || ((m) => Math.floor(m / 3e5) * 3e5);
  return { s: f(s), e: f(Math.min(e, now - 5 * 60000)) };
}
function obsButtons() {
  return `<button class="btn cx-tog" data-obs="radar" aria-pressed="${CO.radar}" title="Rain radar">${RAD}<span class="cx-long">Radar</span></button><button class="btn cx-tog" data-obs="strikes" aria-pressed="${CO.strikes}" title="Lightning strikes">${BOLT}<span class="cx-long">Strikes</span></button>`;
}
function obsBar() {
  if (!CO.radar && !CO.strikes) return '';
  const r = obsRange(), ex = E(), step = ex?.RADAR_STEP || 3e5;
  if (!r || r.future) return `<div class="cx-obs"><span class="cx-obsnote">Radar and strikes appear once these forecasts start${r ? ` (${X.dayName(new Date(r.s))} ${hmm(r.s)})` : ''}.</span><button class="btn sm" id="cxObsOff">Turn off</button></div>`;
  if (CO.t == null || CO.t < r.s || CO.t > r.e) CO.t = r.e;
  CO.t0 = r.s; CO.t1 = r.e;
  const n = Math.max(0, Math.round((r.e - r.s) / step)), i = Math.round((CO.t - r.s) / step), live = Date.now() - CO.t < 20 * 60000;
  const key = CO.keyOpen ? `<div class="cx-okeys">${CO.strikes ? `<span class="okey"><b>Strikes</b>${(ex?.STRIKE_CLASSES || []).map(c => `<span><i style="background:${c[0]}"></i>${c[1]}</span>`).join('')}</span>` : ''}${CO.radar ? `<span class="okey rain"><b>Rain rate</b><span class="rainwrap"><span class="rainbar"></span><span class="rticks"><span>0.1</span><span>1</span><span>5</span><span>20</span><span>100 mm/h</span></span></span></span>` : ''}</div>` : '';
  return `<div class="cx-obs" role="group" aria-label="Radar and strikes time">
    <button class="btn icon" id="cxPlay" aria-label="${CO.playing ? 'Pause' : 'Play'}">${CO.playing ? PAUSEI : PLAYI}</button>
    <div class="cx-omid"><div class="cx-ohead"><b id="cxOTime">${CO.radar ? 'Radar' : 'Strikes'} · ${X.dayName(new Date(CO.t))} ${hmm(CO.t)}</b><span class="tag live${live ? '' : ' hidden'}" id="cxOLive">Live</span><small id="cxOInfo">${esc(CO.note)}</small></div>
      <label class="sr" for="cxOSlider">Observed time</label><input type="range" id="cxOSlider" min="0" max="${n}" value="${i}" step="1" style="--pct:${n ? i / n * 100 : 100}%">
      <div class="cx-oticks"><span>${X.dayName(new Date(r.s))} ${hmm(r.s)}</span><span>${hmm(r.e)}</span></div></div>
    ${CO.radar ? `<button class="btn sm cx-tog" id="cxOLines" aria-pressed="${CO.outlines}" title="Draw the forecast as coloured outlines while radar is on" aria-label="Forecast as outlines"><svg class="cx-short" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M4 8c2-4 9-5 13-2s4 9 0 11-10 3-12-1-3-5-1-8z"/></svg><span class="cx-long">Outlines</span></button>` : ''}<button class="btn sm" id="cxONow">${C.verification ? 'End' : 'Now'}</button><button class="btn sm" id="cxOKey" aria-expanded="${CO.keyOpen}">Key</button><button class="btn icon sm" id="cxObsOff" aria-label="Turn off radar and strikes">✕</button>
    ${key}</div>`;
}
function renderObsBar() {
  const host = $('cxObsHost'); if (!host) return;
  host.innerHTML = obsBar();
  document.querySelectorAll('[data-obs]').forEach(b => b.setAttribute('aria-pressed', CO[b.dataset.obs]));
  $('cxObsOff') && ($('cxObsOff').onclick = () => { stopObs(); CO.radar = CO.strikes = false; applyObsAll(); renderObsBar(); });
  if (!$('cxOSlider')) return;
  const step = E()?.RADAR_STEP || 3e5;
  $('cxOSlider').oninput = (e) => { stopObs(); CO.t = CO.t0 + (+e.target.value) * step; updateObsHead(); paintAll(); };
  $('cxONow').onclick = () => { stopObs(); CO.t = CO.t1; renderObsBar(); paintAll(); };
  $('cxOKey').onclick = () => { CO.keyOpen = !CO.keyOpen; renderObsBar(); };
  $('cxOLines') && ($('cxOLines').onclick = () => { CO.outlines = !CO.outlines; try { localStorage.setItem('hocoCmpOutlines', CO.outlines ? '1' : '0'); } catch (e) {} $('cxOLines').setAttribute('aria-pressed', CO.outlines); C.maps.forEach(forecastStyle); });
  $('cxPlay').onclick = () => { if (CO.playing) { stopObs(); renderObsBar(); return; } CO.playing = true; if (CO.t >= CO.t1) CO.t = CO.t0; renderObsBar(); playStep(); };
}
function updateObsHead() {
  const s = $('cxOSlider'), step = E()?.RADAR_STEP || 3e5; if (!s) return;
  const i = Math.round((CO.t - CO.t0) / step); s.value = i; s.style.setProperty('--pct', (+s.max ? i / +s.max * 100 : 100) + '%');
  const t = $('cxOTime'); if (t) t.textContent = `${CO.radar ? 'Radar' : 'Strikes'} · ${X.dayName(new Date(CO.t))} ${hmm(CO.t)}`;
  const inf = $('cxOInfo'); if (inf) inf.textContent = CO.note;
  $('cxOLive')?.classList.toggle('hidden', !(CO.t >= CO.t1 && Date.now() - CO.t < 20 * 60000));
}
function stopObs() { CO.playing = false; clearTimeout(CO.timer); }
async function playStep() {
  if (!CO.playing || !comparing()) return;
  const step = E()?.RADAR_STEP || 3e5;
  CO.t = CO.t + step > CO.t1 ? CO.t0 : CO.t + step; updateObsHead();
  await paintAll();
  if (CO.playing) CO.timer = setTimeout(playStep, CO.t >= CO.t1 ? 1400 : 450);
}
// forecast drawn as coloured outlines while radar is on, so the rain stays readable
function forecastStyle(m) {
  if (!m.getLayer('hoco-fill') || !m.getLayer('hoco-line')) return;
  if (CO.radar && CO.outlines) { m.setLayoutProperty('hoco-fill', 'visibility', 'none'); m.setPaintProperty('hoco-line', 'line-color', ['coalesce', ['get', 'fill'], X.colorExpr()]); m.setPaintProperty('hoco-line', 'line-width', 2.2); }
  else { m.setLayoutProperty('hoco-fill', 'visibility', 'visible'); m.setPaintProperty('hoco-line', 'line-color', 'rgba(16,34,56,0.45)'); m.setPaintProperty('hoco-line', 'line-width', 0.6); }
}
function applyObs(i) {
  const m = C.maps[i]; if (!m || !m.isStyleLoaded?.() && !m.getSource('hoco')) return;
  forecastStyle(m);
  if (!CO.radar) {
    const radar = CO.states[i];
    if (radar) { radar.tok++; radar.key = ''; }
    if (m.getLayer('cx-radar')) m.removeLayer('cx-radar');
    if (m.getSource('cx-radar')) m.removeSource('cx-radar');
  }
  if (!CO.strikes) { if (m.getLayer('cx-strikes')) m.removeLayer('cx-strikes'); if (m.getSource('cx-strikes')) m.removeSource('cx-strikes'); }
  paintPane(i);
}
function applyObsAll() { C.maps.forEach((_, i) => applyObs(i)); }
async function paintPane(i) {
  const m = C.maps[i], ex = E(); if (!m || !ex || CO.t == null || (!CO.radar && !CO.strikes)) return;
  const r = obsRange(); if (!r || r.future) return;
  if (CO.radar) {
    const st = CO.states[i] || (CO.states[i] = ex.newRadarState('cx-radar'));
    st.add = (coords, map, s) => ex.addCanvasRadar(coords, map, s,
      ['hoco-line', 'hoco-hindcast-contours', 'cx-coast'].find(id => map.getLayer(id)), getSettings().radarOpacity ?? 0.85);
    const got = await ex.paintRadar(m, st, CO.t, CO.playing);
    if (C.maps[i] !== m) return;
    if (got === 0) { CO.note = 'No radar for this time'; updateObsHead(); } else if (got) { if (CO.note) { CO.note = ''; updateObsHead(); } }
  }
  if (CO.strikes && CO.list) {
    const end = C.verification && CO.t === CO.t1 ? C.verification.entry.end : CO.t;
    const g = ex.strikeFeatures(CO.list, end, CO.t0);
    if (m.getSource('cx-strikes')) m.getSource('cx-strikes').setData(g);
    else if (m.getSource('hoco')) { m.addSource('cx-strikes', { type: 'geojson', data: g }); m.addLayer(ex.strikeLayer('cx-strikes')); }
  }
}
async function paintAll() {
  const maps = C.maps;
  if (CO.strikes) await ensureStrikes();
  if (C.maps === maps) await Promise.all(maps.map((_, i) => paintPane(i)));
}
async function ensureStrikes() {
  if (C.verification) return;
  const r = obsRange(), ex = E(); if (!r || r.future || !ex) return;
  const key = `${X.S.region}|${r.s}|${r.e}`; if (CO.listKey === key && CO.list && Date.now() - (CO.listAt || 0) < 120000) return;
  CO.note = 'Loading strikes…'; updateObsHead();
  const maps = C.maps;
  try {
    const list = await ex.loadStrikes(r.s, r.e + 5 * 60000, X.S.region, true);
    if (C.maps !== maps) return;
    CO.list = list; CO.listKey = key; CO.listAt = Date.now(); CO.note = '';
  } catch (e) { if (C.maps === maps) CO.note = 'Strikes are unavailable right now'; }
  updateObsHead();
}
function wireObs() {
  document.querySelectorAll('[data-obs]').forEach(b => b.onclick = () => { const k = b.dataset.obs; CO[k] = !CO[k]; if (!CO.radar && !CO.strikes) stopObs(); renderObsBar(); applyObsAll(); if (CO.strikes) paintAll(); });
  renderObsBar();
}

export const comparing = () => document.body.classList.contains('comparing');
async function compareHourcast(n) {
  const run = X.S.current;
  if (run?.type !== 'timing') return X.toast('Choose a forecast window to compare');
  const previous = await X.S.timingBaseline;
  if (!X.S.timing || X.S.current !== run) return;
  C.day = X.S.day;
  C.hourcast = new Map(X.hourcastRuns().map(window => [window.id, window]));
  if (previous) C.hourcast.set(previous.id, previous);
  const source = X.runsFor(C.day, 'automated').find(item => item.id === run.sourceRunId);
  openCompare(n, [run.id, previous?.id || source?.id].filter(Boolean));
}
export function openCompare(n = 2, sel) {
  if (X.S.timing && !sel) return compareHourcast(n);
  if (!X.S.timing) C.hourcast.clear();
  const latest = (d, t) => X.runsFor(d, t).at(-1)?.id, prev = (d, t) => X.runsFor(d, t).at(-2)?.id;
  if (!latest(X.S.day, 'automated') && !sel) return X.toast('No runs to compare yet');
  if (sel) C.panes = sel.slice(0, 4);
  else if (!comparing() || C.panes.length !== n) {
    const day = X.S.day; C.day = day;
    C.panes = (n === 4 ? [latest(0, 'automated'), latest(1, 'automated'), latest(2, 'automated'), latest(day, 'ai') || prev(day, 'automated')]
      : [latest(day, 'automated'), latest(day, 'ai') || prev(day, 'automated')]).slice(0, n).filter(Boolean);
  }
  // Start on the forecast region, or on what you were looking at if you had zoomed in further than that.
  const reg = X.REGIONS.find(r => r.id === X.S.region && r.west !== undefined), rb = reg && [[reg.west, reg.south], [reg.east, reg.north]];
  const fitZ = rb ? X.map.cameraForBounds(rb)?.zoom : null;
  C.view = rb && (fitZ == null || X.map.getZoom() < fitZ + 0.6) ? rb : X.map.getBounds();
  drawCompare();
}
function showVerificationMap(entries, selected, region, buildReference, returnToVerification) {
  const previous = { panes: C.panes, mode: C.mode, split: C.split, view: C.view };
  const previousObs = { ...CO };
  C.verification = {
    entries, region, buildReference,
    restore() {
      Object.assign(C, previous);
      Object.assign(CO, previousObs, { playing: false, states: [] });
      returnToVerification();
    }
  };
  C.mode = 'swipe';
  C.split = 0.5;
  C.view = [[region.west, region.south], [region.east, region.north]];
  Object.assign(CO, { radar: false, strikes: false, keyOpen: false });
  setVerificationWindow(selected);
}

function setVerificationWindow(index) {
  const verification = C.verification;
  const entry = verification.entries[index];
  const reference = verification.buildReference(verification.region, entry.points, X.BANDS.map(band => band.min));
  Object.assign(verification, { index, entry, reference });
  C.panes = [entry.run.id, 'observed-reference'];
  stopObs();
  const { west, east, south, north } = verification.region;
  const strikes = entry.points.filter(([lon, lat]) => lon >= west - 0.5 && lon <= east + 0.5 &&
    lat >= south - 0.5 && lat <= north + 0.5).map(([lon, lat, t]) => ({ lon, lat, t })).sort((a, b) => a.t - b.t);
  Object.assign(CO, { t: null, t0: null, t1: null, list: strikes, listKey: '', note: '' });
  drawCompare();
}
const CHEV = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
function paneHead(i) {
  if (C.verification) {
    const label = i === 0 ? typeLabel(C.verification.entry.run) : 'Lightning hindcast';
    return `<div class="cx-chip cx-ver-label"><b>${esc(label)}</b></div>
      <div class="cx-stat" id="cxStat${i}" aria-live="polite"></div>`;
  }
  const r = findRun(C.panes[i]), c = r && X.created(r), d = runDay(r), list = r && (r.type === 'automated' || r.type === 'ai') && d != null ? X.runsFor(d, r.type) : [], latest = list.at(-1)?.id === r?.id;
  return `<div class="cx-chip"><span class="cx-num">${i + 1}</span>
    <button class="cx-pick" data-pick="${i}" aria-haspopup="menu" aria-label="Change the run on map ${i + 1}"><span class="cx-tag ${typeCls(r)}">${esc(typeLabel(r))}</span>
      <span class="cx-when"><b>${c ? X.hhmm(c) : '–'}</b><small>${r?.windowLabel ? esc(r.windowLabel) : d != null ? `Day ${d}` : c ? X.dayDate(c) : ''}${latest ? ' · latest' : ''}</small></span>${CHEV}</button>
    ${C.panes.length > 1 ? `<button class="cx-x" data-rm="${i}" aria-label="Remove map ${i + 1}" title="Remove this map">✕</button>` : ''}</div>
    <div class="cx-stat" id="cxStat${i}" aria-live="polite">Loading…</div>`;
}
function drawCompare() {
  const n = C.panes.length; if (n !== 2 && C.mode === 'swipe') C.mode = 'side';
  const verification = C.verification;
  C.swipeResize?.disconnect();
  document.body.classList.add('comparing');
  const el = $('compare'); el.classList.remove('hidden'); el.classList.add('cx');
  el.classList.toggle('cx-verifying', !!verification);
  const reg = X.REGIONS.find(r => r.id === X.S.region), dt = X.baseDay(); dt.setDate(dt.getDate() + C.day);
  const verificationWindows = verification?.entries.length > 1
    ? `<select id="cxVerWindow" aria-label="Hourcast window">${verification.entries.map((entry, i) =>
      `<option value="${i}"${i === verification.index ? ' selected' : ''}>${esc(entry.label)}</option>`).join('')}</select>`
    : '';
  el.innerHTML = `<header class="cx-top">
      <button class="btn icon" id="cmpBack" aria-label="${verification ? 'Back to verification' : 'Back to the forecast map'}" title="Back (Esc)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
      <div class="cx-title"><b>${verification ? 'Forecast vs observations' : 'Compare maps'}</b><small>${verification ? esc(verification.entry.label) : `${esc(reg?.name || X.S.region)} · ${n} map${n > 1 ? 's' : ''}`}</small></div>
      <div class="cx-tools">
        ${verification ? verificationWindows : `<div class="seg" role="group" aria-label="Forecast day for Traditional and AI maps">${[0, 1, 2].map(d => { const x = new Date(dt); x.setDate(x.getDate() - C.day + d); return `<button data-cday="${d}" aria-pressed="${C.day === d}" title="${X.dayDate(x)}">Day ${d}</button>`; }).join('')}</div>`}
        ${n === 2 ? `<div class="seg" role="group" aria-label="Layout"><button data-cmode="side" aria-pressed="${C.mode === 'side'}">Side<span class="cx-long"> by side</span></button><button data-cmode="swipe" aria-pressed="${C.mode === 'swipe'}">Swipe</button></div>` : ''}
        ${verification ? '' : `<button class="btn" id="cmpAdd" ${n >= 4 ? 'disabled title="Up to 4 maps"' : 'title="Add a map"'} aria-label="Add a map">+<span class="cx-long">&nbsp;Add map</span></button>
        <label class="cx-sync" title="Pan and zoom all maps together"><input type="checkbox" id="cmpLink" ${C.link || C.mode === 'swipe' ? 'checked' : ''} ${C.mode === 'swipe' ? 'disabled' : ''}><svg class="cx-short" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg><span class="cx-long">Move together</span></label>`}
      </div>
      <span class="cx-obsbtns">${obsButtons()}</span>
      <div class="cx-key" aria-label="Colour key: chance of lightning within 20 km"><span class="cx-bar">${X.BANDS.map(b => `<i style="background:${b.fill}"></i>`).join('')}</span><span class="cx-ticks"><span>5%</span><span>50%</span><span>90%</span></span></div>
      <button class="btn primary" id="cmpClose">Done</button>
    </header>
    <div class="cx-grid" data-n="${n}" data-mode="${C.mode}">${C.panes.map((_, i) => `<section class="cx-pane" data-i="${i}" aria-label="${verification ? (i === 0 ? 'Forecast map' : 'Observed lightning map') : 'Map ' + (i + 1)}"><div class="cx-map" id="cmpMap${i}"></div>${paneHead(i)}</section>`).join('')}
      ${C.mode === 'swipe' ? `<div class="cx-divider" id="cxDiv" role="slider" tabindex="0" aria-label="${verification ? 'Swipe between forecast and observed lightning' : 'Swipe between map 1 and map 2'}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(C.split * 100)}"><span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6-6 6 6 6M15 6l6 6-6 6"/></svg></span></div>` : ''}
    </div>
    <div id="cxObsHost"></div>
    ${verification ? `<div class="cx-reference-key" aria-label="Observed lightning map key">
      <b>Smoothed lightning hindcast</b>
      ${X.BANDS.filter(band => [5, 15, 30, 50, 70, 90].includes(band.min)).map(band =>
        `<span><i style="background:${band.fill}"></i>${band.min}%${band.min === 90 ? '+' : ''}</span>`).join('')}
      <span title="Gaussian smoothing of observed lightning within 20 km">Shown within observation coverage${verification.entry.coverage < 1 ? ` · ${(verification.entry.coverage * 100).toFixed(2)}% time coverage` : ''}</span>
    </div>` : ''}
    <div class="cx-menu hidden" id="cxMenu" role="menu"></div>`;
  discardCompareMaps();
  const bounds = C.view || X.map.getBounds();
  C.panes.forEach((id, i) => {
    const m = new mapboxgl.Map({ container: `cmpMap${i}`, style: X.styleUrl(), bounds, fitBoundsOptions: { padding: 10 }, attributionControl: false, logoPosition: 'bottom-left', projection: 'mercator', dragRotate: false, pitchWithRotate: false });
    m.touchZoomRotate.disableRotation();
    let moved = false; m.once('dragstart', () => { moved = true; }); m.once('zoomstart', (e) => { if (e.originalEvent) moved = true; });
    if ('ResizeObserver' in window) {
      const resize = new ResizeObserver(() => {
        if (C.maps[i] !== m) return;
        m.resize();
        if (!moved && i === 0 && C.view) {
          C.syncing = true;
          m.fitBounds(C.view, { padding: 10, duration: 0 });
          C.syncing = false;
          C.maps.slice(1).forEach(o => o.jumpTo({ center: m.getCenter(), zoom: m.getZoom() }));
        }
      });
      resize.observe(m.getContainer());
      m.once('remove', () => resize.disconnect());
    }
    if (i === C.panes.length - 1) m.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');
    m.on('style.load', () => { addPaneLayers(m, i === 1 ? verification?.reference : null); loadPane(i).then(() => { if (C.maps[i] === m) applyObs(i); }); });
    m.on('moveend', () => { if (CO.radar) paintPane(i); });
    m.on('move', () => { if (C.syncing) return; if (i === 0 || verification || C.link || C.mode === 'swipe') C.view = m.getBounds(); if (!verification && !C.link && C.mode !== 'swipe') return; C.syncing = true; C.maps.forEach(o => { if (o !== m) o.jumpTo({ center: m.getCenter(), zoom: m.getZoom() }); }); C.syncing = false; });
    m.on('mousemove', (e) => paneProbe(i, e.lngLat));
    m.on('click', (e) => paneProbe(i, e.lngLat));
    m.on('mouseout', () => clearProbe());
    const dot = document.createElement('div'); dot.className = 'cx-cursor'; C.marks.push(new mapboxgl.Marker({ element: dot }));
    C.maps.push(m);
  });
  if (C.mode === 'swipe') wireSwipe();
  wireObs();
  el.querySelectorAll('[data-pick]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openMenu(+b.dataset.pick, b); });
  el.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { C.panes.splice(+b.dataset.rm, 1); drawCompare(); });
  el.querySelectorAll('[data-cday]').forEach(b => b.onclick = () => { C.day = +b.dataset.cday;
    C.panes = C.panes.map(id => { const r = findRun(id); if (!r || (r.type !== 'automated' && r.type !== 'ai')) return id; const list = X.runsFor(runDay(r) ?? C.day, r.type), back = list.length - 1 - list.findIndex(x => x.id === id), t = X.runsFor(C.day, r.type); return t[Math.max(0, t.length - 1 - back)]?.id || id; });
    drawCompare(); });
  el.querySelectorAll('[data-cmode]').forEach(b => b.onclick = () => { C.mode = b.dataset.cmode; drawCompare(); });
  if ($('cmpAdd')) $('cmpAdd').onclick = (e) => { e.stopPropagation(); if (C.panes.length >= 4) return; openMenu(C.panes.length, $('cmpAdd')); };
  if ($('cmpLink')) $('cmpLink').onchange = (e) => { C.link = e.target.checked; };
  if ($('cxVerWindow')) $('cxVerWindow').onchange = (e) => { setVerificationWindow(+e.target.value); $('cxVerWindow').focus(); };
  $('cmpClose').onclick = closeCompare; $('cmpBack').onclick = closeCompare;
  el.onclick = (e) => { if (!e.target.closest('#cxMenu,[data-pick],#cmpAdd')) $('cxMenu')?.classList.add('hidden'); };
}
function wireSwipe() {
  const grid = document.querySelector('.cx-grid'), top = grid.querySelector('.cx-pane[data-i="1"]'), div = $('cxDiv');
  const apply = () => { const w = grid.clientWidth, x = Math.round(C.split * w); top.style.clipPath = `inset(0 0 0 ${x}px)`; div.style.left = x + 'px'; div.setAttribute('aria-valuenow', Math.round(C.split * 100)); };
  apply();
  if ('ResizeObserver' in window) {
    C.swipeResize = new ResizeObserver(apply);
    C.swipeResize.observe(grid);
  }
  div.onpointerdown = (e) => { e.preventDefault(); div.setPointerCapture(e.pointerId); div.classList.add('drag');
    const move = (ev) => { const r = grid.getBoundingClientRect(); C.split = Math.min(0.97, Math.max(0.03, (ev.clientX - r.left) / r.width)); apply(); };
    div.onpointermove = move; div.onpointerup = div.onpointercancel = () => { div.onpointermove = null; div.classList.remove('drag'); }; };
  div.onkeydown = (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { C.split = Math.min(0.97, Math.max(0.03, C.split + (e.key === 'ArrowLeft' ? -0.05 : 0.05))); apply(); e.preventDefault(); } };
}
function openMenu(i, btn) {
  const menu = $('cxMenu'), cur = C.panes[i], r0 = findRun(cur);
  let day = runDay(r0) ?? C.day;
  let product = ['automated','ai','timing'].includes(r0?.type) ? r0.type : X.S.timing ? 'timing' : 'automated';
  let menuRequest = 0;
  const row = (r, label) => {
    const c = X.created(r), pk = X.S.peaks?.[r.id];
    return `<button class="cx-row" role="menuitemradio" data-run="${esc(r.id)}" aria-checked="${r.id === cur}"><b>${c ? X.hhmm(c) : '–'}</b><span>${esc(label || (c ? X.dayDate(c) : ''))}</span><em>${pk != null ? (pk >= 5 ? Math.round(pk) + '%' : '<5%') : ''}</em></button>`;
  };
  const draw = () => {
    const token = ++menuRequest;
    const hourly = product === 'timing';
    const source = hourly ? X.runsFor(day,'automated').filter(hasHourcast).slice().reverse() : [];
    const candidates = hourly ? [] : X.runsFor(day,product).slice().reverse();
    const localWindows = hourly ? [...C.hourcast.values()].filter(r => runDay(r) === day || r.id === cur) : [];
    const saved = !hourly ? ensembles() : [];
    menu.innerHTML = `<div class="cx-mhead"><b>${i < C.panes.length ? `Map ${i + 1}` : 'Add a map'}</b><div class="seg" role="group" aria-label="Forecast day">${[0,1,2].map(d => `<button data-mday="${d}" aria-pressed="${d === day}">Day ${d}</button>`).join('')}</div></div>
      <div class="cx-mbody">
        <div class="product-choices" role="group" aria-label="Forecast product">${productButtons('cx-product', product)}</div>
        ${source.length ? `<div class="cx-window-pick"><label class="field"><span class="kicker">Hourcast run</span><select data-hourcast-run>${source.map((r,n) => `<option value="${n}" ${r.id === r0?.sourceRunId ? 'selected' : ''}>${esc(X.hhmm(X.created(r)) + ' · ' + X.dayDate(X.created(r)))}</option>`).join('')}</select></label><div data-hourcast-window role="status"></div></div>` : ''}
        ${localWindows.length ? `<div class="cx-grp"><span class="kicker">Open Hourcast windows</span>${localWindows.map(r => row(r, r.windowValidity)).join('')}</div>` : ''}
        ${candidates.map((r,n) => row(r,n === 0 ? 'Latest' : X.dayDate(X.created(r)))).join('')}
        ${!source.length && !localWindows.length && !candidates.length ? '<small class="muted">No forecasts for this selection.</small>' : ''}
        ${saved.length ? `<div class="cx-grp"><span class="kicker">Ensembles</span>${saved.map(r => row(r,r.ensembleName || r.name || 'Ensemble')).join('')}</div>` : ''}
      </div>
      <button class="cx-more" id="cxMore">Browse forecast archive…</button>`;
    menu.querySelectorAll('[data-mday]').forEach(b => b.onclick = e => { e.stopPropagation(); day = +b.dataset.mday; draw(); });
    menu.querySelectorAll('[data-cx-product]').forEach(b => b.onclick = e => { e.stopPropagation(); product = b.dataset.cxProduct; draw(); });
    menu.querySelectorAll('[data-run]').forEach(b => b.onclick = () => { menu.classList.add('hidden'); setPane(i,b.dataset.run); });
    $('cxMore').onclick = () => { menu.classList.add('hidden'); C.pickInto = i; X.openTools('runs','all',product); };
    const select = menu.querySelector('[data-hourcast-run]'), panel = menu.querySelector('[data-hourcast-window]');
    if (select) {
      let request = 0;
      const update = async () => {
        const current = ++request;
        panel.textContent = 'Loading windows…';
        try {
          const windows = await X.hourcastWindows(source[+select.value]);
          if (token !== menuRequest || current !== request || !panel.isConnected) return;
          if (!windows.length) { panel.textContent = 'No saved windows.'; return; }
          panel.innerHTML = `<label class="field"><span class="kicker">Valid window</span><select>${windows.map((r,n) => `<option value="${n}" ${r.id === cur ? 'selected' : ''}>${esc(r.windowValidity)}</option>`).join('')}</select></label><button class="btn sm primary">Use window</button>`;
          panel.querySelector('button').onclick = () => {
            const run = windows[+panel.querySelector('select').value];
            C.hourcast.set(run.id, run);
            menu.classList.add('hidden');
            setPane(i,run.id);
          };
        } catch {
          if (token === menuRequest && current === request) panel.textContent = 'Could not load the windows.';
        }
      };
      select.onchange = update;
      update();
    }
  };
  draw();
  const r = btn.getBoundingClientRect(), w = Math.min(360,innerWidth-16), y = r.bottom + 6;
  Object.assign(menu.style, { left: Math.max(8,Math.min(r.left,innerWidth-w-8))+'px', top:y+'px', width:w+'px', maxHeight:(innerHeight-y-8)+'px' });
  menu.classList.remove('hidden');
}
function setPane(i, id) { if (i >= C.panes.length) C.panes.push(id); else C.panes[i] = id; drawCompare(); }
function discardCompareMaps() {
  CO.states.forEach(radar => radar.tok++);
  CO.states = [];
  C.maps.forEach(m => m && m.remove());
  C.maps = []; C.marks = [];
  paneGeo.length = paneStat.length = 0;
}
export function closeCompare() {
  const verification = C.verification;
  C.verification = null;
  C.pickInto = null;
  stopObs();
  C.swipeResize?.disconnect();
  discardCompareMaps();
  const el = $('compare');
  el.classList.add('hidden'); el.innerHTML = '';
  document.body.classList.remove('comparing');
  X.map.resize();
  verification?.restore();
}
export function loadTo(run) {
  extra.set(run.id, run);
  if (C.pickInto != null) { const i = C.pickInto; C.pickInto = null; X.closeTools(); setPane(Math.min(i, C.panes.length), run.id); return; }
  const c = X.created(run), slots = [0, 1, 2, 3].map(i => ({ i, r: C.panes[i] ? findRun(C.panes[i]) : null })).filter(s => s.i <= C.panes.length);
  let pick = slots.find(s => !s.r)?.i ?? 1;
  const d = dialog(`<div class="rowbetween"><h2>Load run</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
    <div class="note slim"><span class="cx-tag ${typeCls(run)}">${typeLabel(run)}</span><span>${esc(run.region || '')} · issued ${c ? `${X.dayDate(c)} ${X.hhmm(c)}` : ''}</span></div>
    <span class="kicker">Put it on which map?</span>
    <div class="alist">${slots.map(s => `<button class="arow" data-slot="${s.i}" aria-pressed="${s.i === pick}"><span><b>${s.r ? `Map ${s.i + 1}` : 'New map'}</b><small>${s.r ? `Now: ${typeLabel(s.r)} · ${X.hhmm(X.created(s.r))}` : 'Add it as another map'}</small></span></button>`).join('')}</div>
    <div class="chips" style="justify-content:flex-end"><button class="btn" data-x>Cancel</button><button class="btn primary" id="ltGo"></button></div>`, 'Load run');
  const lbl = () => { const s = slots.find(x => x.i === pick); $('ltGo').textContent = s?.r ? `Replace map ${pick + 1}` : 'Add as a new map'; }; lbl();
  d.querySelectorAll('[data-slot]').forEach(b => b.onclick = () => { pick = +b.dataset.slot; d.querySelectorAll('[data-slot]').forEach(x => x.setAttribute('aria-pressed', x === b)); lbl(); });
  $('ltGo').onclick = () => { d.classList.add('hidden'); X.closeTools(); setPane(Math.min(pick, C.panes.length), run.id); };
}
function addPaneLayers(m, reference) {
  if (m.getSource('hoco')) return;
  const label = m.getStyle().layers.find(l => l.type === 'symbol' && l.layout && l.layout['text-field'])?.id;
  m.addSource('hoco', { type: 'geojson', data: { type: 'FeatureCollection', features: [] },
    ...(reference ? { tolerance: 0 } : {}) });
  const fill = reference ? X.colorExpr() : X.fillColor();
  m.addLayer({ id: 'hoco-fill', type: 'fill', source: 'hoco', filter: ['==', ['get', 'feature_type'], 'polygon'], paint: { 'fill-color': fill, 'fill-opacity': 0.7, 'fill-antialias': !reference } }, label);
  m.addLayer({ id: reference ? 'hoco-hindcast-contours' : 'hoco-line', type: 'line', source: 'hoco',
    filter: ['==', ['get', 'feature_type'], reference ? 'contour' : 'polygon'],
    paint: { 'line-color': 'rgba(16,34,56,0.45)', 'line-width': 0.6 } }, label);
  try { m.addSource('cx-ref', { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8' });
    m.addLayer({ id: 'cx-coast', type: 'line', source: 'cx-ref', 'source-layer': 'water', paint: { 'line-color': 'rgba(15,27,45,0.55)', 'line-width': 0.7 } }, label);
    m.addLayer({ id: 'cx-borders', type: 'line', source: 'cx-ref', 'source-layer': 'admin', filter: ['all', ['<=', ['get', 'admin_level'], 1], ['==', ['get', 'maritime'], 'false']], paint: { 'line-color': 'rgba(15,27,45,0.5)', 'line-width': 0.8, 'line-dasharray': [2, 1] } }, label); } catch (e) { /* outlines are optional */ }
}
const paneGeo = [], paneStat = [];
async function loadPane(i) {
  const verification = C.verification;
  const m = C.maps[i], run = verification?.entry.run || findRun(C.panes[i]); if (!m || !run) return;
  try {
    const observed = !!verification && i === 1;
    const g = verification ? (observed ? verification.reference.geo : verification.entry.geo) : await X.fetchGeo(run);
    if (C.maps[i] !== m) return;
    paneGeo[i] = g;
    if (!m.getSource('hoco')) addPaneLayers(m, observed ? verification.reference : null);
    m.getSource('hoco').setData(g);
    if (!observed) {
      m.setPaintProperty('hoco-fill', 'fill-opacity', Math.min(1, (g?.properties?.hoco_layout === 'bands_v2' ? 0.7 : 0.32) * getSettings().opacity));
      paneStat[i] = X.peakOf(g);
    }
    C.panes.forEach((_, j) => renderStat(j));
  } catch (e) { const s = $(`cxStat${i}`); if (C.maps[i] === m && s) s.textContent = 'Could not load this map'; }
}
const pctTxt = (v) => v >= 5 ? Math.round(v) + '%' : '<5%';
function delta(a, b) { if (a == null || b == null) return ''; const d = Math.round(Math.max(a, 0)) - Math.round(Math.max(b, 0)); return `<span class="cx-d ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d === 0 ? '±0' : (d > 0 ? '+' : '−') + Math.abs(d)} vs map 1</span>`; }
function renderStat(i, here) {
  const el = $(`cxStat${i}`), pk = paneStat[i]; if (!el) return;
  const verification = C.verification;
  if (verification) {
    el.classList.toggle('here', !!here);
    if (i === 1) {
      const hindcast = here?.v[i];
      if (!here) el.innerHTML = `<small>${esc(verification.entry.label)}</small>`;
      else if (hindcast === null) el.innerHTML = '<b>Unverified</b>';
      else el.innerHTML = `<b>${pctTxt(hindcast)}</b><span>hindcast</span>`;
    } else if (here && here.v[i] !== null) {
      el.innerHTML = `<b>${pctTxt(here.v[i])}</b><span>here</span>`;
    } else if (pk) {
      el.innerHTML = `<b>${pctTxt(pk.risk)}</b><span>forecast peak</span><small>${esc(verification.entry.label)}</small>`;
    }
    el.hidden = !el.textContent;
    return;
  }
  if (!pk) return;
  const run = findRun(C.panes[i]), s = run && X.startOf(run), e = run && X.endOf(run);
  if (here) { el.innerHTML = `<b>${pctTxt(here.v[i])}</b><span>here</span>${i > 0 ? delta(here.v[i], here.v[0]) : ''}`; el.classList.add('here'); return; }
  el.classList.remove('here');
  el.innerHTML = `<b>${pctTxt(pk.risk)}</b><span>peak${pk.lat != null && pk.risk >= 5 ? ` near ${esc(X.nearestPlace(pk.lat, pk.lon))}` : ''}</span>${i > 0 ? delta(pk.risk, paneStat[0]?.risk) : ''}<small>${run?.windowValidity ? esc(run.windowValidity) : s ? `${X.dayName(s)} ${X.hhmm(s)} – ${X.dayName(e)} ${X.hhmm(e)}` : ''}</small>`;
}
function paneProbe(i, ll) {
  const v = C.panes.map((_, j) => C.verification && j === 1 ? C.verification.reference.valueAt(ll.lng, ll.lat) :
    paneGeo[j] ? X.riskAt(paneGeo[j], ll.lng, ll.lat) : null);
  C.marks.forEach((mk, j) => { if (j === i || !C.maps[j]) mk.remove(); else mk.setLngLat(ll).addTo(C.maps[j]); });
  C.panes.forEach((_, j) => renderStat(j, { v }));
}
function clearProbe() { C.marks.forEach(mk => mk.remove()); C.panes.forEach((_, j) => renderStat(j)); }

// ------------------------------------------------------------------ accuracy page
const f2 = (v, d = 2) => Number.isFinite(+v) ? (+v).toFixed(d) : '–';
function binStats(day) {
  const F = day?.reliabilityForecast, O = day?.reliabilityObserved, N = day?.reliabilityCount; if (!Array.isArray(F) || !Array.isArray(N)) return null;
  let pos = 0, n = 0, posHi = 0, nHi = 0, bs = 0; const bins = [];
  F.forEach((f, i) => { const o = O[i] || 0, c = N[i] || 0; if (!c) return; const lo = i / F.length; pos += o * c; n += c; bs += c * (o * (1 - f) ** 2 + (1 - o) * f ** 2); bins.push({ f, o, c, lo }); if (lo >= 0.1 - 1e-9) { posHi += o * c; nHi += c; } });
  if (!n) return null; const ob = pos / n, clim = ob * (1 - ob);
  return { pod: pos ? posHi / pos : null, far: nHi ? 1 - posHi / nHi : null, bss: clim ? 1 - (bs / n) / clim : null, bins };
}
function relChart(f, o, n, { perfect = true, detailed = false } = {}) {
  if (!Array.isArray(f) || !f.length) return '';
  const W = 320, H = 210, P = 34, x = (v) => P + v * (W - P - 10), y = (v) => H - P - v * (H - P - 10);
  const pts = f.map((v, i) => [v, o[i], n?.[i] || 0]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[2] !== 0);
  return `<svg viewBox="0 0 ${W} ${H}" class="relchart" role="img" aria-label="Forecast chance against how often lightning happened">
    ${perfect ? `<line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" stroke="currentColor" stroke-opacity=".35" stroke-dasharray="4 4"/>` : ''}
    <line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(0)}" stroke="currentColor" stroke-opacity=".4"/><line x1="${x(0)}" y1="${y(0)}" x2="${x(0)}" y2="${y(1)}" stroke="currentColor" stroke-opacity=".4"/>
    ${[0, 0.5, 1].map(t => `<text x="${x(t)}" y="${H - 16}" font-size="10" text-anchor="middle" fill="currentColor" opacity=".6">${t * 100}%</text><text x="${P - 6}" y="${y(t) + 3}" font-size="10" text-anchor="end" fill="currentColor" opacity=".6">${t * 100}%</text>`).join('')}
    <polyline fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" points="${pts.map(p => `${x(p[0])},${y(p[1])}`).join(' ')}"/>
    ${pts.map(p => `<circle cx="${x(p[0])}" cy="${y(p[1])}" r="3.5" fill="var(--accent)">${detailed ? `<title>${Math.round(p[0] * 100)}% forecast · ${Math.round(p[1] * 100)}% observed · ${p[2].toLocaleString()} samples</title>` : ''}</circle>`).join('')}
    <text x="${(W + P) / 2}" y="${H - 2}" font-size="10" text-anchor="middle" fill="currentColor" opacity=".7">${detailed ? 'Forecast chance' : 'HOCO said'}</text>
    ${detailed ? `<text x="8" y="${H / 2}" transform="rotate(-90 8 ${H / 2})" font-size="9" text-anchor="middle" fill="currentColor" opacity=".7">Observed lightning</text>` : ''}</svg>`;
}

async function openRunVerification() {
  const run = X.S.custom || X.S.current;
  if (!run) { X.toast('Select a forecast to verify.'); return; }
  const opener = document.activeElement;
  const region = X.REGIONS.find(r => r.id === run.region) || (run.region === 'UK'
    ? { west: -11, east: 3, south: 49, north: 61 }
    : X.REGIONS.find(r => r.id === X.S.region));
  const windows = run.type === 'timing' ? X.hourcastRuns().filter(w => w.sourceRunId === run.sourceRunId) : [];
  const displayTime = (date) => date ? `${X.dayDate(date)}, ${X.hhmm(date)}` : '–';
  const period = run.windowValidity || `${displayTime(X.startOf(run))} – ${displayTime(X.endOf(run))}`;
  const d = dialog(`<div class="rowbetween"><h2>Forecast verification</h2><button class="btn icon" data-x aria-label="Close verification">✕</button></div>
    <p class="lead">${esc(typeLabel(run))} · ${esc(run.region || X.S.region)} · Issued ${esc(displayTime(X.created(run)))}</p>
    ${windows.length > 1 ? `<label class="field"><span class="kicker">Verify</span><select id="verScope"><option value="selected">Selected window</option><option value="all">Whole Hourcast run</option></select></label>` : ''}
    <p class="lead" id="verPeriod">${esc(period)}</p>
    <div id="verResults" class="accbody" aria-live="polite"></div>`, 'Forecast verification', true);
  const body = $('verResults'), scope = $('verScope');
  let pending, closed = false;
  function close() {
    closed = true;
    pending?.abort();
    d.classList.add('hidden');
    opener?.focus();
  }
  d.querySelector('[data-x]').onclick = close;
  d.querySelector('[data-x]').focus();

  async function load() {
    pending?.abort();
    pending = new AbortController();
    const controller = pending, { signal } = controller;
    const all = scope?.value === 'all';
    const maps = all ? windows : [run];
    const start = X.startOf(maps[0])?.getTime();
    let end = X.endOf(maps.at(-1))?.getTime();
    // Automated full-period forecasts publish their end as the last included minute.
    if (['automated', 'ai'].includes(run.type) && new Date(end).getUTCMinutes() === 59) end += 60_000;
    body.textContent = 'Loading verification…';
    const status = message => { if (!closed && !signal.aborted && body.isConnected) body.textContent = message; };
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 48 * 3600_000 ||
        !Number.isFinite(region?.west)) {
      status('This forecast does not have a verifiable time period and map area.');
      return;
    }
    $('verPeriod').textContent = all ? `${displayTime(new Date(start))} – ${displayTime(new Date(end - 1))}` : period;
    if (run.weather && !String(run.weather).toLowerCase().includes('lightning')) {
      status('Verification is available for lightning forecasts.');
      return;
    }
    let timeout;
    try {
      const { OBSERVATION_DELAY, loadObservations, verifyMap, combinedVerification, observedReference } = await import('./run-verification.js?v=4');
      if (Date.now() < end + OBSERVATION_DELAY) {
        status('Verification is available after the forecast period ends and lightning observations have arrived.');
        return;
      }
      if (signal.aborted) return;
      timeout = setTimeout(() => {
        status('Verification took too long. Reopen this screen to try again.');
        controller.abort();
      }, all ? 65_000 : 20_000);
      const { points, coverage, intervals } = await loadObservations(start, end, signal);
      const results = [];
      // Limit concurrent map downloads when the whole Hourcast run is selected.
      for (let i = 0; i < maps.length && !signal.aborted; i += 3) {
        const batch = await Promise.all(maps.slice(i, i + 3).map(async window => {
          const geo = await X.fetchGeo(window);
          if (signal.aborted) return null;
          const a = window.type === 'timing' ? X.startOf(window).getTime() : start;
          const b = window.type === 'timing' ? X.endOf(window).getTime() : end;
          const windowPoints = all ? points.filter(point => point[2] >= a && point[2] < b) : points;
          const covered = intervals.reduce((sum, [from, to]) => sum + Math.max(0, Math.min(to, b) - Math.max(from, a)), 0);
          return {
            score: verifyMap(geo, region, windowPoints),
            entry: { run: window, geo, start: a, end: b, points: windowPoints, coverage: covered / (b - a),
              label: window.windowValidity || period }
          };
        }));
        results.push(...batch);
      }
      if (closed || signal.aborted || !body.isConnected) return;
      const score = all ? combinedVerification(results.map(result => result.score)) : results[0].score;
      const entries = results.map(result => result.entry).filter(entry => entry.coverage >= 0.95);
      const pct = value => (100 * value).toFixed(1) + '%';
      const fmtBins = key => score.bins.map(bin => bin[key]);
      const chart = (perfect) => relChart(fmtBins('forecast'), fmtBins('observed'), fmtBins('count'), { perfect, detailed: true });
      const startedBeforeIssue = run.type === 'timing' && start < X.created(run)?.getTime();
      const difference = Math.round(1000 * (score.forecast - score.observed)) / 10;
      const summary = difference
        ? `On average, forecast chances were ${Math.abs(difference).toFixed(1)} percentage points ${difference > 0 ? 'higher' : 'lower'} than the observed rate.`
        : 'The mean forecast chance and observed rate were within 0.1 percentage points.';
      body.innerHTML = `<div class="ver-metrics">
        <div><small>Brier score</small><strong>${score.brier.toFixed(4)}</strong><small>0 is best</small></div>
        <div><small>Mean forecast chance</small><strong>${pct(score.forecast)}</strong></div>
        <div><small>Observed lightning rate</small><strong>${pct(score.observed)}</strong></div>
      </div>
      <p class="lead">${summary}</p>
      ${entries.length ? '<button class="btn primary" id="verMap">Compare map with observed lightning</button>' : ''}
      <div class="setgrp"><div class="rowbetween ver-chart-head"><b>Reliability chart</b><button class="btn sm" id="verPerfect" aria-pressed="true">Compare with perfect calibration</button></div>
        <div id="verChart">${chart(true)}</div>
        <div class="ver-legend"><span>● ${esc(typeLabel(run))}</span><span id="verLineKey">┄ Perfect calibration</span></div>
        <p class="lead">Points closer to the dashed line had forecast chances that better matched observed frequencies.</p>
      </div>
      <small class="muted">${score.cells.toLocaleString()} ${all ? 'location-window samples' : 'sampled locations'} · Lightning within 20 km · UKWX observations${coverage < 1 ? ` · ${(coverage * 100).toFixed(2)}% time coverage` : ''}</small>
      <small class="muted">Map-based estimate using forecast points and colour bands. Only areas with supported lightning coverage are scored.</small>
      ${startedBeforeIssue ? '<small class="muted">The first verified window was already in progress when this run was issued.</small>' : ''}`;
      $('verPerfect').onclick = (event) => {
        const show = event.currentTarget.getAttribute('aria-pressed') !== 'true';
        event.currentTarget.setAttribute('aria-pressed', show);
        $('verChart').innerHTML = chart(show);
        $('verLineKey').classList.toggle('hidden', !show);
      };
      if ($('verMap')) $('verMap').onclick = () => {
        const selected = Math.max(0, entries.findIndex(entry => entry.run.id === run.id));
        d.classList.add('hidden');
        showVerificationMap(entries, selected, region, observedReference, () => {
          d.classList.remove('hidden');
          $('verMap')?.focus();
        });
        $('cmpBack')?.focus();
      };
    } catch (error) {
      status(error instanceof Error ? error.message : 'Verification is unavailable for this forecast.');
    } finally {
      clearTimeout(timeout);
    }
  }
  if (scope) scope.onchange = load;
  await load();
}
function bandBars(bins) {
  const groups = [['Under 10%', 0, 0.1], ['10–30%', 0.1, 0.3], ['30–50%', 0.3, 0.5], ['50%+', 0.5, 1.01]].map(([l, a, b]) => {
    const bs = bins.filter(x => x.lo >= a - 1e-9 && x.lo < b - 1e-9), c = bs.reduce((s, x) => s + x.c, 0);
    return { l, exp: c ? bs.reduce((s, x) => s + x.f * x.c, 0) / c : 0, obs: c ? bs.reduce((s, x) => s + x.o * x.c, 0) / c : 0, c };
  }).filter(g => g.c);
  const max = Math.max(...groups.map(g => Math.max(g.exp, g.obs)), 0.01);
  return `<div class="bars">${groups.map(g => `<div class="bar-g"><div class="bar-pair"><i class="exp" style="height:${g.exp / max * 100}%" title="Expected ${Math.round(g.exp * 100)}%"></i><i class="obs" style="height:${g.obs / max * 100}%" title="Observed ${Math.round(g.obs * 100)}%"></i></div><small>${g.l}</small><small class="muted">${Math.round(g.exp * 100)}% / ${Math.round(g.obs * 100)}%</small></div>`).join('')}</div>
    <div class="bar-key"><span><i class="exp"></i>Expected</span><span><i class="obs"></i>Observed</span></div>`;
}
// Recent days, checked here against observed strikes: peak of that day's latest Day 0 run vs lightning in the region.
async function recentDays(nDays) {
  const out = [], today = new Date(); today.setHours(0, 0, 0, 0);
  const r = X.REGIONS.find(x => x.id === X.S.region);
  for (let k = 1; k <= nDays; k++) {
    const day = new Date(today); day.setDate(day.getDate() - k); const key = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    const row = { day, key, peak: null, lightning: null };
    try {
      const s0 = new Date(key + 'T00:00:00'), s1 = new Date(key + 'T23:59:59');
      const snap = await X.getDocs(X.query(X.collection(X.db, 'hoco_requests'), X.where('createdAt', '>=', s0), X.where('createdAt', '<=', s1), X.orderBy('createdAt', 'desc'), X.limit(60)));
      let last = null; snap.forEach(x => { const d = { id: x.id, ...x.data() }; if (!last && d.type === 'automated' && X.regionMatches(X.S.region, d) && X.startOf(d) && X.dateKey(X.startOf(d)) === key) last = d; });
      if (last) row.peak = X.peakOf(await X.fetchGeo(last)).risk;
    } catch (e) { }
    try {
      const resp = await fetch(`https://ukwx.duckdns.org/lightning/archive/europe/${key}.json`, { cache: 'force-cache' });
      if (resp.ok) { const j = await resp.json(); row.lightning = (j.points || []).filter(p => !r || (p.lon >= r.west && p.lon <= r.east && p.lat >= r.south && p.lat <= r.north)).length; }
    } catch (e) { }
    out.push(row);
  }
  return out;
}
function verdict(peak, n) {
  if (peak == null || n == null) return ['–', ''];
  if (n >= 5) return peak >= 50 ? ['Good', 'good'] : peak >= 15 ? ['Fair', 'fair'] : ['Missed', 'bad'];
  return peak < 30 ? ['Good', 'good'] : peak < 50 ? ['Fair', 'fair'] : ['False alarm', 'bad'];
}
export async function openAccuracy(tab = 'accuracy') {
  const d = dialog(`<div class="rowbetween"><h2>${tab === 'ai' ? 'AI HOCO status' : 'How accurate is HOCO?'}</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
    ${seg('acctab', tab, [['accuracy', 'Accuracy'], ['ai', 'AI HOCO status']])}<div id="accBody" class="accbody"><div class="muted center"><span class="spin"></span> Loading…</div></div>`, 'Accuracy', tab === 'accuracy');
  d.querySelectorAll('[data-acctab]').forEach(b => b.onclick = () => openAccuracy(b.dataset.acctab));
  const body = $('accBody');
  try {
    if (tab === 'accuracy') {
      const snap = await X.getDoc(X.doc(X.db, 'system_stats', 'accuracy_v2'));
      if (!snap.exists()) { body.innerHTML = '<p class="muted">No accuracy figures yet.</p>'; return; }
      const a = snap.data(); let curves = null;
      if (a.curveStoragePath) { try { curves = await (await fetch(await X.getDownloadURL(X.ref(X.storage, a.curveStoragePath)), { cache: 'no-store' })).json(); } catch (e) { } }
      const upd = a.lastUpdated?.toDate ? a.lastUpdated.toDate() : (a.lastUpdated ? new Date(a.lastUpdated) : null);
      const st = [0, 1, 2].map(i => binStats(curves?.[`day${i}`])), s0 = st[0];
      const pct = (v) => v == null || !Number.isFinite(v) ? '–' : Math.round(v * 100) + '%';
      body.innerHTML = `<div class="rowbetween"><p class="lead">AUTO-HOCO checked against real lightning, all verified runs${upd && !isNaN(upd) ? ` · updated ${X.dayDate(upd)}` : ''}</p>${X.S.role === 'developer' ? '<button class="btn sm" id="accRecalc">↻ Recalculate · dev</button>' : ''}</div>
        <div class="acc-grid">
          <div class="acc-card"><span class="kicker">Lightning inside a 10%+ area</span><div class="acc-big">${pct(s0?.pod)}</div><small>Day 0</small></div>
          <div class="acc-card"><span class="kicker">10%+ areas that stayed dry</span><div class="acc-big">${pct(s0?.far)}</div><small>false alarms, Day 0. Lightning is rare, so many areas stay dry.</small></div>
          ${s0?.bss != null && s0.bss > 0 ? `<div class="acc-card"><span class="kicker">Better than climatology</span><div class="acc-big">+${Math.round(s0.bss * 100)}%</div><small>Brier skill, Day 0 (approximate)</small></div>`
            : `<div class="acc-card"><span class="kicker">Ranking skill</span><div class="acc-big">${f2(a.day0?.auc)}</div><small>AUC, Day 0. 1.0 is perfect, 0.5 is a coin toss. HOCO's percentages run high against this check, so Brier skill is not shown.</small></div>`}</div>
        <div class="setgrp"><span class="kicker">Lightning caught, by day</span><div class="caught">${[0, 1, 2].map(i => `<div><b>${pct(st[i]?.pod)}</b><small>Day ${i}</small><span class="cbar"><i style="width:${(st[i]?.pod || 0) * 100}%"></i></span><small class="muted">AUC ${f2(a[`day${i}`]?.auc)}</small></div>`).join('')}</div></div>
        <div class="acc-2col">
          ${curves?.day0?.reliabilityForecast ? `<div class="setgrp"><span class="kicker">Are the percentages honest?</span>${relChart(curves.day0.reliabilityForecast, curves.day0.reliabilityObserved, curves.day0.reliabilityCount)}<small class="muted">Closer to the dashed line is better. Below it, HOCO's chances were too high.</small></div>` : ''}
          ${s0 ? `<div class="setgrp"><span class="kicker">Chance of lightning by risk band</span>${bandBars(s0.bins)}</div>` : ''}</div>
        <div class="setgrp"><div class="rowbetween"><span class="kicker">Recent days · ${esc(X.S.region)}</span>${seg('accn', 7, [[7, '7 days'], [14, '14 days']])}</div>
          <table class="acctable"><thead><tr><th>Day</th><th>Peak</th><th>Lightning?</th><th>Result</th></tr></thead><tbody id="accRows"><tr><td colspan="4" class="muted">Checking recent days…</td></tr></tbody></table>
          <small class="muted">Peak of the last Day 0 run for each day, against observed strikes in the region (5+ strikes counts as lightning).</small></div>
        <div class="adslot hidden" data-ad="accuracy"></div>`;
      renderAds();
      $('accRecalc') && ($('accRecalc').onclick = async (ev) => { const b = ev.currentTarget; b.disabled = true; b.textContent = 'Calculating…';
        try { await X.callable('calculateAutoAccuracy')(); X.toast('Accuracy recalculated'); openAccuracy('accuracy'); } catch (e) { X.toast('Recalculation failed'); b.disabled = false; b.textContent = '↻ Recalculate · dev'; } });
      let job = 0;
      const fill = async (n) => { const me = ++job, rows = $('accRows'); if (!rows) return; rows.innerHTML = `<tr><td colspan="4" class="muted"><span class="spin"></span> Checking ${n} days…</td></tr>`;
        const list = await recentDays(n); if (me !== job || !$('accRows')) return;
        $('accRows').innerHTML = list.map(r => { const [v, c] = verdict(r.peak, r.lightning); return `<tr><td>${X.dayDate(r.day)}</td><td>${r.peak == null ? '–' : r.peak < 5 ? '<5%' : Math.round(r.peak) + '%'}</td><td>${r.lightning == null ? '–' : r.lightning >= 5 ? `Yes · ${r.lightning}` : 'No'}</td><td><span class="verdict ${c}">${v}</span></td></tr>`; }).join(''); };
      d.querySelectorAll('[data-accn]').forEach(b => b.onclick = () => { d.querySelectorAll('[data-accn]').forEach(x => x.setAttribute('aria-pressed', x === b)); fill(+b.dataset.accn); });
      fill(7);
    } else {
      const [ml, ai] = await Promise.all([X.getDoc(X.doc(X.db, 'system_stats', 'hoco_ml')), X.getDoc(X.doc(X.db, 'system_stats', 'ai_hoco'))]);
      const m = ml.exists() ? ml.data() : null, s = ai.exists() ? ai.data() : null, status = s?.status || 'training';
      const checks = m?.readiness?.checks || [], passed = checks.filter(c => c.ok).length, ready = checks.length > 0 && passed === checks.length;
      const trained = m?.trainedAt ? new Date(m.trainedAt) : null;
      const chip = status === 'published' ? '<span class="tag live">Live</span>' : status === 'paused' ? '<span class="tag arch">Paused</span>' : '<span class="tag beta">Training</span>';
      const row = (b, i) => { const e = status === 'published' ? s.model?.[b] : m?.candidate?.[b], vt = e?.vsTraditional, gain = vt ? 1 - vt.model.brier / vt.traditional.brier : NaN;
        return `<tr><td>Day ${i}</td><td>${e ? ({ context: 'Setup model', weights: 'Learned weights', calibration: 'Calibrated' }[e.kind] || 'Learned') : '–'}</td><td><b class="${gain >= 0 ? 'good' : 'bad'}">${Number.isFinite(gain) ? `${gain >= 0 ? '+' : ''}${(gain * 100).toFixed(1)}%` : '–'}</b></td><td>${vt ? `${f2(vt.model.auc)} vs ${f2(vt.traditional.auc)}` : '–'}</td></tr>`; };
      body.innerHTML = `<div class="rowbetween"><p class="lead">${status === 'published' ? `Live${s.version ? ` · v${esc(s.version)}` : ''}` : status === 'paused' ? 'Paused. Traditional is unaffected.' : 'Learning from verified lightning'}${trained && !isNaN(trained) ? ` · last trained ${X.dayDate(trained)}, ${X.hhmm(trained)}` : ''}${m?.data?.featureRuns ? ` · ${m.data.featureRuns} runs with per-model data` : ''}</p>${chip}</div>
        <table class="acctable"><thead><tr><th>Day</th><th>Lab picked</th><th>Brier vs Trad</th><th>AUC</th></tr></thead><tbody>${['day0', 'day1', 'day2'].map(row).join('')}</tbody></table>
        ${checks.length ? `<div class="setgrp"><span class="kicker">Launch checklist · ${passed} of ${checks.length}</span>${checks.map(c => `<div class="check ${c.ok ? 'ok' : ''}"><i>${c.ok ? '✓' : ''}</i><span>${esc(c.label)}<small>${esc(c.detail || '')}</small></span></div>`).join('')}</div>` : ''}
        ${X.S.role === 'developer' ? `<div class="chips" style="justify-content:flex-end"><a class="btn" href="ai-lab.html" target="_blank" rel="noopener">Open the Lab ↗</a><button class="btn primary" id="aiPublish" ${status === 'published' ? 'disabled' : ''}>${status === 'published' ? 'Published' : ready ? 'Publish AI HOCO' : 'Publish AI HOCO (checks not passed)'}</button></div>
          <small class="muted">Model weights stay in the Lab and are only shown to developers.</small>` : '<small class="muted">AI HOCO runs next to Traditional HOCO. Traditional keeps its own hand-tuned weights.</small>'}`;
      $('aiPublish') && ($('aiPublish').onclick = async (ev) => {
        if (!ready) { const w = prompt('Not every launch check has passed. AI HOCO may be worse than Traditional HOCO.\n\nType PUBLISH to publish anyway:'); if (w !== 'PUBLISH') return; }
        else if (!confirm('Publish AI HOCO? AI runs will appear alongside Traditional HOCO from the next AUTO cycle.')) return;
        const b = ev.currentTarget; b.disabled = true; b.textContent = 'Publishing…';
        try { const r = await X.callable('aiHocoAdmin')({ action: 'publish', force: !ready }); X.toast(r.data?.message || 'AI HOCO published'); openAccuracy('ai'); }
        catch (e) { X.toast(e.message || 'Publishing failed'); b.disabled = false; b.textContent = 'Publish AI HOCO'; } });
    }
  } catch (e) { console.error(e); body.innerHTML = '<p class="muted">Could not load this right now. Try again in a moment.</p>'; }
}

// ------------------------------------------------------------------ upgrade request + API access
export async function openUpgrade() {
  const role = X.S.role, label = { normal: 'Normal · 7 runs a day', guest: 'Guest', external_developer: 'External developer', exclusive: 'Exclusive', developer: 'Developer' }[role] || role;
  let pick = 'exclusive', last = null;
  const d = dialog(`<div class="rowbetween"><h2>Apply for an upgrade</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
    <div class="note slim"><span class="muted">Your account</span><b style="margin-left:auto">${esc(label)}</b></div>
    <div class="alist">
      <button class="arow" data-up="exclusive" aria-pressed="true"><span><b>Upgrade to Exclusive</b><small>Custom scenarios and weights, 15 runs a day, no ads</small></span></button>
      <button class="arow" data-up="external_developer" aria-pressed="false"><span><b>External developer</b><small>API access and GeoJSON downloads for your own apps</small></span></button></div>
    <label class="field"><span class="kicker">Social link or handle</span><input id="upSocial" placeholder="e.g. @yourname or a link to your page"></label>
    <label class="field"><span class="kicker">Why do you need it?</span><textarea id="upReason" rows="3" placeholder="e.g. I post storm outlooks for my local weather page and want to test my own model weights."></textarea></label>
    <div class="chips" style="justify-content:flex-end"><button class="btn" data-x>Cancel</button><button class="btn primary" id="upSend">Send request</button></div>
    <small class="muted" id="upStatus">A developer reviews requests, usually within a few days. You'll see the answer here.</small>`, 'Upgrade');
  d.querySelectorAll('[data-up]').forEach(b => b.onclick = () => { pick = b.dataset.up; d.querySelectorAll('[data-up]').forEach(x => x.setAttribute('aria-pressed', x === b)); });
  const uid = X.auth.currentUser?.uid; if (!uid) return;
  try { const snap = await X.getDocs(X.query(X.collection(X.db, 'role_requests'), X.where('userId', '==', uid))); snap.forEach(x => { const r = x.data(); const t = r.createdAt?.toDate ? r.createdAt.toDate() : new Date(r.createdAt); if (!last || t > last.t) last = { ...r, t }; }); } catch (e) { }
  if (last && $('upStatus')) $('upStatus').innerHTML = `Your last request (${esc(last.requestedRole)}, ${X.dayDate(last.t)}): <b>${{ pending: 'waiting for review', approved: 'approved', rejected: 'declined' }[last.status] || esc(last.status)}</b>.`;
  $('upSend').onclick = async () => {
    const social = $('upSocial').value.trim(), reason = $('upReason').value.trim();
    if (!social || !reason) return X.toast('Fill in both boxes');
    try { await X.addDoc(X.collection(X.db, 'role_requests'), { userId: uid, email: X.auth.currentUser.email, requestedRole: pick, social, reason, status: 'pending', createdAt: new Date() });
      X.toast('Request sent'); $('upStatus').innerHTML = 'Request sent: <b>waiting for review</b>.'; $('upSocial').value = ''; $('upReason').value = ''; } catch (e) { X.toast('Could not send the request'); }
  };
}
export function openApi() {
  dialog(`<div class="rowbetween"><h2>API access</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
    <div class="note slim"><span class="tag live" style="margin:0">Public</span><span>No personal key. Public AUTO-HOCO runs are read straight from the HOCO database with the shared web key in the guide.</span></div>
    <div class="setgrp"><span class="kicker">1 · Find the latest runs (catalogue)</span><code class="apiline"><b>POST</b> firestore …/documents:runQuery?key=&lt;web key&gt;</code></div>
    <div class="setgrp"><span class="kicker">2 · Download a run as GeoJSON</span><code class="apiline"><b>GET</b> firebasestorage …/o/&lt;run file&gt;?alt=media&amp;token=&lt;downloadToken&gt;</code></div>
    <p class="lead">The guide has ready-made JavaScript and Python code and the list of supported regions.</p>
    <div class="chips" style="justify-content:flex-end"><a class="btn primary" href="developers.html" target="_blank" rel="noopener">Open the API guide ↗</a></div>`, 'API access');
}

// ------------------------------------------------------------------ Europe region map
const REGION_TAG = { Live: ['#1f9d70', 'Live'], Beta: ['#6c47ff', 'Beta'], Archive: ['#8a94a6', 'Archive only'] };
export function openEurope() {
  const d = dialog(`<div class="rowbetween"><h2>Choose a region</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
    <p class="lead">Tap a box on the map, or pick from the list.</p>
    <div class="eu-wrap"><div id="euMap" class="eu-map"></div><div class="eu-list">${X.REGIONS.map(r => { const t = REGION_TAG[r.tag], off = r.west === undefined;
      return `<button class="arow" data-eu="${r.id}" ${off ? 'disabled' : ''} aria-pressed="${r.id === X.S.region}"><span><b>${esc(r.name)}</b><small>${off ? 'Coming soon' : t ? t[1] : esc(r.tag)}</small></span><i class="eu-dot" style="background:${t ? t[0] : 'transparent'};border-color:${t ? t[0] : 'var(--muted)'}"></i></button>`; }).join('')}</div></div>`, 'Europe map', true);
  const feats = X.REGIONS.filter(r => r.west !== undefined).map(r => ({ type: 'Feature', properties: { id: r.id, name: r.name, col: (REGION_TAG[r.tag] || ['#8a94a6'])[0], on: r.id === X.S.region ? 1 : 0 },
    geometry: { type: 'Polygon', coordinates: [[[r.west, r.south], [r.east, r.south], [r.east, r.north], [r.west, r.north], [r.west, r.south]]] } }));
  const m = new mapboxgl.Map({ container: 'euMap', style: X.styleUrl(), center: [8, 52], zoom: 2.9, attributionControl: false, logoPosition: 'bottom-left', projection: 'mercator' });
  m.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-left');
  const close = () => { d.classList.add('hidden'); try { m.remove(); } catch (e) { } };
  const pickR = (id) => { close(); X.setRegion(id); };
  d.querySelectorAll('[data-eu]').forEach(b => b.onclick = () => pickR(b.dataset.eu));
  d.querySelectorAll('[data-x]').forEach(b => b.onclick = close);
  m.on('load', () => {
    m.addSource('regions', { type: 'geojson', data: { type: 'FeatureCollection', features: feats } });
    m.addLayer({ id: 'reg-fill', type: 'fill', source: 'regions', paint: { 'fill-color': ['get', 'col'], 'fill-opacity': ['case', ['==', ['get', 'on'], 1], 0.35, 0.16] } });
    m.addLayer({ id: 'reg-line', type: 'line', source: 'regions', paint: { 'line-color': ['get', 'col'], 'line-width': ['case', ['==', ['get', 'on'], 1], 3, 1.5] } });
    try { const b = new mapboxgl.LngLatBounds(); feats.forEach(f => f.geometry.coordinates[0].forEach(c => b.extend(c))); m.fitBounds(b, { padding: 20, duration: 0 }); } catch (e) { }
    m.on('click', 'reg-fill', (e) => { const f = e.features?.[0]; if (f) pickR(f.properties.id); });
    m.on('mouseenter', 'reg-fill', () => { m.getCanvas().style.cursor = 'pointer'; }); m.on('mouseleave', 'reg-fill', () => { m.getCanvas().style.cursor = ''; });
  });
}

// ------------------------------------------------------------------ install as an app (+ banner)
let installEvt = null;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !matchMedia('(display-mode: standalone)').matches;
export const canInstall = () => !!installEvt || isIos();
export async function install() {
  if (installEvt) { installEvt.prompt(); const r = await installEvt.userChoice; installEvt = null; $('installBar')?.classList.add('hidden'); if (r.outcome === 'accepted') X.toast('HOCO installed'); return; }
  dialog(`<div class="rowbetween"><h2>Add HOCO to your home screen</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
    <ol class="steps"><li>Tap the <b>Share</b> button in Safari (the square with an arrow).</li><li>Scroll down and tap <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>. HOCO opens full screen like an app and can send storm alerts.</li></ol>`, 'Install');
}
export function installBanner() {
  if (X.embed || matchMedia('(display-mode: standalone)').matches) return;
  try { if (localStorage.getItem('hocoInstallDismissed')) return; } catch (e) { }
  if (!canInstall()) return;
  const b = $('installBar'); if (!b) return; b.classList.remove('hidden');
  b.innerHTML = `<img src="icons/icon-192.png" alt=""><span><b>Add HOCO to your home screen</b><small>Opens like an app and can send storm alerts</small></span><button class="btn primary sm" id="ibGo">Install</button><button class="btn icon sm" id="ibX" aria-label="Not now">✕</button>`;
  $('ibGo').onclick = install; $('ibX').onclick = () => { b.classList.add('hidden'); try { localStorage.setItem('hocoInstallDismissed', '1'); } catch (e) { } };
}

// ------------------------------------------------------------------ tutorial (coach marks)
const STEPS = [
  ['#dayTabs', 'Pick a day', 'Day 0 is today and tonight, Day 1 is tomorrow, Day 2 the day after. Each shows its highest chance.'],
  ['.runrow', 'The slider picks a run, not a time', 'HOCO issues a new run about every hour. Each run is one map for the whole period. Drag to see an earlier run; "All runs" lists them with their peaks.'],
  ['#summary', 'The headline', 'The highest chance of lightning within 20 km, where it is, and what changed since the last run.'],
  ['#layersBtn', 'Radar and lightning', 'Turn on rain radar and lightning strikes, then play them back through the forecast period up to now.'],
];
export function startTutorial(force) {
  if (!force) { try { if (localStorage.getItem('hocoTutorial')) return; } catch (e) { return; } }
  let i = 0; const ov = $('coach');
  const end = () => { ov.classList.add('hidden'); ov.innerHTML = ''; try { localStorage.setItem('hocoTutorial', '1'); } catch (e) { } };
  const show = () => {
    const [sel, title, text] = STEPS[i];
    const el = [...document.querySelectorAll(sel)].find(e => e.offsetParent !== null && e.getBoundingClientRect().width > 0);
    if (!el) { if (++i < STEPS.length) return show(); return end(); }
    const r = el.getBoundingClientRect(), pd = 6;
    ov.classList.remove('hidden');
    ov.innerHTML = `<div class="coach-hole" style="left:${r.left - pd}px;top:${r.top - pd}px;width:${r.width + pd * 2}px;height:${r.height + pd * 2}px"></div>
      <div class="coach-card card" role="dialog" aria-live="polite"><span class="kicker">Quick tutorial · step ${i + 1} of ${STEPS.length}</span><b>${title}</b><p>${text}</p>
      <div class="rowbetween"><button class="linkbtn" data-skip>Skip</button><button class="btn primary sm" data-next>${i === STEPS.length - 1 ? 'Done' : 'Next'}</button></div></div>`;
    const card = ov.querySelector('.coach-card'), cw = Math.min(320, innerWidth - 20);
    card.style.width = cw + 'px';
    const below = r.bottom + 12 + 180 < innerHeight;
    card.style.top = (below ? r.bottom + 12 : Math.max(10, r.top - 12 - card.offsetHeight)) + 'px';
    card.style.left = Math.max(10, Math.min(innerWidth - cw - 10, r.left + r.width / 2 - cw / 2)) + 'px';
    ov.querySelector('[data-next]').onclick = () => { if (++i < STEPS.length) show(); else end(); };
    ov.querySelector('[data-skip]').onclick = end;
  };
  setTimeout(show, 400);
}

// ------------------------------------------------------------------ embed code
export function openEmbed() {
  const base = location.origin + location.pathname;
  let size = '300x250', prod = X.S.timing ? 'timing' : 'traditional';
  const source = X.S.timing ? new URL(location.href) : null;
  const d = dialog(`<div class="rowbetween"><h2>Embed HOCO on your site</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
    <div class="embprev"><div class="embbox" id="emBox"><span class="tag live" style="margin:0">Live</span><b id="emTitle">HOCO · ${esc(X.S.region)} · Day 0</b><small>handry-outlook.github.io/HOCO-V2.0</small></div></div>
    <div class="setgrp"><span class="kicker">Size</span>${seg('emsize', size, [['300x250', '300 × 250'], ['600x300', '600 × 300'], ['full', 'Full width']])}</div>
    <div class="setgrp"><span class="kicker">Show</span>${seg('emprod', prod, [['traditional', 'Traditional'], ['ai', 'AI HOCO'], ['timing', 'Hourcast']])}</div>
    <div class="grid2"><label class="field"><span class="kicker">Region</span><select id="emRegion">${X.REGIONS.filter(r => r.west !== undefined).map(r => `<option value="${r.id}" ${r.id === X.S.region ? 'selected' : ''}>${r.name}</option>`).join('')}</select></label>
      <label class="field"><span class="kicker">Day</span><select id="emDay"><option value="0">Day 0 (today)</option><option value="1">Day 1</option><option value="2">Day 2</option></select></label>
      <label class="field"><span class="kicker">Theme</span><select id="emTheme"><option value="auto">Follow visitor's device</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <label class="field"><span class="kicker">Extras</span><select id="emLayers"><option value="">Forecast only</option><option value="strikes">+ lightning strikes</option><option value="radar,strikes">+ radar and strikes</option></select></label></div>
    <label class="sr" for="emCode">Embed code</label><textarea id="emCode" rows="4" readonly class="code"></textarea>
    <div class="rowbetween"><small class="muted" id="emNote">The widget updates itself with every new run.</small><span class="chips"><a class="btn" id="emOpen" target="_blank" rel="noopener">Preview</a><button class="btn primary" id="emCopy">Copy code</button></span></div>`, 'Embed');
  if (source) $('emDay').value = String(X.S.day);
  const upd = () => {
    const region = $('emRegion');
    for (const item of region.options) item.disabled = prod === 'timing' && !['England', 'Scotland'].includes(item.value);
    if (region.selectedOptions[0]?.disabled) region.value = 'England';
    const u = new URL(base); u.searchParams.set('embed', '1'); u.searchParams.set('region', $('emRegion').value); u.searchParams.set('day', $('emDay').value);
    if (prod === 'ai') u.searchParams.set('view', 'ai');
    if (prod === 'timing') {
      u.searchParams.set('view', 'timing');
      if (source && ['region', 'day'].every(key => source.searchParams.get(key) === u.searchParams.get(key))) {
        for (const key of ['run', 'window']) if (source.searchParams.has(key)) u.searchParams.set(key, source.searchParams.get(key));
      }
    }
    if ($('emTheme').value !== 'auto') u.searchParams.set('theme', $('emTheme').value);
    if ($('emLayers').value) u.searchParams.set('layers', $('emLayers').value);
    const [w, h] = size === 'full' ? ['100%', '520'] : size.split('x');
    $('emCode').value = `<iframe src="${u.href}" width="${w}" height="${h}" style="border:0;border-radius:12px" loading="lazy" title="HOCO thunderstorm outlook · ${$('emRegion').value}"></iframe>`;
    $('emNote').textContent = u.searchParams.has('window') ? 'The widget opens the selected forecast run and window.' : 'The widget updates itself with every new run.';
    $('emOpen').href = u.href; $('emTitle').textContent = `HOCO · ${$('emRegion').value} · Day ${$('emDay').value}${prod === 'timing' ? ' · Hourcast' : prod === 'ai' ? ' · AI' : ''}`;
    const box = $('emBox'); box.style.width = size === 'full' ? '100%' : `${Math.min(+w, 460)}px`; box.style.aspectRatio = size === 'full' ? '16/7' : `${w}/${h}`;
  };
  d.querySelectorAll('[data-emsize]').forEach(b => b.onclick = () => { size = b.dataset.emsize; d.querySelectorAll('[data-emsize]').forEach(x => x.setAttribute('aria-pressed', x === b)); upd(); });
  d.querySelectorAll('[data-emprod]').forEach(b => b.onclick = () => { prod = b.dataset.emprod; d.querySelectorAll('[data-emprod]').forEach(x => x.setAttribute('aria-pressed', x === b)); upd(); });
  d.querySelectorAll('select').forEach(s => s.onchange = upd); upd();
  $('emCopy').onclick = async () => { try { await navigator.clipboard.writeText($('emCode').value); X.toast('Embed code copied'); } catch (e) { $('emCode').select(); X.toast('Press Ctrl+C to copy'); } };
}

// ------------------------------------------------------------------ ad spaces
// Never on top of the map: Tools › Runs (300×100), end of the Accuracy page (728×90 laptop, banner on iPad, 320×50 phone),
// bottom of the pulled-up phone sheet (320×50). Hidden for Exclusive accounts. Off until an AdSense account is added here.
// Map ads: Google's own anchor ad (turned on in AdSense › Auto ads), never a box of ours on top of the map; the layout moves up out of its way.
// Spots below only show once their ad-unit slot ID is filled in (AdSense › Ads › By ad unit › Display ads).
export const ADS = { enabled: true, client: 'ca-pub-6850588636991409', slots: { runs: '9397566061', accuracy: '6266463706', sheet: '1836264105' } };
let adScript = false;
function loadAdScript(consent) {
  if (adScript) return; adScript = true;
  window.adsbygoogle = window.adsbygoogle || []; if (!consent?.ads) window.adsbygoogle.requestNonPersonalizedAds = 1;
  const s = document.createElement('script'); s.async = true; s.dataset.ads = '1'; s.crossOrigin = 'anonymous'; s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADS.client}`; document.head.appendChild(s);
  watchAnchor();
}
// keep the time bar, buttons and top bar clear of Google's anchor ad (top or bottom of the screen)
function watchAnchor() {
  const fit = () => { let top = 0, bottom = 0;
    document.querySelectorAll('ins.adsbygoogle[data-anchor-status], .adsbygoogle-noablate[data-anchor-status]').forEach(a => {
      const st = a.getAttribute('data-anchor-status'); if (st === 'dismissed' || getComputedStyle(a).display === 'none') return;
      const r = a.getBoundingClientRect(); if (!r.height || r.width < 100) return;
      if (r.top < innerHeight / 2) top = Math.max(top, r.bottom); else bottom = Math.max(bottom, innerHeight - r.top); });
    const root = document.documentElement.style, t = top + 'px', b = bottom + 'px';
    if (root.getPropertyValue('--adt') !== t || root.getPropertyValue('--adb') !== b) { root.setProperty('--adt', t); root.setProperty('--adb', b); X.measureDock?.(); } };
  new MutationObserver(() => requestAnimationFrame(fit)).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-anchor-status'] });
  addEventListener('resize', fit); setInterval(fit, 3000);
}
const adLabel = (k) => k === 'runs' ? '300 × 100' : k === 'sheet' ? '320 × 50' : innerWidth <= 640 ? '320 × 50' : innerWidth <= 1100 ? '468 × 60' : '728 × 90';
export function renderAds() {
  let consent = null; try { consent = JSON.parse(localStorage.getItem('hocoConsent') || 'null'); } catch (e) { }
  const role = X.S.role, noAds = role === 'exclusive' || X.embed;
  document.querySelectorAll('[data-ad]').forEach(el => {
    if (noAds) { delete el.dataset.loaded; el.classList.add('hidden'); el.innerHTML = ''; return; }
    if (ADS.enabled && ADS.client && role !== 'developer') {
      loadAdScript(consent);
      if (!ADS.slots[el.dataset.ad]) { el.classList.add('hidden'); el.innerHTML = ''; return; }
      if (el.dataset.loaded) return; el.dataset.loaded = '1'; el.classList.remove('hidden', 'preview');
      el.innerHTML = `<small class="adlbl">Advertisement</small><ins class="adsbygoogle" style="display:block" data-ad-client="${ADS.client}" data-ad-slot="${ADS.slots[el.dataset.ad] || ''}" data-ad-format="auto" data-full-width-responsive="true"></ins>`;
      // fill the ad only once its spot is on screen (the summary details and Tools start closed)
      const fill = () => { try { window.adsbygoogle.push({}); } catch (e) { } };
      if (el.offsetWidth > 0) fill(); else { const ro = new ResizeObserver(() => { if (el.offsetWidth > 0) { ro.disconnect(); fill(); } }); ro.observe(el); }
    } else if (role === 'developer') { delete el.dataset.loaded; el.classList.remove('hidden'); el.classList.add('preview'); el.innerHTML = `<small class="adlbl">Advertisement</small><span>Ad space · ${adLabel(el.dataset.ad)}</span><small>${ADS.slots[el.dataset.ad] ? 'Live for normal users' : 'Needs an ad-unit slot ID'} · hidden for Exclusive accounts · developers see this preview</small>`; }
    else { el.classList.add('hidden'); el.innerHTML = ''; }
  });
}

// ------------------------------------------------------------------ init
export function initStage4(ctx) {
  X = ctx;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; installBanner(); });
  if ('serviceWorker' in navigator && !X.embed) navigator.serviceWorker.register('sw.js').catch(() => { });
  document.querySelectorAll('[data-compare]').forEach(b => b.onclick = () => openCompare(2));
  const verify = $('verifyBtn');
  verify.onclick = openRunVerification;
  verify.disabled = verify.dataset.ready !== 'true';
  addEventListener('keydown', (e) => {
    if ($('verResults') && !$('cookieDlg').classList.contains('hidden')) {
      if (e.key === 'Escape') $('cookieDlg').querySelector('[data-x]').click();
      return;
    }
    if (e.key === 'Escape' && comparing()) closeCompare();
    if (e.key.toLowerCase() === 'c' && !e.target.closest('input,textarea,select') && !e.metaKey && !e.ctrlKey) comparing() ? closeCompare() : openCompare(2); });
}
