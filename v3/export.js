// HOCO v3 publication-grade chart export: Pivotal-Weather-style layout with domain bounding boxes,
// lat/lon graticule + edge ticks, entire-region & multi-region cycle plotting, and multi-region KML.

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const xe = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

const EXPORTS = {
  landscape: [1600, 1100, 'Landscape'],
  square: [1200, 1200, 'Square'],
  story: [1080, 1920, 'Story'],
};

const EX = {
  size: 'landscape',
  file: 'png',
  extent: 'region',
  key: true,
  bbox: true,
  graticule: true,
};

const UTC_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtUtc = (d) => d ? `${UTC_DOW[d.getUTCDay()]} ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z` : '';
const fmtLocal = (d) => d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
const fmtLat = (v) => v === 0 ? '0°' : `${Math.abs(v)}°${v > 0 ? 'N' : 'S'}`;
const fmtLon = (v) => v === 0 ? '0°' : `${Math.abs(v)}°${v > 0 ? 'E' : 'W'}`;
const parseAutoParts = (id) => {
  const m = String(id || '').match(/^(AUTO-\d+)-(.+?)-(Day\d+-\d+(?:-BENCHMARK)?)$/);
  return m ? { prefix: m[1], dayTag: m[3] } : null;
};
const hasGeoPayload = (r) => !!(r && (r.geojsonUrl || r.inlineGeojson || r.inlineGeojsonText || r.geojson || r.ensembleGeojson));

function kmlColor(hex, a = 'b3') {
  const h = String(hex || '#9fd8c4').replace('#', '');
  return a + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2);
}

function niceDegStep(spanDeg, targetCount = 5) {
  if (!Number.isFinite(spanDeg) || spanDeg <= 0) return 5;
  const raw = spanDeg / Math.max(2, targetCount);
  const steps = [1, 2, 5, 10, 15, 20];
  return steps.find((s) => s >= raw) || 20;
}

