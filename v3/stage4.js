// HOCO v3 stage 4: settings, compare maps, accuracy + AI HOCO status, alerts, install, tutorial, embed code, ad spaces.
let X;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');

// ------------------------------------------------------------------ settings
export const DEFAULTS = { mapStyle: 'standard', opacity: 1, radarOpacity: 0.85, region: '', changed: true, alerts: false, alertAt: 30 };
export function getSettings() { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('hocoSettings') || '{}') }; } catch (e) { return { ...DEFAULTS }; } }
function saveSettings(patch) { const s = { ...getSettings(), ...patch }; try { localStorage.setItem('hocoSettings', JSON.stringify(s)); } catch (e) { } X.applySettings(s, patch); return s; }

function dialog(html, label) {
  const d = $('cookieDlg');
  d.innerHTML = `<section class="dialog" role="dialog" aria-modal="true" aria-label="${esc(label)}">${html}</section>`;
  d.classList.remove('hidden');
  d.querySelectorAll('[data-x]').forEach(b => b.onclick = () => d.classList.add('hidden'));
  return d;
}
const seg = (name, cur, opts) => `<div class="seg wide" role="group">${opts.map(([v, l]) => `<button data-${name}="${v}" aria-pressed="${String(cur) === String(v)}">${l}</button>`).join('')}</div>`;

export function openSettings() {
  const s = getSettings(), place = (() => { try { return JSON.parse(localStorage.getItem('hocoPlace') || 'null'); } catch (e) { return null; } })();
  const d = dialog(`<div class="rowbetween"><h2>Settings</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
    <div class="setgrp"><span class="kicker">Theme</span>${seg('th', X.S.theme, [['auto', 'Follow device'], ['light', 'Light'], ['dark', 'Dark']])}</div>
    <div class="setgrp"><span class="kicker">Map style</span>${seg('style', s.mapStyle, [['standard', 'Standard'], ['satellite', 'Satellite'], ['outdoors', 'Outdoors']])}</div>
    <div class="setgrp"><div class="rowbetween"><span class="kicker">Forecast colour strength</span><output id="opOut">${Math.round(s.opacity * 100)}%</output></div>
      <input type="range" id="setOp" min="0.3" max="1.2" step="0.05" value="${s.opacity}" style="--pct:${(s.opacity - 0.3) / 0.9 * 100}%"></div>
    <div class="setgrp"><div class="rowbetween"><span class="kicker">Radar strength</span><output id="rOut">${Math.round(s.radarOpacity * 100)}%</output></div>
      <input type="range" id="setROp" min="0.3" max="1" step="0.05" value="${s.radarOpacity}" style="--pct:${(s.radarOpacity - 0.3) / 0.7 * 100}%"></div>
    <div class="setgrp"><span class="kicker">Start on</span><div class="grid2">
      <select id="setRegion"><option value="">Last region used</option>${X.REGIONS.filter(r => r.west !== undefined).map(r => `<option value="${r.id}" ${s.region === r.id ? 'selected' : ''}>${r.name}</option>`).join('')}</select>
      <select id="setProduct"><option value="traditional" ${X.S.product !== 'ai' ? 'selected' : ''}>Traditional</option><option value="ai" ${X.S.product === 'ai' ? 'selected' : ''}>AI HOCO</option></select></div></div>
    <label class="item layer"><span><b>Show what changed</b><small>A line under the peak comparing with the previous run.</small></span><input type="checkbox" class="switch" id="setChanged" ${s.changed ? 'checked' : ''}></label>
    <div class="setgrp alertbox"><label class="item layer" style="padding-left:0;padding-right:0"><span><b>Storm alerts</b><small>${place ? `Notify me when the chance near <b>${esc(place.name)}</b> reaches the level below.` : 'Search for a place first (magnifier at the top), then turn this on.'}</small></span>
      <input type="checkbox" class="switch" id="setAlerts" ${s.alerts && place ? 'checked' : ''} ${place ? '' : 'disabled'}></label>
      <div class="chips" id="alertLevels">${[20, 30, 50, 70].map(v => `<button class="chipbtn" data-lvl="${v}" aria-pressed="${s.alertAt === v}" ${place ? '' : 'disabled'}>${v}%+</button>`).join('')}</div>
      <small class="muted">Alerts work while HOCO is open in a tab or installed as an app. Alerts with the app fully closed need push notifications, which aren't set up yet.</small></div>`, 'Settings');
  d.querySelectorAll('[data-th]').forEach(b => b.onclick = () => { X.setTheme(b.dataset.th); d.querySelectorAll('[data-th]').forEach(x => x.setAttribute('aria-pressed', x === b)); });
  d.querySelectorAll('[data-style]').forEach(b => b.onclick = () => { saveSettings({ mapStyle: b.dataset.style }); d.querySelectorAll('[data-style]').forEach(x => x.setAttribute('aria-pressed', x === b)); });
  $('setOp').oninput = (e) => { const v = +e.target.value; e.target.style.setProperty('--pct', (v - 0.3) / 0.9 * 100 + '%'); $('opOut').textContent = Math.round(v * 100) + '%'; saveSettings({ opacity: v }); };
  $('setROp').oninput = (e) => { const v = +e.target.value; e.target.style.setProperty('--pct', (v - 0.3) / 0.7 * 100 + '%'); $('rOut').textContent = Math.round(v * 100) + '%'; saveSettings({ radarOpacity: v }); };
  $('setRegion').onchange = (e) => saveSettings({ region: e.target.value });
  $('setProduct').onchange = (e) => X.setProduct(e.target.value);
  $('setChanged').onchange = (e) => saveSettings({ changed: e.target.checked });
  $('setAlerts').onchange = async (e) => {
    if (e.target.checked && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (err) { } }
    if (e.target.checked && 'Notification' in window && Notification.permission === 'denied') X.toast('Notifications are blocked for this site, so alerts will show inside HOCO only');
    saveSettings({ alerts: e.target.checked });
  };
  d.querySelectorAll('[data-lvl]').forEach(b => b.onclick = () => { saveSettings({ alertAt: +b.dataset.lvl }); d.querySelectorAll('[data-lvl]').forEach(x => x.setAttribute('aria-pressed', x === b)); });
}

