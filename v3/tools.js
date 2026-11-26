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
let T = { open: false, tab: 'runs', filter: 'all', product: 'all', region: null, date: null, archive: null, archiveKey: '', showMore: false,
  ens: { key: '', src: 'automated', mix: 50, sel: new Set(), w: {}, busy: false },
  man: { scen: [], model: 'swisseu', scenMode: 'standard', showAllOpts: false, busy: false, notify: true },
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
  const body = $('toolsBody'), keep = T.lastTab === T.tab ? body.scrollTop : 0;
  T.lastTab = T.tab;
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

function forecastsOn(date, overlapping = false, regionOpt = undefined) {
  loadArchive(date);
  if (!T.archive || T.archiveKey !== date) return null;
  const reg = regionOpt === undefined ? X.S.region : regionOpt;
  const byId = new Map(T.archive.map(r => [r.id, r]));
  X.S.runs.forEach(r => byId.set(r.id, r));          // live copies win (status changes while processing)
  return [...byId.values()].filter(r => visible(r) && (reg === 'all' || X.regionMatches(reg, r)) && X.startOf(r) && (dateKey(X.startOf(r)) === date ||
      overlapping && dateKey(X.startOf(r)) < date && X.endOf(r) && dateKey(X.endOf(r)) >= date))
    .sort((a, b) => (X.created(b)?.getTime() || 0) - (X.created(a)?.getTime() || 0));
}

function matchesProduct(r, product) {
  if (product === 'timing') return !!(hasHourcast(r) || r.forecastProduct === 'timing');
  if (product === 'ai') return r.type === 'ai' || r.forecastProduct === 'ai';
  if (product === 'automated') return ['automated', 'manual', 'human-mimic'].includes(r.type) && !['timing', 'ai'].includes(r.forecastProduct);
  return true;
}

function matchesSource(r, filter) {
  if (filter === 'mine') return r.userId === uid();
  if (filter === 'ens') return r.type === 'human-mimic';
  if (filter === 'manens') return !['automated', 'ai'].includes(r.type);
  if (filter === 'auto') return ['automated', 'ai'].includes(r.type);
  if (filter === 'pub') return r.public === true;
  return true;
}

function shortBadge(r) {
  if (isManualHourcast(r)) return { chip: 'HOURCAST', cls: 'beta' };
  if (T.product === 'timing' && hasHourcast(r)) return { chip: 'HOURCAST', cls: 'beta' };
  if (r.type === 'timing') return { chip: 'HOURCAST', cls: 'beta' };
  if (r.forecastProduct === 'timing' && r.type === 'human-mimic') return { chip: 'ENSEMBLE', cls: 'ens' };
  if (r.type === 'manual' && (r.forecastProduct === 'ai' || (!r.forecastProduct && r.ml?.mode && r.ml.mode !== 'hand_weights'))) return { chip: 'MANUAL AI', cls: 'beta' };
  if (r.type === 'ai') return { chip: 'AI', cls: 'beta' };
  if (r.type === 'automated') return { chip: 'AUTO', cls: 'live' };
  if (r.type === 'human-mimic') return { chip: 'ENSEMBLE', cls: 'ens' };
  return { chip: 'MANUAL TRAD', cls: 'arch' };
}

function runRow(r, activeId, showRegion) {
  const b = shortBadge(r), c = X.created(r), s = X.startOf(r), e = X.endOf(r), mine = r.userId === uid();
  const isAct = r.id === activeId;
  let right;
  if (isPending(r)) {
    const mins = c ? Math.max(0, Math.round((Date.now() - c.getTime()) / 60000)) : 0;
    right = `<span class="proc"><span class="spin"></span><span>Processing<br><small>${mins}/${estMinutes(r)} min</small></span></span>`;
  } else if (isFailed(r)) {
    right = `<span class="tag" style="color:#b42318">Failed</span>`;
  } else {
    right = `<div class="run-actions">
      ${(T.product !== 'timing' && !isManualHourcast(r)) || !hasHourcast(r) ? `<button class="btn" data-open="${esc(r.id)}">${X.comparing?.() ? 'Compare' : (isAct ? 'Viewing' : 'View')}</button>` : ''}
      ${hasHourcast(r) ? `<button class="btn" data-timed="${esc(r.id)}">${isManualHourcast(r) || T.product === 'timing' ? 'Windows ▾' : 'Hourly ▾'}</button>` : ''}
    </div>`;
  }
  const lvl = r.severity?.maxLevel;
  const pk = T.product === 'timing' ? r.stormHourPeak : (X.S.peaks?.[r.id] ?? (r.stormHourPeak != null ? r.stormHourPeak : null));
  const badges = [
    lvl >= 1 ? `<span class="sev-pill l${lvl}">L${lvl}</span>` : '',
    pk != null ? `<span class="ri-peak">${pk >= 5 ? Math.round(pk) + '%' : '<5%'}</span>` : '',
    mine && !['automated', 'ai'].includes(r.type) ? '<span class="ri-yours">Yours</span>' : '',
    isAct ? '<span class="ri-on">On map</span>' : ''
  ].filter(Boolean).join('');
  const devPub = role() === 'developer' && !isPending(r) && r.public !== true && !isManualHourcast(r) && !r.privateHourcastEnsemble && r.type !== 'automated' && r.type !== 'ai'
    ? `<button class="linkbtn" data-pub="${esc(r.id)}">Make public</button>` : '';
  const scen = Array.isArray(r.scenarios) && r.scenarios.length ? ` · ${r.scenarios.length} model${r.scenarios.length > 1 ? 's' : ''}` : '';
  const srcs = r.type === 'human-mimic' && r.sourceRunCount ? ` · ${r.sourceRunCount} blended` : '';
  const regTag = showRegion && r.region ? ` · ${esc(r.region)}` : '';
  const issuedTag = c && dateKey(c) !== T.date ? ` · issued ${X.dayName(c)}` : '';
  return `<div class="runitem${isAct ? ' on' : ''}" data-run-id="${esc(r.id)}">
    <div class="ri-main">
      <div class="ri-top"><b>${c ? X.hhmm(c) : '–'}</b><span class="tag ${b.cls}">${b.chip}</span>${badges}</div>
      <small>Valid ${s ? `${X.dayName(s)} ${X.hhmm(s)}` : '–'} → ${e ? `${X.dayName(e)} ${X.hhmm(e)}` : '–'}${regTag}${issuedTag}${scen}${srcs}</small>
      ${devPub}
    </div>${right}</div>`;
}

function renderRuns(body) {
  const reg = T.region || X.S.region;
  const raw = forecastsOn(T.date, false, reg);
  const byProduct = raw ? raw.filter(r => matchesProduct(r, T.product)) : null;
  const list = byProduct ? byProduct.filter(r => matchesSource(r, T.filter)) : null;
  const d = new Date(T.date + 'T00:00:00'), todayKey = dateKey(new Date()), isToday = T.date === todayKey;
  const yestKey = dateKey(new Date(Date.now() - 864e5)), tomKey = dateKey(new Date(Date.now() + 864e5));
  const prodOpts = [['all', 'All'], ['automated', 'Traditional'], ['ai', 'AI HOCO'], ['timing', 'Hourcast']];
  const srcOpts = [['all', 'All'], ['auto', 'AUTO'], ['manens', 'Manual & Ens'], ['mine', 'My runs'], ['pub', 'Public']];
  const minePending = X.S.runs.filter(r => r.userId === uid() && isPending(r));
  const activeId = X.S.custom?.id || (!X.S.custom && X.S.current?.id) || null;
  const showRegion = reg === 'all';
  const shown = list ? (T.showMore ? list : list.slice(0, 40)) : [];
  const hasFilters = T.filter !== 'all' || T.product !== 'all' || reg === 'all' || (T.region && T.region !== X.S.region);

  let listHtml;
  if (list == null) {
    listHtml = '<div class="muted center"><span class="spin"></span> Loading runs…</div>';
  } else if (!shown.length) {
    listHtml = `<div class="t-empty">
      <b>No runs match these filters</b>
      <small>${esc(reg === 'all' ? 'All regions' : reg)} · ${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</small>
      <div class="chips" style="justify-content:center">
        ${hasFilters ? '<button class="btn sm" id="rResetFilters">Reset filters</button>' : ''}
        ${!isToday ? '<button class="btn sm" id="rJumpToday">Jump to today</button>' : ''}
        ${role() !== 'guest' ? '<button class="btn primary sm" id="rBuildNew">Build a run</button>' : ''}
      </div>
    </div>`;
  } else if (T.filter === 'all') {
    const proc = shown.filter(r => isPending(r));
    const custom = shown.filter(r => !isPending(r) && !['automated', 'ai'].includes(r.type));
    const auto = shown.filter(r => !isPending(r) && ['automated', 'ai'].includes(r.type));
    listHtml = [
      proc.length ? `<div class="t-subhead"><span>Processing</span><span>${proc.length}</span></div>${proc.map(r => runRow(r, activeId, showRegion)).join('')}` : '',
      custom.length ? `<div class="t-subhead"><span>Manual &amp; Ensembles</span><span>${custom.length}</span></div>${custom.map(r => runRow(r, activeId, showRegion)).join('')}` : '',
      auto.length ? `<div class="t-subhead"><span>Scheduled AUTO &amp; AI</span><span>${auto.length}</span></div>${auto.map(r => runRow(r, activeId, showRegion)).join('')}` : ''
    ].filter(Boolean).join('');
  } else {
    listHtml = `<div class="t-subhead"><span>Matching runs · newest first</span><span>${list.length}</span></div>${shown.map(r => runRow(r, activeId, showRegion)).join('')}`;
  }

  body.innerHTML = `
    <div class="t-intro"><b>Browse &amp; load runs</b><p>Pick a date and region, filter by forecast type, or open your own manual and ensemble runs.</p></div>
    ${X.comparing?.() ? '<div class="t-banner">Comparing maps: tap any run below to place it into your comparison.</div>' : ''}
    ${minePending.length ? `<div class="note good"><span class="spin"></span><div><b>${minePending.length} run${minePending.length > 1 ? 's' : ''} processing</b><br><small>You can keep using HOCO. We'll notify you when ${minePending.length > 1 ? 'each one is' : "it's"} ready.</small></div></div>` : ''}
    <div class="t-card">
      <div class="t-bar"><label class="t-inline-lbl" for="rRegion">Region</label>
        <select id="rRegion">
          <option value="all" ${reg === 'all' ? 'selected' : ''}>All regions</option>
          ${X.REGIONS.filter(x => x.west !== undefined).map(x => `<option value="${esc(x.id)}" ${reg === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
        </select></div>
      <div class="datebar">
        <button class="btn icon" id="dPrev" aria-label="Previous day">‹</button>
        <label class="dateinput"><span class="sr">Forecasts valid on</span><input type="date" id="dPick" value="${T.date}" max="${dateKey(new Date(Date.now() + 2 * 864e5))}"></label>
        <button class="btn icon" id="dNext" aria-label="Next day">›</button>
      </div>
      <div class="t-quick">
        <button class="chipbtn" data-jump="${yestKey}" aria-pressed="${T.date === yestKey}">Yesterday</button>
        <button class="chipbtn" data-jump="${todayKey}" aria-pressed="${T.date === todayKey}">Today</button>
        <button class="chipbtn" data-jump="${tomKey}" aria-pressed="${T.date === tomKey}">Tomorrow</button>
      </div>
    </div>
    <div class="t-card">
      <div class="field"><span class="kicker">Forecast type</span>
        <div class="seg wide t-seg" role="group" aria-label="Forecast product">
          ${prodOpts.map(([k, l]) => `<button data-forecast="${k}" aria-pressed="${T.product === k}">${l}</button>`).join('')}
        </div></div>
      <div class="field"><span class="kicker">Source</span>
        <div class="chips">${srcOpts.map(([k, l]) => {
          const cnt = byProduct ? byProduct.filter(r => matchesSource(r, k)).length : null;
          return `<button class="chipbtn" aria-pressed="${T.filter === k}" data-f="${k}">${l}${cnt != null ? ` <small>${cnt}</small>` : ''}</button>`;
        }).join('')}</div></div>
    </div>
    <div class="runlist">${listHtml}</div>
    ${list && list.length > shown.length ? `<button class="btn" id="moreRuns">Show all ${list.length} runs</button>` : ''}
    <div class="adslot hidden" data-ad="runs"></div>`;

  const shift = (n) => { const x = new Date(T.date + 'T00:00:00'); x.setDate(x.getDate() + n); T.date = dateKey(x); T.showMore = false; render(); };
  $('rRegion').onchange = (e) => { T.region = e.target.value === X.S.region ? null : e.target.value; T.showMore = false; render(); };
  $('dPrev').onclick = () => shift(-1); $('dNext').onclick = () => shift(1);
  $('dPick').onchange = (e) => { if (e.target.value) { T.date = e.target.value; T.showMore = false; render(); } };
  body.querySelectorAll('[data-jump]').forEach(b => b.onclick = () => { T.date = b.dataset.jump; T.showMore = false; render(); });
  body.querySelectorAll('[data-forecast]').forEach(b => b.onclick = () => { T.product = b.dataset.forecast; T.showMore = false; render(); });
  body.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { T.filter = b.dataset.f; T.showMore = false; render(); });
  $('rResetFilters') && ($('rResetFilters').onclick = () => { T.product = 'all'; T.filter = 'all'; T.region = null; T.showMore = false; render(); });
  $('rJumpToday') && ($('rJumpToday').onclick = () => { T.date = todayKey; T.showMore = false; render(); });
  $('rBuildNew') && ($('rBuildNew').onclick = () => { T.tab = 'manual'; render(); });
  $('moreRuns') && ($('moreRuns').onclick = () => { T.showMore = true; render(); });
  body.querySelectorAll('[data-timed]').forEach(b => b.onclick = () => pickRunWindow(b, list.find(r => r.id === b.dataset.timed)));
  body.querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
    const r = [...X.S.runs, ...(T.archive || [])].find(x => x.id === b.dataset.open); if (!r) return;
    if (X.comparing?.()) { X.loadTo(r); return; }
    X.showCustom(r); if (innerWidth <= 640) toggle(false); else render();
  });
  body.querySelectorAll('.runitem[data-run-id]').forEach(row => row.onclick = (ev) => {
    if (ev.target.closest('button, a, input, select')) return;
    const openBtn = row.querySelector('[data-open]');
    if (openBtn) openBtn.click();
    else row.querySelector('[data-timed]')?.click();
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
    panel.innerHTML = `<div class="rowbetween"><span class="kicker">Pick a window (${windows.length})</span>
      ${!X.comparing() ? '<button class="linkbtn" data-hc-full>Open full timeline →</button>' : ''}</div>
      <div class="hc-grid">${windows.map((w, i) => {
        const st = X.startOf(w), en = X.endOf(w);
        const lbl = st && en ? `${X.hhmm(st)}–${X.hhmm(en)}` : esc(w.windowValidity);
        const lvl = w.severity?.maxLevel;
        return `<button class="hc-win" data-win-idx="${i}"><span>${esc(lbl)}</span>${lvl >= 1 ? `<span class="sev-pill l${lvl}">L${lvl}</span>` : ''}</button>`;
      }).join('')}</div>`;
    panel.querySelector('[data-hc-full]')?.addEventListener('click', () => X.openHourcast(source));
    panel.querySelectorAll('[data-win-idx]').forEach(btn => btn.onclick = () => {
      const win = windows[+btn.dataset.winIdx];
      if (X.comparing()) X.loadTo(win);
      else X.openHourcast(source, win);
    });
    panel.querySelector('[data-win-idx]')?.focus({ preventScroll: true });
  } catch {
    if (panel.isConnected) panel.textContent = 'Could not load the Hourcast windows.';
  }
}

// ---------------------------------------------------------------- shared workflow helpers
function stepHeader(num, title, sub = '', meta = '', metaCls = '') {
  return `<div class="t-step"><span class="t-num">${num}</span><div class="t-stitle"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</div>${meta ? `<span class="t-meta${metaCls ? ' ' + metaCls : ''}">${meta}</span>` : ''}</div>`;
}

function humanDayLabel(d) {
  const k = dateKey(d), today = dateKey(new Date());
  if (k === today) return 'Today';
  if (k === dateKey(new Date(Date.now() + 864e5))) return 'Tomorrow';
  if (k === dateKey(new Date(Date.now() - 864e5))) return 'Yesterday';
  return X.dayDate(d);
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
function effWeight(E, r, dw) {
  if (E.wmode === 'custom') return E.w[r.id] ?? dw[r.id] ?? 1;
  if (E.wmode === 'equal') return 1;
  return dw[r.id] ?? 1;
}

const ENS_PRODS = [
  ['automated', 'Traditional', 'Physics blend runs'],
  ['ai', 'AI HOCO', 'ML-calibrated runs'],
  ['both', 'Trad + AI', 'Mix both products'],
  ['timing', 'Hourcast', 'Matching time windows']
];
const ENS_HINTS = {
  automated: 'Blend recent AUTO-HOCO runs covering the same forecast day.',
  ai: 'Blend recent AI HOCO runs covering the same forecast day.',
  both: 'Combine Traditional and AI HOCO runs and adjust the balance between them.',
  timing: 'Blend Hourcast runs from different issue times that share the exact same window.'
};

function renderEnsemble(body) {
  if (role() === 'guest') { body.innerHTML = '<div class="note">Sign in with a free account to build ensembles.</div>'; return; }
  const E = T.ens, timed = E.src === 'timing';
  const prodHtml = `<div class="ens-prods" role="group" aria-label="Forecast product">
    ${ENS_PRODS.map(([k, title, sub]) => `<button class="ens-prod-btn" data-ens-product="${k}" aria-pressed="${E.src === k}"><b>${title}</b><small>${sub}</small></button>`).join('')}
  </div><p class="t-helper">${ENS_HINTS[E.src] || ''}</p>`;
  if (timed) renderHourcastEnsemble(body, prodHtml);
  else renderEnsembleControls(body, ensembleGroups(), prodHtml, false);
  body.querySelectorAll('[data-ens-product]').forEach(button => button.onclick = () => {
    if (E.busy) return;
    E.sel = new Set(); E.w = {};
    E.src = button.dataset.ensProduct; E.key = ''; E.seed = null;
    render();
  });
}

function renderHourcastEnsemble(body, prodHtml) {
  const E = T.ens;
  E.date ||= dateKey(X.addDays(X.baseDay(), X.S.day));
  const list = forecastsOn(E.date, true, X.S.region);
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
        const k = start.toISOString() + '/' + end.toISOString();
        if (!groups.has(k)) groups.set(k, { key: k, start, end, label: run.windowValidity, runs: [] });
        groups.get(k).runs.push(run);
      }
      E.groups = [...groups.values()].sort((a, b) => a.start - b.start || a.end - b.end);
      if (T.tab === 'ensemble' && E.src === 'timing') render();
    }).catch(() => {
      if (E.windowsKey !== key) return;
      E.groups = []; E.windowError = true;
      if (T.tab === 'ensemble' && E.src === 'timing') render();
    });
  }
  const datePicker = `<div class="field"><span class="kicker">Hourcast date</span>
    <div class="datebar"><button class="btn icon" id="edPrev" aria-label="Previous day">‹</button>
      <input type="date" id="ensDate" value="${E.date}">
      <button class="btn icon" id="edNext" aria-label="Next day">›</button></div></div>`;
  const groups = key && E.windowsKey === key ? E.groups : null;
  if (groups?.length) {
    renderEnsembleControls(body, groups, `${prodHtml}${datePicker}`, true);
  } else {
    body.innerHTML = `<div class="t-intro"><b>Ensemble builder</b><p>Combine multiple runs into one consensus outlook with model spread.</p></div>
      <div class="t-card">${stepHeader(1, 'Choose what to blend', `${esc(X.S.region)}`)}${prodHtml}${datePicker}</div>
      <div class="t-empty" role="status"><b>${E.windowError && groups ? 'Could not load windows' : groups ? 'No Hourcast windows on this date' : 'Loading Hourcast windows…'}</b>
        <small>${groups ? 'Try another date or pick a different forecast product above.' : 'Checking saved runs for matching time windows.'}</small></div>`;
  }
  const shiftE = (n) => { if (E.busy) return; const x = new Date(E.date + 'T00:00:00'); x.setDate(x.getDate() + n); E.date = dateKey(x); E.key = ''; E.seed = null; render(); };
  $('edPrev') && ($('edPrev').onclick = () => shiftE(-1));
  $('edNext') && ($('edNext').onclick = () => shiftE(1));
  $('ensDate') && ($('ensDate').onchange = e => { if (e.target.value && !E.busy) { E.date = e.target.value; E.key = ''; E.seed = null; render(); } });
}

