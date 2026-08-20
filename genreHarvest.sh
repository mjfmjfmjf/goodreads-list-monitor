#!/bin/bash
# genreHarvest.sh — wrapper for `genre-harvest`
#
# Slowly fetches book pages from Goodreads to harvest genres into the book cache.
# Picks random books with enough ratings and no genres yet. Exits on throttle.
#
# Usage:
#   ./genreHarvest.sh                              # defaults: 100 books, minRatings=1000, delay=30s
#   ./genreHarvest.sh --limit 50                   # process at most 50 books
#   ./genreHarvest.sh --minRatings 50000           # only books with 50k+ ratings
#   ./genreHarvest.sh --delay 60                   # 60s between requests
#   ./genreHarvest.sh --delay 20 --delayJitter 10  # 20-30s between requests
#   ./genreHarvest.sh --limit 20 --minRatings 100000 --delay 45
#   ./genreHarvest.sh --throttleSleep 600  # 10 min wait on throttle before retry
set -euo pipefail
cd "$(dirname "$0")"
npm run genre-harvest -- "$@"
