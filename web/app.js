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
const emptyMap = $('emptymap');
const busyOverlay = $('busy');
const busyText = $('busytext');
const layersMenu = $('layersmenu');
const layersBtn = $('layersbtn');
const layersCard = $('layerscard');
const layerList = $('layerlist');
const layerCount = $('layercount');
const labelsToggle = $('labels');
const layerAll = $('layall');
const layerNone = $('laynone');
const basemapCtl = $('basemapctl');
const downloadBtn = $('download');

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
    glyphs: 'https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf',
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
      // Satellite imagery — the same Esri World Imagery source brt-sorocaba uses.
      sat: {
        type: 'raster',
        tileSize: 256,
        attribution: 'Esri, Maxar',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        ],
      },
    },
    // Both basemaps live in the style; switching toggles visibility so the
    // DWG source/layers survive the change (map.setStyle would drop them).
    layers: [
      { id: 'base', type: 'raster', source: 'base' },
      { id: 'sat', type: 'raster', source: 'sat', layout: { visibility: 'none' } },
    ],
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

// ---- Conversion worker (owns the WASM module + proj4; keeps the UI free) ----
let worker = null;
let pending = null; // { name, crs } snapshot of the in-flight conversion

function onWorkerMessage(e) {
  const job = pending;
  pending = null;
  setBusy(false);
  convertBtn.disabled = !fileBytes;
  if (!job) return;
  if (!e.data.ok) {
    setStatus(`Conversion failed: ${e.data.error}`, 'err');
    return;
  }
  try {
    renderResult(e.data, job);
  } catch (error) {
    setStatus(`${error.message || error}`, 'err');
  }
}
function onWorkerError(e) {
  // A load/runtime failure leaves the worker unusable — replace it so the
  // next Convert click gets a fresh one instead of posting into a dead worker.
  pending = null;
  setBusy(false);
  convertBtn.disabled = !fileBytes;
  setStatus(`Converter error: ${e.message || 'failed to run conversion'} — restarted, try again.`, 'err');
  try { worker.terminate(); } catch { /* already dead */ }
  spawnWorker();
}
function spawnWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', onWorkerMessage);
  worker.addEventListener('error', onWorkerError);
}
spawnWorker();

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

  // Snapshot the attribution now: the user may change the file or CRS
  // selector while the worker runs, and the result must be labeled with
  // what was actually converted.
  pending = { name: fileName, crs: crsSelect.value };
  // A stale download from the previous drawing must not survive into a run
  // that might fail — it would silently offer the wrong file.
  lastResult = null;
  downloadBtn.classList.add('hidden');
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

// Last successful conversion, kept for the GeoJSON download.
let lastResult = null;

function renderResult(data, job) {
  showReport(data.report, job);
  const n = data.report.feature_count;
  if (!n || !data.bounds) {
    // Successful parse but nothing renderable — keep an honest empty map.
    clearMapLayers();
    layersMenu.classList.add('hidden');
    downloadBtn.classList.add('hidden');
    lastResult = null;
    emptyMap.classList.remove('hidden');
    emptyMap.querySelector('h3').textContent = 'No mappable geometry';
    emptyMap.querySelector('p').textContent = 'The drawing converted, but no supported model-space entities produced coordinates. See the report.';
    setStatus('Converted, but no mappable features were produced.', 'err');
    return;
  }
  whenStyleReady(() => {
    addToMap(data.fc);
    buildLayerPanel(data.fc);
    emptyMap.classList.add('hidden');
    // Zoom into the drawing's extent once it is on the map.
    map.fitBounds(data.bounds, { padding: 56, maxZoom: 19, duration: 900 });
  });
  lastResult = { fc: data.fc, name: job.name };
  downloadBtn.classList.remove('hidden');
  setStatus(`✓ Mapped ${n} feature${n === 1 ? '' : 's'} from ${job.name}.`, 'ok');
}

