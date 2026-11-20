// HOCO Ensemble blending, ported from the classic site (index.html: buildHumanRiskField /
// buildHumanMimicGeojson). Differences: each source run carries its own weight, and the output
// uses the 11 HOCO probability bands (5..90%) instead of the old five named bands.

const BAND_STEPS = [
  { min: 5, minCells: 10, passes: 2 }, { min: 10, minCells: 9, passes: 2 }, { min: 15, minCells: 8, passes: 2 },
  { min: 20, minCells: 8, passes: 2 }, { min: 30, minCells: 7, passes: 2 }, { min: 40, minCells: 6, passes: 2 },
  { min: 50, minCells: 5, passes: 1 }, { min: 60, minCells: 5, passes: 1 }, { min: 70, minCells: 4, passes: 1 },
  { min: 80, minCells: 4, passes: 1 }, { min: 90, minCells: 3, passes: 1 }];

const q4 = (v) => Number.parseFloat(Number(v).toFixed(4));
const riskOf = (p = {}) => { const v = parseFloat(p.risk ?? p.risk_pct ?? p.prob ?? p.probability ?? p.percent ?? p.percentage); return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0; };
const matrix = (rows, cols, fill = 0) => Array.from({ length: rows }, () => Array(cols).fill(fill));

function ringCentroid(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < ring.length - 1; i++) { const [x1, y1] = ring[i], [x2, y2] = ring[i + 1]; const c = x1 * y2 - x2 * y1; a += c; x += (x1 + x2) * c; y += (y1 + y2) * c; }
  a /= 2;
  if (!Number.isFinite(a) || Math.abs(a) < 1e-9) return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
  return [x / (6 * a), y / (6 * a)];
}

function riskPoints(geo) {
  const fs = Array.isArray(geo?.features) ? geo.features : [];
  const pts = fs.filter(f => f?.geometry?.type === 'Point' && riskOf(f.properties) > 0);
  if (pts.length) return pts.map(f => ({ lon: q4(f.geometry.coordinates[0]), lat: q4(f.geometry.coordinates[1]), risk: riskOf(f.properties) }));
  return fs.flatMap(f => {
    const r = riskOf(f.properties); if (r <= 0) return [];
    const g = f.geometry;
    if (g?.type === 'Polygon') { const c = ringCentroid(g.coordinates?.[0]); return c ? [{ lon: q4(c[0]), lat: q4(c[1]), risk: r }] : []; }
    if (g?.type === 'MultiPolygon') return g.coordinates.flatMap(p => { const c = ringCentroid(p?.[0] || []); return c ? [{ lon: q4(c[0]), lat: q4(c[1]), risk: r }] : []; });
    return [];
  });
}

const median = (v) => { if (!v.length) return 0; const s = v.slice().sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Same blend as the classic ensemble: weighted mean, median and latest run, nudged by trend and agreement.
function combine(values, weights) {
  if (!values.length) return 0;
  if (values.length === 1) return Math.max(0, Math.min(100, values[0]));
  let ws = 0, wt = 0; values.forEach((v, i) => { const w = Number.isFinite(weights[i]) ? weights[i] : 1; ws += v * w; wt += w; });
  const mean = wt ? ws / wt : 0, med = median(values), latest = values[values.length - 1];
  const consensus = values.filter(v => v >= 20).length / values.length;
  const spread = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  let b = mean * 0.68 + med * 0.2 + latest * 0.12;
  b += Math.max(0, latest - med) * (0.16 + consensus * 0.12) - Math.max(0, spread - 16) * (1 - consensus) * 0.28 - Math.max(0, med - latest) * 0.06;
  return Math.max(0, Math.min(100, b));
}

function smooth(m, passes) {
  const rows = m.length, cols = m[0]?.length || 0; if (!rows || !cols) return m;
  const k = [[1, 2, 1], [2, 4, 2], [1, 2, 1]]; let out = m.map(r => r.slice());
  for (let p = 0; p < passes; p++) {
    const next = matrix(rows, cols, 0);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      let w = 0, wt = 0, act = 0;
      for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
        const rr = r + y, cc = c + x; if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        const kw = k[y + 1][x + 1], v = out[rr][cc]; w += v * kw; wt += kw; if (v > 0.1) act += kw;
      }
      next[r][c] = act < 4 ? out[r][c] * 0.6 : w / Math.max(wt, 1);
    }
    out = next;
  }
  return out;
}

function axisEdges(values, desc) {
  if (!values.length) return [];
  const s = values.slice().sort((a, b) => desc ? b - a : a - b);
  if (s.length === 1) return desc ? [s[0] + 0.1, s[0] - 0.1] : [s[0] - 0.1, s[0] + 0.1];
  const e = [s[0] - (s[1] - s[0]) / 2];
  for (let i = 1; i < s.length; i++) e.push((s[i - 1] + s[i]) / 2);
  e.push(s[s.length - 1] + (s[s.length - 1] - s[s.length - 2]) / 2);
  return e;
}

