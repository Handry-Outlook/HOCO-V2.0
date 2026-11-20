const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const SIX_HOURS = DAY / 4;
const FEED = 'https://ukwx.duckdns.org/lightning';
const RAD = Math.PI / 180;
const SAMPLE_KM = 15;
const MAP_CELL_KM = 2.5;
const EVENT_KM = 20;
const EARTH_RADIUS_KM = 6371;
const DISPLAY_LIMIT_KM = EVENT_KM + 4;
const PROXIMITY_BANDS = [
  { max: 5, paletteMin: 90 },
  { max: 10, paletteMin: 50 },
  { max: 15, paletteMin: 30 },
  { max: EVENT_KM, paletteMin: 20 }
];
const BUCKET_DEGREES = 0.5;
const COVERAGE = { west: -17.8, east: 7.8, south: 48.7, north: 63, slope: 0.3491, intercept: 49.3739 };
export const OBSERVATION_DELAY = 15 * MINUTE;

const dayStart = ms => Math.floor((ms - SIX_HOURS) / DAY) * DAY + SIX_HOURS;

export async function loadObservations(start, end, signal, now = Date.now()) {
  const days = [];
  for (let day = dayStart(start); day < end; day += DAY) days.push(day);
  const pages = await Promise.all(days.map(async day => {
    const date = new Date(day).toISOString().slice(0, 10);
    const live = day === dayStart(now);
    const url = live ? FEED + '/europe' : FEED + '/archive/europe/' + date + '.json';
    const response = await fetch(url, { signal, cache: live ? 'no-cache' : 'default' });
    if (!response.ok) throw Error(`Lightning observations are unavailable for ${date}.`);
    const pack = await response.json();
    const from = Math.max(start, day);
    const to = Math.min(end, day + DAY);
    const observedTo = Math.min(Date.parse(pack.fetched_at), to);
    if (Date.parse(pack.period_start) !== day || Date.parse(pack.period_end) !== day + DAY ||
        !Array.isArray(pack.points) || !Number.isFinite(observedTo) ||
        observedTo <= from || to - observedTo > 2 * MINUTE) {
      throw Error('The lightning archive does not cover enough of this forecast window.');
    }
    const points = [];
    for (const point of pack.points) {
      if (!Number.isFinite(point?.t) || !Number.isFinite(point.lon) || !Number.isFinite(point.lat)) {
        throw Error('The lightning archive contains unreadable observations.');
      }
      const time = point.t * 1000;
      if (time >= from && time < observedTo) points.push([point.lon, point.lat, time]);
    }
    return { points, from, to: observedTo };
  }));
  const coverage = pages.reduce((sum, page) => sum + page.to - page.from, 0) / (end - start);
  if (coverage < 0.95) throw Error('The lightning archive does not cover enough of this forecast window.');
  return { points: pages.flatMap(page => page.points), coverage, intervals: pages.map(({ from, to }) => [from, to]) };
}

const coverageEdge = lon => COVERAGE.slope * lon + COVERAGE.intercept;
function withinCoverage(lon, lat) {
  // Match the conservative coverage used by the HOCO verification pipeline.
  return lon >= COVERAGE.west && lon <= COVERAGE.east && lat >= COVERAGE.south &&
    lat <= COVERAGE.north && lat >= coverageEdge(lon);
}

const bucket = value => Math.floor(value / BUCKET_DEGREES);

function spatialIndex(points) {
  const bins = new Map();
  for (const point of points) {
    const key = bucket(point[0]) + ':' + bucket(point[1]);
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push(point);
  }
  return bins;
}

function * neighbours(bins, lon, lat) {
  const x = bucket(lon), y = bucket(lat);
  for (let row = y - 1; row <= y + 1; row++) {
    for (let col = x - 1; col <= x + 1; col++) {
      yield * (bins.get(col + ':' + row) || []);
    }
  }
}

const hav = radians => Math.sin(radians / 2) ** 2;

function distanceKey(lon, lat, point) {
  return hav((point[1] - lat) * RAD) + Math.cos(lat * RAD) * Math.cos(point[1] * RAD) * hav((point[0] - lon) * RAD);
}

function indexObservations(region, observations) {
  const { west, east, south, north } = region;
  const padding = 0.5;
  return spatialIndex(observations.filter(([lon, lat]) =>
    lon >= west - padding && lon <= east + padding && lat >= south - padding && lat <= north + padding
  ));
}

function coveredLocation(region, lon, lat) {
  return lon >= region.west && lon <= region.east && lat >= region.south && lat <= region.north &&
    withinCoverage(lon, lat);
}

function observationLookup(region, observations) {
  const strikes = indexObservations(region, observations);
  const radius = hav(EVENT_KM / EARTH_RADIUS_KM);
  return (lon, lat) => {
    if (!coveredLocation(region, lon, lat)) return null;
    for (const strike of neighbours(strikes, lon, lat)) {
      if (distanceKey(lon, lat, strike) <= radius) return 100;
    }
    return 0;
  };
}