function renderEnsembleControls(body, groups, step1Controls, timed = false) {
  const E = T.ens;
  if (!groups.length) {
    body.innerHTML = `<div class="t-intro"><b>Ensemble builder</b><p>Combine multiple runs into one consensus outlook with model spread.</p></div>
      <div class="t-card">${stepHeader(1, 'Choose what to blend', `${esc(X.S.region)}`)}${step1Controls}</div>
      <div class="t-empty"><b>No finished runs to blend yet</b><small>Nothing available for ${esc(X.S.region)} in this category.</small></div>`;
    return;
  }
  const want = dateKey(X.addDays(X.baseDay(), X.S.day));
  let grp = groups.find(x => x.key === E.key) || (timed ? groups.find(x => x.runs.length >= 2) : groups.find(x => x.key === want)) || groups.at(-1);
  if (grp.key !== E.key) { E.key = grp.key; E.sel = new Set(); E.w = {}; }
  const pool = grp.runs.filter(r => timed || E.src === 'both' || r.type === E.src);
  const dw = defaultWeights(pool);
  pool.forEach(r => { if (E.w[r.id] == null) E.w[r.id] = dw[r.id]; });
  if (E.seed !== `${grp.key}|${E.src}`) { E.seed = `${grp.key}|${E.src}`; E.sel = new Set(pool.slice(-6).map(r => r.id)); }
  if (E.wmode !== 'custom' && E.wmode !== 'equal') E.wmode = 'auto';

  const effMap = Object.fromEntries(pool.map(r => [r.id, effWeight(E, r, dw)]));
  const chosen = pool.filter(r => E.sel.has(r.id));
  const mixOn = E.src === 'both' && chosen.some(r => r.type === 'ai') && chosen.some(r => r.type === 'automated');
  const share = (r, m = E.mix) => !mixOn ? 1 : (r.type === 'ai' ? (100 - m) / 50 : m / 50);
  const computeShares = (m = E.mix) => {
    const raw = Object.fromEntries(chosen.map(r => [r.id, effMap[r.id] * share(r, m)]));
    const tot = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
    const pct = Object.fromEntries(chosen.map(r => [r.id, Math.round(raw[r.id] / tot * 100)]));
    const trad = chosen.filter(r => r.type !== 'ai').reduce((a, r) => a + raw[r.id], 0);
    const tradPct = Math.round(trad / tot * 100);
    return { pct, tradPct, aiPct: 100 - tradPct };
  };
  const shares = computeShares();
  const minReq = timed ? 2 : 1, readyToBuild = chosen.length >= minReq;
  const blendableCnt = timed ? groups.filter(x => x.runs.length >= 2).length : 0;
  const modeHint = E.wmode === 'custom'
    ? 'Drag any slider below to give that run more or less influence.'
    : E.wmode === 'equal'
      ? 'Every selected run has the exact same weight. Tap any bar or Custom to tweak.'
      : 'Newer runs count slightly more (1.0× to 1.4×). Tap any bar or Custom to tweak.';
  const weightSummary = E.wmode === 'custom' ? 'Custom weights' : E.wmode === 'equal' ? 'Equal weights' : 'Newer weighted';

  const step1Picker = timed
    ? `<label class="field"><div class="rowbetween"><span class="kicker">Valid window</span><small class="muted">${blendableCnt} of ${groups.length} ready to blend</small></div>
        <select id="enWindow">${groups.map(x => `<option value="${x.key}" ${x.key === grp.key ? 'selected' : ''}>${esc(x.label)} · ${x.runs.length >= 2 ? `✓ ${x.runs.length} runs` : '1 run · need 2+'}</option>`).join('')}</select>
        ${grp.runs.length < 2 ? '<div class="t-warn">This window only has 1 run. Pick a window marked ✓ to blend 2 or more runs.</div>' : ''}</label>`
    : `<div class="field"><span class="kicker">Valid day</span><div class="chips">${groups.map(x => {
        const cnt = E.src === 'both' ? x.runs.length : x.runs.filter(r => r.type === E.src).length;
        return `<button class="chipbtn ens-daybtn" aria-pressed="${x.key === grp.key}" data-g="${x.key}"><span>${humanDayLabel(x.start)}</span><small>${X.dayDate(x.start)} · ${cnt}</small></button>`;
      }).join('')}</div></div>`;

  const wlistHtml = !pool.length
    ? '<div class="t-empty"><b>No runs here yet</b><small>Try switching the product or day in Step 1.</small></div>'
    : pool.slice().reverse().map((r, idx) => {
      const c = X.created(r), on = E.sel.has(r.id), w = effMap[r.id], ti = typeInfo(r), p = on ? (shares.pct[r.id] ?? 0) : 0;
      const rightCtrl = !on
        ? '<span class="wexcl">Excluded</span>'
        : E.wmode === 'custom'
          ? `<input type="range" min="0.1" max="2" step="0.1" value="${w}" data-w="${esc(r.id)}" aria-label="Weight for run issued ${X.hhmm(c)}" style="--pct:${(w - 0.1) / 1.9 * 100}%"><output>${p}%</output>`
          : `<button type="button" class="wbar" data-wbar="${esc(r.id)}" title="Click to adjust weights" aria-label="${p}% share — click to customise"><i style="width:${p}%"></i></button><output>${p}%</output>`;
      return `<div class="wrow${E.wmode === 'custom' ? '' : ' ens-bar-row'}${on ? '' : ' off'}" data-wrow="${esc(r.id)}">
        <label class="chk"><input type="checkbox" data-sel="${esc(r.id)}" ${on ? 'checked' : ''}><span><b>${X.hhmm(c)}</b> <small>${idx === 0 ? 'Latest' : X.dayName(c)}</small></span></label>
        ${E.src === 'both' ? `<span class="tag ${ti.cls}">${ti.chip}</span>` : '<span></span>'}
        ${rightCtrl}
      </div>`;
    }).join('');

  body.innerHTML = `
    <div class="t-intro"><b>Ensemble builder</b><p>Combine multiple runs into one consensus outlook with model spread.</p></div>
    <div class="t-card">
      ${stepHeader(1, 'Choose what to blend', `${esc(X.S.region)}`, `${pool.length} available`)}
      ${step1Controls}
      ${step1Picker}
    </div>
    <div class="t-card">
      ${stepHeader(2, 'Select runs &amp; weights', 'Untick older runs or adjust their influence', `${chosen.length} of ${pool.length}`, readyToBuild ? 'ok' : 'bad')}
      <div class="t-quick">
        <button class="chipbtn" id="selLatest3">Latest 3</button>
        <button class="chipbtn" id="selLatest">Latest 6</button>
        <button class="chipbtn" id="selAll">All</button>
        <button class="chipbtn" id="selNone">Clear</button>
      </div>
      <div class="seg wide t-seg" role="group" aria-label="Weighting mode">
        <button data-wmode="auto" aria-pressed="${E.wmode === 'auto'}">Newer weighted</button>
        <button data-wmode="equal" aria-pressed="${E.wmode === 'equal'}">Equal</button>
        <button data-wmode="custom" aria-pressed="${E.wmode === 'custom'}">Custom</button>
      </div>
      <p class="t-helper">${modeHint}</p>
      ${mixOn ? `<div class="mix-card">
        <div class="rowbetween"><span class="kicker">Traditional vs AI share</span><b style="font-size:12px" id="mixReadout">Trad ${shares.tradPct}% · AI ${shares.aiPct}%</b></div>
        <div class="mix-bar" aria-hidden="true"><i class="mix-trad" id="mixBarTrad" style="width:${shares.tradPct}%"></i><i class="mix-ai"></i></div>
        <input type="range" id="mix" min="0" max="100" step="5" value="${E.mix}" aria-label="Traditional vs AI balance" style="--pct:${E.mix}%">
        <div class="ticks2"><span>Traditional ${E.mix}%</span><span>AI HOCO ${100 - E.mix}%</span></div>
      </div>` : ''}
      <div class="wlist">${wlistHtml}</div>
    </div>
    <div class="runfoot">
      <div class="runfoot-top">
        ${readyToBuild
          ? `<span class="t-sumline">Blending ${chosen.length} run${chosen.length === 1 ? '' : 's'} · ${esc(X.S.region)} · ${weightSummary}</span>`
          : `<div class="t-warn">Select at least ${minReq} run${minReq > 1 ? 's' : ''} above to build an ensemble.</div>`}
        <small id="ensStatus">${timed ? 'Saved privately to My runs in Hourcast format.' : 'Saved to My runs. Only visible to you unless made public.'}</small>
      </div>
      <div class="runfoot-acts">
        <button class="btn" id="resetW">Reset</button>
        <button class="btn primary big" id="buildEns" ${E.busy || !readyToBuild ? 'disabled' : ''}>${E.busy ? '<span class="spin light"></span> Building…' : `Build ensemble (${chosen.length})`}</button>
      </div>
    </div>`;

  const syncSharesUi = () => {
    const sh = computeShares();
    const ro = $('mixReadout'), mb = $('mixBarTrad');
    if (ro) ro.textContent = `Trad ${sh.tradPct}% · AI ${sh.aiPct}%`;
    if (mb) mb.style.width = sh.tradPct + '%';
    chosen.forEach(r => {
      const row = body.querySelector(`.wrow[data-wrow="${CSS.escape(r.id)}"]`); if (!row) return;
      const p = sh.pct[r.id] ?? 0;
      const out = row.querySelector('output'); if (out) out.textContent = p + '%';
      const bar = row.querySelector('.wbar i'); if (bar) bar.style.width = p + '%';
    });
  };

  body.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { E.key = b.dataset.g; E.sel = new Set(); E.w = {}; render(); });
  if ($('enWindow')) $('enWindow').onchange = e => { if (!E.busy) { E.key = e.target.value; E.sel = new Set(); E.w = {}; render(); } };
  $('mix') && ($('mix').oninput = (e) => {
    E.mix = +e.target.value;
    e.target.style.setProperty('--pct', E.mix + '%');
    const t = e.target.nextElementSibling.children;
    t[0].textContent = `Traditional ${E.mix}%`;
    t[1].textContent = `AI HOCO ${100 - E.mix}%`;
    syncSharesUi();
  });
  body.querySelectorAll('[data-sel]').forEach(c => c.onchange = () => { c.checked ? E.sel.add(c.dataset.sel) : E.sel.delete(c.dataset.sel); render(); });
  body.querySelectorAll('[data-wbar]').forEach(b => b.onclick = () => {
    const id = b.dataset.wbar;
    pool.forEach(r => { E.w[r.id] = effWeight(E, r, dw); });
    E.wmode = 'custom'; render();
    body.querySelector(`[data-w="${CSS.escape(id)}"]`)?.focus();
  });
  body.querySelectorAll('[data-w]').forEach(x => {
    x.oninput = () => {
      E.w[x.dataset.w] = +x.value; effMap[x.dataset.w] = +x.value;
      x.style.setProperty('--pct', (x.value - 0.1) / 1.9 * 100 + '%');
      syncSharesUi();
    };
  });
  body.querySelectorAll('[data-wmode]').forEach(b => b.onclick = () => {
    if (b.dataset.wmode === 'custom' && E.wmode !== 'custom') pool.forEach(r => { E.w[r.id] = effWeight(E, r, dw); });
    E.wmode = b.dataset.wmode; render();
  });
  $('selLatest3').onclick = () => { E.sel = new Set(pool.slice(-3).map(r => r.id)); render(); };
  $('selLatest').onclick = () => { E.sel = new Set(pool.slice(-6).map(r => r.id)); render(); };
  $('selAll').onclick = () => { E.sel = new Set(pool.map(r => r.id)); render(); };
  $('selNone').onclick = () => { E.sel = new Set(); render(); };
  $('resetW').onclick = () => { E.w = { ...dw }; E.wmode = 'auto'; E.sel = new Set(pool.slice(-6).map(r => r.id)); E.mix = 50; render(); };
  $('buildEns').onclick = () => buildEnsemble(grp, chosen, mixOn, timed, effMap);
}

