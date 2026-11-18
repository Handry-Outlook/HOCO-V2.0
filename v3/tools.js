// HOCO v3 tools: runs browser, ensemble builder, manual runs, developer console.
// Writes the same Firestore documents as the classic site so both sites and the backend keep working.
import { collection, query, where, orderBy, limit, getDocs, addDoc, updateDoc, doc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js";
import { blendRuns } from './ensemble.js';

// Real model names and run frequency (hours), as in the classic manual builder.
const MODELS = { swisseu: { name: 'SWISS-EU', freq: 3 }, hardmi: { name: 'HARMONIE', freq: 3 }, swissnow: { name: 'SWISS-NOW', freq: 1 },
  ez: { name: 'ECMWF EZ', freq: 12 }, ukmo2km: { name: 'UKMO 2KM', freq: 6 }, rpdid2: { name: 'RPDID2', freq: 3 } };
const RUNNERS = { main: { owner: 'Handry-Outlook', repo: 'HOCO-BACKEND', label: 'Account 1' }, alt1: { owner: 'handry66', repo: 'HOCO-BACKEND-ALT1', label: 'Account 2' },
  alt2: { owner: 'Handry6', repo: 'HOCO-BACKEND-ALT2', label: 'Account 3' } };
const CAPS = { normal: 7, external_developer: 7, exclusive: 15, developer: Infinity };
const ROLES = [['guest', 'Guest'], ['normal', 'Normal'], ['exclusive', 'Exclusive'], ['external_developer', 'External developer'], ['developer', 'Developer']];

let X;               // context from the main page
let T = { open: false, tab: 'runs', filter: 'all', date: null, archive: null, archiveKey: '', showMore: false,
  ens: { key: '', src: 'automated', mix: 50, sel: new Set(), w: {}, busy: false },
  man: { scen: [], picked: new Set(), model: 'swisseu', busy: false, notify: true },
  known: new Map(), devUnsubs: [], runner: null, myToday: 0 };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtHoco = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const $ = (id) => document.getElementById(id);
const hasGeo = (r) => !!(r.geojsonUrl || r.inlineGeojson || r.inlineGeojsonText || r.geojson || r.ensembleGeojson);
const isPending = (r) => r.status === 'pending' || (!hasGeo(r) && r.status !== 'failed' && r.status !== 'error');
const isFailed = (r) => r.status === 'failed' || r.status === 'error';
const role = () => X.S.role;
const uid = () => X.auth.currentUser?.uid;

export function typeInfo(r) {
  if (r.type === 'ai') return { label: 'AI HOCO', chip: 'AI', cls: 'beta' };
  if (r.type === 'automated') return { label: 'AUTO-HOCO', chip: 'AUTO', cls: 'live' };
  if (r.type === 'human-mimic') return { label: 'HOCO Ensemble', chip: 'ENSEMBLE', cls: 'ens' };
  return { label: 'Manual HOCO', chip: r.userId === uid() ? 'MINE' : (r.public ? 'PUBLIC' : 'PRIVATE'), cls: 'arch' };
}
function visible(r) {
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
  T.date = dateKey(new Date());
  $('toolsBtn').onclick = () => toggle();
  $('toolsClose').onclick = () => toggle(false);
  document.querySelectorAll('#toolsTabs button').forEach(b => b.onclick = () => { T.tab = b.dataset.tab; render(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && T.open) toggle(false); });
  const p = new URLSearchParams(location.search);
  if (p.get('tools')) { T.tab = ['runs', 'ensemble', 'manual', 'dev'].includes(p.get('tools')) ? p.get('tools') : 'runs'; T.pendingOpen = true; }
  T.wantOpen = p.get('open');
}

export function openTab(tab, filter) { T.tab = tab; if (filter) T.filter = filter; toggle(true); }
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
}

