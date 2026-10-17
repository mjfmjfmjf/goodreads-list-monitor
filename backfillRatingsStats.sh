#!/bin/bash
# backfillRatingsStats.sh — wrapper for `backfill-ratings-stats`
#
# Offline: recompute the derived ratings statistics columns on book_page
# (mean/median/mode/variance/stddev/skewness/kurtosis/total) from each row's
# stored ratings_dist JSON. Rows without a distribution are left untouched.
# No network requests.
#
# Usage:
#   ./backfillRatingsStats.sh
set -euo pipefail
cd "$(dirname "$0")"
npm run backfill-ratings-stats -- "$@"
