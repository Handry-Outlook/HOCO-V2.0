// ESTOFEX-style Thunderstorm Severity (Level 1 / Level 2 / Level 3) helpers for HOCO v3:
// GeoJSON fetch/caching, Mapbox GL hatched overlay layers, cursor probe lookup,
// high-DPI PNG/GIF/Video 2D canvas compositor, and KML export folder builder.

export const SEVERITY_LEVELS = {
  1: {
    level: 1, short: 'L1', label: 'Level 1', title: 'Level 1 · Marginal severe',
    desc: 'Isolated severe gusts, hail or heavy downpours possible (~5–15% chance within 40 km). Most places stay non-severe.',
    color: '#d97706', ink: '#ffffff',
  },
  2: {
    level: 2, short: 'L2', label: 'Level 2', title: 'Level 2 · Scattered severe',
    desc: 'Scattered severe thunderstorms possible (~15%+ chance within 40 km) — localised damaging gusts, large hail or brief tornadoes.',
    color: '#dc2626', ink: '#ffffff',
  },
  3: {
    level: 3, short: 'L3', label: 'Level 3', title: 'Level 3 · Significant severe',
    desc: 'Rare, significant severe thunderstorm outbreak possible — widespread damaging gusts, very large hail or strong tornadoes.',
    color: '#7e22ce', ink: '#ffffff',
  },
};

export const HAZARD_LABELS = {
  tornado: 'Tornado risk',
  hail: 'Large hail',
  wind: 'Damaging gusts',
  rain: 'Heavy rain / flooding',
};

export const HAZARD_LABELS_L1 = {
  tornado: 'Isolated brief tornado',
  hail: 'Isolated large hail',
  wind: 'Isolated damaging gusts',
  rain: 'Localised heavy rain',
};

export const HAZARD_PANELS = [
  { key: 'rain',    title: 'Flooding',       short: 'Flooding',       subtitle: 'Heavy rain & flooding',       accent: '#0284c7' },
  { key: 'hail',    title: 'Large hail',     short: 'Large hail',     subtitle: 'Severe convective hail',      accent: '#0d9488' },
  { key: 'tornado', title: 'Tornado',        short: 'Tornado',        subtitle: 'Tornado & supercell risk',    accent: '#9333ea' },
  { key: 'wind',    title: 'Damaging gusts', short: 'Damaging gusts', subtitle: 'Severe convective gusts',     accent: '#ea580c' },
];

export const runMaxSeverity = (run) => Number(run?.severity?.maxLevel || 0);

export function formatHazards(list, level = 2) {
  const dict = Number(level) === 1 ? HAZARD_LABELS_L1 : HAZARD_LABELS;
  return (list || []).map((k) => dict[k] || HAZARD_LABELS[k] || String(k));
}

const sevGeoCache = new Map();
let urlResolver = null;

export function setSeverityUrlResolver(fn) {
  urlResolver = typeof fn === 'function' ? fn : null;
}

export async function fetchSeverityGeo(run) {
  if (!run) return null;
  if (run.inlineSeverityGeojson) return run.inlineSeverityGeojson;
  const meta = run.severity;
  if (!meta || Number(meta.maxLevel || 0) < 1 || !meta.geojsonUrl) return null;
  const key = meta.geojsonUrl;
  if (sevGeoCache.has(key)) return sevGeoCache.get(key);
  const p = (async () => {
    const url = urlResolver ? await urlResolver(key).catch(() => key) : key;
    const r = await fetch(url, { cache: 'default' });
    return r.ok ? r.json() : null;
  })().catch(() => null);
  sevGeoCache.set(key, p);
  const res = await p;
  if (!res) sevGeoCache.delete(key);
  return res;
}

function makeHatchCanvas(color, level, scale = 1) {
  const sz = Math.round((level === 1 ? 14 : 10) * scale);
  const c = document.createElement('canvas');
  c.width = sz;
  c.height = sz;
  const g = c.getContext('2d');
  g.strokeStyle = color;
  g.globalAlpha = level === 1 ? 0.55 : level === 2 ? 0.62 : 0.72;
  g.lineWidth = Math.max(1.4, (level === 3 ? 2.0 : 1.7) * scale);
  g.beginPath();
  g.moveTo(-sz, sz); g.lineTo(sz, -sz);
  g.moveTo(0, sz); g.lineTo(sz, 0);
  g.moveTo(0, 2 * sz); g.lineTo(2 * sz, 0);
  if (level >= 3) {
    // Cross-hatch for Level 3 significant severe threat
    g.moveTo(0, 0); g.lineTo(sz, sz);
    g.moveTo(-sz, 0); g.lineTo(sz, 2 * sz);
    g.moveTo(0, -sz); g.lineTo(2 * sz, sz);
  }
  g.stroke();
  return c;
}