function ready(r) {
  const label = typeInfo(r).label;
  actionToast(`Your ${label} run is ready`, 'Open', () => { X.showCustom(r); if (innerWidth <= 640) toggle(false); });
  if (T.man.notify && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { const n = new Notification('HOCO run ready', { body: `${label} · ${X.S.region}`, icon: 'https://raw.githubusercontent.com/Handry-Outlook/Convective-Outlook/refs/heads/main/Handry_outlook_icon_pride_small.png' });
      n.onclick = () => { focus(); X.showCustom(r); }; } catch (e) { /* some browsers block page notifications */ }
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
  ({ runs: renderRuns, ensemble: renderEnsemble, manual: renderManual, dev: renderDev })[T.tab](body);
  body.scrollTop = keep;
}

// ---------------------------------------------------------------- runs browser
async function loadArchive(key) {
  if (T.archiveKey === key && T.archive) return;
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

function runsForDate() {
  loadArchive(T.date);
  if (!T.archive || T.archiveKey !== T.date) return null;
  const byId = new Map(T.archive.map(r => [r.id, r]));
  X.S.runs.forEach(r => byId.set(r.id, r));          // live copies win (status changes while processing)
  return [...byId.values()].filter(r => visible(r) && X.regionMatches(X.S.region, r) && X.startOf(r) && dateKey(X.startOf(r)) === T.date)
    .filter(r => T.filter === 'all' ? true : T.filter === 'mine' ? r.userId === uid() : T.filter === 'ens' ? r.type === 'human-mimic' : T.filter === 'auto' ? (r.type === 'automated' || r.type === 'ai') : r.public === true)
    .sort((a, b) => (X.created(b)?.getTime() || 0) - (X.created(a)?.getTime() || 0));
}

function runRow(r) {
  const ti = typeInfo(r), c = X.created(r), s = X.startOf(r), e = X.endOf(r), mine = r.userId === uid();
  let right;
  if (isPending(r)) {
    const mins = c ? Math.max(0, Math.round((Date.now() - c.getTime()) / 60000)) : 0;
    right = `<span class="proc"><span class="spin"></span><span>Processing<br><small>${mins} of about ${estMinutes(r)} min</small></span></span>`;
  } else if (isFailed(r)) right = `<span class="tag" style="color:#b42318">Failed</span>`;
  else right = `<button class="btn" data-open="${esc(r.id)}">Open</button>`;
  const devPub = role() === 'developer' && !isPending(r) && r.public !== true && r.type !== 'automated' && r.type !== 'ai'
    ? `<button class="linkbtn" data-pub="${esc(r.id)}">Make public</button>` : '';
  const scen = Array.isArray(r.scenarios) && r.scenarios.length ? ` · ${r.scenarios.length} model run${r.scenarios.length > 1 ? 's' : ''}` : '';
  const srcs = r.type === 'human-mimic' && r.sourceRunCount ? ` · ${r.sourceRunCount} runs blended` : '';
  return `<div class="runitem${X.S.custom?.id === r.id ? ' on' : ''}"><span class="tag ${ti.cls}">${ti.chip}</span>
    <div class="ri-main"><b>${ti.label} · issued ${c ? X.hhmm(c) : '–'}</b><small>${s ? `${X.dayName(s)} ${X.hhmm(s)}` : '–'} → ${e ? `${X.dayName(e)} ${X.hhmm(e)}` : '–'}${scen}${srcs}${mine && r.type !== 'automated' && r.type !== 'ai' ? ' · yours' : ''}</small>${devPub}</div>${right}</div>`;
}

function renderRuns(body) {
  const list = runsForDate(), d = new Date(T.date + 'T00:00:00'), isToday = T.date === dateKey(new Date());
  const chips = [['all', 'All'], ['auto', 'Forecasts'], ['mine', 'Mine'], ['ens', 'Ensembles'], ['pub', 'Public']]
    .map(([k, l]) => `<button class="chipbtn" aria-pressed="${T.filter === k}" data-f="${k}">${l}</button>`).join('');
  const mine = X.S.runs.filter(r => r.userId === uid() && isPending(r));
  const shown = list ? (T.showMore ? list : list.slice(0, 40)) : [];
  body.innerHTML = `
    ${mine.length ? `<div class="note good"><span class="spin"></span><div><b>${mine.length} run${mine.length > 1 ? 's' : ''} processing</b><br><small>You can keep using HOCO. We'll show a message when ${mine.length > 1 ? 'each one is' : "it's"} ready.</small></div></div>` : ''}
    <div class="datebar"><button class="btn icon" id="dPrev" aria-label="Previous day">‹</button>
      <label class="dateinput"><span class="kicker">Forecasts valid on</span><input type="date" id="dPick" value="${T.date}" max="${dateKey(new Date(Date.now() + 2 * 864e5))}"></label>
      <button class="btn icon" id="dNext" aria-label="Next day">›</button></div>
    <div class="chips">${chips}</div>
    <div class="muted" style="font-size:13px">${esc(X.S.region)} · ${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${isToday ? ' (today)' : ''}</div>
    <div class="runlist">${list == null ? '<div class="muted center"><span class="spin"></span> Loading runs…</div>' : shown.length ? shown.map(runRow).join('') : `<div class="muted center">No runs here${T.filter !== 'all' ? ' with this filter' : ''}.</div>`}</div>
    ${list && list.length > shown.length ? `<button class="btn" id="moreRuns">Show all ${list.length} runs</button>` : ''}`;
  const shift = (n) => { const x = new Date(T.date + 'T00:00:00'); x.setDate(x.getDate() + n); T.date = dateKey(x); T.showMore = false; render(); };
  $('dPrev').onclick = () => shift(-1); $('dNext').onclick = () => shift(1);
  $('dPick').onchange = (e) => { if (e.target.value) { T.date = e.target.value; T.showMore = false; render(); } };
  body.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { T.filter = b.dataset.f; T.showMore = false; render(); });
  $('moreRuns') && ($('moreRuns').onclick = () => { T.showMore = true; render(); });
  body.querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
    const r = [...X.S.runs, ...(T.archive || [])].find(x => x.id === b.dataset.open); if (!r) return;
    X.showCustom(r); if (innerWidth <= 640) toggle(false); else render();
  });
  body.querySelectorAll('[data-pub]').forEach(b => b.onclick = async () => {
    try { await updateDoc(doc(X.db, 'hoco_requests', b.dataset.pub), { public: true }); X.toast('Run is now public'); } catch (e) { X.toast('Could not make it public'); }
  });
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
    .sort((a, b) => a.start - b.start);
}
function defaultWeights(runs) {   // newer runs count a little more: 1.0 → 1.4, like the classic ensemble
  const out = {}; runs.forEach((r, i) => { out[r.id] = +(1 + (runs.length > 1 ? i / (runs.length - 1) : 0) * 0.4).toFixed(1); }); return out;
}

function renderEnsemble(body) {
  const E = T.ens, groups = ensembleGroups();
  if (role() === 'guest') { body.innerHTML = `<div class="note">Guests can't build ensembles. Ask for a Normal account to blend runs.</div>`; return; }
  if (!groups.length) { body.innerHTML = `<div class="note">No finished runs to blend for ${esc(X.S.region)} yet.</div>`; return; }
  const want = dateKey(X.addDays(new Date(new Date().setHours(0, 0, 0, 0)), X.S.day));
  let grp = groups.find(x => x.key === E.key) || groups.find(x => x.key === want) || groups[groups.length - 1];
  if (grp.key !== E.key) { E.key = grp.key; E.sel = new Set(); E.w = {}; }
  const hasAi = grp.runs.some(r => r.type === 'ai'), hasTrad = grp.runs.some(r => r.type === 'automated');
  if (!hasAi && E.src !== 'automated') E.src = 'automated';
  if (!hasTrad && hasAi && E.src === 'automated') E.src = 'ai';
  const pool = grp.runs.filter(r => E.src === 'both' ? true : r.type === E.src);
  const dw = defaultWeights(pool);
  pool.forEach(r => { if (E.w[r.id] == null) E.w[r.id] = dw[r.id]; });
  if (E.seed !== `${grp.key}|${E.src}`) { E.seed = `${grp.key}|${E.src}`; E.sel = new Set(pool.slice(-6).map(r => r.id)); }
  const chosen = pool.filter(r => E.sel.has(r.id)), mixOn = E.src === 'both' && chosen.some(r => r.type === 'ai') && chosen.some(r => r.type === 'automated');
  body.innerHTML = `
    <p class="lead">Blend several runs into one forecast. Newer runs count a little more by default; drag a weight to change that.</p>
    <div class="field"><span class="kicker">Day</span><div class="chips">${groups.map(x => `<button class="chipbtn" aria-pressed="${x.key === grp.key}" data-g="${x.key}">${X.dayDate(x.start)}<small>${x.runs.length} runs</small></button>`).join('')}</div></div>
    <div class="field"><span class="kicker">Blend</span><div class="seg wide" role="group" aria-label="Which forecasts to blend">
      <button data-src="automated" aria-pressed="${E.src === 'automated'}" ${hasTrad ? '' : 'disabled'}>Traditional</button>
      <button data-src="ai" aria-pressed="${E.src === 'ai'}" ${hasAi ? '' : 'disabled'}>AI HOCO</button>
      <button data-src="both" aria-pressed="${E.src === 'both'}" ${hasAi && hasTrad ? '' : 'disabled'}>Both</button></div>
      ${hasAi ? '' : '<small class="muted">No AI HOCO runs for this day yet, so only Traditional runs can be blended.</small>'}</div>
    ${mixOn ? `<div class="field"><span class="kicker">Traditional vs AI HOCO</span><input type="range" id="mix" min="0" max="100" step="5" value="${E.mix}" style="--pct:${E.mix}%">
      <div class="ticks2"><span>Traditional ${E.mix}%</span><span>AI HOCO ${100 - E.mix}%</span></div></div>` : ''}
    <div class="field"><div class="rowbetween"><span class="kicker">Runs (${chosen.length} of ${pool.length} chosen)</span>
      <span><button class="linkbtn" id="selLatest">Latest 6</button> · <button class="linkbtn" id="selAll">All</button> · <button class="linkbtn" id="resetW">Reset weights</button></span></div>
      <div class="wlist">${pool.slice().reverse().map(r => { const c = X.created(r), on = E.sel.has(r.id), w = E.w[r.id], ti = typeInfo(r);
        return `<div class="wrow${on ? '' : ' off'}"><label class="chk"><input type="checkbox" data-sel="${esc(r.id)}" ${on ? 'checked' : ''}><span><b>${X.hhmm(c)}</b> <small>${X.dayName(c)}</small></span></label>
          <span class="tag ${ti.cls}">${ti.chip}</span>
          <input type="range" min="0" max="2" step="0.1" value="${w}" data-w="${esc(r.id)}" aria-label="Weight for run issued ${X.hhmm(c)}" style="--pct:${w * 50}%" ${on ? '' : 'disabled'}>
          <output>×${(+w).toFixed(1)}</output></div>`; }).join('')}</div></div>
    <button class="btn primary big" id="buildEns" ${E.busy || !chosen.length ? 'disabled' : ''}>${E.busy ? '<span class="spin light"></span> Building…' : `Build ensemble from ${chosen.length} run${chosen.length === 1 ? '' : 's'}`}</button>
    <small class="muted" id="ensStatus">Saved to your runs. Only you can see it unless a developer makes it public.</small>`;
  body.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { E.key = b.dataset.g; E.sel = new Set(); E.w = {}; render(); });
  body.querySelectorAll('[data-src]').forEach(b => b.onclick = () => { E.src = b.dataset.src; E.sel = new Set(); render(); });
  $('mix') && ($('mix').oninput = (e) => { E.mix = +e.target.value; e.target.style.setProperty('--pct', E.mix + '%'); const t = e.target.nextElementSibling.children; t[0].textContent = `Traditional ${E.mix}%`; t[1].textContent = `AI HOCO ${100 - E.mix}%`; });
  body.querySelectorAll('[data-sel]').forEach(c => c.onchange = () => { c.checked ? E.sel.add(c.dataset.sel) : E.sel.delete(c.dataset.sel); render(); });
  body.querySelectorAll('[data-w]').forEach(s => s.oninput = () => { E.w[s.dataset.w] = +s.value; s.style.setProperty('--pct', s.value * 50 + '%'); s.nextElementSibling.textContent = `×${(+s.value).toFixed(1)}`; });
  $('selLatest').onclick = () => { E.sel = new Set(pool.slice(-6).map(r => r.id)); render(); };
  $('selAll').onclick = () => { E.sel = new Set(pool.map(r => r.id)); render(); };
  $('resetW').onclick = () => { E.w = { ...E.w, ...dw }; render(); };
  $('buildEns').onclick = () => buildEnsemble(grp, chosen, mixOn);
}

async function buildEnsemble(grp, chosen, mixOn) {
  const E = T.ens; if (E.busy) return; E.busy = true; render();
  const status = (t) => { const s = $('ensStatus'); if (s) s.textContent = t; };
  try {
    const share = (r) => !mixOn ? 1 : (r.type === 'ai' ? (100 - E.mix) / 50 : E.mix / 50);
    status(`Loading ${chosen.length} runs…`);
    const loaded = (await Promise.allSettled(chosen.map(async r => ({ r, geojson: await X.fetchGeo(r) })))).filter(x => x.status === 'fulfilled').map(x => x.value);
    if (!loaded.length) throw new Error('None of the chosen runs could be loaded.');
    if (loaded.length < chosen.length) X.toast(`${chosen.length - loaded.length} run(s) could not be loaded and were skipped`);
    status('Blending…');
    await new Promise(r => setTimeout(r, 30));
    const entries = loaded.map(({ r, geojson }) => ({ geojson, weight: +(E.w[r.id] * share(r)).toFixed(3), createdMs: X.created(r)?.getTime() || 0, r }));
    const geo = blendRuns(entries, X.BANDS);
    const used = entries.filter(e => e.weight > 0);
    status('Saving…');
    const payload = {
      region: X.S.region, startTime: fmtHoco(grp.start), endTime: fmtHoco(grp.end), weather: 'lightning',
      userId: uid(), createdAt: new Date(), status: 'complete', public: false, type: 'human-mimic', tag: 'ENSEMBLE',
      sourceRunIds: used.map(e => e.r.id), sourceRunCount: used.length, sourceTypes: [...new Set(used.map(e => e.r.type))],
      inlineGeojsonText: JSON.stringify(geo),
      humanMimic: { anomalyAware: true, noiseFilter: true, validPeriodKey: `${X.S.region}|${grp.key}`, weights: Object.fromEntries(used.map(e => [e.r.id, e.weight])),
        traditionalShare: mixOn ? E.mix / 100 : null, builtWith: 'v3',
        latestIssuedAt: X.created(used[used.length - 1].r)?.toISOString() || null, earliestIssuedAt: X.created(used[0].r)?.toISOString() || null }
    };
    if (payload.inlineGeojsonText.length > 900000) throw new Error('This blend is too detailed to save. Pick fewer runs.');
    const ref = await addDoc(collection(X.db, 'hoco_requests'), payload);
    X.cachePut(ref.id, geo);
    X.toast('Ensemble saved');
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

function renderManual(body) {
  const M = T.man, r = role(), cap = CAPS[r], canScen = r === 'exclusive' || r === 'developer', dev = r === 'developer';
  if (r === 'guest') { body.innerHTML = `<div class="note">Guests can't start runs. Request a Normal account below.</div>${upgradeForm()}`; wireUpgrade(); return; }
  const startEl = $('mStart'), endEl = $('mEnd');
  const sv = startEl?.value || M.start || '', ev = endEl?.value || M.end || '';
  const used = Math.min(T.myToday, cap), left = cap === Infinity ? Infinity : Math.max(0, cap - T.myToday);
  const opts = runOptions(M.model, sv);
  body.innerHTML = `
    <p class="lead">Start your own HOCO run for any time window. It takes a few minutes; you can keep browsing and we'll tell you when it's ready.</p>
    <div class="note slim"><b>${cap === Infinity ? 'Unlimited runs' : `${used} of ${cap} runs used today`}</b>${cap !== Infinity && !left ? ' · daily limit reached' : ''}</div>
    <div class="grid2">
      <label class="field"><span class="kicker">Region</span><select id="mRegion">${X.REGIONS.filter(x => x.west !== undefined).map(x => `<option value="${x.id}" ${x.id === (M.region || X.S.region) ? 'selected' : ''}>${x.name}</option>`).join('')}</select></label>
      <label class="field"><span class="kicker">Hazard</span><select disabled><option>Lightning</option></select></label>
      <label class="field"><span class="kicker">Start</span><input type="datetime-local" id="mStart" value="${sv}"></label>
      <label class="field"><span class="kicker">End</span><input type="datetime-local" id="mEnd" value="${ev}"></label>
    </div>
    <div class="chips">${[3, 6, 12, 24].map(h => `<button class="chipbtn" data-h="${h}">+${h} h</button>`).join('')}</div>
    ${canScen ? `
      <div class="field"><span class="kicker">Model runs</span>
        <small class="muted">Leave empty to use HOCO's standard model set. Pick a model, tap one or more of its runs, then add them. Each run gets its own weight.</small>
        <div class="grid2" style="margin-top:6px"><select id="mModel">${Object.entries(MODELS).map(([k, m]) => `<option value="${k}" ${k === M.model ? 'selected' : ''}>${m.name}</option>`).join('')}</select>
        <button class="btn" id="mAdd" ${M.picked.size ? '' : 'disabled'}>Add ${M.picked.size || ''} run${M.picked.size === 1 ? '' : 's'}</button></div>
        <div class="chips runchips">${opts.map(o => `<button class="chipbtn" data-iso="${o.iso}" aria-pressed="${M.picked.has(o.iso)}">${o.label}</button>`).join('')}</div>
        <div class="wlist">${M.scen.length ? M.scen.map((s, i) => `<div class="wrow"><span class="scenlabel"><b>${esc(MODELS[s.model]?.name || s.model)}</b> <small>${esc(s.runLabel)}</small></span>
          <input type="range" min="0.1" max="2" step="0.1" value="${s.weight}" data-sw="${i}" aria-label="Weight" style="--pct:${(s.weight - 0.1) / 1.9 * 100}%"><output>×${(+s.weight).toFixed(1)}</output>
          <button class="btn icon sm" data-rm="${i}" aria-label="Remove">✕</button></div>`).join('') : '<div class="muted center" style="padding:10px">No model runs added. HOCO will use its standard set.</div>'}</div>
      </div>` : `<div class="note slim">Your runs use HOCO's standard model blend. Exclusive members can pick individual model runs and weights.</div>`}
    ${dev ? `<details class="field devbox" ${M.devOpen ? 'open' : ''}><summary><span class="kicker">Developer · model weighting</span></summary>
      <small class="muted">Leave blank to use the backend default for that model.</small>
      <div class="grid3">${Object.entries(MODELS).map(([k, m]) => `<label><small>${m.name}</small><input type="number" step="0.1" min="0" id="mw-${k}" placeholder="default" value="${M.w?.[k] ?? ''}"></label>`).join('')}</div>
      <label class="chk" style="margin-top:8px"><input type="checkbox" id="mLearned" ${M.learned ? 'checked' : ''}><span>Use the AI HOCO learned weighting (falls back to these weights if none is live)</span></label></details>` : ''}
    <label class="chk"><input type="checkbox" id="mNotify" ${M.notify ? 'checked' : ''}><span>Notify me when it's ready</span></label>
    <button class="btn primary big" id="mGo" ${M.busy || (cap !== Infinity && !left) ? 'disabled' : ''}>${M.busy ? '<span class="spin light"></span> Starting…' : 'Start run'}</button>
    ${r !== 'developer' && r !== 'exclusive' ? upgradeForm() : ''}`;
  const save = () => { M.start = $('mStart').value; M.end = $('mEnd').value; M.region = $('mRegion').value; };
  $('mStart').onchange = () => { save(); render(); };
  $('mEnd').onchange = save; $('mRegion').onchange = save;
  body.querySelectorAll('[data-h]').forEach(b => b.onclick = () => {
    let s = $('mStart').value ? new Date($('mStart').value) : null;
    if (!s) { s = new Date(); s.setMinutes(0, 0, 0); s.setHours(s.getHours() + 1); }
    const e = new Date(s.getTime() + +b.dataset.h * 3.6e6); M.start = localInput(s); M.end = localInput(e); M.region = $('mRegion').value; render();
  });
  if (canScen) {
    $('mModel').onchange = (e) => { save(); M.model = e.target.value; M.picked = new Set(); render(); };
    body.querySelectorAll('[data-iso]').forEach(b => b.onclick = () => { M.picked.has(b.dataset.iso) ? M.picked.delete(b.dataset.iso) : M.picked.add(b.dataset.iso); save(); render(); });
    $('mAdd').onclick = () => { save();
      opts.filter(o => M.picked.has(o.iso)).forEach(o => { if (!M.scen.some(s => s.model === M.model && s.run === o.iso)) M.scen.push({ model: M.model, run: o.iso, runLabel: o.label, weight: 1 }); });
      M.picked = new Set(); render(); };
    body.querySelectorAll('[data-sw]').forEach(s => s.oninput = () => { M.scen[+s.dataset.sw].weight = +s.value; s.style.setProperty('--pct', (s.value - 0.1) / 1.9 * 100 + '%'); s.nextElementSibling.textContent = `×${(+s.value).toFixed(1)}`; });
    body.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { save(); M.scen.splice(+b.dataset.rm, 1); render(); });
  }
  if (dev) {
    body.querySelector('.devbox').ontoggle = (e) => { M.devOpen = e.target.open; };
    Object.keys(MODELS).forEach(k => $(`mw-${k}`).oninput = (e) => { M.w = { ...(M.w || {}), [k]: e.target.value }; });
    $('mLearned').onchange = (e) => { M.learned = e.target.checked; };
  }
  $('mNotify').onchange = (e) => { M.notify = e.target.checked; };
  $('mGo').onclick = startManual;
  if (r !== 'developer' && r !== 'exclusive') wireUpgrade();
}

async function startManual() {
  const M = T.man, r = role(), cap = CAPS[r];
  const sIn = $('mStart').value, eIn = $('mEnd').value;
  if (!sIn || !eIn) return X.toast('Choose a start and an end time');
  const s = new Date(sIn), e = new Date(eIn);
  if (s >= e) return X.toast('The start must be before the end');
  if (r !== 'developer' && (e - s) / 3.6e6 > 72) return X.toast('A run can cover up to 72 hours');
  if (cap !== Infinity && T.myToday >= cap) return X.toast(`You've used all ${cap} runs for today`);
  M.busy = true; M.start = sIn; M.end = eIn; M.region = $('mRegion').value; render();
  if (M.notify && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (err) { /* ignore */ } }
  // Normal users always get the standard blend, as on the classic site. Weights left blank use the backend defaults.
  const canScen = r === 'exclusive' || r === 'developer';
  const scenarios = canScen ? M.scen.map(x => ({ model: x.model, run: x.run, label: `${MODELS[x.model].name} (${x.runLabel})`, weight: x.weight })) : [];
  const weights = {};
  if (r === 'developer') { Object.entries(M.w || {}).forEach(([k, v]) => { if (v !== '' && Number.isFinite(+v)) weights[k] = +v; }); if (M.learned) weights._mode = 'learned'; }
  const payload = { region: M.region, scenarios, startTime: fmtHoco(s), endTime: fmtHoco(e), weather: 'lightning', weights: JSON.stringify(weights),
    userId: uid(), createdAt: new Date(), status: 'pending', public: false, type: 'manual' };
  try {
    const ref = await addDoc(collection(X.db, 'hoco_requests'), payload);
    T.known.set(ref.id, 'pending');
    try { await httpsCallable(getFunctions(X.app, 'us-central1'), 'triggerHocoRun')({ id: ref.id, ...payload }); }
    catch (err) { console.error(err); X.toast('The run was saved but the backend did not start it. Try again in a minute.'); }
    M.scen = []; M.picked = new Set();
    X.toast('Run started. We\'ll tell you when it\'s ready.');
    T.tab = 'runs'; T.filter = 'mine'; T.date = dateKey(s);
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
    <section class="devsec"><b>Accuracy</b><small class="muted">Recalculate AUTO-HOCO accuracy against observed lightning.</small>
      <div class="chips"><button class="btn" id="recalc">Recalculate now</button><a class="btn" href="../ai-hoco-lab.html">Open the AI HOCO Lab</a></div></section>
    <section class="devsec"><div class="rowbetween"><b>Access requests</b><span class="tag">${T.reqs ? T.reqs.length : '…'}</span></div>
      ${T.reqs == null ? '<small class="muted">Loading…</small>' : !T.reqs.length ? '<small class="muted">No pending requests.</small>' : T.reqs.map(r => `<div class="req"><div><b>${esc(r.email)}</b> wants <b>${esc(r.requestedRole)}</b></div>
        <small class="muted">${esc(r.social)} · ${esc(r.reason)}</small><div class="chips"><button class="btn primary sm" data-ok="${esc(r.id)}">Approve</button><button class="btn sm" data-no="${esc(r.id)}">Reject</button></div></div>`).join('')}</section>
    <section class="devsec"><div class="rowbetween"><b>Users</b><small class="muted">${T.users ? T.users.length : '…'}</small></div>
      <input id="userQ" placeholder="Search by email" value="${esc(T.userQ || '')}">
      <div class="userlist">${T.users == null ? '<small class="muted">Loading…</small>' : users.slice(0, 60).map(u => `<div class="urow"><span>${esc(u.email || u.id)}</span>
        <select data-role="${esc(u.id)}" aria-label="Role for ${esc(u.email)}">${ROLES.map(([k, l]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`).join('')}
        ${users.length > 60 ? `<small class="muted">Showing 60 of ${users.length}. Search to narrow.</small>` : ''}</div></section>`;
  body.querySelectorAll('[name=runner]').forEach(i => i.onchange = () => { T.runnerPick = i.value; render(); });
  $('saveRunner').onclick = async () => {
    const c = RUNNERS[pick];
    try { await updateDoc(doc(X.db, 'system_config', 'github_settings'), { active_owner: c.owner, active_repo: c.repo }); T.runner = { ...T.runner, active_owner: c.owner, active_repo: c.repo }; T.runnerPick = null; X.toast(`Runner switched to ${c.owner}`); render(); }
    catch (e) { X.toast('Could not switch the runner'); }
  };
  $('recalc').onclick = async (ev) => { const b = ev.currentTarget; b.disabled = true; b.textContent = 'Calculating…';
    try { await httpsCallable(getFunctions(X.app, 'us-central1'), 'calculateAutoAccuracy')(); X.toast('Accuracy recalculated'); } catch (e) { X.toast('Recalculation failed'); }
    finally { b.disabled = false; b.textContent = 'Recalculate now'; } };
  body.querySelectorAll('[data-ok]').forEach(b => b.onclick = async () => { const r = T.reqs.find(x => x.id === b.dataset.ok);
    try { await updateDoc(doc(X.db, 'users', r.userId), { role: r.requestedRole }); await updateDoc(doc(X.db, 'role_requests', r.id), { status: 'approved' }); X.toast('Approved'); } catch (e) { X.toast('Could not approve'); } });
  body.querySelectorAll('[data-no]').forEach(b => b.onclick = async () => { try { await updateDoc(doc(X.db, 'role_requests', b.dataset.no), { status: 'rejected' }); X.toast('Rejected'); } catch (e) { X.toast('Could not reject'); } });
  $('userQ').oninput = (e) => { T.userQ = e.target.value; const pos = e.target.selectionStart; render(); const i = $('userQ'); i.focus(); i.setSelectionRange(pos, pos); };
  body.querySelectorAll('[data-role]').forEach(s => s.onchange = async () => { try { await updateDoc(doc(X.db, 'users', s.dataset.role), { role: s.value }); X.toast('Role updated'); } catch (e) { X.toast('Could not update the role'); } });
}
