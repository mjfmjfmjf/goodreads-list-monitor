#!/bin/bash
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use 22

# Death-notes log (see traps). The crawl itself runs straight to the screen —
# same output path monitor always used — so nothing about on-screen behavior
# changes. The log captures exactly how the run ended (and the dying words, if
# it chose to have any). Set GOODREADS_MONITOR_TEE=1 to also capture the full
# run output into the log via tee.
LOG="monitor-$(date +%Y%m%d-%H%M%S).log"

# Mirror a line to the log and, when the terminal is still alive, the console.
note() {
  local msg="[$(date "+%b %d %H:%M:%S")] monitor.sh: $1"
  echo "$msg" >> "$LOG" 2>/dev/null || true
  echo "$msg" 2>/dev/null || true
}

# Leave a death note on every exit (normal rc=0, error rc=1, SIGINT rc=130...).
# bash re-raises the caught signal's rc through exit below, so this accurately
# records how the run ended.
trap 'rc=$?; note "process ended, rc=$rc"; exit $rc' EXIT
# The shell dying means the whole foreground group (caffeinate/bash/npm/node)
# was singled; log WHY so it can't be dismissed as a code crash.
trap 'note "caught SIGHUP (terminal/session closed) - stopping"; exit 129' 1
trap 'note "caught SIGINT (Ctrl+C) - stopping"; exit 130' 2
trap 'note "caught SIGTERM (external kill) - stopping"; exit 143' 15

echo starting monitor.sh
echo "log: $LOG"
date
# The DB snapshot is intentionally NOT part of this loop anymore: a
# consistent-snapshot backup of the multi-GB DB takes ~an hour under crawler
# load. Run it on its own schedule via ./backupDb.sh when nothing else is
# using the DB.
# every ADDED/REMOVED event the run finds is appended to this gitignored file.
CHANGELOG="changeLog.txt"
BEFORE_LINES=$(wc -l < "$CHANGELOG" 2>/dev/null || echo 0)

if [ "$GOODREADS_MONITOR_TEE" = "1" ]; then
  set -o pipefail
  npm start 2>&1 | tee -a "$LOG"
else
  npm start 2>&1
fi

# Receipt: the screen may stall, but the results never should — copy this run's
# ADDED/REMOVED events (already in changeLog.txt) into the monitor log too.
AFTER_LINES=$(wc -l < "$CHANGELOG" 2>/dev/null || echo 0)
DELTA=$((AFTER_LINES - BEFORE_LINES))
if [ "$DELTA" -gt 0 ]; then
  {
    echo "----- this run: $DELTA list change(s) logged to changeLog.txt -----"
    tail -n "$DELTA" "$CHANGELOG"
  } >> "$LOG" 2>/dev/null || true
  echo "$(date "+%b %d %H:%M:%S") $DELTA list change(s) this run — see $LOG"
else
  echo "$(date "+%b %d %H:%M:%S") no list changes this run"
fi
date
echo ended monitor.sh