export function registerHatchPatterns(map) {
  if (!map || typeof map.addImage !== 'function') return false;
  try {
    for (const lvl of [1, 2, 3]) {
      const id = `hoco-sev-pat-${lvl}`;
      if (map.hasImage?.(id)) continue;
      const cv = makeHatchCanvas(SEVERITY_LEVELS[lvl].color, lvl, 1);
      const img = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
      map.addImage(id, img);
    }
    return true;
  } catch {
    return false;
  }
}

const LAYER_IDS = ['hoco-sev-fill', 'hoco-sev-casing', 'hoco-sev-line-1', 'hoco-sev-line-hi'];

export function syncSeverityLayers(map, sevGeo, visible = true) {
  if (!map) return;
  const empty = { type: 'FeatureCollection', features: [] };
  const hasData = !!(visible && sevGeo?.features?.length);
  const data = hasData ? sevGeo : empty;
  const vis = hasData ? 'visible' : 'none';

  const src = map.getSource('hoco-sev');
  if (src) {
    src.setData(data);
    for (const lid of LAYER_IDS) {
      if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', vis);
    }
    return;
  }

  if (!map.isStyleLoaded?.() && !map.getLayer('hoco-fill')) return;
  const sym = map.getStyle?.()?.layers?.find((l) => l.type === 'symbol' && l.layout?.['text-field'])?.id;
  const before = ['strikes', 'hoco-coast', 'hoco-borders', sym].find((id) => id && map.getLayer(id));

  map.addSource('hoco-sev', { type: 'geojson', data });
  const hasPat = registerHatchPatterns(map);

  const colorExpr = ['match', ['get', 'level'], 1, '#d97706', 2, '#dc2626', 3, '#7e22ce', '#d97706'];
  map.addLayer({
    id: 'hoco-sev-fill',
    type: 'fill',
    source: 'hoco-sev',
    filter: ['==', ['get', 'feature_type'], 'severity_polygon'],
    layout: { visibility: vis },
    paint: hasPat
      ? { 'fill-pattern': ['match', ['get', 'level'], 1, 'hoco-sev-pat-1', 2, 'hoco-sev-pat-2', 3, 'hoco-sev-pat-3', 'hoco-sev-pat-1'], 'fill-opacity': 0.88 }
      : { 'fill-color': colorExpr, 'fill-opacity': 0.22 },
  }, before);

  map.addLayer({
    id: 'hoco-sev-casing',
    type: 'line',
    source: 'hoco-sev',
    filter: ['==', ['get', 'feature_type'], 'severity_polygon'],
    layout: { visibility: vis, 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': 'rgba(255,255,255,0.85)',
      'line-width': ['match', ['get', 'level'], 1, 3.4, 2, 4.4, 3, 5.4, 3.4],
    },
  }, before);

  map.addLayer({
    id: 'hoco-sev-line-1',
    type: 'line',
    source: 'hoco-sev',
    filter: ['all', ['==', ['get', 'feature_type'], 'severity_polygon'], ['==', ['get', 'level'], 1]],
    layout: { visibility: vis, 'line-join': 'round', 'line-cap': 'butt' },
    paint: { 'line-color': '#d97706', 'line-width': 2.1, 'line-dasharray': [3, 2] },
  }, before);

  map.addLayer({
    id: 'hoco-sev-line-hi',
    type: 'line',
    source: 'hoco-sev',
    filter: ['all', ['==', ['get', 'feature_type'], 'severity_polygon'], ['>=', ['get', 'level'], 2]],
    layout: { visibility: vis, 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': colorExpr,
      'line-width': ['match', ['get', 'level'], 2, 2.8, 3, 3.6, 2.8],
    },
  }, before);
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPoly(lon, lat, rings) {
  if (!rings?.length || !pointInRing(lon, lat, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) {
    if (pointInRing(lon, lat, rings[k])) return false;
  }
  return true;
}

export function severityAt(sevGeo, lon, lat) {
  if (!sevGeo?.features?.length || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const cos = Math.cos((lat * Math.PI) / 180);
  let polyMatch = null;
  let bestPt = null;
  let bestD2 = 0.22 * 0.22;

  for (const f of sevGeo.features) {
    const ft = f.properties?.feature_type;
    if (ft === 'severity_polygon' && f.geometry) {
      const hit = f.geometry.type === 'Polygon'
        ? pointInPoly(lon, lat, f.geometry.coordinates)
        : f.geometry.type === 'MultiPolygon' && f.geometry.coordinates.some((p) => pointInPoly(lon, lat, p));
      if (hit && (!polyMatch || f.properties.level > polyMatch.level)) {
        polyMatch = f.properties;
      }
    } else if (ft === 'severity_point' && f.geometry?.type === 'Point') {
      const [x, y] = f.geometry.coordinates;
      const d2 = ((x - lon) * cos) ** 2 + (y - lat) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestPt = f.properties;
      }
    }
  }
  if (!polyMatch && !bestPt) return null;
  const p = bestPt && (!polyMatch || bestPt.level >= polyMatch.level) ? bestPt : polyMatch;
  const lvl = Number(p.level || 0);
  if (lvl < 1) return null;
  return {
    level: lvl,
    label: SEVERITY_LEVELS[lvl]?.label || `Level ${lvl}`,
    color: SEVERITY_LEVELS[lvl]?.color || '#dc2626',
    hazards: p.hazards?.length ? p.hazards : (polyMatch?.hazards || []),
    score: p.score ?? null,
    scp: p.scp ?? null,
    stp: p.stp ?? null,
    gustMph: p.gustMph ?? null,
  };
}

export function drawSeverityOnCanvas(ctx, sevGeo, project, mapX, mapY, u, isDark) {
  if (!sevGeo?.features?.length) return;
  const polysByLevel = { 1: [], 2: [], 3: [] };
  for (const f of sevGeo.features) {
    if (f.properties?.feature_type !== 'severity_polygon' || !f.geometry) continue;
    const lvl = Number(f.properties.level || 0);
    if (!polysByLevel[lvl]) continue;
    if (f.geometry.type === 'Polygon') polysByLevel[lvl].push(f.geometry.coordinates);
    else if (f.geometry.type === 'MultiPolygon') {
      for (const poly of f.geometry.coordinates) polysByLevel[lvl].push(poly);
    }
  }

  const traceRings = (rings) => {
    for (const ring of rings) {
      if (!ring?.length) continue;
      for (let i = 0; i < ring.length; i++) {
        const [px, py] = project(ring[i][0], ring[i][1]);
        if (i === 0) ctx.moveTo(mapX + px, mapY + py);
        else ctx.lineTo(mapX + px, mapY + py);
      }
      ctx.closePath();
    }
  };

  for (const lvl of [1, 2, 3]) {
    const list = polysByLevel[lvl];
    if (!list.length) continue;
    const col = SEVERITY_LEVELS[lvl].color;
    const patCanvas = makeHatchCanvas(col, lvl, Math.max(0.8, u));
    const pat = ctx.createPattern(patCanvas, 'repeat');

    ctx.save();
    ctx.beginPath();
    for (const rings of list) traceRings(rings);
    if (pat) {
      ctx.fillStyle = pat;
      ctx.fill('evenodd');
    } else {
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.22;
      ctx.fill('evenodd');
    }
    ctx.restore();

    // Crisp outer halo then ESTOFEX contour stroke
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = lvl === 1 ? 'butt' : 'round';
    ctx.beginPath();
    for (const rings of list) traceRings(rings);
    ctx.strokeStyle = isDark ? 'rgba(8,14,24,0.85)' : 'rgba(255,255,255,0.88)';
    ctx.lineWidth = Math.max(2.6, (lvl === 1 ? 3.2 : lvl === 2 ? 4.2 : 5.0) * u);
    ctx.stroke();

    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1.6, (lvl === 1 ? 2.0 : lvl === 2 ? 2.7 : 3.4) * u);
    if (lvl === 1) ctx.setLineDash([Math.max(5, 7 * u), Math.max(3, 4 * u)]);
    ctx.stroke();
    ctx.restore();
  }
}

function sevKmlColor(hex, alpha = '88') {
  const c = String(hex || '#dc2626').replace('#', '');
  if (c.length !== 6) return alpha + '2626dc';
  return alpha + c.slice(4, 6) + c.slice(2, 4) + c.slice(0, 2);
}

function severityKmlStyles() {
  return [1, 2, 3].map((l) => {
    const col = SEVERITY_LEVELS[l].color;
    return `<Style id="sev${l}"><LineStyle><color>${sevKmlColor(col, 'ff')}</color><width>${l + 1}</width></LineStyle><PolyStyle><color>${sevKmlColor(col, '55')}</color></PolyStyle></Style>`;
  }).join('');
}

function kmlPolygonsMarks(polys, nameFn, xe) {
  const ringStr = (ring) => ring.map(([lo, la]) => `${lo},${la},0`).join(' ');
  return polys.map((f) => {
    const lvl = Number(f.properties.level || 1);
    const geoms = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : (f.geometry.coordinates || []);
    return geoms.map((rings) => {
      if (!rings?.length) return '';
      const inner = rings.slice(1).map((r) => `<innerBoundaryIs><LinearRing><coordinates>${ringStr(r)}</coordinates></LinearRing></innerBoundaryIs>`).join('');
      return `<Placemark><name>${xe(nameFn(f, lvl))}</name><styleUrl>#sev${lvl}</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>${ringStr(rings[0])}</coordinates></LinearRing></outerBoundaryIs>${inner}</Polygon></Placemark>`;
    }).join('');
  }).join('');
}

export function severityKmlFolder(sevGeo, xe) {
  const polys = (sevGeo?.features || []).filter((f) => f.properties?.feature_type === 'severity_polygon' && f.geometry);
  if (!polys.length) return '';
  const marks = kmlPolygonsMarks(polys, (f, lvl) => {
    const hz = formatHazards(f.properties.hazards, lvl).join(', ');
    return `${SEVERITY_LEVELS[lvl]?.label || `Level ${lvl}`}${hz ? ` (${hz})` : ''}`;
  }, xe);
  return `${severityKmlStyles()}<Folder><name>Severity (ESTOFEX)</name>${marks}</Folder>`;
}

export function inferCellHazardLevel(props, hazard) {
  if (!props || !hazard) return 0;
  const hl = props.hazardLevels;
  if (hl && typeof hl === 'object') {
    const raw = hl[hazard];
    return raw != null && Number.isFinite(Number(raw)) ? Math.max(0, Math.min(3, Math.round(Number(raw)))) : 0;
  }
  if (!Array.isArray(props.hazards) || !props.hazards.includes(hazard)) return 0;
  const cellLvl = Math.max(1, Math.min(3, Math.round(Number(props.level || 1))));
  if (props.hazards[0] === hazard) return cellLvl;
  if (hazard === 'tornado') {
    if (Number.isFinite(Number(props.stp))) {
      const stp = Number(props.stp);
      return Math.max(1, Math.min(cellLvl, stp >= 3.6 ? 3 : stp >= 1.9 ? 2 : 1));
    }
    return 1;
  }
  if (hazard === 'hail') {
    if (Number.isFinite(Number(props.scp)) && Number(props.scp) > 0) {
      const scp = Number(props.scp);
      return Math.max(1, Math.min(cellLvl, scp >= 9.0 ? 3 : scp >= 4.0 ? 2 : 1));
    }
    return 1;
  }
  if (hazard === 'wind') {
    if (Number.isFinite(Number(props.gustMph)) && Number(props.gustMph) > 0) {
      const g = Number(props.gustMph);
      return Math.max(1, Math.min(cellLvl, g >= 78 ? 3 : g >= 66 ? 2 : 1));
    }
    return 1;
  }
  if (hazard === 'rain') {
    return Math.min(cellLvl, Number(props.score || 0) >= 2.2 ? 2 : 1);
  }
  return 1;
}

function detectGridStep(sortedVals) {
  const unique = [];
  for (const v of sortedVals) {
    const r = Math.round(v * 1e4) / 1e4;
    if (!unique.length || r - unique[unique.length - 1] > 0.005) unique.push(r);
  }
  const diffs = [];
  for (let i = 1; i < unique.length; i++) {
    const d = unique[i] - unique[i - 1];
    if (d > 0.005) diffs.push(d);
  }
  if (!diffs.length) return null;
  const dMin = Math.min(...diffs);
  const cluster = diffs.filter((d) => d <= dMin * 1.15);
  return cluster.reduce((a, b) => a + b, 0) / cluster.length;
}

function ringSignedArea(pts) {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    sum += x0 * y1 - x1 * y0;
  }
  return sum * 0.5;
}