async function buildEnsemble(grp, chosen, mixOn, timed, effWeights = T.ens.w) {
  const E = T.ens; if (E.busy) return;
  const weights = { ...effWeights }, mix = E.mix, region = X.S.region, user = uid();
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
    const entries = loaded.map(({ r, geojson }) => ({ geojson, weight: +((weights[r.id] ?? 1) * share(r)).toFixed(3), createdMs: X.created(r)?.getTime() || 0, r }));
    const geo = blendRuns(entries, X.BANDS, { allowQuiet: timed });
    const used = entries.filter(e => e.weight > 0);
    const area = X.REGIONS.find(item => item.id === region && Number.isFinite(item.west));
    if (area && used.length >= 2 && used.every(({ r }) => r.region === region)) {
      try {
        const { forecastSampler } = await import('./run-verification.js?v=7');
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

function nextHourLocal() {
  const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return localInput(d);
}
function dayAt06Local(offsetDays) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays); d.setHours(6, 0, 0, 0); return localInput(d);
}

function manualEst(nScen, hours) { return Math.max(2, Math.ceil((nScen || 6) * 35 * (hours / 24) / 60)); }
function renderManual(body) {
  const M = T.man, r = role(), cap = CAPS[r], canScen = r === 'exclusive' || r === 'developer', dev = r === 'developer';
  if (r === 'guest') { body.innerHTML = '<div class="note">Guests can\'t start runs. Sign in with a free account to build your own forecasts.</div>'; return; }
  if (!M.start) M.start = nextHourLocal();
  if (!M.len) M.len = 12;
  const st = new Date(M.start), en = M.customEnd && M.end ? new Date(M.end) : new Date(st.getTime() + M.len * 3.6e6);
  const rawHours = (en - st) / 3.6e6, hours = Math.max(1, rawHours || 12);
  const left = cap === Infinity ? Infinity : Math.max(0, cap - T.myToday), opts = runOptions(M.model, M.start);
  const chosenRegion = M.region || X.S.region, traditionalOnly = traditionalOnlyRegion(chosenRegion);
  if (traditionalOnly && M.product === 'ai') M.product = 'automated';
  const product = M.product || 'automated';
  const mode = product === 'ai' && !traditionalOnly ? 'learned' : 'custom';
  const productNote = product === 'timing'
    ? ' Manual Hourcast uses hourly windows up to 24 hours.'
    : product === 'automated' && hourcastRegion(chosenRegion)
      ? (hours <= 24 ? ' Automatically includes Hourcast windows too.' : ' Choose up to 24 hours to automatically include Hourcast windows too.')
      : '';

  const prodCards = [
    ['automated', 'Traditional', hourcastRegion(chosenRegion) ? 'Full period + Hourcast ≤24 h' : 'Full forecast period'],
    ...(!traditionalOnly ? [['ai', 'AI HOCO', 'ML-calibrated full period']] : []),
    ['timing', 'Hourcast', 'Hourly · max 24 h']
  ];

  let timeErr = '';
  if (!M.start || isNaN(st) || isNaN(en)) timeErr = 'Choose a valid start and end time.';
  else if (st >= en) timeErr = 'End time must be after start time.';
  else if (product === 'timing' && !hourcastRegion(chosenRegion)) timeErr = 'Hourcast is not supported for this region.';
  else if (product === 'timing' && rawHours > 24) timeErr = 'Manual Hourcast covers up to 24 hours. Shorten the duration or choose Traditional.';
  else if (r !== 'developer' && rawHours > 72) timeErr = 'A manual run can cover up to 72 hours.';

  const presets = [
    ['next12', 'Next 12 h', nextHourLocal(), 12],
    ['next24', 'Next 24 h', nextHourLocal(), 24],
    ['today06', 'Today 06–06', dayAt06Local(0), 24],
    ['tom06', 'Tomorrow 06–06', dayAt06Local(1), 24]
  ];

  const activeScen = canScen && M.scenMode === 'custom' ? M.scen : [];
  const totW = M.scen.reduce((a, x) => a + (+x.weight || 1), 0) || 1;
  const visibleOpts = M.showAllOpts ? opts : opts.slice(0, 8);
  const autoHcBadge = product === 'automated' && hourcastRegion(chosenRegion) && !timeErr && rawHours <= 24;

  const step3Body = canScen ? `
    ${stepHeader(3, 'Weather models', 'Leave on Standard blend or hand-pick specific model runs', M.scenMode === 'custom' && M.scen.length ? `${M.scen.length} selected` : 'Standard')}
    <div class="seg wide t-seg" role="group" aria-label="Model selection mode">
      <button data-scen-mode="standard" aria-pressed="${M.scenMode !== 'custom'}">Standard blend</button>
      <button data-scen-mode="custom" aria-pressed="${M.scenMode === 'custom'}">Custom runs${M.scen.length ? ` (${M.scen.length})` : ''}</button>
    </div>
    ${M.scenMode !== 'custom'
      ? `<p class="t-helper">Uses the latest runs from HOCO's full weather-model suite${mode === 'learned' ? ' with AI learned weights' : ''}. Recommended for most forecasts.</p>`
      : `${mode === 'learned' ? '<p class="t-helper">AI HOCO applies its learned weights to whichever runs you add below.</p>' : ''}
        <div class="rowbetween"><button class="btn sm" id="mAddLatestAll">Add latest of each model</button>${M.scen.length ? `<button class="linkbtn" id="mClearScen">Clear all (${M.scen.length})</button>` : ''}</div>
        <div class="chips modelchips">${Object.entries(MODELS).map(([k, m]) => {
          const cnt = M.scen.filter(x => x.model === k).length;
          return `<button class="chipbtn" data-model="${k}" aria-pressed="${k === M.model}">${m.name}${cnt ? ` <b>${cnt}</b>` : ''}</button>`;
        }).join('')}</div>
        <div class="scen-grid">${visibleOpts.map(o => {
          const added = M.scen.some(x => x.model === M.model && x.run === o.iso);
          return `<button class="chipbtn" data-iso="${o.iso}" aria-pressed="${added}" title="${added ? 'Click to remove' : 'Click to add'}">${added ? '✓ ' : ''}${o.label}</button>`;
        }).join('')}</div>
        ${opts.length > 8 ? `<button class="linkbtn" id="mMoreOpts" style="align-self:flex-start">${M.showAllOpts ? 'Show fewer runs' : `Show ${opts.length - 8} older ${MODELS[M.model].name} runs`}</button>` : ''}
        ${M.scen.length ? `<div class="wlist">${M.scen.map((x, i) => {
          const pct = Math.round((+x.weight || 1) / totW * 100);
          return `<div class="wrow scen-row${mode === 'learned' ? ' learned-row' : ''}" data-srow="${i}">
            <span class="scenlabel"><b>${esc(MODELS[x.model]?.name || x.model)}</b> <small>${esc(x.runLabel)}</small></span>
            ${mode === 'custom'
              ? `<input type="range" min="0.1" max="2" step="0.1" value="${x.weight}" data-sw="${i}" aria-label="Weight for ${esc(MODELS[x.model]?.name || x.model)} ${esc(x.runLabel)}" style="--pct:${(x.weight - 0.1) / 1.9 * 100}%"><output>×${(+x.weight).toFixed(1)} · ${pct}%</output>`
              : '<span class="tag beta">Learned</span>'}
            <button class="btn icon sm" data-rm="${i}" aria-label="Remove">✕</button></div>`;
        }).join('')}</div>`
          : '<p class="t-helper">Tap any run times above to add them immediately — or switch models and pick several runs.</p>'}`}
    ${dev ? `<details class="field devbox" ${M.devOpen ? 'open' : ''}><summary><span class="kicker">Developer · override backend weights</span></summary>
      <small class="muted">${mode === 'learned' ? 'Ignored when AI HOCO is selected; applies to Traditional &amp; Hourcast only.' : 'Leave blank to use the backend default weight for each model.'}</small>
      <div class="grid3">${Object.entries(MODELS).map(([k, m]) => `<label><small>${m.name}</small><input type="number" step="0.1" min="0" id="mw-${k}" placeholder="default" value="${M.w?.[k] ?? ''}"></label>`).join('')}</div></details>` : ''}`
    : `${stepHeader(3, 'Weather models', '', 'Standard blend')}
       <p class="t-helper">Uses HOCO's full multi-model blend automatically. Exclusive accounts can pick individual model runs and weights.</p>`;

  body.innerHTML = `
    <div class="t-intro"><b>Build a custom run</b><p>Start an on-demand HOCO forecast for any region and time window — live or archived.</p></div>
    <div class="t-card">
      ${stepHeader(1, 'Forecast type &amp; region')}
      <div class="field"><span class="kicker">Forecast product</span>
        <div class="prod-cards${traditionalOnly ? ' cols2' : ''}" role="group" aria-label="Forecast product">
          ${prodCards.map(([k, title, sub]) => `<button class="prod-card" data-manual-product="${k}" aria-pressed="${product === k}"><b>${title}</b><small>${sub}</small></button>`).join('')}
        </div>
        <small class="muted">${PRODUCTS[product].detail}${productNote}</small>
      </div>
      <div class="field"><span class="kicker">Region</span>
        <div class="chips">${X.REGIONS.filter(x => x.west !== undefined && (product !== 'timing' || hourcastRegion(x.id))).map(x => `<button class="chipbtn" data-reg="${x.id}" aria-pressed="${x.id === chosenRegion}">${x.name}</button>`).join('')}</div>
        ${traditionalOnly ? `<p class="t-helper">AI HOCO is not trained for ${esc(chosenRegion)} yet, so Traditional is used.</p>` : ''}
      </div>
    </div>
    <div class="t-card">
      ${stepHeader(2, 'Forecast time window', 'Local time — works for live or archived dates', timeErr ? 'Check time' : `${Math.round(hours)} h`, timeErr ? 'bad' : 'ok')}
      <div class="t-quick">${presets.map(([pid, plbl, pstart, plen]) =>
        `<button class="chipbtn" data-tpreset="${pid}" aria-pressed="${!M.customEnd && M.start === pstart && M.len === plen}">${plbl}</button>`).join('')}</div>
      <label class="field"><span class="kicker">Starts</span><input type="datetime-local" id="mStart" value="${M.start}"></label>
      <div class="field">
        <div class="rowbetween"><span class="kicker">Length</span><button class="linkbtn" id="mCustomEnd">${M.customEnd ? 'Use preset length' : 'Pick an end time'}</button></div>
        <div class="chips">${[3, 6, 12, 24].map(h => `<button class="chipbtn" data-h="${h}" aria-pressed="${!M.customEnd && M.len === h}">${h} h</button>`).join('')}</div>
      </div>
      ${M.customEnd ? `<label class="field"><span class="kicker">Ends</span><input type="datetime-local" id="mEnd" value="${M.end || localInput(en)}"></label>` : ''}
      ${timeErr
        ? `<div class="t-warn" id="mTimeWarn">${timeErr}</div>`
        : `<div class="t-period-preview"><span>Covers <b>${X.dayDate(st)} ${X.hhmm(st)}</b> → <b>${X.dayDate(en)} ${X.hhmm(en)}</b></span>${autoHcBadge ? '<span class="t-ok">+ Auto Hourcast</span>' : ''}</div>`}
    </div>
    <div class="t-card">${step3Body}</div>
    <label class="chk"><input type="checkbox" id="mNotify" ${M.notify ? 'checked' : ''}><span>Notify me when it's ready</span></label>
    <div class="runfoot">
      <div class="runfoot-top">
        <span class="t-sumline">${esc(chosenRegion)} · ${PRODUCTS[product].label}${autoHcBadge ? ' + Hourcast' : ''} · ${timeErr ? 'check period' : `${Math.round(hours)} h`} · ${activeScen.length ? `${activeScen.length} custom run${activeScen.length > 1 ? 's' : ''}` : 'Standard blend'}</span>
        <small>${cap === Infinity ? 'Unlimited runs' : `${left} of ${cap} runs left today`} · Takes about ${manualEst(activeScen.length, hours)} min</small>
      </div>
      <div class="runfoot-acts">
        <button class="btn primary big" id="mGo" ${M.busy || (cap !== Infinity && !left) || !!timeErr ? 'disabled' : ''}>${M.busy ? '<span class="spin light"></span> Starting…' : `Run ${PRODUCTS[product].label}`}</button>
      </div>
    </div>`;

  body.querySelectorAll('[data-manual-product]').forEach(b => b.onclick = () => {
    M.product = b.dataset.manualProduct;
    if (M.product === 'timing' && !hourcastRegion(chosenRegion)) M.region = 'England';
    render();
  });
  body.querySelectorAll('[data-reg]').forEach(b => b.onclick = () => { M.region = b.dataset.reg; render(); });
  body.querySelectorAll('[data-tpreset]').forEach(b => b.onclick = () => {
    const p = presets.find(x => x[0] === b.dataset.tpreset); if (!p) return;
    M.start = p[2]; M.len = p[3]; M.customEnd = false; render();
  });
  $('mStart').onchange = (e) => { M.start = e.target.value || M.start; render(); };
  body.querySelectorAll('[data-h]').forEach(b => b.onclick = () => { M.len = +b.dataset.h; M.customEnd = false; render(); });
  $('mCustomEnd').onclick = () => { M.customEnd = !M.customEnd; if (M.customEnd && !M.end) M.end = localInput(en); render(); };
  $('mEnd') && ($('mEnd').onchange = (e) => { M.end = e.target.value; render(); });
  if (canScen) {
    body.querySelectorAll('[data-scen-mode]').forEach(b => b.onclick = () => { M.scenMode = b.dataset.scenMode; render(); });
    body.querySelectorAll('[data-model]').forEach(b => b.onclick = () => { M.model = b.dataset.model; render(); });
    body.querySelectorAll('[data-iso]').forEach(b => b.onclick = () => {
      const idx = M.scen.findIndex(x => x.model === M.model && x.run === b.dataset.iso);
      if (idx >= 0) M.scen.splice(idx, 1);
      else {
        const o = opts.find(x => x.iso === b.dataset.iso);
        if (o) M.scen.push({ model: M.model, run: o.iso, runLabel: o.label, weight: 1 });
      }
      render();
    });
    $('mAddLatestAll') && ($('mAddLatestAll').onclick = () => {
      Object.keys(MODELS).forEach(k => {
        const latest = runOptions(k, M.start)[0];
        if (latest && !M.scen.some(x => x.model === k && x.run === latest.iso)) M.scen.push({ model: k, run: latest.iso, runLabel: latest.label, weight: 1 });
      });
      render();
    });
    $('mClearScen') && ($('mClearScen').onclick = () => { M.scen = []; render(); });
    $('mMoreOpts') && ($('mMoreOpts').onclick = () => { M.showAllOpts = !M.showAllOpts; render(); });
    body.querySelectorAll('[data-sw]').forEach(x => x.oninput = () => {
      M.scen[+x.dataset.sw].weight = +x.value;
      x.style.setProperty('--pct', (x.value - 0.1) / 1.9 * 100 + '%');
      const tot = M.scen.reduce((a, it) => a + (+it.weight || 1), 0) || 1;
      M.scen.forEach((it, idx) => {
        const out = body.querySelector(`.wrow[data-srow="${idx}"] output`);
        if (out) out.textContent = `×${(+it.weight).toFixed(1)} · ${Math.round((+it.weight || 1) / tot * 100)}%`;
      });
    });
    body.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { M.scen.splice(+b.dataset.rm, 1); render(); });
  }
  if (dev && body.querySelector('.devbox')) {
    body.querySelector('.devbox').ontoggle = (e) => { M.devOpen = e.target.open; };
    Object.keys(MODELS).forEach(k => { const inp = $(`mw-${k}`); if (inp) inp.oninput = (e) => { M.w = { ...(M.w || {}), [k]: e.target.value }; }; });
  }
  $('mNotify').onchange = (e) => { M.notify = e.target.checked; };
  $('mGo').onclick = startManual;
}

