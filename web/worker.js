// Conversion runs off the main thread so the UI never freezes on large
// drawings. The worker owns the WASM module and proj4, converts the DWG,
// reprojects to WGS 84, and posts back a ready-to-render FeatureCollection.

import init, { convert } from './pkg/dwg2geo_app.js';
import proj4 from 'https://cdn.jsdelivr.net/npm/proj4@2.15.0/+esm';

const ready = init();

self.onmessage = async (event) => {
  const { bytes, polygonize, tolerance, srcDef } = event.data;
  try {
    await ready;
    // Validate the projection up front so a bad CRS fails fast, before the
    // (potentially expensive) DWG conversion runs.
    let transform;
    try {
      transform = srcDef ? proj4(srcDef, 'EPSG:4326') : null;
    } catch {
      self.postMessage({ ok: false, error: 'That proj4/WKT CRS string is not valid.' });
      return;
    }
    const result = convert(bytes, polygonize, tolerance);
    const fc = JSON.parse(result.geojson);
    const reprojected = reproject(fc, transform);
    const bounds = boundsOf(reprojected);
    self.postMessage({
      ok: true,
      fc: reprojected,
      bounds,
      report: {
        feature_count: result.feature_count,
        model_space_entities: result.model_space_entities,
        converted: result.converted,
        skipped: result.skipped,
        failed: result.failed,
        warnings: result.warnings,
        source_sha256: result.source_sha256,
        reprojected: Boolean(transform),
      },
    });
  } catch (error) {
    self.postMessage({ ok: false, error: String((error && error.message) || error) });
  }
};

function reproject(geojson, transform) {
  const fwd = transform ? (p) => transform.forward([p[0], p[1]]) : (p) => [p[0], p[1]];
  const mapCoords = (c) => (typeof c[0] === 'number' ? fwd(c) : c.map(mapCoords));
  return {
    type: 'FeatureCollection',
    features: geojson.features.map((f) => ({
      type: 'Feature',
      properties: f.properties || {},
      geometry: f.geometry
        ? { type: f.geometry.type, coordinates: mapCoords(f.geometry.coordinates) }
        : null,
    })),
  };
}

function boundsOf(fc) {
  let b = null;
  const ext = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!b) b = [x, y, x, y];
    else {
      b[0] = Math.min(b[0], x);
      b[1] = Math.min(b[1], y);
      b[2] = Math.max(b[2], x);
      b[3] = Math.max(b[3], y);
    }
  };
  const walk = (c) => (typeof c[0] === 'number' ? ext(c[0], c[1]) : c.forEach(walk));
  for (const f of fc.features) if (f.geometry) walk(f.geometry.coordinates);
  return b ? [[b[0], b[1]], [b[2], b[3]]] : null;
}