function coveredRing(west, east, south, north) {
  west = Math.max(west, COVERAGE.west);
  north = Math.min(north, COVERAGE.north);
  south = Math.max(south, COVERAGE.south);
  east = Math.min(east, COVERAGE.east, (north - COVERAGE.intercept) / COVERAGE.slope);
  if (east <= west || north <= south) return null;
  const lower = [[west, Math.max(south, coverageEdge(west))]];
  const corner = (south - COVERAGE.intercept) / COVERAGE.slope;
  if (corner > west && corner < east) lower.push([corner, south]);
  return [[west, north], ...lower, [east, Math.max(south, coverageEdge(east))], [east, north], [west, north]];
}

function nearestDistance(strikes, lon, lat) {
  let closest = hav(DISPLAY_LIMIT_KM / EARTH_RADIUS_KM);
  const latitudeScale = Math.cos(lat * RAD);
  for (const [strikeLon, strikeLat] of neighbours(strikes, lon, lat)) {
    const northSouth = hav((strikeLat - lat) * RAD);
    if (northSouth >= closest) continue;
    closest = Math.min(closest, northSouth + latitudeScale * Math.cos(strikeLat * RAD) * hav((strikeLon - lon) * RAD));
  }
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(closest));
}

// Clip an interpolated triangle to a distance contour or the edge of observation coverage.
function clipBand(vertices, inside) {
  const clipped = [];
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[(i + vertices.length - 1) % vertices.length], b = vertices[i];
    const p = inside(a), q = inside(b);
    if ((p < 0 && q > 0) || (p > 0 && q < 0)) {
      const fraction = p / (p - q);
      clipped.push(a.map((value, axis) => value + fraction * (b[axis] - value)));
    }
    if (q >= 0) clipped.push(b);
  }
  return clipped;
}

function addProximityBands(features, region, strikes) {
  const west = Math.max(region.west, COVERAGE.west), east = Math.min(region.east, COVERAGE.east);
  const south = Math.max(region.south, COVERAGE.south), north = Math.min(region.north, COVERAGE.north);
  const step = MAP_CELL_KM / 111.195, lonStep = step / Math.cos((south + north) / 2 * RAD);
  const columns = Math.ceil((east - west) / lonStep), rows = Math.ceil((north - south) / step);
  const sampleRow = row => {
    const lat = Math.min(north, south + row * step);
    return Array.from({ length: columns + 1 }, (_, column) => {
      const lon = Math.min(east, west + column * lonStep);
      return [lon, lat, nearestDistance(strikes, lon, lat)];
    });
  };
  const bandAt = distance => PROXIMITY_BANDS.findIndex(band => distance <= band.max);
  const addRing = (ring, index) => {
    if (!ring || ring.length < 4) return;
    features.push({ type: 'Feature', properties: { feature_type: 'polygon', proximityKm: PROXIMITY_BANDS[index].max },
      geometry: { type: 'Polygon', coordinates: [ring] } });
  };
  let bottom = sampleRow(0);
  for (let row = 0; row < rows; row++) {
    const top = sampleRow(row + 1);
    let span = 0, spanBand = -1;
    const flush = column => {
      if (spanBand >= 0) addRing(coveredRing(bottom[span][0], bottom[column][0], bottom[0][1], top[0][1]), spanBand);
    };
    for (let column = 0; column < columns; column++) {
      const cell = [bottom[column], bottom[column + 1], top[column + 1], top[column]];
      const distances = cell.map(vertex => vertex[2]), low = Math.min(...distances), high = Math.max(...distances);
      const index = bandAt(low), whole = index === bandAt(high);
      const nextBand = whole ? index : -1;
      if (spanBand !== nextBand) {
        flush(column);
        span = column; spanBand = nextBand;
      }
      if (whole || index < 0) continue;
      // Interpolate the band boundary within mixed cells. Adjacent cells share edge samples.
      for (let k = index; k < PROXIMITY_BANDS.length; k++) {
        const min = PROXIMITY_BANDS[k - 1]?.max ?? 0, max = PROXIMITY_BANDS[k].max;
        if (min >= high) break;
        for (const triangle of [[cell[0], cell[1], cell[2]], [cell[0], cell[2], cell[3]]]) {
          let polygon = clipBand(triangle, v => max - v[2]);
          if (k > 0) polygon = clipBand(polygon, v => v[2] - min);
          polygon = clipBand(polygon, ([lon, lat]) => lat - coverageEdge(lon));
          if (polygon.length < 3) continue;
          const ring = polygon.map(([lon, lat]) => [lon, lat]);
          addRing([...ring, ring[0]], k);
        }
      }
    }
    flush(columns);
    bottom = top;
  }
}