function simplifyCollinearLoop(pts) {
  if (pts.length <= 4) return pts;
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const cross = (cur[0] - prev[0]) * (next[1] - cur[1]) - (cur[1] - prev[1]) * (next[0] - cur[0]);
    if (Math.abs(cross) > 1e-9) out.push(cur);
  }
  return out.length >= 3 ? out : pts;
}

function chaikinLoop(pts, passes = 2) {
  let cur = pts;
  for (let p = 0; p < passes; p++) {
    const next = [];
    const n = cur.length;
    for (let i = 0; i < n; i++) {
      const a = cur[i];
      const b = cur[(i + 1) % n];
      next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      next.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    cur = next;
  }
  return cur;
}

function buildGridPolygons(cellsByLevel, lon0, lat0, dx, dy, hazard) {
  const features = [];
  // Priority order at saddle vertices: turn left > straight > turn right > reverse
  const NEXT_DIRS = (inDir) => [(inDir + 1) & 3, inDir, (inDir + 3) & 3, (inDir + 2) & 3];
  const toRingCoords = (loop) => {
    const coords = loop.map(([gx, gy]) => [
      +(lon0 + (gx - 0.5) * dx).toFixed(5),
      +(lat0 + (gy - 0.5) * dy).toFixed(5),
    ]);
    if (coords.length) coords.push([coords[0][0], coords[0][1]]);
    return coords;
  };

  for (const lvl of [1, 2, 3]) {
    const cellSet = cellsByLevel[lvl];
    if (!cellSet || !cellSet.size) continue;

    // Map startKey -> array of directed edge objects { x0, y0, x1, y1, dir, used }
    const byStart = new Map();
    const edges = [];
    const addEdge = (x0, y0, x1, y1, dir) => {
      const e = { x0, y0, x1, y1, dir, used: false };
      edges.push(e);
      const k = `${x0},${y0}`;
      let list = byStart.get(k);
      if (!list) { list = []; byStart.set(k, list); }
      list.push(e);
    };

    for (const key of cellSet) {
      const sep = key.indexOf(',');
      const ix = Number(key.slice(0, sep));
      const iy = Number(key.slice(sep + 1));
      if (!cellSet.has(`${ix},${iy - 1}`)) addEdge(ix, iy, ix + 1, iy, 0);         // South -> East
      if (!cellSet.has(`${ix + 1},${iy}`)) addEdge(ix + 1, iy, ix + 1, iy + 1, 1); // East -> North
      if (!cellSet.has(`${ix},${iy + 1}`)) addEdge(ix + 1, iy + 1, ix, iy + 1, 2); // North -> West
      if (!cellSet.has(`${ix - 1},${iy}`)) addEdge(ix, iy + 1, ix, iy, 3);         // West -> South
    }

    const outers = [];
    const holes = [];
    for (const startEdge of edges) {
      if (startEdge.used) continue;
      const raw = [];
      let cur = startEdge;
      while (cur && !cur.used) {
        cur.used = true;
        raw.push([cur.x0, cur.y0]);
        const cands = byStart.get(`${cur.x1},${cur.y1}`);
        let next = null;
        if (cands?.length) {
          for (const d of NEXT_DIRS(cur.dir)) {
            next = cands.find((e) => !e.used && e.dir === d);
            if (next) break;
          }
          if (!next) next = cands.find((e) => !e.used) || null;
        }
        cur = next;
      }
      if (raw.length < 4) continue;
      const simplified = simplifyCollinearLoop(raw);
      if (simplified.length < 3) continue;
      const smooth = chaikinLoop(simplified, 2);
      const area = ringSignedArea(smooth);
      const ring = toRingCoords(smooth);
      if (ring.length < 4) continue;
      if (area >= 0) outers.push({ ring, area, holes: [] });
      else holes.push(ring);
    }

    // Sort outers ascending by area so each hole attaches to the tightest enclosing outer ring
    outers.sort((a, b) => a.area - b.area);
    for (const hole of holes) {
      const [hx, hy] = hole[0];
      const host = outers.find((o) => pointInRing(hx, hy, o.ring));
      if (host) host.holes.push(hole);
    }

    const meta = SEVERITY_LEVELS[lvl];
    for (const o of outers) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [o.ring, ...o.holes] },
        properties: {
          feature_type: 'severity_polygon',
          hazard,
          level: lvl,
          label: meta.label,
          color: meta.color,
        },
      });
    }
  }
  return features;
}

