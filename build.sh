#!/usr/bin/env bash
# Fetch the published dwg2geo npm package (the WASM conversion bindings) into
# web/pkg/. The app is a pure static site — no Rust toolchain needed; bump
# VERSION to upgrade the converter. npm verifies the tarball integrity
# against the registry checksum.
set -euo pipefail
cd "$(dirname "$0")"

VERSION="0.2.1"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
(cd "$tmp" && npm pack "dwg2geo@${VERSION}" --silent >/dev/null)
rm -rf web/pkg && mkdir -p web/pkg
tar xzf "$tmp/dwg2geo-${VERSION}.tgz" -C web/pkg --strip-components=1

echo "web/pkg <- dwg2geo@${VERSION} (npm). Serve with: python3 -m http.server -d web 8080"
