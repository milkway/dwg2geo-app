// dwg2geo web app — convert a DWG to GeoJSON in-browser (WASM), reproject to
// WGS 84 with proj4, and render on a MapLibre map. The heavy conversion +
// reprojection runs in a Web Worker (web/worker.js) so the tab never freezes
// and the UI can show honest upload / processing / done states.

// ---- CRS catalog. UTM families that cover Brazil (SIRGAS 2000 is the
// official datum; SAD69 and Córrego Alegre still appear on older sheets;
// WGS 84 on GPS-derived work), zones 18–25 S and 18–22 N, plus the CRS of
// the bundled CCSF examples. Entries are generated from the family's proj4
// template and EPSG numbering so the catalog and the automatic detection
// (see detectCrs) share one source of truth. ----
const UTM_FAMILIES = [
  { key: 'sirgas2000', name: 'SIRGAS 2000', proj: '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
    south: { zones: range(18, 25), epsg: (z) => 31960 + z }, north: { zones: range(18, 22), epsg: (z) => 31954 + z } },
  { key: 'wgs84', name: 'WGS 84', proj: '+datum=WGS84 +units=m +no_defs',
    south: { zones: range(18, 25), epsg: (z) => 32700 + z }, north: { zones: range(18, 22), epsg: (z) => 32600 + z } },
  { key: 'sad69', name: 'SAD69', proj: '+ellps=aust_SA +towgs84=-57,1,-41,0,0,0,0 +units=m +no_defs',
    south: { zones: range(18, 25), epsg: (z) => 29170 + z }, north: { zones: range(18, 22), epsg: (z) => 29150 + z } },
  { key: 'corrego', name: 'Córrego Alegre 1970-72', proj: '+ellps=intl +towgs84=-206,172,-6,0,0,0,0 +units=m +no_defs',
    south: { zones: range(21, 25), epsg: (z) => 22500 + z }, north: { zones: [], epsg: () => null } },
];
function range(a, b) { return Array.from({ length: b - a + 1 }, (_, i) => a + i); }
function utmEntries(family) {
  const out = [];
  for (const [hemi, south] of [['south', true], ['north', false]]) {
    for (const zone of family[hemi].zones) {
      out.push({
        code: `EPSG:${family[hemi].epsg(zone)}`,
        label: `${family.name} / UTM ${zone}${south ? 'S' : 'N'}`,
        group: family.name,
        family: family.key, zone, south,
        def: `+proj=utm +zone=${zone}${south ? ' +south' : ''} ${family.proj}`,
      });
    }
  }
  return out;
}
const CRS = [
  ...UTM_FAMILIES.flatMap(utmEntries),
  // The CRS of the CCSF Digital Basemap sheets bundled as examples (declared
  // by San Francisco Public Works in the dataset metadata, not by the DWGs).
  { code: 'EPSG:2227', group: 'Other', label: 'NAD83 / California zone 3 (ftUS)', def: '+proj=lcc +lat_1=38.43333333333333 +lat_2=37.06666666666667 +lat_0=36.5 +lon_0=-120.5 +x_0=2000000.0001016 +y_0=500000.0001016002 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs' },
  { code: 'EPSG:4326', group: 'Other', label: 'WGS 84 (lon/lat — already geographic)', def: '+proj=longlat +datum=WGS84 +no_defs' },
  { code: 'CUSTOM', group: 'Other', label: 'Custom proj4 / WKT…', def: null },
];
function findUtm(family, zone, south) {
  return CRS.find((c) => c.family === family && c.zone === zone && c.south === south) || null;
}

