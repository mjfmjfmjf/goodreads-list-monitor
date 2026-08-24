#!/bin/bash
# bookSweep.sh — wrapper for `book-sweep`
#
# Slowly fetches book pages from Goodreads to sweep genres and workIds into the book cache.
# Picks random books with enough ratings that are missing genres or workId. Exits on throttle.
#
# Usage:
#   ./bookSweep.sh                              # defaults: 100 books, minRatings=1000, delay=30s
#   ./bookSweep.sh --limit 50                   # process at most 50 books
#   ./bookSweep.sh --minRatings 50000           # only books with 50k+ ratings
#   ./bookSweep.sh --delay 60                   # 60s between requests
#   ./bookSweep.sh --delay 20 --delayJitter 10  # 20-30s between requests
#   ./bookSweep.sh --limit 20 --minRatings 100000 --delay 45
#   ./bookSweep.sh --throttleSleep 600  # 10 min wait on throttle before retry
set -euo pipefail
cd "$(dirname "$0")"
npm run book-sweep -- "$@"
