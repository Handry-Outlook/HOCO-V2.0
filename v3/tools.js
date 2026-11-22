// HOCO v3 tools: runs browser, ensemble builder, manual runs, developer console.
// Writes the same Firestore documents as the classic site so both sites and the backend keep working.
import { collection, query, where, orderBy, limit, getDocs, addDoc, updateDoc, doc, getDoc, onSnapshot, writeBatch } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js";
import { blendRuns } from './ensemble.js?v=4';
import { encodeRunSpread } from './model-spread.js?v=1';
import { PRODUCTS, hasHourcast, hourcastRegion, productButtons, traditionalOnlyRegion } from './products.js?v=2';

// Real model names and run frequency (hours), as in the classic manual builder.
const MODELS = { swisseu: { name: 'SWISS-EU', freq: 3 }, hardmi: { name: 'HARMONIE', freq: 3 }, swissnow: { name: 'SWISS-NOW', freq: 1 },
  ez: { name: 'ECMWF EZ', freq: 12 }, ukmo2km: { name: 'UKMO 2KM', freq: 6 }, rpdid2: { name: 'RPDID2', freq: 3 } };
const RUNNERS = { main: { owner: 'Handry-Outlook', repo: 'HOCO-BACKEND', label: 'Account 1' }, alt1: { owner: 'handry66', repo: 'HOCO-BACKEND-ALT1', label: 'Account 2' },
  alt2: { owner: 'Handry6', repo: 'HOCO-BACKEND-ALT2', label: 'Account 3' } };
const CAPS = { normal: 7, external_developer: 7, exclusive: 15, developer: Infinity };
const ROLES = [['guest', 'Guest'], ['normal', 'Normal'], ['exclusive', 'Exclusive'], ['external_developer', 'External developer'], ['developer', 'Developer']];

