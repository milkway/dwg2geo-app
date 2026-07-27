#!/usr/bin/env bash
# Fetch the published dwg2geo npm package (the WASM conversion bindings) into
# web/pkg/. The app is a pure static site — no Rust toolchain needed; bump
# VERSION to upgrade the converter. npm verifies the tarball integrity
# against the registry checksum.
set -euo pipefail
cd "$(dirname "$0")"

VERSION="0.2.3"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
(cd "$tmp" && npm pack "dwg2geo@${VERSION}" --silent >/dev/null)
rm -rf web/pkg && mkdir -p web/pkg
tar xzf "$tmp/dwg2geo-${VERSION}.tgz" -C web/pkg --strip-components=1

# Example drawings: CCSF Digital Basemap sheets (San Francisco Public Works,
# PDDL-1.0 — public domain, redistributable). Fetched from dated Internet
# Archive snapshots of the canonical URLs (bsm.sfdpw.org rejects non-US
# traffic) and pinned by SHA-256 so a tampered or partial download fails the
# build instead of shipping.
fetch_example() {
  local name="$1" snapshot="$2" sha="$3"
  # The committed copy is authoritative when its digest matches; the snapshot
  # is the recovery path, so a deploy does not depend on archive.org being up.
  if echo "${sha}  web/examples/${name}.dwg" | shasum -a 256 -c - >/dev/null 2>&1; then
    return
  fi
  local zip="$tmp/${name}.zip"
  curl -fsSL --retry 3 -o "$zip" "$snapshot"
  (cd "$tmp" && unzip -oq "$zip" "${name}.dwg")
  echo "${sha}  $tmp/${name}.dwg" | shasum -a 256 -c - >/dev/null
  mv "$tmp/${name}.dwg" "web/examples/${name}.dwg"
}
mkdir -p web/examples
fetch_example sf00c \
  "https://web.archive.org/web/20260726225654id_/https://bsm.sfdpw.org/maps/basemap_dwg/sf00c.zip" \
  3659798a03a732cc9fed261621e69a86870a69ca10c55be8e8684f434ec5c850
fetch_example sf01c \
  "https://web.archive.org/web/20260726225426id_/https://bsm.sfdpw.org/maps/basemap_dwg/sf01c.zip" \
  f2b53ff484578bb9606a92f8c671c081d531cdef47058e25c0712086b5875554

echo "web/pkg <- dwg2geo@${VERSION} (npm) + web/examples (CCSF, PDDL-1.0)."
echo "Serve with: python3 -m http.server -d web 8080"