function pickTicks(minVal, maxVal, step) {
  const start = Math.ceil((minVal - 1e-9) / step) * step;
  const out = [];
  for (let v = start; v <= maxVal + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

function rectsOverlap(a, b, padPx = 4) {
  return !(a.x + a.w + padPx <= b.x || b.x + b.w + padPx <= a.x || a.y + a.h + padPx <= b.y || b.y + b.h + padPx <= a.y);
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

export function initExport(deps) {
  const {
    X, O, setLayer, paintRadar, newRadarState, loadStrikes,
    strikeFeatures, strikeLayer, STRIKE_CLASSES, riskOutlineLayer, getDiffState,
  } = deps;

  const validRegions = () => (X.REGIONS || []).filter((r) => Number.isFinite(r.west));

  function canonicalRegion(run) {
    const regs = validRegions();
    return regs.find((r) => X.regionMatches(r.id, run))
      || regs.find((r) => r.id === X.S.region)
      || { id: run?.region || X.S.region || 'UK', name: run?.region || X.S.region || 'UK' };
  }

  function matchCycleSiblings(refRun, wantType, { requireStormHour = false } = {}) {
    const regs = validRegions();
    const curReg = canonicalRegion(refRun);
    const curIdx = regs.findIndex((r) => r.id === curReg.id);
    const pool = (X.srcRuns?.() || []).filter((r) =>
      r && r.type === wantType && r.status !== 'pending' && !X.hidden?.(r)
      && (!requireStormHour || r.stormHour === true)
      && (requireStormHour || hasGeoPayload(r))
    );
    const refIdForParse = wantType === 'ai' ? (refRun.sourceRunId || String(refRun.id).replace(/^AI-/, '')) : refRun.id;
    const refParts = parseAutoParts(refIdForParse);
    const refStart = X.startOf(refRun), refEnd = X.endOf(refRun), refCr = X.created(refRun);
    const refDate = refStart ? X.dateKey(refStart) : null;

    const entries = [];
    for (const reg of regs) {
      if (reg.id === curReg.id) {
        entries.push({ region: reg, run: refRun });
        continue;
      }
      const inReg = pool.filter((r) => X.regionMatches(reg.id, r));
      let hit = null;
      if (refParts) {
        hit = inReg.find((r) => {
          const cid = wantType === 'ai' ? (r.sourceRunId || String(r.id).replace(/^AI-/, '')) : r.id;
          const p = parseAutoParts(cid);
          return p && p.prefix === refParts.prefix && p.dayTag === refParts.dayTag;
        }) || null;
      }
      if (!hit && refDate && refEnd && refCr) {
        let bestDt = 25 * 60000;
        for (const r of inReg) {
          const rs = X.startOf(r), re = X.endOf(r), rc = X.created(r);
          if (!rs || !re || !rc || X.dateKey(rs) !== refDate) continue;
          if (Math.abs(re.getTime() - refEnd.getTime()) > 2 * 3600000) continue;
          const dt = Math.abs(rc.getTime() - refCr.getTime());
          if (dt <= bestDt) { bestDt = dt; hit = r; }
        }
      }
      if (hit) entries.push({ region: reg, run: hit });
    }
    if (curIdx < 0 && !entries.some((e) => e.region.id === curReg.id)) {
      entries.unshift({ region: curReg, run: refRun });
    }
    return entries;
  }

  function findAvailableRegionRuns(run) {
    const curReg = canonicalRegion(run);
    if (!run) return { entries: [], isTiming: false, resolveTiming: async () => [] };

    if (run.type === 'automated' || run.type === 'ai') {
      const entries = matchCycleSiblings(run, run.type);
      return { entries, isTiming: false, resolveTiming: async () => entries };
    }

    if (run.type === 'timing') {
      const all = X.srcRuns?.() || [];
      const src = all.find((r) => r.id === run.sourceRunId)
        || { id: run.sourceRunId, type: 'automated', status: 'completed', region: run.region || curReg.id, stormHour: true, createdAt: run.createdAt, validFrom: run.validFrom, validTo: run.validTo };
      const candSources = src.type === 'automated' ? matchCycleSiblings(src, 'automated', { requireStormHour: true }) : [{ region: curReg, run: src }];
      const baseEntries = candSources.map(({ region, run: sRun }) => ({
        region,
        run: region.id === curReg.id ? run : null,
        sourceRun: sRun,
      }));
      const resolveTiming = async () => {
        const wStart = X.startOf(run)?.getTime(), wEnd = X.endOf(run)?.getTime();
        const resolved = await Promise.all(baseEntries.map(async (entry) => {
          if (entry.run) return { region: entry.region, run: entry.run };
          if (!X.hourcastWindows || !entry.sourceRun || !Number.isFinite(wStart) || !Number.isFinite(wEnd)) return null;
          try {
            const wins = await X.hourcastWindows(entry.sourceRun);
            let best = null, bestOverlap = 0.8;
            for (const w of wins || []) {
              const a = X.startOf(w)?.getTime(), b = X.endOf(w)?.getTime();
              if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
              const overlap = (Math.min(wEnd, b) - Math.max(wStart, a)) / Math.max(wEnd - wStart, b - a);
              if (overlap >= bestOverlap) { best = w; bestOverlap = overlap; }
            }
            return best ? { region: entry.region, run: best } : null;
          } catch { return null; }
        }));
        return resolved.filter(Boolean);
      };
      return {
        entries: baseEntries.map(({ region, run: r }) => ({ region, run: r || run, pendingTiming: !r })),
        isTiming: true,
        resolveTiming,
      };
    }

    return { entries: [{ region: curReg, run }], isTiming: false, resolveTiming: async () => [{ region: curReg, run }] };
  }

  async function getGeoForRun(run, useLiveObs = false) {
    if (useLiveObs && O.run?.id === run.id && (X.S.obsGeo || X.S.geo)) return X.S.obsGeo || X.S.geo;
    if (X.S.current?.id === run.id && X.S.geo) return X.S.geo;
    if (X.S.custom?.id === run.id && X.S.geo) return X.S.geo;
    return X.fetchGeo(run);
  }

  async function loadExportData(run, info, extent) {
    const curReg = canonicalRegion(run);
    if (extent !== 'all') {
      const geo = await getGeoForRun(run, extent === 'current');
      return {
        items: [{ region: curReg, run, geo, peak: X.peakOf(geo) }],
        mergedGeo: geo,
        spreadGeo: null,
      };
    }

    const entries = info.isTiming ? await info.resolveTiming() : info.entries;
    const fetched = await Promise.all(entries.map(async (e) => {
      try {
        const geo = await getGeoForRun(e.run, false);
        return { region: e.region, run: e.run, geo, peak: X.peakOf(geo) };
      } catch {
        return null;
      }
    }));
    let items = fetched.filter(Boolean);
    if (!items.length) {
      const geo = await getGeoForRun(run, false);
      items = [{ region: curReg, run, geo, peak: X.peakOf(geo) }];
    }

    const polygons = [];
    const points = [];
    let anyBanded = false;
    for (const item of items) {
      if (item.geo?.properties?.hoco_layout === 'bands_v2') anyBanded = true;
      for (const f of item.geo?.features || []) {
        if (f.properties?.feature_type === 'polygon') polygons.push(f);
        else if (f.properties?.feature_type === 'point') points.push(f);
      }
    }
    polygons.sort((a, b) => X.riskOf(a.properties) - X.riskOf(b.properties));
    const mergedGeo = {
      type: 'FeatureCollection',
      properties: anyBanded ? { hoco_layout: 'bands_v2' } : {},
      features: [...polygons, ...points],
    };

    let spreadGeo = null;
    if (X.spreadActive?.()) {
      const spreadFeatures = [];
      for (const item of items) {
        const grid = (item.run.id === O.run?.id && X.spreadGrid?.()) || X.decodeSpread?.(item.geo);
        if (grid) spreadFeatures.push(...(X.spreadMap?.(grid)?.features || []));
      }
      if (spreadFeatures.length) spreadGeo = { type: 'FeatureCollection', features: spreadFeatures };
    }

    return { items, mergedGeo, spreadGeo };
  }

  function addForecastAndOverlaysToMap(m, { mergedGeo, spreadGeo, diffGeo, strikeGeo, includeStrikes }) {
    const label = m.getStyle()?.layers?.find((l) => l.type === 'symbol' && l.layout && l.layout['text-field'])?.id;
    const spreadActive = !!X.spreadActive?.();
    const banded = mergedGeo?.properties?.hoco_layout === 'bands_v2';

    if (!m.getSource('hoco')) m.addSource('hoco', { type: 'geojson', data: mergedGeo || { type: 'FeatureCollection', features: [] } });

    if (O.forecast && !spreadActive) {
      if (!O.outlines && !diffGeo) {
        m.addLayer({
          id: 'hoco-fill', type: 'fill', source: 'hoco',
          filter: ['==', ['get', 'feature_type'], 'polygon'],
          paint: { 'fill-color': X.fillColor(), 'fill-opacity': X.fillOp(mergedGeo), 'fill-antialias': !banded },
        }, label);
      }
      m.addLayer({
        id: 'hoco-line', type: 'line', source: 'hoco',
        filter: ['==', ['get', 'feature_type'], 'polygon'],
        paint: O.outlines
          ? { 'line-color': ['coalesce', ['get', 'fill'], X.colorExpr()], 'line-width': 2.2 }
          : {
            'line-color': X.mapIsDark() ? 'rgba(8,16,28,0.72)' : 'rgba(16,34,56,0.56)',
            'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.45, 8, 1.15],
            'line-opacity': 0.82,
          },
      }, label);
    }

    if (spreadActive && spreadGeo?.features?.length) {
      m.addSource('hoco-spread', { type: 'geojson', data: spreadGeo });
      m.addLayer({
        id: 'hoco-spread', type: 'fill', source: 'hoco-spread',
        paint: { 'fill-color': ['get', 'colour'], 'fill-opacity': 0.78, 'fill-antialias': false },
      }, label);
    } else if (diffGeo?.features?.length) {
      m.addSource('hoco-diff', { type: 'geojson', data: diffGeo });
      m.addLayer({
        id: 'hoco-diff', type: 'circle', source: 'hoco-diff',
        paint: {
          'circle-color': ['interpolate', ['linear'], ['get', 'd'], -40, '#1d4ed8', -5, '#93c5fd', 5, '#fca5a5', 40, '#b91c1c'],
          'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 4, 3, 6, 9, 8, 30],
          'circle-blur': 0.5, 'circle-opacity': 0.75,
        },
      }, label);
    }

    if (includeStrikes && strikeGeo) {
      m.addSource('strikes', { type: 'geojson', data: strikeGeo });
      m.addLayer(strikeLayer('strikes'), riskOutlineLayer(m) || label);
    }

    if (X.outlines?.()) {
      if (!m.getSource('hoco-ref')) m.addSource('hoco-ref', { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8' });
      const col = X.outlineColor();
      m.addLayer({
        id: 'hoco-coast', type: 'line', source: 'hoco-ref', 'source-layer': 'water',
        layout: { visibility: 'visible', 'line-join': 'round' },
        paint: { 'line-color': col, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 6, 1.0, 9, 1.45] },
      }, label);
      m.addLayer({
        id: 'hoco-borders', type: 'line', source: 'hoco-ref', 'source-layer': 'admin',
        filter: ['all', ['<=', ['get', 'admin_level'], 1], ['!=', ['get', 'maritime'], true], ['!=', ['get', 'maritime'], 'true']],
        layout: { visibility: 'visible', 'line-join': 'round' },
        paint: {
          'line-color': col,
          'line-width': ['match', ['get', 'admin_level'], 0, ['interpolate', ['linear'], ['zoom'], 3, 0.85, 8, 1.6], ['interpolate', ['linear'], ['zoom'], 3, 0.5, 8, 1.1]],
          'line-dasharray': ['match', ['get', 'admin_level'], 0, ['literal', [1, 0]], ['literal', [3, 2]]],
        },
      }, label);
    }
  }

  async function prepareStrikeGeo(items, includeStrikes) {
    if (!includeStrikes || O.t == null || O.t0 == null) return null;
    const endT = O.t === O.tNow ? (O.strikeEnd ?? O.t) : O.t;
    const rawList = Array.isArray(O.strikeData)
      ? O.strikeData
      : await loadStrikes(O.t0, Math.min(endT + 5 * 60000, Date.now())).catch(() => []);
    const regs = items.map((i) => i.region).filter((r) => Number.isFinite(r?.west));
    let filtered = rawList;
    if (regs.length) {
      const w = Math.min(...regs.map((r) => r.west));
      const s = Math.min(...regs.map((r) => r.south));
      const e = Math.max(...regs.map((r) => r.east));
      const n = Math.max(...regs.map((r) => r.north));
      filtered = rawList.filter((p) => p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n);
    }
    return strikeFeatures(filtered, endT, O.t0);
  }

  async function captureMapFrame({ mapW, mapH, extent, items, mergedGeo, spreadGeo, includeStrikes, includeRadar }) {
    const boundsRegions = items.map((i) => i.region).filter((r) => Number.isFinite(r?.west));
    const effectiveExtent = (extent === 'current' || !boundsRegions.length) ? 'current' : extent;

    if (effectiveExtent === 'current') {
      await Promise.race([new Promise((r) => { X.map.once('render', r); X.map.triggerRepaint(); }), new Promise((r) => setTimeout(r, 700))]);
      const src = X.map.getCanvas();
      const srcW = src.clientWidth || src.width || mapW;
      const srcH = src.clientHeight || src.height || mapH;
      const scale = Math.max(mapW / srcW, mapH / srcH);
      const dw = srcW * scale, dh = srcH * scale;
      const ox = (mapW - dw) / 2, oy = (mapH - dh) / 2;
      return {
        effectiveExtent,
        drawMapTo(ctx, mapX, mapY) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(mapX, mapY, mapW, mapH);
          ctx.clip();
          ctx.drawImage(src, mapX + ox, mapY + oy, dw, dh);
          ctx.restore();
        },
        project(lon, lat) {
          const p = X.map.project ? X.map.project([lon, lat]) : { x: mapW / 2, y: mapH / 2 };
          return [ox + p.x * scale, oy + p.y * scale];
        },
        unproject(px, py) {
          return X.map.unproject([(px - ox) / scale, (py - oy) / scale]);
        },
        cleanup() {},
      };
    }

    const west = Math.min(...boundsRegions.map((r) => r.west));
    const south = Math.min(...boundsRegions.map((r) => r.south));
    const east = Math.max(...boundsRegions.map((r) => r.east));
    const north = Math.max(...boundsRegions.map((r) => r.north));
    const padPx = Math.round(Math.min(mapW, mapH) * 0.055);

    const strikeGeo = await prepareStrikeGeo(items, includeStrikes);

    const host = document.createElement('div');
    host.className = 'hoco-export-offscreen';
    host.style.cssText = `position:fixed;left:-12000px;top:0;width:${mapW}px;height:${mapH}px;pointer-events:none;opacity:0;z-index:-1`;
    document.body.appendChild(host);

    let m = null;
    try {
      m = new mapboxgl.Map({
        container: host,
        style: X.styleUrl(),
        bounds: [[west, south], [east, north]],
        fitBoundsOptions: { padding: padPx, duration: 0 },
        attributionControl: false,
        interactive: false,
        fadeDuration: 0,
        projection: 'mercator',
        preserveDrawingBuffer: true,
        pixelRatio: 1,
      });

      await new Promise((resolve) => {
        let done = false;
        const fin = () => { if (!done) { done = true; resolve(); } };
        if (m.isStyleLoaded?.() && m.getStyle?.()?.sources) return setTimeout(fin, 20);
        m.once('style.load', fin);
        m.once('load', fin);
        setTimeout(fin, 10000);
      });

      m.fitBounds([[west, south], [east, north]], { padding: padPx, duration: 0 });

      const diffState = getDiffState?.();
      const diffGeo = extent === 'region' && diffState?.diffOn && diffState.lastDiff?.feats?.length
        ? { type: 'FeatureCollection', features: diffState.lastDiff.feats }
        : null;

      let rst = null;
      if (includeRadar && O.t != null) {
        rst = newRadarState('ex-radar');
        rst.add = (coords, mapInst, st) => {
          if (mapInst.getSource(st.id)) return;
          const label = mapInst.getStyle()?.layers?.find((l) => l.type === 'symbol' && l.layout && l.layout['text-field'])?.id;
          const before = mapInst.getLayer('strikes') ? 'strikes' : riskOutlineLayer(mapInst) || label;
          mapInst.addSource(st.id, { type: 'canvas', canvas: st.canvas, coordinates: coords, animate: false });
          mapInst.addLayer({
            id: st.id, type: 'raster', source: st.id,
            paint: { 'raster-opacity': X.radarOpacity ? X.radarOpacity() : 0.85, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' },
          }, before);
        };
      }

      addForecastAndOverlaysToMap(m, { mergedGeo, spreadGeo, diffGeo, strikeGeo, includeStrikes });

      if (rst) {
        await paintRadar(m, rst, O.t, false).catch(() => {});
      }

      await new Promise((resolve) => {
        let done = false;
        const fin = () => { if (!done) { done = true; resolve(); } };
        m.once('idle', fin);
        setTimeout(fin, 8000);
      });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await Promise.race([new Promise((r) => { m.once('render', r); m.triggerRepaint(); }), new Promise((r) => setTimeout(r, 350))]);

      return {
        effectiveExtent,
        drawMapTo(ctx, mapX, mapY) {
          const cv = m.getCanvas();
          ctx.save();
          ctx.beginPath();
          ctx.rect(mapX, mapY, mapW, mapH);
          ctx.clip();
          ctx.drawImage(cv, mapX, mapY, mapW, mapH);
          ctx.restore();
        },
        project(lon, lat) {
          const p = m.project([lon, lat]);
          return [p.x, p.y];
        },
        unproject(px, py) {
          return m.unproject([px, py]);
        },
        cleanup() {
          try { m?.remove(); } catch {}
          host.remove();
        },
      };
    } catch (err) {
      try { m?.remove(); } catch {}
      host.remove();
      throw err;
    }
  }

  // Vector rendering of the Handry Outlook rainbow emblem (canvas-safe, matches icons/icon-192.png palette)
  function drawBrandEmblem(ctx, cx, bottomY, radius) {
    const arcs = [
      [1.00, '#f5c817'],
      [0.83, '#c8281d'],
      [0.66, '#f07427'],
      [0.49, '#ffffff'],
      [0.33, '#7d8796'],
      [0.18, '#283673'],
    ];
    for (const [frac, col] of arcs) {
      ctx.beginPath();
      ctx.arc(cx, bottomY, radius * frac, Math.PI, 0, false);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
    }
  }

  function drawHalodText(ctx, text, x, y, haloCol, fillCol, haloWidth) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeStyle = haloCol;
    ctx.lineWidth = haloWidth;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fillCol;
    ctx.fillText(text, x, y);
  }

  function drawDomainBoxes(ctx, { items, mapX, mapY, mapW, mapH, project, isDark, singleRegion }) {
    const boxRegions = items.filter((it) => Number.isFinite(it.region?.west));
    if (!boxRegions.length) return;
    const u = Math.min(mapW, mapH) / 900;
    const haloCol = isDark ? 'rgba(10,16,28,0.88)' : 'rgba(255,255,255,0.88)';
    const strokeCol = isDark ? '#f8fafc' : '#0f1b2d';

    const projected = boxRegions.map((it) => {
      const r = it.region;
      const nw = project(r.west, r.north), se = project(r.east, r.south);
      const x0 = mapX + Math.min(nw[0], se[0]);
      const y0 = mapY + Math.min(nw[1], se[1]);
      const x1 = mapX + Math.max(nw[0], se[0]);
      const y1 = mapY + Math.max(nw[1], se[1]);
      return { it, x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
    });

    // Draw outer box frames clipped cleanly to the map frame
    ctx.save();
    ctx.beginPath();
    ctx.rect(mapX, mapY, mapW, mapH);
    ctx.clip();

    for (const b of projected) {
      ctx.strokeStyle = haloCol;
      ctx.lineWidth = Math.max(2.6, 3.4 * u);
      ctx.strokeRect(b.x0, b.y0, b.w, b.h);

      ctx.strokeStyle = strokeCol;
      ctx.lineWidth = Math.max(1.4, 1.8 * u);
      ctx.strokeRect(b.x0, b.y0, b.w, b.h);

      // Subtle corner bracket accents for multi-region clarity
      const arm = Math.min(14 * u, b.w * 0.16, b.h * 0.16);
      if (arm >= 5) {
        ctx.lineWidth = Math.max(2.2, 2.8 * u);
        ctx.beginPath();
        // NW
        ctx.moveTo(b.x0, b.y0 + arm); ctx.lineTo(b.x0, b.y0); ctx.lineTo(b.x0 + arm, b.y0);
        // NE
        ctx.moveTo(b.x1 - arm, b.y0); ctx.lineTo(b.x1, b.y0); ctx.lineTo(b.x1, b.y0 + arm);
        // SE
        ctx.moveTo(b.x1, b.y1 - arm); ctx.lineTo(b.x1, b.y1); ctx.lineTo(b.x1 - arm, b.y1);
        // SW
        ctx.moveTo(b.x0 + arm, b.y1); ctx.lineTo(b.x0, b.y1); ctx.lineTo(b.x0, b.y1 - arm);
        ctx.stroke();
      }
    }

    // Place compact non-overlapping corner labels inside each domain bounding box
    const placed = [
      // Reserve bottom-left attribution and bottom-right Handry Outlook brand mark areas
      { x: mapX, y: mapY + mapH - 42 * u, w: Math.min(mapW * 0.44, 340 * u), h: 42 * u },
      { x: mapX + mapW - Math.min(mapW * 0.44, 340 * u), y: mapY + mapH - 54 * u, w: Math.min(mapW * 0.44, 340 * u), h: 54 * u },
    ];
    const fontSize = Math.max(10, Math.round(12 * u));
    const pillPadX = Math.round(7 * u);
    const pillH = Math.round(fontSize + 9 * u);
    const swSize = Math.round(8 * u);
    const inset = Math.round(7 * u);
    ctx.font = `700 ${fontSize}px Inter, system-ui, sans-serif`;

    for (const b of projected) {
      if (b.w < 54 || b.h < 28) continue;
      const pk = b.it.peak?.risk ?? 0;
      const band = pk >= 5 ? X.bandFor(pk) : null;
      const pkTxt = pk >= 5 ? ` · ${Math.round(pk)}%` : singleRegion ? '' : ' · <5%';
      const label = `${b.it.region.name.toUpperCase()}${pkTxt}`;
      const textW = ctx.measureText(label).width;
      const hasSwatch = !!band;
      const pillW = Math.round(pillPadX * 2 + textW + (hasSwatch ? swSize + 5 * u : 0));
      if (pillW > b.w - 8) continue;

      const cands = [
        { x: b.x0 + inset, y: b.y0 + inset },
        { x: b.x1 - pillW - inset, y: b.y0 + inset },
        { x: b.x0 + inset, y: b.y1 - pillH - inset },
        { x: b.x1 - pillW - inset, y: b.y1 - pillH - inset },
      ];
      let best = null, bestPenalty = Infinity;
      for (const c of cands) {
        const rect = { x: c.x, y: c.y, w: pillW, h: pillH };
        const inMap = rect.x >= mapX + 3 && rect.y >= mapY + 3 && rect.x + rect.w <= mapX + mapW - 3 && rect.y + rect.h <= mapY + mapH - 3;
        if (!inMap) continue;
        let penalty = 0;
        for (const p of placed) if (rectsOverlap(rect, p, 4)) penalty += 100;
        for (const ob of projected) {
          if (ob === b) continue;
          const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
          if (cx >= ob.x0 && cx <= ob.x1 && cy >= ob.y0 && cy <= ob.y1) penalty += 15;
        }
        if (penalty < bestPenalty) { bestPenalty = penalty; best = rect; }
      }
      if (!best) continue;
      placed.push(best);

      ctx.fillStyle = isDark ? 'rgba(11,18,32,0.88)' : 'rgba(255,255,255,0.92)';
      ctx.strokeStyle = isDark ? 'rgba(248,250,252,0.6)' : 'rgba(15,27,45,0.45)';
      ctx.lineWidth = Math.max(1, 1.1 * u);
      roundRectPath(ctx, best.x, best.y, best.w, best.h, 4 * u);
      ctx.fill();
      ctx.stroke();

      let tx = best.x + pillPadX;
      if (hasSwatch) {
        ctx.fillStyle = band.fill;
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 0.8;
        ctx.fillRect(tx, best.y + (best.h - swSize) / 2, swSize, swSize);
        ctx.strokeRect(tx, best.y + (best.h - swSize) / 2, swSize, swSize);
        tx += swSize + 5 * u;
      }
      ctx.fillStyle = isDark ? '#f8fafc' : '#0f1b2d';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, tx, best.y + best.h / 2 + 0.5);
    }
    ctx.restore();
    ctx.textBaseline = 'alphabetic';
  }

  function drawGraticuleAndTicks(ctx, { mapX, mapY, mapW, mapH, project, unproject, isDark, u }) {
    let corners;
    try {
      corners = [unproject(0, 0), unproject(mapW, 0), unproject(mapW, mapH), unproject(0, mapH)];
    } catch { return; }
    if (!corners.every((c) => c && Number.isFinite(c.lng) && Number.isFinite(c.lat))) return;

    const minLon = Math.min(...corners.map((c) => c.lng));
    const maxLon = Math.max(...corners.map((c) => c.lng));
    const minLat = Math.min(...corners.map((c) => c.lat));
    const maxLat = Math.max(...corners.map((c) => c.lat));

    const lonStep = niceDegStep(maxLon - minLon, mapW > 950 ? 6 : 4);
    const latStep = niceDegStep(maxLat - minLat, mapH > 950 ? 6 : 4);
    const lons = pickTicks(minLon, maxLon, lonStep);
    const lats = pickTicks(minLat, maxLat, latStep);

    // Subtle interior graticule lines
    ctx.save();
    ctx.beginPath();
    ctx.rect(mapX, mapY, mapW, mapH);
    ctx.clip();
    ctx.strokeStyle = isDark ? 'rgba(241,245,249,0.16)' : 'rgba(15,23,42,0.14)';
    ctx.lineWidth = Math.max(0.7, 0.9 * u);
    ctx.setLineDash([4 * u, 4 * u]);

    for (const lon of lons) {
      const a = project(lon, maxLat), b = project(lon, minLat);
      ctx.beginPath();
      ctx.moveTo(mapX + a[0], mapY);
      ctx.lineTo(mapX + b[0], mapY + mapH);
      ctx.stroke();
    }
    for (const lat of lats) {
      const a = project(minLon, lat), b = project(maxLon, lat);
      ctx.beginPath();
      ctx.moveTo(mapX, mapY + a[1]);
      ctx.lineTo(mapX + mapW, mapY + b[1]);
      ctx.stroke();
    }
    ctx.restore();

    // Crisp outer tick pips + coordinate labels along left & bottom margins
    const tickLen = Math.round(5 * u);
    const lblFont = `600 ${Math.max(10, Math.round(12 * u))}px Inter, system-ui, sans-serif`;
    ctx.font = lblFont;
    ctx.strokeStyle = '#0f172a';
    ctx.fillStyle = '#334155';
    ctx.lineWidth = Math.max(1.1, 1.3 * u);

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    let lastLatY = -Infinity;
    for (const lat of lats) {
      const py = mapY + project((minLon + maxLon) / 2, lat)[1];
      if (py < mapY + 10 * u || py > mapY + mapH - 10 * u) continue;
      ctx.beginPath();
      ctx.moveTo(mapX - tickLen, py);
      ctx.lineTo(mapX, py);
      ctx.stroke();
      if (Math.abs(py - lastLatY) >= 24 * u) {
        ctx.fillText(fmtLat(lat), mapX - tickLen - 4 * u, py);
        lastLatY = py;
      }
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let lastLonX = -Infinity;
    for (const lon of lons) {
      const px = mapX + project(lon, (minLat + maxLat) / 2)[0];
      if (px < mapX + 18 * u || px > mapX + mapW - 18 * u) continue;
      ctx.beginPath();
      ctx.moveTo(px, mapY + mapH);
      ctx.lineTo(px, mapY + mapH + tickLen);
      ctx.stroke();
      if (px - lastLonX >= 46 * u) {
        ctx.fillText(fmtLon(lon), px, mapY + mapH + tickLen + 3 * u);
        lastLonX = px;
      }
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  function drawLegendStrip(ctx, { W, mapX, mapW, stripY, stripH, spreadActive, includeStrikes, includeRadar, u }) {
    const F = (sz, wt = 700) => `${wt} ${Math.max(10, Math.round(sz * u))}px Inter, system-ui, sans-serif`;
    const isSpread = spreadActive;
    const barH = Math.round(16 * u);
    const barTop = stripY + Math.round(24 * u);
    const showExtras = includeStrikes || includeRadar;
    const wideInline = includeStrikes && !includeRadar && W >= 1400;

    // Colorbar title + segmented cells with aligned edge boundary ticks (Pivotal Weather grammar)
    const labelStr = isSpread ? 'Spread (pp):' : 'Risk (%):';
    ctx.font = F(14.5, 700);
    const lblW = Math.ceil(ctx.measureText(labelStr).width) + Math.round(14 * u);
    const bands = isSpread ? (X.SPREAD_BANDS || []) : X.BANDS;
    const endLabel = isSpread ? '30+' : '100%';
    ctx.font = F(12.5, 600);
    const endCapW = Math.ceil(ctx.measureText(endLabel).width / 2) + Math.round(6 * u);
    const capPx = bands.length <= 6 ? 420 * u : (wideInline ? Math.min(mapW * 0.56, 760 * u) : 920 * u);
    const maxBarW = Math.min(mapW - lblW - endCapW, capPx);
    const barX = mapX + lblW;
    const barW = Math.max(180 * u, maxBarW);
    const cellW = barW / bands.length;

    ctx.font = F(14.5, 700);
    ctx.fillStyle = '#0f172a';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelStr, mapX, barTop + barH / 2);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.font = F(12.5, 600);
    bands.forEach((b, i) => {
      const fill = isSpread ? b[1] : b.fill;
      const val = isSpread ? b[0] : b.min;
      const cx = barX + i * cellW;
      ctx.fillStyle = fill;
      ctx.fillRect(cx, barTop, cellW + 0.5, barH);
      // Boundary tick pip + label cleanly aligned at left edge of each interval
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = Math.max(1, 1 * u);
      ctx.beginPath();
      ctx.moveTo(cx, barTop - 3.5 * u);
      ctx.lineTo(cx, barTop + barH);
      ctx.stroke();

      ctx.fillStyle = '#0f172a';
      const txt = isSpread && i === bands.length - 1 ? `${val}+` : String(val);
      ctx.fillText(txt, cx, barTop - 5 * u);
    });
    // Right closing border + upper-bound tick for risk (%) scale
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = Math.max(1.2, 1.3 * u);
    ctx.strokeRect(barX, barTop, barW, barH);
    if (!isSpread) {
      ctx.beginPath();
      ctx.moveTo(barX + barW, barTop - 3.5 * u);
      ctx.lineTo(barX + barW, barTop + barH);
      ctx.stroke();
      ctx.fillStyle = '#0f172a';
      ctx.fillText('100%', barX + barW, barTop - 5 * u);
    }

    if (!showExtras) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      return;
    }

    // Lightning strikes and/or rain rate legend
    ctx.textAlign = 'left';
    const secY = wideInline ? (barTop + barH / 2) : (barTop + barH + 18 * u);
    let sx = wideInline ? (barX + barW + 46 * u) : mapX;
    if (includeStrikes) {
      ctx.font = F(13.5, 700);
      ctx.fillStyle = '#0f172a';
      ctx.textBaseline = 'middle';
      ctx.fillText('Strikes:', sx, secY);
      sx += ctx.measureText('Strikes:').width + 10 * u;
      ctx.font = F(12.5, 600);
      const rDot = Math.max(4, 5.5 * u);
      for (const [col, name] of STRIKE_CLASSES) {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(sx + rDot, secY, rDot, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#1a1205';
        ctx.lineWidth = 1;
        ctx.stroke();
        sx += rDot * 2 + 5 * u;
        ctx.fillStyle = '#1e293b';
        ctx.fillText(name, sx, secY);
        sx += ctx.measureText(name).width + 12 * u;
      }
    }

    if (includeRadar && sx + 180 * u <= mapX + mapW) {
      if (includeStrikes) sx += 8 * u;
      ctx.font = F(13.5, 700);
      ctx.fillStyle = '#0f172a';
      ctx.textBaseline = 'middle';
      ctx.fillText('Rain (mm/h):', sx, secY);
      sx += ctx.measureText('Rain (mm/h):').width + 8 * u;
      const rw = Math.min(180 * u, mapX + mapW - sx - 10 * u);
      const rh = Math.round(10 * u);
      const grad = ctx.createLinearGradient(sx, 0, sx + rw, 0);
      ['#c8e8b4', '#36b038', '#00741c', '#e8e800', '#ffa800', '#ef1c00', '#a30014', '#b40078', '#6a00b8']
        .forEach((c, idx, arr) => grad.addColorStop(idx / (arr.length - 1), c));
      ctx.fillStyle = grad;
      ctx.fillRect(sx, secY - rh / 2, rw, rh);
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx, secY - rh / 2, rw, rh);
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  async function renderExport(kind = EX.size, optsOrWithKey = {}) {
    const opts = typeof optsOrWithKey === 'boolean'
      ? { key: optsOrWithKey }
      : (optsOrWithKey || {});
    const run = opts.run || O.run;
    if (!run) throw new Error('No active run to export');

    const [W, H] = EXPORTS[kind] || EXPORTS.landscape;
    const extent = opts.extent || EX.extent;
    const withKey = opts.key !== undefined ? !!opts.key : EX.key;
    const withBbox = opts.bbox !== undefined ? !!opts.bbox : EX.bbox;
    const withGraticule = opts.graticule !== undefined ? !!opts.graticule : (withBbox && EX.graticule);
    const includeStrikes = opts.strikes !== undefined ? !!opts.strikes : !!O.strikes;
    const includeRadar = opts.radar !== undefined ? !!opts.radar : !!O.radar;

    const info = opts.regionInfo || findAvailableRegionRuns(run);
    const data = await loadExportData(run, info, extent);
    const { items, mergedGeo, spreadGeo } = data;

    const u = Math.min(W, H) / 1080;
    const F = (sz, wt = 700) => `${wt} ${Math.max(10, Math.round(sz * u))}px Inter, system-ui, sans-serif`;
    const isStory = W < H;
    const leftM = Math.round((withGraticule ? 54 : 26) * u);
    const rightM = Math.round(24 * u);
    const topPad = Math.round(18 * u);
    const mapW = W - leftM - rightM;

    const spreadActive = !!X.spreadActive?.();
    const multiRegion = items.length > 1;
    const st = X.startOf(run), en = X.endOf(run), cr = X.created(run);
    const domainTag = extent === 'current'
      ? `${canonicalRegion(run).name} · Current View`
      : multiRegion
        ? `All Available Regions (${items.length})`
        : `${items[0].region.name} · Full Domain`;

    const titleText = spreadActive
      ? 'HOCO Model Spread · Standard Deviation Across Fields (pp)'
      : run.type === 'timing'
        ? 'Hourcast Short-Window Lightning Risk within 20 km (%)'
        : run.type === 'ai'
          ? 'AI HOCO Thunderstorm Outlook · Lightning within 20 km (%)'
          : 'HOCO Thunderstorm Outlook · Lightning within 20 km (%)';

    const dayPrefix = run.type === 'timing'
      ? `Day ${X.S.day} Hourcast`
      : X.S.custom
        ? (X.TYPE_LABEL?.[run.type] || 'Custom Run')
        : `Day ${X.S.day}`;
    const validStr = run.type === 'timing' && run.windowValidity
      ? `${dayPrefix}  Valid: ${fmtUtc(st)} – ${fmtUtc(en)} (${run.windowValidity})`
      : `${dayPrefix}  Valid: ${st && en ? `${fmtUtc(st)} – ${fmtUtc(en)}` : '–'}`;
    const typeTag = X.TYPE_LABEL?.[run.type] || 'HOCO';
    const initStr = `Init: ${cr ? fmtUtc(cr) : '–'}  ${typeTag}${X.S.archive ? '  ARCHIVE' : ''}`;

    const peakParts = items
      .map((it) => `${it.region.name}: ${it.peak?.risk >= 5 ? Math.round(it.peak.risk) + '%' : '<5%'}`)
      .join('  ·  ');
    const microLeft = `Peak: ${peakParts}${includeStrikes ? '  ·  Strikes: Met Office, UKWX' : ''}${includeRadar ? '  ·  Radar: Windy' : ''}`;
    const microRight = 'Map © Mapbox © OpenStreetMap';

    const tmpCtx = document.createElement('canvas').getContext('2d');
    tmpCtx.font = F(17.5, 600);
    const metaWrapped = isStory || (tmpCtx.measureText(validStr).width + tmpCtx.measureText(initStr).width + 24 * u > mapW);

    const headerH = Math.round(topPad + (isStory ? 28 : 30) * u + (metaWrapped ? 44 : 24) * u + 22 * u);
    const tickBandH = withGraticule ? Math.round(24 * u) : Math.round(10 * u);
    const extraLegendRow = (includeStrikes && !includeRadar && W >= 1400) || (!includeStrikes && !includeRadar) ? 0 : Math.round(28 * u);
    const legendH = withKey ? Math.round(52 * u + extraLegendRow) : Math.round(12 * u);
    const bottomPad = Math.round(10 * u);
    const mapX = leftM;
    const mapY = headerH;
    const mapH = Math.max(320, H - mapY - tickBandH - legendH - bottomPad);

    const capture = await captureMapFrame({
      mapW, mapH, extent, items, mergedGeo, spreadGeo, includeStrikes, includeRadar,
    });

    try {
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const g = canvas.getContext('2d');

      // 1. Crisp white Pivotal-Weather-style outer matte
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, W, H);

      // 2. Top header typography
      let y = topPad + Math.round(22 * u);
      g.font = F(isStory ? 22 : 25, 800);
      g.fillStyle = '#0b1320';
      const domainFont = F(isStory ? 13.5 : 15, 700);
      g.font = domainFont;
      const domW = g.measureText(domainTag).width;
      g.textAlign = 'right';
      g.fillStyle = '#1e3a8a';
      g.fillText(domainTag, mapX + mapW, y);

      g.textAlign = 'left';
      g.font = F(isStory ? 22 : 25, 800);
      g.fillStyle = '#0b1320';
      g.fillText(titleText, mapX, y, Math.max(120, mapW - domW - 14 * u));

      y += Math.round((isStory ? 24 : 25) * u);
      g.font = F(isStory ? 15.5 : 17, 600);
      g.fillStyle = '#1e293b';
      if (metaWrapped) {
        g.fillText(validStr, mapX, y, mapW);
        y += Math.round(20 * u);
        g.fillStyle = '#334155';
        g.fillText(initStr, mapX, y, mapW);
      } else {
        g.fillText(validStr, mapX, y);
        g.textAlign = 'right';
        g.fillText(initStr, mapX + mapW, y);
        g.textAlign = 'left';
      }

      // Micro-attribution / peak line directly above the map border (exact Pivotal Weather position)
      const microY = mapY - Math.round(6 * u);
      g.font = F(11.5, 500);
      g.fillStyle = '#475569';
      g.textAlign = 'right';
      const mrW = g.measureText(microRight).width;
      g.fillText(microRight, mapX + mapW, microY);
      g.textAlign = 'left';
      g.fillText(microLeft, mapX, microY, Math.max(100, mapW - mrW - 16 * u));

      // 3. Draw map into clipped frame
      capture.drawMapTo(g, mapX, mapY);

      const isDark = !!X.mapIsDark?.();

      // 4. Graticule + outside coordinate ticks
      if (withGraticule) {
        drawGraticuleAndTicks(g, {
          mapX, mapY, mapW, mapH,
          project: capture.project,
          unproject: capture.unproject,
          isDark,
          u,
        });
      }

      // 5. Forecast domain bounding box(es) + non-overlapping corner badges
      if (withBbox) {
        drawDomainBoxes(g, {
          items, mapX, mapY, mapW, mapH,
          project: capture.project,
          isDark,
          singleRegion: !multiRegion && capture.effectiveExtent !== 'current',
        });
      }

      // 6. Subtle Pivotal-Weather-style corner watermarks inside map frame
      const halo = isDark ? 'rgba(8,14,24,0.92)' : 'rgba(255,255,255,0.94)';
      const ink = isDark ? '#f8fafc' : '#0b1320';
      const padIn = Math.round(12 * u);

      // Bottom-left URL mark
      g.font = F(16.5, 700);
      g.textAlign = 'left';
      g.textBaseline = 'bottom';
      drawHalodText(g, 'handry-outlook.github.io/HOCO-V2.0', mapX + padIn, mapY + mapH - padIn + 1, halo, ink, Math.max(3, 4.5 * u));

      // Bottom-right vector Handry Outlook emblem + wordmark
      const wmText = 'handry outlook';
      g.font = F(26, 800);
      const wmW = g.measureText(wmText).width;
      const embR = Math.round(13 * u);
      const wmRight = mapX + mapW - padIn;
      const wmY = mapY + mapH - padIn + 2;
      g.textAlign = 'right';
      drawHalodText(g, wmText, wmRight, wmY, halo, ink, Math.max(3.5, 5.5 * u));

      // Draw crisp rounded badge behind the rainbow arc emblem right beside the wordmark
      const embCx = wmRight - wmW - embR - 9 * u;
      const embCy = wmY - 4 * u;
      const badgeSize = embR * 2 + 6 * u;
      g.save();
      roundRectPath(g, embCx - badgeSize / 2, embCy - badgeSize * 0.72, badgeSize, badgeSize * 0.86, 5 * u);
      g.fillStyle = '#283673';
      g.fill();
      g.strokeStyle = halo;
      g.lineWidth = Math.max(1.5, 2 * u);
      g.stroke();
      drawBrandEmblem(g, embCx, embCy + badgeSize * 0.04, embR * 0.86);
      g.restore();

      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';

      // 7. Outer black border enclosing the map viewport
      g.strokeStyle = '#0f172a';
      g.lineWidth = Math.max(1.6, 2 * u);
      g.lineJoin = 'miter';
      g.strokeRect(mapX, mapY, mapW, mapH);

      // 8. Bottom colorbar legend strip
      if (withKey) {
        drawLegendStrip(g, {
          W, mapX, mapW,
          stripY: mapY + mapH + tickBandH,
          stripH: legendH,
          spreadActive,
          includeStrikes,
          includeRadar,
          u,
        });
      }

      return canvas;
    } finally {
      capture.cleanup();
    }
  }

  function bboxRing(r) {
    return [
      [r.west, r.south], [r.east, r.south], [r.east, r.north], [r.west, r.north], [r.west, r.south],
    ].map(([lon, lat]) => `${lon},${lat},0`).join(' ');
  }

  function geoPolygonsToKml(geo) {
    return (geo?.features || [])
      .filter((f) => f.properties?.feature_type === 'polygon' && (f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'))
      .map((f) => {
        const risk = X.riskOf(f.properties), b = X.bandFor(risk), idx = Math.max(0, X.BANDS.indexOf(b));
        const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        return polys.map((p) => `<Placemark><name>${xe(X.bandLabel(b))}</name><styleUrl>#b${idx}</styleUrl><Polygon><tessellate>1</tessellate>${p.map((ring, k) => `<${k ? 'innerBoundaryIs' : 'outerBoundaryIs'}><LinearRing><coordinates>${ring.map((c) => `${c[0]},${c[1]},0`).join(' ')}</coordinates></LinearRing></${k ? 'innerBoundaryIs' : 'outerBoundaryIs'}>`).join('')}</Polygon></Placemark>`).join('');
      }).join('');
  }

  async function buildKml(run, info, extent, includeBbox = true) {
    const data = await loadExportData(run, info, extent);
    const items = data.items;
    const st = X.startOf(run), en = X.endOf(run);
    const styles = X.BANDS.map((b, i) => `<Style id="b${i}"><LineStyle><color>${kmlColor(b.fill, 'ff')}</color><width>1</width></LineStyle><PolyStyle><color>${kmlColor(b.fill)}</color></PolyStyle></Style>`).join('')
      + `<Style id="bbox"><LineStyle><color>ff2d1b0f</color><width>2.5</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>`;

    const body = items.length > 1
      ? items.map((it) => `<Folder><name>${xe(it.region.name)}</name>${geoPolygonsToKml(it.geo)}</Folder>`).join('')
      : geoPolygonsToKml(items[0].geo);

    const bboxFolder = includeBbox && items.some((it) => Number.isFinite(it.region?.west))
      ? `<Folder><name>Domain Bounding Box${items.length > 1 ? 'es' : ''}</name>${items.filter((it) => Number.isFinite(it.region?.west)).map((it) => `<Placemark><name>${xe(it.region.name)} Domain</name><styleUrl>#bbox</styleUrl><LineString><tessellate>1</tessellate><coordinates>${bboxRing(it.region)}</coordinates></LineString></Placemark>`).join('')}</Folder>`
      : '';

    const regTitle = items.length > 1 ? `All Regions (${items.map((i) => i.region.name).join(', ')})` : items[0].region.name;
    const validDesc = run.windowValidity || (st && en ? `${X.dayName(st)} ${fmtLocal(st)} – ${X.dayName(en)} ${fmtLocal(en)}` : '');
    return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${run.type === 'timing' ? 'Hourcast' : 'HOCO'} ${xe(regTitle)} ${st ? X.dayDate(st) : ''}</name><description>Chance of lightning within 20 km. Valid ${xe(validDesc)}. Handry Outlook HOCO.</description>${styles}${body}${bboxFolder}</Document></kml>`;
  }

  async function download(blob, name) {
    const file = new File([blob], name, { type: blob.type });
    if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'HOCO outlook' }); return; } catch {}
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function fileBase(run, extent, entries) {
    const st = X.startOf(run);
    const scope = extent === 'all' && entries.length > 1
      ? 'AllRegions'
      : `${canonicalRegion(run).id}${extent === 'region' ? '-full' : ''}`;
    if (run.type === 'timing') {
      return `Hourcast-${scope}-${st ? st.toISOString().slice(0, 16).replace(':', '') : 'run'}`;
    }
    return `HOCO-${scope}-${st ? `${st.getFullYear()}${pad(st.getMonth() + 1)}${pad(st.getDate())}` : 'run'}`;
  }

  let dlgGen = 0;

  function openExport() {
    const run = O.run;
    if (!run) return X.toast('Nothing to export yet');
    const gen = ++dlgGen;
    const d = $('cookieDlg'), st = X.startOf(run), en = X.endOf(run);
    const curReg = canonicalRegion(run);
    const info = findAvailableRegionRuns(run);
    let busy = false;

    const alive = () => dlgGen === gen && !d.classList.contains('hidden');

    // If Hourcast (timing) is active, check sibling manifests in the background and update the dialog if still open
    if (info.isTiming && info.entries.some((e) => e.pendingTiming)) {
      info.resolveTiming().then((resolved) => {
        if (!alive()) return;
        info.entries = resolved.length ? resolved : [{ region: curReg, run }];
        info.isTiming = false;
        if (EX.extent === 'all' && info.entries.length < 2) EX.extent = 'region';
        draw();
      });
    }

    const draw = () => {
      const canAll = info.entries.length > 1;
      if (EX.extent === 'all' && !canAll) EX.extent = 'region';
      const extentLabel = EX.extent === 'current'
        ? `${curReg.name} · Current view`
        : EX.extent === 'all' && canAll
          ? `All regions (${info.entries.length})`
          : `${curReg.name} · Entire region`;

      const regionChips = canAll && EX.extent === 'all'
        ? `<div class="exregions">${info.entries.map((e) => `<span class="exchip">${esc(e.region.name)}${e.pendingTiming ? '…' : ''}</span>`).join('')}</div>`
        : '';

      const areaOpts = [
        ['current', 'Current view', 'On screen'],
        ['region', 'Entire region', curReg.name],
        ['all', 'All regions', canAll ? `${info.entries.length} regions` : 'Only 1 region', !canAll],
      ];

      d.innerHTML = `<section class="dialog" role="dialog" aria-modal="true" aria-label="Export chart">
        <div class="rowbetween"><h2>Export chart</h2><button class="btn icon" data-x aria-label="Close">✕</button></div>
        <div class="expreview">
          <div class="rowbetween"><b>${run.type === 'timing' ? 'Hourcast' : run.type === 'ai' ? 'AI HOCO Outlook' : 'HOCO Thunderstorm Outlook'}</b><span class="exscope">${esc(extentLabel)}</span></div>
          <span>${esc(run.windowValidity || (st && en ? `${X.dayName(st)} ${X.hhmm(st)} – ${X.dayName(en)} ${X.hhmm(en)}` : ''))}</span>
          ${regionChips}
        </div>
        <div class="setgrp"><span class="kicker">Map area</span>
          <div class="seg wide stack" role="group" aria-label="Map area">
            ${areaOpts.map(([k, l, sub, off]) => `<button data-extent="${k}" aria-pressed="${EX.extent === k}" ${off ? 'disabled' : ''}><span>${l}</span><small>${esc(sub)}</small></button>`).join('')}
          </div>
        </div>
        <label class="item layer"><span><b>Domain bounding box</b><small>Region boundary frame, corner peak label &amp; lat/lon ticks</small></span><input type="checkbox" class="switch" id="exBbox" ${EX.bbox ? 'checked' : ''}></label>
        <label class="item layer"><span><b>Show lightning strikes</b><small>Observed strikes up to now, newest in gold</small></span><input type="checkbox" class="switch" id="exStrikes" ${O.strikes ? 'checked' : ''}></label>
        ${EX.file === 'png' ? `<label class="item layer"><span><b>Show colour key</b><small>Probability scale &amp; strike legend below the map</small></span><input type="checkbox" class="switch" id="exKey" ${EX.key ? 'checked' : ''}></label>` : ''}
        <div class="setgrp"><span class="kicker">File</span>
          <div class="seg wide" role="group"><button data-file="png" aria-pressed="${EX.file === 'png'}">PNG image</button><button data-file="kml" aria-pressed="${EX.file === 'kml'}">KML (Google Earth)</button></div>
        </div>
        ${EX.file === 'png' ? `<div class="setgrp"><span class="kicker">Size</span>
          <div class="seg wide stack" role="group">${Object.entries(EXPORTS).map(([k, [w, h, l]]) => `<button data-size="${k}" aria-pressed="${EX.size === k}"><span>${l}</span><small>${w}×${h}</small></button>`).join('')}</div>
        </div>` : ''}
        <div class="chips" style="justify-content:flex-end">
          <button class="btn" id="exLink">Copy link</button>
          ${X.openEmbed ? '<button class="btn" id="exEmbed">Embed</button>' : ''}
          <button class="btn" id="exShare">Share</button>
          <button class="btn primary" id="exGo">Download ${EX.file.toUpperCase()}</button>
        </div>
      </section>`;

      d.classList.remove('hidden');
      d.querySelector('[data-x]').onclick = () => d.classList.add('hidden');
      $('exBbox').onchange = (e) => { EX.bbox = e.target.checked; };
      $('exStrikes').onchange = (e) => setLayer('strikes', e.target.checked);
      $('exKey') && ($('exKey').onchange = (e) => { EX.key = e.target.checked; });
      d.querySelectorAll('[data-extent]:not([disabled])').forEach((b) => {
        b.onclick = () => { if (busy) return; EX.extent = b.dataset.extent; draw(); };
      });
      d.querySelectorAll('[data-file]').forEach((b) => {
        b.onclick = () => { if (busy) return; EX.file = b.dataset.file; draw(); };
      });
      d.querySelectorAll('[data-size]').forEach((b) => {
        b.onclick = () => { if (busy) return; EX.size = b.dataset.size; draw(); };
      });
      $('exLink').onclick = async () => {
        try { await navigator.clipboard.writeText(location.href); X.toast('Link copied'); }
        catch { X.toast(location.href); }
      };
      $('exEmbed') && ($('exEmbed').onclick = () => { d.classList.add('hidden'); X.openEmbed(); });

      const setBusy = (on) => {
        busy = on;
        const go = $('exGo'), sh = $('exShare');
        if (go) { go.disabled = on; go.textContent = on ? 'Rendering…' : `Download ${EX.file.toUpperCase()}`; }
        if (sh) sh.disabled = on;
      };

      const make = async () => {
        if (EX.file === 'kml') {
          const xml = await buildKml(run, info, EX.extent, EX.bbox);
          return new Blob([xml], { type: 'application/vnd.google-earth.kml+xml' });
        }
        if (O.strikes && O.loadingStrikes) await new Promise((r) => setTimeout(r, 1500));
        const c = await renderExport(EX.size, {
          run, regionInfo: info, extent: EX.extent, key: EX.key, bbox: EX.bbox, graticule: EX.bbox,
        });
        return new Promise((resolve, reject) => c.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG encode failed')), 'image/png'));
      };

      const suffix = EX.file === 'png' ? `-${EX.size}` : '';
      const outName = () => `${fileBase(run, EX.extent, info.entries)}${suffix}.${EX.file}`;

      $('exGo').onclick = async () => {
        if (busy) return;
        setBusy(true);
        X.toast(EX.extent === 'current' ? 'Preparing…' : 'Rendering chart…');
        try {
          const b = await make();
          await download(b, outName());
          X.toast(EX.file === 'kml' ? 'KML saved' : 'Chart saved');
        } catch (err) {
          console.error('[export]', err);
          X.toast('Could not prepare export');
        } finally {
          if (alive()) setBusy(false);
        }
      };

      $('exShare').onclick = async () => {
        if (busy) return;
        setBusy(true);
        try {
          const b = await make();
          const f = new File([b], outName(), { type: b.type });
          if (navigator.canShare?.({ files: [f] })) {
            try { await navigator.share({ files: [f], title: 'HOCO outlook', url: location.href }); return; } catch { return; }
          }
          try { await navigator.clipboard.writeText(location.href); X.toast('Sharing files is not supported here, so the link was copied'); }
          catch { X.toast(location.href); }
        } catch (err) {
          console.error('[export]', err);
          X.toast('Could not share export');
        } finally {
          if (alive()) setBusy(false);
        }
      };
    };

    draw();
  }

  return { openExport, renderExport, findAvailableRegionRuns, buildKml };
}