// ---- Bundled example drawings (fetched by build.sh, SHA-pinned). Loading one
// prefills the CRS that the SOURCE declares — the drawing itself carries none,
// which is exactly the failure mode dwg2geo exists to make explicit. ----
const EXAMPLES = [
  { file: 'sf00c.dwg', label: 'San Francisco basemap — sheet sf00c', crs: 'EPSG:2227' },
  { file: 'sf01c.dwg', label: 'San Francisco basemap — sheet sf01c', crs: 'EPSG:2227' },
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
const crsHint = $('crshint');
const exampleList = $('examplelist');

{
  const groups = new Map();
  for (const c of CRS) {
    if (!groups.has(c.group)) {
      const g = document.createElement('optgroup');
      g.label = c.group;
      groups.set(c.group, g);
      crsSelect.appendChild(g);
    }
    const opt = document.createElement('option');
    opt.value = c.code;
    opt.textContent = `${c.label}${c.code.startsWith('EPSG') ? ` (${c.code})` : ''}`;
    groups.get(c.group).appendChild(opt);
  }
}
crsSelect.value = 'EPSG:31983';
crsSelect.addEventListener('change', () => {
  customWrap.classList.toggle('hidden', crsSelect.value !== 'CUSTOM');
});

// ---- Map. Streets basemap: OpenFreeMap "positron" (free vector tiles,
// no API key, no usage cap — CARTO's raster basemaps started stamping
// "API KEY REQUIRED" on every tile in 2026). Its style is fetched at start
// and merged with the Esri World Imagery raster source, so both basemaps
// live in ONE style and switching only toggles visibility (map.setStyle
// would drop the DWG source and layers). ----
if (typeof maplibregl === 'undefined') {
  document.getElementById('status').textContent =
    'Map library failed to load (offline or blocked). Reload to try again.';
  throw new Error('maplibre-gl unavailable');
}
const STREETS_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const GLYPHS_URL = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const LABEL_FONT = ['Noto Sans Regular']; // served by GLYPHS_URL
const SAT_SOURCE = {
  type: 'raster',
  tileSize: 256,
  attribution: 'Esri, Maxar',
  tiles: [
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  ],
};
let streetLayerIds = []; // basemap layers toggled by the Streets/Satellite switch
let map = null;
let styleReady = false;

async function fetchStreetsStyle() {
  try {
    const res = await fetch(STREETS_STYLE_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const style = await res.json();
    if (style.version !== 8 || !Array.isArray(style.layers)) throw new Error('not a style');
    return style;
  } catch (error) {
    console.warn('Streets basemap style unavailable:', error);
    return null;
  }
}

const mapReady = fetchStreetsStyle().then((streets) => {
  const style = streets
    ? { ...streets, sources: { ...streets.sources, sat: SAT_SOURCE }, layers: [...streets.layers] }
    : { version: 8, glyphs: GLYPHS_URL, sources: { sat: SAT_SOURCE }, layers: [] };
  style.layers.push({ id: 'sat', type: 'raster', source: 'sat', layout: { visibility: streets ? 'none' : 'visible' } });
  streetLayerIds = streets
    ? streets.layers.filter((l) => !(l.layout && l.layout.visibility === 'none')).map((l) => l.id)
    : [];
  if (!streets) {
    // Honest fallback: satellite only, and say why the Streets button is off.
    const streetsBtn = basemapCtl.querySelector('button[data-base="streets"]');
    streetsBtn.disabled = true;
    streetsBtn.title = 'Streets basemap unavailable (offline or blocked) — satellite imagery only.';
    setActiveBasemap(basemapCtl.querySelector('button[data-base="sat"]'));
  }
  map = new maplibregl.Map({
    container: 'map',
    style,
    center: [-47.463, -23.5],
    zoom: 11,
    attributionControl: true,
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  map.on('load', () => { styleReady = true; });
  map.on('error', (e) => {
    // Basemap tile/style errors shouldn't break the app — the drawing still renders.
    console.warn('MapLibre error:', e && e.error);
  });
  return map;
});

// ---- Conversion worker (owns the WASM module + proj4; keeps the UI free) ----
let worker = null;
let pending = null; // { name, crs } snapshot of the in-flight conversion

function onWorkerMessage(e) {
  if (e.data && e.data.probe !== undefined) {
    onProbeResult(e.data);
    return;
  }
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
let probeSeq = 0; // pairs probe replies with the file that requested them

// ---- CRS detection ----
// A DWG carries no reliable CRS declaration, which is why the operator
// chooses. What the converter DOES surface is every declaration the drawing
// happens to contain: a GEODATA object (AutoCAD geographic location), and
// text strings from any space — the title block's "DATUM: UTM - SIRGAS 2000
// - MC 33° W - FUSO 25 SUL" — as `crs_text_hints`. When one of those names
// both a datum and a zone, the CRS is prefilled and the quote shown, so the
// operator can see exactly what the choice rests on. Anything weaker (only a
// zone, only coordinate magnitudes) stays a suggestion.
const PROBE_MAX_BYTES = 32 * 1024 * 1024;

const DATUM_PATTERNS = [
  ['sirgas2000', /SIRGAS/i],
  ['wgs84', /WGS\s*-?\s*84|UTM84|\bWGS\b/i],
  ['sad69', /SAD\s*-?\s*69|\bSAD\b/i],
  ['corrego', /C[OÓ]RREGO\s*ALEGRE/i],
];
const DATUM_NAMES = { sirgas2000: 'SIRGAS 2000', wgs84: 'WGS 84', sad69: 'SAD69', corrego: 'Córrego Alegre' };

// Parse one text string into { datum, zone, south } (each may be null).
function parseCrsText(raw) {
  const text = String(raw).replace(/%%[dD]/g, '°').replace(/\s+/g, ' ');
  let datum = null;
  for (const [key, re] of DATUM_PATTERNS) if (re.test(text)) { datum = key; break; }
  let zone = null;
  let south = null;
  let m;
  if ((m = text.match(/EPSG\s*:?\s*(\d{4,5})/i))) return { epsg: `EPSG:${m[1]}`, datum, zone, south };
  if ((m = text.match(/(?:FUSO|ZONA|ZONE)\s*:?\s*(\d{1,2})\s*([NS])?\b/i))) {
    zone = Number(m[1]);
    if (m[2]) south = m[2].toUpperCase() === 'S';
  } else if ((m = text.match(/UTM\s*-?\s*(?:84)?\s*-?\s*(\d{1,2})\s*([NS])\b/i))) {
    zone = Number(m[1]);
    south = m[2].toUpperCase() === 'S';
  } else if ((m = text.match(/(?:\bMC\b|M\.\s*C\.|MERIDIANO\s*CENTRAL)\s*:?\s*(-?\d{1,3})\s*[°º]?\s*([WEO])?/i))) {
    // Central meridian → zone: 33° W is zone 25 (183 − 33)/6.
    let mc = Number(m[1]);
    const dir = (m[2] || '').toUpperCase();
    if (dir === 'W' || dir === 'O') mc = -Math.abs(mc);
    const z = (183 + mc) / 6;
    if (Number.isInteger(z) && z >= 1 && z <= 60) zone = z;
  }
  if (south === null) {
    if (/\bSUL\b|\bSOUTH\b|\bS\b(?![A-Z])/i.test(text) && !/\bNORTE\b|\bNORTH\b/i.test(text)) south = true;
    else if (/\bNORTE\b|\bNORTH\b/i.test(text)) south = false;
  }
  if (zone !== null && (zone < 1 || zone > 60)) zone = null;
  return { epsg: null, datum, zone, south };
}

// Combine the evidence into a decision. Returns null or
// { code, text, quote, apply } — apply=true when datum AND zone are declared.
function detectCrs(probe) {
  const bbox = probe.bbox || null;
  const bboxSouth = bbox ? bbox[3] >= 1e6 : null; // UTM northings in the southern hemisphere
  const looksUtm = bbox && bbox[2] >= 1e5 && bbox[2] <= 1.1e6 && bbox[3] >= 0 && bbox[3] <= 1.0e7;

  const candidates = [];
  if (probe.geodata && probe.geodata.definition_summary) {
    candidates.push({ source: 'the drawing’s GEODATA (geographic location) object', text: probe.geodata.definition_summary });
  }
  for (const h of probe.crs_text_hints || []) {
    const where = h.space === 'paper' ? 'a paper-space layout (title block)' : h.space === 'model' ? 'model-space text' : 'a block definition';
    candidates.push({ source: `${h.entity_type} in ${where}`, text: h.text });
  }

  let partial = null;
  for (const c of candidates) {
    const p = parseCrsText(c.text);
    if (p.epsg && CRS.some((e) => e.code === p.epsg)) {
      return { code: p.epsg, quote: c.text, apply: true, text: `Source CRS declared as ${p.epsg} by ${c.source}.` };
    }
    const south = p.south !== null ? p.south : bboxSouth;
    if (p.datum && p.zone !== null && south !== null) {
      const entry = findUtm(p.datum, p.zone, south);
      if (entry) {
        return { code: entry.code, quote: c.text, apply: true,
          text: `${entry.label} — declared by ${c.source}${p.south === null ? ' (hemisphere taken from the coordinates)' : ''}.` };
      }
      return { code: 'CUSTOM', quote: c.text, apply: false,
        def: `+proj=utm +zone=${p.zone}${south ? ' +south' : ''} ${(UTM_FAMILIES.find((f) => f.key === p.datum) || UTM_FAMILIES[0]).proj}`,
        text: `${DATUM_NAMES[p.datum]} / UTM ${p.zone}${south ? 'S' : 'N'} declared by ${c.source} is outside the catalog — use it as a custom proj4 string.` };
    }
    if (!partial && (p.zone !== null || p.datum)) partial = { ...p, source: c.source, quote: c.text };
  }

  if (partial && partial.zone !== null) {
    const south = partial.south !== null ? partial.south : bboxSouth;
    const entry = findUtm('sirgas2000', partial.zone, south !== null ? south : true);
    if (entry) {
      return { code: entry.code, quote: partial.quote, apply: false,
        text: `UTM zone ${partial.zone} is declared by ${partial.source} but no datum — SIRGAS 2000 (Brazil’s official datum) is the likely reading; confirm.` };
    }
  }
  if (!bbox) return null;
  const [minx, , maxx, maxy] = bbox;
  if (Math.abs(minx) <= 180 && Math.abs(maxx) <= 180 && Math.abs(maxy) <= 90) {
    return { code: 'EPSG:4326', apply: false, text: 'Coordinates fit longitude/latitude ranges — this may already be WGS 84.' };
  }
  if (maxx >= 5.5e6 && maxx <= 6.5e6 && maxy >= 1.7e6 && maxy <= 2.4e6) {
    return { code: 'EPSG:2227', apply: false, text: 'Extents match California State Plane zone 3 in US survey feet (the CRS the CCSF basemap declares).' };
  }
  if (looksUtm && maxy >= 6.5e6) {
    // An older converter build (no `crs_text_hints` field) never looked for
    // declarations, so do not claim the drawing has none.
    const declared = Array.isArray(probe.crs_text_hints)
      ? 'no text in the drawing declares it'
      : 'this converter build does not read the drawing’s text declarations';
    return { code: null, apply: false,
      text: `Extents look like southern-hemisphere UTM in metres${partial && partial.datum ? ` and the drawing mentions ${DATUM_NAMES[partial.datum]}` : ''}. The zone cannot be inferred from coordinates and ${declared} — pick it from the drawing’s documentation.` };
  }
  return null;
}

function clearCrsHint() {
  crsHint.classList.add('hidden');
  crsHint.innerHTML = '';
}

function applySuggestion(suggestion) {
  crsSelect.value = suggestion.code;
  if (suggestion.code === 'CUSTOM' && suggestion.def) customInput.value = suggestion.def;
  crsSelect.dispatchEvent(new Event('change'));
}

function onProbeResult(data) {
  if (data.seq !== probeSeq || !fileBytes) return; // a newer file superseded it
  const suggestion = data.ok ? detectCrs(data) : null;
  if (!suggestion) { clearCrsHint(); return; }
  if (suggestion.apply) {
    applySuggestion(suggestion);
    setStatus(`Source CRS set to ${suggestion.code} from the drawing’s own declaration — confirm and convert.`, 'ok');
  }
  const quote = suggestion.quote
    ? ` <q class="crsquote">${escapeHtml(suggestion.quote)}</q>`
    : '';
  const note = suggestion.quote
    ? 'Read from text in the drawing — the map is only right if that text is.'
    : 'Heuristic on coordinate magnitudes only — confirm before trusting the result.';
  crsHint.classList.remove('hidden');
  crsHint.innerHTML =
    `<span class="hint-ic" aria-hidden="true">${suggestion.apply ? '📌' : '💡'}</span> ${escapeHtml(suggestion.text)}${quote}` +
    (suggestion.code && !suggestion.apply && crsSelect.value !== suggestion.code
      ? ` <button type="button" class="linkbtn" id="applyhint">Use ${escapeHtml(suggestion.code === 'CUSTOM' ? 'custom proj4' : suggestion.code)}</button>`
      : '') +
    ` <span class="muted">${note}</span>`;
  const apply = document.getElementById('applyhint');
  if (apply) {
    apply.addEventListener('click', () => {
      applySuggestion(suggestion);
      clearCrsHint();
      setStatus(`Source CRS set to ${suggestion.code} — confirm it matches the drawing's documentation.`, 'ok');
    });
  }
}

function launchProbe() {
  if (!fileBytes || fileBytes.length > PROBE_MAX_BYTES) return;
  const seq = ++probeSeq;
  worker.postMessage({ probe: true, seq, bytes: fileBytes });
}

function clearFile() {
  fileBytes = null;
  fileName = '';
  drop.classList.remove('loaded');
  fileMeta.classList.add('hidden');
  convertBtn.disabled = true;
  clearCrsHint();
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
    launchProbe();
  }).catch(() => {
    if (seq === loadSeq) setStatus('Could not read that file.', 'err');
  });
}

// ---- Bundled examples ----
for (const example of EXAMPLES) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn example';
  btn.textContent = example.label;
  btn.addEventListener('click', () => loadExample(example, btn));
  exampleList.appendChild(btn);
}

function loadExample(example, btn) {
  const seq = ++loadSeq;
  clearFile();
  btn.disabled = true;
  setStatus(`Loading ${example.file}…`, 'busy');
  fetch(`examples/${example.file}`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((buf) => {
      btn.disabled = false;
      if (seq !== loadSeq) return;
      fileBytes = new Uint8Array(buf);
      fileName = example.file;
      drop.classList.add('loaded');
      fileMeta.classList.remove('hidden');
      fileMeta.innerHTML =
        `<span class="ok-tick">✓</span> <strong>${escapeHtml(example.file)}</strong>` +
        `<span class="muted"> · ${formatBytes(fileBytes.length)} · CCSF Digital Basemap (PDDL-1.0)</span>`;
      // The DWG itself declares no CRS; this value comes from the dataset's
      // OWN metadata page, which is why the app may prefill it honestly.
      crsSelect.value = example.crs;
      crsSelect.dispatchEvent(new Event('change'));
      clearCrsHint();
      setStatus(`Example loaded. Source CRS prefilled to ${example.crs} (declared by the publisher, not by the DWG) — convert when ready.`, 'ok');
      convertBtn.disabled = false;
    })
    .catch((error) => {
      btn.disabled = false;
      if (seq === loadSeq) setStatus(`Could not load the example: ${error.message || error}`, 'err');
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
    whenStyleReady(clearMapLayers);
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
  mapReady.then(() => {
    if (styleReady || map.isStyleLoaded()) cb();
    else map.once('load', cb);
  });
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
      'text-font': LABEL_FONT,
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

// ---- Basemap switch (Streets ⇄ Satellite) ----
function setActiveBasemap(btn) {
  for (const b of basemapCtl.querySelectorAll('button')) {
    b.classList.toggle('active', b === btn);
  }
}
basemapCtl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-base]');
  if (!btn || btn.disabled) return;
  const sat = btn.dataset.base === 'sat';
  whenStyleReady(() => {
    for (const id of streetLayerIds) map.setLayoutProperty(id, 'visibility', sat ? 'none' : 'visible');
    map.setLayoutProperty('sat', 'visibility', sat ? 'visible' : 'none');
  });
  setActiveBasemap(btn);
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
