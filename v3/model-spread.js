export const SPREAD_BANDS = [
  [1, '#d4d0ff'], [5, '#9d8af3'], [10, '#7256dd'], [20, '#5327a9'], [30, '#310d66']
];

function coordinates(grid, row, col) {
  const [west, , , north] = grid.bounds;
  return [west + col * grid.dx, north - row * grid.dy];
}

export function decodeSpread(geo) {
  const data = geo?.properties?.modelSpread;
  if (data?.v !== 1 || !['models', 'runs'].includes(data.source) ||
      !Array.isArray(data.bounds) || data.bounds.length !== 4 || !data.bounds.every(Number.isFinite) ||
      !Number.isInteger(data.rows) || !Number.isInteger(data.cols) ||
      data.rows < 1 || data.rows > 200 || data.cols < 1 || data.cols > 200 ||
      !Array.isArray(data.members) || data.members.length < 2 || data.members.length > 200) return null;
  const [west, south, east, north] = data.bounds;
  if (west >= east || south >= north || west < -180 || east > 180 || south < -90 || north > 90) return null;
  const members = data.members.map(member => ({
    id: typeof member?.id === 'string' ? member.id : '',
    label: typeof member?.label === 'string' ? member.label.slice(0, 80) : '',
    weight: member?.weight ?? 1
  }));
  if (members.some(m => !Number.isFinite(m.weight) || m.weight <= 0)) return null;
  const total = members.reduce((sum, member) => sum + member.weight, 0);
  if (!Number.isFinite(total)) return null;
  const count = data.rows * data.cols * members.length;
  if (typeof data.values !== 'string' || data.values.length !== 4 * Math.ceil(count / 3)) return null;
  let values;
  try { values = Uint8Array.from(atob(data.values), byte => byte.charCodeAt(0)); }
  catch { return null; }
  if (values.length !== count || values.some(v => v > 100)) return null;
  return { ...data, members, values, total, dx: (east - west) / data.cols, dy: (north - south) / data.rows };
}

function cellStats(grid, row, col) {
  const first = (row * grid.cols + col) * grid.members.length;
  const values = grid.values.subarray(first, first + grid.members.length);
  const mean = grid.members.reduce((sum, m, i) => sum + values[i] * (m.weight / grid.total), 0);
  const variance = grid.members.reduce((sum, m, i) => sum + (values[i] - mean) ** 2 * (m.weight / grid.total), 0);
  return { mean, sigma: Math.sqrt(variance), values };
}

export function spreadAt(grid, lon, lat) {
  const [west, south, east, north] = grid.bounds;
  if (lon < west || lon > east || lat < south || lat > north) return null;
  const col = Math.min(grid.cols - 1, Math.floor((lon - west) / grid.dx));
  const row = Math.min(grid.rows - 1, Math.floor((north - lat) / grid.dy));
  return cellStats(grid, row, col);
}

export function spreadMap(grid) {
  const features = [];
  for (let row = 0; row < grid.rows; row++) {
    let band = -1, start = 0;
    for (let col = 0; col <= grid.cols; col++) {
      const next = col === grid.cols ? -1 :
        SPREAD_BANDS.findLastIndex(([threshold]) => cellStats(grid, row, col).sigma >= threshold);
      if (next === band) continue;
      if (band >= 0) {
        const [west, north] = coordinates(grid, row, start), [east, south] = coordinates(grid, row + 1, col);
        features.push({
          type: 'Feature', properties: { colour: SPREAD_BANDS[band][1] },
          geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] }
        });
      }
      band = next;
      start = col;
    }
  }
  return { type: 'FeatureCollection', features };
}

export function encodeRunSpread(entries, bounds, byteBudget) {
  if (entries.length < 2 || byteBudget < 512) return null;
  const [west, south, east, north] = bounds;
  const members = entries.map(({ id, label, weight }) => ({ id, label, weight }));
  // Leave room for the inline Firestore field and member labels.
  const maxCells = Math.floor((byteBudget - JSON.stringify(members).length - 180) * 0.75 / members.length);
  if (maxCells < 36) return null;
  const cols = Math.max(6, Math.min(48, Math.floor(Math.sqrt(maxCells * 1.25))));
  const rows = Math.min(40, Math.floor(maxCells / cols));
  const grid = { bounds, dx: (east - west) / cols, dy: (north - south) / rows };
  const bytes = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const [lon, lat] = coordinates(grid, y + 0.5, x + 0.5);
      for (const { sample } of entries) bytes.push(String.fromCharCode(Math.round(sample(lon, lat) * 100)));
    }
  }
  return { v: 1, source: 'runs', bounds, cols, rows, members, values: btoa(bytes.join('')) };
}