let X;               // context from the main page
let T = { open: false, tab: 'runs', filter: 'all', product: 'all', date: null, archive: null, archiveKey: '', showMore: false,
  ens: { key: '', src: 'automated', mix: 50, sel: new Set(), w: {}, busy: false },
  man: { scen: [], picked: new Set(), model: 'swisseu', busy: false, notify: true },
  known: new Map(), devUnsubs: [], runner: null, myToday: 0 };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtHoco = (d) => `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const $ = (id) => document.getElementById(id);
const isManualHourcast = r => r.type === 'manual' && r.forecastProduct === 'timing';
const hasGeo = (r) => !!(hasHourcast(r) || r.privateHourcastEnsemble || r.geojsonUrl || r.inlineGeojson || r.inlineGeojsonText || r.geojson || r.ensembleGeojson);
const isPending = (r) => r.cancelled !== true && (r.status === 'pending' || (isManualHourcast(r) && !hasHourcast(r) && !['error','failed'].includes(r.status)) || (!hasGeo(r) && r.status !== 'failed' && r.status !== 'error'));
const isFailed = (r) => r.status === 'failed' || r.status === 'error';
const role = () => X.S.role;
const uid = () => X.auth.currentUser?.uid;

export function typeInfo(r) {
  if (isManualHourcast(r)) return { label: 'Manual Hourcast HOCO', chip: 'HOURCAST', cls: 'beta' };
  if (r.type === 'timing') return { label: 'Hourcast', chip: 'HOURCAST', cls: 'beta' };
  if (r.forecastProduct === 'timing' && r.type === 'human-mimic') return { label: 'Hourcast Ensemble', chip: 'ENSEMBLE', cls: 'ens' };
  if (r.type === 'manual' && (r.forecastProduct === 'ai' || (!r.forecastProduct && r.ml?.mode && r.ml.mode !== 'hand_weights'))) return { label: 'Manual AI HOCO', chip: 'AI', cls: 'beta' };
  if (r.type === 'ai') return { label: 'AI HOCO', chip: 'AI', cls: 'beta' };
  if (r.type === 'automated') return { label: 'AUTO-HOCO', chip: 'AUTO', cls: 'live' };
  if (r.type === 'human-mimic') return { label: 'HOCO Ensemble', chip: 'ENSEMBLE', cls: 'ens' };
  return { label: 'Manual Trad HOCO', chip: r.userId === uid() ? 'MINE' : (r.public ? 'PUBLIC' : 'PRIVATE'), cls: 'arch' };
}
function visible(r) {
  if (r.cancelled === true) return false;
  if (role() === 'developer') return true;
  return r.type === 'automated' || r.type === 'ai' || r.public === true || (uid() && r.userId === uid());
}
function estMinutes(r) {
  const n = Array.isArray(r.scenarios) && r.scenarios.length ? r.scenarios.length : 6;
  const s = X.parseHocoTime(r.startTime), e = X.parseHocoTime(r.endTime || r.startTime);
  const h = s && e ? Math.max(1, (e - s) / 3.6e6) : 24;
  return Math.max(2, Math.ceil(n * 35 * (h / 24) / 60));
}

// ---------------------------------------------------------------- shell
export function initTools(ctx) {
  X = ctx;
  T.man.notify = X.notifyDefault !== false;
  T.date = dateKey(new Date());
  $('toolsBtn').onclick = () => toggle();
  $('toolsClose').onclick = () => toggle(false);
  document.querySelectorAll('#toolsTabs button').forEach(b => b.onclick = () => { T.tab = b.dataset.tab; render(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && T.open) toggle(false); });
  const p = new URLSearchParams(location.search), initToolsParam = X.initialTools ?? p.get('tools');
  if (initToolsParam) { T.tab = ['runs', 'ensemble', 'manual', 'settings', 'dev'].includes(initToolsParam) ? initToolsParam : 'runs'; T.pendingOpen = true; }
  T.wantOpen = X.initialOpen ?? p.get('open');
}

export function setNotify(v) { T.man.notify = !!v; }
export function openTab(tab, filter, product) {
  T.tab = tab;
  if (filter) T.filter = filter;
  if (product) T.product = product;
  toggle(true);
}
export function toggle(force) {
  T.open = force ?? !T.open;
  $('tools').classList.toggle('hidden', !T.open);
  document.body.classList.toggle('tools-open', T.open);
  $('toolsBtn').setAttribute('aria-expanded', T.open);
  if (T.open) render();
}

// called by the main page on every snapshot of hoco_requests
export function onRuns() {
  const me = uid();
  X.S.runs.forEach(r => {
    if (r.userId !== me) return;
    const was = T.known.get(r.id), now = isPending(r) ? 'pending' : (isFailed(r) ? 'failed' : 'done');
    if (was === 'pending' && now === 'done') ready(r);
    if (was === 'pending' && now === 'failed') X.toast('Your HOCO run failed. Try again, or pick fewer model runs.');
    T.known.set(r.id, now);
  });
  T.myToday = X.S.runs.filter(r => r.userId === me && X.created(r) && dateKey(X.created(r)) === dateKey(new Date())).length;
  if (T.pendingOpen && X.S.role) { T.pendingOpen = false; toggle(true); }
  if (T.wantOpen) { const r = X.S.runs.find(x => x.id === T.wantOpen); if (r && visible(r) && !isPending(r)) { T.wantOpen = null; X.showCustom(r); } }
  if (T.open && (T.tab === 'runs' || T.tab === 'ensemble')) render();
  renderMyRun();
}

// ---------------------------------------------------------------- your run is processing (progress card)
// The backend does not report progress, so stages are estimated from the time taken so far.
let myRunTimer = null;
function renderMyRun() {
  const el = $('myRun'), me = uid(); if (!el) return;
  const r = X.S.runs.filter(x => x.userId === me && x.type !== 'automated' && x.type !== 'ai' && x.cancelled !== true && isPending(x)).sort((a, b) => (X.created(b)?.getTime() || 0) - (X.created(a)?.getTime() || 0))[0];
  clearTimeout(myRunTimer);
  if (!r || T.hideRun === r.id) { el.classList.add('hidden'); document.body.classList.remove('myrun-on'); return; }
  const c = X.created(r), est = estMinutes(r), el_ = c ? (Date.now() - c.getTime()) / 60000 : 0, frac = Math.min(0.95, el_ / est), pct = Math.round(frac * 100);
  const n = Array.isArray(r.scenarios) && r.scenarios.length ? r.scenarios.length : 6, s = X.startOf(r), e = X.endOf(r);
  const stages = ['Queued', `Fetching the ${n} model runs`, 'Blending with your weights', 'Drawing the map'], at = frac < 0.1 ? 0 : frac < 0.6 ? 1 : frac < 0.85 ? 2 : 3;
  const left = Math.max(1, Math.round(est - el_));
  el.innerHTML = `<div class="mr-pill" role="button" tabindex="0" aria-label="Show your run's progress"><span class="spin"></span>Your run · ${pct}% · about ${left} min</div>
    <div class="rowbetween"><b>Your run is processing</b><b class="mr-pct">${pct}%</b></div>
    <small class="muted">${esc(r.region || '')} · ${s ? `${X.dayName(s)} ${X.hhmm(s)}` : ''} → ${e ? `${X.dayName(e)} ${X.hhmm(e)}` : ''} · ${n} model run${n > 1 ? 's' : ''}</small>
    <div class="mr-bar"><i style="width:${pct}%"></i></div>
    <ol class="mr-steps">${stages.map((t, i) => `<li class="${i < at ? 'done' : i === at ? 'now' : ''}"><i>${i < at ? '✓' : ''}</i>${t}</li>`).join('')}</ol>
    <small class="muted">About ${left} min left${el_ > est ? ' (taking longer than usual)' : ''}. You can close this or leave the page; it keeps running.</small>
    <label class="chk sm"><input type="checkbox" id="mrNotify" ${T.man.notify ? 'checked' : ''}><span>Notify me when it's ready</span></label>
    <div class="chips" style="justify-content:flex-end"><button class="btn sm" id="mrHide">Minimise</button><button class="btn sm" id="mrCancel" style="color:#b42318">Cancel run</button></div>`;
  el.classList.remove('hidden'); document.body.classList.add('myrun-on'); el.classList.toggle('collapsed', !T.myRunOpen);
  el.querySelector('.mr-pill').onclick = () => { T.myRunOpen = true; renderMyRun(); };
  $('mrNotify').onchange = async (ev) => { T.man.notify = ev.target.checked; if (ev.target.checked && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (err) { } } };
  $('mrHide').onclick = () => { T.myRunOpen = false; renderMyRun(); };
  $('mrCancel').onclick = async () => {
    if (!confirm('Cancel this run? It will be removed from your runs. A job that has already started on the server may still finish in the background.')) return;
    try { await updateDoc(doc(X.db, 'hoco_requests', r.id), { cancelled: true }); T.known.delete(r.id); X.toast('Run cancelled'); } catch (err) { X.toast('Could not cancel the run'); }
  };
  myRunTimer = setTimeout(renderMyRun, 15000);
}

function ready(r) {
  const label = typeInfo(r).label;
  const open = () => isManualHourcast(r) ? X.openHourcast(r) : X.showCustom(r);
  actionToast(`Your ${label} run is ready`, 'Open', () => { open(); if (innerWidth <= 640) toggle(false); });
  if (T.man.notify && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { const n = new Notification('HOCO run ready', { body: `${label} · ${X.S.region}`, icon: 'https://raw.githubusercontent.com/Handry-Outlook/Convective-Outlook/refs/heads/main/Handry_outlook_icon_pride_small.png' });
      n.onclick = () => { focus(); open(); }; } catch (e) { /* some browsers block page notifications */ }
  }
}
function actionToast(msg, action, fn) {
  const t = $('actToast'); t.innerHTML = `<span>${esc(msg)}</span><button class="btn primary">${esc(action)}</button><button class="btn icon" aria-label="Dismiss">✕</button>`;
  t.classList.remove('hidden'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 15000);
  const [a, x] = t.querySelectorAll('button'); a.onclick = () => { t.classList.add('hidden'); fn(); }; x.onclick = () => t.classList.add('hidden');
}

function render() {
  if (!T.open) return;
  const dev = role() === 'developer';
  document.querySelectorAll('#toolsTabs button').forEach(b => { b.setAttribute('aria-selected', b.dataset.tab === T.tab); if (b.dataset.tab === 'dev') b.classList.toggle('hidden', !dev); });
  if (T.tab === 'dev' && !dev) T.tab = 'runs';
  const body = $('toolsBody'), keep = body.scrollTop;
  ({ runs: renderRuns, ensemble: renderEnsemble, manual: renderManual, dev: renderDev, settings: (b) => X.renderSettings(b) })[T.tab](body);
  body.scrollTop = keep;
}

// ---------------------------------------------------------------- runs browser
async function loadArchive(key) {
  if (T.archiveKey === key) return;
  T.archiveKey = key; T.archive = null;
  // a run valid on day D is issued on D or up to two days before it
  const from = new Date(key + 'T00:00:00'), to = new Date(key + 'T23:59:59');
  from.setDate(from.getDate() - 2);
  try {
    const snap = await getDocs(query(collection(X.db, 'hoco_requests'), where('createdAt', '>=', from), where('createdAt', '<=', to), orderBy('createdAt', 'desc'), limit(700)));
    const out = []; snap.forEach(s => out.push({ id: s.id, ...s.data() }));
    if (T.archiveKey === key) { T.archive = out; render(); }
  } catch (e) { console.error(e); if (T.archiveKey === key) { T.archive = []; X.toast('Could not load that date'); render(); } }
}

function forecastsOn(date, overlapping = false) {
  loadArchive(date);
  if (!T.archive || T.archiveKey !== date) return null;
  const byId = new Map(T.archive.map(r => [r.id, r]));
  X.S.runs.forEach(r => byId.set(r.id, r));          // live copies win (status changes while processing)
  return [...byId.values()].filter(r => visible(r) && X.regionMatches(X.S.region, r) && X.startOf(r) && (dateKey(X.startOf(r)) === date ||
      overlapping && dateKey(X.startOf(r)) < date && X.endOf(r) && dateKey(X.endOf(r)) >= date))
    .sort((a, b) => (X.created(b)?.getTime() || 0) - (X.created(a)?.getTime() || 0));
}

function runsForDate() {
  const list = forecastsOn(T.date);
  if (!list) return null;
  return list.filter(r => {
    const product = T.product;
    if (product === 'timing' && !(hasHourcast(r) || r.forecastProduct === 'timing')) return false;
    if (product === 'ai' && !(r.type === 'ai' || r.forecastProduct === 'ai')) return false;
    if (product === 'automated' && !['automated','manual','human-mimic'].includes(r.type)) return false;
    if (product === 'automated' && ['timing','ai'].includes(r.forecastProduct)) return false;
    const filter = T.filter;
    return filter === 'all' || (filter === 'mine' && r.userId === uid()) ||
      (filter === 'ens' && r.type === 'human-mimic') ||
      (filter === 'manens' && !['automated','ai'].includes(r.type)) ||
      (filter === 'auto' && ['automated','ai'].includes(r.type)) ||
      (filter === 'pub' && r.public === true);
  });
}

function runRow(r) {
  const ti = T.product === "timing" && hasHourcast(r) ? typeInfo({type:"timing"}) : typeInfo(r), c = X.created(r), s = X.startOf(r), e = X.endOf(r), mine = r.userId === uid();
  let right;
  if (isPending(r)) {
    const mins = c ? Math.max(0, Math.round((Date.now() - c.getTime()) / 60000)) : 0;
    right = `<span class="proc"><span class="spin"></span><span>Processing<br><small>${mins} of about ${estMinutes(r)} min</small></span></span>`;
  } else if (isFailed(r)) right = `<span class="tag" style="color:#b42318">Failed</span>`;
  else right = `<div class="run-actions">
    ${(T.product !== 'timing' && !isManualHourcast(r)) || !hasHourcast(r) ? `<button class="btn" data-open="${esc(r.id)}">Load</button>` : ''}
    ${hasHourcast(r) ? `<button class="btn" data-timed="${esc(r.id)}">${T.product === 'timing' ? 'Choose window' : 'Hourcast'}</button>` : ''}
  </div>`;
  const devPub = role() === 'developer' && !isPending(r) && r.public !== true && !isManualHourcast(r) && !r.privateHourcastEnsemble && r.type !== 'automated' && r.type !== 'ai'
    ? `<button class="linkbtn" data-pub="${esc(r.id)}">Make public</button>` : '';
  const scen = Array.isArray(r.scenarios) && r.scenarios.length ? ` · ${r.scenarios.length} model run${r.scenarios.length > 1 ? 's' : ''}` : '';
  const srcs = r.type === 'human-mimic' && r.sourceRunCount ? ` · ${r.sourceRunCount} runs blended` : '';
  return `<div class="runitem${X.S.custom?.id === r.id ? ' on' : ''}"><span class="tag ${ti.cls}">${ti.chip}</span>
    <div class="ri-main"><b>${c ? X.hhmm(c) : '–'} <span class="ri-type">${ti.label}${c && dateKey(c) !== T.date ? ` · issued ${X.dayName(c)}` : ''}</span></b><small>${s ? `${X.dayName(s)} ${X.hhmm(s)}` : '–'} → ${e ? `${X.dayName(e)} ${X.hhmm(e)}` : '–'}${scen}${srcs}${mine && r.type !== 'automated' && r.type !== 'ai' ? ' · yours' : ''}</small>${devPub}</div>${right}</div>`;
}

function renderRuns(body) {
  const list = runsForDate(), d = new Date(T.date + 'T00:00:00'), isToday = T.date === dateKey(new Date());
  const chips = [['all', 'All'], ['auto', 'AUTO'], ['manens', 'Manual + Ensemble'], ['mine', 'My runs'], ['pub', 'Public']]
    .map(([k, l]) => `<button class="chipbtn" aria-pressed="${T.filter === k}" data-f="${k}">${l}</button>`).join('');
  const mine = X.S.runs.filter(r => r.userId === uid() && isPending(r));
  const shown = list ? (T.showMore ? list : list.slice(0, 40)) : [];
  body.innerHTML = `
    ${mine.length ? `<div class="note good"><span class="spin"></span><div><b>${mine.length} run${mine.length > 1 ? 's' : ''} processing</b><br><small>You can keep using HOCO. We'll show a message when ${mine.length > 1 ? 'each one is' : "it's"} ready.</small></div></div>` : ''}
    <div class="datebar"><button class="btn icon" id="dPrev" aria-label="Previous day">‹</button>
      <label class="dateinput"><span class="kicker">Forecasts valid on</span><input type="date" id="dPick" value="${T.date}" max="${dateKey(new Date(Date.now() + 2 * 864e5))}"></label>
      <button class="btn icon" id="dNext" aria-label="Next day">›</button></div>
    <div class="product-choices" role="group" aria-label="Forecast product">${productButtons('forecast', T.product, ['all','automated','ai','timing'])}</div>
    <div class="chips">${chips}</div>
    <div class="muted" style="font-size:13px">${esc(X.S.region)} · ${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${isToday ? ' (today)' : ''}</div>
    <div class="runlist">${list == null ? '<div class="muted center"><span class="spin"></span> Loading runs…</div>' : shown.length ? shown.map(runRow).join('') : `<div class="muted center">No runs here${T.filter !== 'all' ? ' with this filter' : ''}.</div>`}</div>
    ${list && list.length > shown.length ? `<button class="btn" id="moreRuns">Show all ${list.length} runs</button>` : ''}
    <div class="adslot hidden" data-ad="runs"></div>`;
  const shift = (n) => { const x = new Date(T.date + 'T00:00:00'); x.setDate(x.getDate() + n); T.date = dateKey(x); T.showMore = false; render(); };
  $('dPrev').onclick = () => shift(-1); $('dNext').onclick = () => shift(1);
  $('dPick').onchange = (e) => { if (e.target.value) { T.date = e.target.value; T.showMore = false; render(); } };
  body.querySelectorAll('[data-forecast]').forEach(b => b.onclick = () => { T.product = b.dataset.forecast; T.showMore = false; render(); });
  body.querySelectorAll('[data-timed]').forEach(b => b.onclick = () => pickRunWindow(b, list.find(r => r.id === b.dataset.timed)));
  body.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { T.filter = b.dataset.f; T.showMore = false; render(); });
  $('moreRuns') && ($('moreRuns').onclick = () => { T.showMore = true; render(); });
  body.querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
    const r = [...X.S.runs, ...(T.archive || [])].find(x => x.id === b.dataset.open); if (!r) return;
    if (X.comparing?.()) { X.loadTo(r); return; }
    X.showCustom(r); if (innerWidth <= 640) toggle(false); else render();
  });
  X.renderAds?.();
  body.querySelectorAll('[data-pub]').forEach(b => b.onclick = async () => {
    try { await updateDoc(doc(X.db, 'hoco_requests', b.dataset.pub), { public: true }); X.toast('Run is now public'); } catch (e) { X.toast('Could not make it public'); }
  });
}

async function pickRunWindow(button, source) {
  if (!source) return;
  const row = button.closest('.runitem');
  const existing = row.nextElementSibling;
  if (existing?.classList.contains('hourcast-pick')) { existing.remove(); return; }
  const panel = document.createElement('div');
  panel.className = 'hourcast-pick';
  panel.textContent = 'Loading Hourcast windows…';
  row.after(panel);
  try {
    const windows = await X.hourcastWindows(source);
    if (!panel.isConnected) return;
    if (!windows.length) { panel.textContent = 'No Hourcast windows were saved for this run.'; return; }
    panel.innerHTML = `<label class="field"><span class="kicker">Valid window</span><select>${windows.map((w,i) => `<option value="${i}">${esc(w.windowValidity)}</option>`).join('')}</select></label><button class="btn primary sm">${X.comparing() ? 'Add to compare' : 'Open Hourcast'}</button>`;
    panel.querySelector('button').onclick = () => {
      const window = windows[Number(panel.querySelector('select').value)];
      if (X.comparing()) X.loadTo(window);
      else X.openHourcast(source, window);
    };
    panel.querySelector('select').focus();
  } catch {
    if (panel.isConnected) panel.textContent = 'Could not load the Hourcast windows.';
  }
}

// ---------------------------------------------------------------- ensemble
// Auto runs cover 06:00 to 05:59 the next day; group them by that valid period (as the classic site does).
function periodOf(r) {
  const s = X.startOf(r), e = X.endOf(r); if (!s || !e || e.getHours() !== 5 || e.getMinutes() !== 59) return null;
  const ns = new Date(s.getFullYear(), s.getMonth(), s.getDate(), 6, 0), ne = new Date(ns); ne.setDate(ne.getDate() + 1); ne.setHours(5, 59);
  if (Math.abs(e - ne) > 60000) return null;
  return { start: ns, end: ne, key: dateKey(ns) };
}
function ensembleGroups() {
  const g = new Map();
  X.S.runs.forEach(r => {
    if (!(r.type === 'automated' || r.type === 'ai') || isPending(r) || !hasGeo(r) || !X.regionMatches(X.S.region, r)) return;
    const w = String(r.weather || '').toLowerCase(); if (w && !w.includes('lightning') && !w.includes('thunder')) return;
    const p = periodOf(r); if (!p) return;
    if (!g.has(p.key)) g.set(p.key, { ...p, runs: [] }); g.get(p.key).runs.push(r);
  });
  return [...g.values()].map(x => ({ ...x, runs: x.runs.sort((a, b) => (X.created(a)?.getTime() || 0) - (X.created(b)?.getTime() || 0)) }))
    .sort((a, b) => a.start - b.start).slice(-5);   // the last few days are what people blend
}
function defaultWeights(runs) {   // newer runs count a little more: 1.0 → 1.4, like the classic ensemble
  const out = {}; runs.forEach((r, i) => { out[r.id] = +(1 + (runs.length > 1 ? i / (runs.length - 1) : 0) * 0.4).toFixed(1); }); return out;
}

function renderEnsemble(body) {
  if (role() === 'guest') { body.innerHTML = '<div class="note">Sign in to build ensembles.</div>'; return; }
  const E = T.ens, timed = E.src === 'timing';
  const nav = `<div class="product-choices" role="group" aria-label="Forecast product">
    ${productButtons('ens-product', E.src)}
    <button class="chipbtn" data-ens-product="both" aria-pressed="${E.src === 'both'}">Traditional + AI</button>
  </div>`;
  if (timed) renderHourcastEnsemble(body, nav);
  else renderEnsembleControls(body, ensembleGroups(), nav);
  body.querySelectorAll('[data-ens-product]').forEach(button => button.onclick = () => {
    if (E.busy) return;
    E.sel = new Set(); E.w = {};
    E.src = button.dataset.ensProduct; E.key = ''; E.seed = null;
    render();
  });
}

function renderHourcastEnsemble(body, nav) {
  const E = T.ens;
  E.date ||= dateKey(X.addDays(X.baseDay(), X.S.day));
  const list = forecastsOn(E.date, true);
  const runs = list?.filter(r => hasHourcast(r) && !isPending(r) && !isFailed(r));
  const key = runs && JSON.stringify([E.date, X.S.region, runs.map(r => r.id)]);
  if (key && E.windowsKey !== key) {
    E.windowsKey = key; E.groups = null; E.windowError = false;
    const date = E.date;
    Promise.all(runs.map(r => X.hourcastWindows(r))).then(lists => {
      if (E.windowsKey !== key) return;
      const groups = new Map();
      for (const run of lists.flat()) {
        const start = X.startOf(run), end = X.endOf(run);
        if (dateKey(start) !== date) continue;
        const key = start.toISOString() + '/' + end.toISOString();
        if (!groups.has(key)) groups.set(key, { key, start, end, label: run.windowValidity, runs: [] });
        groups.get(key).runs.push(run);
      }
      E.groups = [...groups.values()].sort((a,b) => a.start - b.start || a.end - b.end);
      if (T.tab === 'ensemble' && E.src === 'timing') render();
    }).catch(() => {
      if (E.windowsKey !== key) return;
      E.groups = []; E.windowError = true;
      if (T.tab === 'ensemble' && E.src === 'timing') render();
    });
  }
  const header = `${nav}<label class="field"><span class="kicker">Forecast date</span><input type="date" id="ensDate" value="${E.date}"></label>`;
  const groups = key && E.windowsKey === key ? E.groups : null;
  if (groups?.length) renderEnsembleControls(body, groups, header, true);
  else body.innerHTML = `${header}<div class="note" role="status">${E.windowError && groups ? 'Could not load the saved windows.' : groups ? 'No Hourcast windows for this date.' : 'Loading Hourcast windows…'}</div>`;
  $('ensDate').onchange = e => { if (e.target.value && !E.busy) { E.date = e.target.value; E.key = ''; E.seed = null; render(); } };
}

function renderEnsembleControls(body, groups, header, timed = false) {
  const E = T.ens;
  if (!groups.length) { body.innerHTML = `${header}<div class="note">No finished runs to blend for ${esc(X.S.region)} yet.</div>`; return; }
  const want = dateKey(X.addDays(X.baseDay(), X.S.day));
  let grp = groups.find(x => x.key === E.key) || (timed ? groups.find(x => x.runs.length >= 2) : groups.find(x => x.key === want)) || groups.at(-1);
  if (grp.key !== E.key) { E.key = grp.key; E.sel = new Set(); E.w = {}; }
  const pool = grp.runs.filter(r => timed || E.src === 'both' || r.type === E.src);
  const dw = defaultWeights(pool);
  pool.forEach(r => { if (E.w[r.id] == null) E.w[r.id] = dw[r.id]; });
  if (E.seed !== `${grp.key}|${E.src}`) { E.seed = `${grp.key}|${E.src}`; E.sel = new Set(pool.slice(-6).map(r => r.id)); }
  const chosen = pool.filter(r => E.sel.has(r.id)), mixOn = E.src === 'both' && chosen.some(r => r.type === 'ai') && chosen.some(r => r.type === 'automated');
  if (E.wmode !== 'custom') pool.forEach(r => { E.w[r.id] = dw[r.id]; });
  const share = (r) => !mixOn ? 1 : (r.type === 'ai' ? (100 - E.mix) / 50 : E.mix / 50);
  const tot = chosen.reduce((a, r) => a + E.w[r.id] * share(r), 0) || 1, pctOf = (r) => E.sel.has(r.id) ? Math.round(E.w[r.id] * share(r) / tot * 100) : 0;
  body.innerHTML = `
    <p class="lead">Blend several runs into one forecast. Newer runs count a little more by default; drag a weight to change that.</p>
    ${header}
    ${timed ? `<label class="field"><span class="kicker">Valid window</span><select id="enWindow">
      ${groups.map(x => `<option value="${x.key}" ${x.key === grp.key ? 'selected' : ''}>${esc(x.label)} · ${x.runs.length} run${x.runs.length===1?'':'s'}</option>`).join('')}
    </select><small class="muted">Select at least two runs with the same start and end time.</small></label>`
      : `<div class="field"><span class="kicker">Day</span><div class="chips">${groups.map(x => `<button class="chipbtn" aria-pressed="${x.key === grp.key}" data-g="${x.key}">${X.dayDate(x.start)}<small>${x.runs.length} runs</small></button>`).join('')}</div></div>`}
    ${!pool.length ? '<small class="muted">No runs for this product on the selected day.</small>' : ''}
    ${mixOn ? `<div class="field"><span class="kicker">Traditional vs AI HOCO</span><input type="range" id="mix" min="0" max="100" step="5" value="${E.mix}" style="--pct:${E.mix}%">
      <div class="ticks2"><span>Traditional ${E.mix}%</span><span>AI HOCO ${100 - E.mix}%</span></div></div>` : ''}
    <div class="field"><div class="rowbetween"><span class="kicker">Run weights</span><span><button class="linkbtn" id="selLatest">Latest 6</button> · <button class="linkbtn" id="selAll">All</button></span></div>
      <div class="seg wide" role="group"><button data-wmode="auto" aria-pressed="${E.wmode !== 'custom'}">Auto (newer counts more)</button><button data-wmode="custom" aria-pressed="${E.wmode === 'custom'}">Custom</button></div>
      <div class="wlist">${pool.slice().reverse().map(r => { const c = X.created(r), on = E.sel.has(r.id), w = E.w[r.id], ti = typeInfo(r);
        return `<div class="wrow${on ? '' : ' off'}"><label class="chk"><input type="checkbox" data-sel="${esc(r.id)}" ${on ? 'checked' : ''}><span><b>${X.hhmm(c)}</b> <small>${X.dayName(c)}</small></span></label>
          <span class="tag ${ti.cls}">${ti.chip}</span>
          <input type="range" min="0.1" max="2" step="0.1" value="${w}" data-w="${esc(r.id)}" aria-label="Weight for run issued ${X.hhmm(c)}" style="--pct:${(w - 0.1) / 1.9 * 100}%" ${on && E.wmode === 'custom' ? '' : 'disabled'}>
          <output>${on ? pctOf(r) + '%' : '–'}</output></div>`; }).join('')}</div>
      <small class="muted">Weights always add up to 100%. Untick a run to leave it out.</small></div>
    <div class="runfoot"><button class="btn" id="resetW">Reset</button><button class="btn primary big" id="buildEns" ${E.busy || chosen.length < (timed ? 2 : 1) ? 'disabled' : ''}>${E.busy ? '<span class="spin light"></span> Building…' : `Build ensemble (${chosen.length} run${chosen.length === 1 ? '' : 's'})`}</button></div>
    <small class="muted" id="ensStatus">${timed ? 'Saved to My runs. The ensemble map is visible only to your account.' : 'Saved to your runs. Only you can see it unless a developer makes it public.'}</small>`;
  body.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { E.key = b.dataset.g; E.sel = new Set(); E.w = {}; render(); });
  if ($('enWindow')) $('enWindow').onchange = e => { if (!E.busy) { E.key = e.target.value; E.sel = new Set(); E.w = {}; render(); } };
  $('mix') && ($('mix').oninput = (e) => { E.mix = +e.target.value; e.target.style.setProperty('--pct', E.mix + '%'); const t = e.target.nextElementSibling.children; t[0].textContent = `Traditional ${E.mix}%`; t[1].textContent = `AI HOCO ${100 - E.mix}%`; });
  body.querySelectorAll('[data-sel]').forEach(c => c.onchange = () => { c.checked ? E.sel.add(c.dataset.sel) : E.sel.delete(c.dataset.sel); render(); });
  body.querySelectorAll('[data-w]').forEach(x => { x.oninput = () => { E.w[x.dataset.w] = +x.value; x.style.setProperty('--pct', (x.value - 0.1) / 1.9 * 100 + '%');
    const t2 = chosen.reduce((a, r) => a + E.w[r.id] * share(r), 0) || 1; body.querySelectorAll('[data-w]').forEach(y => { const rr = pool.find(r => r.id === y.dataset.w); if (rr && E.sel.has(rr.id)) y.nextElementSibling.textContent = Math.round(E.w[rr.id] * share(rr) / t2 * 100) + '%'; }); }; });
  body.querySelectorAll('[data-wmode]').forEach(b => b.onclick = () => { E.wmode = b.dataset.wmode; render(); });
  $('selLatest').onclick = () => { E.sel = new Set(pool.slice(-6).map(r => r.id)); render(); };
  $('selAll').onclick = () => { E.sel = new Set(pool.map(r => r.id)); render(); };
  $('resetW').onclick = () => { E.w = { ...E.w, ...dw }; E.wmode = 'auto'; E.sel = new Set(pool.slice(-6).map(r => r.id)); E.mix = 50; render(); };
  $('buildEns').onclick = () => buildEnsemble(grp, chosen, mixOn, timed);
}

async function buildEnsemble(grp, chosen, mixOn, timed) {
  const E = T.ens; if (E.busy) return;
  const weights = { ...E.w }, mix = E.mix, region = X.S.region, user = uid();
  E.busy = true; render();
  const status = (t) => { const s = $('ensStatus'); if (s) s.textContent = t; };
  try {
    const share = (r) => !mixOn ? 1 : (r.type === 'ai' ? (100 - mix) / 50 : mix / 50);
    status(`Loading ${chosen.length} runs…`);
    const loaded = (await Promise.allSettled(chosen.map(async r => ({ r, geojson: await X.fetchGeo(r) })))).filter(x => x.status === 'fulfilled').map(x => x.value);
    if (loaded.length < (timed ? 2 : 1)) throw new Error(timed ? 'At least two matching Hourcast runs must load.' : 'None of the chosen runs could be loaded.');
    if (loaded.length < chosen.length) X.toast(`${chosen.length - loaded.length} run(s) could not be loaded and were skipped`);
    status('Blending…');
    await new Promise(r => setTimeout(r, 30));
    const entries = loaded.map(({ r, geojson }) => ({ geojson, weight: +(weights[r.id] * share(r)).toFixed(3), createdMs: X.created(r)?.getTime() || 0, r }));
    const geo = blendRuns(entries, X.BANDS, { allowQuiet: timed });
    const used = entries.filter(e => e.weight > 0);
    const area = X.REGIONS.find(item => item.id === region && Number.isFinite(item.west));
    if (area && used.length >= 2 && used.every(({ r }) => r.region === region)) {
      try {
        const { forecastSampler } = await import('./run-verification.js?v=5');
        const members = used.map(({ r, weight, geojson }) => ({
          id: r.id, weight, label: `${PRODUCTS[r.type]?.label || 'Run'} ${X.hhmm(X.created(r))}`,
          sample: forecastSampler(geojson)
        }));
        const spread = encodeRunSpread(members, [area.west, area.south, area.east, area.north],
          890000 - JSON.stringify(geo).length);
        if (spread) geo.properties.modelSpread = spread;
      } catch (err) {
        console.warn('Model spread unavailable for this ensemble', err);
      }
    }
    status('Saving…');
    const payload = {
      region, startTime: fmtHoco(grp.start), endTime: fmtHoco(grp.end), weather: 'lightning',
      userId: user, validFrom: grp.start, validTo: grp.end, ...(timed ? { forecastProduct: 'timing' } : {}), createdAt: new Date(), status: 'complete', public: false, type: 'human-mimic', tag: 'ENSEMBLE',
      sourceRunIds: used.map(e => e.r.sourceRunId || e.r.id), sourceRunCount: used.length, sourceTypes: [...new Set(used.map(e => e.r.type))],
      inlineGeojsonText: JSON.stringify(geo),
      humanMimic: { anomalyAware: true, noiseFilter: true, validPeriodKey: `${region}|${grp.key}`, weights: Object.fromEntries(used.map(e => [e.r.id, e.weight])),
        traditionalShare: mixOn ? mix / 100 : null, builtWith: 'v3',
        latestIssuedAt: X.created(used[used.length - 1].r)?.toISOString() || null, earliestIssuedAt: X.created(used[0].r)?.toISOString() || null }
    };
    if (payload.inlineGeojsonText.length > 900000) throw new Error('This blend is too detailed to save. Pick fewer runs.');
    let ref;
    if (timed) {
      if (uid() !== user) throw Error('Sign in again to save the ensemble.');
      ref = doc(collection(X.db, 'hoco_requests'));
      const inlineGeojsonText = payload.inlineGeojsonText;
      delete payload.inlineGeojsonText;
      payload.privateHourcastEnsemble = true;
      const batch = writeBatch(X.db);
      batch.set(ref, payload);
      batch.set(doc(X.db, 'users', user, 'hourcast_runs', ref.id), { inlineGeojsonText });
      await batch.commit();
    } else {
      ref = await addDoc(collection(X.db, 'hoco_requests'), payload);
    }
    X.cachePut(ref.id, geo);
    X.toast(timed ? 'Hourcast ensemble saved' : 'Ensemble saved');
    X.showCustom({ id: ref.id, ...payload });
    if (innerWidth <= 640) toggle(false);
  } catch (e) { console.error(e); X.toast(e.message || 'Could not build the ensemble'); }
  finally { E.busy = false; render(); }
}

// ---------------------------------------------------------------- manual run
function runOptions(model, startVal) {
  const f = MODELS[model].freq, ref = startVal ? new Date(startVal) : new Date();
  ref.setUTCMinutes(0, 0, 0); ref.setUTCHours(Math.floor(ref.getUTCHours() / f) * f);
  return Array.from({ length: 20 }, (_, i) => { const d = new Date(ref.getTime() - i * f * 3.6e6);
    return { iso: d.toISOString(), label: `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}z` }; });
}

function manualEst(nScen, hours) { return Math.max(2, Math.ceil((nScen || 6) * 35 * (hours / 24) / 60)); }
function renderManual(body) {
  const M = T.man, r = role(), cap = CAPS[r], canScen = r === 'exclusive' || r === 'developer', dev = r === 'developer';
  if (r === 'guest') { body.innerHTML = `<div class="note">Guests can't start runs. Sign in with a free account to run HOCO.</div>`; return; }
  if (!M.start) { const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); M.start = localInput(d); }
  if (!M.len) M.len = 12;
  const st = new Date(M.start), en = M.customEnd && M.end ? new Date(M.end) : new Date(st.getTime() + M.len * 3.6e6), hours = Math.max(1, (en - st) / 3.6e6);
  const left = cap === Infinity ? Infinity : Math.max(0, cap - T.myToday), opts = runOptions(M.model, M.start);
  const chosenRegion = M.region || X.S.region, traditionalOnly = traditionalOnlyRegion(chosenRegion);
  if (traditionalOnly && M.product === 'ai') M.product = 'automated';
  const product = M.product || 'automated';
  const nModels = new Set(M.scen.map(x => x.model)).size, mode = product === 'ai' && !traditionalOnly ? 'learned' : 'custom';
  const productNote = product === 'timing'
    ? ' Manual Hourcast uses hourly windows up to 24 hours.'
    : product === 'automated' && hourcastRegion(chosenRegion)
      ? (hours <= 24 ? ' Automatically includes Hourcast windows too.' : ' Choose up to 24 hours to automatically include Hourcast windows too.')
      : '';
  body.innerHTML = `
    <div class="field"><span class="kicker">Forecast product</span><div class="product-choices" role="group" aria-label="Forecast product">${productButtons('manual-product', product, traditionalOnly ? ['automated', 'timing'] : undefined)}</div>
      <small class="muted">${PRODUCTS[product].detail}${productNote}</small></div>
    <div class="field"><span class="kicker">Region</span><div class="chips">${X.REGIONS.filter(x => x.west !== undefined && (product !== 'timing' || hourcastRegion(x.id))).map(x => `<button class="chipbtn" data-reg="${x.id}" aria-pressed="${x.id === (M.region || X.S.region)}">${x.name}</button>`).join('')}</div></div>
    <div class="grid2"><label class="field"><span class="kicker">Starts</span><input type="datetime-local" id="mStart" value="${M.start}"></label>
      <div class="field"><span class="kicker">Length</span><div class="chips">${[3, 6, 12, 24].map(h => `<button class="chipbtn" data-h="${h}" aria-pressed="${!M.customEnd && M.len === h}">${h} h</button>`).join('')}</div></div></div>
    <div class="rowbetween"><small class="muted">→ ends <b>${X.dayName(en)} ${X.hhmm(en)}</b> · ${Math.round(hours)} h</small><button class="linkbtn" id="mCustomEnd">${M.customEnd ? 'Use a length' : 'Pick an end time'}</button></div>
    ${M.customEnd ? `<label class="field"><span class="kicker">Ends</span><input type="datetime-local" id="mEnd" value="${M.end || localInput(en)}"></label>` : ''}
    ${canScen ? `
      <div class="field"><div class="rowbetween"><span class="kicker">Models and runs</span><small class="muted">${M.scen.length ? `${M.scen.length} run${M.scen.length > 1 ? 's' : ''} · ${nModels} model${nModels > 1 ? 's' : ''}` : 'standard set'}</small></div>
        ${mode === 'learned' ? '<small class="muted">AI HOCO\'s learned weights decide how much each model counts. Falls back to the standard weights if none is live.</small>' : ''}
        <div class="chips modelchips">${Object.entries(MODELS).map(([k, m]) => `<button class="chipbtn" data-model="${k}" aria-pressed="${k === M.model}">${m.name}</button>`).join('')}</div>
        <div class="chips runchips">${opts.map(o => { const added = M.scen.some(x => x.model === M.model && x.run === o.iso);
          return `<button class="chipbtn${added ? ' added' : ''}" data-iso="${o.iso}" aria-pressed="${M.picked.has(o.iso)}" ${added ? 'disabled title="Already added"' : ''}>${o.label}</button>`; }).join('')}</div>
        <button class="btn" id="mAdd" ${M.picked.size ? '' : 'disabled'}>Add ${M.picked.size || ''} ${MODELS[M.model].name} run${M.picked.size === 1 ? '' : 's'}</button>
        <div class="wlist">${M.scen.length ? M.scen.map((x, i) => `<div class="wrow"><span class="scenlabel"><b>${esc(MODELS[x.model]?.name || x.model)}</b> <small>${esc(x.runLabel)}</small></span>
          ${mode === 'custom' ? `<input type="range" min="0.1" max="2" step="0.1" value="${x.weight}" data-sw="${i}" aria-label="Weight" style="--pct:${(x.weight - 0.1) / 1.9 * 100}%"><output>×${(+x.weight).toFixed(1)}</output>` : '<span class="muted" style="font-size:12px">learned</span><span></span>'}
          <button class="btn icon sm" data-rm="${i}" aria-label="Remove">✕</button></div>`).join('') : ''}</div>
        <small class="muted">Add the same model more than once to use several of its runs.${mode === 'custom' ? ' Each run has its own weight.' : ''}</small>
      </div>` : `<div class="note slim">Your runs use HOCO's standard model blend. Exclusive accounts can pick model runs and weights.</div>`}
    ${dev ? `<details class="field devbox" ${M.devOpen ? 'open' : ''}><summary><span class="kicker">Developer · model weighting</span></summary>
      <small class="muted">Leave blank to use the backend default for that model.</small>
      <div class="grid3">${Object.entries(MODELS).map(([k, m]) => `<label><small>${m.name}</small><input type="number" step="0.1" min="0" id="mw-${k}" placeholder="default" value="${M.w?.[k] ?? ''}"></label>`).join('')}</div></details>` : ''}
    <label class="chk"><input type="checkbox" id="mNotify" ${M.notify ? 'checked' : ''}><span>Notify me when it's ready</span></label>
    <div class="runfoot"><span><b>${cap === Infinity ? 'Unlimited runs' : `${left} of ${cap} runs left today`}</b><small>Takes about ${manualEst(M.scen.length, hours)} min</small></span>
      <button class="btn primary big" id="mGo" ${M.busy || (cap !== Infinity && !left) ? 'disabled' : ''}>${M.busy ? '<span class="spin light"></span> Starting…' : `Run ${PRODUCTS[product].label}`}</button></div>`;
  body.querySelectorAll('[data-manual-product]').forEach(b => b.onclick = () => {
    M.product = b.dataset.manualProduct;
    if (M.product === 'timing' && !hourcastRegion(chosenRegion)) M.region = 'England';
    render();
  });
  body.querySelectorAll('[data-reg]').forEach(b => b.onclick = () => { M.region = b.dataset.reg; render(); });
  $('mStart').onchange = (e) => { M.start = e.target.value || M.start; render(); };
  body.querySelectorAll('[data-h]').forEach(b => b.onclick = () => { M.len = +b.dataset.h; M.customEnd = false; render(); });
  $('mCustomEnd').onclick = () => { M.customEnd = !M.customEnd; if (M.customEnd && !M.end) M.end = localInput(en); render(); };
  $('mEnd') && ($('mEnd').onchange = (e) => { M.end = e.target.value; render(); });
  if (canScen) {
    body.querySelectorAll('[data-model]').forEach(b => b.onclick = () => { M.model = b.dataset.model; M.picked = new Set(); render(); });
    body.querySelectorAll('[data-iso]').forEach(b => b.onclick = () => { M.picked.has(b.dataset.iso) ? M.picked.delete(b.dataset.iso) : M.picked.add(b.dataset.iso); render(); });
    $('mAdd').onclick = () => { opts.filter(o => M.picked.has(o.iso)).forEach(o => { if (!M.scen.some(x => x.model === M.model && x.run === o.iso)) M.scen.push({ model: M.model, run: o.iso, runLabel: o.label, weight: 1 }); }); M.picked = new Set(); render(); };
    body.querySelectorAll('[data-sw]').forEach(x => x.oninput = () => { M.scen[+x.dataset.sw].weight = +x.value; x.style.setProperty('--pct', (x.value - 0.1) / 1.9 * 100 + '%'); x.nextElementSibling.textContent = `×${(+x.value).toFixed(1)}`; });
    body.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { M.scen.splice(+b.dataset.rm, 1); render(); });
  }
  if (dev) { body.querySelector('.devbox').ontoggle = (e) => { M.devOpen = e.target.open; };
    Object.keys(MODELS).forEach(k => $(`mw-${k}`).oninput = (e) => { M.w = { ...(M.w || {}), [k]: e.target.value }; }); }
  $('mNotify').onchange = (e) => { M.notify = e.target.checked; };
  $('mGo').onclick = startManual;
}

async function startManual() {
  const M = T.man, r = role(), cap = CAPS[r];
  const sIn = M.start, s = new Date(sIn), e = M.customEnd && M.end ? new Date(M.end) : new Date(s.getTime() + (M.len || 12) * 3.6e6);
  if (!sIn || isNaN(s) || isNaN(e)) return X.toast('Choose when the run starts');
  if (s >= e) return X.toast('The start must be before the end');
  const product = M.product || 'automated';
  if (product === 'timing' && (!hourcastRegion(M.region || X.S.region) || e - s > 864e5 || e <= new Date())) {
    return X.toast('Choose an active period up to 24 hours in a supported Hourcast region.');
  }
  if (r !== 'developer' && (e - s) / 3.6e6 > 72) return X.toast('A run can cover up to 72 hours');
  if (cap !== Infinity && T.myToday >= cap) return X.toast(`You've used all ${cap} runs for today`);
  M.busy = true; M.region = M.region || X.S.region; render();
  if (M.notify && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (err) { /* ignore */ } }
  // Normal users always get the standard blend, as on the classic site. Weights left blank use the backend defaults.
  const canScen = r === 'exclusive' || r === 'developer';
  const traditionalOnly = traditionalOnlyRegion(M.region);
  const learned = product === 'ai' && !traditionalOnly;
  const scenarios = canScen ? M.scen.map(x => ({ model: x.model, run: x.run, label: `${MODELS[x.model].name} (${x.runLabel})`, ...(learned ? {} : { weight: x.weight }) })) : [];
  const weights = {};
  if (r === 'developer' && !learned) Object.entries(M.w || {}).forEach(([k, v]) => { if (v !== '' && Number.isFinite(+v)) weights[k] = +v; });
  if (product === 'timing') weights._mode = 'hourcast';
  else if (learned) weights._mode = 'learned';
  const payload = { forecastProduct: product, region: M.region, scenarios, startTime: fmtHoco(s), endTime: fmtHoco(e), weather: 'lightning', weights: JSON.stringify(weights),
    userId: uid(), createdAt: new Date(), status: 'pending', public: false, type: 'manual' };
  try {
    const ref = await addDoc(collection(X.db, 'hoco_requests'), payload);
    T.known.set(ref.id, 'pending'); T.myRunOpen = true;
    try {
      const result = await httpsCallable(getFunctions(X.app, 'us-central1'), 'triggerHocoRun')({ id: ref.id, ...payload });
      if (result.data?.success === false) throw Error('The backend declined the dispatch');
    } catch (err) {
      console.error(err);
      X.toast('The run was saved but the backend did not start it.');
      return;
    }
    M.scen = []; M.picked = new Set();
    X.toast('Run started. We\'ll tell you when it\'s ready.');
    T.tab = 'runs'; T.filter = 'mine'; T.product = product; T.date = dateKey(s);
  } catch (err) { console.error(err); X.toast('Could not start the run'); }
  finally { M.busy = false; render(); }
}