export function observedReference(region, observations) {
  const { west, east, south, north } = region;
  const geometry = coveredRing(west, east, south, north);
  if (!geometry) throw Error('No supported lightning observations for this map area.');
  const features = [{
    type: 'Feature', properties: { feature_type: 'coverage' }, geometry: { type: 'Polygon', coordinates: [geometry] }
  }];
  const strikes = indexObservations(region, observations);
  if (strikes.size) addProximityBands(features, region, strikes);
  return {
    bands: PROXIMITY_BANDS,
    distanceAt: (lon, lat) => coveredLocation(region, lon, lat) ? nearestDistance(strikes, lon, lat) : null,
    geo: { type: 'FeatureCollection', features }
  };
}

function insideRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x, y] = ring[i], [previousX, previousY] = ring[j];
    if ((y > lat) !== (previousY > lat) && lon < x + (previousX - x) * (lat - y) / (previousY - y)) {
      inside = !inside;
    }
  }
  return inside;
}

function forecastIndex(geo) {
  const polygons = [], points = [];
  for (const { geometry, properties } of geo.features) {
    const risk = +(properties?.risk ?? properties?.risk_pct ?? properties?.prob ?? properties?.probability ??
      properties?.percent ?? properties?.percentage);
    if (!Number.isFinite(risk) || risk < 0 || risk > 100 || !geometry) continue;
    if (geometry.type === 'Point') {
      const [lon, lat] = geometry.coordinates;
      if (Number.isFinite(lon) && Number.isFinite(lat)) points.push([lon, lat, risk / 100]);
    }
    const shapes = geometry.type === 'Polygon' ? [geometry.coordinates] :
      geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    for (const rings of shapes) {
      if (!rings[0]?.length) continue;
      let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
      for (const [lon, lat] of rings[0]) {
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }
      const upper = properties.band_max;
      const probability = Number.isFinite(upper) && upper >= risk && upper <= 100 ? (risk + upper) / 200 : risk / 100;
      polygons.push({ rings, west, east, south, north, probability });
    }
  }
  if (!polygons.length && !points.length && (geo.features.length || geo.properties?.hoco_layout !== 'bands_v2')) {
    throw Error('This saved map does not contain verifiable lightning probabilities.');
  }
  polygons.sort((a, b) => b.probability - a.probability);
  return { polygons, points: spatialIndex(points) };
}

function probabilityAt(index, lon, lat) {
  let closest = hav(8 / 6371), value;
  for (const point of neighbours(index.points, lon, lat)) {
    const distance = distanceKey(lon, lat, point);
    if (distance < closest) {
      closest = distance;
      value = point[2];
    }
  }
  if (value !== undefined) return value;
  for (const { west, east, south, north, rings, probability } of index.polygons) {
    if (lon >= west && lon <= east && lat >= south && lat <= north &&
        insideRing(lon, lat, rings[0]) && !rings.slice(1).some(hole => insideRing(lon, lat, hole))) {
      return probability;
    }
  }
  return 0.025; // Midpoint of the published map's uncoloured under-5% band.
}

export function verifyMap(geo, region, observations) {
  const forecast = forecastIndex(geo);
  const { west, east, south, north } = region;
  const observedRiskAt = observationLookup(region, observations);
  const step = SAMPLE_KM / 111.195;
  const bins = Array.from({ length: 10 }, () => ({ forecast: 0, observed: 0, count: 0 }));
  let cells = 0, hits = 0, expected = 0, loss = 0;
  for (let lat = south + step / 2; lat < north; lat += step) {
    const lonStep = step / Math.cos(lat * RAD);
    for (let lon = west + lonStep / 2; lon < east; lon += lonStep) {
      const risk = observedRiskAt(lon, lat);
      if (risk === null) continue;
      const probability = probabilityAt(forecast, lon, lat);
      const observed = risk / 100;
      const bin = bins[Math.min(9, Math.floor(probability * 10))];
      bin.forecast += probability;
      bin.observed += observed;
      bin.count++;
      cells++;
      hits += observed;
      expected += probability;
      loss += (probability - observed) ** 2;
    }
  }
  if (!cells) throw Error('This map falls outside HOCO’s supported lightning verification area.');
  return {
    cells,
    forecast: expected / cells,
    observed: hits / cells,
    brier: loss / cells,
    bins: bins.map(bin => ({
      forecast: bin.count ? bin.forecast / bin.count : null,
      observed: bin.count ? bin.observed / bin.count : null,
      count: bin.count
    }))
  };
}

export function combinedVerification(scores) {
  const cells = scores.reduce((sum, score) => sum + score.cells, 0);
  const average = key => scores.reduce((sum, score) => sum + score[key] * score.cells, 0) / cells;
  const bins = scores[0].bins.map((_, i) => {
    const rows = scores.map(score => score.bins[i]).filter(bin => bin.count);
    const count = rows.reduce((sum, bin) => sum + bin.count, 0);
    const mean = key => count ? rows.reduce((sum, bin) => sum + bin[key] * bin.count, 0) / count : null;
    return { count, forecast: mean('forecast'), observed: mean('observed') };
  });
  return { cells, forecast: average('forecast'), observed: average('observed'), brier: average('brier'), bins };
}
