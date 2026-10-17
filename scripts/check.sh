#!/bin/bash
# Every automated check, headless and silent. Writes work/check-report.txt.
#   scripts/check.sh            # unit + integration + plugin validate/test + typecheck + audio analysis
#   scripts/check.sh --pty      # also drives the real interactive CLI in a pty (no model call)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$HERE"
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
OUT="$HERE/work/check-report.txt"
mkdir -p work/out
fail=0
run() { echo "== $1"; shift; "$@" 2>&1 | tail -"${TAIL:-12}"; local s=${PIPESTATUS[0]}; [ "$s" = 0 ] || { echo "!! failed ($s)"; fail=1; }; echo; }
{
  date '+%Y-%m-%d %H:%M:%S'
  echo "claude $("$CLAUDE_BIN" --version) / node $(node --version) / $(/opt/homebrew/bin/ffplay -version 2>/dev/null | head -1 | cut -d' ' -f1-3)"
  echo
  TAIL=8 run "engine: unit + integration tests (node --test)" node --test engine/test/*.test.mjs
  TAIL=4 run "mod: claude plugin validate" "$CLAUDE_BIN" plugin validate mod
  TAIL=12 run "mod: claude plugin test" "$CLAUDE_BIN" plugin test mod
  if [ -x node_modules/.bin/tsc ]; then
    # Types the CLI wrote when it loaded the mod (the target build); bundled copy otherwise.
    if [ -f mod/.claude-plugin/types/claude-code/index.d.ts ]; then
      TAIL=20 run "mod: tsc strict against $(head -1 mod/.claude-plugin/types/claude-code/index.d.ts | sed 's#// ##')" node_modules/.bin/tsc -p mod
    else
      echo "== mod: tsc skipped (start Claude Code with the mod once so it writes mod/.claude-plugin/types/)"
    fi
  fi
  TAIL=40 run "audio: DEMO render 62 s" node engine/render.mjs --script demo --seconds 62 --out work/out/demo.wav
  TAIL=40 run "audio: REPLAY render 60 s" node engine/render.mjs --script replay --events recordings/replay.json --seconds 60 --out work/out/replay.wav
  TAIL=40 run "audio: idle 20 s (no events)" node engine/render.mjs --script idle --seconds 20 --out work/out/idle.wav
  TAIL=40 run "audio: flood 20 s (40 live events every 100 ms)" node engine/render.mjs --script live --seconds 20 --flood 40 --out work/out/flood.wav
  if [ "${1:-}" = "--pty" ]; then TAIL=30 run "cli: pty smoke (real interactive claude, silent sink)" python3 scripts/pty-smoke.py; fi
  [ "$fail" = 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
} | tee "$OUT"
exit $fail
