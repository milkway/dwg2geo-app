// dwg2geo web app — convert a DWG to GeoJSON in-browser (WASM), reproject to
// WGS 84 with proj4, and render on a MapLibre map. The heavy conversion +
// reprojection runs in a Web Worker (web/worker.js) so the tab never freezes
// and the UI can show honest upload / processing / done states.

// ---- CRS catalog (SIRGAS 2000 / UTM South, the common Brazilian zones, plus
// WGS 84 UTM South). The selected entry's proj4 `def` string is handed to the
// worker, which owns proj4 and does the actual reprojection. ----
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
const busyOverlay = $('busy');
const busyText = $('busytext');

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

// ---- Map — the same CARTO "light_all" raster basemap used by brt-sorocaba ----
if (typeof maplibregl === 'undefined') {
  document.getElementById('status').textContent =
    'Map library failed to load (offline or blocked). Reload to try again.';
  throw new Error('maplibre-gl unavailable');
}
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      base: {
        type: 'raster',
        tileSize: 256,
        attribution:
          '© <a href="https://carto.com/attributions">CARTO</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        tiles: ['a', 'b', 'c', 'd'].map(
          (s) => `https://${s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png`,
        ),
      },
    },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  },
  center: [-47.463, -23.5],
  zoom: 11,
  attributionControl: true,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');
let styleReady = false;
map.on('load', () => { styleReady = true; });
map.on('error', (e) => {
  // Basemap tile/style errors shouldn't break the app — the drawing still renders.
  console.warn('MapLibre error:', e && e.error);
});

const COLORS = { point: '#7c5cff', line: '#17b898', polygon: '#ff8a3d' };

// ---- Conversion worker (owns the WASM module + proj4; keeps the UI free) ----
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let pending = null; // { name } of the in-flight conversion

worker.addEventListener('message', (e) => {
  const job = pending;
  pending = null;
  setBusy(false);
  convertBtn.disabled = false;
  if (!job) return;
  if (!e.data.ok) {
    setStatus(`Conversion failed: ${e.data.error}`, 'err');
    return;
  }
  try {
    renderResult(e.data);
  } catch (error) {
    setStatus(`${error.message || error}`, 'err');
  }
});
worker.addEventListener('error', (e) => {
  pending = null;
  setBusy(false);
  convertBtn.disabled = false;
  setStatus(`Worker error: ${e.message || 'failed to run conversion'}`, 'err');
});

// ---- State ----
let fileBytes = null;
let fileName = '';
let loadSeq = 0; // guards against out-of-order arrayBuffer() reads

function clearFile() {
  fileBytes = null;
  fileName = '';
  drop.classList.remove('loaded');
  fileMeta.classList.add('hidden');
  convertBtn.disabled = true;
}