const ringArea = (r) => { let a = 0; for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return a / 2; };
function smoothRing(ring, passes) {
  if (ring.length < 4) return ring; let cur = ring.slice(0, -1);
  for (let p = 0; p < passes; p++) { const n = []; for (let i = 0; i < cur.length; i++) { const a = cur[i], b = cur[(i + 1) % cur.length];
    n.push([+(0.75 * a[0] + 0.25 * b[0]).toFixed(5), +(0.75 * a[1] + 0.25 * b[1]).toFixed(5)], [+(0.25 * a[0] + 0.75 * b[0]).toFixed(5), +(0.25 * a[1] + 0.75 * b[1]).toFixed(5)]); } cur = n; }
  cur.push(cur[0]); return cur;
}
function simplify(ring, d) {
  if (ring.length < 4) return ring; const s = [ring[0]];
  for (let i = 1; i < ring.length - 1; i++) { const p = s[s.length - 1], c = ring[i]; if (Math.hypot(c[0] - p[0], c[1] - p[1]) >= d) s.push(c); }
  if (s.length < 3) return ring; s.push(ring[ring.length - 1]); return s;
}
const pk = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
function rings(edges) {
  const byStart = new Map(), seen = new Set();
  edges.forEach((e, i) => { e.id = i; e.sk = pk(e.start); e.ek = pk(e.end); if (!byStart.has(e.sk)) byStart.set(e.sk, []); byStart.get(e.sk).push(e); });
  const out = [];
  for (const e of edges) {
    if (seen.has(e.id)) continue; const ring = [e.start]; seen.add(e.id); let cur = e, g = 0;
    while (g < edges.length + 4) { ring.push(cur.end); if (cur.ek === e.sk) break; const opts = (byStart.get(cur.ek) || []).filter(c => !seen.has(c.id)); if (!opts.length) break; cur = opts[0]; seen.add(cur.id); g++; }
    if (ring.length >= 4 && pk(ring[0]) === pk(ring[ring.length - 1])) out.push(ring);
  }
  return out;
}
function components(mask) {
  const rows = mask.length, cols = mask[0]?.length || 0, seen = matrix(rows, cols, false), out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (!mask[r][c] || seen[r][c]) continue; const qq = [[r, c]], comp = []; seen[r][c] = true;
    while (qq.length) { const [a, b] = qq.pop(); comp.push([a, b]);
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nr = a + dr, nc = b + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols || !mask[nr][nc] || seen[nr][nc]) continue; seen[nr][nc] = true; qq.push([nr, nc]); } }
    out.push(comp);
  }
  return out;
}
function componentRings(comp, lonE, latE, simp, passes) {
  const set = new Set(comp.map(([r, c]) => `${r},${c}`)), edges = [];
  comp.forEach(([r, c]) => {
    if (!set.has(`${r - 1},${c}`)) edges.push({ start: [lonE[c], latE[r]], end: [lonE[c + 1], latE[r]] });
    if (!set.has(`${r},${c + 1}`)) edges.push({ start: [lonE[c + 1], latE[r]], end: [lonE[c + 1], latE[r + 1]] });
    if (!set.has(`${r + 1},${c}`)) edges.push({ start: [lonE[c + 1], latE[r + 1]], end: [lonE[c], latE[r + 1]] });
    if (!set.has(`${r},${c - 1}`)) edges.push({ start: [lonE[c], latE[r + 1]], end: [lonE[c], latE[r]] });
  });
  return rings(edges).map(r => smoothRing(r, passes)).map(r => simplify(r, simp)).filter(r => r.length >= 4 && Math.abs(ringArea(r)) > 0.01);
}

/**
 * entries: [{ geojson, weight, createdMs }] — weight 0 drops the run.
 * bands: [{min, fill}] (HOCO bands). Returns a FeatureCollection of nested band polygons.
 */
export function blendRuns(entries, bands, { allowQuiet = false } = {}) {
  const list = entries.filter(e => e.weight > 0).sort((a, b) => a.createdMs - b.createdMs);
  if (!list.length) throw new Error('Pick at least one run with a weight above 0.');
  const weights = list.map(e => e.weight), coords = new Map();
  const maps = list.map(({ geojson }) => { const m = new Map();
    riskPoints(geojson).forEach(p => { const k = `${p.lon},${p.lat}`; coords.set(k, p); if (p.risk > (m.get(k) || 0)) m.set(k, p.risk); }); return m; });
  if (!coords.size) {
    if (allowQuiet) return { type: 'FeatureCollection', properties: { hoco_layout: 'ensemble_v3' }, features: [] };
    throw new Error('The chosen runs have no usable risk data.');
  }
  const all = [...coords.values()];
  const lons = [...new Set(all.map(c => c.lon))].sort((a, b) => a - b), lats = [...new Set(all.map(c => c.lat))].sort((a, b) => b - a);
  const li = new Map(lons.map((v, i) => [v, i])), ai = new Map(lats.map((v, i) => [v, i])), m = matrix(lats.length, lons.length, 0);
  coords.forEach((c, k) => { const v = combine(maps.map(mm => mm.get(k) ?? 0), weights); if (v <= 0.5) return; m[ai.get(c.lat)][li.get(c.lon)] = v; });
  const lonE = axisEdges(lons, false), latE = axisEdges(lats, true);
  const step = Math.max(lons.length > 1 ? Math.abs(lons[1] - lons[0]) : 0.15, lats.length > 1 ? Math.abs(lats[0] - lats[1]) : 0.15);
  const simp = Math.max(0.025, Math.min(0.1, step * 0.85)), sm = smooth(m, 3), features = [];
  BAND_STEPS.forEach((bs) => {
    const fill = (bands.find(b => b.min === bs.min) || bands[0]).fill;
    components(sm.map(r => r.map(v => v >= bs.min))).filter(c => c.length >= bs.minCells).forEach(comp => {
      const peak = comp.reduce((p, [r, c]) => Math.max(p, sm[r][c] || 0), 0);
      componentRings(comp, lonE, latE, simp, bs.passes).forEach(ring => features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { feature_type: 'polygon', risk: bs.min, peak_risk: +peak.toFixed(1), fill, 'fill-opacity': 0.46, stroke: fill, 'stroke-width': 1.3 } }));
    });
  });
  if (!features.length && !allowQuiet) throw new Error('The blend has no area above 5%, so there is nothing to draw.');
  return { type: 'FeatureCollection', properties: { hoco_layout: 'ensemble_v3' }, features };
}
