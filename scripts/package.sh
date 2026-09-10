#!/usr/bin/env bash
# Build the Chrome Web Store upload zip: extension files only, no repo cruft.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(grep -o '"version"[^,]*' manifest.json | grep -o '[0-9][0-9.]*')
OUT="dist/dahua-camera-viewer-${VERSION}.zip"

rm -rf dist && mkdir -p dist
zip -r -X "$OUT" \
  manifest.json app.html app.js style.css background.js \
  lib icons \
  -x '*.DS_Store' >/dev/null

echo "Built $OUT"
unzip -l "$OUT"
