#!/bin/bash
# ratingsByDateHistogram.sh — wrapper for `ratings-by-date-histogram`
#
# Pivot of the ratings histogram: the rows stay the same rating brackets as
# ./ratingsHistogram.sh, but the columns become dates (the last N days, weeks,
# or months). Each cell is how many books were in the DB in that rating range
# as of that period, driven by the books.first_seen column (cumulative).
#
# Usage:
#   ./ratingsByDateHistogram.sh              # last 7 days
#   ./ratingsByDateHistogram.sh --days 30    # last 30 days
#   ./ratingsByDateHistogram.sh --weeks 12   # last 12 Monday-weeks
#   ./ratingsByDateHistogram.sh --months 6   # last 6 calendar months
set -euo pipefail
cd "$(dirname "$0")"
npm run ratings-by-date-histogram -- "$@"