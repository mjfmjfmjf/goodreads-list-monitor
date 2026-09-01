#!/bin/bash
# monitorTopRatedList.sh — wrapper for `monitor-top-rated-list`
#
# Offline report over the goodreads.db book cache: the top-N highest-rated books
# with at least `--min` ratings, excluding box sets (seriesPos==99.99) and only
# one (highest-rated) book per series (series name parsed from the title suffix),
# diffed against the Listopia user-votes page.
#
# Usage:
#   ./monitorTopRatedList.sh
#   ./monitorTopRatedList.sh --min 10000 --limit 100
#   ./monitorTopRatedList.sh --votes 7700658
set -euo pipefail
cd "$(dirname "$0")"
npm run monitor-top-rated-list -- "$@"