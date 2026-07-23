//! WebAssembly wrapper over `dwg2geo`'s in-memory conversion API.

use wasm_bindgen::prelude::*;

/// Convert DWG bytes to a GeoJSON FeatureCollection (local drawing
/// coordinates) plus a summary. Returns a JS object shaped like
/// `dwg2geo::backend::native::EmbedResult`. Reprojection to WGS84 is done in
/// JavaScript with proj4js — this function never guesses a CRS.
#[wasm_bindgen]
pub fn convert(
    bytes: &[u8],
    polygonize_closed: bool,
    curve_tolerance: Option<f64>,
) -> Result<JsValue, JsValue> {
    console_error_panic_hook::set_once();
    let result = dwg2geo::backend::native::convert_bytes(bytes, polygonize_closed, curve_tolerance)
        .map_err(|error| JsValue::from_str(&format!("{error:#}")))?;
    serde_wasm_bindgen::to_value(&result).map_err(|error| JsValue::from_str(&error.to_string()))
}
