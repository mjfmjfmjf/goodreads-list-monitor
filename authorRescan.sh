#!/bin/bash
# authorRescan.sh — wrapper for `author-rescan`
#
# Re-scrapes author pages to refresh stats (ratings, reviews, shelves, avg rating).
# Authors with no stats are always included regardless of other filters.
#
# Usage:
#   ./authorRescan.sh                              # defaults: top 100 by numRatings
#   ./authorRescan.sh --minRatings 10000 --limit 500   # top authors + any missing stats
#   ./authorRescan.sh --sortBy averageRating --minRatings 100000 --limit 10
#   ./authorRescan.sh --minAge 30 --limit 200     # skip authors updated in last 30 days
date
echo starting authorRescan.sh
npm run author-rescan -- "$@"
echo ended authorRescan.sh
date
