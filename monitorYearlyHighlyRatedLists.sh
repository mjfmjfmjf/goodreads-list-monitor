#!/bin/bash
# monitorYearlyHighlyRatedLists.sh — wrapper for `monitor-yearly-highly-rated-lists`
#
# Offline report: for each year (2012-2026), the current size of the
# "Highest Rated Books of YYYY" list vs how many distinct eligible works the
# book cache holds at 4.4+/4.5+/4.6+ avg rating (>=1000 ratings, by workId).
#
# Usage:
#   ./monitorYearlyHighlyRatedLists.sh
set -euo pipefail
cd "$(dirname "$0")"
npm run monitor-yearly-highly-rated-lists -- "$@"
