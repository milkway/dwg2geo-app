// dwg2geo web app — convert a DWG to GeoJSON in-browser (WASM), reproject to
// WGS 84 with proj4, and render on a MapLibre map.

import init, { convert } from './pkg/dwg2geo_app.js';

// ---- CRS catalog (SIRGAS 2000 / UTM South, the common Brazilian zones, plus
// WGS 84 UTM South). proj4 knows EPSG:4326; the rest are registered here. ----
const CRS = [
  { code: 'EPSG:31978', label: 'SIRGAS 2000 / UTM 18S', def: '+proj=utm +zone=18 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
  { code: 'EPSG:31979', label: 'SIRGAS 2000 / UTM 19S', def: '+proj=utm +zone=19 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
  { code: 'EPSG:31980', label: 'SIRGAS 2000 / UTM 20S', def: '+proj=utm +zone=20 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
  { code: 'EPSG:31981', label: 'SIRGAS 2000 / UTM 21S', def: '+proj=utm +zone=21 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
  { code: 'EPSG:31982', label: 'SIRGAS 2000 / UTM 22S', def: '+proj=utm +zone=22 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
  { code: 'EPSG:31983', label: 'SIRGAS 2000 / UTM 23S', def: '+proj=utm +zone=23 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
  { code: 'EPSG:31984', label: 'SIRGAS 2000 / UTM 24S', def: '+proj=utm +zone=24 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
  { code: 'EPSG:31985', label: 'SIRGAS 2000 / UTM 25S', def: '+proj=utm +zone=25 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
  { code: 'EPSG:32722', label: 'WGS 84 / UTM 22S', def: '+proj=utm +zone=22 +south +datum=WGS84 +units=m +no_defs' },
  { code: 'EPSG:32723', label: 'WGS 84 / UTM 23S', def: '+proj=utm +zone=23 +south +datum=WGS84 +units=m +no_defs' },
  { code: 'EPSG:4326', label: 'WGS 84 (lon/lat — already geographic)', def: '+proj=longlat +datum=WGS84 +no_defs' },
  { code: 'CUSTOM', label: 'Custom proj4 / WKT…', def: null },
];
for (const c of CRS) if (c.def) proj4.defs(c.code, c.def);

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const fileInput = $('file');
const drop = $('drop');
const fileMeta = $('filemeta');
const crsSelect = $('crs');
const customWrap = $('customwrap');
const customInput = $('custom');
const convertBtn = $('convert');
const statusEl = $('status');
const reportCard = $('reportcard');
const reportEl = $('report');
const legend = $('legend');
const emptyMap = $('emptymap');

for (const c of CRS) {
  const opt = document.createElement('option');
  opt.value = c.code;
  opt.textContent = `${c.label}${c.code.startsWith('EPSG') ? ` (${c.code})` : ''}`;
  crsSelect.appendChild(opt);
}
crsSelect.value = 'EPSG:31983';
crsSelect.addEventListener('change', () => {
  customWrap.classList.toggle('hidden', crsSelect.value !== 'CUSTOM');
});

// ---- Map (theme-aware Carto basemap, free & keyless) ----
const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const basemap = dark
  ? 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
  : 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const map = new maplibregl.Map({
  container: 'map',
  style: basemap,
  center: [-47.45, -23.5],
  zoom: 4,
  attributionControl: true,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');

const COLORS = { point: '#7c5cff', line: '#17b898', polygon: '#ff8a3d' };

// ---- State ----
let wasmReady = false;
let fileBytes = null;

init().then(() => { wasmReady = true; maybeEnable(); });

function maybeEnable() {
  convertBtn.disabled = !(wasmReady && fileBytes);
}

// ---- File handling ----
function acceptFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.dwg')) {
    setStatus(`"${file.name}" is not a .dwg file.`, 'err');
    return;
  }
  file.arrayBuffer().then((buf) => {
    fileBytes = new Uint8Array(buf);
    fileMeta.classList.remove('hidden');
    fileMeta.innerHTML = `<strong>${escapeHtml(file.name)}</strong> · ${formatBytes(file.size)}`;
    setStatus('', '');
    maybeEnable();
  });
}
fileInput.addEventListener('change', () => acceptFile(fileInput.files[0]));
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  acceptFile(e.dataTransfer.files[0]);
});

// ---- Convert ----
convertBtn.addEventListener('click', () => {
  if (!wasmReady || !fileBytes) return;
  const polygonize = $('polygonize').checked;
  const tol = parseFloat($('tolerance').value);
  const curveTolerance = Number.isFinite(tol) && tol > 0 ? tol : undefined;

  setStatus('Converting…', 'busy');
  convertBtn.disabled = true;

  // Defer so the busy status paints before the (synchronous) wasm call.
  setTimeout(() => {
    let result;
    try {
      result = convert(fileBytes, polygonize, curveTolerance);
    } catch (error) {
      setStatus(`Conversion failed: ${error}`, 'err');
      convertBtn.disabled = false;
      return;
    }
    try {
      renderResult(result);
    } catch (error) {
      setStatus(`${error.message || error}`, 'err');
    } finally {
      convertBtn.disabled = false;
    }
  }, 30);
});

function renderResult(result) {
  const geojson = JSON.parse(result.geojson);
  const proj = resolveProjection();
  const reprojected = reproject(geojson, proj);

  addToMap(reprojected);
  const bounds = boundsOf(reprojected);
  if (bounds) {
    emptyMap.classList.add('hidden');
    map.fitBounds(bounds, { padding: 48, maxZoom: 18, duration: 800 });
  }
  showReport(result, proj);
  setStatus(`Mapped ${result.feature_count} feature${result.feature_count === 1 ? '' : 's'}.`, 'ok');
}

function resolveProjection() {
  const code = crsSelect.value;
  if (code === 'EPSG:4326') return null; // already lon/lat
  if (code === 'CUSTOM') {
    const def = customInput.value.trim();
    if (!def) throw new Error('Enter a custom proj4/WKT string, or pick a CRS.');
    proj4.defs('CUSTOM', def);
    return proj4('CUSTOM', 'EPSG:4326');
  }
  return proj4(code, 'EPSG:4326');
}

// ---- Reprojection (deep-copies geometry, transforming every position) ----
function reproject(geojson, proj) {
  const fwd = proj ? (xy) => proj.forward(xy) : (xy) => xy;
  const mapPos = (p) => {
    const [x, y] = fwd([p[0], p[1]]);
    return [x, y];
  };
  const mapCoords = (c) => {
    if (typeof c[0] === 'number') return mapPos(c);
    return c.map(mapCoords);
  };
  return {
    type: 'FeatureCollection',
    features: geojson.features.map((f) => ({
      type: 'Feature',
      properties: f.properties || {},
      geometry: f.geometry ? { type: f.geometry.type, coordinates: mapCoords(f.geometry.coordinates) } : null,
    })),
  };
}

// ---- Map layers ----
const SRC = 'dwg';
function addToMap(fc) {
  for (const id of ['dwg-fill', 'dwg-line', 'dwg-outline', 'dwg-point']) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(SRC)) map.getSource(SRC).setData(fc);
  else map.addSource(SRC, { type: 'geojson', data: fc });

  map.addLayer({ id: 'dwg-fill', type: 'fill', source: SRC,
    filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
    paint: { 'fill-color': COLORS.polygon, 'fill-opacity': 0.22 } });
  map.addLayer({ id: 'dwg-outline', type: 'line', source: SRC,
    filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
    paint: { 'line-color': COLORS.polygon, 'line-width': 1.4 } });
  map.addLayer({ id: 'dwg-line', type: 'line', source: SRC,
    filter: ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
    paint: { 'line-color': COLORS.line, 'line-width': 1.8 } });
  map.addLayer({ id: 'dwg-point', type: 'circle', source: SRC,
    filter: ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
    paint: { 'circle-color': COLORS.point, 'circle-radius': 4, 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' } });

  bindPopup();
  showLegend();
}

let popupBound = false;
function bindPopup() {
  if (popupBound) return;
  popupBound = true;
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: true });
  for (const id of ['dwg-fill', 'dwg-line', 'dwg-point']) {
    map.on('click', id, (e) => {
      const p = e.features[0].properties || {};
      const rows = ['entity_type', 'layer', 'handle', 'text', 'block_name', 'color_index', 'linetype']
        .filter((k) => p[k] !== undefined && p[k] !== '')
        .map((k) => `<tr><td>${k}</td><td>${escapeHtml(String(p[k]))}</td></tr>`)
        .join('');
      popup.setLngLat(e.lngLat).setHTML(`<table class="pop">${rows}</table>`).addTo(map);
    });
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
}

function showLegend() {
  legend.classList.remove('hidden');
  legend.innerHTML = `
    <div><span class="sw" style="background:${COLORS.point}"></span>Points</div>
    <div><span class="sw" style="background:${COLORS.line}"></span>Lines</div>
    <div><span class="sw" style="background:${COLORS.polygon}"></span>Polygons</div>`;
}

function boundsOf(fc) {
  let b = null;
  const ext = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!b) b = [x, y, x, y];
    else { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
  };
  const walk = (c) => { if (typeof c[0] === 'number') ext(c[0], c[1]); else c.forEach(walk); };
  for (const f of fc.features) if (f.geometry) walk(f.geometry.coordinates);
  return b ? [[b[0], b[1]], [b[2], b[3]]] : null;
}

// ---- Report ----
function showReport(result, proj) {
  reportCard.classList.remove('hidden');
  const rows = (arr) => arr.map((o) => `<tr><td>${escapeHtml(o.entity_type)}</td><td>${o.count}</td>${o.reason ? `<td class="muted">${escapeHtml(o.reason)}</td>` : ''}</tr>`).join('');
  const skipped = result.skipped || [];
  const failed = result.failed || [];
  const warnings = result.warnings || [];
  reportEl.innerHTML = `
    <div class="stat-row">
      <div class="stat"><b>${result.feature_count}</b><span>features</span></div>
      <div class="stat"><b>${result.model_space_entities}</b><span>model-space entities</span></div>
      <div class="stat"><b>${skipped.reduce((s, o) => s + o.count, 0)}</b><span>skipped</span></div>
      <div class="stat"><b>${failed.reduce((s, o) => s + o.count, 0)}</b><span>failed</span></div>
    </div>
    <p class="muted small">${proj ? `Reprojected from ${escapeHtml(crsSelect.value)} to WGS 84.` : 'Coordinates used as WGS 84 lon/lat.'} · SHA-256 <code>${result.source_sha256.slice(0, 12)}…</code></p>
    ${result.converted?.length ? `<h4>Converted</h4><table class="rep">${rows(result.converted)}</table>` : ''}
    ${skipped.length ? `<h4>Skipped</h4><table class="rep">${rows(skipped)}</table>` : ''}
    ${failed.length ? `<h4>Failed</h4><table class="rep">${rows(failed)}</table>` : ''}
    ${warnings.length ? `<h4>Warnings</h4><ul class="warn">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}`;
}

// ---- Helpers ----
function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind || ''}`;
}
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
