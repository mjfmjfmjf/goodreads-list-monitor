#!/bin/bash
# monitorTopStandalones.sh — wrapper for `monitor-top-standalones`
#
# Reorder the user's Listopia votes for a standalones list: keep only
# standalone books (no series markers), drop non-standalones and books
# below the ratings threshold, then sort by avg rating desc (# ratings
# as tiebreaker).
#
# Usage:
#   ./monitorTopStandalones.sh
#   ./monitorTopStandalones.sh --votes 9695567
#   ./monitorTopStandalones.sh --min 10000
set -euo pipefail
cd "$(dirname "$0")"
npm run monitor-top-standalones -- "$@"