function upgradeForm() {
  return `<details class="field devbox"><summary><span class="kicker">Ask for more access</span></summary>
    <label class="field"><small>Account type</small><select id="uRole"><option value="normal">Normal</option><option value="exclusive">Exclusive</option><option value="external_developer">External developer (API)</option></select></label>
    <label class="field"><small>Social link or handle</small><input id="uSocial" placeholder="e.g. @yourname"></label>
    <label class="field"><small>Why do you need it?</small><textarea id="uReason" rows="3"></textarea></label>
    <button class="btn" id="uSend">Send request</button></details>`;
}
function wireUpgrade() {
  const b = $('uSend'); if (!b) return;
  b.onclick = async () => {
    const social = $('uSocial').value.trim(), reason = $('uReason').value.trim();
    if (!social || !reason) return X.toast('Fill in both boxes');
    try { await addDoc(collection(X.db, 'role_requests'), { userId: uid(), email: X.auth.currentUser.email, requestedRole: $('uRole').value, social, reason, status: 'pending', createdAt: new Date() });
      X.toast('Request sent'); $('uSocial').value = ''; $('uReason').value = ''; } catch (e) { X.toast('Could not send the request'); }
  };
}

// ---------------------------------------------------------------- developer console
function devSubscribe() {
  if (T.devUnsubs.length || role() !== 'developer') return;
  T.users = null; T.reqs = null;
  T.devUnsubs.push(onSnapshot(collection(X.db, 'users'), (s) => { T.users = []; s.forEach(d => T.users.push({ id: d.id, ...d.data() })); if (T.tab === 'dev') render(); }));
  T.devUnsubs.push(onSnapshot(query(collection(X.db, 'role_requests'), where('status', '==', 'pending')), (s) => { T.reqs = []; s.forEach(d => T.reqs.push({ id: d.id, ...d.data() })); if (T.tab === 'dev') render(); }));
  getDoc(doc(X.db, 'system_config', 'github_settings')).then(s => { T.runner = s.exists() ? s.data() : {}; if (T.tab === 'dev') render(); }).catch(() => { T.runner = {}; });
}
export function signedOut() { T.devUnsubs.forEach(u => u()); T.devUnsubs = []; T.known.clear(); toggle(false); }