function ellipticalPadCoords(lon, lat, rx = 0.32, ry = 0.20, steps = 20) {
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ring.push([+(lon + Math.cos(a) * rx).toFixed(5), +(lat + Math.sin(a) * ry).toFixed(5)]);
  }
  return ring;
}

const hazardCache = new WeakMap();

export function hazardSeverityGeo(sevGeo, hazard) {
  const empty = {
    type: 'FeatureCollection',
    properties: { hazard, maxLevel: 0, peakMetric: null },
    features: [],
  };
  if (!sevGeo?.features?.length || !hazard) return empty;

  let byHz = hazardCache.get(sevGeo);
  if (!byHz) {
    byHz = new Map();
    hazardCache.set(sevGeo, byHz);
  }
  if (byHz.has(hazard)) return byHz.get(hazard);

  const hasBackendHazardPolys = sevGeo.properties?.hazardPolygons === true
    || sevGeo.features.some((f) => f.properties?.feature_type === 'hazard_polygon');
  const allPts = sevGeo.features.filter((f) => f.properties?.feature_type === 'severity_point' && f.geometry?.type === 'Point');

  const outPts = [];
  let maxLevel = 0;
  let peakMetric = null;

  for (const pt of allPts) {
    const hl = inferCellHazardLevel(pt.properties, hazard);
    if (hl < 1) continue;
    if (hl > maxLevel) maxLevel = hl;
    const p = pt.properties;
    const mVal = hazard === 'tornado' ? Number(p.stp)
      : hazard === 'hail' ? Number(p.scp)
        : hazard === 'wind' ? Number(p.gustMph)
          : Number(p.score);
    if (Number.isFinite(mVal) && (peakMetric == null || mVal > peakMetric)) peakMetric = mVal;
    outPts.push({
      type: 'Feature',
      geometry: pt.geometry,
      properties: {
        ...p,
        feature_type: 'severity_point',
        hazard,
        level: hl,
        label: SEVERITY_LEVELS[hl]?.label || `Level ${hl}`,
        hazards: [hazard],
      },
    });
  }

  let outPolys = [];
  if (hasBackendHazardPolys) {
    for (const f of sevGeo.features) {
      if (f.properties?.feature_type !== 'hazard_polygon' || f.properties?.hazard !== hazard || !f.geometry) continue;
      const lvl = Math.max(1, Math.min(3, Number(f.properties.level || 1)));
      if (lvl > maxLevel) maxLevel = lvl;
      outPolys.push({
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          ...f.properties,
          feature_type: 'severity_polygon',
          hazard,
          level: lvl,
          label: SEVERITY_LEVELS[lvl]?.label || `Level ${lvl}`,
          color: SEVERITY_LEVELS[lvl]?.color || '#d97706',
        },
      });
    }
  } else if (allPts.length) {
    const lons = allPts.map((f) => f.geometry.coordinates[0]).sort((a, b) => a - b);
    const lats = allPts.map((f) => f.geometry.coordinates[1]).sort((a, b) => a - b);
    let dx = detectGridStep(lons);
    let dy = detectGridStep(lats);
    if (dx != null && dy == null) dy = dx * 0.65;
    if (dy != null && dx == null) dx = dy / 0.65;

    const isDenseGrid = allPts.length >= 4 && dx != null && dy != null && dx >= 0.02 && dx <= 0.45 && dy >= 0.015 && dy <= 0.35;
    if (isDenseGrid) {
      const lon0 = lons[0];
      const lat0 = lats[0];
      const cellsByLevel = { 1: new Set(), 2: new Set(), 3: new Set() };
      for (const pt of outPts) {
        const [lon, lat] = pt.geometry.coordinates;
        const ix = Math.round((lon - lon0) / dx);
        const iy = Math.round((lat - lat0) / dy);
        cellsByLevel[pt.properties.level]?.add(`${ix},${iy}`);
      }
      outPolys = buildGridPolygons(cellsByLevel, lon0, lat0, dx, dy, hazard);
    } else if (outPts.length) {
      for (const pt of outPts) {
        const [lon, lat] = pt.geometry.coordinates;
        const lvl = pt.properties.level;
        outPolys.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [ellipticalPadCoords(lon, lat)] },
          properties: {
            feature_type: 'severity_polygon',
            hazard,
            level: lvl,
            label: SEVERITY_LEVELS[lvl]?.label || `Level ${lvl}`,
            color: SEVERITY_LEVELS[lvl]?.color || '#d97706',
          },
        });
      }
    }
  } else {
    for (const f of sevGeo.features) {
      if (f.properties?.feature_type !== 'severity_polygon' || !f.geometry) continue;
      if (!Array.isArray(f.properties.hazards) || !f.properties.hazards.includes(hazard)) continue;
      const lvl = Math.max(1, Math.min(3, Number(f.properties.level || 1)));
      if (lvl > maxLevel) maxLevel = lvl;
      outPolys.push({
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          ...f.properties,
          feature_type: 'severity_polygon',
          hazard,
          level: lvl,
          label: SEVERITY_LEVELS[lvl]?.label || `Level ${lvl}`,
          color: SEVERITY_LEVELS[lvl]?.color || '#d97706',
        },
      });
    }
  }

  outPolys.sort((a, b) => Number(a.properties.level || 0) - Number(b.properties.level || 0));
  const res = {
    type: 'FeatureCollection',
    properties: { hazard, maxLevel, peakMetric },
    features: [...outPolys, ...outPts],
  };
  byHz.set(hazard, res);
  return res;
}

