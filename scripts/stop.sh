#!/bin/bash
# Stops CODE ORCHESTRA engines started from this folder — nothing else.
#   scripts/stop.sh                 # every engine of this product (sessions keep running, music stops)
#   scripts/stop.sh --orphans-only  # only engines whose Claude session is gone
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENGINE="$HERE/engine/main.mjs"
only_orphans=0; [ "${1:-}" = "--orphans-only" ] && only_orphans=1
n=0
for pid in $(pgrep -f -- "$ENGINE" || true); do
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$cmd" in *"$ENGINE"*) ;; *) continue ;; esac
  ppid="$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')"
  if [ "$only_orphans" = 1 ] && [ "$ppid" != "1" ]; then continue; fi
  kill -TERM "$pid" 2>/dev/null && n=$((n+1))
done
# Sockets left by engines that are gone.
for s in "$HOME/.code-orchestra/run/"*.sock; do
  [ -S "$s" ] || continue
  if ! pgrep -f -- "--sock $s" >/dev/null 2>&1; then rm -f "$s"; fi
done
echo "code-orchestra: stopped $n engine(s)"
