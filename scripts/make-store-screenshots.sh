#!/usr/bin/env bash
# Fit each docs screenshot into a 1280x800 white canvas (Chrome Web Store size).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p store/screenshots

python3 - <<'PY'
from PIL import Image
import glob, os
W, H = 1280, 800
for src in sorted(glob.glob("docs/screenshots/*.png")):
    im = Image.open(src).convert("RGB")
    im.thumbnail((W, H), Image.LANCZOS)
    canvas = Image.new("RGB", (W, H), (255, 255, 255))
    canvas.paste(im, ((W - im.width) // 2, (H - im.height) // 2))
    out = os.path.join("store/screenshots", os.path.basename(src))
    canvas.save(out)
    print("wrote", out)
PY
