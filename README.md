# dwg2geo-app

[![CI](https://github.com/milkway/dwg2geo-app/actions/workflows/ci.yml/badge.svg)](https://github.com/milkway/dwg2geo-app/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE-MIT)
[![WebAssembly](https://img.shields.io/badge/runs-in%20the%20browser-8A2BE2.svg)](https://milkway.github.io/dwg2geo-app/)

A browser app that turns a **DWG drawing into a map layer**. Upload a `.dwg`, pick its coordinate system, and see it rendered as GeoJSON on an interactive [MapLibre](https://maplibre.org/) map.

**Live app:** <https://milkway.github.io/dwg2geo-app/>

## Everything runs in your browser

The conversion is [`dwg2geo`](https://github.com/milkway/dwg2geo) — the audited, pure-Rust DWG→GeoJSON converter — compiled to **WebAssembly**. Your drawing is read and converted entirely on your device: **the file is never uploaded to any server.** The app is a static site.

## How it works

1. **Convert** — the DWG bytes go to the WASM module, which returns a GeoJSON `FeatureCollection` in the drawing's local coordinates, plus a conversion report (feature counts, skipped/failed entities with reasons, warnings, bounding box).
2. **Georeference** — you choose the drawing's source CRS (SIRGAS 2000 / UTM zones, WGS 84 / UTM, or a custom proj4 string). The app reprojects every coordinate to WGS 84 in the browser with [proj4js](http://proj4js.org/).
3. **Map** — the reprojected features are drawn on MapLibre over a free basemap (**streets or satellite imagery**), styled with each entity's own CAD **colour** and **line weight**, with **TEXT/MTEXT rendered as rotated labels**. A floating **Layers menu** on the map lets you toggle each imported DWG layer (and the text labels), and the view fits the drawing's bounds. Click a feature to inspect its CAD properties.
4. **Export** — download the reprojected WGS 84 GeoJSON with one click, ready for QGIS, geojson.io, or any GIS pipeline.

## Build & run locally

Requires Rust (with the `wasm32-unknown-unknown` target) and [`wasm-pack`](https://rustwasm.github.io/wasm-pack/).

```bash
./build.sh                          # builds web/pkg via wasm-pack
python3 -m http.server -d web 8080  # then open http://localhost:8080
```

`maplibre-gl` and `proj4` load from a CDN; the WebAssembly bundle is built locally into `web/pkg/` (git-ignored — regenerated on each deploy).

## License

MIT (`LICENSE-MIT`). Bundles no LibreDWG/GDAL. The conversion core (`dwg2geo` + its dependencies) is permissive; the only weak-copyleft dependency is `acadrust` (MPL-2.0). See the [dwg2geo licensing notes](https://github.com/milkway/dwg2geo).
