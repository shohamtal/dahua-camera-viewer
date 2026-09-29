#!/usr/bin/env bash
# Fit the store screenshots (max 5, in listing order) into a 1280x800 canvas
# (Chrome Web Store size).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p store/screenshots

python3 - <<'PY'
from PIL import Image
import os
W, H = 1280, 800
SHOTS = ["live-grid", "events", "recordings", "admin-security", "admin-users"]
for i, name in enumerate(SHOTS, 1):
    src = f"docs/screenshots/{name}.png"
    im = Image.open(src).convert("RGB")
    im.thumbnail((W, H), Image.LANCZOS)
    canvas = Image.new("RGB", (W, H), (15, 18, 22))  # app background
    canvas.paste(im, ((W - im.width) // 2, (H - im.height) // 2))
    out = f"store/screenshots/{i}-{name}.png"
    canvas.save(out)
    print("wrote", out)
PY