// ---- Download the reprojected (WGS 84) GeoJSON ----
downloadBtn.addEventListener('click', () => {
  if (!lastResult) return;
  const blob = new Blob([JSON.stringify(lastResult.fc)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${lastResult.name.replace(/\.dwg$/i, '')}.geojson`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

function whenStyleReady(cb) {
  if (styleReady || map.isStyleLoaded()) cb();
  else map.once('load', cb);
}

// ---- Map layers ----
// Every feature carries the CAD `color_rgb` and (often) `lineweight_mm`, so the
// map mirrors the drawing's own colours and line widths instead of flat styles.
const SRC = 'dwg';
const RENDER_LAYERS = ['dwg-fill', 'dwg-outline', 'dwg-line-casing', 'dwg-line', 'dwg-point', 'dwg-text'];
const cadColor = (fallback) => ['coalesce', ['get', 'color_rgb'], fallback];
// Plot line weight is in mm; scale to a legible pixel width with a floor.
const cadLineWidth = ['max', 0.8, ['*', ['coalesce', ['get', 'lineweight_mm'], 0.13], 10]];
const GEOM = {
  fill: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
  line: ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
  point: ['all', ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false], ['!', ['has', 'text']]],
  text: ['all', ['==', ['geometry-type'], 'Point'], ['has', 'text']],
};

// Per-DWG-layer visibility state.
const hiddenLayers = new Set();
let showLabels = true;

function clearMapLayers() {
  for (const id of RENDER_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
}

function addToMap(fc) {
  clearMapLayers();
  if (map.getSource(SRC)) map.getSource(SRC).setData(fc);
  else map.addSource(SRC, { type: 'geojson', data: fc });

  map.addLayer({ id: 'dwg-fill', type: 'fill', source: SRC,
    paint: { 'fill-color': cadColor('#ff8a3d'), 'fill-opacity': 0.18 } });
  map.addLayer({ id: 'dwg-outline', type: 'line', source: SRC,
    paint: { 'line-color': cadColor('#ff8a3d'), 'line-width': cadLineWidth } });
  // A faint dark casing keeps light/white CAD colours visible on the basemap.
  map.addLayer({ id: 'dwg-line-casing', type: 'line', source: SRC,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': 'rgba(20,28,48,0.35)', 'line-width': ['+', cadLineWidth, 1.4] } });
  map.addLayer({ id: 'dwg-line', type: 'line', source: SRC,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': cadColor('#17b898'), 'line-width': cadLineWidth } });
  map.addLayer({ id: 'dwg-point', type: 'circle', source: SRC,
    paint: { 'circle-color': cadColor('#7c5cff'), 'circle-radius': 3.5,
      'circle-stroke-width': 1, 'circle-stroke-color': 'rgba(255,255,255,0.85)' } });
  // Text/MTEXT features become real labels, rotated to match the drawing.
  map.addLayer({ id: 'dwg-text', type: 'symbol', source: SRC,
    layout: {
      'text-field': ['coalesce', ['get', 'text'], ''],
      'text-size': 12,
      'text-font': ['Open Sans Regular'],
      'text-rotation-alignment': 'map',
      'text-rotate': ['-', 0, ['coalesce', ['get', 'text_rotation_deg'], 0]],
      'text-allow-overlap': false,
      'text-max-width': 20,
    },
    paint: {
      'text-color': cadColor('#10306a'),
      'text-halo-color': 'rgba(255,255,255,0.92)',
      'text-halo-width': 1.4,
    } });

  applyLayerFilters();
  bindPopup();
}

// Mirrors buildLayerPanel's bucketing exactly: missing, null, and empty layer
// names all collapse to "(no layer)" so that toggle works for them too.
const LAYER_KEY = ['case',
  ['any', ['!', ['has', 'layer']], ['==', ['coalesce', ['get', 'layer'], ''], '']],
  '(no layer)',
  ['get', 'layer']];
function layerVisibleExpr() {
  return ['!', ['in', LAYER_KEY, ['literal', [...hiddenLayers]]]];
}
function applyLayerFilters() {
  const vis = layerVisibleExpr();
  const set = (id, geom) => { if (map.getLayer(id)) map.setFilter(id, ['all', geom, vis]); };
  set('dwg-fill', GEOM.fill);
  set('dwg-outline', GEOM.fill);
  set('dwg-line-casing', GEOM.line);
  set('dwg-line', GEOM.line);
  set('dwg-point', GEOM.point);
  set('dwg-text', GEOM.text);
  if (map.getLayer('dwg-text')) {
    map.setLayoutProperty('dwg-text', 'visibility', showLabels ? 'visible' : 'none');
  }
}

// ---- Per-layer panel (toggle DWG layers, mirror their colours) ----
function buildLayerPanel(fc) {
  hiddenLayers.clear();
  showLabels = true;
  const stat = new Map(); // layer -> { count, colors: Map<hex,count>, hasText }
  for (const f of fc.features) {
    const p = f.properties || {};
    const name = p.layer || '(no layer)';
    let s = stat.get(name);
    if (!s) { s = { count: 0, colors: new Map(), hasText: false }; stat.set(name, s); }
    s.count += 1;
    if (p.color_rgb) s.colors.set(p.color_rgb, (s.colors.get(p.color_rgb) || 0) + 1);
    if (p.text) s.hasText = true;
  }
  const layers = [...stat.entries()].sort((a, b) => b[1].count - a[1].count);
  const swatch = (colors) => {
    let best = '#888', n = -1;
    for (const [hex, c] of colors) if (c > n) { best = hex; n = c; }
    return best;
  };
  layerList.innerHTML = layers.map(([name, s]) => `
    <label class="layer-row">
      <input type="checkbox" data-layer="${escapeHtml(name)}" checked />
      <span class="layer-sw" style="background:${escapeHtml(swatch(s.colors))}"></span>
      <span class="layer-name" title="${escapeHtml(name)}">${escapeHtml(name)}${s.hasText ? ' 🅣' : ''}</span>
      <span class="layer-count">${s.count}</span>
    </label>`).join('');
  layerCount.textContent = `(${layers.length})`;
  labelsToggle.checked = true;
  layersMenu.classList.remove('hidden');
  setLayersOpen(true);

  layerList.querySelectorAll('input[data-layer]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) hiddenLayers.delete(cb.dataset.layer);
      else hiddenLayers.add(cb.dataset.layer);
      applyLayerFilters();
    });
  });
  // Re-apply now that hiddenLayers/showLabels were reset — addToMap ran with
  // the previous drawing's state.
  applyLayerFilters();
}
function setAllLayers(visible) {
  layerList.querySelectorAll('input[data-layer]').forEach((cb) => { cb.checked = visible; });
  hiddenLayers.clear();
  if (!visible) layerList.querySelectorAll('input[data-layer]').forEach((cb) => hiddenLayers.add(cb.dataset.layer));
  applyLayerFilters();
}
layerAll.addEventListener('click', () => setAllLayers(true));
layerNone.addEventListener('click', () => setAllLayers(false));
labelsToggle.addEventListener('change', () => { showLabels = labelsToggle.checked; applyLayerFilters(); });

// Collapse/expand the floating layers menu.
function setLayersOpen(open) {
  layersCard.classList.toggle('hidden', !open);
  layersBtn.setAttribute('aria-expanded', String(open));
}
layersBtn.addEventListener('click', () => {
  setLayersOpen(layersCard.classList.contains('hidden'));
});

// ---- Basemap switch (Streets ⇄ Satellite, mirroring brt-sorocaba) ----
basemapCtl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-base]');
  if (!btn) return;
  const sat = btn.dataset.base === 'sat';
  whenStyleReady(() => {
    map.setLayoutProperty('base', 'visibility', sat ? 'none' : 'visible');
    map.setLayoutProperty('sat', 'visibility', sat ? 'visible' : 'none');
  });
  for (const b of basemapCtl.querySelectorAll('button')) {
    b.classList.toggle('active', b === btn);
  }
});

let popupBound = false;
function bindPopup() {
  if (popupBound) return;
  popupBound = true;
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: true });
  for (const id of ['dwg-fill', 'dwg-line', 'dwg-point', 'dwg-text']) {
    map.on('click', id, (e) => {
      const p = e.features[0].properties || {};
      const rows = ['entity_type', 'layer', 'handle', 'text', 'block_name', 'color_index', 'color_rgb', 'lineweight_mm', 'linetype']
        .filter((k) => p[k] !== undefined && p[k] !== '')
        .map((k) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(p[k]))}</td></tr>`)
        .join('');
      popup.setLngLat(e.lngLat).setHTML(`<table class="pop">${rows}</table>`).addTo(map);
    });
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
}

// ---- Report ----
function showReport(report, job) {
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
    <p class="muted small"><strong>${escapeHtml(job.name)}</strong> · ${report.reprojected ? `Reprojected from ${escapeHtml(job.crs)} to WGS 84.` : 'Coordinates used as WGS 84 lon/lat.'} · SHA-256 <code>${escapeHtml(String(report.source_sha256).slice(0, 12))}…</code></p>
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
