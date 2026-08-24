#!/bin/bash
# backfillSeriesPos.sh — wrapper for `backfill-series-pos`
#
# Offline: recomputes series_pos for every cached book from its title
# (parseSeriesPos) and writes the column back. Fixes stale/incorrect values.
# No network requests.
#
# Usage:
#   ./backfillSeriesPos.sh
set -euo pipefail
cd "$(dirname "$0")"
npm run backfill-series-pos -- "$@"
