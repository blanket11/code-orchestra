#!/bin/bash
# Plays 6 seconds of the DEMO intro at low volume, to check the speakers before presenting.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
NODE_BIN="${CODE_ORCHESTRA_NODE:-$(command -v node)}"
OUT="$HERE/work/sound-check.wav"
"$NODE_BIN" "$HERE/engine/render.mjs" --script demo --seconds 6 --volume 0.3 --out "$OUT" >/dev/null
echo "playing $OUT (6 s)…"
/usr/bin/afplay "$OUT"
