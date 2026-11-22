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

export function severityKmlFolder(sevGeo, xe) {
  const polys = (sevGeo?.features || []).filter((f) => f.properties?.feature_type === 'severity_polygon' && f.geometry);
  if (!polys.length) return '';
  const styles = [1, 2, 3].map((l) => {
    const col = SEVERITY_LEVELS[l].color;
    return `<Style id="sev${l}"><LineStyle><color>${sevKmlColor(col, 'ff')}</color><width>${l + 1}</width></LineStyle><PolyStyle><color>${sevKmlColor(col, '55')}</color></PolyStyle></Style>`;
  }).join('');
  const ringStr = (ring) => ring.map(([lo, la]) => `${lo},${la},0`).join(' ');
  const marks = polys.map((f) => {
    const lvl = Number(f.properties.level || 1);
    const hz = formatHazards(f.properties.hazards, lvl).join(', ');
    const rings = f.geometry.type === 'Polygon' ? f.geometry.coordinates : (f.geometry.coordinates[0] || []);
    if (!rings.length) return '';
    const inner = rings.slice(1).map((r) => `<innerBoundaryIs><LinearRing><coordinates>${ringStr(r)}</coordinates></LinearRing></innerBoundaryIs>`).join('');
    return `<Placemark><name>${xe(SEVERITY_LEVELS[lvl]?.label || `Level ${lvl}`)}${hz ? ` (${xe(hz)})` : ''}</name><styleUrl>#sev${lvl}</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>${ringStr(rings[0])}</coordinates></LinearRing></outerBoundaryIs>${inner}</Polygon></Placemark>`;
  }).join('');
  return `${styles}<Folder><name>Severity (ESTOFEX)</name>${marks}</Folder>`;
}