// ---- File handling ----
function acceptFile(file) {
  if (!file) return;
  const seq = ++loadSeq;
  if (!file.name.toLowerCase().endsWith('.dwg')) {
    clearFile();
    setStatus(`"${file.name}" is not a .dwg file — choose an AutoCAD .dwg.`, 'err');
    return;
  }
  clearFile();
  setStatus('Reading file…', 'busy');
  file.arrayBuffer().then((buf) => {
    if (seq !== loadSeq) return; // a newer selection superseded this read
    fileBytes = new Uint8Array(buf);
    fileName = file.name;
    drop.classList.add('loaded');
    fileMeta.classList.remove('hidden');
    fileMeta.innerHTML =
      `<span class="ok-tick">✓</span> <strong>${escapeHtml(file.name)}</strong>` +
      `<span class="muted"> · ${formatBytes(file.size)} · ready to convert</span>`;
    setStatus('File loaded. Choose the CRS and convert.', 'ok');
    convertBtn.disabled = false;
  }).catch(() => {
    if (seq === loadSeq) setStatus('Could not read that file.', 'err');
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
  if (!fileBytes || pending) return;
  const polygonize = $('polygonize').checked;
  const tol = parseFloat($('tolerance').value);
  const curveTolerance = Number.isFinite(tol) && tol > 0 ? tol : undefined;

  let srcDef;
  try {
    srcDef = resolveSrcDef();
  } catch (error) {
    setStatus(error.message || String(error), 'err');
    return;
  }

  pending = { name: fileName };
  convertBtn.disabled = true;
  setStatus(`Converting ${fileName}…`, 'busy');
  setBusy(true, `Converting ${fileName}…`);
  worker.postMessage({ bytes: fileBytes, polygonize, tolerance: curveTolerance, srcDef });
});

function resolveSrcDef() {
  const code = crsSelect.value;
  if (code === 'EPSG:4326') return null; // already lon/lat — no reprojection
  if (code === 'CUSTOM') {
    const def = customInput.value.trim();
    if (!def) throw new Error('Enter a custom proj4/WKT string, or pick a CRS.');
    return def; // the worker validates the projection before converting
  }
  return CRS.find((c) => c.code === code).def;
}

function renderResult(data) {
  showReport(data.report);
  const n = data.report.feature_count;
  if (!n || !data.bounds) {
    // Successful parse but nothing renderable — keep an honest empty map.
    clearMapLayers();
    legend.classList.add('hidden');
    emptyMap.classList.remove('hidden');
    emptyMap.querySelector('h3').textContent = 'No mappable geometry';
    emptyMap.querySelector('p').textContent = 'The drawing converted, but no supported model-space entities produced coordinates. See the report.';
    setStatus('Converted, but no mappable features were produced.', 'err');
    return;
  }
  whenStyleReady(() => {
    addToMap(data.fc);
    emptyMap.classList.add('hidden');
    // Zoom into the drawing's extent once it is on the map.
    map.fitBounds(data.bounds, { padding: 56, maxZoom: 19, duration: 900 });
  });
  setStatus(`✓ Mapped ${n} feature${n === 1 ? '' : 's'}.`, 'ok');
}

function whenStyleReady(cb) {
  if (styleReady || map.isStyleLoaded()) cb();
  else map.once('load', cb);
}

// ---- Map layers ----
const SRC = 'dwg';
function clearMapLayers() {
  for (const id of ['dwg-fill', 'dwg-line', 'dwg-outline', 'dwg-point']) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
}
function addToMap(fc) {
  clearMapLayers();
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
        .map((k) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(p[k]))}</td></tr>`)
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

// ---- Report ----
function showReport(report) {
  reportCard.classList.remove('hidden');
  const rows = (arr) => arr.map((o) => `<tr><td>${escapeHtml(o.entity_type)}</td><td>${o.count}</td>${o.reason ? `<td class="muted">${escapeHtml(o.reason)}</td>` : ''}</tr>`).join('');
  const converted = report.converted || [];
  const skipped = report.skipped || [];
  const failed = report.failed || [];
  const warnings = report.warnings || [];
  reportEl.innerHTML = `
    <div class="stat-row">
      <div class="stat"><b>${report.feature_count}</b><span>features</span></div>
      <div class="stat"><b>${report.model_space_entities}</b><span>model-space entities</span></div>
      <div class="stat"><b>${skipped.reduce((s, o) => s + o.count, 0)}</b><span>skipped</span></div>
      <div class="stat"><b>${failed.reduce((s, o) => s + o.count, 0)}</b><span>failed</span></div>
    </div>
    <p class="muted small">${report.reprojected ? `Reprojected from ${escapeHtml(crsSelect.value)} to WGS 84.` : 'Coordinates used as WGS 84 lon/lat.'} · SHA-256 <code>${escapeHtml(String(report.source_sha256).slice(0, 12))}…</code></p>
    ${converted.length ? `<h4>Converted</h4><table class="rep">${rows(converted)}</table>` : ''}
    ${skipped.length ? `<h4>Skipped</h4><table class="rep">${rows(skipped)}</table>` : ''}
    ${failed.length ? `<h4>Failed</h4><table class="rep">${rows(failed)}</table>` : ''}
    ${warnings.length ? `<h4>Warnings</h4><ul class="warn">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}`;
}

// ---- Helpers ----
function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind || ''}`;
}
function setBusy(on, text) {
  if (text) busyText.textContent = text;
  busyOverlay.classList.toggle('hidden', !on);
  convertBtn.classList.toggle('loading', on);
}
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