// ------------------------------------------------------------------ alerts (checked on every new run while the app is open)
export async function checkAlerts(latest) {
  const s = getSettings(); if (!s.alerts) return;
  let place; try { place = JSON.parse(localStorage.getItem('hocoPlace') || 'null'); } catch (e) { } if (!place) return;
  let done; try { done = JSON.parse(localStorage.getItem('hocoAlerted') || '[]'); } catch (e) { done = []; }
  for (const [day, run] of latest.entries()) {
    if (!run || done.includes(run.id)) continue;
    try {
      const g = await X.fetchGeo(run), r = X.riskAt(g, place.lon, place.lat);
      done.push(run.id);
      if (r >= s.alertAt) {
        const when = day === 0 ? 'today' : day === 1 ? 'tomorrow' : X.dayName(X.startOf(run));
        const msg = `${Math.round(r)}% chance of lightning near ${place.name} ${when}`;
        X.toast(`⚡ ${msg}`);
        if ('Notification' in window && Notification.permission === 'granted') {
          try { const n = new Notification('HOCO storm alert', { body: msg, icon: 'icons/icon-192.png', tag: `hoco-${run.id}` }); n.onclick = () => { focus(); X.goDay(day); }; } catch (e) { }
        }
      }
    } catch (e) { /* try again on the next run */ }
  }
  try { localStorage.setItem('hocoAlerted', JSON.stringify(done.slice(-60))); } catch (e) { }
}

