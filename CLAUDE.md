# dwg2geo-app

Static site (GitHub Pages) that converts a DWG to GeoJSON in the browser and maps it. No
build step beyond `./build.sh`; no bundler, no framework. Three files matter:

- `web/app.js` — UI, CRS catalog + detection, MapLibre map. ES module.
- `web/worker.js` — owns the WASM converter and proj4; converts, reprojects, posts back.
- `build.sh` — vendors `dwg2geo@VERSION` from npm into `web/pkg/` (git-ignored) and the two
  CCSF example DWGs (SHA-pinned, committed).

## Converter coupling

The converter is the npm package `dwg2geo` (wasm build of `~/Github/dwg2geo`,
`bindings/js`). Its result shape is the contract: `{ geojson, feature_count,
model_space_entities, converted, skipped, failed, warnings, bbox, source_sha256, geodata,
crs_text_hints }`. `geodata` and `crs_text_hints` exist since 0.2.5.

- A feature the app needs from the converter means: change the core, run its
  `scripts/dev-check.sh`, release it (flow in that repo's `CLAUDE.md`), then bump `VERSION`
  in `build.sh`. The deployed site fetches from npm at deploy time, so the app must degrade
  when a field is missing (`result.x ?? null` in the worker, `Array.isArray` checks in
  `detectCrs`) — CI here also runs against the pinned npm version.
- To test an unreleased core build locally: `bash ~/Github/dwg2geo/bindings/js/build.sh`
  and copy `bindings/js/pkg` over `web/pkg/`.

## CRS detection (`detectCrs` in app.js)

A DWG has no reliable CRS field; the converter never applies one. Evidence hierarchy:

1. `crs_text_hints` (TEXT/MTEXT/ATTRIB from model, paper and block spaces that mention a
   CRS keyword) and the GEODATA definition are parsed by `parseCrsText`: datum
   (SIRGAS/WGS/SAD69/Córrego Alegre), zone ("FUSO 25", "UTM 25S", "ZONA 25", "MC 33° W" →
   (183−33)/6), hemisphere (SUL/NORTE/S/N), or a literal EPSG code. Datum + zone → CRS
   prefilled and the quoted text shown. Zone only → suggestion (SIRGAS 2000 assumed).
2. Otherwise coordinate magnitudes only suggest (lon/lat, CCSF State Plane, "southern UTM,
   zone unknown"). Never prefill from magnitudes: every UTM zone has the same E/N range.

The catalog (`UTM_FAMILIES` → `CRS`) is generated per datum family with EPSG numbering
(SIRGAS 2000 S = 31960+zone, N = 31954+zone; WGS 84 = 32700/32600+zone; SAD69 =
29170/29150+zone; Córrego Alegre S = 22500+zone). Detection and the `<select>` share it;
add a family there, not in two places.

## Basemaps

Both basemaps live in ONE MapLibre style so switching only toggles visibility
(`map.setStyle` would drop the DWG source/layers). Streets = OpenFreeMap "positron"
(vector, no key, no cap), fetched at startup with an 8 s timeout and merged with the Esri
World Imagery raster source; label glyphs come from OpenFreeMap too (`Noto Sans Regular`).
If the style fetch fails the map is satellite-only and the Streets button is disabled with a
title explaining why. Do not go back to CARTO raster tiles: since 2026 they return HTTP 200
images stamped "API KEY REQUIRED", so MapLibre raises no error and the stamp shows on the
map.

`map` is created asynchronously (`mapReady`); anything touching it goes through
`whenStyleReady(cb)`.

## Testing by hand

`python3 -m http.server -d web 8080` (after `./build.sh`). To drive it from the Claude in
Chrome tools, the file picker cannot be used and `file_upload` only reads session-shared
paths — copy the DWG into the scratchpad and upload from there, or serve it next to the app
and inject it: fetch → `File` → `DataTransfer` → `input.files` → dispatch `change`. Check
`#crshint`, `#crs`, `#status` and the `.maplibregl-ctrl-attrib` text. Fetching from
`127.0.0.1` inside the https site does not work (private-network access blocks it).
MapLibre vector-tile requests happen in its worker and are invisible to page-level network
tracking; raster tiles are not.

Sample drawing that exercises detection: a Civil 3D sheet whose title block reads
"UTM - SIRGAS-2000 - MC 33º W - FUSO 25 SUL" in paper space (Aldeia, Camaragibe-PE).
