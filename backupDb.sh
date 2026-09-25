#!/bin/bash
# Backup the Goodreads SQLite DB, keeping the last 7 daily snapshots.
# Run on a schedule (cron / launchd). NOTE: crawlers are always running in this
# environment, so this intentionally does NOT skip when they are active.
#   Fast path: wal_checkpoint(TRUNCATE) then an APFS copy-on-write clone of the
#   main file (seconds). If the WAL can't be reclaimed mid-crawl, it falls back
#   to the consistent SQLite backup API, which replays the WAL but may take
#   tens of minutes while crawlers contend for disk I/O.
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use 22 > /dev/null

echo starting backupDb.sh
date
npm start -- backup
echo ended backupDb.sh
date