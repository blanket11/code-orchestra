#!/bin/bash
# CODE ORCHESTRA launcher for iTerm2.
#   scripts/start.sh            # opens Claude Code in a fresh copy of the demo project
#   scripts/start.sh <dir>      # opens Claude Code in <dir> instead (your own project)
# Safe to rerun: leftover engines of this product are cleaned first, and each
# Claude session owns at most one engine (it dies with the session).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
[ -x "$CLAUDE_BIN" ] || CLAUDE_BIN="$(command -v claude || true)"
NODE_BIN="${CODE_ORCHESTRA_NODE:-$(command -v node || true)}"
FFPLAY_BIN="${CODE_ORCHESTRA_FFPLAY:-$(command -v ffplay || echo /opt/homebrew/bin/ffplay)}"

fail() { echo "code-orchestra: $*" >&2; exit 1; }
[ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ] || fail "claude CLI not found (set CLAUDE_BIN)"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || fail "node not found (set CODE_ORCHESTRA_NODE)"
[ -x "$FFPLAY_BIN" ] || fail "ffplay not found (brew install ffmpeg, or set CODE_ORCHESTRA_FFPLAY)"

"$HERE/scripts/stop.sh" --orphans-only >/dev/null 2>&1 || true

if [ "$#" -ge 1 ]; then
  WORKDIR="$(cd "$1" && pwd -P)"
else
  WORKDIR="$HERE/work/demo-project"
  rm -rf "$WORKDIR"
  mkdir -p "$HERE/work"
  cp -R "$HERE/fixtures/demo-project" "$WORKDIR"
fi

export CODE_ORCHESTRA_NODE="$NODE_BIN"
export CODE_ORCHESTRA_FFPLAY="$FFPLAY_BIN"
echo "CODE ORCHESTRA — project: $WORKDIR"
echo "  In the pane: s Start/Stop · r Remix · d Demo · p Replay · l Live · j/k Volume"
echo "  (ctrl+x tab, or click the pane, to give it the keys; /orchestra reopens it)"
cd "$WORKDIR"
exec "$CLAUDE_BIN" --plugin-dir "$HERE/mod"
