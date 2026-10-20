#!/usr/bin/env bash
# Starts the app server. Proven behaviour (blueprint §3.2): do not change.
#   --foreground  postStartCommand: runs the server in the foreground so a remote wake keeps it alive
#   --watch       postAttachCommand: starts the server only if it isn't running, then tails the log
#   (no flag)     npm run server: restarts the server in the background, then tails the log
cd "$(dirname "$0")/.." || exit 1
DIR="$PWD/.server"; mkdir -p "$DIR"; LOG="$DIR/server.log"; MODE="${1:-}"
note() { echo "$(date -u +%FT%TZ) [$MODE] $*" >>"$DIR/start.log"; }
running() { pgrep -f '^node server/index\.js' >/dev/null 2>&1; }
case "$MODE" in
  --foreground) pkill -f '^node server/index\.js'; : >"$LOG"; note "foreground"
                node server/index.js >>"$LOG" 2>&1 </dev/null; note "stopped ($?)"; exit 0 ;;
  --watch)      running || { setsid nohup node server/index.js >>"$LOG" 2>&1 </dev/null & } ;;
  *)            pkill -f '^node server/index\.js'; sleep 1; : >"$LOG"
                setsid nohup node server/index.js >>"$LOG" 2>&1 </dev/null & ;;
esac
exec tail -n 40 -f "$LOG"