function renderDev(body) {
  devSubscribe();
  const cur = T.runner ? Object.entries(RUNNERS).find(([, v]) => v.owner === T.runner.active_owner)?.[0] : null;
  const pick = T.runnerPick || cur || 'main', q = (T.userQ || '').toLowerCase();
  const users = (T.users || []).filter(u => !q || String(u.email || '').toLowerCase().includes(q)).sort((a, b) => String(a.email).localeCompare(String(b.email)));
  body.innerHTML = `
    <section class="devsec"><div class="rowbetween"><b>Global runner</b><small class="muted">${T.runner ? `Now: ${esc(T.runner.active_owner || 'not set')}` : 'Loading…'}</small></div>
      <small class="muted">Which GitHub account's Actions run every HOCO job.</small>
      <div class="runners">${Object.entries(RUNNERS).map(([k, v]) => `<label class="runner${pick === k ? ' on' : ''}"><input type="radio" name="runner" value="${k}" ${pick === k ? 'checked' : ''}><span><b>${v.label}</b><small>${v.owner} / ${v.repo}</small></span>${cur === k ? '<span class="tag live">Active</span>' : ''}</label>`).join('')}</div>
      <button class="btn primary" id="saveRunner" ${pick === cur ? 'disabled' : ''}>Switch runner</button></section>
    <section class="devsec"><b>Accuracy &amp; AI Lab</b><small class="muted">Unified Traditional vs AI evaluation uses daily ML stats. Optionally run legacy live recalculation or open the full AI Lab.</small>
      <div class="chips"><button class="btn" id="recalc">Recalculate live stats</button><a class="btn" href="ai-lab.html">Open full AI Lab</a></div></section>
    <section class="devsec"><div class="rowbetween"><b>Access requests</b><span class="tag">${T.reqs ? T.reqs.length : '…'}</span></div>
      ${T.reqs == null ? '<small class="muted">Loading…</small>' : !T.reqs.length ? '<small class="muted">No pending requests.</small>' : T.reqs.map(r => `<div class="req"><div><b>${esc(r.email)}</b> wants <b>${esc(r.requestedRole)}</b></div>
        <small class="muted">${esc(r.social)} · ${esc(r.reason)}</small><div class="chips"><button class="btn primary sm" data-ok="${esc(r.id)}">Approve</button><button class="btn sm" data-no="${esc(r.id)}">Reject</button></div></div>`).join('')}</section>
    <section class="devsec"><div class="rowbetween"><b>Users</b><small class="muted">${T.users ? T.users.length : '…'}</small></div>
      <small class="muted">G guest · N normal · E exclusive · API external developer · D developer</small>
      <input id="userQ" placeholder="Search by email" value="${esc(T.userQ || '')}">
      <div class="userlist">${T.users == null ? '<small class="muted">Loading…</small>' : users.slice(0, 60).map(u => `<div class="urow"><span>${esc(u.email || u.id)}</span>
        <span class="rolechips" role="group" aria-label="Role for ${esc(u.email)}">${ROLES.map(([k, l]) => `<button data-role="${esc(u.id)}" data-v="${k}" title="${l}" aria-pressed="${(u.role || 'normal') === k}">${{ guest: 'G', normal: 'N', exclusive: 'E', external_developer: 'API', developer: 'D' }[k]}</button>`).join('')}</span></div>`).join('')}
        ${users.length > 60 ? `<small class="muted">Showing 60 of ${users.length}. Search to narrow.</small>` : ''}</div></section>`;
  body.querySelectorAll('[name=runner]').forEach(i => i.onchange = () => { T.runnerPick = i.value; render(); });
  $('saveRunner').onclick = async () => {
    const c = RUNNERS[pick];
    try { await updateDoc(doc(X.db, 'system_config', 'github_settings'), { active_owner: c.owner, active_repo: c.repo }); T.runner = { ...T.runner, active_owner: c.owner, active_repo: c.repo }; T.runnerPick = null; X.toast(`Runner switched to ${c.owner}`); render(); }
    catch (e) { X.toast('Could not switch the runner'); }
  };
  $('recalc').onclick = async (ev) => { const b = ev.currentTarget; b.disabled = true; b.textContent = 'Calculating…';
    try { await httpsCallable(getFunctions(X.app, 'us-central1'), 'calculateAutoAccuracy')(); X.toast('Live stats recalculated'); } catch (e) { X.toast('Recalculation failed'); }
    finally { b.disabled = false; b.textContent = 'Recalculate live stats'; } };
  body.querySelectorAll('[data-ok]').forEach(b => b.onclick = async () => { const r = T.reqs.find(x => x.id === b.dataset.ok);
    try { await updateDoc(doc(X.db, 'users', r.userId), { role: r.requestedRole }); await updateDoc(doc(X.db, 'role_requests', r.id), { status: 'approved' }); X.toast('Approved'); } catch (e) { X.toast('Could not approve'); } });
  body.querySelectorAll('[data-no]').forEach(b => b.onclick = async () => { try { await updateDoc(doc(X.db, 'role_requests', b.dataset.no), { status: 'rejected' }); X.toast('Rejected'); } catch (e) { X.toast('Could not reject'); } });
  $('userQ').oninput = (e) => { T.userQ = e.target.value; const pos = e.target.selectionStart; render(); const i = $('userQ'); i.focus(); i.setSelectionRange(pos, pos); };
  body.querySelectorAll('[data-role]').forEach(b => b.onclick = async () => { try { await updateDoc(doc(X.db, 'users', b.dataset.role), { role: b.dataset.v }); X.toast('Role updated'); } catch (e) { X.toast('Could not update the role'); } });
}