async function startManual() {
  const M = T.man, r = role(), cap = CAPS[r];
  const sIn = M.start, s = new Date(sIn), e = M.customEnd && M.end ? new Date(M.end) : new Date(s.getTime() + (M.len || 12) * 3.6e6);
  if (!sIn || isNaN(s) || isNaN(e)) return X.toast('Choose when the run starts');
  if (s >= e) return X.toast('The start must be before the end');
  const product = M.product || 'automated';
  if (product === 'timing' && (!hourcastRegion(M.region || X.S.region) || e - s > 864e5)) {
    return X.toast('Choose a period up to 24 hours in a supported Hourcast region.');
  }
  if (r !== 'developer' && (e - s) / 3.6e6 > 72) return X.toast('A run can cover up to 72 hours');
  if (cap !== Infinity && T.myToday >= cap) return X.toast(`You've used all ${cap} runs for today`);
  M.busy = true; M.region = M.region || X.S.region; render();
  if (M.notify && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (err) { /* ignore */ } }
  // Normal users always get the standard blend, as on the classic site. Weights left blank use the backend defaults.
  const canScen = r === 'exclusive' || r === 'developer';
  const traditionalOnly = traditionalOnlyRegion(M.region);
  const learned = product === 'ai' && !traditionalOnly;
  const chosenScen = canScen && M.scenMode === 'custom' ? M.scen : [];
  const scenarios = chosenScen.map(x => ({ model: x.model, run: x.run, label: `${MODELS[x.model].name} (${x.runLabel})`, ...(learned ? {} : { weight: x.weight }) }));
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
    M.scen = []; M.scenMode = 'standard';
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
