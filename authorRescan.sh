#!/bin/bash
# authorRescan.sh — wrapper for `author-rescan`
#
# Re-scrapes author pages to refresh stats (ratings, reviews, shelves, avg rating).
# Statless authors are NOT selected by the default path — use --rescanMissing.
#
# Usage:
#   ./authorRescan.sh                              # defaults: top 100 by numRatings
#   ./authorRescan.sh --minRatings 10000 --limit 500   # top authors (statless excluded)
#   ./authorRescan.sh --rescanMissing --multiPage --minRatings 1000000 --limit 100
#   ./authorRescan.sh --sortBy averageRating --minRatings 100000 --limit 10
#   ./authorRescan.sh --minAge 30 --limit 200     # skip authors updated in last 30 days
date
echo starting authorRescan.sh
npm run author-rescan -- "$@"
echo ended authorRescan.sh
date
