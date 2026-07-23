#!/usr/bin/env bash
# Build the WebAssembly module + JS bindings into web/pkg/.
set -euo pipefail
cd "$(dirname "$0")"
wasm-pack build --target web --release --out-dir web/pkg
echo "Built web/pkg. Serve the app with:  python3 -m http.server -d web 8080"