// ------------------------------------------------------------------ compare maps (2 or 4)
const C = { n: 2, maps: [], sel: [], link: true, syncing: false };
function paneOptions() {
  const out = [];
  for (const type of ['automated', 'ai']) for (let d = 0; d < 3; d++) {
    const runs = X.runsFor(d, type);
    runs.slice().reverse().forEach((r, i) => out.push({ id: r.id, run: r, label: `Day ${d} · ${type === 'ai' ? 'AI HOCO' : 'Traditional'} · ${X.hhmm(X.created(r))}${i === 0 ? ' (latest)' : ''}`, group: `Day ${d} · ${type === 'ai' ? 'AI HOCO' : 'Traditional'}` }));
  }
  return out;
}
function defaultSel(n, opts) {
  const latest = (d, t) => X.runsFor(d, t).at(-1)?.id, prev = (d, t) => X.runsFor(d, t).at(-2)?.id;
  const want = n === 2 ? [latest(X.S.day, 'automated'), latest(X.S.day, 'ai') || prev(X.S.day, 'automated')]
    : [latest(0, 'automated'), latest(1, 'automated'), latest(2, 'automated'), latest(0, 'ai') || prev(0, 'automated')];
  return want.map((id, i) => id || opts[i]?.id || opts[0]?.id);
}
export function openCompare(n = 2) {
  const opts = paneOptions(); if (!opts.length) return X.toast('No runs to compare yet');
  C.n = n; if (C.sel.length !== n || C.sel.some(id => !opts.some(o => o.id === id))) C.sel = defaultSel(n, opts);
  document.body.classList.add('comparing');
  const el = $('compare'); el.classList.remove('hidden'); el.dataset.n = n;
  const groups = [...new Set(opts.map(o => o.group))];
  el.innerHTML = `<div class="cmp-grid">${C.sel.map((id, i) => `<div class="cmp-pane"><div class="cmp-map" id="cmpMap${i}"></div>
      <div class="cmp-head card"><label class="sr" for="cmpSel${i}">Run for map ${i + 1}</label><select id="cmpSel${i}" data-i="${i}">${groups.map(g => `<optgroup label="${g}">${opts.filter(o => o.group === g).map(o => `<option value="${o.id}" ${o.id === id ? 'selected' : ''}>${o.label.replace(' · Traditional', '').replace(' · AI HOCO', ' · AI')}</option>`).join('')}</optgroup>`).join('')}</select>
      <div class="cmp-peak" id="cmpPeak${i}">–</div></div></div>`).join('')}</div>
    <div class="cmp-bar card"><b>Compare</b>${seg('cmpn', n, [[2, '2 maps'], [4, '4 maps']])}
      <label class="chk"><input type="checkbox" id="cmpLink" ${C.link ? 'checked' : ''}><span>Move maps together</span></label>
      <span class="cmp-key">${X.BANDS.map(b => `<i style="background:${b.fill}"></i>`).join('')}<small>5% → 90%+</small></span>
      <button class="btn primary" id="cmpClose">Done</button></div>`;
  C.maps.forEach(m => m.remove()); C.maps = [];
  const main = X.map, center = main.getCenter(), zoom = main.getZoom() - (n === 4 ? 0.7 : 0.3);
  C.sel.forEach((id, i) => {
    const m = new mapboxgl.Map({ container: `cmpMap${i}`, style: X.styleUrl(), center, zoom, attributionControl: false, logoPosition: 'bottom-left', projection: 'mercator' });
    if (i === 0) m.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-left');
    m.on('style.load', () => { addPaneLayers(m); loadPane(i); });
    m.on('move', () => { if (!C.link || C.syncing) return; C.syncing = true; C.maps.forEach(o => { if (o !== m) o.jumpTo({ center: m.getCenter(), zoom: m.getZoom() }); }); C.syncing = false; });
    m.on('mousemove', (e) => paneProbe(i, e));
    m.on('mouseleave', () => C.maps.forEach((_, j) => { const el = $(`cmpPeak${j}`); if (el) { el.dataset.hover = ''; renderPeak(j); } }));
    C.maps.push(m);
  });
  el.querySelectorAll('select[data-i]').forEach(s => s.onchange = () => { C.sel[+s.dataset.i] = s.value; loadPane(+s.dataset.i); });
  el.querySelectorAll('[data-cmpn]').forEach(b => b.onclick = () => openCompare(+b.dataset.cmpn));
  $('cmpLink').onchange = (e) => { C.link = e.target.checked; };
  $('cmpClose').onclick = closeCompare;
}
export function closeCompare() { C.maps.forEach(m => m.remove()); C.maps = []; $('compare').classList.add('hidden'); $('compare').innerHTML = ''; document.body.classList.remove('comparing'); X.map.resize(); }
function addPaneLayers(m) {
  if (m.getSource('hoco')) return;
  const label = m.getStyle().layers.find(l => l.type === 'symbol' && l.layout && l.layout['text-field'])?.id;
  m.addSource('hoco', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  m.addLayer({ id: 'hoco-fill', type: 'fill', source: 'hoco', filter: ['==', ['get', 'feature_type'], 'polygon'], paint: { 'fill-color': ['coalesce', ['get', 'fill'], X.colorExpr()], 'fill-opacity': 0.7 } }, label);
  m.addLayer({ id: 'hoco-line', type: 'line', source: 'hoco', filter: ['==', ['get', 'feature_type'], 'polygon'], paint: { 'line-color': 'rgba(16,34,56,0.5)', 'line-width': 0.6 } }, label);
}
const paneGeo = [];
async function loadPane(i) {
  const m = C.maps[i], id = C.sel[i], opt = paneOptions().find(o => o.id === id); if (!m || !opt) return;
  $(`cmpPeak${i}`).textContent = 'Loading…';
  try {
    const g = await X.fetchGeo(opt.run); paneGeo[i] = g;
    if (!m.getSource('hoco')) addPaneLayers(m);
    m.getSource('hoco').setData(g);
    m.setPaintProperty('hoco-fill', 'fill-opacity', (g?.properties?.hoco_layout === 'bands_v2' ? 0.7 : 0.32) * getSettings().opacity);
    renderPeak(i);
  } catch (e) { $(`cmpPeak${i}`).textContent = 'Could not load this run'; }
}
function renderPeak(i) {
  const el = $(`cmpPeak${i}`), g = paneGeo[i]; if (!el || !g) return;
  if (el.dataset.hover) { el.innerHTML = el.dataset.hover; return; }
  const pk = X.peakOf(g), opt = paneOptions().find(o => o.id === C.sel[i]), s = opt && X.startOf(opt.run), e = opt && X.endOf(opt.run);
  el.innerHTML = `<b>${pk.risk >= 5 ? Math.round(pk.risk) + '%' : '<5%'}</b> peak${pk.lat != null && pk.risk >= 5 ? ` near ${esc(X.nearestPlace(pk.lat, pk.lon))}` : ''}<small>${s ? `${X.dayName(s)} ${X.hhmm(s)} – ${X.dayName(e)} ${X.hhmm(e)}` : ''}</small>`;
}
function paneProbe(i, e) {
  const g = paneGeo[i], el = $(`cmpPeak${i}`); if (!g || !el) return;
  // show the value under the cursor on every map, so the same spot can be compared
  C.maps.forEach((_, j) => { const gj = paneGeo[j], ej = $(`cmpPeak${j}`); if (!gj || !ej) return; const rj = X.riskAt(gj, e.lngLat.lng, e.lngLat.lat);
    ej.dataset.hover = `<b>${rj >= 5 ? Math.round(rj) + '%' : '<5%'}</b> here<small>${j === i ? 'under your cursor' : 'same spot'}</small>`; renderPeak(j); });
}

// ------------------------------------------------------------------ accuracy + AI HOCO status
const fmt = (v, d = 2) => Number.isFinite(+v) ? (+v).toFixed(d) : '–';
function relChart(f, o, n) {
  if (!Array.isArray(f) || !f.length) return '';
  const W = 300, H = 200, P = 30, x = (v) => P + v * (W - P - 10), y = (v) => H - P - v * (H - P - 10);
  const pts = f.map((v, i) => [v, o[i], n?.[i] || 0]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[2] !== 0);
  return `<svg viewBox="0 0 ${W} ${H}" class="relchart" role="img" aria-label="Reliability: forecast chance against how often lightning happened">
    <line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" stroke="currentColor" stroke-opacity=".3" stroke-dasharray="4 4"/>
    <line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(0)}" stroke="currentColor" stroke-opacity=".4"/><line x1="${x(0)}" y1="${y(0)}" x2="${x(0)}" y2="${y(1)}" stroke="currentColor" stroke-opacity=".4"/>
    ${[0, 0.5, 1].map(t => `<text x="${x(t)}" y="${H - 10}" font-size="10" text-anchor="middle" fill="currentColor" opacity=".6">${t * 100}%</text><text x="${P - 6}" y="${y(t) + 3}" font-size="10" text-anchor="end" fill="currentColor" opacity=".6">${t * 100}%</text>`).join('')}
    <polyline fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" points="${pts.map(p => `${x(p[0])},${y(p[1])}`).join(' ')}"/>
    ${pts.map(p => `<circle cx="${x(p[0])}" cy="${y(p[1])}" r="3.5" fill="var(--accent)"/>`).join('')}
    <text x="${W / 2}" y="${H}" font-size="10" text-anchor="middle" fill="currentColor" opacity=".6">HOCO said</text></svg>`;
}
export async function openAccuracy(tab = 'accuracy') {
  const d = dialog(`<div class="rowbetween"><h2>How good is HOCO?</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
    ${seg('acctab', tab, [['accuracy', 'Accuracy'], ['ai', 'AI HOCO status']])}<div id="accBody" class="accbody"><div class="muted center"><span class="spin"></span> Loading…</div></div>`, 'Accuracy');
  d.querySelectorAll('[data-acctab]').forEach(b => b.onclick = () => openAccuracy(b.dataset.acctab));
  const body = $('accBody');
  try {
    if (tab === 'accuracy') {
      const snap = await X.getDoc(X.doc(X.db, 'system_stats', 'accuracy_v2'));
      if (!snap.exists()) { body.innerHTML = '<p class="muted">No accuracy figures yet.</p>'; return; }
      const a = snap.data(); let curves = null;
      if (a.curveStoragePath) { try { curves = await (await fetch(await X.getDownloadURL(X.ref(X.storage, a.curveStoragePath)), { cache: 'no-store' })).json(); } catch (e) { } }
      const upd = a.lastUpdated?.toDate ? a.lastUpdated.toDate() : (a.lastUpdated || a.timestamp ? new Date(a.lastUpdated || a.timestamp) : null);
      body.innerHTML = `<p class="lead">Checked against observed lightning for every AUTO-HOCO run. ${upd && !isNaN(upd) ? `Last updated ${X.dayDate(upd)}.` : ''}</p>
        <div class="acc-grid">${[0, 1, 2].map(i => { const x = a[`day${i}`] || {}; return `<div class="acc-card"><span class="kicker">Day ${i}</span>
          <div class="acc-big">${fmt(x.auc)}</div><small>AUC · 1.0 is perfect, 0.5 is a coin toss</small>
          <div class="acc-row"><span>Precision–recall</span><b>${fmt(x.prAuc)}</b></div><div class="acc-row"><span>Brier score</span><b>${fmt(x.brierScore, 3)}</b></div><div class="acc-row"><span>Grid points checked</span><b>${x.count || 0}</b></div></div>`; }).join('')}</div>
        ${curves?.day0?.reliabilityForecast ? `<div class="setgrp"><span class="kicker">When HOCO says a chance, how often does lightning happen? (Day 0)</span>${relChart(curves.day0.reliabilityForecast, curves.day0.reliabilityObserved, curves.day0.reliabilityCount)}
          <small class="muted">Points on the dashed line mean HOCO's chances match what happened. Below the line: HOCO was too high; above: too low.</small></div>` : ''}`;
    } else {
      const [ml, ai] = await Promise.all([X.getDoc(X.doc(X.db, 'system_stats', 'hoco_ml')), X.getDoc(X.doc(X.db, 'system_stats', 'ai_hoco'))]);
      const m = ml.exists() ? ml.data() : null, s = ai.exists() ? ai.data() : null, status = s?.status || 'training';
      const checks = m?.readiness?.checks || [], passed = checks.filter(c => c.ok).length;
      const pub = s?.publishedAt?.toDate ? s.publishedAt.toDate() : null;
      const head = status === 'published' ? `AI HOCO is <b>live</b>${s.version ? ` (v${esc(s.version)})` : ''}${pub ? `, published ${X.dayDate(pub)}` : ''}, and checked daily against fresh lightning. Traditional HOCO keeps its hand-tuned weights.`
        : status === 'paused' ? 'AI HOCO is <b>paused</b>. Traditional HOCO is unaffected.'
        : m ? `AI HOCO is <b>training</b>: ${passed} of ${checks.length} launch checks passed. It goes live alongside Traditional once a developer publishes it.` : 'AI HOCO is <b>collecting data</b> from every AUTO run so it can learn from verified lightning.';
      const stat = (e) => { const vt = e?.vsTraditional, gain = vt ? 1 - vt.model.brier / vt.traditional.brier : NaN;
        return `<div class="acc-row"><span>vs Traditional</span><b>${Number.isFinite(gain) ? `${gain >= 0 ? '+' : ''}${(gain * 100).toFixed(1)}%` : '–'}</b></div><div class="acc-row"><span>AUC</span><b>${vt?.model?.auc != null ? vt.model.auc.toFixed(2) : '–'}</b></div>
          <div class="acc-row"><span>Method</span><b>${e ? ({ context: 'Learned + context', weights: 'Learned', calibration: 'Calibrated' }[e.kind] || 'Learned') : 'Hand-tuned'}</b></div>`; };
      body.innerHTML = `<p class="lead">${head}</p>
        <div class="acc-grid">${['day0', 'day1', 'day2'].map((b, i) => { const e = status === 'published' ? s.model?.[b] : m?.candidate?.[b]; return `<div class="acc-card"><span class="kicker">Day ${i} · ${status === 'published' ? 'live' : 'candidate'}</span>${stat(e)}</div>`; }).join('')}</div>
        ${checks.length ? `<div class="setgrp"><span class="kicker">Launch checklist</span>${checks.map(c => `<div class="check ${c.ok ? 'ok' : ''}"><i>${c.ok ? '✓' : ''}</i><span>${esc(c.label)}<small>${esc(c.detail || '')}</small></span></div>`).join('')}</div>` : ''}
        ${X.S.role === 'developer' ? '<a class="btn" href="../ai-hoco-lab.html">Open the AI HOCO Lab</a>' : ''}`;
    }
  } catch (e) { console.error(e); body.innerHTML = '<p class="muted">Could not load this right now. Try again in a moment.</p>'; }
}

// ------------------------------------------------------------------ install as an app
let installEvt = null;
export const canInstall = () => !!installEvt || isIos();
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !matchMedia('(display-mode: standalone)').matches;
export async function install() {
  if (installEvt) { installEvt.prompt(); const r = await installEvt.userChoice; installEvt = null; if (r.outcome === 'accepted') X.toast('HOCO installed'); return; }
  dialog(`<div class="rowbetween"><h2>Add HOCO to your home screen</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
    <ol class="steps"><li>Tap the <b>Share</b> button in Safari (the square with an arrow).</li><li>Scroll down and tap <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>. HOCO opens full screen like an app.</li></ol>`, 'Install');
}

// ------------------------------------------------------------------ tutorial (coach marks)
const STEPS = [
  ['#summary, .dock-head', 'The headline', 'This is the highest chance of lightning within 20 km for the run you are looking at, and roughly where it is.'],
  ['#dayTabs', 'Pick a day', 'Day 0 is today, then tomorrow and the day after. The coloured pill is that day\'s peak chance.'],
  ['.runrow', 'The slider picks a run, not a time', 'HOCO issues a new run about every hour. Drag to see an earlier run of the same forecast. The map always shows the whole forecast period, not one moment.'],
  ['#layersBtn', 'Radar and lightning', 'Turn on rain radar and lightning strikes, then play them back through the forecast period up to now.'],
  ['#toolsBtn', 'Tools', 'Blend runs into an ensemble, start your own manual run, or browse past forecasts.'],
];
export function startTutorial(force) {
  if (!force) { try { if (localStorage.getItem('hocoTutorial')) return; } catch (e) { return; } }
  let i = 0; const ov = $('coach');
  const show = () => {
    const [sel, title, text] = STEPS[i];
    const el = [...document.querySelectorAll(sel)].find(e => e.offsetParent !== null && e.getBoundingClientRect().width > 0);
    if (!el) { if (++i < STEPS.length) return show(); return end(); }
    const r = el.getBoundingClientRect(), pad = 6;
    ov.classList.remove('hidden');
    ov.innerHTML = `<div class="coach-hole" style="left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px"></div>
      <div class="coach-card card" role="dialog" aria-live="polite"><span class="kicker">${i + 1} of ${STEPS.length}</span><b>${title}</b><p>${text}</p>
      <div class="rowbetween"><button class="linkbtn" data-skip>Skip</button><button class="btn primary sm" data-next>${i === STEPS.length - 1 ? 'Done' : 'Next'}</button></div></div>`;
    const card = ov.querySelector('.coach-card'), cw = Math.min(320, innerWidth - 20);
    card.style.width = cw + 'px';
    const below = r.bottom + 12 + 170 < innerHeight;
    card.style.top = (below ? r.bottom + 12 : Math.max(10, r.top - 12 - card.offsetHeight)) + 'px';
    card.style.left = Math.max(10, Math.min(innerWidth - cw - 10, r.left + r.width / 2 - cw / 2)) + 'px';
    ov.querySelector('[data-next]').onclick = () => { if (++i < STEPS.length) show(); else end(); };
    ov.querySelector('[data-skip]').onclick = end;
  };
  const end = () => { ov.classList.add('hidden'); ov.innerHTML = ''; try { localStorage.setItem('hocoTutorial', '1'); } catch (e) { } };
  setTimeout(show, 400);
}

// ------------------------------------------------------------------ embed code
export function openEmbed() {
  const base = location.origin + location.pathname;
  const d = dialog(`<div class="rowbetween"><h2>Embed HOCO on your site</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
    <p class="lead">Paste this into any web page. It always shows the latest forecast, and nobody needs to sign in.</p>
    <div class="grid2"><label class="field"><span class="kicker">Region</span><select id="emRegion">${X.REGIONS.filter(r => r.west !== undefined).map(r => `<option value="${r.id}" ${r.id === X.S.region ? 'selected' : ''}>${r.name}</option>`).join('')}</select></label>
      <label class="field"><span class="kicker">Day</span><select id="emDay"><option value="0">Day 0 (today)</option><option value="1">Day 1</option><option value="2">Day 2</option></select></label>
      <label class="field"><span class="kicker">Forecast</span><select id="emProd"><option value="traditional">Traditional</option><option value="ai">AI HOCO</option></select></label>
      <label class="field"><span class="kicker">Theme</span><select id="emTheme"><option value="auto">Follow visitor's device</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <label class="field"><span class="kicker">Height</span><select id="emH"><option>420</option><option selected>520</option><option>640</option></select></label>
      <label class="field"><span class="kicker">Extras</span><select id="emLayers"><option value="">Forecast only</option><option value="strikes">+ lightning strikes</option><option value="radar,strikes">+ radar and strikes</option></select></label></div>
    <label class="sr" for="emCode">Embed code</label><textarea id="emCode" rows="4" readonly class="code"></textarea>
    <div class="chips" style="justify-content:flex-end"><a class="btn" id="emOpen" target="_blank" rel="noopener">Preview</a><button class="btn primary" id="emCopy">Copy code</button></div>`, 'Embed');
  const upd = () => {
    const u = new URL(base); u.searchParams.set('embed', '1'); u.searchParams.set('region', $('emRegion').value); u.searchParams.set('day', $('emDay').value);
    if ($('emProd').value === 'ai') u.searchParams.set('view', 'ai'); if ($('emTheme').value !== 'auto') u.searchParams.set('theme', $('emTheme').value);
    if ($('emLayers').value) u.searchParams.set('layers', $('emLayers').value);
    $('emCode').value = `<iframe src="${u.href}" width="100%" height="${$('emH').value}" style="border:0;border-radius:12px" loading="lazy" title="HOCO thunderstorm outlook · ${$('emRegion').value}" allow="fullscreen"></iframe>`;
    $('emOpen').href = u.href;
  };
  d.querySelectorAll('select').forEach(s => s.onchange = upd); upd();
  $('emCopy').onclick = async () => { try { await navigator.clipboard.writeText($('emCode').value); X.toast('Embed code copied'); } catch (e) { $('emCode').select(); X.toast('Press Ctrl+C to copy'); } };
}

// ------------------------------------------------------------------ ad spaces
// Off until there is an ad account. Developers see where the spaces sit; nobody else sees anything.
export const ADS = { enabled: false, client: '', slots: { summary: '', sheet: '' } };
export function renderAds() {
  let consent = null; try { consent = JSON.parse(localStorage.getItem('hocoConsent') || 'null'); } catch (e) { }
  document.querySelectorAll('[data-ad]').forEach(el => {
    if (ADS.enabled && ADS.client && consent?.ads) {
      if (el.dataset.loaded) return; el.dataset.loaded = '1'; el.classList.remove('hidden', 'preview');
      el.innerHTML = `<ins class="adsbygoogle" style="display:block" data-ad-client="${ADS.client}" data-ad-slot="${ADS.slots[el.dataset.ad] || ''}" data-ad-format="auto" data-full-width-responsive="true"></ins>`;
      if (!document.querySelector('script[data-ads]')) { const s = document.createElement('script'); s.async = true; s.dataset.ads = '1'; s.crossOrigin = 'anonymous'; s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADS.client}`; document.head.appendChild(s); }
      try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) { }
    } else if (X.S.role === 'developer' && !X.embed) { el.classList.remove('hidden'); el.classList.add('preview'); el.innerHTML = `<span>Ad space · ${el.dataset.ad === 'summary' ? '320 × 100' : '320 × 50'}</span><small>Only developers see this until ads are switched on</small>`; }
    else { el.classList.add('hidden'); el.innerHTML = ''; }
  });
}

// ------------------------------------------------------------------ init
export function initStage4(ctx) {
  X = ctx;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });
  if ('serviceWorker' in navigator && !X.embed) navigator.serviceWorker.register('sw.js').catch(() => { });
  document.querySelectorAll('[data-compare]').forEach(b => b.onclick = () => openCompare(2));
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('comparing')) closeCompare();
    if (e.key.toLowerCase() === 'c' && !e.target.closest('input,textarea,select') && !e.metaKey && !e.ctrlKey) document.body.classList.contains('comparing') ? closeCompare() : openCompare(2); });
}