export function hazardMaxLevels(sevGeo) {
  const out = {};
  for (const p of HAZARD_PANELS) {
    const preset = sevGeo?.properties?.hazardMaxLevels?.[p.key];
    if (Number.isFinite(Number(preset))) {
      out[p.key] = Math.max(0, Math.min(3, Number(preset)));
    } else {
      out[p.key] = hazardSeverityGeo(sevGeo, p.key).properties.maxLevel || 0;
    }
  }
  return out;
}

export function mergeHazardSevGeos(sevGeos, hazard) {
  const list = Array.isArray(sevGeos) ? sevGeos.filter(Boolean) : (sevGeos ? [sevGeos] : []);
  const polys = [];
  const pts = [];
  let maxLevel = 0;
  let peakMetric = null;
  for (const sg of list) {
    const hg = hazardSeverityGeo(sg, hazard);
    if ((hg.properties?.maxLevel || 0) > maxLevel) maxLevel = hg.properties.maxLevel;
    const pm = hg.properties?.peakMetric;
    if (pm != null && (peakMetric == null || pm > peakMetric)) peakMetric = pm;
    for (const f of hg.features || []) {
      if (f.properties?.feature_type === 'severity_polygon') polys.push(f);
      else if (f.properties?.feature_type === 'severity_point') pts.push(f);
    }
  }
  polys.sort((a, b) => Number(a.properties?.level || 0) - Number(b.properties?.level || 0));
  return {
    type: 'FeatureCollection',
    properties: { hazard, maxLevel, peakMetric },
    features: [...polys, ...pts],
  };
}

export function severityHazardKmlFolders(sevGeosOrGeo, xe, { includeStyles = false } = {}) {
  const styles = includeStyles ? severityKmlStyles() : '';
  const folders = HAZARD_PANELS.map((panel) => {
    const hg = mergeHazardSevGeos(sevGeosOrGeo, panel.key);
    const polys = (hg.features || []).filter((f) => f.properties?.feature_type === 'severity_polygon' && f.geometry);
    if (!polys.length) return '';
    const marks = kmlPolygonsMarks(polys, (_, lvl) => `${panel.title} · ${SEVERITY_LEVELS[lvl]?.label || `Level ${lvl}`}`, xe);
    return `<Folder><name>${xe(panel.title)}</name>${marks}</Folder>`;
  }).filter(Boolean).join('');
  return folders ? `${styles}<Folder><name>Severity by Hazard</name>${folders}</Folder>` : '';
}
